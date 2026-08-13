/**
 * KPOST TestBench — standalone HTML report generator.
 *
 * Pure function of a run model (see `test-results/kpost-testbench.json`): given the model it
 * returns one self-contained HTML document with every style, script and glyph inlined. No
 * network access at render time and none at view time, so the artifact survives being
 * downloaded from a CI job and opened offline.
 *
 * Plain CommonJS rather than TypeScript on purpose: the Playwright reporter requires it during
 * a run, and a human can also run it directly against a saved model without a build step:
 *
 *     node scripts/generateKpostReport.js --in test-results/kpost-testbench.json \
 *                                         --out test-results/kpost-testbench.html
 *
 * Types for the TypeScript callers live in generateKpostReport.d.ts.
 *
 * The page is a *bug report* first: the defect index is what opens, one screen at a time via
 * tabs, and the 4,500-row test register is a tab of its own rather than something a reader has
 * to scroll past. Everything else on the page exists to qualify those defects.
 */

import fs from 'fs';
import path from 'path';
import type { ReportDefect, ReportTest, RunModel } from './run-model';
import { PAYLOADS_FILENAME } from './run-paths';

type Totals = RunModel['totals'];
interface Verdict {
  tone: string;
  headline: string;
  detail: string;
}

/* ------------------------------------------------------------------ escaping */

function esc(value: unknown): string {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * `</script>` inside the embedded JSON would close the host tag early, so the angle brackets
 * are unicode-escaped. U+2028 / U+2029 are legal in JSON strings but not in JavaScript source,
 * and they do turn up in scraped API responses.
 */
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/* ------------------------------------------------------------------ formatting */

export function formatDuration(ms: number): string {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return Math.round(ms) + ' ms';
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return totalSeconds.toFixed(1) + ' s';
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds - minutes * 60);
  if (minutes < 60) return minutes + 'm ' + String(seconds).padStart(2, '0') + 's';
  const hours = Math.floor(minutes / 60);
  return hours + 'h ' + String(minutes - hours * 60).padStart(2, '0') + 'm';
}

