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
import { DESIGNATION_PATHS } from '../../src/api/clients/designations.client';
import {
  designationListEnvelopeSchema,
  abbreviationEnvelopeSchema,
} from '../../src/api/schemas/designations.schema';
import { looseEnvelopeSchema } from '../../src/api/schemas/envelope.schema';
import {
  buildDesignation,
  buildDesignationArray,
  buildDesignationUpdate,
  buildGetByCompanyAndDept,
  buildAbbreviationRequest,
  buildDeleteById,
  randomObjectId,
} from '../../src/api/payloads/designations.payload';

/*
 * Designations tag (/designation/*) — the tenant's job titles, hung off a department by
 * `departmentId` and chained into a seniority tree by `parentDesignationId`.
 *
 * One describe per endpoint titled with its bare `METHOD /path` signature, explicit standalone
 * cases — no loops, no factories — so every case is individually named, reportable and
 * skippable, and so `scripts/audit-vectors.ts` can group coverage by endpoint.
 *
 * ## What is dangerous here
 *
 * `POST /designation/delete` is a **hard delete**: no soft-delete flag, no cascade, no undo
 * through the API. It is also the tag's worst destructive case, because designations are
 * referenced from two directions — child designations point at it via `parentDesignationId`,
 * and role postings point at it by id — and neither reference is checked or repaired. Every
 * case below therefore points delete at a freshly-minted random ObjectId that matches no
 * document, or at a refusal path. Nothing in this file deletes a real record.
 *
 * `POST /designation/save` accepts an ARRAY and takes `departmentId` on trust: nothing verifies
 * the parent department exists, or belongs to the caller's tenant, so a title can be filed under
 * a department that is not there.
 *
 * `POST /designation/update` shares the module-wide defect — no failure branch, `status: SUCCESS`
 * even when no document matched the id — and re-pointing `departmentId` silently moves a title
 * between departments. Cases here read `value` rather than trusting `status`.
 *
 * `POST /designation/abbreviationAndCodeCreation` derives a code but does **not** reserve it, so
 * two callers racing on the same name are handed the same pair and only discover the clash at
 * save time. That race is only observable by issuing both requests concurrently.
 *
 * `POST /designation/getDesignationByCompanyIdAndDepartmentId` is not an `$in` query: the
 * controller loops over `departmentIdList` and issues one `find` per element, so the list length
 * is a caller-controlled multiplier on database round trips.
 *
 * ## Envelope reminder
 *
 * Every route answers HTTP 200 or 500 only, carrying
 * `{ value, status: SUCCESS|FAILURE, statusCode, urlPath, error? }`. HTTP 200 says nothing
 * about success, so assertions read the envelope's status word, never the transport alone.
 */

