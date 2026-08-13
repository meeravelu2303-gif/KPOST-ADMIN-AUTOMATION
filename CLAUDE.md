# CLAUDE.md

Guidance for Claude Code (and any engineer) working in **kpost-admin-testbench**.

## What this project is

A Playwright + TypeScript **API test automation framework** for the **KPOST Admin Module**
API — the tenant (company) administration backend that manages organisation set-up,
workplace/HR hierarchies, employee master data, role postings, product subscriptions and
user onboarding. It contains **no UI/browser code** — every test drives `APIRequestContext`
directly. The purpose is not regression-guarding a healthy API; it is **adversarial
bug-hunting** against a live backend, with every confirmed defect written to
`BUG_REPORT.md` in a fixed, ticket-ready schema.

It shares its architecture, assertion conventions and 4-tier reporting engine with the main
KPOST framework (`kpost-automation-v1`). Where this module differs from that platform, the
difference is called out below — the auth model and the response envelope are the two that
matter most.

The API contract lives in **`api.json`** (OpenAPI 3.0.1, **112 endpoints across 24 tags**).
Treat it as the source of truth for paths and payload shapes — but **not** for actual
behaviour, which frequently diverges (see "Known API behaviours"). Data is stored in
**MongoDB** (`admin_enterprise`); every `id` is a 24-character hex `ObjectId`.

## Commands

```bash
npm test                    # full suite (runs the vector gate first via pretest)
npm run typecheck           # tsc --noEmit — must be clean before any commit
npm run test:departments    # single project: users | departments | designations | ...
npm run audit:vectors       # the coverage gate on its own; --json writes .audit-build/gaps.json
npm run scorecard           # measured SUITE_SCORECARD.md (compiles, lists, then grades)
npm run test:list           # enumerate every test as JSON without running anything
npm run generate            # regenerate the ownership registry from api.json
npm run report              # open the tier 1 diagnostic report (traces)
npm run report:executive    # print the absolute path of the newest executive HTML
npm run notify              # print DEV_DIGEST.md to stdout
npm run seed                # opt-in: establish a session and write QA_AUTH_TOKEN into .env
npm run clean               # remove run caches; deliberately does NOT touch reports/
npm run test:no-onboarding  # skip the account-creating / message-sending specs
```

Run a single spec or a single test:

```bash
npx playwright test tests/departments/departments.spec.ts -g "stored XSS"
```

> Passing `--reporter=line` **overrides all configured reporters**, so none of the four report
> tiers are produced and `BUG_REPORT.md` is left at the "run in progress" stub globalSetup
> wrote. Use the bare `npm test` when you need the artifacts. `test:list` pins
> `--reporter=json` for the same reason — so listing can never clobber the ledger.

> **`npm run` exiting 1 with no output** is an environment fault, not a broken script: npm
> resolves its script shell from `ComSpec`, which Git Bash does not set, and fails before your
> script runs. Use PowerShell/CMD, or prefix `ComSpec="C:\Windows\System32\cmd.exe"`.

## Architecture

```
scripts/
  generateModuleOwnership.js   api.json -> src/api/registry/moduleOwnership.generated.ts
  audit-vectors.ts             the coverage gate (pretest); classifies each test() by code
  run-seed.js                  `npm run seed` wrapper; sets KPOST_RUN_SEED portably
  seed/seed.setup.ts           the seed task itself (its own opt-in Playwright project)
  clean.js                     removes run caches, never reports/
  print-digest.js              cats DEV_DIGEST.md
  print-executive-path.js      prints the newest executive HTML path
reporters/     the tier 2-4 engine + dashboard-ingest (see "The reporting engine")
src/
  config/      env.config.ts (typed env), global-setup.ts (resets bug ledger)
  fixtures/    api.fixture.ts (Playwright fixtures), authSession.ts (session acquisition),
               seedUser.ts (mints + persists QA_AUTH_TOKEN)
  reporters/   bugReporter.ts (compiles BUG_REPORT.md + .json, then the digest)
  utils/       bugTracker.ts (bug ledger + report/JSON writer),
               devNotifier.ts (Developer Digest generator),
               apiAssertions.ts (the bug-hunting assertions),
               environment.ts (environmentName/hostOf — the ONE env-label source),
               schemaValidator.ts (Zod wrapper), fuzzData.ts (attack corpus),
               safeTestData.ts (safe SMS/e-mail destinations)
  api/
    clients/   one thin client per hand-written tag + base.client.ts (transport)
    payloads/  faker-backed request builders (Record<string, unknown> overrides)
    registry/  moduleOwnership.generated.ts (GENERATED — do not edit)
    schemas/   Zod response contracts (envelope.schema.ts is the Admin envelope)
tests/
  users/ departments/ designations/ rolePostings/ employeeMaster/       hand-written,
  workplaceLocations/ holidayCalendar/ productLicensing/                 one Playwright
  workplaceHierarchy/ hrHierarchy/ referenceData/                        project per suite
```

