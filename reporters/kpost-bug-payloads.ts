import fs from 'fs';
import path from 'path';
import type { ReportDefect, RunModel } from './run-model';

/**
 * TIER 4 — Structured auto-bug stream.
 *
 * Emits `reports/kpost-bug-payloads.json`: REST-ready issue payloads that can be POSTed
 * straight at Plane, Redmine or Jira without a transform step. One payload per *defect*, not
 * per failed test — a single backend fault trips hundreds of cases here, and filing hundreds
 * of tickets for it is how an issue tracker becomes unusable.
 */

/** The six fields the integration contract fixes. Extras live under `kpost`. */
export interface BugPayload {
  bugId: string;
  summary: string;
  owner: string;
  severity: string;
  endpoint: string;
  stackTrace: string;
  /**
   * Context a tracker will ignore and a human will want: kept nested so the top-level shape
   * stays exactly as specified for strict consumers.
   */
  kpost: {
    ledgerId: string;
    module: string;
    classification: string;
    severityGrade: string;
    method: string;
    occurrences: number;
    expected: string;
    actual: string;
    requestBody?: string;
    responseSnippet?: string;
    reproduction?: string;
    environment: string;
    baseURL: string;
    runTimestamp: string;
  };
}

/**
 * Ledger grades map onto tracker priority words. Trackers do not share a vocabulary, so the
 * mapping is stated once here rather than assumed at each integration.
 */
const TRACKER_SEVERITY: Record<string, string> = {
  Critical: 'Critical',
  Major: 'High',
  Minor: 'Medium',
};

function summaryFor(defect: ReportDefect): string {
  const route = defect.method && defect.method !== '—'
    ? `${defect.method} ${defect.path}`
    : defect.path;
  return `[KPOST Automation] ${route} — ${defect.title}`;
}

/**
 * The developer-facing failure text. Ledger findings carry an `actual` line built from the
 * real response; synthesised findings carry the assertion message. Either way this is what a
 * triager reads first, so it leads with expected-vs-actual and appends the reproduction.
 */
function stackTraceFor(defect: ReportDefect): string {
  const lines = [
    `Expected: ${defect.expected}`,
    `Actual:   ${defect.actual}`,
    '',
    defect.description,
  ];
  if (defect.repro) lines.push('', '--- Playwright reproduction ---', defect.repro);
  return lines.join('\n');
}

export function buildBugPayloads(model: RunModel): BugPayload[] {
  return model.defects.map((defect) => ({
    bugId: defect.id,
    summary: summaryFor(defect),
    owner: defect.owner,
    severity: TRACKER_SEVERITY[defect.severity] ?? 'Medium',
    endpoint: defect.path,
    stackTrace: stackTraceFor(defect),
    kpost: {
      ledgerId: defect.ledgerId,
      module: defect.module,
      classification: defect.classification,
      severityGrade: String(defect.severity),
      method: defect.method,
      occurrences: defect.occurrences,
      expected: defect.expected,
      actual: defect.actual,
      requestBody: defect.requestBody,
      responseSnippet: defect.responseSnippet,
      reproduction: defect.repro,
      environment: model.environment.name,
      baseURL: model.environment.baseURL,
      runTimestamp: model.generatedAt,
    },
  }));
}

/** Writes the payload stream. Returns the written path. */
export function writeBugPayloads(model: RunModel, outPath: string): string {
  const payloads = buildBugPayloads(model);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payloads, null, 2)}\n`, 'utf-8');
  return outPath;
}
