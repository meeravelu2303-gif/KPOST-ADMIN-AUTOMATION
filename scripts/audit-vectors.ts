/**
 * Vector coverage audit — enforces the standard vector set per endpoint.
 *
 * ## Why this exists
 *
 * `CLAUDE.md` requires every endpoint to carry standalone cases spanning a fixed set of attack
 * vectors. Until this script, nothing checked it: the rule was a convention followed by hand
 * across eleven spec files. Case *count* was verifiable, but a block can hold twelve boundary
 * tests and no authorization check at all — so the count proved nothing about scenario
 * completeness, and coverage drifted with no signal.
 *
 * ## How detection works, and why it is not regex-on-prose
 *
 * A first attempt in the main framework matched test *titles*. It reported 19% full coverage,
 * which was wrong — it was measuring vocabulary rather than coverage, because prose varies.
 *
 * This version classifies **each `test()` block individually by the code inside it** — which
 * assertion helper it calls, and what shape of payload it builds. Those are structural facts:
 * `assertUnauthorized` means an auth case regardless of how the title is worded. It is also
 * why the house style fixes `test.describe` titles to a bare `METHOD /path` signature: that
 * title is the key this audit groups by.
 *
 * ## The one vector that stays heuristic
 *
 * IDOR/BOLA has no dedicated helper — it is an ordinary assertion applied to a *foreign
 * identity*. Detection is therefore tag-only; see `IDOR_TAG`.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = fs.existsSync(path.join(process.cwd(), 'api.json'))
  ? process.cwd()
  : path.resolve(__dirname, '..');

/** Coverage below this fails the build. */
const THRESHOLD = Number(process.env.KPOST_VECTOR_THRESHOLD ?? 98);

type Vector =
  | 'contract'
  | 'missingParam'
  | 'nullBoundary'
  | 'typeFuzz'
  | 'auth'
  | 'idor'
  | 'business'
  | 'injection'
  | 'idempotency'
  | 'statusParity';

const MANDATORY: Vector[] = [
  'contract',
  'nullBoundary',
  'typeFuzz',
  'auth',
  'idor',
  'injection',
  'statusParity',
];

const ALL: Vector[] = [
  'contract',
  'missingParam',
  'nullBoundary',
  'typeFuzz',
  'auth',
  'idor',
  'business',
  'injection',
  'idempotency',
  'statusParity',
];

const LABEL: Record<Vector, string> = {
  contract: 'Contract/Zod',
  missingParam: 'MissingParam',
  nullBoundary: 'Null/Boundary',
  typeFuzz: 'TypeFuzz',
  auth: 'Auth',
  idor: 'IDOR/BOLA',
  business: 'BusinessLogic',
  injection: 'Injection',
  idempotency: 'Idempotency',
  statusParity: 'StatusParity',
};

/**
 * IDOR detection is **tag-only**, deliberately.
 *
 * Every other vector has an unambiguous structural signal — `assertUnauthorized` is an auth
 * case, full stop. IDOR has none: it is an ordinary assertion pointed at a foreign identity,
 * so heuristics either miss real cases or credit tests that merely mention "victim" in a
 * message string. Requiring an explicit `[IDOR]` marker in the title makes detection exact in
 * both directions. A genuine ownership test without the tag reads as a gap — the right failure
 * direction, because it is visible and fixable, whereas a false pass is neither.
 *
 * On this module IDOR is the highest-value vector of the set: every tenant-scoped route takes
 * a caller-supplied `companyId` in the body, and the auth filter is permissive, so a foreign
 * companyId is the whole attack.
 */
const IDOR_TAG = /\[IDOR\]/;

/**
 * Endpoints where a mandatory vector genuinely does not apply, each with the reason.
 *
 * This ledger exists so "not applicable" is *recorded and reviewable* rather than silently
 * absent. Without it the only way to reach 100% is to write tests that assert nothing — an
 * IDOR case for `GET /country/countryList` would be checking that one caller cannot read
 * another caller's copy of a global country list, which is not a concept. That is
 * metric-gaming, and it would dilute a suite whose value is its signal-to-noise ratio.
 *
 * Two rules for adding an entry: name the *specific* vector (never blanket-exempt an
 * endpoint), and state why the vector is meaningless here rather than merely inconvenient.
 */