**All 24 Swagger tags have coverage** across eleven projects. Four of them bundle related
tags that share an owning subsystem: `productLicensing` (the five Product/Project tags),
`workplaceHierarchy` (generic + workplace-tier attributes/variables + hierarchy links),
`hrHierarchy` (HR tier + set-up tier levels/nodes), and `referenceData` (country/address,
admin details, employee↔role-posting mapping). Bundling only groups test execution — bug
ownership is still resolved per path by `MODULE_BY_PATH`, so each tag routes to its own team.
The two hierarchy suites reuse one LEVEL/NODE archetype schema and payload set
(`hierarchy.schema.ts` / `hierarchy.payload.ts`) — shared contract code, not a test factory:
every `test()` is still hand-written. Run a single suite with its `npm run test:<name>`
script. New endpoints on an existing tag are added as more `test()` cases in its spec.

Each `tests/<dir>` is a separate Playwright **project**, so `--project=<name>` scopes a run.
Add a tag by authoring its 4-file set (`schemas/<tag>.schema.ts`, `payloads/<tag>.payload.ts`,
`clients/<tag>.client.ts`, `tests/<tag>/<feature>.spec.ts`) and registering the project in
`playwright.config.ts`.

### One layer of test authoring: every spec is hand-written

There is **no generated test matrix** and no test factory. Every suite lives under
`tests/<tag>/`, one project per tag, and each endpoint gets its own `test.describe` with
explicit, individually-named `test()` cases — **no loops**, so every case is reportable and
skippable on its own. `scripts/generateModuleOwnership.js` is the only generator: it derives
`MODULE_BY_PATH` (path → tag → owning team) so bug tickets route correctly.

### Spec house style — not cosmetic, it is parsed

Every spec follows the same shape, and two parts of it are load-bearing rather than stylistic:

```ts
/* ==== POST /department/save ==== */
test.describe('POST /department/save', () => {          // ← BARE `METHOD /path`, nothing else
  const META = {
    method: 'POST',
    path: DEPARTMENT_PATHS.save,                        // ← from the client's PATHS const
    repro: `await departmentsClient.save(buildDepartmentArray(2), { token });`,
  };

  test('[5] [IDOR] a department must not be creatable inside another tenant', async ({ … }) => {
    …
    await assertRejectsInvalidInput(response, { ...META, body, scenario: '…' });
  });
});
```

- **The describe title must be the bare `METHOD /path` signature.** `scripts/audit-vectors.ts`
  groups coverage by exactly that string, and `generate-scorecard.ts` counts unique signatures
  from it. A prose suffix (`— list departments for a company`) breaks neither parser outright
  but changes what they group by, so keep the title bare and put the prose in the doc comment.
- **`[IDOR]` in a test title is the only way an IDOR case is detected.** Every other vector has
  an unambiguous structural signal (calling `assertUnauthorized` *is* an auth case); IDOR is an
  ordinary assertion pointed at a foreign identity, so it is tag-only by design. An untagged
  ownership test reads as a gap — the right failure direction, because it is visible.
- Tests are numbered `[1]` happy path, `[1b]` contract, `[2]` boundary, `[3]` typefuzz,
  `[4]` auth, `[5] [IDOR]`, `[6]` injection, with letter sub-variants.
- `META` is declared once per describe and spread into every assertion as `{ ...META, body }`,
  with a per-test `repro`/`scenario` override where the reproduction differs.
