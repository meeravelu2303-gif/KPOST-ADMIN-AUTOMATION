import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import type { RunModel } from './run-model';
import { EXECUTIVE_FILENAME, ROOT, resolveLatestRun } from './run-paths';

dotenv.config({ path: path.resolve(ROOT, '.env'), quiet: true });

/**
 * Chat webhook notifier — Slack, Mattermost or Microsoft Teams.
 *
 * One `WEBHOOK_URL` drives all three. Slack and Mattermost both accept `{ "text": "..." }`
 * with the same markdown dialect; Teams' incoming-webhook connector ignores that field and
 * needs a MessageCard, so the payload shape is chosen from the host rather than from another
 * environment variable nobody remembers to set.
 */

const LOG = '[KPOST Reporter]';
const TIMEOUT_MS = 10_000;

export type WebhookFlavour = 'teams' | 'slack';

/** Teams rejects a bare `text` payload; everything else in common use accepts it. */
export function detectFlavour(url: string): WebhookFlavour {
  return /(\.office\.com|\.office365\.com|webhook\.office|logic\.azure\.com)/i.test(url)
    ? 'teams'
    : 'slack';
}

function passRate(model: RunModel): number {
  return model.totals.total
    ? Math.round((model.totals.passed / model.totals.total) * 1000) / 10
    : 0;
}

/**
 * Bug ids for the alert line. Capped, because a bad deployment can file dozens of defects and
 * a chat message listing all of them is scrolled past rather than read — the count and the
 * report link carry the rest.
 */
function bugSummary(model: RunModel, limit = 8): string {
  if (model.defects.length === 0) return 'none';
  const shown = model.defects.slice(0, limit).map((defect) => defect.id);
  const owners = Array.from(new Set(model.defects.map((defect) => defect.owner)));
  const overflow = model.defects.length > limit ? ` +${model.defects.length - limit} more` : '';
  const assignee = owners.length === 1 ? owners[0] : `${owners.length} teams`;
  return `${shown.join(', ')}${overflow} (assigned to ${assignee})`;
}

export function buildMessage(model: RunModel, reportPath: string): string {
  const alarm = model.totals.failed > 0 ? '🚨' : '✅';
  return [
    `${alarm} *KPOST Test Run Completed* | Environment: ${model.environment.name}`,
    `*Results:* Passed: ${model.totals.passed} | Failed: ${model.totals.failed} | Pass Rate: ${passRate(model)}%`,
    `*Logged Bugs:* ${bugSummary(model)}`,
    `📄 *Latest Report:* \`${reportPath}\``,
  ].join('\n');
}

export function buildPayload(model: RunModel, reportPath: string, flavour: WebhookFlavour): unknown {
  const text = buildMessage(model, reportPath);
  if (flavour === 'slack') return { text };

  // Teams renders \n\n as a paragraph break and single newlines not at all.
  return {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    summary: `KPOST test run — ${model.totals.failed} failed`,
    themeColor: model.totals.failed > 0 ? 'B3261E' : '0F5C3F',
    title: `KPOST Test Run Completed — ${model.environment.name}`,
    text: text.split('\n').join('\n\n'),
  };
}

export interface DispatchResult {
  sent: boolean;
  detail: string;
}

export async function sendWebhookAlert(input?: { model: RunModel }): Promise<DispatchResult> {
  const url = process.env.WEBHOOK_URL;
  if (!url) {
    const detail = 'Webhook dispatch skipped - WEBHOOK_URL not configured';
    console.log(`${LOG} ${detail}`);
    return { sent: false, detail };
  }

  let model = input?.model;
  if (!model) {
    const latest = resolveLatestRun();
    if (!latest) {
      const detail = 'Webhook dispatch skipped - no run found under reports/runs/';
      console.log(`${LOG} ${detail}`);
      return { sent: false, detail };
    }
    model = JSON.parse(fs.readFileSync(latest.runModel, 'utf-8')) as RunModel;
  }

  const flavour = detectFlavour(url);
  const payload = buildPayload(model, `./reports/latest/${EXECUTIVE_FILENAME}`, flavour);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, 200);
      const detail = `Webhook dispatch failed - HTTP ${response.status} ${body}`.trim();
      console.log(`${LOG} ${detail}`);
      return { sent: false, detail };
    }
    const detail = `Webhook alert delivered (${flavour} format)`;
    console.log(`${LOG} ${detail}`);
    return { sent: true, detail };
  } catch (error) {
    const detail = `Webhook dispatch failed - ${error instanceof Error ? error.message : String(error)}`;
    console.log(`${LOG} ${detail}`);
    return { sent: false, detail };
  } finally {
    clearTimeout(timer);
  }
}

if (require.main === module) {
  void sendWebhookAlert();
}
