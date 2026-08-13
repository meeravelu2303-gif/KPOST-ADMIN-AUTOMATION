import fs from 'fs';
import path from 'path';
import type { Reporter } from '@playwright/test/reporter';

/**
 * Pushes the finished run to the external QA Dashboard.
 *
 * The dashboard is a separate product in its own repository: it serves 10+ test
 * benches, owns its schema, its users and its uptime. This bench therefore knows
 * nothing about that storage — it POSTs one JSON document and forgets. No
 * database driver, no connection string, no schema knowledge, and nothing new in
 * `package.json`: the POST uses Node's built-in `fetch`.
 *
 * **Must stay LAST in `playwright.config.ts`.** Reporter `onEnd` hooks run in
 * array order and this reads `BUG_REPORT.json`, which `src/reporters/bugReporter.ts`
 * writes in its own `onEnd`. Placed any earlier it would upload the *previous*
 * run — the same ordering constraint that keeps `kpost-master-reporter` ahead of
 * `bugReporter`.
 *
 * Fail-safe by construction, exactly like the dispatchers in `send-*.ts`: it
 * returns rather than throws, and prints one line whatever happens. An
 * unreachable dashboard must never change a test run's exit code — the run's own
 * result is the product, and this is telemetry about it.
 */

const TIMEOUT_MS = 10_000;

export interface IngestOutcome {
  posted: boolean;
  reason?: string;
  runId?: string;
}

export async function pushToDashboard(
  reportPath = path.resolve(__dirname, '..', 'BUG_REPORT.json')
): Promise<IngestOutcome> {
  const url = process.env.DASHBOARD_INGEST_URL;
  const apiKey = process.env.DASHBOARD_API_KEY;

  // Unset is a decision, not a fault: most developers run this suite with no
  // dashboard at all. Matches the "… skipped - X not configured" line the email,
  // webhook and tracker dispatchers print.
  if (!url || !apiKey) {
    const missing = !url ? 'DASHBOARD_INGEST_URL' : 'DASHBOARD_API_KEY';
    return { posted: false, reason: `${missing} not configured` };
  }

  if (!fs.existsSync(reportPath)) {
    return { posted: false, reason: `${path.basename(reportPath)} not found` };
  }

  let body: string;
  try {
    /*
     * BUG_REPORT.json is forwarded essentially as-is — the dashboard's ingest
     * contract *is* this document, and reshaping it here would move the mapping
     * into the wrong repository, where ten benches would each drift their own way.
     *
     * The one exception is `run.durationMs`. The ledger records
     * `durationSeconds` (what a human reads in the report header) while the
     * dashboard's schema requires milliseconds, and rejects the payload with
     * `422 {"details":[{"path":"run.durationMs","message":"Required"}]}` without
     * it. `durationSeconds` is left in place so the document a human reads and
     * the document the dashboard stores stay the same file.
     */
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as {
      run?: { durationSeconds?: number; durationMs?: number };
    };
    if (report.run && report.run.durationMs === undefined) {
      report.run.durationMs = Math.round((report.run.durationSeconds ?? 0) * 1000);
    }
    body = JSON.stringify(report);
  } catch (error) {
    return { posted: false, reason: `unreadable report - ${messageOf(error)}` };
  }

  // A hung dashboard must not hold the process open after the suite is done.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body,
      signal: abort.signal,
    });

    if (!response.ok) {
      /*
       * The response body carries the reason. A bare "HTTP 422" sends someone
       * hunting through two repositories; "422 - run.durationMs: Required" is
       * the whole diagnosis. Clipped because a stack trace or an HTML error page
       * would otherwise dump into the run log.
       */
      const detail = await response.text().catch(() => '');
      const explained = summariseError(detail);
      return {
        posted: false,
        reason: `HTTP ${response.status} ${response.statusText}${explained ? ` - ${explained}` : ''}`,
      };
    }

    // runId is the dashboard's own identifier for the stored run; logging it is
    // what lets someone jump from a CI log to the right dashboard page.
    const payload = (await response.json().catch(() => ({}))) as { runId?: string | number };
    return {
      posted: true,
      runId: payload.runId === undefined ? undefined : String(payload.runId),
    };
  } catch (error) {
    const reason =
      error instanceof Error && error.name === 'AbortError'
        ? `no response within ${TIMEOUT_MS / 1000}s`
        : messageOf(error);
    return { posted: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Turns the dashboard's error response into one readable clause.
 *
 * Its validator answers `{"error":"Invalid payload","details":[{"path":"…",
 * "message":"…"}]}`, which flattens to `field: reason` pairs — the form that
 * tells a reader which field to fix. Anything else (a proxy's HTML page, a plain
 * string) is clipped to a single line so the run log stays readable.
 */
function summariseError(body: string): string {
  const trimmed = body.trim();
  if (trimmed === '') return '';

  try {
    const parsed = JSON.parse(trimmed) as {
      error?: string;
      message?: string;
      details?: Array<{ path?: string; message?: string }>;
    };
    const fields = (parsed.details ?? [])
      .map((d) => [d.path, d.message].filter(Boolean).join(': '))
      .filter(Boolean);
    const headline = parsed.error ?? parsed.message ?? '';
    return [headline, fields.join('; ')].filter(Boolean).join(' - ').slice(0, 300);
  } catch {
    return trimmed.replace(/\s+/g, ' ').slice(0, 200);
  }
}

export default class DashboardIngestReporter implements Reporter {
  async onEnd(): Promise<void> {
    try {
      const outcome = await pushToDashboard();
      if (outcome.posted) {
        const suffix = outcome.runId ? ` - dashboard runId ${outcome.runId}` : '';
        console.log(`[KPOST Dashboard] run published${suffix}`);
      } else {
        console.log(`[KPOST Dashboard] ingest skipped - ${outcome.reason}`);
      }
    } catch (error) {
      // Unreachable by design; kept because a throw here would surface as a
      // reporter crash and cast doubt on an otherwise valid run.
      console.log(`[KPOST Dashboard] ingest skipped - ${messageOf(error)}`);
    }
  }

  /** Keeps this line out of Playwright's own error summary. */
  printsToStdio(): boolean {
    return true;
  }
}
