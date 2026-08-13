import fs from 'fs';
import path from 'path';

/**
 * Run isolation for the KPOST reporting engine.
 *
 * Every execution writes into its own timestamped folder, so a re-run never overwrites the
 * evidence from the run before it:
 *
 *   reports/
 *     runs/run_2026-08-10_17-42-08/
 *       kpost-executive-summary.html
 *       kpost-bug-payloads.json
 *       kpost-run-model.json
 *       diagnostic/            <- Playwright's native HTML report + traces
 *     latest/
 *       kpost-executive-summary.html
 *       kpost-bug-payloads.json
 *       run.json               <- pointer the dispatchers resolve "latest" through
 *     kpost-trend-history.json <- stays in the root and only ever appends
 *
 * `latest/` is a copy rather than a symlink: creating symlinks on Windows needs elevation or
 * developer mode, and a reporting step that fails on half the team's machines is worse than
 * a duplicated 70 KB file.
 */

export const ROOT = path.resolve(__dirname, '..');
export const REPORTS_DIR = path.join(ROOT, 'reports');
export const RUNS_DIR = path.join(REPORTS_DIR, 'runs');
export const LATEST_DIR = path.join(REPORTS_DIR, 'latest');

/** Playwright's own report lands here, configured in playwright.config.ts. */
export const LIVE_DIAGNOSTIC_DIR = path.join(REPORTS_DIR, 'diagnostic');

/** The one artifact that is deliberately global and append-only. */
export const TREND_HISTORY = path.join(REPORTS_DIR, 'kpost-trend-history.json');

export const EXECUTIVE_FILENAME = 'kpost-executive-summary.html';
export const PAYLOADS_FILENAME = 'kpost-bug-payloads.json';
export const MODEL_FILENAME = 'kpost-run-model.json';

export interface RunLocation {
  /** Folder name, e.g. `run_2026-08-10_17-42-08` — also used as the report's run id. */
  runId: string;
  dir: string;
  executiveHtml: string;
  bugPayloads: string;
  runModel: string;
  diagnosticDir: string;
}

/**
 * UTC, not local time. Folder names then sort chronologically for everyone regardless of
 * timezone, never repeat an hour across a DST change, and line up with the UTC timestamps
 * printed in the report itself.
 */
export function runStamp(date: Date): string {
  const iso = date.toISOString();
  return `run_${iso.slice(0, 10)}_${iso.slice(11, 19).replace(/:/g, '-')}`;
}

export function runLocation(date: Date): RunLocation {
  const runId = runStamp(date);
  const dir = path.join(RUNS_DIR, runId);
  return {
    runId,
    dir,
    executiveHtml: path.join(dir, EXECUTIVE_FILENAME),
    bugPayloads: path.join(dir, PAYLOADS_FILENAME),
    runModel: path.join(dir, MODEL_FILENAME),
    diagnosticDir: path.join(dir, 'diagnostic'),
  };
}

/** Path relative to the project root, with forward slashes, for logs and report copy. */
export function relativeToRoot(target: string): string {
  return path.relative(ROOT, target).replace(/\\/g, '/');
}

/* ------------------------------------------------------------------ latest pointer */

export interface LatestPointer {
  runId: string;
  generatedAt: string;
  /** Root-relative so the file stays meaningful when the workspace is moved or archived. */
  runDir: string;
  executiveHtml: string;
  bugPayloads: string;
  runModel: string;
  environment: string;
  totals: { total: number; passed: number; failed: number; skipped: number };
  defectIds: string[];
}

export function writeLatestPointer(pointer: LatestPointer): void {
  fs.mkdirSync(LATEST_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(LATEST_DIR, 'run.json'),
    `${JSON.stringify(pointer, null, 2)}\n`,
    'utf-8'
  );
}

/**
 * Resolves the most recent run for the dispatchers.
 *
 * The pointer file is the fast path; scanning `runs/` is the fallback, because a dispatcher
 * invoked by hand after someone deleted `latest/` should still find the run rather than
 * report "nothing to send".
 */
export function resolveLatestRun(): RunLocation | null {
  try {
    const pointer = JSON.parse(
      fs.readFileSync(path.join(LATEST_DIR, 'run.json'), 'utf-8')
    ) as LatestPointer;
    const dir = path.resolve(ROOT, pointer.runDir);
    if (fs.existsSync(dir)) {
      return {
        runId: pointer.runId,
        dir,
        executiveHtml: path.join(dir, EXECUTIVE_FILENAME),
        bugPayloads: path.join(dir, PAYLOADS_FILENAME),
        runModel: path.join(dir, MODEL_FILENAME),
        diagnosticDir: path.join(dir, 'diagnostic'),
      };
    }
  } catch {
    // No pointer, or it names a run that has since been pruned — fall through to the scan.
  }

  let entries: string[];
  try {
    entries = fs
      .readdirSync(RUNS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('run_'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }
  const newest = entries[entries.length - 1];
  if (!newest) return null;

  const dir = path.join(RUNS_DIR, newest);
  return {
    runId: newest,
    dir,
    executiveHtml: path.join(dir, EXECUTIVE_FILENAME),
    bugPayloads: path.join(dir, PAYLOADS_FILENAME),
    runModel: path.join(dir, MODEL_FILENAME),
    diagnosticDir: path.join(dir, 'diagnostic'),
  };
}

/* ------------------------------------------------------------------ diagnostic capture */

/**
 * Materialises Playwright's diagnostic report inside the run folder.
 *
 * Hard links first, copy as the fallback. A failing run's traces are tens or hundreds of
 * megabytes; hard-linking gives the run folder its own directory entries for the same bytes,
 * so archiving runs costs no extra disk and `reports/diagnostic/` stays valid for
 * `npx playwright show-report`. Links fall back per file, because a hard link is impossible
 * across volumes and on some network filesystems.
 */
export function captureDiagnostic(sourceDir: string, targetDir: string): { files: number; linked: number } {
  let files = 0;
  let linked = 0;

  const walk = (from: string, to: string): void => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dest = path.join(to, entry.name);
      if (entry.isDirectory()) {
        walk(src, dest);
        continue;
      }
      if (!entry.isFile()) continue;
      files += 1;
      try {
        fs.linkSync(src, dest);
        linked += 1;
      } catch {
        try {
          fs.copyFileSync(src, dest);
        } catch {
          // A single unreadable artifact must not cost the run its whole report.
        }
      }
    }
  };

  if (!fs.existsSync(sourceDir)) return { files: 0, linked: 0 };
  walk(sourceDir, targetDir);
  return { files, linked };
}

/* ------------------------------------------------------------------ retention */

/**
 * Caps how many run folders are kept. Traces are large and this directory otherwise grows
 * without bound on a nightly schedule; the trend history in the root keeps the *metrics* for
 * every run forever, so pruning here loses evidence, never the trend line.
 *
 * Set `KPOST_RUN_RETENTION=0` to keep everything.
 */
export function pruneOldRuns(keep: number): string[] {
  if (!Number.isFinite(keep) || keep <= 0) return [];

  let dirs: string[];
  try {
    dirs = fs
      .readdirSync(RUNS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('run_'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }

  const doomed = dirs.slice(0, Math.max(0, dirs.length - keep));
  const removed: string[] = [];
  for (const name of doomed) {
    try {
      fs.rmSync(path.join(RUNS_DIR, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Locked by a viewer or an antivirus scan; it will be pruned on the next run.
    }
  }
  return removed;
}

export function retentionSetting(): number {
  const raw = process.env.KPOST_RUN_RETENTION;
  if (raw === undefined || raw === '') return 20;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 20;
}
