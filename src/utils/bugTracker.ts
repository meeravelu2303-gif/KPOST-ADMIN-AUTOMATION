import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { MODULE_BY_PATH } from '../api/registry/moduleOwnership.generated';
import { environmentName } from './environment';

const ROOT = path.resolve(__dirname, '../..');
const BUG_REPORT_PATH = path.join(ROOT, 'BUG_REPORT.md');
/** Machine-readable twin of BUG_REPORT.md, for CI jobs and tracker importers. */
const BUG_REPORT_JSON_PATH = path.join(ROOT, 'BUG_REPORT.json');

/**
 * Findings are written first to one file per defect here, then compiled into BUG_REPORT.md
 * at teardown. Playwright runs each worker as a separate process, so appending to a single
 * shared file races: two workers can both read "not yet reported" and append the same
 * finding twice. Creating a per-finding file with the exclusive 'wx' flag is atomic, which
 * is what makes cross-worker deduplication reliable.
 */
const BUG_CACHE_DIR = path.join(ROOT, '.bug-cache');

/**
 * Four bands, deliberately. A report where everything is Critical is a report nobody reads,
 * so the grading rules in `apiAssertions.ts` reserve Critical for defects that actually
 * changed or exposed something, and push spec/implementation mismatches down.
 *
 * `Low` replaces the former `Minor`; `Medium` is new and sits between "wrong but harmless to
 * data" and "actively misleading a client".
 */
export type Severity = 'Critical' | 'Major' | 'Medium' | 'Low';

/**
 * Delivery priority, distinct from severity.
 *
 * Severity says how bad the defect is; priority says how soon it must be picked up. They
 * usually track each other, which is why the default mapping below is mechanical — but the
 * field is separate so a low-severity defect blocking a release can still be raised to P0
 * by passing `priority` explicitly.
 */
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

const PRIORITY_BY_SEVERITY: Record<Severity, Priority> = {
  Critical: 'P0',
  Major: 'P1',
  Medium: 'P2',
  Low: 'P3',
};

/** Defect taxonomy — drives the dashboard's "flaws by classification" breakdown. */
export type FlawClassification =
  | 'Security/XSS'
  | 'Security/SQL Injection'
  | 'Security/Access Control'
  | 'Security/Information Disclosure'
  | 'Security/Rate Limiting'
  | 'Business Logic Flaw'
  | 'Input Validation Gap'
  | 'Incorrect HTTP Status'
  | 'Status Code Misreporting'
  | 'Schema Violation'
  | 'Unhandled NPE / Server Error'
  | 'Idempotency / Concurrency';

export interface BugRecord {
  /**
   * Stable, content-derived id: BUG-API-XXXXXX.
   *
   * This is *identity*, not the display label. A sequential counter cannot be minted safely
   * inside a worker — Playwright runs each worker as its own process, so a counter restarts
   * per worker and mints duplicates. The hash also collapses a defect that hundreds of tests
   * trip over into one entry, and stays stable across runs so a tracker can match it.
   *
   * The human-facing `BUG-<MODULE>-NNN` label is assigned in `displayId`, at compile time,
   * in the single reporter process where a counter *is* safe.
   */
  id: string;
  /** `BUG-AUTH-001` style label, assigned at compile time. Absent until then. */
  displayId?: string;
  title: string;
  severity: Severity;
  /** Delivery priority. Defaults from severity; can be set explicitly. */
  priority: Priority;
  /** What this costs the business or the user if it ships. */
  riskImpact: string;
  /** Swagger tag / controller the endpoint belongs to. */
  module: string;
  /** Team the ticket should be routed to. */
  owner: string;
  method: string;
  endpointPath: string;
  classification: FlawClassification;
  description: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  expected: string;
  actual: string;
  reproSnippet: string;
  /** Copy-pasteable `curl` for the exact request, with the token redacted to a variable. */
  curlSnippet: string;
}

export type BugInput = Omit<
  BugRecord,
  'id' | 'displayId' | 'owner' | 'priority' | 'riskImpact' | 'curlSnippet'
> & {
  owner?: string;
  priority?: Priority;
  riskImpact?: string;
};

/**
 * Risk wording per classification, used when a call site does not supply its own.
 *
 * The point of the field is to say what the defect *costs*, in the language a product owner
 * triages in — not to restate the assertion. A generic "this is a bug" line would be worse
 * than none, so each entry names a concrete consequence.
 */
