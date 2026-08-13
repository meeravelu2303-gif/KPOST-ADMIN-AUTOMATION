import {
  test,
  expect,
  EXPIRED_TOKEN,
  MALFORMED_TOKEN,
  FORGED_ALG_NONE_JWT,
} from '../../src/fixtures/api.fixture';
import {
  assertStatusCodeParity,
  assertRejectsInvalidInput,
  assertUnauthorized,
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertNot200OKOnError,
  expectValidContract,
  readBody,
  reportBusinessLogicFlaw,
} from '../../src/utils/apiAssertions';
import { HOLIDAY_PATHS } from '../../src/api/clients/holidayCalendar.client';
import {
  holidayListEnvelopeSchema,
  holidayEnvelopeSchema,
} from '../../src/api/schemas/holidayCalendar.schema';
import { buildHoliday } from '../../src/api/payloads/holidayCalendar.payload';

/*
 * Holiday Calendar tag (/holiday/*) — the tenant's working-day calendar, which leave, payroll
 * and attendance all read from.
 *
 * One describe per endpoint titled with its bare `METHOD /path` signature, explicit standalone
 * cases — no loops, no factories — so every case is individually named, reportable and
 * skippable, and so `scripts/audit-vectors.ts` can group coverage by endpoint. Note that
 * `getHoliday` is a **GET**: it takes no body at all, so its boundary, type-fuzz and injection
 * cases are driven through query parameters instead.
 *
 * ## What is dangerous here
 *
 * `GET /holiday/getHoliday` derives its company scope from the **token's** `companyID` attribute
 * — there is no path, query or body parameter for it. That is the one genuinely tenant-safe
 * pattern in this module, and the cases below are written to prove it stays that way: every
 * query-parameter probe checks that a caller-supplied `companyID` does **not** displace the
 * token's. With no token the filter resolves companyID to null, so an anonymous caller gets an
 * empty calendar rather than a refusal — a spec/implementation mismatch, not a data breach.
 *
 * `POST /holiday/saveHoliday` is the opposite: `companyID` comes from the **body**, so the same
 * tenant scope that the read derives safely is caller-controlled on the write. It is also
 * documented to reject a same-date duplicate as HTTP 500 "Holiday already exists" — a
 * client-correctable validation failure dressed as a server fault. There is no delete route on
 * this tag, so every accepted write is permanent: the payload builder pins dates to 2027 so the
 * rows it creates cannot collide with a real working calendar.
 *
 * ## Envelope reminder
 *
 * Every route answers HTTP 200 or 500 only, carrying
 * `{ value, status: SUCCESS|FAILURE, statusCode, urlPath, error? }`. HTTP 200 says nothing about
 * success, so assertions read the envelope's status word, never the transport alone. An empty
 * calendar is documented to carry envelope `statusCode: 204` under an HTTP 200.
 */

