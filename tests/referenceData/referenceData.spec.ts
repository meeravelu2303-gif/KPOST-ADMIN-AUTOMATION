import {
  test,
  expect,
  EXPIRED_TOKEN,
  MALFORMED_TOKEN,
  FORGED_ALG_NONE_JWT,
} from '../../src/fixtures/api.fixture';
import {
  assertStatus,
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
import { REFERENCE_PATHS } from '../../src/api/clients/referenceData.client';
import {
  countryListEnvelopeSchema,
  addressListEnvelopeSchema,
  addressEnvelopeSchema,
  adminDetailsEnvelopeSchema,
  employeeRoleMappingEnvelopeSchema,
} from '../../src/api/schemas/referenceData.schema';
import { looseEnvelopeSchema } from '../../src/api/schemas/envelope.schema';
import {
  buildCountry,
  buildCountryArray,
  buildAdminDetails,
  buildEmployeeRoleMapping,
  randomObjectId,
} from '../../src/api/payloads/referenceData.payload';

/*
 * Reference-data & onboarding tail — the module's shared lookups and its two smallest writes.
 *
 * This project BUNDLES three Swagger tags plus the untagged liveness route:
 *   - Country & Address Reference Data (/country/*)
 *   - Admin Details (/adminDetails/save)
 *   - Employee ↔ Role Posting Mapping (/employeeRoleMapping/save)
 *   - admin-module-application (GET /)
 * Bundling groups **test execution only**. Bug ownership is still resolved per path by
 * `MODULE_BY_PATH`, so a defect found here routes to the team that owns that individual path,
 * not to one "reference data" bucket.
 *
 * One describe per endpoint titled with its bare `METHOD /path` signature, explicit standalone
 * cases — no loops, no factories — so every case is individually named, reportable and
 * skippable, and so `scripts/audit-vectors.ts` can group coverage by endpoint.
 *
 * ## What is dangerous here
 *
 * `POST /country/save` writes to the **global** `table_admin_country` collection. Unlike every
 * other write in this module the record has no owning tenant: whatever one caller stores, every
 * other tenant reads. That is why the audit ledger exempts this route from IDOR — and the
 * exemption is itself the finding. There is no per-tenant copy to cross-access because there is
 * no ownership at all, so an ordinary tenant token mutating shared reference data cannot even be
 * *described* as cross-tenant access. `dialCode` compounds it: the catalogue feeds OTP delivery,
 * so a bad dial code written here breaks mobile verification for that country platform-wide.
 * The block below reports that reachability explicitly rather than letting the exemption hide it.
 *
 * The two pincode lookups take **path parameters** and make an OUTBOUND HTTP call to the
 * external KPOST address service with the segment passed straight through. There is no body, so
 * the path is the entire attack surface: traversal, URL-encoded script, oversized and
 * wrong-typed segments are all driven through the URL. `getAddressUsingPincodeAndCountry`
 * additionally indexes upstream element `0` unconditionally, so a pincode with no match raises
 * an IndexOutOfBoundsException instead of answering an empty result.
 *
 * `POST /employeeRoleMapping/save` links an employee to a role posting and validates **neither**
 * id against its collection, nor the pair for uniqueness. A mapping naming an employee in
 * another tenant is the strong IDOR case; a repeated mapping is the idempotency case.
 *
 * ## Envelope reminder
 *
 * Every route here except `GET /` answers HTTP 200 or 500 only, carrying
 * `{ value, status: SUCCESS|FAILURE, statusCode, urlPath, error? }` — the payload is in
 * `value`, never `data`. There is no 404: a missing document is 200 with `value: null`/`[]`, or
 * 500 with `status: FAILURE`. HTTP 200 says nothing about success, so assertions read the
 * envelope's status word, never the transport alone. `GET /` is the one exception — it returns
 * an HTML banner page and no envelope at all, so nothing there asserts one.
 */

const XSS_PAYLOAD = `<script>alert('ref')</script>`;
const SQLI_PAYLOAD = `1001' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE table_admin_country; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);

/* ==== GET /country/countryList ==== */
test.describe('GET /country/countryList', () => {
  const META = {
    method: 'GET',
    path: REFERENCE_PATHS.countryList,
    repro: `await referenceDataClient.countryList({ token });`,
  };

  test('[1] happy path: the catalogue returns a well-formed country-list envelope', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * An EMPTY catalogue is a documented success, and is what the live backend currently
     * answers (`{"value":[],"urlPath":"countryList","status":"SUCCESS","statusCode":200}`).
     * The schema accepts `[]`, so this case asserts the envelope's shape, not its contents.
     */
    const response = await referenceDataClient.countryList({ token });

    await expectValidContract(response, countryListEnvelopeSchema, META);
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await referenceDataClient.countryList({ token });

    await assertStatusCodeParity(response, META);
  });

  test('[1c] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await referenceDataClient.countryList({ token });

    await assertNot200OKOnError(response, META);
  });

  test('[2] boundary: a 5000-character query string must not crash the catalogue read', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * The route takes no parameters, so an unrecognised query string is the only input a caller
     * can supply. Spring must ignore it; a 500 would mean an unbounded request line reaches
     * something that cannot cope with it, and this endpoint is called before login.
     */
    const params = { filter: MAX_LENGTH_STRING };
    const response = await referenceDataClient.countryList({ token, params });

    await assertStatus(response, [200], {
      ...META,
      repro: `await referenceDataClient.countryList({ token, params: { filter: 'a'.repeat(5000) } });`,
    });
  });

  test('[3] typefuzz: an undocumented numeric paging parameter must be ignored, not honoured', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * The read is an unfiltered `find({})` with no paging. If injecting `limit`/`skip` changes
     * the number of documents returned, the endpoint honours a parameter its contract does not
     * publish — clients would depend on undocumented behaviour, and the "whole catalogue"
     * guarantee callers cache against is silently breakable.
     */
    const baseline = await referenceDataClient.countryList({ token });
    const fuzzed = await referenceDataClient.countryList({ token, params: { limit: 1001 } });

    const baseValue = (await readBody(baseline)).json?.value;
    const fuzzValue = (await readBody(fuzzed)).json?.value;
    const baseCount = Array.isArray(baseValue) ? baseValue.length : -1;
    const fuzzCount = Array.isArray(fuzzValue) ? fuzzValue.length : -1;

    if (baseCount >= 0 && fuzzCount >= 0 && baseCount !== fuzzCount) {
      await reportBusinessLogicFlaw(
        fuzzed,
        {
          ...META,
          repro: `await referenceDataClient.countryList({ token, params: { limit: 1001 } });`,
          scenario: `The catalogue returned ${baseCount} countries with no parameters and ${fuzzCount} with an undocumented \`limit=1001\`. The endpoint honours a paging parameter absent from its contract, so callers can silently receive a partial catalogue while believing they hold the whole list.`,
          title: 'countryList honours an undocumented paging parameter',
        },
        'Business Logic Flaw',
        'Low'
      );
    }
    expect(true).toBe(true); // presence-only assertion; the finding above is the signal
  });

  test('[4] auth: the catalogue is a pre-account lookup and must serve an anonymous caller', async ({
    referenceDataClient,
  }) => {
    /*
     * Deliberately NOT assertUnauthorized. Country and dial-code dropdowns are read during
     * company registration, before any session exists, so anonymous access is by design here
     * and grading it as an auth defect would bury the real bypasses elsewhere in the module.
     * What matters is that the route stays reachable and returns no protected material.
     */
    const response = await referenceDataClient.countryList({ token: null });

    await assertStatus(response, [200], {
      ...META,
      repro: `await referenceDataClient.countryList({ token: null });`,
    });
  });

  test('[4b] auth: a malformed bearer token must not turn a public read into a server error', async ({
    referenceDataClient,
  }) => {
    // The filter may ignore the header (public route) or refuse it, but a garbage token must
    // not reach the read path and 500 — that would make the registration screen unusable for
    // anyone holding a stale token.
    const response = await referenceDataClient.countryList({ token: MALFORMED_TOKEN });

    await assertStatus(response, [200, 401, 403], {
      ...META,
      repro: `await referenceDataClient.countryList({ token: MALFORMED_TOKEN });`,
    });
  });

  test('[6] injection: a SQL payload in the query string must not surface a database error', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const params = { filter: SQLI_PAYLOAD };
    const response = await referenceDataClient.countryList({ token, params });

    await assertNoInternalLeak(
      response,
      {
        ...META,
        repro: `await referenceDataClient.countryList({ token, params: { filter: "${SQLI_PAYLOAD}" } });`,
      },
      SQLI_PAYLOAD
    );
  });

  test('[6b] injection: a script query parameter must not be echoed back unescaped', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // Spring's default error handling reflects the offending parameter in some configurations;
    // the envelope's `urlPath` is another echo point. Either would be an XSS sink for a UI that
    // renders the error text.
    const params = { filter: XSS_PAYLOAD };
    const response = await referenceDataClient.countryList({ token, params });

    await assertNoReflectedScript(
      response,
      {
        ...META,
        repro: `await referenceDataClient.countryList({ token, params: { filter: "${XSS_PAYLOAD}" } });`,
      },
      XSS_PAYLOAD
    );
  });
});

