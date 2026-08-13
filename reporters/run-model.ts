import os from 'os';
import path from 'path';
import type { Suite, TestCase } from '@playwright/test/reporter';
import { env } from '../src/config/env.config';
import { BugRecord, readAuthStrategy, readBugLedger, resolveModule, Severity } from '../src/utils/bugTracker';
import { environmentName, hostOf } from '../src/utils/environment';
import { runStamp } from './run-paths';
import { ApiCallRecord, readTelemetry } from './telemetry';

/**
 * Assembles the run model the HTML generator renders.
 *
 * Three sources are joined here and nowhere else:
 *   1. Playwright's result tree — which tests ran, how they ended, and why they failed.
 *   2. The bug ledger written by `bugTracker` during the run — the ticket-ready defects.
 *   3. Per-request telemetry — the response code and latency behind each test.
 */

export type TestStatus = 'passed' | 'failed' | 'skipped';

export interface ReportCall {
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  body?: string;
}

export interface ReportDefect {
  /** Sequential, human-quotable id: KP-001, KP-002, … */
  id: string;
  /** The content-hashed id in BUG_REPORT.md, so the two reports can be cross-referenced. */
  ledgerId: string;
  title: string;
  severity: Severity | string;
  module: string;
  owner: string;
  method: string;
  path: string;
  classification: string;
  description: string;
  expected: string;
  actual: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  responseSnippet?: string;
  repro?: string;
  /** How many test cases tripped this same defect. */
  occurrences: number;
}

export interface ReportTest {
  id: string;
  title: string;
  describe: string;
  suite: string;
  project: string;
  file: string;
  line: number;
  status: TestStatus;
  flaky: boolean;
  durationMs: number;
  retries: number;
  method: string | null;
  path: string | null;
  statusCode: number | null;
  latencyMs: number | null;
  calls: ReportCall[];
  error?: { message: string; stack?: string };
  defectIds: string[];
  /** Display owner and grade of the highest-severity linked defect, for the failure cards. */
  defectOwner: string | null;
  defectSeverity: string | null;
  /** Pre-joined haystacks so the browser filters without rebuilding strings per keystroke. */
  _index: string;
  _owners: string;
  _bugs: string;
  _severities: string;
}

export interface RunModel {
  app: 'KPOST';
  generatedAt: string;
  generatedAtLabel: string;
  /** Timestamped run folder this report belongs to, e.g. `run_2026-08-10_17-42-08`. */
  runId: string;
  modelPath?: string;
  environment: {
    name: string;
    baseURL: string;
    /** Host only — the report header names the server separately from the full target URL. */
    server: string;
    tester: string;
    framework: string;
    authStrategy: string;
    ci: boolean;
    workers: number;
    /** Relative link to Playwright's own report, which owns the trace viewer. */
    traceReport: string;
  };
  totals: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    flaky: number;
    durationMs: number;
    endpointsExercised: number;
  };
  suites: Array<{ name: string; total: number; passed: number; failed: number; skipped: number }>;
  defects: ReportDefect[];
  tests: ReportTest[];
}

