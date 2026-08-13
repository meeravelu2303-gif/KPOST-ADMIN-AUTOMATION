/**
 * Developer Digest — the human-readable summary of a run, and the webhook payloads that
 * carry it.
 *
 * ## Why this is a generator, not another dispatcher
 *
 * `reporters/send-webhook-alert.ts` and `reporters/send-email-report.ts` already own
 * *delivery*: SMTP, Slack/Teams payload shaping, timeouts, and the fail-safe behaviour that
 * stops an unreachable webhook from failing a test run. Duplicating any of that here would
 * be exactly the redundancy this module was asked to avoid.
 *
 * What did not exist is the **digest itself**: a grouped, triage-ready summary broken down by
 * severity, module and assigned owner, produced as a durable artifact that can be read
 * without running Playwright.
 *
 * So this module is deliberately **pure and side-effect-light**: it reads `BUG_REPORT.json`,
 * builds the digest, and writes two files. It sends nothing. The dispatchers can consume
 * `buildWebhookPayload()`, CI can read `DEV_DIGEST.md`, and a human can open it in a browser
 * or paste it into a ticket.
 *
 * Reading `BUG_REPORT.json` rather than the in-memory run model is what makes it runnable
 * standalone (`npm run notify`) long after the run finished — useful when someone asks "what
 * did last night's run find?" and nobody wants to re-run 3,900 tests to answer.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const BUG_REPORT_JSON = path.join(ROOT, 'BUG_REPORT.json');
const DIGEST_MD = path.join(ROOT, 'DEV_DIGEST.md');
const DIGEST_JSON = path.join(ROOT, 'DEV_DIGEST.json');

export type DigestFlavour = 'slack' | 'teams' | 'discord' | 'markdown';

interface DefectRecord {
  id: string;
  displayId?: string;
  title: string;
  severity: string;
  priority: string;
  module: string;
  owner: string;
  method: string;
  endpointPath: string;
  classification: string;
  riskImpact: string;
}

interface BugReportJson {
  generatedAt: string;
  environment: string;
  run: {
    totalTests: number;
    passed: number;
    failed: number;
    skipped: number;
    durationSeconds: number;
    endpointsExercised: number;
    authStrategy: string;
  };
  summary: {
    total: number;
    bySeverity: Record<string, number>;
    byPriority: Record<string, number>;
    byModule: Record<string, number>;
    byOwner: Record<string, number>;
    byClassification: Record<string, number>;
  };
  defects: DefectRecord[];
}

export interface Digest {
  generatedAt: string;
  environment: string;
  headline: string;
  verdict: string;
  run: BugReportJson['run'] & { passRate: string };
  bySeverity: Record<string, number>;
  byPriority: Record<string, number>;
  byModule: Array<{ name: string; count: number }>;
  byOwner: Array<{ name: string; count: number }>;
  /** The defects a reader should look at first — P0 and P1, most severe first. */
  topDefects: DefectRecord[];
}

const SEVERITY_ORDER = ['Critical', 'Major', 'Medium', 'Low'];

function sortedEntries(counts: Record<string, number>): Array<{ name: string; count: number }> {
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Reads the machine-readable report. Returns null when a run has not produced one yet. */
export function readBugReportJson(file = BUG_REPORT_JSON): BugReportJson | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as BugReportJson;
  } catch {
    return null;
  }
}

/**
 * Builds the digest model.
 *
 * The verdict wording matches `BUG_REPORT.md` on purpose — a digest that grades a run
 * differently from the report it summarises is worse than no digest, because the two get
 * quoted against each other in the same thread.
 */
export function buildDigest(report: BugReportJson): Digest {
  const { run, summary } = report;
  const executed = run.passed + run.failed;
  const passRate = executed === 0 ? '0.0' : ((run.passed / executed) * 100).toFixed(1);

  const critical = summary.bySeverity.Critical ?? 0;
  const major = summary.bySeverity.Major ?? 0;

  const verdict =
    critical > 0
      ? `DO NOT SHIP — ${critical} critical defect${critical === 1 ? '' : 's'} open (auth bypass, injection, or data exposure).`
      : major > 0
        ? `SHIP AT RISK — no critical defects, but ${major} major gap${major === 1 ? '' : 's'} remain.`
        : summary.total > 0
          ? 'ACCEPTABLE — only contract deviations recorded.'
          : 'CLEAN — no deviations detected.';

  const topDefects = [...report.defects]
    .filter((d) => d.priority === 'P0' || d.priority === 'P1')
    .sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
        a.endpointPath.localeCompare(b.endpointPath)
    )
    .slice(0, 10);

  return {
    generatedAt: report.generatedAt,
    environment: report.environment,
    headline: `${summary.total} defect${summary.total === 1 ? '' : 's'} across ${run.endpointsExercised} endpoints — ${passRate}% of ${executed} tests passed`,
    verdict,
    run: { ...run, passRate },
    bySeverity: summary.bySeverity,
    byPriority: summary.byPriority,
    byModule: sortedEntries(summary.byModule),
    byOwner: sortedEntries(summary.byOwner),
    topDefects,
  };
}

function severityRow(bySeverity: Record<string, number>): string {
  return SEVERITY_ORDER.map((s) => `${s} ${bySeverity[s] ?? 0}`).join(' · ');
}