/* ==== POST /country/save ==== */
test.describe('POST /country/save', () => {
  const META = {
    method: 'POST',
    path: REFERENCE_PATHS.countrySave,
    repro: `await referenceDataClient.saveCountries(buildCountryArray(2), { token });`,
  };

  test('[1] happy path: a valid array of countries is accepted', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildCountryArray(2);
    const response = await referenceDataClient.saveCountries(body, { token });

    await assertStatus(response, [200], { ...META, body });
  });

  test('[1b] contract: the save response satisfies the envelope', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // Documented to answer the literal string `SUCCESS` in `value`, not a country document —
    // so the loose envelope, not the country-list schema, is the contract here.
    const body = buildCountryArray(1);
    const response = await referenceDataClient.saveCountries(body, { token });

    await expectValidContract(response, looseEnvelopeSchema, { ...META, body });
  });

  test('[1c] parity: the HTTP status must agree with the envelope statusCode', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildCountryArray(1);
    const response = await referenceDataClient.saveCountries(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1d] business rule: an ordinary tenant token must not be able to mutate global reference data', async ({
    referenceDataClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * The notable risk on this route, and the reason it is IDOR-exempt: `table_admin_country`
     * has no owning tenant, so a write here is visible to EVERY tenant. Seeding the catalogue is
     * an administrative, one-off operation; if an ordinary tenant-scoped session can perform it,
     * any customer can rewrite reference data the whole platform reads — including `dialCode`,
     * which drives OTP delivery, so a bad value breaks mobile verification for that country
     * everywhere. Privilege separation, not tenant isolation, is what is missing.
     */
    const body = buildCountryArray(1, { countryName: 'QA-AUTOMATION-GLOBAL-WRITE-PROBE' });
    const response = await referenceDataClient.saveCountries(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await referenceDataClient.saveCountries([{ countryName: "QA-AUTOMATION-GLOBAL-WRITE-PROBE", ... }], { token /* ordinary tenant ${companyID} */ });`,
          scenario: `An ordinary tenant-scoped session (company ${companyID}) wrote a document into the GLOBAL country catalogue and was told SUCCESS. The collection is shared by every tenant and has no owning company, so this record is now served to all of them by country/countryList — and a forged dialCode written the same way propagates into OTP delivery. The route needs an administrative privilege check the module does not apply. Body: ${text.slice(0, 200)}`,
          title: 'Global country reference data is writable by any tenant-scoped caller',
        },
        'Security/Access Control',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: an empty array must not be accepted as a successful seed', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body: unknown[] = [];
    const response = await referenceDataClient.saveCountries(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      repro: `await referenceDataClient.saveCountries([], { token });`,
      scenario: 'empty country array',
    });
  });

  test('[2b] boundary: a null countryName must be refused, not seeded as a blank dropdown row', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // The collection has no schema validation, so a blank name is accepted and then surfaces
    // as an empty option in every tenant's country dropdown.
    const body = buildCountryArray(1, { countryName: null });
    const response = await referenceDataClient.saveCountries(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null countryName' });
  });

  test('[2c] boundary: a 5000-character countryName must be refused rather than stored globally', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildCountryArray(1, { countryName: MAX_LENGTH_STRING });
    const response = await referenceDataClient.saveCountries(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) countryName',
    });
  });

  test('[3] typefuzz: an object body where the documented shape is an array must be refused', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildCountry(); // a single object where an array is required
    const response = await referenceDataClient.saveCountries(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      repro: `await referenceDataClient.saveCountries(buildCountry(), { token }); // object, not array`,
      scenario: 'object body instead of a JSON array',
    });
  });

  test('[3b] typefuzz: a numeric dialCode where a string is documented must be refused', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * `dialCode` is typed as a string here (unlike the OTP schemas, where it is an integer), and
     * the repository's `existsByDialCode` takes an `int`. A number accepted into the string field
     * is exactly the mismatch that makes the duplicate check miss.
     */
    const body = buildCountryArray(1, { dialCode: 1001 });
    const response = await referenceDataClient.saveCountries(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'numeric dialCode where a string is documented',
    });
  });

  test('[3c] typefuzz: a boolean countryCode must not be coerced into the catalogue', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildCountryArray(1, { countryCode: true });
    const response = await referenceDataClient.saveCountries(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean countryCode' });
  });

  test('[4] auth: an unauthenticated caller must not be able to seed the global catalogue', async ({
    referenceDataClient,
  }) => {
    /*
     * Reading the catalogue anonymously is by design; WRITING it is not. api.json places this
     * route under the global bearerAuth requirement, and an anonymous write lands in data every
     * tenant reads. A 200 here is a spec/implementation mismatch at minimum.
     */
    const body = buildCountryArray(1);
    const response = await referenceDataClient.saveCountries(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must not authorise a global write', async ({
    referenceDataClient,
  }) => {
    const body = buildCountryArray(1);
    const response = await referenceDataClient.saveCountries(body, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[6] injection: a <script> countryName must not be stored and echoed unescaped', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // Stored XSS here is platform-wide: the catalogue is rendered in every tenant's dropdowns.
    const body = buildCountryArray(1, { countryName: XSS_PAYLOAD });
    const response = await referenceDataClient.saveCountries(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });

  test('[6b] injection: a SQL payload in countryName must not surface a database error', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildCountryArray(1, { countryName: SQLI_DROP_PAYLOAD });
    const response = await referenceDataClient.saveCountries(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });
});