const EXEMPTIONS: Array<{ sig: string; vectors: Vector[]; reason: string }> = [
  // --- No owned resource: the response is identical for every caller ------------------
  { sig: 'GET /country/countryList', vectors: ['idor'], reason: 'Global country reference list, identical for every caller. No per-tenant copy to cross-access.' },
  { sig: 'GET /country/getAddressUsingPincode/{pincode}', vectors: ['idor'], reason: 'Postal reference lookup. A PIN code belongs to no tenant.' },
  { sig: 'GET /country/getAddressUsingPincodeAndCountry/{pincode}/{country}', vectors: ['idor'], reason: 'Postal reference lookup keyed by PIN and country, not by owner.' },
  { sig: 'POST /country/save', vectors: ['idor'], reason: 'Writes to the global country reference collection; the record has no owning tenant.' },
  { sig: 'GET /', vectors: ['idor', 'contract', 'statusParity'], reason: 'Liveness page returning HTML, not the JSON envelope. It has no owner, no schema and no envelope statusCode to compare against.' },

  // --- Pre-account / pre-session: run before an identity exists -----------------------
  { sig: 'POST /userDetails/sendOTP', vectors: ['idor', 'auth'], reason: 'Pre-account OTP dispatch keyed by mobile number; must work with no token, and owns no record.' },
  { sig: 'POST /userDetails/validateOTP', vectors: ['idor', 'auth'], reason: 'Pre-account OTP gate; must work with no token.' },
  { sig: 'POST /userDetails/login', vectors: ['idor', 'auth'], reason: 'The credential endpoint itself — it runs before a session exists, and reads no owned record.' },
  { sig: 'POST /userDetails/registration', vectors: ['idor', 'auth'], reason: 'Account creation; runs before an identity exists.' },
  { sig: 'POST /userDetails/signUp', vectors: ['idor', 'auth'], reason: 'Account creation; runs before an identity exists.' },
  { sig: 'POST /userDetails/checkAvailability', vectors: ['idor', 'auth'], reason: 'Registration availability oracle over a namespace; deliberately public, reads no stored record.' },
  { sig: 'POST /userDetails/generateUserIdSuggestions', vectors: ['idor', 'auth'], reason: 'Generates candidate strings during registration; reads no stored record.' },
];

function exemptionFor(sig: string, vector: Vector): string | null {
  const hit = EXEMPTIONS.find((e) => e.sig === sig && e.vectors.includes(vector));
  return hit ? hit.reason : null;
}

interface Block {
  sig: string;
  file: string;
  cases: number;
  present: Set<Vector>;
}

