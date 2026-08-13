import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import type { BugPayload } from './kpost-bug-payloads';
import { REPORTS_DIR, ROOT, resolveLatestRun } from './run-paths';

dotenv.config({ path: path.resolve(ROOT, '.env'), quiet: true });

/**
 * Issue-tracker dispatcher — files each defect as a ticket in Plane or Redmine.
 *
 * Two rules make this safe to run on every build:
 *
 *  1. **One ticket per defect, once.** Dispatched defects are recorded in
 *     `reports/dispatched-bugs.json` and skipped thereafter. Without that ledger, a nightly
 *     schedule re-files the same twelve findings every night until the tracker is unusable.
 *     The key is the defect's content hash (`BUG-API-XXXXXX`), not its `KP-001` display id —
 *     display ids are positional and shift as the ledger grows, the hash does not.
 *  2. **Fail-safe.** Missing configuration is a clean skip; a tracker outage is a logged
 *     failure. Neither fails the test run.
 */

const LOG = '[KPOST Reporter]';
const TIMEOUT_MS = 15_000;
const DISPATCH_LEDGER = path.join(REPORTS_DIR, 'dispatched-bugs.json');

export interface DispatchedRecord {
  key: string;
  bugId: string;
  tracker: string;
  issueRef: string;
  dispatchedAt: string;
  summary: string;
}

export interface TrackerConfig {
  tracker: 'plane' | 'redmine';
  url: string;
  apiKey: string;
  projectId?: string;
  workspaceSlug?: string;
}

export function readTrackerConfig(): { config: TrackerConfig } | { skip: string } {
  const planeUrl = process.env.PLANE_API_URL;
  const redmineUrl = process.env.REDMINE_API_URL;
  if (!planeUrl && !redmineUrl) {
    return { skip: 'Bug dispatch skipped - neither PLANE_API_URL nor REDMINE_API_URL configured' };
  }

  const apiKey = process.env.TRACKER_API_KEY;
  if (!apiKey) return { skip: 'Bug dispatch skipped - TRACKER_API_KEY not configured' };

  if (planeUrl) {
    const workspaceSlug = process.env.PLANE_WORKSPACE_SLUG;
    const projectId = process.env.PLANE_PROJECT_ID;
    // Plane addresses issues per workspace and project; without both, the endpoint cannot be
    // formed and a POST would 404 on every defect.
    if (!workspaceSlug || !projectId) {
      return {
        skip: 'Bug dispatch skipped - PLANE_WORKSPACE_SLUG and PLANE_PROJECT_ID are required alongside PLANE_API_URL',
      };
    }
    return { config: { tracker: 'plane', url: planeUrl, apiKey, workspaceSlug, projectId } };
  }

  const projectId = process.env.REDMINE_PROJECT_ID;
  if (!projectId) {
    return { skip: 'Bug dispatch skipped - REDMINE_PROJECT_ID is required alongside REDMINE_API_URL' };
  }
  return { config: { tracker: 'redmine', url: redmineUrl as string, apiKey, projectId } };
}

/* ------------------------------------------------------------------ request shaping */

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function endpointFor(config: TrackerConfig): string {
  if (config.tracker === 'plane') {
    // Accept either the bare host or a fully-formed issues endpoint, so an operator who
    // already knows their URL is not forced to decompose it.
    if (/\/issues\/?$/.test(config.url)) return config.url;
    return `${trimSlash(config.url)}/api/v1/workspaces/${config.workspaceSlug}/projects/${config.projectId}/issues/`;
  }
  if (/\/issues\.json$/.test(config.url)) return config.url;
  return `${trimSlash(config.url)}/issues.json`;
}

/** Plane priorities are lowercase words; Redmine uses numeric priority ids. */
const PLANE_PRIORITY: Record<string, string> = {
  Critical: 'urgent',
  High: 'high',
  Medium: 'medium',
  Low: 'low',
};
const REDMINE_PRIORITY: Record<string, number> = { Critical: 5, High: 4, Medium: 2, Low: 1 };

export function requestFor(
  config: TrackerConfig,
  payload: BugPayload
): { url: string; headers: Record<string, string>; body: string } {
  const description = [
    payload.stackTrace,
    '',
    `Endpoint: ${payload.kpost.method} ${payload.endpoint}`,
    `Module: ${payload.kpost.module}`,
    `Classification: ${payload.kpost.classification}`,
    `Occurrences: ${payload.kpost.occurrences} test(s)`,
    `Environment: ${payload.kpost.environment} (${payload.kpost.baseURL})`,
    `KPOST ledger reference: ${payload.kpost.ledgerId || payload.bugId}`,
  ].join('\n');

  if (config.tracker === 'plane') {
    return {
      url: endpointFor(config),
      headers: { 'Content-Type': 'application/json', 'x-api-key': config.apiKey },
      body: JSON.stringify({
        name: payload.summary,
        description_html: `<p>${description.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br/>')}</p>`,
        priority: PLANE_PRIORITY[payload.severity] ?? 'medium',
      }),
    };
  }

  return {
    url: endpointFor(config),
    headers: { 'Content-Type': 'application/json', 'X-Redmine-API-Key': config.apiKey },
    body: JSON.stringify({
      issue: {
        project_id: config.projectId,
        subject: payload.summary,
        description,
        priority_id: REDMINE_PRIORITY[payload.severity] ?? 2,
      },
    }),
  };
}