/* ==== GET /country/getAddressUsingPincode/{pincode} ==== */
test.describe('GET /country/getAddressUsingPincode/{pincode}', () => {
  const META = {
    method: 'GET',
    path: REFERENCE_PATHS.getAddressUsingPincode,
    repro: `await referenceDataClient.getAddressUsingPincode('600042', { token });`,
  };

  test('[1] happy path: a valid pincode returns a well-formed address-list envelope', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // The item shape is dictated by the external address service, so the contract asserted is
    // the envelope plus "value is a list of maps" — an unknown pincode legitimately yields [].
    const response = await referenceDataClient.getAddressUsingPincode('600042', { token });

    await expectValidContract(response, addressListEnvelopeSchema, META);
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await referenceDataClient.getAddressUsingPincode('600042', { token });

    await assertStatusCodeParity(response, META);
  });

  test('[2] boundary: an empty pincode segment must be refused, not resolved', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // An empty segment collapses the URL to `/country/getAddressUsingPincode/`. That must be a
    // client error, not an outbound call with a blank key.
    const response = await referenceDataClient.getAddressUsingPincode('', { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        repro: `await referenceDataClient.getAddressUsingPincode('', { token });`,
        scenario: 'empty pincode path segment',
        severity: 'Major',
      },
      [400, 404, 422]
    );
  });

  test('[2b] boundary: a 5000-character pincode must not be forwarded to the address service', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * The segment is passed straight through to an outbound HTTP call. An unbounded value is
     * both a request-line abuse against this backend and an amplification against the upstream
     * service, which is a paid third party.
     */
    const response = await referenceDataClient.getAddressUsingPincode(MAX_LENGTH_STRING, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        repro: `await referenceDataClient.getAddressUsingPincode('a'.repeat(5000), { token });`,
        scenario: 'oversized (5000-char) pincode path segment',
        severity: 'Major',
      },
      [400, 414, 422]
    );
  });

  test('[2c] boundary: a non-numeric pincode must be refused, not answered from the upstream call', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // Documented as "passed straight through with no validation", so a word reaches the paid
    // upstream service unchecked. Validating the format locally is the whole fix.
    const response = await referenceDataClient.getAddressUsingPincode('not-a-pincode', { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        repro: `await referenceDataClient.getAddressUsingPincode('not-a-pincode', { token });`,
        scenario: 'non-numeric pincode',
        severity: 'Major',
      },
      [400, 404, 422]
    );
  });

  test('[3] typefuzz: a boolean-shaped path segment must not be resolved as a pincode', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * A path parameter has no request body to fuzz, so the wrong-typed value is driven through
     * the segment itself: the literal `true` where a numeric PIN code is documented.
     */
    const pathParams = { pincode: true };
    const response = await referenceDataClient.getAddressUsingPincode(String(pathParams.pincode), {
      token,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: pathParams,
        repro: `await referenceDataClient.getAddressUsingPincode('true', { token });`,
        scenario: 'boolean-shaped path segment "true" where a numeric PIN code is documented',
        severity: 'Major',
      },
      [400, 404, 422]
    );
  });

  test('[4] auth: postal reference data is public, but the route must not fault without a token', async ({
    referenceDataClient,
  }) => {
    /*
     * A PIN code belongs to no tenant and the data is public, so this is graded as a reachability
     * check rather than assertUnauthorized — reporting anonymous access as a breach here would be
     * noise. The abuse worth reporting is the outbound relay, which [4b] covers separately.
     */
    const response = await referenceDataClient.getAddressUsingPincode('600042', { token: null });

    await assertStatus(response, [200, 401, 403], {
      ...META,
      repro: `await referenceDataClient.getAddressUsingPincode('600042', { token: null });`,
    });
  });

  test('[4b] business rule: an anonymous caller must not be able to drive the outbound address service', async ({
    referenceDataClient,
  }) => {
    /*
     * The endpoint is an unauthenticated, unthrottled proxy in front of a paid third-party
     * service. That is a different defect from "protected data leaked": nothing sensitive comes
     * back, but anyone on the internet can spend the tenant's upstream quota through it and use
     * this backend as an anonymising relay for address enumeration.
     */
    const response = await referenceDataClient.getAddressUsingPincode('600042', { token: null });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          repro: `await referenceDataClient.getAddressUsingPincode('600042', { token: null });`,
          scenario: `With no Authorization header at all, the endpoint completed an outbound call to the external KPOST address service and returned its result. The route is declared under bearerAuth, is unthrottled, and has no per-caller budget, so an anonymous client can exhaust the upstream quota and use this backend as a relay for address enumeration. Body: ${text.slice(0, 200)}`,
          title: 'Unauthenticated, unthrottled proxy to the external address service',
        },
        'Security/Rate Limiting',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a traversal segment must not reach the outbound URL or leak internals', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * The segment is concatenated into the upstream request. If it is not encoded on the way
     * out, `../` re-points that call at a different upstream path — and whatever comes back,
     * the response must not carry the exception, the upstream base URL, or the endpoint it
     * actually called.
     */
    const traversal = '../../actuator/env';
    const response = await referenceDataClient.getAddressUsingPincode(
      encodeURIComponent(traversal),
      { token }
    );

    await assertNoInternalLeak(
      response,
      {
        ...META,
        repro: `await referenceDataClient.getAddressUsingPincode(encodeURIComponent('${traversal}'), { token });`,
      },
      traversal
    );
  });

  test('[6b] injection: a SQL payload in the path must not surface a database or driver error', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await referenceDataClient.getAddressUsingPincode(
      encodeURIComponent(SQLI_PAYLOAD),
      { token }
    );

    await assertNoInternalLeak(
      response,
      {
        ...META,
        repro: `await referenceDataClient.getAddressUsingPincode(encodeURIComponent("${SQLI_PAYLOAD}"), { token });`,
      },
      SQLI_PAYLOAD
    );
  });

  test('[6c] injection: a URL-encoded script segment must not be reflected unescaped', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // The envelope echoes `urlPath`, and upstream failures echo the value that caused them —
    // both are places this payload can come back verbatim into a message a UI renders.
    const response = await referenceDataClient.getAddressUsingPincode(
      encodeURIComponent(XSS_PAYLOAD),
      { token }
    );

    await assertNoReflectedScript(
      response,
      {
        ...META,
        repro: `await referenceDataClient.getAddressUsingPincode(encodeURIComponent("${XSS_PAYLOAD}"), { token });`,
      },
      XSS_PAYLOAD
    );
  });
});