/** Classifies one `test()` body by the code it runs, not by how its title is phrased. */
function classify(body: string): Vector[] {
  const found: Vector[] = [];

  if (/expectValidContract\(|validateSchema\(/.test(body)) found.push('contract');
  if (/assertStatusCodeParity\(|assertNot200OKOnError\(/.test(body)) found.push('statusParity');
  if (/assertNoInternalLeak\(|assertNoReflectedScript\(/.test(body)) found.push('injection');
  if (
    /assertUnauthorized\(|EXPIRED_TOKEN|FORGED_ALG_NONE_JWT|MALFORMED_TOKEN|token:\s*null/.test(body)
  ) {
    found.push('auth');
  }
  if (/Promise\.all\(/.test(body)) found.push('idempotency');
  if (IDOR_TAG.test(body)) found.push('idor');

  // A required field removed from an otherwise valid payload, or a deliberately bare request.
  if (
    /delete \(payload as|delete payload\.|,\s*\{\}\s*(,|\))|\(\{\}\s*,|postTo\([^,]+,\s*\{\}/.test(
      body
    )
  ) {
    found.push('missingParam');
  }

  // null / empty-string / oversized values fed into an override.
  if (/:\s*null\b|:\s*''|:\s*""|\.repeat\(|MAX_LENGTH|_STRING\b/.test(body)) {
    found.push('nullBoundary');
  }

  // Wrong-typed value where a scalar belongs, or a raw malformed body.
  if (
    /\[typefuzz\]|sendRaw\(|postRawTo\(|postRaw\(|:\s*\[[^\]]*\]\s*[,}]|:\s*\{\s*\w+:|:\s*\d{3,}\s*[,}]|:\s*true\b|:\s*false\b/.test(
      body
    )
  ) {
    found.push('typeFuzz');
  }

  // Anything asserting a rule beyond shape: rate limits, verbs, traversal, privilege, parity.
  if (
    /sendVerb\(|business rule|cross-parameter|documented defect|PARITY|enumeration|privilege|verb binding|traversal|rate limit|referential|reportBusinessLogicFlaw/i.test(
      body
    )
  ) {
    found.push('business');
  }

  return found;
}

function collectSpecFiles(dir: string, out: { rel: string; text: string }[] = []) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return out;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) collectSpecFiles(rel, out);
    else if (entry.name.endsWith('.spec.ts'))
      out.push({ rel, text: fs.readFileSync(path.join(ROOT, rel), 'utf8') });
  }
  return out;
}

const SIGNATURE = /(?:^|[-–]\s*)(GET|POST|PUT|PATCH|DELETE)\s+(\S+)/;

/**
 * Drops a trailing slash but never the whole path.
 *
 * A bare `.replace(/\/+$/, '')` turns the liveness route `/` into the empty string, so its
 * signature became `"GET "` and could never match the `'GET /'` entry in EXEMPTIONS — the
 * endpoint was reported as missing two vectors it is explicitly exempt from, forever.
 */
function stripTrailingSlash(route: string): string {
  const trimmed = route.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

function analyse(): Block[] {
  const blocks: Block[] = [];
  for (const file of collectSpecFiles('tests')) {
    const describeRe = /test\.describe\(\s*'([^']+)'/g;
    const starts: { title: string; idx: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = describeRe.exec(file.text)) !== null) starts.push({ title: m[1], idx: m.index });

    starts.forEach((start, i) => {
      const end = i + 1 < starts.length ? starts[i + 1].idx : file.text.length;
      const body = file.text.slice(start.idx, end);
      const sigMatch = start.title.match(SIGNATURE);
      if (!sigMatch) return;

      const sig = `${sigMatch[1]} ${stripTrailingSlash(sigMatch[2])}`;
      const present = new Set<Vector>();

      // Split into individual test() bodies so each case is classified on its own merits.
      const testRe = /\n\s{2}test\(/g;
      const testStarts: number[] = [];
      let t: RegExpExecArray | null;
      while ((t = testRe.exec(body)) !== null) testStarts.push(t.index);

      testStarts.forEach((s, j) => {
        const e = j + 1 < testStarts.length ? testStarts[j + 1] : body.length;
        classify(body.slice(s, e)).forEach((v) => present.add(v));
      });

      const existing = blocks.find((b) => b.sig === sig);
      if (existing) {
        existing.cases += testStarts.length;
        present.forEach((v) => existing.present.add(v));
      } else {
        blocks.push({ sig, file: file.rel, cases: testStarts.length, present });
      }
    });
  }
  return blocks;
}

function main(): void {
  const blocks = analyse().sort((a, b) => a.sig.localeCompare(b.sig));
  if (blocks.length === 0) {
    console.error('[vectors] no endpoint describe blocks found — is this the project root?');
    process.exit(1);
  }

  const totals = {} as Record<Vector, number>;
  ALL.forEach((v) => (totals[v] = blocks.filter((b) => b.present.has(v)).length));

  /*
   * Coverage counts *applicable* slots only. An exempted vector is removed from both the
   * numerator and the denominator, so exemptions cannot flatter the percentage — they only
   * stop a meaningless test from being demanded.
   */
  let slots = 0;
  const gaps = blocks
    .map((b) => {
      const applicable = MANDATORY.filter((v) => !exemptionFor(b.sig, v));
      slots += applicable.length;
      return { ...b, missing: applicable.filter((v) => !b.present.has(v)) };
    })
    .filter((b) => b.missing.length > 0);

  const filled = slots - gaps.reduce((n, b) => n + b.missing.length, 0);
  const coverage = (filled / slots) * 100;

  console.log(`\nKPOST Admin vector audit — ${blocks.length} endpoint blocks\n`);
  console.log('VECTOR                     COVERAGE');
  for (const v of ALL) {
    const n = totals[v];
    const pctv = (n / blocks.length) * 100;
    const bar = '█'.repeat(Math.round(pctv / 4)).padEnd(25, '·');
    const flag = MANDATORY.includes(v) ? ' *' : '  ';
    console.log(
      `  ${LABEL[v].padEnd(15)}${flag} ${bar} ${String(n).padStart(3)}/${blocks.length}  ${pctv.toFixed(1)}%`
    );
  }
  console.log('\n  * = mandatory; only these count toward the gate.');

  if (gaps.length) {
    console.log(`\nGAP MATRIX — ${gaps.length} endpoints missing at least one mandatory vector\n`);
    console.log('ENDPOINT'.padEnd(62) + 'CASES  MISSING');
    for (const g of gaps.sort(
      (a, b) => b.missing.length - a.missing.length || a.sig.localeCompare(b.sig)
    )) {
      console.log(
        `${g.sig.slice(0, 60).padEnd(62)}${String(g.cases).padStart(4)}   ${g.missing.map((v) => LABEL[v]).join(', ')}`
      );
    }
  }

  console.log(`\nmandatory vector coverage : ${filled}/${slots}  (${coverage.toFixed(2)}%)`);
  console.log(`threshold                 : ${THRESHOLD}%`);

  if (coverage < THRESHOLD) {
    console.error(
      `\n[vectors] FAIL — coverage ${coverage.toFixed(2)}% is below the ${THRESHOLD}% threshold.\n` +
        `          Close the gaps listed above, or lower KPOST_VECTOR_THRESHOLD deliberately\n` +
        `          and record why. Do not silence this by deleting the check.\n`
    );
    process.exit(1);
  }

  console.log('\n[vectors] PASS\n');
}

/**
 * `--json` emits the gap matrix as machine-readable JSON so remediation tooling can consume
 * it directly rather than re-deriving the analysis. Kept at the bottom, after `main()`, so the
 * human-facing path stays the default.
 */
if (process.argv.includes('--json')) {
  const blocks = analyse();
  const gaps = blocks
    .map((b) => ({
      sig: b.sig,
      file: b.file,
      cases: b.cases,
      missing: MANDATORY.filter((v) => !exemptionFor(b.sig, v) && !b.present.has(v)),
    }))
    .filter((b) => b.missing.length > 0);
  fs.mkdirSync(path.join(ROOT, '.audit-build'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.audit-build', 'gaps.json'), JSON.stringify(gaps, null, 2));
  console.log(`[vectors] wrote .audit-build/gaps.json — ${gaps.length} endpoints with gaps`);
}

main();
