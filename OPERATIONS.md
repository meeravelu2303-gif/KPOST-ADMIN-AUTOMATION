# KPOST Admin Module Test Bench — Operations Manual

Everything you need to run this suite, read its reports, and get them to the people who fix the
defects. Written for a QA engineer seeing this repo for the first time.

`README.md` is the short front door. This file is the depth.

> Anything marked **⚠ Unverified** was written from source code or from another system's
> responses but could not be proven by running it here. Everything else was executed against
> this repo on 2026-08-13, against a live backend at `http://localhost:9595`.

---

## 1. What this test bench does

It fires hand-written API tests at the KPOST **Admin Module** backend — the tenant (company)
administration service that owns organisation set-up, workplace and HR hierarchies, employee
master data, role postings, product licensing and user onboarding. It hunts for real defects:
authentication bypass, injection, IDOR, unvalidated input, contract violations. Every confirmed
defect is written to a ticket-ready ledger with a `curl` and a Playwright reproduction attached.

There is no browser and no UI code: every test drives `APIRequestContext` directly. The backend
is Java/Spring Boot, which changes nothing here — this is black-box HTTP testing from outside.

```
  npm test
     │
     ▼
  [1] pretest gate ......... scripts/audit-vectors.ts
     │                       fails the run if mandatory vector coverage < 98%
     ▼
  [2] tests ................ 11 Playwright projects covering all 24 functional tags
     │                       assertions record defects into .bug-cache/ (one file per defect)
     ▼
  [3] reports .............. BUG_REPORT.md/.json · DEV_DIGEST · executive HTML
     │                       trend history · bug payloads · JUnit XML · traces
     ▼
  [4] dispatch ............. email · chat webhook · issue tracker
     │                       each skips with one line when unconfigured
     ▼
  [5] publish .............. POST BUG_REPORT.json ──▶ external QA Dashboard
                             logs the dashboard's runId
```

Steps 3–5 happen automatically in the reporters' `onEnd`, in that order. **The order is
load-bearing**: each stage reads what the one before it wrote. See CLAUDE.md → "The reporting
engine" for why.

### What makes this module different from the main KPOST bench

Two divergences matter operationally:

- **Login issues no token.** `userDetails/login` returns identity fields only. A session is
  acquired from `QA_AUTH_TOKEN`, or by **minting an HS256 JWT locally** from
  `ADMIN_JWT_SECRET`. If that secret does not match the server's signing key, the run silently
  drops to unauthenticated — which looks like an improvement (fewer defects) and is the
  opposite. Check the digest header says something other than `Authentication | NONE`.
- **The envelope is `{ value, status, statusCode, urlPath, error? }`** and the API answers
  **HTTP 200 or 500 only — never 404**. So a 200 tells you nothing. Every assertion reads the
  envelope's `status` word, not the transport status.

---

## 2. One-time setup

### Requirements

- Node.js 20+ (verified on v20.19.4)
- The Admin Module backend reachable at `BASE_URL` (default `http://localhost:9595`)
- Its liveness page answers at `GET /` — "Admin Application is Up and Running!!"

### Install

```bash
npm install
cp .env.example .env
```

Then edit `.env`. The variables that actually matter on day one:

| Variable | Why it matters |
| --- | --- |
| `BASE_URL` | Target API. Default `http://localhost:9595`. |
| `TEST_ENV` | The label on every report header **and the QA Dashboard's grouping key**. Inferred from `BASE_URL` when unset (`localhost` → `Local`). Never a raw URL. |
| `ADMIN_JWT_SECRET` | **The one to get right.** Must match the server's signing key or every run is unauthenticated. The `.env.example` value is the checked-in dev secret; a shared QA or production backend will differ. |
| `QA_KPOST_ID` / `QA_COMPANY_ID` | The identity baked into a minted token. `companyID` is what tenant-scoped endpoints read. |
| `QA_AUTH_TOKEN` | A real already-issued token. Preferred over minting; `npm run seed` writes it here. |
| `TEST_MOBILE` / `TEST_EMAIL` | Safe destinations. `userDetails/sendOTP` reaches a **real handset and costs money** — these keep every OTP test pointed at one number you control. |
| `KPOST_VECTOR_THRESHOLD` | Coverage gate percentage (default 98). `npm test` fails below it. |
| `DASHBOARD_INGEST_URL` / `DASHBOARD_API_KEY` | Publish to the QA Dashboard. Both unset = ingest skips cleanly. Get the key from the Dashboard's Applications page for slug **`kpost-admin`**. |

### Verify setup worked

```bash
npm run typecheck        # must print nothing and exit 0
npm run audit:vectors    # prints the coverage bar; exits 1 if below threshold
npm run test:departments # smallest useful real run against the backend
```

