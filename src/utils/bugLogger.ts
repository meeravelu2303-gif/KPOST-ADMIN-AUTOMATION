/**
 * bugLogger — the single entry point for defect logging across the suite.
 *
 * This is a thin, intentional FACADE over the framework's existing, battle-tested defect
 * pipeline; it does not introduce a second ledger. Every finding still flows:
 *
 *     assertion helper / logBug()  ->  bugTracker.recordBug()  ->  .bug-cache/<hash>.json
 *                                   -> bugReporter.onEnd()     ->  BUG_REPORT.md + BUG_REPORT.json
 *
 * `BUG_REPORT.md` already carries exactly the schema the brief asks for, produced by
 * `bugTracker.compileBugReport`:
 *   - a stable content-hash Bug ID (BUG-API-XXXXXX) plus a severity-sorted display ID (KP-001…)
 *   - Severity (Critical|Major|Medium|Low) and a mechanically-derived Priority (P0..P3)
 *   - Module name + owning team (from MODULE_BY_PATH, per Swagger tag)
 *   - Target endpoint (METHOD /path), Expected vs Actual status + body
 *   - a runnable curl command and a Playwright snippet
 *   - a system-impact line
 *
 * Prefer the assertion helpers (assertStatus, assertUnauthorized, …) — they capture the real
 * request/response automatically. Use `logBug` directly only for a bespoke finding a helper
 * cannot express. Everything a spec needs for the 10 test categories is re-exported here so a
 * spec has one import surface.
 */

export {
  recordBug as logBug,
  recordEndpointExercised,
  recordAuthStrategy,
} from './bugTracker';
export type { Severity, Priority, FlawClassification, BugInput } from './bugTracker';

export {
  assertStatus,
  assertStatusCodeParity,
  assertRejectsInvalidInput,
  assertUnauthorized,
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertNot200OKOnError,
  expectValidContract,
  reportBusinessLogicFlaw,
  readBody,
} from './apiAssertions';
export type { EndpointMeta } from './apiAssertions';

export { validateSchema } from './schemaValidator';
export { SQLI, XSS, BOUNDARY_STRINGS, TYPE_MISMATCH_VALUES, MALFORMED_JSON_STRINGS } from './fuzzData';