const RISK_BY_CLASSIFICATION: Record<FlawClassification, string> = {
  'Security/XSS':
    'Attacker-controlled script executes in another user’s session, enabling account takeover and data theft from the rendering client.',
  'Security/SQL Injection':
    'Query structure is influenced by user input; worst case is unauthorised read or destruction of the datastore.',
  'Security/Access Control':
    'One user can read or act on another user’s data. Direct breach of tenant isolation and, for personal data, a reportable incident.',
  'Security/Information Disclosure':
    'Internal infrastructure, credentials or third-party endpoints are exposed to callers, lowering the cost of a follow-on attack.',
  'Security/Rate Limiting':
    'An unthrottled endpoint can be enumerated or used to exhaust capacity, quota or third-party spend.',
  'Business Logic Flaw':
    'The system reaches a state the business rules forbid; downstream processes and reporting act on data that should not exist.',
  'Input Validation Gap':
    'Invalid data is persisted, so corruption spreads to every consumer of the record and cannot be traced back to a rejected request.',
  'Incorrect HTTP Status':
    'Clients branch on the status code; a wrong one sends retries, alerts and error handling down the wrong path.',
  'Status Code Misreporting':
    'A failure is transported as a success. Callers record the operation as complete when nothing happened.',
  'Schema Violation':
    'The response breaks its published contract, so generated clients and typed consumers fail at runtime rather than at build time.',
  'Unhandled NPE / Server Error':
    'An unhandled exception reaches the caller: no useful error, possible stack disclosure, and an alert-generating 5xx for a client mistake.',
  'Idempotency / Concurrency':
    'A retried or concurrent request produces duplicate or interleaved state — double charges, double sends, or one user served another’s data.',
};

/** Shell-safe single-quoting for a curl argument. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * A copy-pasteable `curl` for the exact request that produced the finding.
 *
 * This is the field a backend developer actually uses: it reproduces the defect without
 * installing the test suite, checking out the repo, or reading TypeScript. The Authorization
 * header is emitted as a placeholder rather than the live token — the report is committed.
 */
export function buildCurl(record: {
  method: string;
  endpointPath: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
}): string {
  const baseUrl = process.env.BASE_URL ?? 'http://localhost:9595';
  const parts = [`curl -i -X ${record.method.toUpperCase()} ${shellQuote(baseUrl + record.endpointPath)}`];

  for (const [key, value] of Object.entries(record.requestHeaders)) {
    const emitted = key.toLowerCase() === 'authorization' ? 'Bearer $KPOST_TOKEN' : value;
    parts.push(`  -H ${shellQuote(`${key}: ${emitted}`)}`);
  }

  if (record.requestBody !== undefined) {
    // Collapse the pretty-printed body: a multi-line -d argument is awkward to paste.
    let compact = record.requestBody;
    try {
      compact = JSON.stringify(JSON.parse(record.requestBody));
    } catch {
      compact = record.requestBody.replace(/\s*\n\s*/g, ' ');
    }
    parts.push(`  -d ${shellQuote(compact)}`);
  }

  return parts.join(' \\\n');
}

/**
 * Ownership is resolved from the spec-derived map rather than from URL-prefix guesses:
 * KPOST's routes do not follow their tag names (Company Administration lives under
 * `/admin`, Kdiary under `/dairySchedule`), so prefix matching mis-routes tickets.
 */
export function resolveModule(endpointPath: string): { module: string; team: string } {
  const exact = MODULE_BY_PATH[endpointPath];
  if (exact) return exact;

  // Path-parameter routes are recorded with a concrete value substituted in, so fall back
  // to matching the registry's `{param}` template against the concrete path.
  for (const [template, ownership] of Object.entries(MODULE_BY_PATH)) {
    if (!template.includes('{')) continue;
    const pattern = new RegExp(
      `^${template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{[^}]+\\\}/g, '[^/]+')}$`
    );
    if (pattern.test(endpointPath)) return ownership;
  }

  return { module: 'Unclassified', team: 'Platform' };
}

/**
 * Content-derived id rather than a counter: workers are separate processes, so a counter
 * restarts per worker and mints duplicates. A hash is also stable run-to-run, so a ticket
 * raised from BUG-API-3F2A91 still refers to the same defect next week.
 */
function computeId(method: string, endpointPath: string, title: string): string {
  const fingerprint = `${method} ${endpointPath} :: ${title}`;
  const digest = crypto.createHash('sha1').update(fingerprint).digest('hex');
  return `BUG-API-${digest.slice(0, 6).toUpperCase()}`;
}

const COVERAGE_DIR = path.join(ROOT, '.bug-cache', 'coverage');

