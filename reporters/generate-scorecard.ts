import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * Generates `SUITE_SCORECARD.md`.
 *
 * ## The design decision that matters here
 *
 * A scorecard that a script awards itself is worthless. Three of the four rubric categories
 * ("clean structure", "depth of bug-hunting", "developer actionability") are judgements, and a
 * generator that mechanically prints 25/25 for each is theatre — it would score a broken suite
 * exactly as highly as a good one.
 *
 * So this file **measures what is measurable and refuses to invent the rest.** Every number
 * below is derived from an artifact the run actually produced:
 *
 * - duplicate route signatures, from Playwright's own resolved test list
 * - endpoints under the 10-case floor, from the same list
 * - TypeScript status, from a real `tsc --noEmit` invocation
 * - coverage, from `api.json` against the resolved test signatures
 * - reproduction quality, from counting curl blocks in `BUG_REPORT.json`
 * - artifact presence, from the filesystem
 *
 * Each rubric point is then scored against a **stated, checkable rule** — printed next to the
 * score, so a reader can disagree with the arithmetic rather than having to trust it. Where a
 * criterion cannot be measured, the scorecard says so and deducts, rather than assuming credit.
 *
 * ## Where this diverges from the main framework's scorecard
 *
 * That one spends 15 of its 100 points on "V1 legacy specs purged". This module has no
 * superseded tag and no `tests/legacy/`, so those points would be awarded unconditionally on
 * every run — free credit that measures nothing, which is the exact failure this generator is
 * built to avoid. They are replaced by two properties that are load-bearing *here*: that the
 * generated ownership registry still covers every documented path (a stale registry misroutes
 * every bug ticket, and ticket routing is this bench's product), and that every spec directory
 * is actually registered as a Playwright project (an unregistered directory never runs, and
 * silently contributes zero coverage while looking like coverage in the tree).
 */

/**
 * Resolve the project root from the working directory when that is plausibly the project, and
 * fall back to walking up from this file. The distinction matters because this generator is
 * compiled to a scratch directory before running (the repo has no TypeScript runner), and
 * `__dirname` then points at the build output rather than the repo — which silently produced a
 * scorecard measuring an empty directory rather than the suite.
 */
function resolveRoot(): string {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'api.json'))) return cwd;
  return path.resolve(__dirname, '..');
}

const ROOT = resolveRoot();
const p = (...s: string[]) => path.join(ROOT, ...s);

interface Metric {
  label: string;
  value: string;
  ok: boolean;
}

function exists(rel: string): boolean {
  return fs.existsSync(p(rel));
}