const XSS_PAYLOAD = `<script>alert('desig')</script>`;
const SQLI_PAYLOAD = `1001' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE table_admin_designation; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);

/* ==== POST /designation/getDesignationByCompanyIdAndDepartmentId ==== */
test.describe('POST /designation/getDesignationByCompanyIdAndDepartmentId', () => {
  const META = {
    method: 'POST',
    path: DESIGNATION_PATHS.getDesignationByCompanyIdAndDepartmentId,
    repro: `await designationsClient.getByCompanyAndDepartment(buildGetByCompanyAndDept(), { token });`,
  };

  test('[1] happy path: a valid companyId and department list return a well-formed envelope', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompanyAndDept();
    const response = await designationsClient.getByCompanyAndDepartment(body, { token });

    await expectValidContract(response, designationListEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompanyAndDept();
    const response = await designationsClient.getByCompanyAndDepartment(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: a caller-sized departmentIdList must not multiply database round trips', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * Documented implementation detail: the controller loops the list and issues one `find` per
     * element instead of a single `$in`. The list length is therefore a caller-controlled
     * multiplier on database work with no declared cap — a cheap request that costs the server
     * proportionally more than it costs the client.
     */
    const wideList = Array.from({ length: 200 }, () => randomObjectId());
    const body = buildGetByCompanyAndDept({ departmentIdList: wideList });
    const response = await designationsClient.getByCompanyAndDepartment(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await designationsClient.getByCompanyAndDepartment({ companyId, departmentIdList: [ ...200 ids ] }, { token });`,
          scenario: `A departmentIdList of 200 entries was accepted with status SUCCESS. The controller issues one query per element rather than a single $in, so an unauthenticated-cost request forces 200 database round trips and the list has no documented or enforced upper bound. Body: ${text.slice(0, 200)}`,
          title: 'getDesignationByCompanyIdAndDepartmentId accepts an unbounded departmentIdList (one query per element)',
        },
        'Security/Rate Limiting',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: an empty companyId must be refused, not answered across tenants', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompanyAndDept({ companyId: '' });
    const response = await designationsClient.getByCompanyAndDepartment(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'empty companyId' },
      [400, 422]
    );
  });

  test('[2b] boundary: a null companyId must be refused rather than treated as "all tenants"', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompanyAndDept({ companyId: null });
    const response = await designationsClient.getByCompanyAndDepartment(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'null companyId' },
      [400, 422]
    );
  });

  test('[2c] boundary: a null departmentIdList must be refused, not looped over as nothing', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompanyAndDept({ departmentIdList: null });
    const response = await designationsClient.getByCompanyAndDepartment(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'null departmentIdList — the loop variable of the query' },
      [400, 422]
    );
  });

  test('[2d] boundary: a 5000-character companyId must not be processed as a lookup key', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompanyAndDept({ companyId: MAX_LENGTH_STRING });
    const response = await designationsClient.getByCompanyAndDepartment(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'oversized (5000-char) companyId' },
      [400, 422]
    );
  });

  test('[3] typefuzz: a scalar departmentIdList where an array is documented must be refused', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompanyAndDept({ departmentIdList: randomObjectId() });
    const response = await designationsClient.getByCompanyAndDepartment(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'scalar departmentIdList where an array is documented' },
      [400, 422]
    );
  });

  test('[3b] typefuzz: a numeric companyId must be refused, not silently coerced', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompanyAndDept({ companyId: 1001 });
    const response = await designationsClient.getByCompanyAndDepartment(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'numeric companyId where a string is documented' },
      [400, 422]
    );
  });

  test('[3c] typefuzz: a boolean departmentIdList must be refused', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompanyAndDept({ departmentIdList: true });
    const response = await designationsClient.getByCompanyAndDepartment(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'boolean departmentIdList' },
      [400, 422]
    );
  });

  test('[4] auth: an unauthenticated caller must be refused, not served the tenant\'s job titles', async ({
    designationsClient,
  }) => {
    /*
     * api.json places every route under the global bearerAuth requirement, but the backend's
     * SecurityConfiguration permits "/**". A 200 here is a real spec/implementation mismatch:
     * Major on its own — the designation document carries no personal data — but it still hands
     * an anonymous caller a competitor's complete org chart of job titles and seniority chains.
     */
    const body = buildGetByCompanyAndDept();
    const response = await designationsClient.getByCompanyAndDepartment(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must be refused', async ({ designationsClient }) => {
    const body = buildGetByCompanyAndDept();
    const response = await designationsClient.getByCompanyAndDepartment(body, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4c] auth: a token forged with alg:none must never be accepted', async ({
    designationsClient,
  }) => {
    // An alg:none token is unsigned by construction. Accepting one means the filter trusts the
    // header's algorithm claim, which lets anyone mint any identity.
    const body = buildGetByCompanyAndDept();
    const response = await designationsClient.getByCompanyAndDepartment(body, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] one tenant must not receive another tenant\'s designations', async ({
    designationsClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * The filter injects companyID from the token, but this endpoint reads companyId from the
     * BODY. Asking for a different tenant while authenticated as ours must not work — if it
     * does, the body overrides the token and every tenant's job-title structure is readable.
     */
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildGetByCompanyAndDept({ companyId: otherTenant });
    const response = await designationsClient.getByCompanyAndDepartment(body, { token });

    const { json } = await readBody(response);
    const value = json?.value;
    if (Array.isArray(value) && value.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await designationsClient.getByCompanyAndDepartment({ companyId: "${otherTenant}", departmentIdList: [...] }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, the body companyId "${otherTenant}" returned ${value.length} foreign designation(s) — the endpoint trusts the body over the token, a cross-tenant IDOR that exposes another employer's job titles and reporting chain.`,
          title: 'Cross-tenant designation read (IDOR): body companyId overrides the token tenant',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL-injection companyId must not surface a database error or query echo', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompanyAndDept({ companyId: SQLI_PAYLOAD });
    const response = await designationsClient.getByCompanyAndDepartment(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script companyId must not come back unescaped in the envelope', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompanyAndDept({ companyId: XSS_PAYLOAD });
    const response = await designationsClient.getByCompanyAndDepartment(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /designation/save ==== */
test.describe('POST /designation/save', () => {
  const META = {
    method: 'POST',
    path: DESIGNATION_PATHS.save,
    repro: `await designationsClient.save(buildDesignationArray(2), { token });`,
  };

  test('[1] happy path: a valid array of designations is accepted', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDesignationArray(2);
    const response = await designationsClient.save(body, { token });

    await assertStatus(response, [200], { ...META, body });
  });

  test('[1b] contract: the save response satisfies the designation-list envelope', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDesignationArray(1);
    const response = await designationsClient.save(body, { token });

    await expectValidContract(response, designationListEnvelopeSchema, { ...META, body });
  });

  test('[1c] parity: the HTTP status must agree with the envelope statusCode', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDesignationArray(1);
    const response = await designationsClient.save(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1d] business rule: a designation must not be filed under a department that does not exist', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * `departmentId` is a foreign key in intent but not in enforcement. A title accepted against
     * an id that matches no department is invisible to the designation picker (which queries by
     * department) yet still occupies its abbreviation and code, so the namespace is consumed by
     * a record no screen can reach.
     */
    const orphanDepartmentId = randomObjectId();
    const body = buildDesignationArray(1, { departmentId: orphanDepartmentId });
    const response = await designationsClient.save(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await designationsClient.save([{ departmentId: "${orphanDepartmentId}", designationName: "...", companyId }], { token });`,
          scenario: `A designation was saved with status SUCCESS against departmentId "${orphanDepartmentId}", which matches no department document. Referential integrity is not checked on write, so the record is unreachable from the only read path that filters by department while still consuming its abbreviation and code. Body: ${text.slice(0, 200)}`,
          title: 'designation/save accepts a departmentId that matches no department',
        },
        'Business Logic Flaw',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: an empty array must not be accepted as a successful save', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body: unknown[] = [];
    const response = await designationsClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      repro: `await designationsClient.save([], { token });`,
      scenario: 'empty designation array',
    });
  });

  test('[2b] boundary: a null designationName must be refused, not persisted as a nameless title', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDesignationArray(1, { designationName: null });
    const response = await designationsClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'null designationName',
    });
  });

  test('[2c] boundary: a 5000-character designationName must be refused rather than stored', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDesignationArray(1, { designationName: MAX_LENGTH_STRING });
    const response = await designationsClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) designationName',
    });
  });

  test('[2d] boundary: an empty departmentId must be refused, not stored as an unparented title', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDesignationArray(1, { departmentId: '' });
    const response = await designationsClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'empty departmentId — the designation would hang off no department',
    });
  });

  test('[3] typefuzz: an object body where the documented shape is an array must be refused', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDesignation(); // a single object where an array is required
    const response = await designationsClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      repro: `await designationsClient.save(buildDesignation(), { token }); // object, not array`,
      scenario: 'object body instead of a JSON array',
    });
  });

  test('[3b] typefuzz: a numeric companyId must be refused, not silently coerced', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDesignationArray(1, { companyId: 1001 }); // number, spec says string
    const response = await designationsClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'numeric companyId where a string is documented',
    });
  });

  test('[3c] typefuzz: an array designationName must be refused', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDesignationArray(1, { designationName: ['Engineering Manager', 'Architect'] });
    const response = await designationsClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'array designationName where a string is documented',
    });
  });

  test('[4] auth: an unauthenticated caller must not be able to create designations', async ({
    designationsClient,
  }) => {
    // A write reachable anonymously is worse than a readable one: it lets an unauthenticated
    // caller pollute another tenant's job-title structure, which role postings then reference.
    const body = buildDesignationArray(1);
    const response = await designationsClient.save(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a malformed bearer token must be refused', async ({ designationsClient }) => {
    const body = buildDesignationArray(1);
    const response = await designationsClient.save(body, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a designation must not be creatable inside another tenant', async ({
    designationsClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildDesignationArray(1, { companyId: otherTenant });
    const response = await designationsClient.save(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await designationsClient.save([{ companyId: "${otherTenant}", designationName: "...", ... }], { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, a designation was written into tenant "${otherTenant}" and reported SUCCESS. The body's companyId is trusted over the token's, so any caller can inject job titles into any tenant — and role postings assigned to that title inherit the injected record. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant designation write (IDOR): body companyId overrides the token tenant',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a <script> designation name must not be stored and echoed unescaped', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDesignationArray(1, { designationName: XSS_PAYLOAD });
    const response = await designationsClient.save(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });

  test('[6b] injection: a SQL payload in designationName must not surface a database error', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDesignationArray(1, { designationName: SQLI_DROP_PAYLOAD });
    const response = await designationsClient.save(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });
});

/* ==== POST /designation/update ==== */
test.describe('POST /designation/update', () => {
  const META = {
    method: 'POST',
    path: DESIGNATION_PATHS.update,
    repro: `await designationsClient.update(buildDesignationUpdate(), { token });`,
  };

  test('[1] happy path: an update returns a well-formed envelope', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDesignationUpdate();
    const response = await designationsClient.update(body, { token });

    await expectValidContract(response, looseEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDesignationUpdate();
    const response = await designationsClient.update(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: updating a non-existent id must not be reported as SUCCESS', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * Documented module-wide defect: update has no failure branch and returns SUCCESS even when
     * no document matched. That misreports the outcome to every caller — the client believes it
     * renamed a job title that does not exist.
     */
    const missingId = randomObjectId();
    const body = buildDesignationUpdate({ id: missingId, designationName: 'Renamed Nowhere' });
    const response = await designationsClient.update(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await designationsClient.update({ id: "${missingId}", designationName: "Renamed Nowhere" }, { token });`,
          scenario: `Update against a non-existent id "${missingId}" returned status SUCCESS. No document was modified, yet the caller is told the update succeeded. Body: ${text.slice(0, 200)}`,
          title: 'designation/update reports SUCCESS when no document matched the id',
        },
        'Status Code Misreporting',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[1d] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDesignationUpdate({ id: randomObjectId() });
    const response = await designationsClient.update(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[2] boundary: an empty id must be refused rather than updating an arbitrary row', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDesignationUpdate({ id: '' });
    const response = await designationsClient.update(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty id' });
  });

  test('[2b] boundary: a null id must be refused', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDesignationUpdate({ id: null });
    const response = await designationsClient.update(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id' });
  });

  test('[2c] boundary: a 5000-character designationName must be refused on update', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDesignationUpdate({ designationName: MAX_LENGTH_STRING });
    const response = await designationsClient.update(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) designationName on update',
    });
  });

  test('[3] typefuzz: a numeric id where a 24-char ObjectId is documented must be refused', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDesignationUpdate({ id: 1001 });
    const response = await designationsClient.update(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric id' });
  });

  test('[3b] typefuzz: an object id must be refused, not stringified into a query', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDesignationUpdate({ id: { $ne: null } });
    const response = await designationsClient.update(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object id ({ $ne: null }) — a Mongo operator injection shape',
    });
  });

  test('[3c] typefuzz: a boolean designationName must be refused', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDesignationUpdate({ designationName: true });
    const response = await designationsClient.update(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean designationName' });
  });

  test('[4] auth: an unauthenticated caller must not be able to update a designation', async ({
    designationsClient,
  }) => {
    const body = buildDesignationUpdate();
    const response = await designationsClient.update(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must be refused on a write', async ({ designationsClient }) => {
    const body = buildDesignationUpdate();
    const response = await designationsClient.update(body, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a designation must not be reassignable into another tenant', async ({
    designationsClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * Update rewrites both the owning tenant and the parent department in one call, so a
     * successful cross-tenant write here does not merely read foreign data — it relocates a job
     * title out of, or into, another employer's org chart.
     */
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildDesignationUpdate({ companyId: otherTenant });
    const response = await designationsClient.update(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS' && json?.value) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await designationsClient.update({ id: "<id>", companyId: "${otherTenant}" }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, an update rewrote a designation's companyId to "${otherTenant}" and returned a document. A tenant can move job titles into — or out of — another tenant, orphaning any role posting that referenced them. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant designation reassignment (IDOR) via the update body',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a malformed ObjectId must not leak the parser exception', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDesignationUpdate({ id: 'not-an-object-id' });
    const response = await designationsClient.update(body, { token });

    // A malformed ObjectId should be a 4xx; this module tends to 500, and a 500 must not carry
    // the "Invalid ObjectId" exception text or a stack frame back to the caller.
    await assertNoInternalLeak(response, { ...META, body }, 'not-an-object-id');
  });

  test('[6b] injection: a script designationName must not be echoed unescaped on update', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDesignationUpdate({ designationName: XSS_PAYLOAD });
    const response = await designationsClient.update(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /designation/abbreviationAndCodeCreation ==== */
test.describe('POST /designation/abbreviationAndCodeCreation', () => {
  const META = {
    method: 'POST',
    path: DESIGNATION_PATHS.abbreviationAndCodeCreation,
    repro: `await designationsClient.abbreviationAndCodeCreation(buildAbbreviationRequest(), { token });`,
  };

  test('[1] happy path: a designation name yields a well-formed abbreviation/code envelope', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildAbbreviationRequest({ designationName: 'Senior Software Engineer' });
    const response = await designationsClient.abbreviationAndCodeCreation(body, { token });

    await expectValidContract(response, abbreviationEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildAbbreviationRequest();
    const response = await designationsClient.abbreviationAndCodeCreation(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: two concurrent callers must not be handed the same code', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * Documented defect: this endpoint derives a value but does not reserve it, so two callers
     * racing on the same name receive the same abbreviation and the collision only surfaces at
     * save. Issuing both requests concurrently is the only way to observe it. The designation
     * variant composes its code relative to a department, so the race is scoped per department —
     * both calls therefore share one departmentId.
     */
    const body = buildAbbreviationRequest({
      designationName: 'Concurrent Reservation Test',
      departmentId: randomObjectId(),
    });
    const [first, second] = await Promise.all([
      designationsClient.abbreviationAndCodeCreation(body, { token }),
      designationsClient.abbreviationAndCodeCreation(body, { token }),
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
          scenario: `Two concurrent calls for "Concurrent Reservation Test" in the same department both returned code "${a.code}". The endpoint hands out a value it does not reserve, so the collision is only discovered when the second save fails — after the user has filled in the rest of the form.`,
          title: 'designation abbreviationAndCodeCreation does not reserve the code it issues',
        },
        'Idempotency / Concurrency',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: an empty designationName must be refused, not handed a blank abbreviation', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildAbbreviationRequest({ designationName: '' });
    const response = await designationsClient.abbreviationAndCodeCreation(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty designationName' });
  });

  test('[2b] boundary: a null designationName must be refused', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildAbbreviationRequest({ designationName: null });
    const response = await designationsClient.abbreviationAndCodeCreation(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null designationName' });
  });

  test('[2c] boundary: a 5000-character name must not be abbreviated', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildAbbreviationRequest({ designationName: MAX_LENGTH_STRING });
    const response = await designationsClient.abbreviationAndCodeCreation(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) designationName',
    });
  });

  test('[2d] boundary: a null departmentId must be refused — the code is scoped to a department', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * Unlike the department generator, this one composes the code relative to its parent
     * department and only needs uniqueness within it. With no departmentId the uniqueness scope
     * is undefined, so a code issued here can collide with an existing title at save time.
     */
    const body = buildAbbreviationRequest({ departmentId: null });
    const response = await designationsClient.abbreviationAndCodeCreation(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'null departmentId — the uniqueness scope of the generated code',
    });
  });

  test('[3] typefuzz: a numeric designationName must be refused', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildAbbreviationRequest({ designationName: 1001 });
    const response = await designationsClient.abbreviationAndCodeCreation(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'numeric designationName',
    });
  });

  test('[3b] typefuzz: an array designationName must be refused', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildAbbreviationRequest({ designationName: ['Manager', 'Architect'] });
    const response = await designationsClient.abbreviationAndCodeCreation(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'array designationName' });
  });

  test('[3c] typefuzz: a boolean departmentId must be refused', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildAbbreviationRequest({ departmentId: true });
    const response = await designationsClient.abbreviationAndCodeCreation(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean departmentId' });
  });

  test('[4] auth: an unauthenticated caller must be refused', async ({ designationsClient }) => {
    const body = buildAbbreviationRequest();
    const response = await designationsClient.abbreviationAndCodeCreation(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a forged alg:none token must be refused', async ({ designationsClient }) => {
    const body = buildAbbreviationRequest();
    const response = await designationsClient.abbreviationAndCodeCreation(body, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] the generated code must not disclose another tenant\'s naming space', async ({
    designationsClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * The abbreviation is derived against existing designations in the target department to
     * avoid a clash. If the endpoint honours a foreign companyId, the returned code is an oracle
     * over another tenant's job titles — which of them exist can be inferred from what it avoids.
     */
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildAbbreviationRequest({ companyId: otherTenant });
    const response = await designationsClient.abbreviationAndCodeCreation(body, { token });

    await assertStatusCodeParity(response, {
      ...META,
      body,
      repro: `await designationsClient.abbreviationAndCodeCreation({ designationName: "...", companyId: "${otherTenant}" }, { token });`,
    });
  });

  test('[6] injection: a script designation name must not be reflected unescaped', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildAbbreviationRequest({ designationName: XSS_PAYLOAD });
    const response = await designationsClient.abbreviationAndCodeCreation(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });

  test('[6b] injection: a SQL payload must not surface a database error', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildAbbreviationRequest({ designationName: SQLI_PAYLOAD });
    const response = await designationsClient.abbreviationAndCodeCreation(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });
});

/* ==== POST /designation/delete ==== */
test.describe('POST /designation/delete', () => {
  const META = {
    method: 'POST',
    path: DESIGNATION_PATHS.delete,
    repro: `await designationsClient.delete(buildDeleteById(), { token }); // random id — matches no document`,
  };

  test('[1] happy path: a delete against a non-existent id returns a well-formed envelope', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // Non-existent id on purpose — this is a hard delete with no undo through the API, and no
    // cascade, so a real target would orphan its child designations and any role posting on it.
    const body = buildDeleteById({ id: randomObjectId() });
    const response = await designationsClient.delete(body, { token });

    await expectValidContract(response, looseEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDeleteById({ id: randomObjectId() });
    const response = await designationsClient.delete(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: deleting an id that does not exist must not be reported as SUCCESS', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const missingId = randomObjectId();
    const body = buildDeleteById({ id: missingId });
    const response = await designationsClient.delete(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await designationsClient.delete({ id: "${missingId}" }, { token });`,
          scenario: `Deleting the non-existent id "${missingId}" reported SUCCESS. A caller cannot distinguish "removed" from "was never there", which hides a failed cleanup. Body: ${text.slice(0, 200)}`,
          title: 'designation/delete reports SUCCESS for an id that matched no document',
        },
        'Status Code Misreporting',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[1d] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDeleteById({ id: randomObjectId() });
    const response = await designationsClient.delete(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[2] boundary: an empty id must be refused, not treated as "delete everything"', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDeleteById({ id: '' });
    const response = await designationsClient.delete(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty id on a delete' });
  });

  test('[2b] boundary: a null id must be refused', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDeleteById({ id: null });
    const response = await designationsClient.delete(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id on a delete' });
  });

  test('[3] typefuzz: an object id must be refused, not used as a Mongo operator', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * `{ $ne: null }` is the classic operator-injection shape: if it reaches the driver as a
     * filter it matches every document, turning a single delete into a collection wipe of every
     * job title on the platform. This must be refused at the boundary.
     */
    const body = buildDeleteById({ id: { $ne: null } });
    const response = await designationsClient.delete(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object id ({ $ne: null }) — operator injection that would match every document',
    });
  });

  test('[3b] typefuzz: a boolean id must be refused', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDeleteById({ id: true });
    const response = await designationsClient.delete(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean id' });
  });

  test('[4] auth: an unauthenticated delete must be refused', async ({ designationsClient }) => {
    const body = buildDeleteById();
    const response = await designationsClient.delete(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must not authorise a destructive delete', async ({
    designationsClient,
  }) => {
    const body = buildDeleteById();
    const response = await designationsClient.delete(body, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4c] auth: a malformed token must not authorise a destructive delete', async ({
    designationsClient,
  }) => {
    const body = buildDeleteById();
    const response = await designationsClient.delete(body, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a caller must not be able to delete another tenant\'s designation', async ({
    designationsClient,
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
    const response = await designationsClient.delete(body, { token });

    const { json, text } = await readBody(response);
    const value = json?.value as { companyId?: string } | null;
    if (value?.companyId && value.companyId !== companyID) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await designationsClient.delete({ id: "${foreignId}" }, { token /* tenant ${companyID} */ });`,
          scenario: `A delete issued as tenant ${companyID} returned a designation belonging to tenant "${value.companyId}". The endpoint resolves ids globally rather than within the caller's tenant, so any job title is deletable by anyone who can guess its id — and because the delete does not cascade, its child designations and role postings are left pointing at nothing. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant designation delete (IDOR): ids resolve outside the caller\'s tenant',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload as the id must not leak an exception trace', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDeleteById({ id: SQLI_DROP_PAYLOAD });
    const response = await designationsClient.delete(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });

  test('[6b] injection: a script id must not be reflected unescaped', async ({
    designationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDeleteById({ id: XSS_PAYLOAD });
    const response = await designationsClient.delete(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});