If the third command reports far fewer defects than expected, check the authentication line in
`DEV_DIGEST.md` before believing the API improved.

---

## 3. Running tests — every command

| Command | What it does |
| --- | --- |
| `npm test` | Full suite. Runs the vector gate first via `pretest`, then all 11 projects, then every report tier and dispatcher. |
| `npm run test:<tag>` | One project. `users`, `departments`, `designations`, `rolePostings`, `locations`, `employees`, `holidays`, `products`, `workplace`, `hr`, `reference`. |
| `npm run test:list` | Enumerate every test as JSON without running anything. Pins `--reporter=json` so it can never clobber `BUG_REPORT.md`. |
| `npm run test:no-onboarding` | Skips the specs that create accounts or send messages — see below. |
| `npm run test:skip-audit` | Bare `playwright test`, bypassing the `pretest` coverage gate. |
| `npm run audit:vectors` | The gate alone. `-- --json` writes `.audit-build/gaps.json`. |
| `npm run scorecard` | Writes `SUITE_SCORECARD.md` from measured facts. |
| `npm run seed` | Establishes a session and writes `QA_AUTH_TOKEN` into `.env`. Opt-in only. |
| `npm run clean` | Removes `test-results`, `.bug-cache`, `.audit-build`, `.scorecard-build`, `.dispatch-build`. Never touches `reports/`. |
| `npm run typecheck` | `tsc --noEmit`. Must be clean before any commit. |

### `test:no-onboarding` — what it skips and why

```
userDetails/sendOTP · userDetails/registration · userDetails/signUp · userDetails/save
userDetails/resetPassword · userDetails/createCommunicationId · demo/createDemoRequest
```

Use it on any environment that must not receive new accounts or dispatch messages. `sendOTP` is
the expensive one: it reaches a real handset, is unauthenticated, unthrottled, and has no
lockout. Note this variant **also bypasses the coverage gate** (npm only runs `pretest` for the
script literally named `test`), so run `npm run audit:vectors` yourself afterwards.

### One spec, or one test

```bash
npx playwright test tests/departments/departments.spec.ts
npx playwright test tests/departments/departments.spec.ts -g "\[IDOR\]"
npx playwright test --project=users -g "sendOTP"
```

### Two gotchas that cost real time

1. **`--reporter=line` (or any `--reporter=` override) disables all configured reporters.** No
   report tier is produced and `BUG_REPORT.md` is left at the "run in progress" stub that
   globalSetup wrote. Use a bare `npm test` when you need the artifacts.
2. **Seeding never runs by accident.** The `seed` project is registered in
   `playwright.config.ts` only when `KPOST_RUN_SEED` is set, which only `npm run seed` does.

---

## 4. Reports — the complete list

### 4.1 `BUG_REPORT.md` — the bug ledger *(root, automatic)*

The human deliverable. One ticket per defect, sorted by severity, each with steps to reproduce,
a `curl`, a Playwright snippet, the owning team, and the user-visible consequence. **Generated —
never edit by hand.**

### 4.2 `BUG_REPORT.json` — machine twin *(root, automatic)*

Same records, same ids, no rendering. This is the exact document the QA Dashboard ingests. Its
`environment` field carries the **short label** (`"Local"`), with the raw URL alongside as
`baseURL` — one shared `environmentName()` produces the label for both this file and the
executive HTML, so a run cannot be grouped two different ways.

### 4.3 `DEV_DIGEST.md` / `.json` — triage summary *(root, automatic)*

Severity / module / owner rollup plus ready-made chat payloads. `npm run notify` prints it.
**Read its authentication line first** — `Authentication | NONE` invalidates the run's
protected-route findings.

### 4.4 `SUITE_SCORECARD.md` — suite health *(root, on-demand)*

`npm run scorecard`. Grades the *test suite*, not the API, out of 100 from measured facts only:
a real `tsc --noEmit`, duplicate route signatures, endpoints under the 10-case floor, coverage
against `api.json`, whether the ownership registry still covers every path, whether every spec
directory is a registered project, and the proportion of defects carrying a curl/snippet/owner.
Where a criterion cannot be measured it deducts rather than assuming credit.

### 4.5 `reports/runs/<run>/kpost-executive-summary.html` — executive report *(automatic)*

Self-contained offline HTML for leads. Mirrored to `reports/latest/`; `npm run report:executive`
prints the path.

### 4.6 `reports/diagnostic/index.html` — Playwright's own report *(automatic)*

`npm run report`. Owns the **trace viewer**, the only way to replay a failed request and
response. Traces are retained on failure with sources. Note this path is flat, not run-scoped.

### 4.7 The QA Dashboard — external *(automatic after each run)*

`reporters/dashboard-ingest.ts` POSTs `BUG_REPORT.json` and logs the dashboard's `runId`. Cross-
run history lives there, not here — this bench holds no database driver and stores no history
beyond the trend file. Application slug: **`kpost-admin`**.