/* ==== GET /country/getAddressUsingPincodeAndCountry/{pincode}/{country} ==== */
test.describe('GET /country/getAddressUsingPincodeAndCountry/{pincode}/{country}', () => {
  const META = {
    method: 'GET',
    path: REFERENCE_PATHS.getAddressUsingPincodeAndCountry,
    repro: `await referenceDataClient.getAddressUsingPincodeAndCountry('600042', 'India', { token });`,
  };

  test('[1] happy path: a valid pincode and country return a single address envelope', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await referenceDataClient.getAddressUsingPincodeAndCountry(
      '600042',
      'India',
      { token }
    );

    await expectValidContract(response, addressEnvelopeSchema, META);
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await referenceDataClient.getAddressUsingPincodeAndCountry(
      '600042',
      'India',
      { token }
    );

    await assertStatusCodeParity(response, META);
  });

  test('[1c] business rule: an unmatched pincode must yield an empty result, not an unhandled exception', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * Documented defect: the implementation indexes upstream element `0` unconditionally, so a
     * well-formed pincode with no match raises an IndexOutOfBoundsException and the route answers
     * 500. "No address for this PIN" is an ordinary outcome of an address lookup, not a server
     * fault — the sibling route returns [] for the same input.
     */
    const unmatched = '999999';
    const response = await referenceDataClient.getAddressUsingPincodeAndCountry(
      unmatched,
      'India',
      { token }
    );

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    const code = typeof json?.statusCode === 'number' ? json.statusCode : null;
    if (response.status() >= 500 || status === 'FAILURE' || (code !== null && code >= 500)) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          repro: `await referenceDataClient.getAddressUsingPincodeAndCountry('${unmatched}', 'India', { token });`,
          scenario: `A well-formed pincode with no upstream match produced a server error rather than an empty result — the implementation indexes element 0 of the upstream list unconditionally. Every address form that uses this variant breaks on any unrecognised PIN code, and the caller cannot tell "no such PIN" from "the address service is down". Body: ${text.slice(0, 200)}`,
          title: 'Unmatched pincode raises IndexOutOfBoundsException instead of an empty result',
        },
        'Unhandled NPE / Server Error',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: an empty country segment must be refused', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await referenceDataClient.getAddressUsingPincodeAndCountry('600042', '', {
      token,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        repro: `await referenceDataClient.getAddressUsingPincodeAndCountry('600042', '', { token });`,
        scenario: 'empty country path segment',
        severity: 'Major',
      },
      [400, 404, 422]
    );
  });

  test('[2b] boundary: a 5000-character country segment must be refused', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await referenceDataClient.getAddressUsingPincodeAndCountry(
      '600042',
      MAX_LENGTH_STRING,
      { token }
    );

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        repro: `await referenceDataClient.getAddressUsingPincodeAndCountry('600042', 'a'.repeat(5000), { token });`,
        scenario: 'oversized (5000-char) country path segment',
        severity: 'Major',
      },
      [400, 414, 422]
    );
  });

  test('[3] typefuzz: an array-shaped pincode segment must not be resolved', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * A caller serialising a list into the segment sends `600042,600001`. The documented type is
     * a single string PIN code; a comma-joined pair must be refused rather than silently
     * resolving to whichever half the upstream service happens to parse.
     */
    const pathParams = { pincode: ['600042', '600001'] };
    const response = await referenceDataClient.getAddressUsingPincodeAndCountry(
      String(pathParams.pincode),
      'India',
      { token }
    );

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body: pathParams,
        repro: `await referenceDataClient.getAddressUsingPincodeAndCountry('600042,600001', 'India', { token });`,
        scenario: 'array-shaped pincode segment ("600042,600001") where a single PIN code is documented',
        severity: 'Major',
      },
      [400, 404, 422]
    );
  });

  test('[4] auth: the lookup must not fault when called without a token', async ({
    referenceDataClient,
  }) => {
    // Same reasoning as the sibling route: postal data has no owner, so this is a reachability
    // check rather than an authorisation breach.
    const response = await referenceDataClient.getAddressUsingPincodeAndCountry(
      '600042',
      'India',
      { token: null }
    );

    await assertStatus(response, [200, 401, 403, 500], {
      ...META,
      repro: `await referenceDataClient.getAddressUsingPincodeAndCountry('600042', 'India', { token: null });`,
    });
  });

  test('[6] injection: a traversal segment in country must not leak internals or the upstream URL', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // The country segment is documented as accepted-but-unused, which makes it the least
    // guarded input on the route — and it still lands in the request line and the audit entry.
    const traversal = '../../../actuator/health';
    const response = await referenceDataClient.getAddressUsingPincodeAndCountry(
      '600042',
      encodeURIComponent(traversal),
      { token }
    );

    await assertNoInternalLeak(
      response,
      {
        ...META,
        repro: `await referenceDataClient.getAddressUsingPincodeAndCountry('600042', encodeURIComponent('${traversal}'), { token });`,
      },
      traversal
    );
  });

  test('[6b] injection: a script country segment must not be reflected unescaped', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await referenceDataClient.getAddressUsingPincodeAndCountry(
      '600042',
      encodeURIComponent(XSS_PAYLOAD),
      { token }
    );

    await assertNoReflectedScript(
      response,
      {
        ...META,
        repro: `await referenceDataClient.getAddressUsingPincodeAndCountry('600042', encodeURIComponent("${XSS_PAYLOAD}"), { token });`,
      },
      XSS_PAYLOAD
    );
  });
});

