import fs from 'fs';
import path from 'path';
import type { RunModel } from './run-model';

/**
 * TIER 3 — Historical trend logger.
 *
 * Appends one data point per run to `reports/kpost-trend-history.json` so quality dashboards
 * can chart pass rate, duration and failure churn across builds. The file is a plain JSON
 * array, which any spreadsheet, Grafana JSON datasource or notebook can read without a schema.
 */

export interface TrendDataPoint {
  runId: string;
  timestamp: string;
  totalTests: number;
  passCount: number;
  failCount: number;
  passRatePercentage: number;
  totalDurationMs: number;
  /** Stable identifiers of the tests that failed, so churn between builds is computable. */
  failedTestKeys: string[];
}

/** Newest-run-last, capped so the file stays readable after months of nightly builds. */
const MAX_POINTS = 500;

/**
 * A run identifier that is stable within a build and unique across builds. CI build numbers
 * are preferred because they let a trend point be traced back to the pipeline that produced
 * it; a timestamp is the fallback for local runs.
 */
function resolveRunId(model: RunModel): string {
  const ci =
    process.env.BUILD_ID ??
    process.env.BUILD_NUMBER ??
    process.env.GITHUB_RUN_ID ??
    process.env.CI_PIPELINE_ID;
  const stamp = model.generatedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return ci ? `KPOST-${ci}` : `KPOST-${stamp}`;
}

/**
 * A test's identity across runs. The Playwright test id is derived from file position, so it
 * shifts when a spec is edited above the test; project + suite + title survives that.
 */
export function testKey(test: { project: string; describe: string; title: string }): string {
  return [test.project, test.describe, test.title].filter(Boolean).join(' › ');
}

function readHistory(historyPath: string): TrendDataPoint[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
    return Array.isArray(parsed) ? (parsed as TrendDataPoint[]) : [];
  } catch {
    // Absent on the first run, and a corrupt file must not abort the run — a truncated
    // history is recoverable, a failed test suite report is not.
    return [];
  }
}

export function buildTrendPoint(model: RunModel): TrendDataPoint {
  const failed = model.tests.filter((test) => test.status === 'failed');
  return {
    runId: resolveRunId(model),
    timestamp: model.generatedAt,
    totalTests: model.totals.total,
    passCount: model.totals.passed,
    failCount: model.totals.failed,
    passRatePercentage: model.totals.total
      ? Math.round((model.totals.passed / model.totals.total) * 1000) / 10
      : 0,
    totalDurationMs: model.totals.durationMs,
    failedTestKeys: failed.map(testKey),
  };
}

/** Appends this run to the history file, creating it if absent. Returns the written path. */
export function appendTrendPoint(model: RunModel, historyPath: string): string {
  const point = buildTrendPoint(model);
  const history = readHistory(historyPath);

  // Re-running the same build id replaces its point rather than double-counting it, which
  // matters when a pipeline retries a failed stage.
  const existing = history.findIndex((entry) => entry.runId === point.runId);
  if (existing === -1) history.push(point);
  else history[existing] = point;

  const trimmed = history.slice(-MAX_POINTS);

  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(historyPath, `${JSON.stringify(trimmed, null, 2)}\n`, 'utf-8');
  return historyPath;
}