export function resetBugLedger(): void {
  fs.rmSync(BUG_CACHE_DIR, { recursive: true, force: true });
  fs.mkdirSync(COVERAGE_DIR, { recursive: true });
  fs.writeFileSync(
    BUG_REPORT_PATH,
    '# KPOST Admin API — Automated Bug Report\n\n_Run in progress; this file is rewritten when the suite completes._\n',
    'utf-8'
  );
}

/**
 * Endpoints this worker has exercised. Kept in-process so each distinct endpoint costs one
 * filesystem write per worker rather than one per assertion.
 */
const seenEndpoints = new Set<string>();

/** Records that an endpoint was exercised, for the dashboard's coverage figure. */
export function recordEndpointExercised(method: string, endpointPath: string): void {
  const key = `${method} ${endpointPath}`;
  if (seenEndpoints.has(key)) return;
  seenEndpoints.add(key);

  const name = crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
  try {
    fs.mkdirSync(COVERAGE_DIR, { recursive: true });
    fs.writeFileSync(path.join(COVERAGE_DIR, `${name}.json`), JSON.stringify({ key }), {
      flag: 'wx',
      encoding: 'utf-8',
    });
  } catch {
    // Already recorded by another worker.
  }
}

/** Distinct method+path pairs this run touched. Shared by both report formats. */
export function countExercisedEndpoints(): number {
  try {
    return fs.readdirSync(COVERAGE_DIR).filter((f) => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

const AUTH_STRATEGY_FILE = path.join(BUG_CACHE_DIR, 'auth-strategy.txt');

/**
 * Workers are separate processes from the reporter, so the resolved auth strategy is
 * handed over through the cache directory rather than an environment variable.
 */
export function recordAuthStrategy(summary: string): void {
  try {
    fs.mkdirSync(BUG_CACHE_DIR, { recursive: true });
    fs.writeFileSync(AUTH_STRATEGY_FILE, summary, { flag: 'wx', encoding: 'utf-8' });
  } catch {
    // First worker to resolve a session wins.
  }
}

export function readAuthStrategy(): string {
  try {
    return fs.readFileSync(AUTH_STRATEGY_FILE, 'utf-8');
  } catch {
    return 'unresolved — see run log';
  }
}

/** Records a defect. Repeat reports of the same defect are collapsed to one entry. */
export function recordBug(input: BugInput): string {
  const id = computeId(input.method, input.endpointPath, input.title);
  const resolved = resolveModule(input.endpointPath);
  const record: BugRecord = {
    ...input,
    id,
    module: input.module || resolved.module,
    owner: input.owner ?? `Backend Dev - ${resolved.team} Team`,
    priority: input.priority ?? PRIORITY_BY_SEVERITY[input.severity],
    riskImpact: input.riskImpact ?? RISK_BY_CLASSIFICATION[input.classification],
    curlSnippet: buildCurl(input),
  };

  try {
    fs.mkdirSync(BUG_CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(BUG_CACHE_DIR, `${id}.json`), JSON.stringify(record), {
      flag: 'wx',
      encoding: 'utf-8',
    });
  } catch {
    // 'wx' failed because another worker already reported this defect — nothing to do.
  }

  return id;
}

const SEVERITY_ORDER: Record<Severity, number> = { Critical: 0, Major: 1, Medium: 2, Low: 3 };

/**
 * Every finding recorded so far. Exported so the TestBench HTML reporter can render the same
 * ledger the Markdown report is compiled from — both read the cache, neither owns it.
 */
export function readBugLedger(): BugRecord[] {
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(BUG_CACHE_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const records: BugRecord[] = [];
  for (const file of files) {
    try {
      records.push(JSON.parse(fs.readFileSync(path.join(BUG_CACHE_DIR, file), 'utf-8')));
    } catch {
      // Skip a partially written record rather than losing the entire report.
    }
  }
  return records;
}

function formatHeaders(headers: Record<string, string>): string {
  const entries = Object.entries(headers);
  if (entries.length === 0) return '`(none)`';
  return entries.map(([k, v]) => `\`${k}: ${v}\``).join(', ');
}

function renderBug(record: BugRecord): string {
  const bodyBlock = record.requestBody
    ? `\n     \`\`\`json\n${record.requestBody
        .split('\n')
        .map((l) => `     ${l}`)
        .join('\n')}\n     \`\`\``
    : ' _(no request body)_';

  return `---

### [${record.displayId ?? record.id}] ${record.title}

- **Bug ID:** \`${record.displayId ?? record.id}\` &nbsp;·&nbsp; **Content hash:** \`${record.id}\`
- **Severity:** ${record.severity} &nbsp;·&nbsp; **Priority:** ${record.priority}
- **Module / Controller:** ${record.module}
- **Suggested Owner:** ${record.owner}
- **Endpoint:** \`${record.method} ${record.endpointPath}\`
- **Flaw Classification:** ${record.classification}
- **Description:** ${record.description}
- **System Risk Impact:** ${record.riskImpact}
- **Steps to Reproduce:**
  1. Send \`${record.method}\` request to \`${record.endpointPath}\`
  2. Headers: ${formatHeaders(record.requestHeaders)}
  3. Request Body:${bodyBlock}
- **Expected Behavior:** ${record.expected}
- **Actual Behavior:** ${record.actual}
- **Reproduce with curl:**

  \`\`\`bash
${record.curlSnippet
  .split('\n')
  .map((l) => `  ${l}`)
  .join('\n')}
  \`\`\`

- **Reproduce with Playwright:**

  \`\`\`typescript
${record.reproSnippet
  .split('\n')
  .map((l) => `  ${l}`)
  .join('\n')}
  \`\`\`
`;
}

function countBy<T extends string>(records: BugRecord[], key: (r: BugRecord) => T): Map<T, number> {
  const counts = new Map<T, number>();
  for (const record of records) {
    const value = key(record);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function renderDashboard(records: BugRecord[], meta: RunMeta): string {
  const bySeverity = countBy(records, (r) => r.severity);
  const byModule = [...countBy(records, (r) => r.module).entries()].sort((a, b) => b[1] - a[1]);
  const byClass = [...countBy(records, (r) => r.classification).entries()].sort(
    (a, b) => b[1] - a[1]
  );

  const byPriority = countBy(records, (r) => r.priority);
  const byOwner = [...countBy(records, (r) => r.owner).entries()].sort((a, b) => b[1] - a[1]);

  const critical = bySeverity.get('Critical') ?? 0;
  const major = bySeverity.get('Major') ?? 0;
  const medium = bySeverity.get('Medium') ?? 0;
  const low = bySeverity.get('Low') ?? 0;

  const verdict =
    critical > 0
      ? '**DO NOT SHIP** — critical defects (auth bypass, injection, or data exposure) are open.'
      : major > 0
        ? '**SHIP AT RISK** — no critical defects, but contract and validation gaps remain.'
        : records.length > 0
          ? '**ACCEPTABLE** — only cosmetic contract deviations recorded.'
          : '**CLEAN** — no deviations detected in this run.';

  return `# KPOST Admin API — Automated Bug Report

> Generated by the KPOST API Test Bench on ${meta.generatedAt}.
> **This file is generated — do not edit by hand.** Re-run \`npm test\` to regenerate.

## Executive Summary Dashboard

| Metric | Value |
| --- | --- |
| Report generated | ${meta.generatedAt} |
| Target environment | \`${meta.baseURL}\` |
| Tests executed | ${meta.totalTests} |
| Passed / Failed / Skipped | ${meta.passed} / ${meta.failed} / ${meta.skipped} |
| Endpoints exercised | ${meta.endpointsExercised} |
| Run duration | ${meta.durationSeconds}s |
| Authentication | ${meta.authStrategy} |

### Defect Counts by Severity

| Severity | Count | Meaning |
| --- | --- | --- |
| Critical | ${critical} | Auth bypass, injection, IDOR, or unauthenticated data exposure |
| Major | ${major} | Unvalidated input accepted, business rule not enforced, internals disclosed |
| Medium | ${medium} | Wrong status code or misreported outcome — misleads a client, corrupts nothing |
| Low | ${low} | Cosmetic contract/response-shape deviation |
| **Total distinct defects** | **${records.length}** | |

### Defect Counts by Priority

| Priority | Count | Meaning |
| --- | --- | --- |
| P0 | ${byPriority.get('P0') ?? 0} | Fix before the next deploy |
| P1 | ${byPriority.get('P1') ?? 0} | Fix this sprint |
| P2 | ${byPriority.get('P2') ?? 0} | Schedule |
| P3 | ${byPriority.get('P3') ?? 0} | Backlog |

### Release Verdict

${verdict}

### Defects by Module

| Module / Controller | Defects |
| --- | --- |
${byModule.map(([m, c]) => `| ${m} | ${c} |`).join('\n') || '| _none_ | 0 |'}

### Defects by Assigned Owner

| Owner | Defects |
| --- | --- |
${byOwner.map(([o, c]) => `| ${o} | ${c} |`).join('\n') || '| _none_ | 0 |'}

### Defects by Flaw Classification

| Classification | Defects |
| --- | --- |
${byClass.map(([c, n]) => `| ${c} | ${n} |`).join('\n') || '| _none_ | 0 |'}

### Bug Index

| ID | Severity | Priority | Owner | Endpoint | Title |
| --- | --- | --- | --- | --- | --- |
${
    records
      .map(
        (r) =>
          `| ${r.displayId ?? r.id} | ${r.severity} | ${r.priority} | ${r.owner} | \`${r.method} ${r.endpointPath}\` | ${r.title} |`
      )
      .join('\n') || '| _none_ | — | — | — | — | — |'
  }

## Itemized Bug Ledger

`;
}

export interface RunMeta {
  generatedAt: string;
  baseURL: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  durationSeconds: number;
  endpointsExercised: number;
  authStrategy: string;
}

export type RunStats = Omit<RunMeta, 'endpointsExercised'>;

/** Compiles every recorded finding into the final report. Called by the bug reporter. */
export function compileBugReport(stats: RunStats): void {
  const meta: RunMeta = { ...stats, endpointsExercised: countExercisedEndpoints() };
  writeReport(meta);
}

/**
 * Turns a module name into the short token used in a display id: "Authentication V2" →
 * "AUTH", "Company Administration" → "COMPANY". First alphanumeric word, capped at 8
 * characters so the label stays scannable in a table.
 */
function moduleToken(module: string): string {
  const word = module.replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/)[0] ?? 'API';
  return word.slice(0, 8).toUpperCase() || 'API';
}

/**
 * Assigns `BUG-<MODULE>-NNN` labels.
 *
 * Safe here and only here: this runs in the reporter, a single process, after every worker
 * has finished writing to the cache. The counter restarts per module and follows the sorted
 * order, so the same run always produces the same labels — but the label is *display only*.
 * `id` (the content hash) remains identity for deduplication and tracker matching, because a
 * positional number changes the moment a defect above it is fixed.
 */
function assignDisplayIds(records: BugRecord[]): void {
  const counters = new Map<string, number>();
  for (const record of records) {
    const token = moduleToken(record.module);
    const next = (counters.get(token) ?? 0) + 1;
    counters.set(token, next);
    record.displayId = `BUG-${token}-${String(next).padStart(3, '0')}`;
  }
}

function writeReport(meta: RunMeta): void {
  const records = readBugLedger().sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const byPath = a.endpointPath.localeCompare(b.endpointPath);
    return byPath !== 0 ? byPath : a.title.localeCompare(b.title);
  });

  assignDisplayIds(records);

  const body =
    records.length === 0
      ? '_No defects were recorded in this run._\n'
      : records.map(renderBug).join('\n');

  fs.writeFileSync(BUG_REPORT_PATH, `${renderDashboard(records, meta)}${body}`, 'utf-8');

  /*
   * The machine-readable twin of the Markdown report.
   *
   * Same records, same ids, no rendering — so a CI job, a tracker importer or a dashboard can
   * consume the run without parsing Markdown. Written next to BUG_REPORT.md rather than under
   * reports/ because the two are a pair and reviewers expect to find them together.
   */
  const jsonReport = {
    generatedAt: meta.generatedAt,
    /*
     * This field previously carried the raw `baseURL`, which the QA Dashboard rendered as its
     * Env column and grouped separately whenever the hostname differed. The URL is still
     * published, as `baseURL` below; this is the short label the executive report also shows.
     */
    environment: environmentName(meta.baseURL),
    baseURL: meta.baseURL,
    run: {
      totalTests: meta.totalTests,
      passed: meta.passed,
      failed: meta.failed,
      skipped: meta.skipped,
      durationSeconds: meta.durationSeconds,
      endpointsExercised: meta.endpointsExercised,
      authStrategy: meta.authStrategy,
    },
    summary: {
      total: records.length,
      bySeverity: tally(records, (r) => r.severity),
      byPriority: tally(records, (r) => r.priority),
      byModule: tally(records, (r) => r.module),
      byOwner: tally(records, (r) => r.owner),
      byClassification: tally(records, (r) => r.classification),
    },
    defects: records,
  };
  fs.writeFileSync(BUG_REPORT_JSON_PATH, `${JSON.stringify(jsonReport, null, 2)}\n`, 'utf-8');

  fs.rmSync(BUG_CACHE_DIR, { recursive: true, force: true });
}

function tally(records: BugRecord[], key: (r: BugRecord) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const record of records) {
    const value = key(record);
    out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}