function pct(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

function ownerInitials(name: string): string {
  const cleaned = String(name || '')
    .replace(/^Backend Dev\s*[-–]\s*/i, '')
    .replace(/\s*Team$/i, '');
  const words = cleaned.split(/[\s&/-]+/).filter(Boolean);
  if (!words.length) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

function slug(value: string): string {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'other';
}

/* ------------------------------------------------------------------ small parts */

function methodBadge(method: string | null): string {
  if (!method || method === '—') return '<span class="muted-dash">—</span>';
  return '<span class="badge-method m-' + esc(method) + '">' + esc(method) + '</span>';
}

function severityBadge(severity: string): string {
  return '<span class="badge-sev s-' + esc(severity) + '">' + esc(severity) + '</span>';
}

/**
 * "Backend Dev - Identity & Access Team" → "Identity & Access". The role and the word "Team"
 * are identical on every row, so in a table they cost ~110px of width and carry no signal;
 * the full string stays in the tooltip and in the expanded ticket.
 */
function shortOwner(owner: string): string {
  return (
    String(owner || '')
      .replace(/^Backend Dev\s*[-–]\s*/i, '')
      .replace(/\s*Team$/i, '')
      .trim() || String(owner || '')
  );
}

function ownerChip(owner: string, short?: boolean): string {
  return (
    '<span class="owner" title="' + esc(owner) + '"><span class="owner-avatar" aria-hidden="true">' +
    esc(ownerInitials(owner)) +
    '</span><span class="owner-name">' +
    esc(short ? shortOwner(owner) : owner) +
    '</span></span>'
  );
}

/* Response codes appear only in the client-rendered register, which has its own `codePill`. */

/* ------------------------------------------------------------------ charts */

const OUTCOME_SLOTS = [
  { key: 'passed', label: 'Passed', glyph: '✓' },
  { key: 'failed', label: 'Failed', glyph: '✕' },
  { key: 'skipped', label: 'Skipped', glyph: '⊘' },
];

/**
 * Outcome ring, rendered server-side as inline SVG so it survives a saved page, a print, and
 * scripting being off. Segments carry a 2px surface gap and every one is direct-labelled with
 * its count in the legend beside it: the pass/fail hues sit at the colour-vision-deficiency
 * separation floor, so identity is never left to colour alone.
 */
function renderRing(totals: Totals): string {
  const size = 132;
  const stroke = 18;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const counts: Record<string, number> = {
    passed: totals.passed,
    failed: totals.failed,
    skipped: totals.skipped,
  };
  const present = OUTCOME_SLOTS.filter((slot) => counts[slot.key] > 0);

  let offset = 0;
  const arcs = present
    .map((slot) => {
      const raw = (counts[slot.key] / (totals.total || 1)) * circumference;
      const length = present.length > 1 ? Math.max(raw - 2, 1) : raw;
      const arc =
        '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + radius +
        '" fill="none" stroke="var(--st-' + slot.key + ')" stroke-width="' + stroke +
        '" stroke-dasharray="' + length.toFixed(2) + ' ' + (circumference - length).toFixed(2) +
        '" stroke-dashoffset="' + (-offset).toFixed(2) + '"><title>' + esc(slot.label) + ': ' +
        counts[slot.key] + ' (' + pct(counts[slot.key], totals.total) + '%)</title></circle>';
      offset += raw;
      return arc;
    })
    .join('');

  const legend = OUTCOME_SLOTS.map(
    (slot) =>
      '<li><span class="lg-key"><i class="lg-dot" style="background:var(--st-' + slot.key + ')"></i>' +
      '<span class="lg-glyph" aria-hidden="true">' + slot.glyph + '</span>' + esc(slot.label) + '</span>' +
      '<span class="lg-val"><b>' + counts[slot.key] + '</b><span class="lg-pct">' +
      pct(counts[slot.key], totals.total) + '%</span></span></li>'
  ).join('');

  return (
    '<div class="ring-block">' +
    '<div class="ring-wrap"><svg viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="' +
    totals.passed + ' passed, ' + totals.failed + ' failed, ' + totals.skipped + ' skipped">' +
    '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + radius +
    '" fill="none" stroke="var(--hairline)" stroke-width="' + stroke + '" />' +
    '<g transform="rotate(-90 ' + size / 2 + ' ' + size / 2 + ')">' + arcs + '</g></svg>' +
    '<div class="ring-mid"><span class="ring-num">' + pct(totals.passed, totals.total) +
    '<i>%</i></span><span class="ring-cap">passed</span></div></div>' +
    '<ul class="legend">' + legend + '</ul></div>'
  );
}

const SEVERITY_SLOTS: readonly string[] = ['Critical', 'Major', 'Minor'];

function renderSeverityBars(defects: ReportDefect[]): string {
  const counts: Record<string, number> = { Critical: 0, Major: 0, Minor: 0 };
  defects.forEach((defect) => {
    counts[defect.severity] = (counts[defect.severity] || 0) + 1;
  });
  // Bars are shares of the whole ledger, not of the largest band. Normalising to the maximum
  // paints three full bars whenever the counts happen to tie, which reads as "everything is
  // maxed out" rather than "one defect each".
  const total = Math.max(1, defects.length);

  return (
    '<ul class="sevbars">' +
    SEVERITY_SLOTS.map((key) => {
      const value = counts[key] || 0;
      return (
        '<li><span class="sb-name">' + key + '</span>' +
        '<span class="sb-track"><span class="sb-fill s-' + key + '" style="width:' +
        (value === 0 ? 0 : Math.max(3, (value / total) * 100)) + '%"></span></span>' +
        '<span class="sb-count">' + value + '</span></li>'
      );
    }).join('') +
    '</ul>'
  );
}

/* ------------------------------------------------------------------ verdict */

function verdictFor(defects: ReportDefect[], totals: Totals): Verdict {
  const critical = defects.filter((defect) => defect.severity === 'Critical').length;
  const major = defects.filter((defect) => defect.severity === 'Major').length;
  if (critical > 0) {
    return {
      tone: 'critical',
      headline: 'Do not ship',
      detail:
        critical + ' critical ' + (critical === 1 ? 'defect is' : 'defects are') +
        ' open — authentication bypass, injection, or unauthenticated exposure of protected data.',
    };
  }
  if (major > 0) {
    return {
      tone: 'major',
      headline: 'Ship at risk',
      detail:
        'No critical defects, but ' + major + (major === 1 ? ' major issue remains' : ' major issues remain') +
        ': contract mismatches and validation gaps that mislead clients without breaching data.',
    };
  }
  if (defects.length > 0) {
    return { tone: 'minor', headline: 'Acceptable', detail: 'Only cosmetic contract deviations were recorded.' };
  }
  return {
    tone: 'clean',
    headline: 'Clean',
    detail: 'No deviations detected across ' + totals.total + ' executed tests.',
  };
}

/* ------------------------------------------------------------------ hero */

function metaCard(label: string, value: string): string {
  return (
    '<div class="meta-card"><span class="meta-label">' + esc(label) + '</span>' +
    '<span class="meta-value">' + esc(value) + '</span></div>'
  );
}

function renderHero(model: RunModel): string {
  const totals = model.totals;
  return (
    '<header class="hero">' +
    '<div class="wrap">' +
    '<div class="hero-top">' +
    '<div class="brand"><span class="brand-mark" aria-hidden="true">KP</span>' +
    '<span class="brand-text"><b>' + esc(model.app) + '</b><i>Test Bench Automation</i></span></div>' +
    '<div class="hero-actions">' +
    '<span class="hero-chip">' + esc(model.environment.name) + '</span>' +
    '<span class="hero-chip">' + (model.environment.ci ? 'CI run' : 'Local run') + '</span>' +
    // Every run is archived under its own folder; naming it here is what makes a report
    // found on a shared drive traceable back to the execution that produced it.
    '<span class="hero-chip mono">' + esc(model.runId) + '</span>' +
    '<button type="button" class="theme-toggle" id="theme-toggle">Theme</button>' +
    '</div></div>' +
    '<h1>API Bug Report Dashboard</h1>' +
    '<p class="hero-sub">Module-wise defect report — every finding reproduced with the exact request and response, and routed to the controller team that owns it.</p>' +
    '<div class="meta-grid">' +
    metaCard('Environment', model.environment.name) +
    metaCard('Live server', model.environment.server) +
    metaCard('Report date', model.generatedAtLabel.slice(0, 10)) +
    metaCard('Tester / QA', model.environment.tester) +
    metaCard('Framework', model.environment.framework) +
    metaCard('Run duration', formatDuration(totals.durationMs)) +
    '</div></div></header>'
  );
}

/* ------------------------------------------------------------------ KPIs */

function kpi(value: number, label: string, tone: string): string {
  return (
    '<div class="kpi' + (tone ? ' kpi--' + tone : '') + '"><span class="kpi-num">' + esc(value) +
    '</span><span class="kpi-label">' + esc(label) + '</span><span class="kpi-rule"></span></div>'
  );
}

function renderKpis(model: RunModel): string {
  const counts: Record<string, number> = { Critical: 0, Major: 0, Minor: 0 };
  model.defects.forEach((defect) => {
    counts[defect.severity] = (counts[defect.severity] || 0) + 1;
  });
  return (
    '<div class="kpis">' +
    kpi(model.defects.length, 'Total defects', 'total') +
    kpi(counts.Critical, 'Critical', 'critical') +
    kpi(counts.Major, 'Major', 'major') +
    kpi(counts.Minor, 'Minor', 'minor') +
    kpi(model.totals.failed, 'Tests failed', 'failed') +
    kpi(model.totals.passed, 'Tests passed', 'passed') +
    '</div>'
  );
}

/* ------------------------------------------------------------------ health strip */

function renderHealth(model: RunModel): string {
  const verdict = verdictFor(model.defects, model.totals);
  return (
    '<section class="health">' +
    '<div class="hcard"><h2>Outcome distribution</h2>' + renderRing(model.totals) + '</div>' +
    '<div class="hcard"><h2>Defects by severity</h2>' + renderSeverityBars(model.defects) +
    '<p class="hnote">' + model.totals.endpointsExercised + ' distinct endpoints exercised across ' +
    model.suites.length + ' suite' + (model.suites.length === 1 ? '' : 's') + '.</p></div>' +
    '<div class="hcard hcard--verdict v-' + verdict.tone + '">' +
    '<h2>Release verdict</h2><p class="verdict-head">' + esc(verdict.headline) + '</p>' +
    '<p class="verdict-detail">' + esc(verdict.detail) + '</p></div>' +
    '</section>'
  );
}

/* ------------------------------------------------------------------ defect detail */

function snippetBlock(label: string, text?: string): string {
  if (!text) return '';
  return (
    '<div class="fld"><span class="fld-label">' + esc(label) + '</span>' +
    '<pre class="snippet">' + esc(text) + '</pre></div>'
  );
}

function stepsFor(defect: ReportDefect, baseURL: string): string {
  const headers = defect.requestHeaders && Object.keys(defect.requestHeaders).length
    ? Object.keys(defect.requestHeaders)
        .map((key) => '<code>' + esc(key) + ': ' + esc(defect.requestHeaders[key]) + '</code>')
        .join(' ')
    : '<code>(none)</code>';
  return (
    '<ol class="steps">' +
    '<li>Send <code>' + esc(defect.method) + '</code> to <code>' + esc(defect.path) +
    '</code> on <code>' + esc(baseURL) + '</code></li>' +
    '<li>Headers: ' + headers + '</li>' +
    '<li>Body: ' + (defect.requestBody ? 'the request payload below' : '<code>(no request body)</code>') + '</li>' +
    '<li>Observe: ' + esc(defect.actual) + '</li>' +
    '</ol>'
  );
}

function renderDefectDetail(defect: ReportDefect, model: RunModel): string {
  return (
    '<div class="detail">' +
    '<div class="fld-grid">' +
    '<div class="fld"><span class="fld-label">Assignee</span><span class="fld-value">' + ownerChip(defect.owner) + '</span></div>' +
    '<div class="fld"><span class="fld-label">Module / controller</span><span class="fld-value">' + esc(defect.module) + '</span></div>' +
    '<div class="fld"><span class="fld-label">Classification</span><span class="fld-value">' + esc(defect.classification) + '</span></div>' +
    '<div class="fld"><span class="fld-label">Occurrences</span><span class="fld-value">' + defect.occurrences +
    ' test' + (defect.occurrences === 1 ? '' : 's') + '</span></div>' +
    '<div class="fld"><span class="fld-label">Ledger reference</span><span class="fld-value mono">' +
    esc(defect.ledgerId || 'synthesised from a bare assertion') + '</span></div>' +
    '</div>' +
    '<div class="fld"><span class="fld-label">Description</span><p class="fld-value">' + esc(defect.description) + '</p></div>' +
    '<div class="fld-grid two">' +
    '<div class="fld"><span class="fld-label">Expected behaviour</span><p class="fld-value">' + esc(defect.expected) + '</p></div>' +
    '<div class="fld"><span class="fld-label">Actual behaviour</span><p class="fld-value">' + esc(defect.actual) + '</p></div>' +
    '</div>' +
    '<div class="fld"><span class="fld-label">Steps to reproduce</span>' + stepsFor(defect, model.environment.baseURL) + '</div>' +
    snippetBlock('Request payload', defect.requestBody) +
    snippetBlock('Response snippet', defect.responseSnippet) +
    snippetBlock('Playwright reproduction', defect.repro) +
    '</div>'
  );
}

/* ------------------------------------------------------------------ defect index */

function renderDefectPanel(model: RunModel): string {
  if (!model.defects.length) {
    return (
      '<section class="panel" id="panel-defects">' +
      '<p class="empty">No defect was filed during this run.</p></section>'
    );
  }

  const rows = model.defects
    .map((defect) => {
      const drawerId = 'd-' + defect.id;
      return (
        '<tr class="bug-row" id="' + esc(defect.id) + '" data-module="' + esc(slug(defect.module)) +
        '" data-severity="' + esc(defect.severity) + '" data-target="' + drawerId +
        '" tabindex="0" role="button" aria-expanded="false" aria-controls="' + drawerId + '">' +
        '<td class="c-id"><span class="chev" aria-hidden="true">›</span><b>' + esc(defect.id) + '</b></td>' +
        '<td>' + severityBadge(defect.severity) + '</td>' +
        '<td class="c-module">' + esc(defect.module) + '</td>' +
        '<td>' + methodBadge(defect.method) + '</td>' +
        '<td class="c-endpoint"><span class="mono">' + esc(defect.path) + '</span></td>' +
        '<td class="c-title">' + esc(defect.title) + '</td>' +
        '<td class="c-owner">' + ownerChip(defect.owner, true) + '</td>' +
        '<td><span class="status-open">Open</span></td>' +
        '</tr>' +
        '<tr class="bug-detail" id="' + drawerId + '" data-module="' + esc(slug(defect.module)) +
        '" data-severity="' + esc(defect.severity) + '" hidden><td colspan="8">' +
        renderDefectDetail(defect, model) + '</td></tr>'
      );
    })
    .join('');

  return (
    '<section class="panel" id="panel-defects">' +
    '<div class="panel-head"><h2>Defect index</h2>' +
    '<span class="panel-note">Select a row to open the full ticket — steps to reproduce, payloads and the Playwright snippet.</span>' +
    '<span class="panel-count" id="defect-count"></span></div>' +
    '<div class="table-scroll"><table class="bugtable"><thead><tr>' +
    '<th>Bug ID</th><th>Severity</th><th>Module</th><th>Method</th><th>Endpoint</th><th>Title</th><th>Bug owner</th><th>Status</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
    '<p class="empty" id="defect-empty" hidden>No defect in this module.</p>' +
    '</section>'
  );
}

/* ------------------------------------------------------------------ test register */

function renderRegisterPanel(model: RunModel): string {
  const projects = Array.from(new Set(model.tests.map((test: ReportTest) => test.suite))).sort();
  const methods = Array.from(
    new Set(model.tests.map((test: ReportTest) => test.method).filter((m): m is string => Boolean(m)))
  ).sort();
  const option = (value: string, label: string) => '<option value="' + esc(value) + '">' + esc(label) + '</option>';

  const statusButtons: Array<[string, string, number]> = [
    ['all', 'All', model.totals.total],
    ['failed', 'Failed', model.totals.failed],
    ['passed', 'Passed', model.totals.passed],
    ['skipped', 'Skipped', model.totals.skipped],
  ];
  const statusButtonHtml = statusButtons
    .map(
      (entry) =>
        '<button type="button" data-status="' + entry[0] + '" aria-pressed="' + (entry[0] === 'all') +
        '">' + entry[1] + ' <span class="sc">' + entry[2] + '</span></button>'
    )
    .join('');

  return (
    '<section class="panel" id="panel-register" hidden>' +
    '<div class="panel-head"><h2 id="register-heading">Test register</h2>' +
    '<span class="panel-note" id="register-note">Every executed case with its endpoint, response code and latency. Select a row for the execution trace and failure reason.</span></div>' +
    '<div class="controls">' +
    '<label class="search"><svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<circle cx="7" cy="7" r="4.75" stroke="currentColor" stroke-width="1.5"/>' +
    '<path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' +
    '<input id="search-input" type="search" autocomplete="off" aria-label="Search tests" ' +
    'placeholder="Search test, endpoint, bug ID or owner — or status:failed, bug:KP-001, owner:identity" /></label>' +
    '<div class="segmented" role="group" aria-label="Filter by outcome">' + statusButtonHtml + '</div>' +
    '<select id="filter-module" aria-label="Filter by suite">' + option('all', 'All suites') +
    projects.map((name) => option(name, name)).join('') + '</select>' +
    '<select id="filter-method" aria-label="Filter by HTTP method">' + option('all', 'All methods') +
    methods.map((name) => option(name, name)).join('') + '</select>' +
    '<select id="filter-severity" aria-label="Filter by linked defect severity">' + option('all', 'Any severity') +
    SEVERITY_SLOTS.map((name) => option(name, name + ' defects only')).join('') + '</select>' +
    '<div class="segmented" role="group" aria-label="Layout">' +
    '<button type="button" data-view="table" aria-pressed="true">Table</button>' +
    '<button type="button" data-view="cards" aria-pressed="false">Cards</button></div>' +
    '<button type="button" class="linkish" id="reset-filters">Reset</button>' +
    '</div>' +
    '<p class="result-line" id="result-line"></p>' +
    '<div class="table-scroll" id="register-table"><table class="bugtable register"><thead><tr>' +
    '<th>Outcome</th><th>Test case</th><th>Endpoint</th><th>Code</th><th>Latency</th><th>Wall time</th><th>Bug</th>' +
    '</tr></thead><tbody id="register-body"></tbody></table></div>' +
    '<div class="cards" id="register-cards" hidden></div>' +
    '<div id="more-wrap"></div></section>'
  );
}

/* ------------------------------------------------------------------ tabs */

function renderTabs(model: RunModel): string {
  const counts = new Map<string, { module: string; count: number }>();
  model.defects.forEach((defect) => {
    const entry = counts.get(defect.module) ?? { module: defect.module, count: 0 };
    entry.count += 1;
    counts.set(defect.module, entry);
  });
  const modules = [...counts.values()].sort((a, b) => b.count - a.count || a.module.localeCompare(b.module));

  const tabs = [
    '<button type="button" class="tab" role="tab" data-tab="defects" data-module="all" aria-selected="true">' +
      'Overview <span class="tc">' + model.defects.length + '</span></button>',
  ]
    .concat(
      modules.map(
        (entry) =>
          '<button type="button" class="tab" role="tab" data-tab="defects" data-module="' + esc(slug(entry.module)) +
          '" aria-selected="false">' + esc(entry.module) + ' <span class="tc">' + entry.count + '</span></button>'
      )
    )
    .concat([
      // Failures and the register are the same panel under different presets: one filtered to
      // failed tests as cards, one unfiltered as a table. Two views, one code path.
      '<button type="button" class="tab tab--failures" role="tab" data-tab="failures" aria-selected="false">' +
        'Failed tests <span class="tc">' + model.totals.failed + '</span></button>',
      '<button type="button" class="tab" role="tab" data-tab="register" aria-selected="false">' +
        'Test register <span class="tc">' + model.totals.total + '</span></button>',
    ]);

  return '<nav class="tabs" role="tablist" aria-label="Report sections">' + tabs.join('') + '</nav>';
}

/* ------------------------------------------------------------------ footer */

function renderFooter(model: RunModel): string {
  const column = (label: string, lines: string[]) =>
    '<div><span class="foot-label">' + esc(label) + '</span>' +
    lines.map((line) => '<span class="foot-line">' + line + '</span>').join('') + '</div>';

  return (
    '<footer class="footer"><div class="wrap foot-grid">' +
    column('Generated by', [
      'KPOST Test Bench Automation',
      esc(model.environment.framework),
      '<span class="mono">' + esc(model.generatedAtLabel) + '</span>',
    ]) +
    column('Coverage', [
      model.totals.total + ' tests · ' + model.suites.length + ' suites',
      model.totals.endpointsExercised + ' endpoints exercised',
      'Auth: ' + esc(model.environment.authStrategy),
    ]) +
    column('Reproduce', [
      '<span class="mono">npm test</span>',
      '<span class="mono">npm run report:testbench</span>',
      'Target <span class="mono">' + esc(model.environment.baseURL) + '</span>',
    ]) +
    column('This run', [
      '<a href="' + esc(model.environment.traceReport) + '">Playwright trace viewer →</a>',
      'Archived as <span class="mono">' + esc(model.runId) + '</span>',
      'Bug payloads: <span class="mono">' + esc(PAYLOADS_FILENAME) + '</span>',
    ]) +
    '</div></footer>'
  );
}

/* ------------------------------------------------------------------ styles */

const STYLES = `
*, *::before, *::after { box-sizing: border-box; }

:root {
  color-scheme: light;

  --ground: #F4F6F9;
  --surface: #FFFFFF;
  --sunken: #F7F9FB;
  --ink: #14202E;
  --ink-muted: #566577;
  --ink-faint: #7C8A9A;
  --hairline: #E2E7EE;
  --hairline-strong: #CBD4DF;
  --accent: #1B5FA8;
  --accent-soft: #E8F0F9;

  --navy: #112742;
  --navy-deep: #0B1B2F;
  --on-navy: #FFFFFF;
  --on-navy-muted: #9FB6D0;
  --hero-card: #FFFFFF;
  --hero-card-ink: #14202E;
  --hero-line: rgba(255,255,255,.14);

  --st-passed: #0F5C3F;
  --st-failed: #E2503C;
  --st-skipped: #7A8A88;
  --sev-Critical: #A31810;
  --sev-Major: #C98214;
  --sev-Minor: #3F5D8A;
  --sev-Critical-soft: #F9E2DF;
  --sev-Major-soft: #FBF0DC;
  --sev-Minor-soft: #E4EAF3;

  --m-GET: #2F6FB0;
  --m-POST: #0F5C3F;
  --m-PUT: #C98214;
  --m-PATCH: #6F4C9B;
  --m-DELETE: #A31810;
  --m-HEAD: #566577;
  --m-OPTIONS: #566577;

  --font-ui: ui-sans-serif, system-ui, "Segoe UI Variable Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, "Cascadia Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;

  --radius: 8px;
  --page: 1280px;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --ground: #0B1220;
    --surface: #111B2B;
    --sunken: #0D1725;
    --ink: #E6EDF5;
    --ink-muted: #93A4B8;
    --ink-faint: #74869B;
    --hairline: #1F2C3E;
    --hairline-strong: #2E4056;
    --accent: #6BA9E8;
    --accent-soft: #142740;

    --navy: #0A1526;
    --navy-deep: #060E1B;
    --hero-card: #14243A;
    --hero-card-ink: #E6EDF5;
    --hero-line: rgba(255,255,255,.08);

    --st-passed: #6FD9A4;
    --st-failed: #E0574A;
    --st-skipped: #96A6A4;
    --sev-Critical: #FF6B5A;
    --sev-Major: #F0A93C;
    --sev-Minor: #8FB2E0;
    --sev-Critical-soft: #38150F;
    --sev-Major-soft: #38280E;
    --sev-Minor-soft: #172433;

    --m-GET: #74AEE8;
    --m-POST: #6FD9A4;
    --m-PUT: #F0A93C;
    --m-PATCH: #B79BE4;
    --m-DELETE: #FF6B5A;
    --m-HEAD: #93A4B8;
    --m-OPTIONS: #93A4B8;
  }
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --ground: #0B1220;
  --surface: #111B2B;
  --sunken: #0D1725;
  --ink: #E6EDF5;
  --ink-muted: #93A4B8;
  --ink-faint: #74869B;
  --hairline: #1F2C3E;
  --hairline-strong: #2E4056;
  --accent: #6BA9E8;
  --accent-soft: #142740;

  --navy: #0A1526;
  --navy-deep: #060E1B;
  --hero-card: #14243A;
  --hero-card-ink: #E6EDF5;
  --hero-line: rgba(255,255,255,.08);

  --st-passed: #6FD9A4;
  --st-failed: #E0574A;
  --st-skipped: #96A6A4;
  --sev-Critical: #FF6B5A;
  --sev-Major: #F0A93C;
  --sev-Minor: #8FB2E0;
  --sev-Critical-soft: #38150F;
  --sev-Major-soft: #38280E;
  --sev-Minor-soft: #172433;

  --m-GET: #74AEE8;
  --m-POST: #6FD9A4;
  --m-PUT: #F0A93C;
  --m-PATCH: #B79BE4;
  --m-DELETE: #FF6B5A;
  --m-HEAD: #93A4B8;
  --m-OPTIONS: #93A4B8;
}

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: var(--font-ui);
  font-size: 14.5px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}

h1, h2 { margin: 0; font-weight: 700; letter-spacing: -.015em; text-wrap: balance; }
p { margin: 0; }
a { color: var(--accent); }
.mono { font-family: var(--font-mono); font-size: .92em; }
.muted-dash { color: var(--ink-faint); }

:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }

.wrap { max-width: var(--page); margin: 0 auto; padding: 0 24px; }

/* ---------- hero ---------- */

.hero {
  background: var(--navy);
  background-image:
    linear-gradient(var(--hero-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--hero-line) 1px, transparent 1px),
    linear-gradient(160deg, var(--navy) 0%, var(--navy-deep) 100%);
  background-size: 48px 48px, 48px 48px, 100% 100%;
  color: var(--on-navy);
  padding: 22px 0 78px;
}
.hero-top { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 30px; }
.brand { display: flex; align-items: center; gap: 11px; margin-right: auto; }
.brand-mark {
  width: 38px; height: 38px; border-radius: 9px;
  background: rgba(255,255,255,.1);
  border: 1px solid rgba(255,255,255,.2);
  display: grid; place-items: center;
  font-weight: 700; font-size: 13px; letter-spacing: .04em;
}
.brand-text { display: grid; line-height: 1.25; }
.brand-text b { font-size: 17px; letter-spacing: .01em; }
.brand-text i {
  font-style: normal; font-size: 10px; letter-spacing: .16em;
  text-transform: uppercase; color: var(--on-navy-muted);
}
.hero-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.hero-chip {
  border: 1px solid rgba(255,255,255,.24); border-radius: 999px;
  padding: 4px 12px; font-size: 12px; color: var(--on-navy);
}
.theme-toggle {
  border: 1px solid rgba(255,255,255,.24); border-radius: 999px;
  background: transparent; color: var(--on-navy);
  padding: 4px 12px; font: inherit; font-size: 12px; cursor: pointer;
}
.theme-toggle:hover { background: rgba(255,255,255,.1); }

.hero h1 { font-size: clamp(26px, 3.4vw, 36px); line-height: 1.15; margin-bottom: 8px; }
.hero-sub { color: var(--on-navy-muted); max-width: 80ch; font-size: 14.5px; }

.meta-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 10px;
  margin-top: 26px;
}
.meta-card {
  background: var(--hero-card); color: var(--hero-card-ink);
  border-radius: var(--radius); padding: 11px 13px 12px;
  display: grid; gap: 3px; min-width: 0;
}
.meta-label {
  font-size: 9.5px; letter-spacing: .13em; text-transform: uppercase; color: var(--ink-faint);
}
.meta-value { font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }

/* ---------- KPIs ---------- */

main { padding-bottom: 72px; }

.kpis {
  display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px;
  margin-top: -52px; margin-bottom: 26px;
}
.kpi {
  background: var(--surface); border: 1px solid var(--hairline); border-radius: var(--radius);
  padding: 16px 16px 0; text-align: center; display: grid; gap: 2px;
  box-shadow: 0 1px 2px rgba(17,39,66,.05);
}
.kpi-num {
  font-size: 34px; font-weight: 700; line-height: 1.05;
  font-variant-numeric: tabular-nums; letter-spacing: -.02em; color: var(--kpi-color, var(--ink));
}
.kpi-label {
  font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-faint);
  padding-bottom: 12px;
}
.kpi-rule { height: 3px; background: var(--kpi-color, var(--hairline-strong)); border-radius: 3px 3px 0 0; }
.kpi--total { --kpi-color: var(--accent); }
.kpi--critical { --kpi-color: var(--sev-Critical); }
.kpi--major { --kpi-color: var(--sev-Major); }
.kpi--minor { --kpi-color: var(--sev-Minor); }
.kpi--failed { --kpi-color: var(--st-failed); }
.kpi--passed { --kpi-color: var(--st-passed); }

/* ---------- health strip ---------- */

.health { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 26px; }
.hcard {
  background: var(--surface); border: 1px solid var(--hairline);
  border-radius: var(--radius); padding: 16px 18px 18px; min-width: 0;
}
.hcard h2 {
  font-size: 10px; letter-spacing: .13em; text-transform: uppercase;
  color: var(--ink-faint); font-weight: 600; margin-bottom: 14px;
}
.hnote { font-size: 12px; color: var(--ink-faint); margin-top: 14px; }

.ring-block { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
.ring-wrap { position: relative; width: 118px; height: 118px; flex: none; }
.ring-wrap svg { width: 100%; height: 100%; display: block; }
.ring-mid { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; }
.ring-num { font-size: 25px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
.ring-num i { font-style: normal; font-size: 13px; color: var(--ink-muted); }
.ring-cap { font-size: 9.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--ink-faint); }
.legend { list-style: none; margin: 0; padding: 0; display: grid; gap: 7px; flex: 1; min-width: 140px; }
.legend li {
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  font-size: 13px; padding-bottom: 6px; border-bottom: 1px solid var(--hairline);
}
.legend li:last-child { border-bottom: 0; padding-bottom: 0; }
.lg-key { display: inline-flex; align-items: center; gap: 7px; color: var(--ink-muted); }
.lg-dot { width: 9px; height: 9px; border-radius: 2px; }
.lg-glyph { font-size: 10px; color: var(--ink-faint); width: 9px; text-align: center; }
.lg-val { display: inline-flex; align-items: baseline; gap: 6px; font-variant-numeric: tabular-nums; }
.lg-val b { font-size: 14.5px; }
.lg-pct { font-family: var(--font-mono); font-size: 11px; color: var(--ink-faint); }

.sevbars { list-style: none; margin: 0; padding: 0; display: grid; gap: 13px; }
.sevbars li { display: grid; grid-template-columns: 64px 1fr 28px; align-items: center; gap: 10px; }
.sb-name { font-size: 12.5px; color: var(--ink-muted); }
.sb-track { height: 9px; background: var(--sunken); border: 1px solid var(--hairline); border-radius: 5px; overflow: hidden; }
.sb-fill { display: block; height: 100%; border-radius: 5px; }
.sb-fill.s-Critical { background: var(--sev-Critical); }
.sb-fill.s-Major { background: var(--sev-Major); }
.sb-fill.s-Minor { background: var(--sev-Minor); }
.sb-count { font-size: 15px; font-weight: 700; text-align: right; font-variant-numeric: tabular-nums; }

.hcard--verdict { border-left: 4px solid var(--v-color); }
.v-critical { --v-color: var(--sev-Critical); }
.v-major { --v-color: var(--sev-Major); }
.v-minor { --v-color: var(--sev-Minor); }
.v-clean { --v-color: var(--st-passed); }
.verdict-head { font-size: 21px; font-weight: 700; color: var(--v-color); letter-spacing: -.015em; margin-bottom: 6px; }
.verdict-detail { font-size: 13.5px; color: var(--ink-muted); }

/* ---------- tabs ---------- */

.tabs {
  display: flex; gap: 2px; overflow-x: auto; scrollbar-width: thin;
  border-bottom: 1px solid var(--hairline); margin-bottom: 18px;
}
.tab {
  border: 0; background: transparent; color: var(--ink-muted);
  font: inherit; font-size: 13.5px; padding: 10px 15px 11px; cursor: pointer;
  white-space: nowrap; border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.tab:hover { color: var(--ink); }
.tab[aria-selected="true"] { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
.tab .tc { font-family: var(--font-mono); font-size: 11px; color: var(--ink-faint); margin-left: 3px; }
.tab--failures { margin-left: auto; }

/* ---------- panels & tables ---------- */

.panel-head { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 12px; }
.panel-head h2 { font-size: 17px; }
.panel-note { font-size: 12.5px; color: var(--ink-faint); }
.panel-count { margin-left: auto; font-family: var(--font-mono); font-size: 12px; color: var(--ink-faint); }

.table-scroll {
  background: var(--surface); border: 1px solid var(--hairline);
  border-radius: var(--radius); overflow-x: auto;
}
table.bugtable { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 1000px; }
table.bugtable thead th {
  text-align: left; background: var(--navy); color: var(--on-navy);
  font-size: 10px; letter-spacing: .11em; text-transform: uppercase; font-weight: 600;
  padding: 11px 14px; white-space: nowrap;
}
table.bugtable thead th:first-child { border-top-left-radius: 7px; }
table.bugtable thead th:last-child { border-top-right-radius: 7px; }
table.bugtable td { padding: 11px 14px; border-bottom: 1px solid var(--hairline); vertical-align: middle; }
tbody tr:last-child td { border-bottom: 0; }

.bug-row { cursor: pointer; }
.bug-row:hover td { background: var(--sunken); }
.bug-row.open td { background: var(--sunken); }
.c-id { white-space: nowrap; font-family: var(--font-mono); font-size: 12px; }
.c-id b { font-weight: 700; letter-spacing: .03em; }
.chev { display: inline-block; color: var(--ink-faint); transition: transform .18s ease; margin-right: 5px; }
.bug-row.open .chev { transform: rotate(90deg); }
.c-module { color: var(--ink-muted); white-space: nowrap; }
/* Paths stay on one line — broken mid-token they stop being copy-pasteable, and the table
   already scrolls horizontally inside its own container. */
.c-endpoint .mono { font-size: 12px; color: var(--ink-muted); white-space: nowrap; }
.c-title { font-weight: 550; min-width: 260px; }
.c-owner { white-space: nowrap; }

.bug-detail > td { padding: 0; background: var(--sunken); }
.detail { padding: 18px 20px 22px; display: grid; gap: 16px; }

.status-open {
  font-size: 11.5px; font-weight: 600; color: var(--sev-Major);
  border: 1px solid var(--sev-Major); background: var(--sev-Major-soft);
  border-radius: 999px; padding: 2px 9px; white-space: nowrap;
}

/* ---------- badges ---------- */

.badge-method {
  display: inline-block; font-family: var(--font-mono); font-size: 10px; font-weight: 700;
  letter-spacing: .05em; padding: 3px 7px; border-radius: 4px; color: #fff; white-space: nowrap;
}
.m-GET { background: var(--m-GET); }
.m-POST { background: var(--m-POST); }
.m-PUT { background: var(--m-PUT); }
.m-PATCH { background: var(--m-PATCH); }
.m-DELETE { background: var(--m-DELETE); }
.m-HEAD, .m-OPTIONS { background: var(--m-HEAD); }
:root[data-theme="dark"] .badge-method { color: #0A1526; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .badge-method { color: #0A1526; }
}

.badge-sev {
  display: inline-block; font-size: 10.5px; font-weight: 700; letter-spacing: .06em;
  text-transform: uppercase; padding: 3px 9px; border-radius: 999px; border: 1px solid; white-space: nowrap;
}
.s-Critical { color: var(--sev-Critical); border-color: var(--sev-Critical); background: var(--sev-Critical-soft); }
.s-Major { color: var(--sev-Major); border-color: var(--sev-Major); background: var(--sev-Major-soft); }
.s-Minor { color: var(--sev-Minor); border-color: var(--sev-Minor); background: var(--sev-Minor-soft); }

.owner { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--ink-muted); }
.owner-avatar {
  width: 21px; height: 21px; border-radius: 50%; flex: none;
  background: var(--accent-soft); color: var(--accent);
  font-size: 9px; font-weight: 700; display: inline-grid; place-items: center;
}

.code-pill {
  font-family: var(--font-mono); font-size: 12px; font-variant-numeric: tabular-nums;
  padding: 1px 6px; border-radius: 4px; background: var(--sunken); border: 1px solid var(--hairline);
}
.code-pill.c2 { color: var(--st-passed); }
.code-pill.c4 { color: var(--sev-Major); }
.code-pill.c5 { color: var(--sev-Critical); }

.status-pill {
  display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600;
  padding: 2px 9px 2px 7px; border-radius: 999px; color: #fff; white-space: nowrap;
}
.status-pill.p-passed { background: var(--st-passed); }
.status-pill.p-failed { background: var(--st-failed); }
.status-pill.p-skipped { background: var(--st-skipped); }
.status-pill i { font-style: normal; font-size: 10px; }
:root[data-theme="dark"] .status-pill { color: #0A1526; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .status-pill { color: #0A1526; }
}

.bug-tag {
  font-family: var(--font-mono); font-size: 11.5px; font-weight: 700; letter-spacing: .03em;
  padding: 2px 7px; border-radius: 4px; border: 1px solid var(--hairline-strong);
  background: var(--sunken); color: var(--ink); text-decoration: none; white-space: nowrap;
}
a.bug-tag:hover { border-color: var(--accent); color: var(--accent); }

/* ---------- detail fields ---------- */

.fld { display: grid; gap: 5px; min-width: 0; }
.fld-label { font-size: 9.5px; letter-spacing: .13em; text-transform: uppercase; color: var(--ink-faint); }
.fld-value { font-size: 13.5px; color: var(--ink-muted); }
.fld-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px 22px; }
.fld-grid.two { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }

pre.snippet {
  margin: 0; padding: 12px 14px; background: var(--surface);
  border: 1px solid var(--hairline); border-radius: 6px;
  font-family: var(--font-mono); font-size: 12px; line-height: 1.6; color: var(--ink);
  overflow: auto; max-height: 320px; white-space: pre; tab-size: 2;
}
pre.snippet.err { border-left: 3px solid var(--st-failed); }

ol.steps { margin: 0; padding-left: 20px; display: grid; gap: 6px; font-size: 13.5px; color: var(--ink-muted); }
ol.steps code {
  font-family: var(--font-mono); font-size: 12px; color: var(--ink);
  background: var(--surface); border: 1px solid var(--hairline); border-radius: 4px; padding: 1px 5px;
}

table.calls { width: 100%; border-collapse: collapse; font-size: 12.5px; }
table.calls th {
  text-align: left; font-size: 9.5px; letter-spacing: .1em; text-transform: uppercase;
  color: var(--ink-faint); font-weight: 600; padding: 6px 12px 6px 0; border-bottom: 1px solid var(--hairline);
}
table.calls td { padding: 7px 12px 7px 0; border-bottom: 1px solid var(--hairline); }
table.calls tr:last-child td { border-bottom: 0; }

/* ---------- register controls ---------- */

.controls { display: flex; gap: 9px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
.search {
  flex: 1 1 320px; min-width: 240px; display: flex; align-items: center; gap: 8px;
  background: var(--surface); border: 1px solid var(--hairline-strong); border-radius: 6px; padding: 7px 11px;
}
.search:focus-within { border-color: var(--accent); }
.search svg { flex: none; color: var(--ink-faint); }
.search input { border: 0; background: transparent; color: var(--ink); font: inherit; font-size: 13.5px; width: 100%; outline: none; }
.segmented { display: inline-flex; border: 1px solid var(--hairline-strong); border-radius: 6px; overflow: hidden; background: var(--surface); }
.segmented button {
  border: 0; background: transparent; color: var(--ink-muted); font: inherit; font-size: 13px;
  padding: 7px 13px; cursor: pointer; border-right: 1px solid var(--hairline);
}
.segmented button:last-child { border-right: 0; }
.segmented button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.sc { font-family: var(--font-mono); font-size: 11px; opacity: .75; margin-left: 3px; }
select {
  border: 1px solid var(--hairline-strong); background: var(--surface); color: var(--ink);
  border-radius: 6px; padding: 7px 10px; font: inherit; font-size: 13px; max-width: 210px; cursor: pointer;
}
.linkish { border: 0; background: none; color: var(--accent); font: inherit; font-size: 13px; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; padding: 0; }
.result-line { font-size: 12.5px; color: var(--ink-muted); margin-bottom: 10px; }
.result-line b { color: var(--ink); font-variant-numeric: tabular-nums; }
#more-wrap { padding-top: 14px; }

table.register { min-width: 940px; }
.entry { cursor: pointer; }
.entry:hover td, .entry.open td { background: var(--sunken); }
.entry td:first-child { border-left: 3px solid transparent; }
.entry.e-failed td:first-child { border-left-color: var(--st-failed); }
.entry.e-passed td:first-child { border-left-color: var(--st-passed); }
.entry.e-skipped td:first-child { border-left-color: var(--st-skipped); }
.t-title { display: grid; gap: 2px; max-width: 50ch; }
.t-title .tt { font-weight: 550; line-height: 1.4; }
.t-title .ts, .tid { font-size: 11.5px; color: var(--ink-faint); }
.tid { font-family: var(--font-mono); }
.t-endpoint { display: grid; gap: 4px; justify-items: start; }
.num { font-family: var(--font-mono); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
tr.drawer > td { padding: 0; background: var(--sunken); }

.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; }
.card {
  background: var(--surface); border: 1px solid var(--hairline); border-left: 3px solid var(--hairline-strong);
  border-radius: var(--radius); padding: 14px 16px; display: grid; gap: 9px; align-content: start; cursor: pointer;
}
.card.e-failed { border-left-color: var(--st-failed); }
.card.e-passed { border-left-color: var(--st-passed); }
.card.e-skipped { border-left-color: var(--st-skipped); }
.card-top { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.card-title { font-size: 14px; font-weight: 550; line-height: 1.45; }
.card-foot { display: flex; gap: 10px; align-items: center; padding-top: 6px; border-top: 1px solid var(--hairline); }

.empty {
  padding: 36px 20px; text-align: center; color: var(--ink-faint); font-size: 13.5px;
  border: 1px dashed var(--hairline-strong); border-radius: var(--radius); background: var(--surface);
}

.flash { animation: flash 1.4s ease; }
@keyframes flash { 0%, 45% { background: var(--accent-soft); } 100% { background: transparent; } }

/* ---------- footer ---------- */

.footer { border-top: 1px solid var(--hairline); background: var(--surface); padding: 26px 0 34px; }
.foot-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 22px; }
.foot-label { display: block; font-size: 9.5px; letter-spacing: .13em; text-transform: uppercase; color: var(--ink-faint); margin-bottom: 7px; }
.foot-line { display: block; font-size: 12.5px; color: var(--ink-muted); }

[hidden] { display: none !important; }

@media (max-width: 1120px) {
  .meta-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .health { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  .wrap { padding: 0 16px; }
  .meta-grid, .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .tab--register { margin-left: 0; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}

@media print {
  .tabs, .controls, .theme-toggle { display: none !important; }
  .panel, .bug-detail { display: block !important; }
  .hero { background: var(--navy) !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;

/* ------------------------------------------------------------------ client script */

const CLIENT_JS = `
(function () {
  'use strict';

  var DATA = JSON.parse(document.getElementById('kpost-data').textContent);
  var TESTS = DATA.tests || [];
  var DEFECTS = DATA.defects || [];
  var PAGE = 100;

  /* ---------- theme ---------- */

  var root = document.documentElement;
  var toggle = document.getElementById('theme-toggle');
  try {
    var stored = localStorage.getItem('kpost-testbench-theme');
    if (stored === 'dark' || stored === 'light') root.setAttribute('data-theme', stored);
  } catch (e) { /* storage blocked */ }

  function currentTheme() {
    return root.getAttribute('data-theme') ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }
  function paintToggle() {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    toggle.textContent = next === 'dark' ? '\\u25D0 Dark' : '\\u25D1 Light';
    toggle.setAttribute('aria-label', 'Switch to ' + next + ' theme');
  }
  toggle.addEventListener('click', function () {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('kpost-testbench-theme', next); } catch (e) { /* storage blocked */ }
    paintToggle();
  });
  paintToggle();

  /* ---------- helpers ---------- */

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function ms(v) {
    if (v === null || v === undefined) return '\\u2014';
    return v < 1000 ? Math.round(v) + ' ms' : (v / 1000).toFixed(2) + ' s';
  }
  function codePill(code) {
    if (!code) return '<span class="muted-dash">\\u2014</span>';
    var tone = code >= 500 ? 'c5' : code >= 400 ? 'c4' : (code >= 200 && code < 300) ? 'c2' : '';
    return '<span class="code-pill ' + tone + '">' + code + '</span>';
  }
  function methodBadge(m) {
    if (!m) return '<span class="muted-dash">\\u2014</span>';
    return '<span class="badge-method m-' + esc(m) + '">' + esc(m) + '</span>';
  }
  function statusPill(status) {
    var glyph = status === 'passed' ? '\\u2713' : status === 'failed' ? '\\u2715' : '\\u2298';
    return '<span class="status-pill p-' + status + '"><i aria-hidden="true">' + glyph + '</i>' +
      status.charAt(0).toUpperCase() + status.slice(1) + '</span>';
  }
  /** Playwright ids are two concatenated hashes; the tail is the distinguishing half. */
  function shortId(id) { return id.length > 12 ? '#' + id.slice(-8) : id; }

  /** "Backend Dev - Identity & Access Team" -> "Identity & Access" / "IA". */
  function shortOwner(owner) {
    return String(owner || '').replace(/^Backend Dev\\s*[-\\u2013]\\s*/i, '').replace(/\\s*Team$/i, '').trim() || String(owner || '');
  }
  function initials(owner) {
    var words = shortOwner(owner).split(/[\\s&\\/-]+/).filter(Boolean);
    if (!words.length) return '??';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  }

  /* ---------- tabs ---------- */

  var panels = { defects: document.getElementById('panel-defects'), register: document.getElementById('panel-register') };
  var bugRows = Array.prototype.slice.call(document.querySelectorAll('.bug-row'));
  var bugDetails = Array.prototype.slice.call(document.querySelectorAll('.bug-detail'));
  var defectCount = document.getElementById('defect-count');
  var defectEmpty = document.getElementById('defect-empty');

  function applyModule(moduleSlug) {
    var visible = 0;
    bugRows.forEach(function (row) {
      var show = moduleSlug === 'all' || row.dataset.module === moduleSlug;
      row.hidden = !show;
      if (show) visible++;
      if (!show) {
        var detail = document.getElementById(row.dataset.target);
        if (detail) detail.hidden = true;
        row.classList.remove('open');
        row.setAttribute('aria-expanded', 'false');
      }
    });
    bugDetails.forEach(function (detail) {
      if (moduleSlug !== 'all' && detail.dataset.module !== moduleSlug) detail.hidden = true;
    });
    if (defectCount) defectCount.textContent = visible + ' of ' + bugRows.length + ' defects';
    if (defectEmpty) defectEmpty.hidden = visible !== 0;
    var scroll = panels.defects ? panels.defects.querySelector('.table-scroll') : null;
    if (scroll) scroll.hidden = visible === 0;
  }

  function selectTab(button) {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
      tab.setAttribute('aria-selected', String(tab === button));
    });
    var which = button.dataset.tab;
    if (panels.defects) panels.defects.hidden = which !== 'defects';
    if (panels.register) panels.register.hidden = which === 'defects';
    if (which === 'defects') applyModule(button.dataset.module || 'all');
    setRegisterHeading(which);
    if (which === 'failures') presetFailures();
    if (which === 'register') render();
  }

  var REGISTER_HEADINGS = {
    failures: ['Failed tests', 'One card per failure — bug ID, assignee and priority on the face, stack trace in the drawer.'],
    register: ['Test register', 'Every executed case with its endpoint, response code and latency. Select a row for the execution trace and failure reason.']
  };

  /** The panel is shared by two tabs, so its heading has to say which one you are on. */
  function setRegisterHeading(which) {
    var copy = REGISTER_HEADINGS[which];
    if (!copy) return;
    var heading = document.getElementById('register-heading');
    var note = document.getElementById('register-note');
    if (heading) heading.textContent = copy[0];
    if (note) note.textContent = copy[1];
  }

  /** The "Failed tests" tab: the register panel preset to failures, shown as cards. */
  function presetFailures() {
    state.status = 'failed';
    state.view = 'cards';
    state.limit = PAGE;
    Array.prototype.forEach.call(document.querySelectorAll('[data-status]'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.status === 'failed'));
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.view === 'cards'));
    });
    render();
  }

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
    tab.addEventListener('click', function () { selectTab(tab); });
  });
  applyModule('all');

  /* ---------- defect rows ---------- */

  function toggleBug(row) {
    var detail = document.getElementById(row.dataset.target);
    if (!detail) return;
    var expanded = row.getAttribute('aria-expanded') === 'true';
    detail.hidden = expanded;
    row.setAttribute('aria-expanded', String(!expanded));
    row.classList.toggle('open', !expanded);
  }

  bugRows.forEach(function (row) {
    row.addEventListener('click', function (event) {
      if (event.target.closest('a, pre')) return;
      toggleBug(row);
    });
    row.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggleBug(row);
    });
  });

  /** Opens a defect from anywhere: switches to Overview, expands it, scrolls it into view. */
  function openDefect(id) {
    var row = document.getElementById(id);
    if (!row) return;
    var overview = document.querySelector('.tab[data-module="all"]');
    if (overview) selectTab(overview);
    if (row.getAttribute('aria-expanded') !== 'true') toggleBug(row);
    row.classList.remove('flash');
    void row.offsetWidth;
    row.classList.add('flash');
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  document.addEventListener('click', function (event) {
    var link = event.target.closest('a.bug-tag');
    if (!link) return;
    event.preventDefault();
    openDefect(link.getAttribute('href').replace('#', ''));
  });

  /* ---------- register ---------- */

  var state = { q: '', status: 'all', module: 'all', method: 'all', severity: 'all', view: 'table', limit: PAGE };
  var tbody = document.getElementById('register-body');
  var cards = document.getElementById('register-cards');
  var tableWrap = document.getElementById('register-table');
  var resultLine = document.getElementById('result-line');
  var moreWrap = document.getElementById('more-wrap');
  var current = [];

  /**
   * Free text matches every indexed field; "field:value" narrows to one.
   * Supported: status, owner, bug, module, method, endpoint, severity, code.
   */
  function matches(test, query) {
    if (!query) return true;
    var tokens = query.toLowerCase().split(/\\s+/).filter(Boolean);
    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i];
      var colon = token.indexOf(':');
      var field = null;
      var value = token;
      if (colon > 0) {
        var candidate = token.slice(0, colon);
        if (['status','owner','bug','module','method','endpoint','severity','code'].indexOf(candidate) !== -1) {
          field = candidate;
          value = token.slice(colon + 1);
        }
      }
      if (!value) continue;
      var hay;
      if (field === 'status') hay = test.status;
      else if (field === 'owner') hay = test._owners;
      else if (field === 'bug') hay = test._bugs;
      else if (field === 'module') hay = test.suite + ' ' + test.describe;
      else if (field === 'method') hay = test.method || '';
      else if (field === 'endpoint') hay = test.path || '';
      else if (field === 'severity') hay = test._severities;
      else if (field === 'code') hay = String(test.statusCode || '');
      else hay = test._index;
      if (String(hay || '').toLowerCase().indexOf(value) === -1) return false;
    }
    return true;
  }

  function filtered() {
    return TESTS.filter(function (test) {
      if (state.status !== 'all' && test.status !== state.status) return false;
      if (state.module !== 'all' && test.suite !== state.module) return false;
      if (state.method !== 'all' && (test.method || '') !== state.method) return false;
      if (state.severity !== 'all' && String(test._severities || '').indexOf(state.severity) === -1) return false;
      return matches(test, state.q);
    });
  }

  function bugCell(test) {
    var ids = test.defectIds || [];
    if (!ids.length) return '<span class="muted-dash">\\u2014</span>';
    return ids.slice(0, 2).map(function (id) {
      return '<a class="bug-tag" href="#' + esc(id) + '">' + esc(id) + '</a>';
    }).join(' ') + (ids.length > 2 ? ' <span class="tid">+' + (ids.length - 2) + '</span>' : '');
  }

  function callsTable(calls) {
    if (!calls || !calls.length) {
      return '<p class="fld-value">No HTTP traffic was captured — the test either failed before issuing a request, or was skipped.</p>';
    }
    var rows = calls.map(function (call) {
      return '<tr><td>' + methodBadge(call.method) + '</td><td><span class="mono">' + esc(call.path) +
        '</span></td><td>' + codePill(call.status) + '</td><td class="num">' + ms(call.latencyMs) + '</td></tr>';
    }).join('');
    return '<div class="fld"><span class="fld-label">Execution trace \\u2014 ' + calls.length + ' request' +
      (calls.length === 1 ? '' : 's') + '</span><div style="overflow-x:auto"><table class="calls"><thead><tr>' +
      '<th>Method</th><th>Endpoint</th><th>Code</th><th>Latency</th></tr></thead><tbody>' + rows +
      '</tbody></table></div></div>';
  }

  function drawerFor(test) {
    var parts = ['<div class="fld-grid">' +
      '<div class="fld"><span class="fld-label">Test case ID</span><span class="fld-value tid">' + esc(test.id) + '</span></div>' +
      '<div class="fld"><span class="fld-label">Suite</span><span class="fld-value">' + esc(test.suite) + '</span></div>' +
      '<div class="fld"><span class="fld-label">Source</span><span class="fld-value tid">' + esc(test.file) + ':' + esc(test.line) + '</span></div>' +
      '<div class="fld"><span class="fld-label">Wall time</span><span class="fld-value">' + ms(test.durationMs) +
      (test.retries ? ' \\u00b7 ' + test.retries + ' retry' : '') + '</span></div></div>'];

    if (test.describe) {
      parts.push('<div class="fld"><span class="fld-label">Scenario</span><p class="fld-value">' +
        esc(test.describe) + ' \\u2014 ' + esc(test.title) + '</p></div>');
    }
    parts.push(callsTable(test.calls));
    if (test.error && test.error.message) {
      parts.push('<div class="fld"><span class="fld-label">Failure reason</span><pre class="snippet err">' +
        esc(test.error.message) + '</pre></div>');
    }
    if (test.error && test.error.stack) {
      parts.push('<div class="fld"><span class="fld-label">Stack trace</span><pre class="snippet">' +
        esc(test.error.stack) + '</pre></div>');
    }
    if ((test.defectIds || []).length) {
      parts.push('<div class="fld"><span class="fld-label">Tracked defect</span><p class="fld-value">Filed as ' +
        bugCell(test) + ' \\u2014 open it for the full ticket.</p></div>');
    } else if (test.status === 'failed') {
      parts.push('<p class="fld-value">No ledger entry is attached: this failure came from a bare assertion rather than one of the bug-tracking helpers.</p>');
    }
    return '<div class="detail">' + parts.join('') + '</div>';
  }

  function rowHtml(test, index) {
    return '<tr class="entry e-' + test.status + '" data-index="' + index + '" tabindex="0" role="button" aria-expanded="false">' +
        '<td><span class="chev" aria-hidden="true">\\u203A</span>' + statusPill(test.status) + '</td>' +
        '<td><div class="t-title"><span class="tt">' + esc(test.title) + '</span><span class="ts">' +
          esc(test.describe || test.suite) + '</span><span class="tid" title="' + esc(test.id) + '">' +
          esc(shortId(test.id)) + '</span></div></td>' +
        '<td><div class="t-endpoint">' + methodBadge(test.method) + '<span class="mono">' + esc(test.path || '\\u2014') + '</span></div></td>' +
        '<td>' + codePill(test.statusCode) + '</td>' +
        '<td class="num">' + ms(test.latencyMs) + '</td>' +
        '<td class="num">' + ms(test.durationMs) + '</td>' +
        '<td>' + bugCell(test) + '</td></tr>' +
      '<tr class="drawer" data-drawer="' + index + '" hidden><td colspan="7"></td></tr>';
  }

  /**
   * Failure card. Everything a lead needs before opening the drawer: outcome, endpoint and
   * method, response code, the assigned bug id, its priority, and who owns it.
   */
  function cardHtml(test, index) {
    var priority = test.defectSeverity
      ? '<span class="badge-sev s-' + esc(test.defectSeverity) + '">' + esc(test.defectSeverity) + '</span>'
      : '';
    var owner = test.defectOwner
      ? '<span class="owner" title="' + esc(test.defectOwner) + '"><span class="owner-avatar" aria-hidden="true">' +
        esc(initials(test.defectOwner)) + '</span>' + esc(shortOwner(test.defectOwner)) + '</span>'
      : '';
    return '<article class="card e-' + test.status + '" data-index="' + index + '" tabindex="0" role="button" aria-expanded="false">' +
        '<div class="card-top">' + statusPill(test.status) + methodBadge(test.method) + codePill(test.statusCode) +
          priority + '<span class="num" style="margin-left:auto">' + ms(test.latencyMs) + '</span></div>' +
        '<div class="card-title">' + esc(test.title) + '</div>' +
        '<div><span class="mono" style="font-size:12px;color:var(--ink-muted)">' + esc(test.path || test.suite) + '</span></div>' +
        (owner ? '<div>' + owner + '</div>' : '') +
        '<div class="card-foot"><span class="tid" title="' + esc(test.id) + '">' + esc(shortId(test.id)) + '</span>' +
          '<span style="margin-left:auto">' + bugCell(test) + '</span></div>' +
        '<div class="card-drawer" data-drawer="' + index + '" hidden></div></article>';
  }

  function render() {
    if (!tbody) return;
    current = filtered();
    var shown = current.slice(0, state.limit);

    if (state.view === 'table') {
      tableWrap.hidden = false;
      cards.hidden = true;
      tbody.innerHTML = shown.length ? shown.map(rowHtml).join('')
        : '<tr><td colspan="7" style="text-align:center;color:var(--ink-faint);padding:32px">No test matches these filters.</td></tr>';
    } else {
      tableWrap.hidden = true;
      cards.hidden = false;
      cards.innerHTML = shown.length ? shown.map(cardHtml).join('') : '<p class="empty">No test matches these filters.</p>';
    }

    resultLine.innerHTML = 'Showing <b>' + shown.length + '</b> of <b>' + current.length +
      '</b> matching tests (<b>' + TESTS.length + '</b> executed).';

    moreWrap.innerHTML = current.length > shown.length
      ? '<button class="linkish" id="show-more">Show ' + Math.min(PAGE, current.length - shown.length) +
        ' more (' + (current.length - shown.length) + ' hidden)</button>'
      : '';
    var more = document.getElementById('show-more');
    if (more) more.addEventListener('click', function () { state.limit += PAGE; render(); });
  }

  function toggleEntry(index, element) {
    var test = current[index];
    if (!test) return;
    var expanded = element.getAttribute('aria-expanded') === 'true';
    var host = state.view === 'table'
      ? document.querySelector('tr.drawer[data-drawer="' + index + '"]')
      : element.querySelector('.card-drawer');
    if (!host) return;
    var target = state.view === 'table' ? host.firstElementChild : host;
    if (!expanded && !target.dataset.filled) {
      target.innerHTML = drawerFor(test);
      target.dataset.filled = '1';
    }
    host.hidden = expanded;
    element.setAttribute('aria-expanded', String(!expanded));
    element.classList.toggle('open', !expanded);
  }

  function bindOpen(container, selector) {
    if (!container) return;
    container.addEventListener('click', function (event) {
      if (event.target.closest('a, button, pre')) return;
      var el = event.target.closest(selector);
      if (el) toggleEntry(Number(el.dataset.index), el);
    });
    container.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      var el = event.target.closest(selector);
      if (!el) return;
      event.preventDefault();
      toggleEntry(Number(el.dataset.index), el);
    });
  }
  bindOpen(tbody, 'tr.entry');
  bindOpen(cards, 'article.card');

  var searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', function (event) {
      state.q = event.target.value.trim();
      state.limit = PAGE;
      render();
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-status]'), function (button) {
    button.addEventListener('click', function () {
      state.status = button.dataset.status;
      state.limit = PAGE;
      Array.prototype.forEach.call(document.querySelectorAll('[data-status]'), function (b) {
        b.setAttribute('aria-pressed', String(b === button));
      });
      render();
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (button) {
    button.addEventListener('click', function () {
      state.view = button.dataset.view;
      Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (b) {
        b.setAttribute('aria-pressed', String(b === button));
      });
      render();
    });
  });

  ['module', 'method', 'severity'].forEach(function (key) {
    var select = document.getElementById('filter-' + key);
    if (!select) return;
    select.addEventListener('change', function () {
      state[key] = select.value;
      state.limit = PAGE;
      render();
    });
  });

  var reset = document.getElementById('reset-filters');
  if (reset) {
    reset.addEventListener('click', function () {
      state.q = ''; state.status = 'all'; state.module = 'all';
      state.method = 'all'; state.severity = 'all'; state.limit = PAGE;
      if (searchInput) searchInput.value = '';
      ['module', 'method', 'severity'].forEach(function (key) {
        var select = document.getElementById('filter-' + key);
        if (select) select.value = 'all';
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-status]'), function (b) {
        b.setAttribute('aria-pressed', String(b.dataset.status === 'all'));
      });
      render();
    });
  }

  if (window.location.hash) openDefect(decodeURIComponent(window.location.hash.replace('#', '')));
  window.addEventListener('hashchange', function () {
    openDefect(decodeURIComponent(window.location.hash.replace('#', '')));
  });
})();
`;

/* ------------------------------------------------------------------ document */

/**
 * The client script is a string, so `tsc` cannot see inside it — a typo there ships a page
 * whose tabs and filters silently do nothing. `new Function` parses the body without running
 * it, which catches that at generation time for the cost of a few microseconds.
 */
function assertClientScriptParses(): void {
  try {
    new Function(CLIENT_JS);
  } catch (error) {
    throw new Error(
      `Executive report client script has a syntax error and would ship dead: ${String(error)}`
    );
  }
}

export function renderExecutiveHtml(model: RunModel): string {
  assertClientScriptParses();
  return (
    '<!doctype html>\n<html lang="en">\n<head>\n' +
    '<meta charset="utf-8" />\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
    '<title>' + esc(model.app) + ' — API Bug Report Dashboard (' + esc(model.environment.name) + ')</title>\n' +
    '<meta name="description" content="KPOST API verification run: ' + model.totals.total + ' tests, ' +
    model.totals.failed + ' failed, ' + model.defects.length + ' defects filed." />\n' +
    '<style>' + STYLES + '</style>\n</head>\n<body>\n' +
    renderHero(model) +
    '<main class="wrap">' +
    renderKpis(model) +
    renderHealth(model) +
    renderTabs(model) +
    renderDefectPanel(model) +
    renderRegisterPanel(model) +
    '</main>\n' +
    renderFooter(model) +
    '<script id="kpost-data" type="application/json">' + embedJson(model) + '</script>\n' +
    '<script>' + CLIENT_JS + '</script>\n</body>\n</html>\n'
  );
}

/** Renders the model and writes it to `outPath`, creating parent directories as needed. */
export function writeExecutiveReport(model: RunModel, outPath: string): string {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, renderExecutiveHtml(model), 'utf-8');
  return outPath;
}