/** Both trackers echo the created issue; the id is what a human needs to follow the link. */
function issueRefFrom(tracker: string, body: unknown): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (tracker === 'redmine' && record.issue && typeof record.issue === 'object') {
      const issue = record.issue as Record<string, unknown>;
      if (issue.id !== undefined) return `#${String(issue.id)}`;
    }
    if (record.sequence_id !== undefined) return `#${String(record.sequence_id)}`;
    if (record.id !== undefined) return String(record.id);
  }
  return 'created';
}

/* ------------------------------------------------------------------ dedupe ledger */

export function readDispatchLedger(): DispatchedRecord[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(DISPATCH_LEDGER, 'utf-8'));
    return Array.isArray(parsed) ? (parsed as DispatchedRecord[]) : [];
  } catch {
    return [];
  }
}

function writeDispatchLedger(records: DispatchedRecord[]): void {
  fs.mkdirSync(path.dirname(DISPATCH_LEDGER), { recursive: true });
  fs.writeFileSync(DISPATCH_LEDGER, `${JSON.stringify(records, null, 2)}\n`, 'utf-8');
}

/** Content hash where available; the summary is the fallback for synthesised findings. */
export function dedupeKey(payload: BugPayload): string {
  return payload.kpost.ledgerId || `synthetic::${payload.summary}`;
}

/* ------------------------------------------------------------------ entry point */

export interface DispatchResult {
  sent: boolean;
  detail: string;
  created: number;
  skipped: number;
  failed: number;
}

export async function dispatchBugsToTracker(input?: {
  payloadsPath: string;
}): Promise<DispatchResult> {
  const settings = readTrackerConfig();
  if ('skip' in settings) {
    console.log(`${LOG} ${settings.skip}`);
    return { sent: false, detail: settings.skip, created: 0, skipped: 0, failed: 0 };
  }

  let payloadsPath = input?.payloadsPath;
  if (!payloadsPath) {
    const latest = resolveLatestRun();
    if (!latest) {
      const detail = 'Bug dispatch skipped - no run found under reports/runs/';
      console.log(`${LOG} ${detail}`);
      return { sent: false, detail, created: 0, skipped: 0, failed: 0 };
    }
    payloadsPath = latest.bugPayloads;
  }

  let payloads: BugPayload[];
  try {
    payloads = JSON.parse(fs.readFileSync(payloadsPath, 'utf-8')) as BugPayload[];
  } catch (error) {
    const detail = `Bug dispatch skipped - could not read ${payloadsPath}: ${error instanceof Error ? error.message : String(error)}`;
    console.log(`${LOG} ${detail}`);
    return { sent: false, detail, created: 0, skipped: 0, failed: 0 };
  }

  if (payloads.length === 0) {
    const detail = 'Bug dispatch skipped - no defects in this run';
    console.log(`${LOG} ${detail}`);
    return { sent: true, detail, created: 0, skipped: 0, failed: 0 };
  }

  const ledger = readDispatchLedger();
  const alreadyFiled = new Set(ledger.map((record) => record.key));
  const fresh = payloads.filter((payload) => !alreadyFiled.has(dedupeKey(payload)));
  const skipped = payloads.length - fresh.length;

  let created = 0;
  let failed = 0;

  for (const payload of fresh) {
    const request = requestFor(settings.config, payload);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      if (!response.ok) {
        failed += 1;
        const body = (await response.text().catch(() => '')).slice(0, 180);
        console.log(`${LOG} ${payload.bugId} not filed - HTTP ${response.status} ${body}`.trim());
        continue;
      }
      const parsed: unknown = await response.json().catch(() => null);
      const issueRef = issueRefFrom(settings.config.tracker, parsed);
      ledger.push({
        key: dedupeKey(payload),
        bugId: payload.bugId,
        tracker: settings.config.tracker,
        issueRef,
        dispatchedAt: new Date().toISOString(),
        summary: payload.summary,
      });
      created += 1;
      console.log(`${LOG} ${payload.bugId} filed in ${settings.config.tracker} as ${issueRef}`);
    } catch (error) {
      failed += 1;
      console.log(
        `${LOG} ${payload.bugId} not filed - ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      clearTimeout(timer);
    }
  }

  if (created > 0) writeDispatchLedger(ledger);

  const detail =
    `Bug dispatch to ${settings.config.tracker}: ${created} created, ` +
    `${skipped} already filed, ${failed} failed`;
  console.log(`${LOG} ${detail}`);
  return { sent: failed === 0, detail, created, skipped, failed };
}

if (require.main === module) {
  void dispatchBugsToTracker();
}