const ENDPOINT_IN_TITLE = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s)]*)/i;
/** Playwright colourises assertion messages; raw escape codes would render as noise. */
const ANSI = /\u001b\[[0-9;]*m/g;
const SEVERITY_ORDER: Record<string, number> = { Critical: 0, Major: 1, Minor: 2 };

function clip(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= max ? value : `${value.slice(0, max)}\n… truncated (${value.length} chars)`;
}

function clean(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.replace(ANSI, '');
}

/** `actual` reads "HTTP 500 — body: {…}"; the body is what a developer wants to see verbatim. */
function responseSnippetOf(record: BugRecord): string | undefined {
  const marker = record.actual.indexOf('body: ');
  if (marker === -1) return undefined;
  const body = record.actual.slice(marker + 6).trim();
  return body.length > 0 ? clip(body, 4000) : undefined;
}

function endpointKey(method: string | null, endpointPath: string | null): string {
  return `${method ?? ''} ${endpointPath ?? ''}`;
}

/**
 * A failure raised by a bare `expect` never reaches the bug ledger, so it would otherwise
 * appear in the report with no ticket at all. One synthetic defect is minted per distinct
 * (endpoint, failure reason) pair — per pair, not per test, or a single backend fault tripped
 * by two hundred cases would mint two hundred tickets.
 */
function synthesizeDefect(test: ReportTest): { key: string; defect: Omit<ReportDefect, 'id'> } {
  const reason = (test.error?.message ?? 'Assertion failed').split('\n')[0].slice(0, 180);
  const ownership = test.path ? resolveModule(test.path) : { module: test.suite, team: 'Platform' };
  return {
    key: `${endpointKey(test.method, test.path)} :: ${reason}`,
    defect: {
      ledgerId: '',
      title: reason,
      severity: 'Major',
      module: ownership.module,
      owner: `Backend Dev - ${ownership.team} Team`,
      method: test.method ?? '—',
      path: test.path ?? test.suite,
      classification: 'Assertion Failure',
      description:
        'A test assertion failed without filing a ledger entry. It was raised by a plain expect() rather than one of the bug-tracking helpers, so the full request/response metadata is limited to the trace below.',
      expected: 'The assertion in the referenced spec to hold',
      actual: clean(test.error?.message)?.slice(0, 600) ?? 'Assertion failed',
      requestHeaders: {},
      requestBody: test.calls.find((call) => call.body)?.body,
      responseSnippet: undefined,
      repro: `// ${test.file}:${test.line}\n// ${test.describe}\ntest('${test.title.replace(/'/g, "\\'")}')`,
      occurrences: 0,
    },
  };
}

export function buildRunModel(options: {
  suite: Suite | undefined;
  startedAt: number;
  durationMs: number;
  endpointsExercised: number;
}): RunModel {
  const cases: TestCase[] = options.suite?.allTests() ?? [];
  const telemetry = readTelemetry(options.startedAt);

  const callsByTest = new Map<string, ApiCallRecord[]>();
  for (const record of telemetry) {
    const bucket = callsByTest.get(record.testId);
    if (bucket) bucket.push(record);
    else callsByTest.set(record.testId, [record]);
  }

  const totals = { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 };
  const suiteStats = new Map<string, { name: string; total: number; passed: number; failed: number; skipped: number }>();
  const tests: ReportTest[] = [];

  for (const testCase of cases) {
    const outcome = testCase.outcome();
    const status: TestStatus =
      outcome === 'skipped' ? 'skipped' : outcome === 'unexpected' ? 'failed' : 'passed';

    totals.total += 1;
    totals[status] += 1;
    if (outcome === 'flaky') totals.flaky += 1;

    const titlePath = testCase.titlePath();
    const describe = titlePath.slice(3, -1).join(' › ');
    const project = testCase.parent.project()?.name ?? 'unknown';
    const file = path.relative(process.cwd(), testCase.location.file).replace(/\\/g, '/');
    const suiteName = describe || path.basename(file);

    const endpointMatch = ENDPOINT_IN_TITLE.exec(describe) ?? ENDPOINT_IN_TITLE.exec(testCase.title);
    const method = endpointMatch ? endpointMatch[1].toUpperCase() : null;
    const endpointPath = endpointMatch ? endpointMatch[2] : null;

    const last = testCase.results[testCase.results.length - 1];
    const failed = status === 'failed';

    const recorded = callsByTest.get(testCase.id) ?? [];
    const calls: ReportCall[] = recorded.slice(0, 12).map((record) => ({
      method: record.method,
      path: record.path,
      status: record.status,
      latencyMs: record.latencyMs,
      // Payloads are only carried for failures: on a clean run they would add megabytes to
      // the report without anyone ever opening the drawer.
      body: failed ? clip(record.body, 3000) : undefined,
    }));

    /*
     * The headline code and latency describe the call the test was actually about. A test may
     * warm up with an unrelated request (fetching a list before deleting from it), so the call
     * matching the suite's declared endpoint wins; the last call is the fallback.
     */
    const primary =
      recorded.find((record) => endpointPath !== null && record.path.split('?')[0] === endpointPath) ??
      recorded[recorded.length - 1];

    const stats =
      suiteStats.get(project) ?? { name: project, total: 0, passed: 0, failed: 0, skipped: 0 };
    stats.total += 1;
    stats[status] += 1;
    suiteStats.set(project, stats);

    const error =
      failed && last?.error
        ? {
            message: clip(clean(last.error.message) ?? 'Test failed', 6000) as string,
            stack: clip(clean(last.error.stack), 8000),
          }
        : undefined;

    tests.push({
      id: testCase.id,
      title: testCase.title,
      describe,
      suite: project,
      project,
      file,
      line: testCase.location.line,
      status,
      flaky: outcome === 'flaky',
      durationMs: last?.duration ?? 0,
      retries: Math.max(0, testCase.results.length - 1),
      method: method ?? primary?.method ?? null,
      path: endpointPath ?? primary?.path.split('?')[0] ?? null,
      statusCode: primary?.status ?? null,
      latencyMs: primary?.latencyMs ?? null,
      calls,
      error,
      defectIds: [],
      defectOwner: null,
      defectSeverity: null,
      _index: `${testCase.title} ${describe} ${project} ${suiteName} ${method ?? ''} ${endpointPath ?? ''} ${status}`.toLowerCase(),
      _owners: '',
      _bugs: '',
      _severities: '',
    });
  }

  /* ---- defects: ledger first, then anything that failed without filing one ---- */

  const ledger = readBugLedger();
  const byEndpoint = new Map<string, BugRecord[]>();
  for (const record of ledger) {
    const key = endpointKey(record.method.toUpperCase(), record.endpointPath);
    const bucket = byEndpoint.get(key);
    if (bucket) bucket.push(record);
    else byEndpoint.set(key, [record]);
  }

  const drafts = new Map<string, Omit<ReportDefect, 'id'>>();
  for (const record of ledger) {
    drafts.set(record.id, {
      ledgerId: record.id,
      title: record.title,
      severity: record.severity,
      module: record.module,
      owner: record.owner,
      method: record.method.toUpperCase(),
      path: record.endpointPath,
      classification: record.classification,
      description: record.description,
      expected: record.expected,
      actual: record.actual,
      requestHeaders: record.requestHeaders,
      requestBody: clip(record.requestBody, 4000),
      responseSnippet: responseSnippetOf(record),
      repro: record.reproSnippet,
      occurrences: 0,
    });
  }

  // Ledger findings attach to the failed tests that exercised the same endpoint. A defect is
  // deduplicated across the whole run, so the same one legitimately lands on many tests.
  const linkage = new Map<ReportTest, string[]>();
  const synthesized = new Map<string, { key: string; defect: Omit<ReportDefect, 'id'> }>();

  for (const test of tests) {
    if (test.status !== 'failed') continue;
    const matches = byEndpoint.get(endpointKey(test.method, test.path)) ?? [];
    if (matches.length > 0) {
      linkage.set(test, matches.map((record) => record.id));
      continue;
    }
    const draft = synthesizeDefect(test);
    if (!synthesized.has(draft.key)) synthesized.set(draft.key, draft);
    if (!drafts.has(draft.key)) drafts.set(draft.key, draft.defect);
    linkage.set(test, [draft.key]);
  }

  for (const ids of linkage.values()) {
    for (const id of ids) {
      const draft = drafts.get(id);
      if (draft) draft.occurrences += 1;
    }
  }

  // Sequential ids are assigned once, here, in a single process — a worker-side counter would
  // restart per worker and mint duplicates, which is why the ledger itself hashes instead.
  // Sorting before numbering keeps KP-001 as the most severe entry and the numbering stable
  // for an unchanged set of findings.
  const ordered = [...drafts.entries()].sort((a, b) => {
    const bySeverity = (SEVERITY_ORDER[a[1].severity] ?? 9) - (SEVERITY_ORDER[b[1].severity] ?? 9);
    if (bySeverity !== 0) return bySeverity;
    const byOccurrences = b[1].occurrences - a[1].occurrences;
    if (byOccurrences !== 0) return byOccurrences;
    const byPath = a[1].path.localeCompare(b[1].path);
    return byPath !== 0 ? byPath : a[1].title.localeCompare(b[1].title);
  });

  const idByKey = new Map<string, string>();
  const defects: ReportDefect[] = ordered.map(([key, draft], index) => {
    const id = `KP-${String(index + 1).padStart(3, '0')}`;
    idByKey.set(key, id);
    return { ...draft, id, occurrences: Math.max(1, draft.occurrences) };
  });
  const defectById = new Map(defects.map((defect) => [defect.id, defect]));

  for (const [test, keys] of linkage.entries()) {
    test.defectIds = keys.map((key) => idByKey.get(key)).filter((id): id is string => Boolean(id));
    const linked = test.defectIds.map((id) => defectById.get(id)!).filter(Boolean);
    test._bugs = test.defectIds.join(' ').toLowerCase();
    test._owners = linked.map((defect) => defect.owner).join(' ').toLowerCase();
    test._severities = linked.map((defect) => defect.severity).join(' ');
    test._index = `${test._index} ${test._bugs} ${test._owners} ${test._severities.toLowerCase()}`;

    // The failure card shows one owner and one priority; when a test trips several defects
    // the most severe is the one that decides who is paged and how urgently.
    const worst = linked
      .slice()
      .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9))[0];
    test.defectOwner = worst ? worst.owner : null;
    test.defectSeverity = worst ? String(worst.severity) : null;
  }

  const now = new Date();

  return {
    app: 'KPOST',
    generatedAt: now.toISOString(),
    generatedAtLabel: `${now.toISOString().replace('T', ' ').slice(0, 19)} UTC`,
    // The reporter stamps the real folder name; this keeps the model valid on its own.
    runId: runStamp(now),
    environment: {
      name: environmentName(env.baseURL),
      baseURL: env.baseURL,
      server: hostOf(env.baseURL),
      // Named QA owner for the report header. Falls back to the OS account rather than being
      // left blank: a report with no author is one nobody can follow up on.
      tester: process.env.QA_ENGINEER ?? process.env.TESTER ?? os.userInfo().username,
      framework: 'Playwright + TypeScript',
      authStrategy: readAuthStrategy(),
      ci: env.isCI,
      workers: env.workers,
      traceReport: './diagnostic/index.html',
    },
    totals: {
      ...totals,
      durationMs: options.durationMs,
      endpointsExercised: options.endpointsExercised,
    },
    suites: [...suiteStats.values()],
    defects,
    tests,
  };
}
