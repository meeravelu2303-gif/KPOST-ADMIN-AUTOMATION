/**
 * How a run's target is labelled, in one place.
 *
 * This lived privately inside `reporters/run-model.ts`, which meant the executive report said
 * "Local" while `BUG_REPORT.json` — the document the QA Dashboard ingests — carried the raw
 * `http://localhost:9595`. The dashboard's Env column showed a URL, and two runs against the
 * same environment through different hostnames grouped as different environments.
 *
 * Both consumers now share this module, so the label a human reads and the label the dashboard
 * groups by are the same string by construction.
 */

/** Host with its port, or the input unchanged when it is not a parseable URL. */
export function hostOf(baseURL: string): string {
  try {
    const url = new URL(baseURL);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return baseURL;
  }
}

/**
 * The environment label. An explicit `TEST_ENV` always wins; otherwise the target host is the
 * only evidence available, and a wrong guess on a production URL is the expensive one, so
 * anything unrecognised is reported as Unknown rather than assumed safe.
 *
 * `ENVIRONMENT` is accepted as an alias because CI systems commonly set that name already.
 */
export function environmentName(baseURL: string): string {
  const explicit = process.env.TEST_ENV ?? process.env.ENVIRONMENT;
  if (explicit) return explicit;

  const host = hostOf(baseURL).split(':')[0].toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host.startsWith('192.168.')) return 'Local';
  /*
   * `staging` is spelled out rather than covered by `stag`: there is no word boundary between
   * "stag" and "ing", so the original `\b(stag|stg|uat)\b|stage\.` matched `uat-api` and
   * `stage.host` but reported the commonest form of all — `staging.host` — as Unknown. Harmless
   * while this was only a report header; now that the same label groups runs in the QA
   * Dashboard, it would have filed every staging run under Unknown.
   */
  if (/\b(stag|stage|staging|stg|uat)\b/.test(host)) return 'Staging';
  if (/\b(qa|test|dev)\b/.test(host)) return 'QA';
  if (/\b(prod|live)\b/.test(host)) return 'Production';
  return 'Unknown';
}