/** The digest as Markdown — what lands in `DEV_DIGEST.md` and in a Discord/Slack code block. */
export function renderMarkdown(digest: Digest): string {
  const { run } = digest;

  return `# KPOST Admin API — Developer Digest

> ${digest.generatedAt} · target \`${digest.environment}\`

**${digest.verdict}**

${digest.headline}

## Execution

| Metric | Value |
| --- | --- |
| Scenarios run | ${run.totalTests} |
| Passed | ${run.passed} |
| Failed | ${run.failed} |
| Skipped | ${run.skipped} |
| Pass rate | ${run.passRate}% |
| Duration | ${run.durationSeconds}s |
| Endpoints exercised | ${run.endpointsExercised} |
| Authentication | ${run.authStrategy} |

## Defects by severity

| Severity | Count |
| --- | --- |
${SEVERITY_ORDER.map((s) => `| ${s} | ${digest.bySeverity[s] ?? 0} |`).join('\n')}

## Defects by priority

| Priority | Count |
| --- | --- |
${['P0', 'P1', 'P2', 'P3'].map((p) => `| ${p} | ${digest.byPriority[p] ?? 0} |`).join('\n')}

## Defects by module

| Module | Defects |
| --- | --- |
${digest.byModule.map((m) => `| ${m.name} | ${m.count} |`).join('\n') || '| _none_ | 0 |'}

## Defects by assigned owner

| Owner | Defects |
| --- | --- |
${digest.byOwner.map((o) => `| ${o.name} | ${o.count} |`).join('\n') || '| _none_ | 0 |'}

## Fix these first (P0/P1)

| ID | Severity | Owner | Endpoint | Title |
| --- | --- | --- | --- | --- |
${
    digest.topDefects
      .map(
        (d) =>
          `| ${d.displayId ?? d.id} | ${d.severity} | ${d.owner} | \`${d.method} ${d.endpointPath}\` | ${d.title} |`
      )
      .join('\n') || '| _none_ | — | — | — | — |'
  }

_Full detail, reproduction curl and Playwright snippets: \`BUG_REPORT.md\`._
`;
}

/**
 * A webhook payload in the shape the target expects.
 *
 * Teams' incoming-webhook connector rejects a bare `{text}` and needs a MessageCard; Slack
 * and Discord both accept `{content}`/`{text}`. Getting this wrong produces a silent 400 that
 * looks like "the alert just never arrived", which is why the shape is explicit per flavour
 * rather than one payload sent hopefully to all three.
 */
export function buildWebhookPayload(digest: Digest, flavour: DigestFlavour): unknown {
  const summaryLine = `*KPOST API run* — ${digest.verdict}`;
  const detail = [
    digest.headline,
    `Severity: ${severityRow(digest.bySeverity)}`,
    `Top owners: ${digest.byOwner.slice(0, 3).map((o) => `${o.name} (${o.count})`).join(', ') || 'none'}`,
  ].join('\n');

  switch (flavour) {
    case 'teams':
      return {
        '@type': 'MessageCard',
        '@context': 'https://schema.org/extensions',
        summary: 'KPOST API test run',
        themeColor: (digest.bySeverity.Critical ?? 0) > 0 ? 'D93F0B' : '2EA043',
        title: 'KPOST API — Developer Digest',
        text: `${digest.verdict}\n\n${detail}`,
      };
    case 'discord':
      // Discord caps `content` at 2000 characters and renders Markdown, so the digest goes in
      // a fenced block and is truncated rather than silently rejected.
      return { content: `\`\`\`\n${`${summaryLine}\n${detail}`.slice(0, 1900)}\n\`\`\`` };
    case 'markdown':
      return { markdown: renderMarkdown(digest) };
    case 'slack':
    default:
      return { text: `${summaryLine}\n${detail}` };
  }
}

export interface DigestResult {
  written: boolean;
  reason?: string;
  markdownPath?: string;
  jsonPath?: string;
  digest?: Digest;
}

/**
 * Generates the digest artifacts.
 *
 * Fail-safe by construction, like the dispatchers: it returns a result object and never
 * throws, so a missing report or an unwritable directory cannot break a CI step that runs it
 * after the suite.
 */
export function generateDigest(): DigestResult {
  const report = readBugReportJson();
  if (!report) {
    return {
      written: false,
      reason: `No BUG_REPORT.json found at ${BUG_REPORT_JSON}. Run the suite first (npm test).`,
    };
  }

  try {
    const digest = buildDigest(report);
    fs.writeFileSync(DIGEST_MD, renderMarkdown(digest), 'utf-8');
    fs.writeFileSync(
      DIGEST_JSON,
      `${JSON.stringify(
        {
          digest,
          webhooks: {
            slack: buildWebhookPayload(digest, 'slack'),
            teams: buildWebhookPayload(digest, 'teams'),
            discord: buildWebhookPayload(digest, 'discord'),
          },
        },
        null,
        2
      )}\n`,
      'utf-8'
    );
    return { written: true, markdownPath: DIGEST_MD, jsonPath: DIGEST_JSON, digest };
  } catch (error) {
    return { written: false, reason: `Digest generation failed: ${(error as Error).message}` };
  }
}

/* Runnable directly: `npm run notify`. */
if (require.main === module) {
  const result = generateDigest();
  if (!result.written) {
    console.log(`[KPOST Digest] skipped - ${result.reason}`);
  } else {
    console.log(`[KPOST Digest] ${result.digest?.verdict}`);
    console.log(`[KPOST Digest] ${result.digest?.headline}`);
    console.log(`[KPOST Digest] wrote ${result.markdownPath}`);
    console.log(`[KPOST Digest] wrote ${result.jsonPath}`);
  }
}