- Each client exports a `*_PATHS` const; specs build `META.path` from it so a route and the
  ticket reporting a defect on it cannot drift apart.

### The vector coverage gate

`npm test` runs `scripts/audit-vectors.ts` first through `pretest`. It classifies **each
`test()` body by the code inside it** — which assertion helper it calls, what shape of payload
it builds — never by how the title is worded, because an earlier title-matching version in the
main framework scored 19% while measuring nothing but vocabulary.

Seven vectors are mandatory per endpoint: `contract`, `nullBoundary`, `typeFuzz`, `auth`,
`idor`, `injection`, `statusParity`. Coverage below `KPOST_VECTOR_THRESHOLD` (default **98**)
fails the run. Endpoints where a vector is genuinely meaningless are listed in the script's
`EXEMPTIONS` ledger **with a reason** — an IDOR case for `GET /country/countryList` would be
asserting that one caller cannot read another caller's copy of a global country list, which is
not a concept. Exempted slots leave both the numerator and the denominator, so an exemption can
never flatter the percentage. Two rules for adding one: name the specific vector, and say why
it is meaningless rather than merely inconvenient.

`delete` endpoints (`department/delete`, `userDetails/delete/{id}`, and the many
`*/delete` hierarchy routes) are **destructive hard deletes** with no soft-delete flag and no
cascade. Exercise them on refusal / auth paths only; never delete a shared record.

## Authentication — the big divergence from main KPOST

**The Admin Module's `userDetails/login` returns identity fields only and NO token.** The
`SignUpResponse` DTO carries `id, country, name, mobileNumber, emailID, userID` — no JWT. So
the reference framework's "log in, extract accessToken" strategy **cannot work here.**

Instead, the backend's `AuthenticationFilter` validates an **HS256 JWT** signed with a dev
secret, reading the `sub` (→ `kpostID`) and `companyID` claims and injecting them as request
attributes that tenant-scoped endpoints read. `authSession.ts` therefore acquires a session
by, in order:

1. `QA_AUTH_TOKEN` from `.env` (a real, already-issued token), or
2. **minting an HS256 JWT** locally from `ADMIN_JWT_SECRET` + `QA_KPOST_ID` / `QA_COMPANY_ID`.

A token is accepted only if the filter does **not** answer 401 to it (a wrong-secret,
malformed or expired token is refused with "Invalid token" / "Token expired"; a valid one
passes through). Every failed step is recorded; `requireAuthToken()` throws
`AuthenticationUnavailableError` carrying the full attempt log rather than skipping, so
unverified coverage is visible. `authSession` is **worker-scoped** — even the minted-token
probe is a round trip.

> **Set `ADMIN_JWT_SECRET` to the server's real signing key** for your environment. The
> `.env.example` default matches the checked-in dev value; a production or shared QA backend
> will differ, and a mismatch drops the run to unauthenticated (with a diagnostic).

**The secret is base64-decoded before signing — this is not optional and cost a live debug to
find.** The backend's `AuthenticationUtility` verifies with `Jwts.parser().setSigningKey(secretKey)`
passing a **String**, and jjwt interprets a String signing key as base64-encoded, decoding it to
the raw HMAC key bytes. Signing with the ASCII bytes of the same string yields a different key
and the filter answers `401 "Invalid token"`. Verified against the live backend: ASCII → 401,
base64-decoded → 200. `mintToken()` in `authSession.ts` does the decode; enter
`ADMIN_JWT_SECRET` exactly as the backend declares it and do not pre-encode it.

This failure mode is the dangerous one on this module: a rejected mint does not stop the run, it
drops it to unauthenticated, and an unauthenticated run finds **fewer** defects — which reads
like the API improved. Always check `DEV_DIGEST.md`'s `Authentication` row before believing a
quiet report.

**OTP and destructive endpoints are constrained on purpose.** `userDetails/sendOTP` reaches a
real handset, costs money, and is unauthenticated + unthrottled with no lockout. Its payload
builder is pinned to `TEST_MOBILE` / `TEST_EMAIL` via `safeTestData.ts`, **never faker** — a
random 10-digit number is a real subscriber. Do not "fix" that by reintroducing faker.