### Also produced, easy to miss

- `reports/kpost-trend-history.json` — one append-only point per run (tier 3).
- `reports/runs/<run>/kpost-bug-payloads.json` — REST-ready issue payloads (tier 4).
- `reports/junit-results.xml` — for CI consumers.
- `reports/runs/` is pruned to `KPOST_RUN_RETENTION` (default 20); `0` keeps everything.

---

## 5. Sending reports to developers

| Situation | Send |
| --- | --- |
| "What broke?" — a developer fixing one defect | `BUG_REPORT.md`, or just their ticket from it |
| Daily triage with a team lead | `DEV_DIGEST.md` |
| Status to management | the executive HTML |
| A failure someone disputes | the diagnostic report + its trace |
| Bulk-filing into Plane / Redmine / Jira | `reports/runs/<run>/kpost-bug-payloads.json` |
| Trend over time | the QA Dashboard |

### The automatic channels

All three dispatchers and the dashboard ingest are **fail-safe**: with their env vars unset each
prints one `skipped - X not configured` line and the run is unaffected.

- **Email** — set `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `DEV_EMAIL_RECIPIENTS`.
- **Chat webhook** — set `WEBHOOK_URL`; the payload shape is chosen from the host (Slack /
  Mattermost / Teams).
- **Issue tracker** — set `TRACKER_API_KEY` plus the `PLANE_*` or `REDMINE_*` trio. Dispatch is
  deduped via `reports/dispatched-bugs.json`, so one defect files one ticket, once.
- **QA Dashboard** — set `DASHBOARD_INGEST_URL` and `DASHBOARD_API_KEY`.

### Testing a channel without spamming anyone

Point the webhook at a private channel and run one small project (`npm run test:holidays`)
rather than the full suite. For email, set `DEV_EMAIL_RECIPIENTS` to your own address first.

### Daily routine

```bash
npm test                 # or test:no-onboarding on a protected environment
npm run notify           # read the digest, check the Authentication line
npm run report           # open traces for anything you intend to dispute
```

---

## 6. Troubleshooting

### 1. The environment is not reachable

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:9595/
```

Expect `200` and an HTML liveness banner. `curl http://localhost:9595/v3/api-docs` should serve
the live OpenAPI document; it is expected to match the checked-in `api.json`.

### 2. The whole run reports almost no defects

Read the `Authentication` line in `DEV_DIGEST.md`. `NONE` means no session could be established
and every protected-route assertion was skipped or unevaluated. Fix `ADMIN_JWT_SECRET`, or run
`npm run seed`. This failure mode is dangerous precisely because it looks like good news.

### 3. `npm test` refuses to start, printing a coverage bar

That is the `pretest` vector gate doing its job. Either close the listed gaps, or lower
`KPOST_VECTOR_THRESHOLD` deliberately and record why. Do not delete the check. To run the suite
once without it: `npm run test:skip-audit`.

### 4. Dashboard ingest returns 401 / connection refused

401 → the API key does not match the application; reissue it from the Dashboard's Applications
page for slug `kpost-admin`. Connection refused → `DASHBOARD_INGEST_URL` is wrong or the
dashboard is down. Either way the run itself is unaffected: ingest can never change the exit
code, and the reports on disk are complete.

### 5. Report files are missing or say "run in progress"

You passed a `--reporter=` override, which disables the configured reporter chain. Re-run with a
bare `npm test`.

### 6. `npm run <script>` exits 1 printing nothing

**Symptom:** any npm script exits 1 with only the npm banner — even `typecheck`, whose
`tsc --noEmit` passes when run directly. Reproduced in this repo from Git Bash.

**Cause:** npm resolves its script shell from `ComSpec`, which Git Bash does not set. npm throws
`ERR_INVALID_ARG_TYPE` *before your script runs*, and the error goes only to
`%LOCALAPPDATA%\npm-cache\_logs\*-debug-0.log`.

**Fix:** run npm from PowerShell or CMD. From Git Bash:

```bash
ComSpec="C:\Windows\System32\cmd.exe" npm test
```

Also never pipe npm to `tail` without `set -o pipefail` — the pipe returns *tail's* exit status
and hides the failure.

### 7. `.env` changes seem to have no effect

`authSession` is worker-scoped and resolved once per worker. Kill any stale Playwright workers
and re-run. `npm run clean` clears the caches that survive between runs.

---

## Reference

| Doc | For |
| --- | --- |
| [README.md](README.md) | The short front door |
| [CLAUDE.md](CLAUDE.md) | Architecture, conventions, severity grading, known API behaviours |
| `api.json` | The API contract. Stays at the root — two scripts locate the repo root by it |
