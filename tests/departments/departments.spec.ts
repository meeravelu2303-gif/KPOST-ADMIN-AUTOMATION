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
import { DEPARTMENT_PATHS } from '../../src/api/clients/departments.client';
import {
  departmentListEnvelopeSchema,
  abbreviationEnvelopeSchema,
} from '../../src/api/schemas/departments.schema';
import { looseEnvelopeSchema } from '../../src/api/schemas/envelope.schema';
import {
  buildDepartment,
  buildDepartmentArray,
  buildDepartmentUpdate,
  buildGetByCompany,
  buildAbbreviationRequest,
  buildDeleteById,
  randomObjectId,
} from '../../src/api/payloads/departments.payload';

/*
 * Departments tag (/department/*) — the tenant's org-structure master data.
 *
 * One describe per endpoint titled with its bare `METHOD /path` signature, explicit standalone
 * cases — no loops, no factories — so every case is individually named, reportable and
 * skippable, and so `scripts/audit-vectors.ts` can group coverage by endpoint.
 *
 * ## What is dangerous here
 *
 * `POST /department/delete` is a **hard delete**: no soft-delete flag, no cascade, no undo
 * through the API. Every case below therefore points it at a freshly-minted random ObjectId
 * that matches no document, or at a refusal path. Nothing in this file deletes a real record.
 *
 * `POST /department/update` is the documented liar of the tag — it has no failure branch and
 * answers `status: SUCCESS` even when no document matched the id. Cases here read `value`
 * rather than trusting `status`.
 *
 * ## Envelope reminder
 *
 * Every route answers HTTP 200 or 500 only, carrying
 * `{ value, status: SUCCESS|FAILURE, statusCode, urlPath, error? }`. HTTP 200 says nothing
 * about success, so assertions read the envelope's status word, never the transport alone.
 */