## Known API behaviours (verified against the spec and the backend source)

Do not "fix" tests that fail on these — they are **real defects the suite is meant to catch**:

- **Authentication is not actually enforced.** `SecurityConfiguration` permits `"/**"`, so
  every "protected" route answers anonymous callers. `assertUnauthorized` grades this
  **Major** (spec/implementation mismatch) unless protected user data actually comes back
  (`getAllUser` leaks `mobileNumber`/`emailID`), which is **Critical**.
- **The envelope is `{ value, status, statusCode, urlPath, error?, message? }`** — the payload
  is in `value`, not `data`. `status` is UPPERCASE `SUCCESS`/`FAILURE`. `envelope.schema.ts`
  models this; the casing is asserted once by the dedicated contract test.
- **HTTP 200 or 500 only — never 404.** A missing document is either 200 with `value: null`/`[]`
  or 500 with `status: FAILURE`. Wrong-status findings key on the envelope, not the transport.
- **Invalid login is reported as HTTP/envelope 500**, not 401 — a credential rejection dressed
  as a server error.
- **Passwords are stored clear-text** (`NoOpPasswordEncoder`), and `userDetails/registration`
  echoes the password back in its response. Never log payloads containing a password.
- **`department/update` has no failure branch** — it returns `status: SUCCESS` even when no
  document matched the `id`. Inspect `value`; do not trust `status`.
- **`abbreviationAndCodeCreation` and `checkAvailability` do not reserve** the value they
  hand out — two concurrent callers get the same one, and the collision only surfaces at save.
- **OTP has no attempt counter or lockout** and is valid for 10 minutes — brute-forceable.
- **`dialCode` is an integer** on the OTP schemas; a quoted string yields 400.

## Non-negotiable conventions

**Never assert with bare `expect(response.status())`.** Use the helpers in
`src/utils/apiAssertions.ts` so failures land in `BUG_REPORT.md` with full metadata:

| Helper | Use for |
| --- | --- |
| `assertStatus` | expected status set; logs a finding on mismatch |
| `assertRejectsInvalidInput` | invalid input must be 400/422 — flags silent acceptance |
| `assertUnauthorized` | protected route must be 401/403 — flags 400/500/200 |
| `assertStatusCodeParity` | HTTP status must equal the envelope's `statusCode` |
| `assertNoInternalLeak` | injected input must not return stack traces / SQL errors |
| `assertNoReflectedScript` | script payloads must not come back unescaped |
| `assertNot200OKOnError` | a success transport status must not carry a failure payload |
| `reportBusinessLogicFlaw` | a rule a generic assertion can't express (IDOR, misreport) |

Pass `body` and (where non-default) `headers` in the assertion `meta` — they populate the
**Steps to Reproduce** block. Every assertion needs an `expect` message explaining the
user-visible consequence, not just the mismatch.

Payload builders take `Record<string, unknown>` overrides, **not** `Partial<T>` — fuzz tests
deliberately submit wrong-typed values and a strict override type would forbid that.

## The reporting engine

Identical to the main framework. Four tiers, one wiring point; every artifact under
`reports/` (git-ignored, created on demand). Two ledgers sit alongside:

| Artifact | Written by | Purpose |
| --- | --- | --- |
| `BUG_REPORT.md` / `.json` | `src/reporters/bugReporter.ts` | human ledger + machine twin, one ticket per defect |
| `DEV_DIGEST.md` / `.json` | `src/utils/devNotifier.ts` | triage summary by severity / module / owner + chat payloads |
| `SUITE_SCORECARD.md` | `reporters/generate-scorecard.ts` (`npm run scorecard`) | measured suite health; on-demand, not part of a run |

| Tier | Artifact | Audience |
| --- | --- | --- |
| 1 Diagnostic | `reports/diagnostic/index.html` + traces | developers, QA |
| 2 Executive | `reports/runs/<run>/kpost-executive-summary.html` (mirrored to `reports/latest/`) | leads, management |
| 3 Trend | `reports/kpost-trend-history.json` | quality dashboards |
| 4 Bug stream | `reports/runs/<run>/kpost-bug-payloads.json` | Plane / Redmine / Jira |
| 5 Publish | POST `BUG_REPORT.json` → external QA Dashboard | cross-run history, all benches |

