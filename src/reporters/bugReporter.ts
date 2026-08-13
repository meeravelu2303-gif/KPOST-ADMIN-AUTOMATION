import type { FullConfig, FullResult, Reporter, Suite } from '@playwright/test/reporter';
import { env } from '../config/env.config';
import { compileBugReport, readAuthStrategy } from '../utils/bugTracker';
import { generateDigest } from '../utils/devNotifier';

/**
 * Compiles BUG_REPORT.md and BUG_REPORT.json once the run finishes, then derives the
 * Developer Digest from them.
 *
 * This lives in a reporter rather than `globalTeardown` because the executive dashboard
 * needs the run's pass/fail/skip counts and duration, which teardown has no access to.
 *
 * The digest is generated here, last, because it reads `BUG_REPORT.json` — which this same
 * reporter has only just written. Running it earlier (in the master reporter, say) would
 * summarise the *previous* run.
 */
export default class BugReporter implements Reporter {
  private startedAt = Date.now();
  private suite?: Suite;

  onBegin(_config: FullConfig, suite: Suite): void {
    this.startedAt = Date.now();
    this.suite = suite;
  }

  async onEnd(_result: FullResult): Promise<void> {
    const tests = this.suite?.allTests() ?? [];

    // Counting final outcomes rather than accumulating in onTestEnd keeps retried tests
    // from being counted twice (once for the failed attempt, once for the retry).
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    for (const test of tests) {
      switch (test.outcome()) {
        case 'expected':
        case 'flaky':
          passed += 1;
          break;
        case 'skipped':
          skipped += 1;
          break;
        default:
          failed += 1;
      }
    }

    compileBugReport({
      generatedAt: `${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
      baseURL: env.baseURL,
      totalTests: tests.length,
      passed,
      failed,
      skipped,
      durationSeconds: Math.round((Date.now() - this.startedAt) / 100) / 10,
      authStrategy: readAuthStrategy(),
    });

    // Fail-safe by construction: returns a result, never throws, so a digest problem cannot
    // mask the run's own outcome.
    const digest = generateDigest();
    if (digest.written) {
      console.log(`[KPOST Digest] ${digest.digest?.verdict}`);
      console.log(`[KPOST Digest] wrote DEV_DIGEST.md and DEV_DIGEST.json`);
    } else {
      console.log(`[KPOST Digest] skipped - ${digest.reason}`);
    }
  }
}