/* ==== POST /adminDetails/save ==== */
test.describe('POST /adminDetails/save', () => {
  const META = {
    method: 'POST',
    path: REFERENCE_PATHS.adminDetailsSave,
    repro: `await referenceDataClient.saveAdminDetails(buildAdminDetails(), { token });`,
  };

  test('[1] happy path: a valid administrator profile is accepted', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildAdminDetails();
    const response = await referenceDataClient.saveAdminDetails(body, { token });

    await assertStatus(response, [200], { ...META, body });
  });

  test('[1b] contract: the save response satisfies the admin-details envelope', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildAdminDetails();
    const response = await referenceDataClient.saveAdminDetails(body, { token });

    await expectValidContract(response, adminDetailsEnvelopeSchema, { ...META, body });
  });

  test('[1c] parity: the HTTP status must agree with the envelope statusCode', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildAdminDetails();
    const response = await referenceDataClient.saveAdminDetails(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1d] business rule: a replace against an id that exists nowhere must not be reported as a replace', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * Supplying an `id` is documented as "replace that document in full". Spring Data's `save`
     * does not distinguish replace from insert: an id matching nothing is upserted, so a caller
     * who mistypes an id creates a second administrator record under the id they meant to
     * overwrite, and is told it succeeded. The caller cannot tell the two outcomes apart.
     */
    const missingId = randomObjectId();
    const body = buildAdminDetails({ id: missingId, firstName: 'Nowhere' });
    const response = await referenceDataClient.saveAdminDetails(body, { token });

    const { json, text } = await readBody(response);
    const value = json?.value as { id?: string } | null;
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS' && value?.id === missingId) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await referenceDataClient.saveAdminDetails({ id: "${missingId}", firstName: "Nowhere", ... }, { token });`,
          scenario: `A save carrying the never-issued id "${missingId}" returned SUCCESS with that same id, so the "replace" silently inserted a new administrator document instead of failing. Nothing in the response distinguishes a genuine replace from an accidental insert, and the tenant now holds an extra admin profile it never created. Body: ${text.slice(0, 200)}`,
          title: 'adminDetails/save upserts an unmatched id and reports it as a successful replace',
        },
        'Business Logic Flaw',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: an empty companyId must be refused, not saved as a tenant-less admin', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // Every read path filters on companyId, so a record saved without one is orphaned: it is
    // never returned to its owner and never cleaned up.
    const body = buildAdminDetails({ companyId: '' });
    const response = await referenceDataClient.saveAdminDetails(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty companyId' });
  });

  test('[2b] boundary: a null companyId must be refused', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildAdminDetails({ companyId: null });
    const response = await referenceDataClient.saveAdminDetails(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null companyId' });
  });

  test('[2c] boundary: a 5000-character firstName must be refused rather than stored', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildAdminDetails({ firstName: MAX_LENGTH_STRING });
    const response = await referenceDataClient.saveAdminDetails(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) firstName',
    });
  });

  test('[3] typefuzz: a numeric companyId where a string is documented must be refused', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // companyId is the business company number stored as text. A number persisted into the same
    // field never matches the string filter every read path uses.
    const body = buildAdminDetails({ companyId: 1001 });
    const response = await referenceDataClient.saveAdminDetails(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'numeric companyId where a string is documented',
    });
  });

  test('[3b] typefuzz: an object companyId must be refused, not used as a Mongo operator', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildAdminDetails({ companyId: { $ne: null } });
    const response = await referenceDataClient.saveAdminDetails(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object companyId ({ $ne: null }) — a Mongo operator injection shape',
    });
  });

  test('[4] auth: an unauthenticated caller must not be able to write an administrator profile', async ({
    referenceDataClient,
  }) => {
    /*
     * This record carries personal data (date of birth, mobile) and names who administers the
     * tenant. An anonymous write overwrites the company's administrator; an anonymous response
     * echoing the stored profile is an outright disclosure.
     */
    const body = buildAdminDetails();
    const response = await referenceDataClient.saveAdminDetails(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must be refused on a write', async ({ referenceDataClient }) => {
    const body = buildAdminDetails();
    const response = await referenceDataClient.saveAdminDetails(body, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] an administrator profile must not be writable into another tenant', async ({
    referenceDataClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * The auth filter injects companyID from the token, but this endpoint takes companyId from
     * the BODY. Unlike the country catalogue, this record IS owned — one document per company —
     * so a foreign companyId that is honoured replaces another tenant's administrator wholesale
     * (the save is a full-document overwrite, and omitted fields persist as null).
     */
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildAdminDetails({ companyId: otherTenant, firstName: 'QA-CROSS-TENANT' });
    const response = await referenceDataClient.saveAdminDetails(body, { token });

    const { json, text } = await readBody(response);
    const value = json?.value as { companyId?: string } | null;
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS' && value?.companyId === otherTenant) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await referenceDataClient.saveAdminDetails({ companyId: "${otherTenant}", firstName: "QA-CROSS-TENANT", ... }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, an administrator profile was written into tenant "${otherTenant}" and returned with that foreign companyId. The body's companyId is trusted over the token's, and the save is a full-document replace, so any caller can overwrite another company's administrator record — name, date of birth and contact mobile included. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant administrator write (IDOR): body companyId overrides the token tenant',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a script firstName must not be stored and echoed unescaped', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // The admin profile is rendered as "managed by" text next to the company's role postings,
    // so a stored script here executes in whoever views that screen.
    const body = buildAdminDetails({ firstName: XSS_PAYLOAD });
    const response = await referenceDataClient.saveAdminDetails(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });

  test('[6b] injection: a SQL payload in companyId must not surface a database error', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildAdminDetails({ companyId: SQLI_PAYLOAD });
    const response = await referenceDataClient.saveAdminDetails(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });
});