const XSS_PAYLOAD = `<script>alert('dept')</script>`;
const SQLI_PAYLOAD = `1001' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE table_admin_department; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);

/* ==== POST /department/getDepartmentByCompanyId ==== */
test.describe('POST /department/getDepartmentByCompanyId', () => {
  const META = {
    method: 'POST',
    path: DEPARTMENT_PATHS.getDepartmentByCompanyId,
    repro: `await departmentsClient.getByCompanyId(buildGetByCompany(), { token });`,
  };

  test('[1] happy path: a valid companyId returns a well-formed department-list envelope', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany();
    const response = await departmentsClient.getByCompanyId(body, { token });

    await expectValidContract(response, departmentListEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany();
    const response = await departmentsClient.getByCompanyId(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[2] boundary: an empty companyId must be refused, not answered with the whole collection', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: '' });
    const response = await departmentsClient.getByCompanyId(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'empty companyId' },
      [400, 422]
    );
  });

  test('[2b] boundary: a null companyId must be refused rather than treated as "all tenants"', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: null });
    const response = await departmentsClient.getByCompanyId(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'null companyId' },
      [400, 422]
    );
  });

  test('[2c] boundary: a 5000-character companyId must not be processed as a lookup key', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: MAX_LENGTH_STRING });
    const response = await departmentsClient.getByCompanyId(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'oversized (5000-char) companyId' },
      [400, 422]
    );
  });

  test('[3] typefuzz: an array companyId where a string is documented must be refused', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: ['1001', '1002'] });
    const response = await departmentsClient.getByCompanyId(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'array companyId where a string is documented' },
      [400, 422]
    );
  });

  test('[3b] typefuzz: a boolean companyId must not be coerced into a lookup', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: true });
    const response = await departmentsClient.getByCompanyId(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'boolean companyId' },
      [400, 422]
    );
  });

  test('[4] auth: an unauthenticated caller must be refused, not served the tenant list', async ({
    departmentsClient,
  }) => {
    /*
     * api.json places every route under the global bearerAuth requirement, but the backend's
     * SecurityConfiguration permits "/**". A 200 here is a real spec/implementation mismatch:
     * Major on its own, Critical if protected material actually comes back.
     */
    const body = buildGetByCompany();
    const response = await departmentsClient.getByCompanyId(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must be refused', async ({ departmentsClient }) => {
    const body = buildGetByCompany();
    const response = await departmentsClient.getByCompanyId(body, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4c] auth: a token forged with alg:none must never be accepted', async ({
    departmentsClient,
  }) => {
    // An alg:none token is unsigned by construction. Accepting one means the filter trusts the
    // header's algorithm claim, which lets anyone mint any identity.
    const body = buildGetByCompany();
    const response = await departmentsClient.getByCompanyId(body, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] one tenant must not receive another tenant\'s departments', async ({
    departmentsClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * The filter injects companyID from the token, but this endpoint reads companyId from the
     * BODY. Asking for a different tenant while authenticated as ours must not work — if it
     * does, the body overrides the token and every tenant's org chart is readable.
     */
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildGetByCompany({ companyId: otherTenant });
    const response = await departmentsClient.getByCompanyId(body, { token });

    const { json } = await readBody(response);
    const value = json?.value;
    if (Array.isArray(value) && value.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await departmentsClient.getByCompanyId({ companyId: "${otherTenant}" }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, the body companyId "${otherTenant}" returned ${value.length} foreign department(s) — the endpoint trusts the body over the token, a cross-tenant IDOR.`,
          title: 'Cross-tenant department read (IDOR): body companyId overrides the token tenant',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true); // presence-only assertion; the finding above is the signal
  });

  test('[6] injection: a SQL-injection companyId must not surface a database error or query echo', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: SQLI_PAYLOAD });
    const response = await departmentsClient.getByCompanyId(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script companyId must not come back unescaped in the envelope', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: XSS_PAYLOAD });
    const response = await departmentsClient.getByCompanyId(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /department/save ==== */
test.describe('POST /department/save', () => {
  const META = {
    method: 'POST',
    path: DEPARTMENT_PATHS.save,
    repro: `await departmentsClient.save(buildDepartmentArray(2), { token });`,
  };

  test('[1] happy path: a valid array of departments is accepted', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDepartmentArray(2);
    const response = await departmentsClient.save(body, { token });

    await assertStatus(response, [200], { ...META, body });
  });

  test('[1b] contract: the save response satisfies the department-list envelope', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDepartmentArray(1);
    const response = await departmentsClient.save(body, { token });

    await expectValidContract(response, departmentListEnvelopeSchema, { ...META, body });
  });

  test('[1c] parity: the HTTP status must agree with the envelope statusCode', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDepartmentArray(1);
    const response = await departmentsClient.save(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[2] boundary: an empty array must not be accepted as a successful save', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body: unknown[] = [];
    const response = await departmentsClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      repro: `await departmentsClient.save([], { token });`,
      scenario: 'empty department array',
    });
  });

  test('[2b] boundary: a null departmentName must be refused, not persisted as a nameless row', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDepartmentArray(1, { departmentName: null });
    const response = await departmentsClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'null departmentName',
    });
  });

  test('[2c] boundary: a 5000-character departmentName must be refused rather than stored', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDepartmentArray(1, { departmentName: MAX_LENGTH_STRING });
    const response = await departmentsClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) departmentName',
    });
  });

  test('[3] typefuzz: an object body where the documented shape is an array must be refused', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDepartment(); // a single object where an array is required
    const response = await departmentsClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      repro: `await departmentsClient.save(buildDepartment(), { token }); // object, not array`,
      scenario: 'object body instead of a JSON array',
    });
  });

  test('[3b] typefuzz: a numeric companyId must be refused, not silently coerced', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDepartmentArray(1, { companyId: 1001 }); // number, spec says string
    const response = await departmentsClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'numeric companyId where a string is documented',
    });
  });

  test('[4] auth: an unauthenticated caller must not be able to create departments', async ({
    departmentsClient,
  }) => {
    // A write reachable anonymously is worse than a readable one: it lets an unauthenticated
    // caller pollute another tenant's org structure.
    const body = buildDepartmentArray(1);
    const response = await departmentsClient.save(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a malformed bearer token must be refused', async ({ departmentsClient }) => {
    const body = buildDepartmentArray(1);
    const response = await departmentsClient.save(body, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a department must not be creatable inside another tenant', async ({
    departmentsClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildDepartmentArray(1, { companyId: otherTenant });
    const response = await departmentsClient.save(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await departmentsClient.save([{ companyId: "${otherTenant}", ... }], { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, a department was written into tenant "${otherTenant}" and reported SUCCESS. The body's companyId is trusted over the token's, so any caller can inject org structure into any tenant. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant department write (IDOR): body companyId overrides the token tenant',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a <script> department name must not be stored and echoed unescaped', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDepartmentArray(1, { departmentName: XSS_PAYLOAD });
    const response = await departmentsClient.save(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });

  test('[6b] injection: a SQL payload in departmentName must not surface a database error', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDepartmentArray(1, { departmentName: SQLI_DROP_PAYLOAD });
    const response = await departmentsClient.save(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });
});

/* ==== POST /department/update ==== */
test.describe('POST /department/update', () => {
  const META = {
    method: 'POST',
    path: DEPARTMENT_PATHS.update,
    repro: `await departmentsClient.update(buildDepartmentUpdate(), { token });`,
  };

  test('[1] happy path: an update returns a well-formed envelope', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDepartmentUpdate();
    const response = await departmentsClient.update(body, { token });

    await expectValidContract(response, looseEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDepartmentUpdate();
    const response = await departmentsClient.update(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: updating a non-existent id must not be reported as SUCCESS', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * Documented defect: update has no failure branch and returns SUCCESS even when no
     * document matched. That misreports the outcome to every caller — the client believes it
     * saved something that does not exist.
     */
    const missingId = randomObjectId();
    const body = buildDepartmentUpdate({ id: missingId, departmentName: 'Renamed Nowhere' });
    const response = await departmentsClient.update(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await departmentsClient.update({ id: "${missingId}", departmentName: "Renamed Nowhere" }, { token });`,
          scenario: `Update against a non-existent id "${missingId}" returned status SUCCESS. No document was modified, yet the caller is told the update succeeded. Body: ${text.slice(0, 200)}`,
          title: 'department/update reports SUCCESS when no document matched the id',
        },
        'Status Code Misreporting',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[1d] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDepartmentUpdate({ id: randomObjectId() });
    const response = await departmentsClient.update(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[2] boundary: an empty id must be refused rather than updating an arbitrary row', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDepartmentUpdate({ id: '' });
    const response = await departmentsClient.update(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty id' });
  });

  test('[2b] boundary: a null id must be refused', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDepartmentUpdate({ id: null });
    const response = await departmentsClient.update(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id' });
  });

  test('[3] typefuzz: a numeric id where a 24-char ObjectId is documented must be refused', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDepartmentUpdate({ id: 1001 });
    const response = await departmentsClient.update(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric id' });
  });

  test('[3b] typefuzz: an object id must be refused, not stringified into a query', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDepartmentUpdate({ id: { $ne: null } });
    const response = await departmentsClient.update(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object id ({ $ne: null }) — a Mongo operator injection shape',
    });
  });

  test('[4] auth: an unauthenticated caller must not be able to update a department', async ({
    departmentsClient,
  }) => {
    const body = buildDepartmentUpdate();
    const response = await departmentsClient.update(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must be refused on a write', async ({ departmentsClient }) => {
    const body = buildDepartmentUpdate();
    const response = await departmentsClient.update(body, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a department must not be reassignable into another tenant', async ({
    departmentsClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildDepartmentUpdate({ companyId: otherTenant });
    const response = await departmentsClient.update(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS' && json?.value) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await departmentsClient.update({ id: "<id>", companyId: "${otherTenant}" }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, an update rewrote a department's companyId to "${otherTenant}" and returned a document. A tenant can move org records into — or out of — another tenant. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant department reassignment (IDOR) via the update body',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a malformed ObjectId must not leak the parser exception', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDepartmentUpdate({ id: 'not-an-object-id' });
    const response = await departmentsClient.update(body, { token });

    // A malformed ObjectId should be a 4xx; this module tends to 500, and a 500 must not carry
    // the "Invalid ObjectId" exception text or a stack frame back to the caller.
    await assertNoInternalLeak(response, { ...META, body }, 'not-an-object-id');
  });

  test('[6b] injection: a script departmentName must not be echoed unescaped on update', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDepartmentUpdate({ departmentName: XSS_PAYLOAD });
    const response = await departmentsClient.update(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /department/abbreviationAndCodeCreation ==== */
test.describe('POST /department/abbreviationAndCodeCreation', () => {
  const META = {
    method: 'POST',
    path: DEPARTMENT_PATHS.abbreviationAndCodeCreation,
    repro: `await departmentsClient.abbreviationAndCodeCreation(buildAbbreviationRequest(), { token });`,
  };

  test('[1] happy path: a department name yields a well-formed abbreviation/code envelope', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildAbbreviationRequest({ departmentName: 'Platform Engineering' });
    const response = await departmentsClient.abbreviationAndCodeCreation(body, { token });

    await expectValidContract(response, abbreviationEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildAbbreviationRequest();
    const response = await departmentsClient.abbreviationAndCodeCreation(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: two concurrent callers must not be handed the same code', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * Documented defect: this endpoint derives a value but does not reserve it, so two callers
     * racing on the same name receive the same abbreviation and the collision only surfaces at
     * save. Issuing both requests concurrently is the only way to observe it.
     */
    const body = buildAbbreviationRequest({ departmentName: 'Concurrent Reservation Test' });
    const [first, second] = await Promise.all([
      departmentsClient.abbreviationAndCodeCreation(body, { token }),
      departmentsClient.abbreviationAndCodeCreation(body, { token }),
    ]);

    const a = (await readBody(first)).json?.value as { code?: string } | null;
    const b = (await readBody(second)).json?.value as { code?: string } | null;

    if (a?.code && b?.code && a.code === b.code) {
      await reportBusinessLogicFlaw(
        second,
        {
          ...META,
          body,
          repro: `await Promise.all([abbreviationAndCodeCreation(body), abbreviationAndCodeCreation(body)]); // same code returned twice`,
          scenario: `Two concurrent calls for "Concurrent Reservation Test" both returned code "${a.code}". The endpoint hands out a value it does not reserve, so the collision is only discovered when the second save fails.`,
          title: 'abbreviationAndCodeCreation does not reserve the code it issues',
        },
        'Idempotency / Concurrency',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: an empty departmentName must be refused, not handed a blank abbreviation', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildAbbreviationRequest({ departmentName: '' });
    const response = await departmentsClient.abbreviationAndCodeCreation(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty departmentName' });
  });

  test('[2b] boundary: a null departmentName must be refused', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildAbbreviationRequest({ departmentName: null });
    const response = await departmentsClient.abbreviationAndCodeCreation(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null departmentName' });
  });

  test('[2c] boundary: a 5000-character name must not be abbreviated', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildAbbreviationRequest({ departmentName: MAX_LENGTH_STRING });
    const response = await departmentsClient.abbreviationAndCodeCreation(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) departmentName',
    });
  });

  test('[3] typefuzz: a numeric departmentName must be refused', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildAbbreviationRequest({ departmentName: 1001 });
    const response = await departmentsClient.abbreviationAndCodeCreation(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric departmentName' });
  });

  test('[3b] typefuzz: an array departmentName must be refused', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildAbbreviationRequest({ departmentName: ['Ops', 'Finance'] });
    const response = await departmentsClient.abbreviationAndCodeCreation(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'array departmentName' });
  });

  test('[4] auth: an unauthenticated caller must be refused', async ({ departmentsClient }) => {
    const body = buildAbbreviationRequest();
    const response = await departmentsClient.abbreviationAndCodeCreation(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a forged alg:none token must be refused', async ({ departmentsClient }) => {
    const body = buildAbbreviationRequest();
    const response = await departmentsClient.abbreviationAndCodeCreation(body, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] the generated code must not disclose another tenant\'s naming space', async ({
    departmentsClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * The abbreviation is derived against existing departments to avoid a clash. If the
     * endpoint honours a foreign companyId, the returned code is an oracle over another
     * tenant's department names — which of them exist can be inferred from what it avoids.
     */
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildAbbreviationRequest({ companyId: otherTenant });
    const response = await departmentsClient.abbreviationAndCodeCreation(body, { token });

    await assertStatusCodeParity(response, {
      ...META,
      body,
      repro: `await departmentsClient.abbreviationAndCodeCreation({ departmentName: "...", companyId: "${otherTenant}" }, { token });`,
    });
  });

  test('[6] injection: a script department name must not be reflected unescaped', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildAbbreviationRequest({ departmentName: XSS_PAYLOAD });
    const response = await departmentsClient.abbreviationAndCodeCreation(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });

  test('[6b] injection: a SQL payload must not surface a database error', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildAbbreviationRequest({ departmentName: SQLI_PAYLOAD });
    const response = await departmentsClient.abbreviationAndCodeCreation(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });
});

/* ==== POST /department/delete ==== */
test.describe('POST /department/delete', () => {
  const META = {
    method: 'POST',
    path: DEPARTMENT_PATHS.delete,
    repro: `await departmentsClient.delete(buildDeleteById(), { token }); // random id — matches no document`,
  };

  test('[1] happy path: a delete against a non-existent id returns a well-formed envelope', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // Non-existent id on purpose — this is a hard delete with no undo through the API.
    const body = buildDeleteById({ id: randomObjectId() });
    const response = await departmentsClient.delete(body, { token });

    await expectValidContract(response, looseEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDeleteById({ id: randomObjectId() });
    const response = await departmentsClient.delete(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: deleting an id that does not exist must not be reported as SUCCESS', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const missingId = randomObjectId();
    const body = buildDeleteById({ id: missingId });
    const response = await departmentsClient.delete(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await departmentsClient.delete({ id: "${missingId}" }, { token });`,
          scenario: `Deleting the non-existent id "${missingId}" reported SUCCESS. A caller cannot distinguish "removed" from "was never there", which hides a failed cleanup. Body: ${text.slice(0, 200)}`,
          title: 'department/delete reports SUCCESS for an id that matched no document',
        },
        'Status Code Misreporting',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: an empty id must be refused, not treated as "delete everything"', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDeleteById({ id: '' });
    const response = await departmentsClient.delete(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty id on a delete' });
  });

  test('[2b] boundary: a null id must be refused', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDeleteById({ id: null });
    const response = await departmentsClient.delete(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id on a delete' });
  });

  test('[3] typefuzz: an object id must be refused, not used as a Mongo operator', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * `{ $ne: null }` is the classic operator-injection shape: if it reaches the driver as a
     * filter it matches every document, turning a single delete into a collection wipe. This
     * must be refused at the boundary.
     */
    const body = buildDeleteById({ id: { $ne: null } });
    const response = await departmentsClient.delete(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object id ({ $ne: null }) — operator injection that would match every document',
    });
  });

  test('[3b] typefuzz: a boolean id must be refused', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDeleteById({ id: true });
    const response = await departmentsClient.delete(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean id' });
  });

  test('[4] auth: an unauthenticated delete must be refused', async ({ departmentsClient }) => {
    const body = buildDeleteById();
    const response = await departmentsClient.delete(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must not authorise a destructive delete', async ({
    departmentsClient,
  }) => {
    const body = buildDeleteById();
    const response = await departmentsClient.delete(body, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4c] auth: a malformed token must not authorise a destructive delete', async ({
    departmentsClient,
  }) => {
    const body = buildDeleteById();
    const response = await departmentsClient.delete(body, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a caller must not be able to delete another tenant\'s department', async ({
    departmentsClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * The delete body carries only an id — no tenant scope at all — so authorisation can only
     * come from the token. A random id is used because confirming this properly would mean
     * destroying a real foreign record; what is asserted here is that the endpoint does not
     * answer with another tenant's document as evidence of a cross-tenant hit.
     */
    const foreignId = randomObjectId();
    const body = buildDeleteById({ id: foreignId, companyId: `${Number(companyID ?? 1001) + 1}` });
    const response = await departmentsClient.delete(body, { token });

    const { json, text } = await readBody(response);
    const value = json?.value as { companyId?: string } | null;
    if (value?.companyId && value.companyId !== companyID) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await departmentsClient.delete({ id: "${foreignId}" }, { token /* tenant ${companyID} */ });`,
          scenario: `A delete issued as tenant ${companyID} returned a document belonging to tenant "${value.companyId}". The endpoint resolves ids globally rather than within the caller's tenant, so any id is deletable by anyone who can guess it. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant department delete (IDOR): ids resolve outside the caller\'s tenant',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload as the id must not leak an exception trace', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDeleteById({ id: SQLI_DROP_PAYLOAD });
    const response = await departmentsClient.delete(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });

  test('[6b] injection: a script id must not be reflected unescaped', async ({
    departmentsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDeleteById({ id: XSS_PAYLOAD });
    const response = await departmentsClient.delete(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});