const XSS_PAYLOAD = `<script>alert('holiday')</script>`;
const SQLI_PAYLOAD = `1001' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE table_holiday; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);

/* ==== GET /holiday/getHoliday ==== */
test.describe('GET /holiday/getHoliday', () => {
  const META = {
    method: 'GET',
    path: HOLIDAY_PATHS.getHoliday,
    repro: `await holidayCalendarClient.getHoliday({ token });`,
  };

  test('[1] happy path: the authenticated company\'s calendar returns a well-formed envelope', async ({
    holidayCalendarClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await holidayCalendarClient.getHoliday({ token });

    await expectValidContract(response, holidayListEnvelopeSchema, { ...META });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    holidayCalendarClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await holidayCalendarClient.getHoliday({ token });

    await assertStatusCodeParity(response, { ...META });
  });

  test('[1c] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    holidayCalendarClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await holidayCalendarClient.getHoliday({ token });

    await assertNot200OKOnError(response, { ...META });
  });

  test('[1d] business rule: an empty calendar must not report envelope 204 under an HTTP 200', async ({
    holidayCalendarClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * Documented quirk: a company with no holidays answers envelope `statusCode: 204` while the
     * transport stays 200. A client branching on the HTTP status sees "OK with a body"; a client
     * branching on the envelope sees "No Content". The same response describes itself two ways.
     */
    const response = await holidayCalendarClient.getHoliday({ token });

    const { json, text } = await readBody(response);
    if (json?.statusCode === 204 && response.status() === 200) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          scenario: `An empty calendar answered HTTP 200 carrying envelope statusCode 204. The transport says "OK, here is a body" while the envelope says "No Content", so a client cannot tell from the status alone whether a payload is present. Body: ${text.slice(0, 200)}`,
          title: 'getHoliday reports envelope statusCode 204 under an HTTP 200 transport status',
        },
        'Status Code Misreporting',
        'Medium'
      );
    }
    expect(true).toBe(true); // presence-only assertion; the finding above is the signal
  });

  test('[2] boundary: an empty companyID query parameter must not widen the token\'s scope', async ({
    holidayCalendarClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * There is no documented query parameter on this route, so an empty `companyID` should be
     * ignored outright. The failure worth catching is not "the parameter was accepted" — Spring
     * ignores unbound parameters by design — but "the parameter reached the tenant filter and
     * blanked it", which would return every company's calendar.
     */
    const response = await holidayCalendarClient.getHoliday({
      token,
      params: { companyID: '' },
    });

    const { json, text } = await readBody(response);
    const rows = Array.isArray(json?.value) ? (json.value as Array<{ companyID?: string }>) : [];
    const foreign = rows.filter((row) => row?.companyID && row.companyID !== companyID);
    if (foreign.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          repro: `await holidayCalendarClient.getHoliday({ token, params: { companyID: '' } });`,
          scenario: `An empty companyID query parameter caused ${foreign.length} holiday row(s) from other tenants to be returned. A blank caller-supplied value reached the tenant filter and widened it, so the token's scope is not authoritative. Body: ${text.slice(0, 200)}`,
          title: 'Empty companyID query parameter widens getHoliday beyond the token tenant',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[2b] boundary: a 5000-character query parameter must not produce a hidden failure', async ({
    holidayCalendarClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await holidayCalendarClient.getHoliday({
      token,
      params: { companyID: MAX_LENGTH_STRING },
    });

    // A query string this long is a classic 500 trigger. Whatever the server decides, it must not
    // answer HTTP 200 carrying a failure envelope — that failure would never reach a dashboard.
    await assertNot200OKOnError(response, {
      ...META,
      repro: `await holidayCalendarClient.getHoliday({ token, params: { companyID: 'a'.repeat(5000) } });`,
    });
  });

  test('[3] typefuzz: a numeric companyID query parameter must not override the token tenant', async ({
    holidayCalendarClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const response = await holidayCalendarClient.getHoliday({
      token,
      params: { companyID: 1001 },
    });

    const { json, text } = await readBody(response);
    const rows = Array.isArray(json?.value) ? (json.value as Array<{ companyID?: string }>) : [];
    const foreign = rows.filter((row) => row?.companyID && row.companyID !== companyID);
    if (foreign.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          repro: `await holidayCalendarClient.getHoliday({ token, params: { companyID: 1001 } });`,
          scenario: `A numeric companyID query parameter returned ${foreign.length} holiday row(s) belonging to other tenants. The route is documented to scope itself from the token alone, so a caller-supplied value must have no effect at all. Body: ${text.slice(0, 200)}`,
          title: 'Numeric companyID query parameter overrides the token tenant on getHoliday',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[3b] typefuzz: a boolean query parameter must be ignored, not coerced into a filter', async ({
    holidayCalendarClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await holidayCalendarClient.getHoliday({
      token,
      params: { repeatType: true },
    });

    await assertStatusCodeParity(response, {
      ...META,
      repro: `await holidayCalendarClient.getHoliday({ token, params: { repeatType: true } });`,
    });
  });

  test('[4] auth: an unauthenticated request must be refused, not answered with a calendar', async ({
    holidayCalendarClient,
  }) => {
    /*
     * With no token the filter resolves companyID to null and the documented result is an empty
     * calendar. api.json places the route under the global bearerAuth requirement, so a 200 here
     * is a real spec/implementation mismatch — Major on its own, Critical if holiday rows for a
     * real tenant actually come back.
     */
    const response = await holidayCalendarClient.getHoliday({ token: null });

    await assertUnauthorized(response, { ...META });
  });

  test('[4b] auth: an expired token must be refused', async ({ holidayCalendarClient }) => {
    const response = await holidayCalendarClient.getHoliday({ token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META });
  });

  test('[4c] auth: a token forged with alg:none must never be accepted', async ({
    holidayCalendarClient,
  }) => {
    // An alg:none token is unsigned by construction, and this one claims companyID 9999. Because
    // the route reads its tenant straight from the token, honouring it hands over that tenant's
    // whole calendar.
    const response = await holidayCalendarClient.getHoliday({ token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META });
  });

  test('[5] [IDOR] a companyID query parameter must not read another tenant\'s calendar', async ({
    holidayCalendarClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const response = await holidayCalendarClient.getHoliday({
      token,
      params: { companyID: otherTenant },
    });

    const { json, text } = await readBody(response);
    const rows = Array.isArray(json?.value) ? (json.value as Array<{ companyID?: string }>) : [];
    const foreign = rows.filter((row) => row?.companyID && row.companyID !== companyID);
    if (foreign.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          repro: `await holidayCalendarClient.getHoliday({ token /* tenant ${companyID} */, params: { companyID: "${otherTenant}" } });`,
          scenario: `Authenticated as tenant ${companyID}, a companyID query parameter of "${otherTenant}" returned ${foreign.length} foreign holiday row(s). The tenant scope is supposed to come from the token only; a caller-supplied parameter that displaces it is a cross-tenant read. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant calendar read (IDOR): companyID query parameter overrides the token',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL-injection query parameter must not surface a database error', async ({
    holidayCalendarClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await holidayCalendarClient.getHoliday({
      token,
      params: { companyID: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(
      response,
      {
        ...META,
        repro: `await holidayCalendarClient.getHoliday({ token, params: { companyID: "${SQLI_PAYLOAD}" } });`,
      },
      SQLI_PAYLOAD
    );
  });

  test('[6b] injection: a script query parameter must not be reflected unescaped', async ({
    holidayCalendarClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * The envelope echoes `urlPath` on every response. If it carries the raw query string, a
     * script payload placed there comes back verbatim to anything that renders the field.
     */
    const response = await holidayCalendarClient.getHoliday({
      token,
      params: { companyID: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(
      response,
      {
        ...META,
        repro: `await holidayCalendarClient.getHoliday({ token, params: { companyID: "<script>…" } });`,
      },
      XSS_PAYLOAD
    );
  });
});

/* ==== POST /holiday/saveHoliday ==== */
test.describe('POST /holiday/saveHoliday', () => {
  const META = {
    method: 'POST',
    path: HOLIDAY_PATHS.saveHoliday,
    repro: `await holidayCalendarClient.saveHoliday(buildHoliday(), { token });`,
  };

  test('[1] happy path: a valid holiday is accepted and returns the stored entity', async ({
    holidayCalendarClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHoliday();
    const response = await holidayCalendarClient.saveHoliday(body, { token });

    await expectValidContract(response, holidayEnvelopeSchema, { ...META, body });
  });

  test('[1b] contract: the stored holiday keeps the documented field casing (companyID)', async ({
    holidayCalendarClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * api.json documents a second, company-wide form of the payload: `countryId` and `stateName`
     * left null so the holiday applies everywhere. It must satisfy the same contract as the
     * regional form — including the tenant field spelt `companyID`, where the rest of the module
     * uses `companyId`. Validating here pins that inconsistency rather than hiding it.
     */
    const body = buildHoliday({ countryId: null, stateName: null });
    const response = await holidayCalendarClient.saveHoliday(body, { token });

    await expectValidContract(response, holidayEnvelopeSchema, { ...META, body });
  });

  test('[1c] parity: the HTTP status must agree with the envelope statusCode', async ({
    holidayCalendarClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHoliday();
    const response = await holidayCalendarClient.saveHoliday(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1d] parity: a rejected save must not be delivered under a 2xx transport status', async ({
    holidayCalendarClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHoliday();
    const response = await holidayCalendarClient.saveHoliday(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[1e] business rule: a duplicate holiday (same date/company) must not be a 500 or a SUCCESS', async ({
    holidayCalendarClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // Fixed date so the second call is a guaranteed duplicate for this tenant.
    const body = buildHoliday({ date: '2027-01-26', holidayDescription: 'QA Republic Day' });

    await holidayCalendarClient.saveHoliday(body, { token }); // first insert (or pre-existing)
    const second = await holidayCalendarClient.saveHoliday(body, { token });

    const { json, text } = await readBody(second);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    /*
     * Documented: a duplicate is rejected as HTTP 500 with message "Holiday already exists". That
     * is a validation outcome dressed as a server fault — it tells the caller the server broke
     * when in fact their input was wrong, and it fires the on-call alert for a user typo. The
     * opposite failure is worse: if the duplicate check never runs, the calendar holds two rows
     * for one date and every downstream leave and payroll calculation double-counts it.
     */
    if (second.status() === 500 || json?.statusCode === 500) {
      await reportBusinessLogicFlaw(
        second,
        {
          ...META,
          body,
          repro: `await holidayCalendarClient.saveHoliday({ date: "2027-01-26", ... }, { token }); // called twice`,
          scenario: `A duplicate holiday was rejected as HTTP/envelope 500 (message: "${json?.message ?? ''}"). A duplicate is a client-correctable validation error and belongs in the 4xx band, not the server-fault band. Body: ${text.slice(0, 200)}`,
          title: 'Duplicate holiday reported as 500 instead of a 4xx validation error',
        },
        'Status Code Misreporting',
        'Medium'
      );
    } else if (second.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        second,
        {
          ...META,
          body,
          repro: `await holidayCalendarClient.saveHoliday({ date: "2027-01-26", ... }, { token }); // called twice`,
          scenario: `A duplicate holiday for the same date and company was accepted with status SUCCESS — the documented duplicate check did not fire, so the calendar can hold two entries for one date. There is no delete route on this tag, so the duplicate cannot be removed through the API.`,
          title: 'Duplicate holiday accepted (duplicate check not enforced)',
        },
        'Business Logic Flaw',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: an empty date must be refused, not stored as an undated holiday', async ({
    holidayCalendarClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHoliday({ date: '' });
    const response = await holidayCalendarClient.saveHoliday(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty date' });
  });

  test('[2b] boundary: a null date must be refused', async ({
    holidayCalendarClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * A holiday with no date is unusable but permanent: there is no delete route on this tag, so
     * a row accepted here stays in the calendar forever.
     */
    const body = buildHoliday({ date: null });
    const response = await holidayCalendarClient.saveHoliday(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null date' });
  });

  test('[2c] boundary: a 5000-character holidayDescription must be refused rather than stored', async ({
    holidayCalendarClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHoliday({ holidayDescription: MAX_LENGTH_STRING });
    const response = await holidayCalendarClient.saveHoliday(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) holidayDescription',
    });
  });

  test('[2d] boundary: a date outside the ISO yyyy-MM-dd form must be refused', async ({
    holidayCalendarClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHoliday({ date: '26/01/2027' });
    const response = await holidayCalendarClient.saveHoliday(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'date in dd/MM/yyyy form where ISO yyyy-MM-dd is documented',
    });
  });

  test('[3] typefuzz: a boolean repeatType where an integer is documented must be refused', async ({
    holidayCalendarClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // `repeatType` is 0 (this year) or 1 (next year). A coerced boolean silently becomes one of
    // them, which quietly moves the holiday to a different year.
    const body = buildHoliday({ repeatType: true });
    const response = await holidayCalendarClient.saveHoliday(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'boolean repeatType where an integer is documented',
    });
  });

  test('[3b] typefuzz: an array stateName where a string is documented must be refused', async ({
    holidayCalendarClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHoliday({ stateName: ['Tamil Nadu', 'Kerala'] });
    const response = await holidayCalendarClient.saveHoliday(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'array stateName where a string is documented',
    });
  });

  test('[3c] typefuzz: an object companyID must be refused, not used as a Mongo operator', async ({
    holidayCalendarClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHoliday({ companyID: { $ne: null } });
    const response = await holidayCalendarClient.saveHoliday(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object companyID ({ $ne: null }) — a Mongo operator injection shape',
    });
  });

  test('[3d] typefuzz: a numeric countryId where a string is documented must be refused', async ({
    holidayCalendarClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // The Holiday DTO types countryId as a STRING here, unlike the Location DTO where it is an
    // integer. A silently-coerced value makes the two tags disagree about the same country.
    const body = buildHoliday({ countryId: 1001 });
    const response = await holidayCalendarClient.saveHoliday(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'numeric countryId where a string is documented',
    });
  });

  test('[4] auth: an unauthenticated caller must not be able to write to a calendar', async ({
    holidayCalendarClient,
  }) => {
    // There is no delete route on this tag, so an anonymous write is unremovable through the API.
    const body = buildHoliday();
    const response = await holidayCalendarClient.saveHoliday(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a malformed bearer token must be refused', async ({ holidayCalendarClient }) => {
    const body = buildHoliday();
    const response = await holidayCalendarClient.saveHoliday(body, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4c] auth: an expired token must be refused on a write', async ({
    holidayCalendarClient,
  }) => {
    const body = buildHoliday();
    const response = await holidayCalendarClient.saveHoliday(body, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a holiday must not be writable into another tenant\'s calendar', async ({
    holidayCalendarClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * The read side derives companyID from the token; the write side takes it from the body. If
     * the body wins, any authenticated caller can insert a working day into a competitor's
     * calendar — and with no delete route on this tag, the victim cannot remove it through the
     * API at all.
     */
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildHoliday({ companyID: otherTenant });
    const response = await holidayCalendarClient.saveHoliday(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    const stored = json?.value as { companyID?: string } | null;
    if (response.status() === 200 && status === 'SUCCESS' && stored?.companyID === otherTenant) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await holidayCalendarClient.saveHoliday({ companyID: "${otherTenant}", ... }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, a holiday was written into tenant "${otherTenant}" and returned stored with that companyID. The body's tenant field overrides the token's, so any caller can alter another company's working calendar — and this tag exposes no delete route to undo it. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant calendar write (IDOR): body companyID overrides the token tenant',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a script holidayDescription must not be stored and echoed unescaped', async ({
    holidayCalendarClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // A calendar entry is rendered in every employee's leave planner, so a persisted script here
    // executes in the session of everyone in the tenant, not just its author.
    const body = buildHoliday({ holidayDescription: XSS_PAYLOAD });
    const response = await holidayCalendarClient.saveHoliday(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });

  test('[6b] injection: a SQL payload in holidayDescription must not surface a database error', async ({
    holidayCalendarClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHoliday({ holidayDescription: SQLI_DROP_PAYLOAD });
    const response = await holidayCalendarClient.saveHoliday(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });

  test('[6c] injection: a SQL payload in stateName must not leak an exception trace', async ({
    holidayCalendarClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHoliday({ stateName: SQLI_PAYLOAD });
    const response = await holidayCalendarClient.saveHoliday(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });
});
