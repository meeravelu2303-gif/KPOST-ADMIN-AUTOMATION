import fs from 'fs';
import path from 'path';

/**
 * Per-request telemetry for the TestBench report.
 *
 * The report has to show a response status code and a latency per test case, and neither is
 * visible to a Playwright reporter: reporters see test outcomes, not HTTP traffic. The
 * transport therefore hands each completed request to `recordApiCall`, which is purely
 * observational — it never inspects, delays or alters a response.
 *
 * Records are buffered in the worker and flushed to disk, because workers are separate
 * processes from the reporter and a per-request write would cost ~10,000 filesystem calls on
 * a full run. Writes use the exclusive `wx` flag so two workers can never collide on a name.
 */

const ROOT = path.resolve(__dirname, '..');
const TELEMETRY_DIR = path.join(ROOT, '.testbench');
const CALLS_DIR = path.join(TELEMETRY_DIR, 'calls');

export interface ApiCallRecord {
  /** Playwright's `TestInfo.testId`, which matches `TestCase.id` in the reporter. */
  testId: string;
  method: string;
  /** Path portion only — the origin is already reported once, as the run's target. */
  path: string;
  status: number;
  latencyMs: number;
  /** Request payload as sent. Present only when the transport captured one. */
  body?: string;
  /** Epoch millis, used to discard records left behind by an earlier run. */
  at: number;
}

const FLUSH_AT = 200;
let buffer: ApiCallRecord[] = [];
let sequence = 0;
let exitHookInstalled = false;

function flush(): void {
  if (buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  const name = `${process.pid}-${sequence++}.jsonl`;
  try {
    fs.mkdirSync(CALLS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(CALLS_DIR, name),
      batch.map((record) => JSON.stringify(record)).join('\n') + '\n',
      { flag: 'wx', encoding: 'utf-8' }
    );
  } catch {
    // Telemetry is a reporting nicety. A failed write must never fail a test run, so the
    // batch is dropped and the affected rows simply show no latency.
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', flush);
}

/**
 * Resolves the test that issued a request. Lazily required so that importing the transport
 * outside a Playwright worker — from a plain node script, say — does not pull in the runner.
 */
function currentTestId(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { test } = require('@playwright/test') as typeof import('@playwright/test');
    return test.info().testId;
  } catch {
    // Called outside a test: worker-fixture setup, or a helper script.
    return '__session__';
  }
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

/** Records one completed HTTP round trip. Never throws. */
export function recordApiCall(input: {
  method: string;
  url: string;
  status: number;
  latencyMs: number;
  body?: string;
}): void {
  try {
    installExitHook();
    buffer.push({
      testId: currentTestId(),
      method: input.method.toUpperCase(),
      path: pathOf(input.url),
      status: input.status,
      latencyMs: Math.round(input.latencyMs),
      body: input.body,
      at: Date.now(),
    });
    if (buffer.length >= FLUSH_AT) flush();
  } catch {
    // Observational only.
  }
}

/** Clears telemetry from previous runs. Called by the reporter before the suite starts. */
export function resetTelemetry(): void {
  fs.rmSync(TELEMETRY_DIR, { recursive: true, force: true });
  fs.mkdirSync(CALLS_DIR, { recursive: true });
}

/**
 * Reads everything the workers flushed. `since` guards against a worker crash having left
 * records from an earlier run behind, which would otherwise attach stale latencies to
 * freshly-run tests.
 */
export function readTelemetry(since: number): ApiCallRecord[] {
  let files: string[];
  try {
    files = fs.readdirSync(CALLS_DIR).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return [];
  }

  const records: ApiCallRecord[] = [];
  for (const file of files) {
    let contents: string;
    try {
      contents = fs.readFileSync(path.join(CALLS_DIR, file), 'utf-8');
    } catch {
      continue;
    }
    for (const line of contents.split('\n')) {
      if (!line) continue;
      try {
        const record = JSON.parse(line) as ApiCallRecord;
        if (record.at >= since) records.push(record);
      } catch {
        // A torn final line from a worker killed mid-flush; the rest of the file is usable.
      }
    }
  }
  return records.sort((a, b) => a.at - b.at);
}

/** Removes the telemetry directory once the report has been compiled. */
export function clearTelemetry(): void {
  fs.rmSync(TELEMETRY_DIR, { recursive: true, force: true });
}