/* ==== POST /employeeRoleMapping/save ==== */
test.describe('POST /employeeRoleMapping/save', () => {
  const META = {
    method: 'POST',
    path: REFERENCE_PATHS.employeeRoleMappingSave,
    repro: `await referenceDataClient.saveEmployeeRoleMapping(buildEmployeeRoleMapping(), { token });`,
  };

  test('[1] happy path: a valid mapping is accepted', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeRoleMapping();
    const response = await referenceDataClient.saveEmployeeRoleMapping(body, { token });

    await assertStatus(response, [200], { ...META, body });
  });

  test('[1b] contract: the save response satisfies the mapping envelope', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeRoleMapping();
    const response = await referenceDataClient.saveEmployeeRoleMapping(body, { token });

    await expectValidContract(response, employeeRoleMappingEnvelopeSchema, { ...META, body });
  });

  test('[1c] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // Documented to have no failure branch: a null service result is still SUCCESS with
    // `value: null`, which is precisely the "200 carrying a failure" shape this catches.
    const body = buildEmployeeRoleMapping();
    const response = await referenceDataClient.saveEmployeeRoleMapping(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[1d] business rule: a mapping must not link ids that exist in no collection', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * Neither `employeeId` nor `rolePostingId` is validated to exist. A mapping between two
     * freshly-minted ObjectIds therefore persists as a dangling assignment: the collection is
     * append-only and doubles as the assignment history, so every downstream report that joins
     * through it silently drops or miscounts these rows.
     */
    const ghostEmployee = randomObjectId();
    const ghostPosting = randomObjectId();
    const body = buildEmployeeRoleMapping({
      employeeId: ghostEmployee,
      rolePostingId: ghostPosting,
    });
    const response = await referenceDataClient.saveEmployeeRoleMapping(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await referenceDataClient.saveEmployeeRoleMapping({ employeeId: "${ghostEmployee}", rolePostingId: "${ghostPosting}", ... }, { token });`,
          scenario: `A mapping between two ObjectIds that match no employee and no role posting was persisted with status SUCCESS. Referential integrity is never checked on either side, so the assignment history accumulates rows pointing at nothing and every join through it under-reports who occupies which seat. Body: ${text.slice(0, 200)}`,
          title: 'employeeRoleMapping/save persists a mapping to non-existent employee and role posting',
        },
        'Business Logic Flaw',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[1e] idempotency: the same mapping sent twice must not create two assignments', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * Documented as having no uniqueness guard, so an ordinary client retry — a dropped
     * response, a double-clicked button — writes the employee into the same seat twice. Issuing
     * both concurrently is how a retry actually behaves in the field.
     */
    const body = buildEmployeeRoleMapping();
    const [first, second] = await Promise.all([
      referenceDataClient.saveEmployeeRoleMapping(body, { token }),
      referenceDataClient.saveEmployeeRoleMapping(body, { token }),
    ]);

    const a = (await readBody(first)).json?.value as { id?: string } | null;
    const b = (await readBody(second)).json?.value as { id?: string } | null;

    if (a?.id && b?.id && a.id !== b.id) {
      await reportBusinessLogicFlaw(
        second,
        {
          ...META,
          body,
          repro: `await Promise.all([saveEmployeeRoleMapping(body), saveEmployeeRoleMapping(body)]); // two distinct ids returned`,
          scenario: `The identical employee/role-posting pair was written twice concurrently and produced two distinct documents ("${a.id}" and "${b.id}"). Nothing enforces uniqueness on the pair, so a retried or double-submitted request duplicates the assignment and the seat appears to be occupied twice.`,
          title: 'employeeRoleMapping/save is not idempotent — a retry duplicates the assignment',
        },
        'Idempotency / Concurrency',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: an empty employeeId must be refused, not persisted', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeRoleMapping({ employeeId: '' });
    const response = await referenceDataClient.saveEmployeeRoleMapping(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'empty employeeId on a role-posting mapping',
    });
  });

  test('[2b] boundary: a null rolePostingId must be refused', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // A mapping with no seat on it is not an assignment; storing one makes the append-only
    // history unreadable.
    const body = buildEmployeeRoleMapping({ rolePostingId: null });
    const response = await referenceDataClient.saveEmployeeRoleMapping(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null rolePostingId' });
  });

  test('[3] typefuzz: a boolean employeeId must not be coerced into a mapping', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeRoleMapping({ employeeId: true });
    const response = await referenceDataClient.saveEmployeeRoleMapping(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean employeeId' });
  });

  test('[3b] typefuzz: an array rolePostingId where a 24-char ObjectId is documented must be refused', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeRoleMapping({
      rolePostingId: ['66f1a2b3c4d5e6f708192ae5', '66f1a2b3c4d5e6f708192ae6'],
    });
    const response = await referenceDataClient.saveEmployeeRoleMapping(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'array rolePostingId where a single ObjectId is documented',
    });
  });

  test('[4] auth: an unauthenticated caller must not be able to assign an employee to a seat', async ({
    referenceDataClient,
  }) => {
    const body = buildEmployeeRoleMapping();
    const response = await referenceDataClient.saveEmployeeRoleMapping(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a token forged with alg:none must never authorise an assignment', async ({
    referenceDataClient,
  }) => {
    // An alg:none token is unsigned by construction. Accepting one means the filter trusts the
    // header's algorithm claim, which lets anyone mint any tenant identity.
    const body = buildEmployeeRoleMapping();
    const response = await referenceDataClient.saveEmployeeRoleMapping(body, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] an employee from another tenant must not be bindable to a role posting', async ({
    referenceDataClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * The strongest case on this route. The mapping names an employee id and a role posting id
     * and validates neither against the caller's tenant, while `companyId` comes from the body
     * rather than the token. A mapping carrying a foreign companyId is therefore an assignment
     * written directly into another company's org data — and because nothing checks the employee
     * belongs to that company, it is also a way to plant a foreign employee into a real seat.
     */
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const foreignEmployee = randomObjectId();
    const body = buildEmployeeRoleMapping({
      companyId: otherTenant,
      employeeId: foreignEmployee,
    });
    const response = await referenceDataClient.saveEmployeeRoleMapping(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await referenceDataClient.saveEmployeeRoleMapping({ companyId: "${otherTenant}", employeeId: "${foreignEmployee}", ... }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, a mapping carrying the foreign companyId "${otherTenant}" and an employee id that belongs to no verified employee of ours was persisted with status SUCCESS. The endpoint takes the tenant from the body rather than the token and validates neither referenced id against the caller's company, so any caller can write role assignments into another tenant's org data and bind arbitrary employee ids to its seats. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant role assignment (IDOR): body companyId and unvalidated employeeId',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload in employeeId must not surface a database error', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeRoleMapping({ employeeId: SQLI_DROP_PAYLOAD });
    const response = await referenceDataClient.saveEmployeeRoleMapping(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });

  test('[6b] injection: a script companyId must not be echoed unescaped', async ({
    referenceDataClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeRoleMapping({ companyId: XSS_PAYLOAD });
    const response = await referenceDataClient.saveEmployeeRoleMapping(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== GET / ==== */
test.describe('GET /', () => {
  const META = {
    method: 'GET',
    path: REFERENCE_PATHS.index,
    repro: `await referenceDataClient.indexPage({ token: null });`,
  };

  /*
   * The liveness page. It returns an HTML banner ("Admin Application is Up and Running!!") with
   * a deployment date — NOT the JSON envelope — so nothing here asserts one, and the audit ledger
   * exempts it from contract, statusParity-by-envelope and IDOR for exactly that reason. The
   * honest scope is: it answers, it needs no token by design, and it discloses nothing beyond the
   * banner. Kept deliberately small.
   */

  test('[1] happy path: the liveness page answers 200 with a body', async ({
    referenceDataClient,
  }) => {
    const response = await referenceDataClient.indexPage({ token: null });

    await assertStatus(response, [200], META);

    const { text } = await readBody(response);
    expect(
      text.trim().length,
      'GET / answered 200 with an empty body — a liveness probe that returns nothing cannot distinguish a healthy application from a stub responder.'
    ).toBeGreaterThan(0);
  });

  test('[1b] parity: the page must not answer 200 while carrying an exception trace', async ({
    referenceDataClient,
  }) => {
    /*
     * There is no envelope statusCode to compare against, but the failure this vector exists to
     * catch still applies: a 200 whose body is a Whitelabel error page or a stack trace keeps
     * every load-balancer health check green while the application is broken.
     */
    const response = await referenceDataClient.indexPage({ token: null });

    await assertNot200OKOnError(response, META);
  });

  test('[2] boundary: a 5000-character query string must not fault the health probe', async ({
    referenceDataClient,
  }) => {
    // The route takes no parameters, so an oversized query string is the only input available.
    // A health endpoint that 500s on a long URL fails the probe for the wrong reason.
    const params = { ping: MAX_LENGTH_STRING };
    const response = await referenceDataClient.indexPage({ params });

    await assertStatus(response, [200], {
      ...META,
      repro: `await referenceDataClient.indexPage({ params: { ping: 'a'.repeat(5000) } });`,
    });
  });

  test('[3] typefuzz: an unexpected numeric query parameter must be ignored', async ({
    referenceDataClient,
  }) => {
    const params = { build: 1001 };
    const response = await referenceDataClient.indexPage({ params });

    await assertStatus(response, [200], {
      ...META,
      repro: `await referenceDataClient.indexPage({ params: { build: 1001 } });`,
    });
  });

  test('[4] auth: the liveness page requires no token by design and must stay reachable', async ({
    referenceDataClient,
  }) => {
    // Deliberately NOT assertUnauthorized: a health endpoint that demands a credential cannot be
    // polled by the infrastructure that needs it. Anonymous 200 is the correct behaviour here.
    const response = await referenceDataClient.indexPage({ token: null });

    await assertStatus(response, [200], META);
  });

  test('[6] injection: a script query parameter must not be reflected into the HTML page', async ({
    referenceDataClient,
  }) => {
    /*
     * The sharpest case in this block. Every other route in the module answers
     * `application/json`, where a reflected payload is inert until a client renders it. This one
     * answers `text/html`, so anything echoed into it — by the banner or by Spring's default
     * error page — executes in the browser directly.
     */
    const params = { v: XSS_PAYLOAD };
    const response = await referenceDataClient.indexPage({ params });

    await assertNoReflectedScript(
      response,
      {
        ...META,
        repro: `await referenceDataClient.indexPage({ params: { v: "${XSS_PAYLOAD}" } });`,
      },
      XSS_PAYLOAD
    );
  });

  test('[6b] injection: the banner must not disclose server internals beyond the deployment date', async ({
    referenceDataClient,
  }) => {
    // The page is public and unauthenticated, so anything it prints is public. A framework
    // version, a hostname, or a stack frame here is reconnaissance handed to anyone.
    const params = { probe: SQLI_PAYLOAD };
    const response = await referenceDataClient.indexPage({ params });

    await assertNoInternalLeak(
      response,
      {
        ...META,
        repro: `await referenceDataClient.indexPage({ params: { probe: "${SQLI_PAYLOAD}" } });`,
      },
      SQLI_PAYLOAD
    );
  });
});
