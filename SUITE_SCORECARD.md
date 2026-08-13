# KPOST Admin Module API Test Suite — Quality Scorecard

> Generated 2026-08-13 07:17:00 UTC by `reporters/generate-scorecard.ts`.
> **Every figure below is measured from a run artifact.** Where a rubric criterion
> could not be measured, the scorecard says so and deducts rather than assuming credit.

## Verdict: PRODUCTION-READY — 97/100

| Category | Score | Basis |
| --- | --- | --- |
| 1. Architecture & Maintenance | 25/25 | tsc 10/10 · no duplicate signatures 10/10 · ownership registry current 5/5 |
| 2. Bug Detection & Resilience | 22/25 | 10-case floor 12/15 · documented coverage 10/10 |
| 3. Zero Redundancy & Wiring | 25/25 | no duplicates 15/15 · every spec dir registered 10/10 |
| 4. Reporting & Actionability | 25/25 | curl 8/8 · snippet 5/5 · owner 4/4 · artifacts 8/8 |
| **Total** | **97/100** | |

## Measured evidence

| Metric | Value |
| --- | --- |
| TypeScript compilation | tsc --noEmit exited 0 |
| Test cases enumerated | 1561 |
| Describe blocks | 112 |
| Unique METHOD+PATH signatures | 112 |
| Duplicate signatures | 0 |
| Signatures under the 10-case floor | 3 |
| Documented operations in api.json | 112 |
| Documented operations with no test signature | 0 |
| Documented coverage | 100.0% |
| Ownership registry covers every path | yes |
| Spec directories not registered as projects | none |
| Defects in ledger | 30 |
| Critical / Major / Medium / Low | 18 / 11 / 1 / 0 |
| Defects carrying a curl reproduction | 30 (100%) |
| Defects carrying a Playwright snippet | 30 (100%) |
| Defects carrying an owning team | 30 (100%) |

## Artifacts

| Artifact | State |
| --- | --- |
| BUG_REPORT.md | present |
| BUG_REPORT.json | present |
| DEV_DIGEST.md | present |
| DEV_DIGEST.json | present |
| Playwright HTML (trace viewer) | present |
| JUnit XML for CI | present |
| Executive HTML (tier 2) | present |
| Trend history (tier 3) | present |
| Bug payload stream (tier 4) | present |

## Signatures under the 10-case floor

- `GET /country/countryList` — 9 cases
- `GET /country/getAddressUsingPincodeAndCountry/{pincode}/{country}` — 9 cases
- `GET /` — 7 cases

## How to disagree with this score

Each category is arithmetic on the evidence table, not a judgement:

- **Architecture** rewards a clean compile, zero duplicate route signatures, and an
  ownership registry that still covers the contract. It does *not* attempt to score
  "clean structure" — that is a code-review judgement a generator has no business
  awarding itself.
- **Bug detection** scores the 10-case floor and coverage breadth. It cannot measure
  whether the assertions are *good*, only that they exist and are numerous, so a high
  score here is necessary but not sufficient. `npm run audit:vectors` is the check
  that grades *which* vectors those cases cover.
- **Redundancy & wiring** is fully mechanical.
- **Reporting** counts the proportion of ledger entries that carry a curl command, a
  Playwright snippet and an owning team, plus the proportion of expected artifacts that
  actually exist on disk.

A verdict of PRODUCTION-READY requires 90+. That threshold is about the *test suite*,
not the API under test — the API itself is failing its own release gate, and the
defect counts above are the reason.