> Tier 1's path is **flat**, not run-scoped: `playwright.config.ts` hard-codes the HTML reporter
> to `reports/diagnostic`, which is what `npm run report` opens. Tiers 2 and 4 are written per
> run under `reports/runs/<run>/` and mirrored into `reports/latest/`. The two schemes coexist
> deliberately — Playwright owns its own output directory and will not write run-scoped folders.

Load-bearing rules:

- **`kpost-master-reporter` must stay ahead of `bugReporter` in `playwright.config.ts`.**
  `onEnd` hooks run in array order and `bugReporter` deletes `.bug-cache/`, where both read
  the defect ledger.
- **`dashboard-ingest` must stay LAST.** It reads `BUG_REPORT.json`, which `bugReporter` only
  writes in its own `onEnd`; placed any earlier it would publish the *previous* run. It is
  fail-safe by construction — skips with one line when `DASHBOARD_INGEST_URL` /
  `DASHBOARD_API_KEY` are unset, times out at 10s, and can never change the run's exit code.
  It bridges `run.durationSeconds` → `run.durationMs` because the dashboard's schema requires
  milliseconds, leaving `durationSeconds` in place so the human file and the stored file match.
- **The environment label has exactly one source**, `src/utils/environment.ts`. Both
  `reporters/run-model.ts` (executive HTML) and `src/utils/bugTracker.ts` (the JSON writer)
  import `environmentName()` from it. `BUG_REPORT.json` therefore carries the short label
  (`"Local"`) in `environment`, and the raw URL separately in `baseURL`. Never reintroduce
  `environment: meta.baseURL` — the dashboard groups runs by that string, so a raw URL splits
  one environment into several.
- **Findings are cached atomically** under `.bug-cache/` with the exclusive `wx` flag, keyed
  by a content hash of `method + path + title`. This is what makes cross-worker dedup reliable
  — never replace it with read-then-append.
- **Defect ids are a content hash** (`BUG-API-XXXXXX`), not a counter; display ids (`KP-001…`)
  are assigned in the reporter after sorting by severity. One payload per defect, not per
  failed test.
- Dispatchers (email / webhook / tracker) are **fail-safe**: they skip cleanly with one log
  line when their env vars are absent and never fail a run. See `.env.example`.

## Bug reporting & severity

`BUG_REPORT.md` is **generated — never edit it by hand.** Four bands,
`Critical | Major | Medium | Low`, with `P0..P3` derived mechanically in `bugTracker.ts`.
A report where everything is Critical is a report nobody reads — grade honestly:

- **Critical** — auth bypass with data exposure, injection, IDOR, or invalid input *accepted*
  and persisted.
- **Major** — business rule not enforced, internals disclosed, a "secured" route reachable
  anonymously (no sensitive data), reflected script on a JSON response.
- **Medium** — wrong status code / misreported outcome (misleads a client, corrupts nothing).
- **Low** — cosmetic contract/response-shape deviation.

Because this backend permits all paths, most `assertUnauthorized` findings are Major
spec/implementation mismatches, not breaches — that grading is deliberate. On this API HTTP
200 says nothing about success, so severity keys on the envelope `status`/`statusCode`, never
the transport status alone.

Bug ownership comes from `MODULE_BY_PATH` (derived from the Swagger tag). Do **not**
reintroduce URL-prefix guessing: routes here do not match their tag names.

## Environment

`.env` (see `.env.example`). `BASE_URL` defaults to `http://localhost:9595`. The backend is
live and stateful — tests create real MongoDB rows. Prefer read-only or self-cleaning
assertions, and keep destructive happy-paths behind throwaway identities.

## Gotchas

- TypeScript 7 + faker 10 (ESM-only) require `module: preserve` / `moduleResolution: bundler`
  in `tsconfig.json`. Switching to `node16` breaks the faker import.
- `jsonwebtoken` is a real dependency here (the main framework has none for auth) — it mints
  the HS256 session token. `@types/jsonwebtoken` is what keeps `authSession.ts` type-clean.
- `noUnusedLocals` / `noUnusedParameters` are on; dead helpers fail the build.