function readJson<T>(rel: string): T | null {
  try {
    return parseJsonLoosely<T>(fs.readFileSync(p(rel), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Parses JSON that may carry non-JSON noise around it.
 *
 * `playwright test --list --reporter=json > file` does NOT produce a clean document: dotenv and
 * globalSetup write to the same stdout, so the file opens with banner lines before the `{`.
 * Parsed strictly, that threw, and every list-derived metric silently reported `n/a` with
 * coverage 0.0% — a scorecard confidently grading a fully-covered suite at zero.
 *
 * Seeking to the *first* `{` is not enough either, and that failure only appears once a `.env`
 * exists: dotenv's banner reads
 *   `◇ injected env (36) from .env // tip: ⌘ suppress logs { quiet: true }`
 * whose own brace is the first one in the file. Candidates are therefore restricted to a `{`
 * that opens a line, which is where a pretty-printed document actually begins.
 */
function parseJsonLoosely<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const end = raw.lastIndexOf('}');
    if (end === -1) return null;

    const starts: number[] = [];
    if (raw.startsWith('{')) starts.push(0);
    for (let i = raw.indexOf('\n{'); i !== -1; i = raw.indexOf('\n{', i + 1)) starts.push(i + 1);

    for (const start of starts) {
      if (end <= start) continue;
      try {
        return JSON.parse(raw.slice(start, end + 1)) as T;
      } catch {
        // Not this candidate — a later line-initial brace is the real document start.
      }
    }
    return null;
  }
}

/** Real compilation check — not a claim that one was run. */
function typecheck(): { clean: boolean; detail: string } {
  try {
    execFileSync('npx', ['tsc', '--noEmit'], { cwd: ROOT, stdio: 'pipe', shell: true });
    return { clean: true, detail: 'tsc --noEmit exited 0' };
  } catch (error) {
    const out = String((error as { stdout?: Buffer }).stdout ?? '').trim();
    const count = out.split('\n').filter((l) => /error TS/.test(l)).length;
    return { clean: false, detail: `${count} TypeScript error(s)` };
  }
}

/** Resolved describe signatures, from the JSON test list Playwright emits. */
interface ListSuite {
  file?: string;
  title?: string;
  specs?: { title: string }[];
  suites?: ListSuite[];
}

const SIG = /(?:^|[-–]\s*)(GET|POST|PUT|PATCH|DELETE|VERB)\s+(\S+)/;

/**
 * Drops a trailing slash but never the whole path — a bare `.replace(/\/+$/, '')` turns the
 * liveness route `/` into the empty string, which would report it as permanently uncovered.
 */
function stripTrailingSlash(route: string): string {
  const trimmed = route.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/** Flattens the nested list report into one describe-trail per enumerated case. */
function listRows(listPath: string): { file: string; describe: string }[] {
  const report = readJson<{ suites?: ListSuite[] }>(listPath);
  const rows: { file: string; describe: string }[] = [];
  if (!report) return rows;
  const visit = (s: ListSuite, file: string, trail: string[]) => {
    const f = s.file ?? file;
    const t = s.title && s.title !== f ? [...trail, s.title] : trail;
    for (const _ of s.specs ?? []) rows.push({ file: f, describe: t.join(' > ') });
    for (const child of s.suites ?? []) visit(child, f, t);
  };
  for (const s of report.suites ?? []) visit(s, s.file ?? '', []);
  return rows;
}

/** The METHOD+PATH signature carried by the innermost describe segment that has one. */
function signatureOf(describe: string): string | null {
  for (const seg of describe.split(' > ').reverse()) {
    const m = seg.match(SIG);
    if (m) return `${m[1]} ${stripTrailingSlash(m[2])}`;
  }
  return null;
}

function analyseList(listPath: string): {
  cases: number;
  blocks: number;
  unique: number;
  duplicates: [string, string[]][];
  thin: [string, number][];
  signatures: Set<string>;
} | null {
  const rows = listRows(listPath);
  if (rows.length === 0) return null;

  const blocks = new Map<string, { file: string; sig: string | null; cases: number }>();
  for (const r of rows) {
    const key = `${r.file}||${r.describe}`;
    if (!blocks.has(key)) blocks.set(key, { file: r.file, sig: signatureOf(r.describe), cases: 0 });
    blocks.get(key)!.cases += 1;
  }

  const bySig = new Map<string, { file: string; cases: number }[]>();
  for (const b of blocks.values()) {
    if (!b.sig) continue;
    if (!bySig.has(b.sig)) bySig.set(b.sig, []);
    bySig.get(b.sig)!.push({ file: b.file, cases: b.cases });
  }

  const duplicates: [string, string[]][] = [];
  const thin: [string, number][] = [];
  for (const [sig, list] of bySig) {
    if (list.length > 1) duplicates.push([sig, list.map((l) => l.file)]);
    const total = list.reduce((n, l) => n + l.cases, 0);
    if (total < 10) thin.push([sig, total]);
  }

  return {
    cases: rows.length,
    blocks: blocks.size,
    unique: bySig.size,
    duplicates,
    thin,
    signatures: new Set(bySig.keys()),
  };
}

/** Documented operations in the contract. Every tag on this module is active. */
function documentedOperations(): string[] {
  const spec = readJson<{ paths: Record<string, Record<string, unknown>> }>('api.json');
  const ops: string[] = [];
  if (!spec) return ops;
  for (const [route, methods] of Object.entries(spec.paths)) {
    for (const method of Object.keys(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      ops.push(`${method.toUpperCase()} ${stripTrailingSlash(route)}`);
    }
  }
  return ops;
}

/**
 * Whether the generated ownership registry still covers every documented path.
 *
 * `MODULE_BY_PATH` is what routes a defect to an owning team. When an endpoint is added to the
 * contract and `npm run generate` is not re-run, its tickets fall back to a default owner and
 * quietly reach nobody — a failure that never surfaces in a test result.
 */
function registryCoverage(ops: string[]): { missing: string[]; current: boolean } {
  const registry = (() => {
    try {
      return fs.readFileSync(p('src/api/registry/moduleOwnership.generated.ts'), 'utf-8');
    } catch {
      return '';
    }
  })();
  if (registry === '') return { missing: ops, current: false };

  /*
   * Quote-agnostic on purpose. The generator emits JSON-style double-quoted keys; an earlier
   * version of this check looked only for single quotes and reported all 112 paths as unmapped
   * against a registry that was in fact complete — a scorecard that invents a failure is worth
   * no more than one that invents a pass.
   */
  const paths = new Set(ops.map((o) => o.split(' ')[1]));
  const missing = [...paths].filter(
    (route) => !registry.includes(`"${route}"`) && !registry.includes(`'${route}'`)
  );
  return { missing, current: missing.length === 0 };
}

/**
 * Spec directories that no Playwright project points at.
 *
 * A directory under `tests/` that is not a registered project is never executed. It looks like
 * coverage in the file tree and contributes none, which is the most expensive kind of gap.
 */
function unregisteredSpecDirs(): string[] {
  let config = '';
  try {
    config = fs.readFileSync(p('playwright.config.ts'), 'utf-8');
  } catch {
    return [];
  }
  const testsDir = p('tests');
  if (!fs.existsSync(testsDir)) return [];
  return fs
    .readdirSync(testsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !config.includes(`./tests/${name}`));
}

interface Defect {
  severity: string;
  endpointPath: string;
  curlSnippet?: string;
  reproSnippet?: string;
  requestBody?: string;
  module?: string;
}

function build(listPath: string): string {
  const ts = typecheck();
  const list = analyseList(listPath);
  const ops = documentedOperations();
  const ledger = readJson<{ defects: Defect[]; meta?: Record<string, unknown> }>('BUG_REPORT.json');
  const defects = ledger?.defects ?? [];

  const norm = (s: string) => s.replace(/\/\{[^}]+\}/g, '').replace(/\/+$/, '');
  const signatures = list?.signatures ?? new Set<string>();
  const coveredNorm = new Set<string>();
  for (const s of signatures) coveredNorm.add(norm(s));

  const uncovered = ops.filter((o) => !signatures.has(o) && !coveredNorm.has(norm(o)));
  const coverage = ops.length ? ((ops.length - uncovered.length) / ops.length) * 100 : 0;

  const registry = registryCoverage(ops);
  const orphanDirs = unregisteredSpecDirs();

  const withCurl = defects.filter((d) => (d.curlSnippet ?? '').includes('curl')).length;
  const withSnippet = defects.filter((d) => (d.reproSnippet ?? '').length > 0).length;
  const withOwner = defects.filter((d) => (d.module ?? '').length > 0).length;
  const pct = (n: number) => (defects.length ? Math.round((n / defects.length) * 100) : 0);

  const junitOk = exists('reports/junit-results.xml') || exists('test-results/results.xml');
  const artifacts: Metric[] = [
    { label: 'BUG_REPORT.md', value: exists('BUG_REPORT.md') ? 'present' : 'MISSING', ok: exists('BUG_REPORT.md') },
    { label: 'BUG_REPORT.json', value: exists('BUG_REPORT.json') ? 'present' : 'MISSING', ok: exists('BUG_REPORT.json') },
    { label: 'DEV_DIGEST.md', value: exists('DEV_DIGEST.md') ? 'present' : 'MISSING', ok: exists('DEV_DIGEST.md') },
    { label: 'DEV_DIGEST.json', value: exists('DEV_DIGEST.json') ? 'present' : 'MISSING', ok: exists('DEV_DIGEST.json') },
    { label: 'Playwright HTML (trace viewer)', value: exists('reports/diagnostic/index.html') ? 'present' : 'MISSING', ok: exists('reports/diagnostic/index.html') },
    { label: 'JUnit XML for CI', value: junitOk ? 'present' : 'MISSING', ok: junitOk },
    { label: 'Executive HTML (tier 2)', value: exists('reports/latest/kpost-executive-summary.html') ? 'present' : 'MISSING', ok: exists('reports/latest/kpost-executive-summary.html') },
    { label: 'Trend history (tier 3)', value: exists('reports/kpost-trend-history.json') ? 'present' : 'MISSING', ok: exists('reports/kpost-trend-history.json') },
    { label: 'Bug payload stream (tier 4)', value: exists('reports/latest/kpost-bug-payloads.json') ? 'present' : 'MISSING', ok: exists('reports/latest/kpost-bug-payloads.json') },
  ];

  /* ---- scoring ------------------------------------------------------------------------
   * Each category states its rule inline. Deductions are arithmetic on measured values, so
   * the reader can recompute any figure from the evidence table above it.
   * ---------------------------------------------------------------------------------- */

  // 1. Architecture (25): tsc clean (10), no duplicate signatures (10), registry current (5).
  const archTs = ts.clean ? 10 : 0;
  const archDupes = list && list.duplicates.length === 0 ? 10 : 0;
  const archRegistry = registry.current ? 5 : 0;
  const arch = archTs + archDupes + archRegistry;

  // 2. Bug detection (25): 15 for the 10-case floor, 10 scaled by documented coverage.
  const thinCount = list?.thin.length ?? 0;
  const depth = thinCount === 0 ? 15 : Math.max(0, 15 - thinCount);
  /*
   * Floor, not round. Rounding turned a measured 96.1% coverage into a full 10/10 in the main
   * framework, which is precisely the flattery this generator exists to avoid: a gap you
   * cannot see in the score is a gap nobody fixes.
   */
  const cover = Math.floor((coverage / 100) * 10);
  const detection = depth + cover;

  // 3. Redundancy & wiring (25): no duplicate signatures (15), every spec dir registered (10).
  const redunDupes = list && list.duplicates.length === 0 ? 15 : 0;
  const redunWiring = orphanDirs.length === 0 ? 10 : 0;
  const redundancy = redunDupes + redunWiring;

  // 4. Reporting (25): curl (8), snippet (5), owner (4), artifacts (8).
  const repCurl = Math.round((pct(withCurl) / 100) * 8);
  const repSnip = Math.round((pct(withSnippet) / 100) * 5);
  const repOwner = Math.round((pct(withOwner) / 100) * 4);
  const artefactOk = artifacts.filter((a) => a.ok).length;
  const repArt = Math.round((artefactOk / artifacts.length) * 8);
  const reporting = repCurl + repSnip + repOwner + repArt;

  const total = arch + detection + redundancy + reporting;
  const verdict = total >= 90 ? 'PRODUCTION-READY' : 'REFACTOR REQUIRED';

  const sevCount = (s: string) => defects.filter((d) => d.severity === s).length;

  const lines: string[] = [];
  lines.push('# KPOST Admin Module API Test Suite — Quality Scorecard');
  lines.push('');
  lines.push(`> Generated ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC by \`reporters/generate-scorecard.ts\`.`);
  lines.push('> **Every figure below is measured from a run artifact.** Where a rubric criterion');
  lines.push('> could not be measured, the scorecard says so and deducts rather than assuming credit.');
  lines.push('');
  lines.push(`## Verdict: ${verdict} — ${total}/100`);
  lines.push('');
  lines.push('| Category | Score | Basis |');
  lines.push('| --- | --- | --- |');
  lines.push(`| 1. Architecture & Maintenance | ${arch}/25 | tsc ${archTs}/10 · no duplicate signatures ${archDupes}/10 · ownership registry current ${archRegistry}/5 |`);
  lines.push(`| 2. Bug Detection & Resilience | ${detection}/25 | 10-case floor ${depth}/15 · documented coverage ${cover}/10 |`);
  lines.push(`| 3. Zero Redundancy & Wiring | ${redundancy}/25 | no duplicates ${redunDupes}/15 · every spec dir registered ${redunWiring}/10 |`);
  lines.push(`| 4. Reporting & Actionability | ${reporting}/25 | curl ${repCurl}/8 · snippet ${repSnip}/5 · owner ${repOwner}/4 · artifacts ${repArt}/8 |`);
  lines.push(`| **Total** | **${total}/100** | |`);
  lines.push('');

  lines.push('## Measured evidence');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| TypeScript compilation | ${ts.detail} |`);
  lines.push(`| Test cases enumerated | ${list?.cases ?? 'n/a'} |`);
  lines.push(`| Describe blocks | ${list?.blocks ?? 'n/a'} |`);
  lines.push(`| Unique METHOD+PATH signatures | ${list?.unique ?? 'n/a'} |`);
  lines.push(`| Duplicate signatures | ${list?.duplicates.length ?? 'n/a'} |`);
  lines.push(`| Signatures under the 10-case floor | ${thinCount} |`);
  lines.push(`| Documented operations in api.json | ${ops.length} |`);
  lines.push(`| Documented operations with no test signature | ${uncovered.length} |`);
  lines.push(`| Documented coverage | ${coverage.toFixed(1)}% |`);
  lines.push(`| Ownership registry covers every path | ${registry.current ? 'yes' : `NO — ${registry.missing.length} path(s) unmapped`} |`);
  lines.push(`| Spec directories not registered as projects | ${orphanDirs.length === 0 ? 'none' : orphanDirs.join(', ')} |`);
  lines.push(`| Defects in ledger | ${defects.length} |`);
  lines.push(`| Critical / Major / Medium / Low | ${sevCount('Critical')} / ${sevCount('Major')} / ${sevCount('Medium')} / ${sevCount('Low')} |`);
  lines.push(`| Defects carrying a curl reproduction | ${withCurl} (${pct(withCurl)}%) |`);
  lines.push(`| Defects carrying a Playwright snippet | ${withSnippet} (${pct(withSnippet)}%) |`);
  lines.push(`| Defects carrying an owning team | ${withOwner} (${pct(withOwner)}%) |`);
  lines.push('');

  lines.push('## Artifacts');
  lines.push('');
  lines.push('| Artifact | State |');
  lines.push('| --- | --- |');
  for (const a of artifacts) lines.push(`| ${a.label} | ${a.ok ? a.value : `**${a.value}**`} |`);
  lines.push('');

  if (uncovered.length) {
    lines.push('## Documented operations with no test signature');
    lines.push('');
    lines.push('Matched by normalising path variables away, so an endpoint covered under a templated');
    lines.push('describe still counts.');
    lines.push('');
    for (const o of uncovered.slice(0, 40)) lines.push(`- \`${o}\``);
    if (uncovered.length > 40) lines.push(`- …and ${uncovered.length - 40} more`);
    lines.push('');
  }

  if (registry.missing.length) {
    lines.push('## Paths missing from the ownership registry');
    lines.push('');
    lines.push('Defects on these routes cannot be routed to an owning team. Run `npm run generate`.');
    lines.push('');
    for (const m of registry.missing.slice(0, 40)) lines.push(`- \`${m}\``);
    if (registry.missing.length > 40) lines.push(`- …and ${registry.missing.length - 40} more`);
    lines.push('');
  }

  if (orphanDirs.length) {
    lines.push('## Spec directories that never run');
    lines.push('');
    lines.push('No Playwright project points at these, so their cases are never executed.');
    lines.push('');
    for (const d of orphanDirs) lines.push(`- \`tests/${d}/\``);
    lines.push('');
  }

  if (list?.duplicates.length) {
    lines.push('## Duplicate signatures');
    lines.push('');
    for (const [sig, files] of list.duplicates) lines.push(`- \`${sig}\` — ${files.join(', ')}`);
    lines.push('');
  }

  if (thinCount) {
    lines.push('## Signatures under the 10-case floor');
    lines.push('');
    for (const [sig, n] of list!.thin) lines.push(`- \`${sig}\` — ${n} cases`);
    lines.push('');
  }

  lines.push('## How to disagree with this score');
  lines.push('');
  lines.push('Each category is arithmetic on the evidence table, not a judgement:');
  lines.push('');
  lines.push('- **Architecture** rewards a clean compile, zero duplicate route signatures, and an');
  lines.push('  ownership registry that still covers the contract. It does *not* attempt to score');
  lines.push('  "clean structure" — that is a code-review judgement a generator has no business');
  lines.push('  awarding itself.');
  lines.push('- **Bug detection** scores the 10-case floor and coverage breadth. It cannot measure');
  lines.push('  whether the assertions are *good*, only that they exist and are numerous, so a high');
  lines.push('  score here is necessary but not sufficient. `npm run audit:vectors` is the check');
  lines.push('  that grades *which* vectors those cases cover.');
  lines.push('- **Redundancy & wiring** is fully mechanical.');
  lines.push('- **Reporting** counts the proportion of ledger entries that carry a curl command, a');
  lines.push('  Playwright snippet and an owning team, plus the proportion of expected artifacts that');
  lines.push('  actually exist on disk.');
  lines.push('');
  lines.push('A verdict of PRODUCTION-READY requires 90+. That threshold is about the *test suite*,');
  lines.push('not the API under test — the API itself is failing its own release gate, and the');
  lines.push('defect counts above are the reason.');
  lines.push('');

  return lines.join('\n');
}

const listPath = process.argv[2] ?? p('reports', 'test-list.json');
fs.writeFileSync(p('SUITE_SCORECARD.md'), build(listPath), 'utf-8');
process.stdout.write('[KPOST Scorecard] wrote SUITE_SCORECARD.md\n');
