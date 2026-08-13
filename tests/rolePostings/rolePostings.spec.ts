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
import { ROLE_POSTING_PATHS } from '../../src/api/clients/rolePostings.client';
import {
  rolePostingListEnvelopeSchema,
  rolePostingEnvelopeSchema,
  rolePostingEmployeeListEnvelopeSchema,
} from '../../src/api/schemas/rolePostings.schema';
import { looseEnvelopeSchema } from '../../src/api/schemas/envelope.schema';
import {
  buildRolePostingRequest,
  buildRolePostingArray,
  buildRolePostingUpdate,
  buildSuspendRequest,
  buildSuspendListRequest,
  buildGetByCompany,
  buildGetByCompanyAndEmployee,
  buildById,
  buildByLastHrVariable,
  randomObjectId,
} from '../../src/api/payloads/rolePostings.payload';

/*
 * Role Postings tag (/rolePosting/*) — the record that places an employee at a workplace/HR
 * tier node and carries the suspend / terminate / transfer / promotion lifecycle.
 *
 * One describe per endpoint titled with its bare `METHOD /path` signature, explicit standalone
 * cases — no loops, no factories — so every case is individually named, reportable and
 * skippable, and so `scripts/audit-vectors.ts` can group coverage by endpoint.
 *
 * ## What is dangerous here
 *
 * This is the richest access-control surface in the module. Nearly every route takes a
 * caller-supplied `companyId` and/or `employeeId` **in the request body** while the backend's
 * SecurityConfiguration permits `"/**"`, so a foreign `companyId` is the entire attack: if the
 * body is trusted over the token, one tenant reads — and rewrites — another tenant's staff
 * roster. Each endpoint therefore carries a real cross-tenant `[IDOR]` case, authenticated as
 * our tenant and asking for `companyID + 1`.
 *
 * Three routes mutate real employment state and are handled with care:
 *   - `POST /rolePosting/delete` is a **hard delete**: no cascade, no undo through the API.
 *   - `POST /rolePosting/suspendOrTerminateEmployee` changes a real person's employment status.
 *   - `POST /rolePosting/softDelete` is reversible in principle but still writes.
 * Every case against all three points at a freshly-minted random 24-char hex ObjectId that
 * matches no document, or at a refusal path. Nothing in this file touches a live record.
 *
 * Several lookups (`getEmployeeByCompanyId`, `getAssignedRolePostingEmployeeByCompanyId`,
 * `getEmployeeDetailsByLastHrvariableId`) return joined `EmployeeDetails` rows, i.e. personal
 * data. An anonymous 200 carrying one of those is a breach, not a spec mismatch — which is
 * exactly the distinction `assertUnauthorized` grades on.
 *
 * ## Envelope reminder
 *
 * Every route answers HTTP 200 or 500 only, carrying
 * `{ value, status: SUCCESS|FAILURE, statusCode, urlPath, error? }`. A missing document is 200
 * with `value: null`/`[]` or 500 with `status: FAILURE` — never 404. HTTP 200 says nothing
 * about success, so assertions read the envelope's status word, never the transport alone, and
 * the update-style routes are read through `value` because `status` is SUCCESS regardless.
 */

const XSS_PAYLOAD = `<script>alert('rolePosting')</script>`;
const SQLI_PAYLOAD = `1001' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE table_admin_role_posting; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);

/* ==== POST /rolePosting/save ==== */
test.describe('POST /rolePosting/save', () => {
  const META = {
    method: 'POST',
    path: ROLE_POSTING_PATHS.save,
    repro: `await rolePostingsClient.save(buildRolePostingArray(2), { token });`,
  };

  test('[1] happy path: a valid array of postings is accepted', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildRolePostingArray(2);
    const response = await rolePostingsClient.save(body, { token });

    await assertStatus(response, [200], { ...META, body });
  });

  test('[1b] contract: the save response satisfies the posting-list envelope', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildRolePostingArray(1);
    const response = await rolePostingsClient.save(body, { token });

    await expectValidContract(response, rolePostingListEnvelopeSchema, { ...META, body });
  });

  test('[1c] parity: the HTTP status must agree with the envelope statusCode', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildRolePostingArray(1);
    const response = await rolePostingsClient.save(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1d] parity: a rejected save must not be delivered as HTTP 200 with a failure payload', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body: unknown[] = [];
    const response = await rolePostingsClient.save(body, { token });

    await assertNot200OKOnError(response, {
      ...META,
      body,
      repro: `await rolePostingsClient.save([], { token });`,
    });
  });

  test('[2] boundary: an empty array must not be accepted as a successful save', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body: unknown[] = [];
    const response = await rolePostingsClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      repro: `await rolePostingsClient.save([], { token });`,
      scenario: 'empty posting array',
    });
  });

  test('[2b] boundary: a null employeeId must be refused, not persisted as an unassigned posting', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // A posting with no employee is a role assigned to nobody — it corrupts every downstream
    // headcount and reporting query that joins on employeeId.
    const body = buildRolePostingArray(1, { employeeId: null });
    const response = await rolePostingsClient.save(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null employeeId' });
  });

  test('[2c] boundary: an empty companyId must be refused rather than saved unscoped', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildRolePostingArray(1, { companyId: '' });
    const response = await rolePostingsClient.save(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty companyId' });
  });

  test('[2d] boundary: a 5000-character displayName must be refused rather than stored', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildRolePostingArray(1, { displayName: MAX_LENGTH_STRING });
    const response = await rolePostingsClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) displayName',
    });
  });

  test('[3] typefuzz: an object body where the documented shape is an array must be refused', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildRolePostingRequest(); // a single object where an array is required
    const response = await rolePostingsClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      repro: `await rolePostingsClient.save(buildRolePostingRequest(), { token }); // object, not array`,
      scenario: 'object body instead of a JSON array',
    });
  });

  test('[3b] typefuzz: an array employeeId where a string is documented must be refused', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildRolePostingArray(1, { employeeId: ['a', 'b'] });
    const response = await rolePostingsClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'array employeeId where a string is documented',
    });
  });

  test('[3c] typefuzz: a numeric companyId must be refused, not silently coerced', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildRolePostingArray(1, { companyId: 1001 }); // number, spec says string
    const response = await rolePostingsClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'numeric companyId where a string is documented',
    });
  });

  test('[3d] typefuzz: a boolean userType must be refused', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildRolePostingArray(1, { userType: true });
    const response = await rolePostingsClient.save(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean userType' });
  });

  test('[4] auth: an unauthenticated caller must not be able to create role postings', async ({
    rolePostingsClient,
  }) => {
    /*
     * api.json places every route under the global bearerAuth requirement, but the backend's
     * SecurityConfiguration permits "/**". A write reachable anonymously is worse than a
     * readable one: it lets anyone attach staff to any tenant's org structure.
     */
    const body = buildRolePostingArray(1);
    const response = await rolePostingsClient.save(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a malformed bearer token must be refused on a write', async ({
    rolePostingsClient,
  }) => {
    const body = buildRolePostingArray(1);
    const response = await rolePostingsClient.save(body, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a posting must not be creatable inside another tenant', async ({
    rolePostingsClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildRolePostingArray(1, { companyId: otherTenant });
    const response = await rolePostingsClient.save(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await rolePostingsClient.save([{ companyId: "${otherTenant}", ... }], { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, a role posting was written into tenant "${otherTenant}" and reported SUCCESS. The body's companyId is trusted over the token's, so any caller can plant staff records — and therefore access — inside any tenant. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant role-posting write (IDOR): body companyId overrides the token tenant',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true); // presence-only assertion; the finding above is the signal
  });

  test('[6] injection: a SQL payload in employeeId must not surface a database error', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildRolePostingArray(1, { employeeId: SQLI_PAYLOAD });
    const response = await rolePostingsClient.save(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a <script> displayName must not be stored and echoed unescaped', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // displayName is rendered in every org chart and staff directory in the product, so a
    // stored script here executes in the session of anyone who opens the roster.
    const body = buildRolePostingArray(1, { displayName: XSS_PAYLOAD });
    const response = await rolePostingsClient.save(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /rolePosting/update ==== */
test.describe('POST /rolePosting/update', () => {
  const META = {
    method: 'POST',
    path: ROLE_POSTING_PATHS.update,
    repro: `await rolePostingsClient.update(buildRolePostingUpdate(), { token }); // random id — matches no document`,
  };

  test('[1] happy path: an update returns a well-formed envelope', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildRolePostingUpdate();
    const response = await rolePostingsClient.update(body, { token });

    await expectValidContract(response, looseEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildRolePostingUpdate();
    const response = await rolePostingsClient.update(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: updating a non-existent id must not be reported as SUCCESS', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * Documented module behaviour: update-style routes have no failure branch and answer
     * SUCCESS even when no document matched. On a posting that misreports an employment
     * change — an HR user is told a transfer or reinstatement was applied when nothing moved.
     */
    const missingId = randomObjectId();
    const body = buildRolePostingUpdate({ id: missingId, remarks: 'Reassigned to nowhere' });
    const response = await rolePostingsClient.update(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS' && !json?.value) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await rolePostingsClient.update({ id: "${missingId}", remarks: "Reassigned to nowhere" }, { token });`,
          scenario: `Update against the non-existent id "${missingId}" returned status SUCCESS with an empty value. No document was modified, yet the caller is told the posting was updated. Body: ${text.slice(0, 200)}`,
          title: 'rolePosting/update reports SUCCESS when no document matched the id',
        },
        'Status Code Misreporting',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[1d] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildRolePostingUpdate({ id: randomObjectId() });
    const response = await rolePostingsClient.update(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[2] boundary: an empty id must be refused rather than updating an arbitrary posting', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildRolePostingUpdate({ id: '' });
    const response = await rolePostingsClient.update(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty id' });
  });

  test('[2b] boundary: a null id must be refused', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildRolePostingUpdate({ id: null });
    const response = await rolePostingsClient.update(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id' });
  });

  test('[2c] boundary: a 5000-character remarks field must be refused rather than stored', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildRolePostingUpdate({ remarks: MAX_LENGTH_STRING });
    const response = await rolePostingsClient.update(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) remarks',
    });
  });

  test('[3] typefuzz: a numeric id where a 24-char ObjectId is documented must be refused', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildRolePostingUpdate({ id: 1001 });
    const response = await rolePostingsClient.update(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric id' });
  });

  test('[3b] typefuzz: an object id must be refused, not stringified into a query', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildRolePostingUpdate({ id: { $ne: null } });
    const response = await rolePostingsClient.update(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object id ({ $ne: null }) — a Mongo operator injection shape that matches every posting',
    });
  });

  test('[3c] typefuzz: a boolean activeStatus expressed as a string must not be coerced', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // activeStatus drives whether the employee is treated as currently posted. A silently
    // coerced value flips employment state on a typo.
    const body = buildRolePostingUpdate({ activeStatus: 'not-a-boolean' });
    const response = await rolePostingsClient.update(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'string activeStatus where a boolean is documented',
    });
  });

  test('[4] auth: an unauthenticated caller must not be able to update a posting', async ({
    rolePostingsClient,
  }) => {
    const body = buildRolePostingUpdate();
    const response = await rolePostingsClient.update(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must be refused on a write', async ({ rolePostingsClient }) => {
    const body = buildRolePostingUpdate();
    const response = await rolePostingsClient.update(body, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a posting must not be reassignable into another tenant', async ({
    rolePostingsClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * Rewriting companyId on an existing posting moves an employee between tenants. If the
     * body wins over the token, a tenant can both export its own staff into a competitor's
     * directory and claim a foreign posting as its own.
     */
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildRolePostingUpdate({ companyId: otherTenant });
    const response = await rolePostingsClient.update(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS' && json?.value) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await rolePostingsClient.update({ id: "<id>", companyId: "${otherTenant}" }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, an update rewrote a posting's companyId to "${otherTenant}" and returned a document. Employment records can be moved into — or out of — another tenant by body alone. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant role-posting reassignment (IDOR) via the update body',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a malformed ObjectId must not leak the parser exception', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildRolePostingUpdate({ id: 'not-an-object-id' });
    const response = await rolePostingsClient.update(body, { token });

    // A malformed ObjectId should be a 4xx; this module tends to 500, and a 500 must not carry
    // the "Invalid ObjectId" exception text or a stack frame back to the caller.
    await assertNoInternalLeak(response, { ...META, body }, 'not-an-object-id');
  });

  test('[6b] injection: a script remarks value must not be echoed unescaped on update', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildRolePostingUpdate({ remarks: XSS_PAYLOAD });
    const response = await rolePostingsClient.update(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /rolePosting/delete ==== */
test.describe('POST /rolePosting/delete', () => {
  const META = {
    method: 'POST',
    path: ROLE_POSTING_PATHS.delete,
    repro: `await rolePostingsClient.delete(buildById(), { token }); // random id — matches no document`,
  };

  test('[1] happy path: a delete against a non-existent id returns a well-formed envelope', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // Non-existent id on purpose — this is a hard delete with no cascade and no undo.
    const body = buildById({ id: randomObjectId() });
    const response = await rolePostingsClient.delete(body, { token });

    await expectValidContract(response, looseEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: randomObjectId() });
    const response = await rolePostingsClient.delete(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: deleting an id that does not exist must not be reported as SUCCESS', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const missingId = randomObjectId();
    const body = buildById({ id: missingId });
    const response = await rolePostingsClient.delete(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await rolePostingsClient.delete({ id: "${missingId}" }, { token });`,
          scenario: `Hard-deleting the non-existent id "${missingId}" reported SUCCESS. A caller cannot distinguish "the posting was removed" from "it was never there", which hides both a failed offboarding and a delete that hit the wrong record. Body: ${text.slice(0, 200)}`,
          title: 'rolePosting/delete reports SUCCESS for an id that matched no document',
        },
        'Status Code Misreporting',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[1d] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: randomObjectId() });
    const response = await rolePostingsClient.delete(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[2] boundary: an empty id must be refused, not treated as "delete everything"', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: '' });
    const response = await rolePostingsClient.delete(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty id on a hard delete' });
  });

  test('[2b] boundary: a null id must be refused', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: null });
    const response = await rolePostingsClient.delete(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id on a hard delete' });
  });

  test('[2c] boundary: a 5000-character id must not be processed as a delete key', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: MAX_LENGTH_STRING });
    const response = await rolePostingsClient.delete(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) id on a hard delete',
    });
  });

  test('[3] typefuzz: an object id must be refused, not used as a Mongo operator', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * `{ $ne: null }` is the classic operator-injection shape: if it reaches the driver as a
     * filter it matches every document, turning one delete into a wipe of the tenant's entire
     * staff roster. This must be refused at the boundary.
     */
    const body = buildById({ id: { $ne: null } });
    const response = await rolePostingsClient.delete(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object id ({ $ne: null }) — operator injection that would match every posting',
    });
  });

  test('[3b] typefuzz: a boolean id must be refused', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: true });
    const response = await rolePostingsClient.delete(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean id' });
  });

  test('[3c] typefuzz: an array id must be refused', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: ['a', 'b'] });
    const response = await rolePostingsClient.delete(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'array id where a single ObjectId is documented',
    });
  });

  test('[4] auth: an unauthenticated hard delete must be refused', async ({ rolePostingsClient }) => {
    const body = buildById();
    const response = await rolePostingsClient.delete(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must not authorise a destructive delete', async ({
    rolePostingsClient,
  }) => {
    const body = buildById();
    const response = await rolePostingsClient.delete(body, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4c] auth: a token forged with alg:none must never authorise a delete', async ({
    rolePostingsClient,
  }) => {
    // An alg:none token is unsigned by construction. Honouring one means anyone can mint any
    // identity — and here that identity can erase employment records.
    const body = buildById();
    const response = await rolePostingsClient.delete(body, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a caller must not be able to delete another tenant\'s posting', async ({
    rolePostingsClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * A random id is used because confirming this properly would mean destroying a real
     * foreign record. What is asserted is that the endpoint does not answer with another
     * tenant's document as evidence that the id resolved outside the caller's tenant.
     */
    const foreignId = randomObjectId();
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildById({ id: foreignId, companyId: otherTenant });
    const response = await rolePostingsClient.delete(body, { token });

    const { json, text } = await readBody(response);
    const value = json?.value as { companyId?: string } | null;
    if (value?.companyId && value.companyId !== companyID) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await rolePostingsClient.delete({ id: "${foreignId}", companyId: "${otherTenant}" }, { token /* tenant ${companyID} */ });`,
          scenario: `A hard delete issued as tenant ${companyID} returned a posting belonging to tenant "${value.companyId}". Ids resolve globally rather than within the caller's tenant, so any posting is destroyable by anyone who can guess or enumerate its id. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant role-posting hard delete (IDOR): ids resolve outside the caller\'s tenant',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload as the id must not leak an exception trace', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: SQLI_DROP_PAYLOAD });
    const response = await rolePostingsClient.delete(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });

  test('[6b] injection: a script id must not be reflected unescaped', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: XSS_PAYLOAD });
    const response = await rolePostingsClient.delete(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /rolePosting/softDelete ==== */
test.describe('POST /rolePosting/softDelete', () => {
  const META = {
    method: 'POST',
    path: ROLE_POSTING_PATHS.softDelete,
    repro: `await rolePostingsClient.softDelete(buildById(), { token }); // random id — matches no document`,
  };

  test('[1] happy path: a soft delete against a non-existent id returns a well-formed envelope', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // Reversible in principle, but still a write — a random id keeps every live posting intact.
    const body = buildById({ id: randomObjectId() });
    const response = await rolePostingsClient.softDelete(body, { token });

    await expectValidContract(response, looseEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: randomObjectId() });
    const response = await rolePostingsClient.softDelete(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: soft-deleting a non-existent id must not be reported as SUCCESS', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const missingId = randomObjectId();
    const body = buildById({ id: missingId });
    const response = await rolePostingsClient.softDelete(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await rolePostingsClient.softDelete({ id: "${missingId}" }, { token });`,
          scenario: `Soft-deleting the non-existent id "${missingId}" reported SUCCESS. Nothing was flagged deleted, yet an offboarding workflow keying on this response will mark the step complete and move on. Body: ${text.slice(0, 200)}`,
          title: 'rolePosting/softDelete reports SUCCESS for an id that matched no document',
        },
        'Status Code Misreporting',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[1d] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: randomObjectId() });
    const response = await rolePostingsClient.softDelete(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[2] boundary: an empty id must be refused rather than flagging an arbitrary posting', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: '' });
    const response = await rolePostingsClient.softDelete(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty id on a soft delete' });
  });

  test('[2b] boundary: a null id must be refused', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: null });
    const response = await rolePostingsClient.softDelete(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id on a soft delete' });
  });

  test('[2c] boundary: a 5000-character id must not be processed as a lookup key', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: MAX_LENGTH_STRING });
    const response = await rolePostingsClient.softDelete(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) id on a soft delete',
    });
  });

  test('[3] typefuzz: an object id must be refused, not used as a Mongo operator', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: { $ne: null } });
    const response = await rolePostingsClient.softDelete(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object id ({ $ne: null }) — operator injection that would flag every posting deleted',
    });
  });

  test('[3b] typefuzz: a numeric id must be refused', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: 1001 });
    const response = await rolePostingsClient.softDelete(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric id' });
  });

  test('[3c] typefuzz: a boolean id must be refused', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: false });
    const response = await rolePostingsClient.softDelete(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean id' });
  });

  test('[4] auth: an unauthenticated soft delete must be refused', async ({ rolePostingsClient }) => {
    const body = buildById();
    const response = await rolePostingsClient.softDelete(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a malformed token must not authorise a soft delete', async ({
    rolePostingsClient,
  }) => {
    const body = buildById();
    const response = await rolePostingsClient.softDelete(body, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a caller must not be able to soft-delete another tenant\'s posting', async ({
    rolePostingsClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const foreignId = randomObjectId();
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildById({ id: foreignId, companyId: otherTenant });
    const response = await rolePostingsClient.softDelete(body, { token });

    const { json, text } = await readBody(response);
    const value = json?.value as { companyId?: string } | null;
    if (value?.companyId && value.companyId !== companyID) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await rolePostingsClient.softDelete({ id: "${foreignId}", companyId: "${otherTenant}" }, { token /* tenant ${companyID} */ });`,
          scenario: `A soft delete issued as tenant ${companyID} returned a posting belonging to tenant "${value.companyId}". The target id is resolved without a tenant filter, so a caller can retire another company's staff assignments. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant role-posting soft delete (IDOR): the target id is not tenant-scoped',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload as the id must not surface a database error', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: SQLI_PAYLOAD });
    const response = await rolePostingsClient.softDelete(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script id must not be reflected unescaped', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: XSS_PAYLOAD });
    const response = await rolePostingsClient.softDelete(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /rolePosting/getRolePostingById ==== */
test.describe('POST /rolePosting/getRolePostingById', () => {
  const META = {
    method: 'POST',
    path: ROLE_POSTING_PATHS.getRolePostingById,
    repro: `await rolePostingsClient.getById(buildById(), { token });`,
  };

  test('[1] happy path: an id lookup returns a well-formed single-posting envelope', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById();
    const response = await rolePostingsClient.getById(body, { token });

    await expectValidContract(response, rolePostingEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById();
    const response = await rolePostingsClient.getById(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] parity: a missing posting must not be reported as a 2xx failure envelope', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: randomObjectId() });
    const response = await rolePostingsClient.getById(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[2] boundary: an empty id must be refused, not answered with an arbitrary posting', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: '' });
    const response = await rolePostingsClient.getById(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty id' });
  });

  test('[2b] boundary: a null id must be refused rather than treated as "any posting"', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: null });
    const response = await rolePostingsClient.getById(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id' });
  });

  test('[2c] boundary: a 5000-character id must not be processed as a lookup key', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: MAX_LENGTH_STRING });
    const response = await rolePostingsClient.getById(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) id',
    });
  });

  test('[3] typefuzz: an array id where a single ObjectId is documented must be refused', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: ['a', 'b'] });
    const response = await rolePostingsClient.getById(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'array id' });
  });

  test('[3b] typefuzz: a numeric id must be refused, not silently coerced', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: 1001 });
    const response = await rolePostingsClient.getById(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric id' });
  });

  test('[3c] typefuzz: an object id must be refused, not used as a Mongo operator', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // `{ $ne: null }` as a find filter returns the first posting in the collection — which,
    // on a globally-resolved id, belongs to whichever tenant inserted it first.
    const body = buildById({ id: { $ne: null } });
    const response = await rolePostingsClient.getById(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object id ({ $ne: null }) — operator injection that matches an arbitrary posting',
    });
  });

  test('[4] auth: an unauthenticated caller must not be served a posting by id', async ({
    rolePostingsClient,
  }) => {
    const body = buildById();
    const response = await rolePostingsClient.getById(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must be refused', async ({ rolePostingsClient }) => {
    const body = buildById();
    const response = await rolePostingsClient.getById(body, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4c] auth: a token forged with alg:none must never be accepted', async ({
    rolePostingsClient,
  }) => {
    const body = buildById();
    const response = await rolePostingsClient.getById(body, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a posting id belonging to another tenant must not be readable', async ({
    rolePostingsClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * This route takes an id and nothing else, so the only possible tenant filter is the
     * token's. If the document that comes back names a different companyId, ids resolve
     * globally and every posting in the database is one enumerated ObjectId away.
     */
    const probeId = randomObjectId();
    const body = buildById({ id: probeId, companyId: `${Number(companyID ?? 1001) + 1}` });
    const response = await rolePostingsClient.getById(body, { token });

    const { json, text } = await readBody(response);
    const value = json?.value as { companyId?: string } | null;
    if (value?.companyId && value.companyId !== companyID) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await rolePostingsClient.getById({ id: "${probeId}" }, { token /* tenant ${companyID} */ });`,
          scenario: `A lookup issued as tenant ${companyID} returned a posting owned by tenant "${value.companyId}". The id is resolved without a tenant filter, exposing another company's staff assignment by direct object reference. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant role-posting read by id (IDOR)',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL-injection id must not surface a database error or query echo', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: SQLI_PAYLOAD });
    const response = await rolePostingsClient.getById(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script id must not come back unescaped in the envelope', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: XSS_PAYLOAD });
    const response = await rolePostingsClient.getById(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /rolePosting/getRolePostingByCompanyId ==== */
test.describe('POST /rolePosting/getRolePostingByCompanyId', () => {
  const META = {
    method: 'POST',
    path: ROLE_POSTING_PATHS.getRolePostingByCompanyId,
    repro: `await rolePostingsClient.getByCompanyId(buildGetByCompany(), { token });`,
  };

  test('[1] happy path: a valid companyId returns a well-formed posting-list envelope', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany();
    const response = await rolePostingsClient.getByCompanyId(body, { token });

    await expectValidContract(response, rolePostingListEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany();
    const response = await rolePostingsClient.getByCompanyId(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] parity: an unknown tenant must not be answered as a 2xx failure envelope', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: '9999999' });
    const response = await rolePostingsClient.getByCompanyId(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[2] boundary: an empty companyId must be refused, not answered with every posting', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: '' });
    const response = await rolePostingsClient.getByCompanyId(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty companyId' });
  });

  test('[2b] boundary: a null companyId must be refused rather than treated as "all tenants"', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: null });
    const response = await rolePostingsClient.getByCompanyId(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null companyId' });
  });

  test('[2c] boundary: a 5000-character companyId must not be processed as a lookup key', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: MAX_LENGTH_STRING });
    const response = await rolePostingsClient.getByCompanyId(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) companyId',
    });
  });

  test('[3] typefuzz: an array companyId where a string is documented must be refused', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // An accepted array is a multi-tenant query in one request — the cheapest possible
    // cross-tenant harvest if the backend passes it through to a `$in`.
    const body = buildGetByCompany({ companyId: ['1001', '1002'] });
    const response = await rolePostingsClient.getByCompanyId(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'array companyId' });
  });

  test('[3b] typefuzz: a boolean companyId must not be coerced into a lookup', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: true });
    const response = await rolePostingsClient.getByCompanyId(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean companyId' });
  });

  test('[3c] typefuzz: an object companyId must be refused, not used as a Mongo operator', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: { $ne: null } });
    const response = await rolePostingsClient.getByCompanyId(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object companyId ({ $ne: null }) — operator injection that would return every tenant',
    });
  });

  test('[4] auth: an unauthenticated caller must be refused, not served the tenant roster', async ({
    rolePostingsClient,
  }) => {
    /*
     * api.json places every route under the global bearerAuth requirement, but the backend's
     * SecurityConfiguration permits "/**". A 200 here is a real spec/implementation mismatch:
     * Major on its own, Critical if protected material actually comes back.
     */
    const body = buildGetByCompany();
    const response = await rolePostingsClient.getByCompanyId(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must be refused', async ({ rolePostingsClient }) => {
    const body = buildGetByCompany();
    const response = await rolePostingsClient.getByCompanyId(body, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] one tenant must not receive another tenant\'s role postings', async ({
    rolePostingsClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * The filter injects companyID from the token, but this endpoint reads companyId from the
     * BODY. Asking for a different tenant while authenticated as ours must not work — if it
     * does, the body overrides the token and every company's staff roster is readable.
     */
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildGetByCompany({ companyId: otherTenant });
    const response = await rolePostingsClient.getByCompanyId(body, { token });

    const { json } = await readBody(response);
    const value = json?.value;
    if (Array.isArray(value) && value.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await rolePostingsClient.getByCompanyId({ companyId: "${otherTenant}" }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, the body companyId "${otherTenant}" returned ${value.length} foreign posting(s) — the endpoint trusts the body over the token, exposing another company's complete staff-to-role assignment map.`,
          title: 'Cross-tenant role-posting read (IDOR): body companyId overrides the token tenant',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL-injection companyId must not surface a database error', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: SQLI_PAYLOAD });
    const response = await rolePostingsClient.getByCompanyId(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script companyId must not come back unescaped in the envelope', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: XSS_PAYLOAD });
    const response = await rolePostingsClient.getByCompanyId(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /rolePosting/getRolePostingByCompanyIdAndEmployeeId ==== */
test.describe('POST /rolePosting/getRolePostingByCompanyIdAndEmployeeId', () => {
  const META = {
    method: 'POST',
    path: ROLE_POSTING_PATHS.getRolePostingByCompanyIdAndEmployeeId,
    repro: `await rolePostingsClient.getByCompanyAndEmployee(buildGetByCompanyAndEmployee(), { token });`,
  };

  test('[1] happy path: a company + employee pair returns a well-formed posting-list envelope', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompanyAndEmployee();
    const response = await rolePostingsClient.getByCompanyAndEmployee(body, { token });

    await expectValidContract(response, rolePostingListEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompanyAndEmployee();
    const response = await rolePostingsClient.getByCompanyAndEmployee(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] parity: an unmatched employee must not be answered as a 2xx failure envelope', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompanyAndEmployee({ employeeId: randomObjectId() });
    const response = await rolePostingsClient.getByCompanyAndEmployee(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[2] boundary: an empty employeeId must be refused, not widened to the whole company', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // Dropping the employee filter silently turns a single-person lookup into a full roster
    // dump — the caller asked about one employee and would receive every one.
    const body = buildGetByCompanyAndEmployee({ employeeId: '' });
    const response = await rolePostingsClient.getByCompanyAndEmployee(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty employeeId' });
  });

  test('[2b] boundary: a null employeeId must be refused', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompanyAndEmployee({ employeeId: null });
    const response = await rolePostingsClient.getByCompanyAndEmployee(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null employeeId' });
  });

  test('[2c] boundary: a 5000-character employeeId must not be processed as a lookup key', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompanyAndEmployee({ employeeId: MAX_LENGTH_STRING });
    const response = await rolePostingsClient.getByCompanyAndEmployee(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) employeeId',
    });
  });

  test('[2d] boundary: an empty companyId must be refused rather than searched unscoped', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompanyAndEmployee({ companyId: '' });
    const response = await rolePostingsClient.getByCompanyAndEmployee(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty companyId' });
  });

  test('[3] typefuzz: an array employeeId where a string is documented must be refused', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompanyAndEmployee({ employeeId: ['a', 'b'] });
    const response = await rolePostingsClient.getByCompanyAndEmployee(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'array employeeId' });
  });

  test('[3b] typefuzz: a numeric employeeId must be refused, not silently coerced', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompanyAndEmployee({ employeeId: 1001 });
    const response = await rolePostingsClient.getByCompanyAndEmployee(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric employeeId' });
  });

  test('[3c] typefuzz: an object employeeId must be refused, not used as a Mongo operator', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompanyAndEmployee({ employeeId: { $ne: null } });
    const response = await rolePostingsClient.getByCompanyAndEmployee(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object employeeId ({ $ne: null }) — operator injection that matches every employee',
    });
  });

  test('[4] auth: an unauthenticated caller must not be served an employee\'s postings', async ({
    rolePostingsClient,
  }) => {
    const body = buildGetByCompanyAndEmployee();
    const response = await rolePostingsClient.getByCompanyAndEmployee(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a malformed bearer token must be refused', async ({ rolePostingsClient }) => {
    const body = buildGetByCompanyAndEmployee();
    const response = await rolePostingsClient.getByCompanyAndEmployee(body, {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] one tenant must not read a foreign tenant\'s employee postings', async ({
    rolePostingsClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildGetByCompanyAndEmployee({ companyId: otherTenant });
    const response = await rolePostingsClient.getByCompanyAndEmployee(body, { token });

    const { json } = await readBody(response);
    const value = json?.value;
    if (Array.isArray(value) && value.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await rolePostingsClient.getByCompanyAndEmployee({ companyId: "${otherTenant}", employeeId: "<id>" }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, a body companyId of "${otherTenant}" returned ${value.length} foreign posting(s). Because both scoping keys come from the body, the pair is an oracle: a caller can confirm whether a given employee id exists inside any other tenant.`,
          title: 'Cross-tenant employee-posting read (IDOR) via body companyId',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload in employeeId must not surface a database error', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompanyAndEmployee({ employeeId: SQLI_PAYLOAD });
    const response = await rolePostingsClient.getByCompanyAndEmployee(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script employeeId must not be reflected unescaped', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompanyAndEmployee({ employeeId: XSS_PAYLOAD });
    const response = await rolePostingsClient.getByCompanyAndEmployee(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /rolePosting/getAssignedRolePostingEmployeeByCompanyId ==== */
test.describe('POST /rolePosting/getAssignedRolePostingEmployeeByCompanyId', () => {
  const META = {
    method: 'POST',
    path: ROLE_POSTING_PATHS.getAssignedRolePostingEmployeeByCompanyId,
    repro: `await rolePostingsClient.getAssignedRolePostingEmployeeByCompanyId(buildGetByCompany(), { token });`,
  };

  test('[1] happy path: a valid companyId returns a well-formed employee-list envelope', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany();
    const response = await rolePostingsClient.getAssignedRolePostingEmployeeByCompanyId(body, {
      token,
    });

    await expectValidContract(response, rolePostingEmployeeListEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany();
    const response = await rolePostingsClient.getAssignedRolePostingEmployeeByCompanyId(body, {
      token,
    });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] parity: an unknown tenant must not be answered as a 2xx failure envelope', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: '9999999' });
    const response = await rolePostingsClient.getAssignedRolePostingEmployeeByCompanyId(body, {
      token,
    });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[2] boundary: an empty companyId must be refused, not answered with every assignment', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: '' });
    const response = await rolePostingsClient.getAssignedRolePostingEmployeeByCompanyId(body, {
      token,
    });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty companyId' });
  });

  test('[2b] boundary: a null companyId must be refused rather than treated as "all tenants"', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: null });
    const response = await rolePostingsClient.getAssignedRolePostingEmployeeByCompanyId(body, {
      token,
    });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null companyId' });
  });

  test('[2c] boundary: a 5000-character companyId must not be processed as a lookup key', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: MAX_LENGTH_STRING });
    const response = await rolePostingsClient.getAssignedRolePostingEmployeeByCompanyId(body, {
      token,
    });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) companyId',
    });
  });

  test('[3] typefuzz: an array companyId where a string is documented must be refused', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: ['1001', '1002'] });
    const response = await rolePostingsClient.getAssignedRolePostingEmployeeByCompanyId(body, {
      token,
    });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'array companyId' });
  });

  test('[3b] typefuzz: a numeric companyId must be refused, not silently coerced', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: 1001 });
    const response = await rolePostingsClient.getAssignedRolePostingEmployeeByCompanyId(body, {
      token,
    });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric companyId' });
  });

  test('[3c] typefuzz: an object companyId must be refused, not used as a Mongo operator', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: { $ne: null } });
    const response = await rolePostingsClient.getAssignedRolePostingEmployeeByCompanyId(body, {
      token,
    });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object companyId ({ $ne: null }) — operator injection that would return every tenant',
    });
  });

  test('[4] auth: an unauthenticated caller must not be served the assigned-employee list', async ({
    rolePostingsClient,
  }) => {
    // This route joins EmployeeDetails onto the posting, so an anonymous 200 that carries rows
    // is a personal-data breach rather than a bare spec/implementation mismatch.
    const body = buildGetByCompany();
    const response = await rolePostingsClient.getAssignedRolePostingEmployeeByCompanyId(body, {
      token: null,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a token forged with alg:none must never be accepted', async ({
    rolePostingsClient,
  }) => {
    const body = buildGetByCompany();
    const response = await rolePostingsClient.getAssignedRolePostingEmployeeByCompanyId(body, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] one tenant must not list another tenant\'s assigned employees', async ({
    rolePostingsClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildGetByCompany({ companyId: otherTenant });
    const response = await rolePostingsClient.getAssignedRolePostingEmployeeByCompanyId(body, {
      token,
    });

    const { json } = await readBody(response);
    const value = json?.value;
    if (Array.isArray(value) && value.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await rolePostingsClient.getAssignedRolePostingEmployeeByCompanyId({ companyId: "${otherTenant}" }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, the body companyId "${otherTenant}" returned ${value.length} foreign employee record(s). These rows carry joined EmployeeDetails, so this is a cross-tenant disclosure of personal data, not just of structure.`,
          title: 'Cross-tenant assigned-employee read (IDOR) exposing personal data',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL-injection companyId must not surface a database error', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: SQLI_PAYLOAD });
    const response = await rolePostingsClient.getAssignedRolePostingEmployeeByCompanyId(body, {
      token,
    });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script companyId must not be reflected unescaped', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: XSS_PAYLOAD });
    const response = await rolePostingsClient.getAssignedRolePostingEmployeeByCompanyId(body, {
      token,
    });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /rolePosting/getEmployeeByCompanyId ==== */
test.describe('POST /rolePosting/getEmployeeByCompanyId', () => {
  const META = {
    method: 'POST',
    path: ROLE_POSTING_PATHS.getEmployeeByCompanyId,
    repro: `await rolePostingsClient.getEmployeeByCompanyId(buildGetByCompany(), { token });`,
  };

  test('[1] happy path: a valid companyId returns a well-formed employee-list envelope', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany();
    const response = await rolePostingsClient.getEmployeeByCompanyId(body, { token });

    await expectValidContract(response, rolePostingEmployeeListEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany();
    const response = await rolePostingsClient.getEmployeeByCompanyId(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] parity: an unknown tenant must not be answered as a 2xx failure envelope', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: '9999999' });
    const response = await rolePostingsClient.getEmployeeByCompanyId(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[2] boundary: an empty companyId must be refused, not answered with every employee', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: '' });
    const response = await rolePostingsClient.getEmployeeByCompanyId(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty companyId' });
  });

  test('[2b] boundary: a null companyId must be refused rather than treated as "all tenants"', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: null });
    const response = await rolePostingsClient.getEmployeeByCompanyId(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null companyId' });
  });

  test('[2c] boundary: a 5000-character companyId must not be processed as a lookup key', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: MAX_LENGTH_STRING });
    const response = await rolePostingsClient.getEmployeeByCompanyId(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) companyId',
    });
  });

  test('[3] typefuzz: an array companyId where a string is documented must be refused', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: ['1001', '1002'] });
    const response = await rolePostingsClient.getEmployeeByCompanyId(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'array companyId' });
  });

  test('[3b] typefuzz: a boolean companyId must not be coerced into a lookup', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: false });
    const response = await rolePostingsClient.getEmployeeByCompanyId(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean companyId' });
  });

  test('[3c] typefuzz: an object companyId must be refused, not used as a Mongo operator', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: { $ne: null } });
    const response = await rolePostingsClient.getEmployeeByCompanyId(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object companyId ({ $ne: null }) — operator injection returning every tenant\'s employees',
    });
  });

  test('[4] auth: an unauthenticated caller must not be served the employee directory', async ({
    rolePostingsClient,
  }) => {
    // The rows here are people. If any come back without a token this is Critical — an
    // anonymous, unthrottled staff-directory dump.
    const body = buildGetByCompany();
    const response = await rolePostingsClient.getEmployeeByCompanyId(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must be refused', async ({ rolePostingsClient }) => {
    const body = buildGetByCompany();
    const response = await rolePostingsClient.getEmployeeByCompanyId(body, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] one tenant must not list another tenant\'s employees', async ({
    rolePostingsClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildGetByCompany({ companyId: otherTenant });
    const response = await rolePostingsClient.getEmployeeByCompanyId(body, { token });

    const { json } = await readBody(response);
    const value = json?.value;
    if (Array.isArray(value) && value.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await rolePostingsClient.getEmployeeByCompanyId({ companyId: "${otherTenant}" }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, the body companyId "${otherTenant}" returned ${value.length} foreign employee record(s). Because companyId values on this module are short sequential integers, an attacker holding any valid token can walk the range and harvest every tenant's staff directory.`,
          title: 'Cross-tenant employee directory read (IDOR) via body companyId',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL-injection companyId must not surface a database error', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: SQLI_PAYLOAD });
    const response = await rolePostingsClient.getEmployeeByCompanyId(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script companyId must not be reflected unescaped', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: XSS_PAYLOAD });
    const response = await rolePostingsClient.getEmployeeByCompanyId(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /rolePosting/getEmployeeDetailsByLastHrvariableId ==== */
test.describe('POST /rolePosting/getEmployeeDetailsByLastHrvariableId', () => {
  const META = {
    method: 'POST',
    path: ROLE_POSTING_PATHS.getEmployeeDetailsByLastHrvariableId,
    repro: `await rolePostingsClient.getEmployeeDetailsByLastHrVariableId(buildByLastHrVariable(), { token });`,
  };

  test('[1] happy path: a company + HR node pair returns a well-formed employee-list envelope', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByLastHrVariable();
    const response = await rolePostingsClient.getEmployeeDetailsByLastHrVariableId(body, { token });

    await expectValidContract(response, rolePostingEmployeeListEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByLastHrVariable();
    const response = await rolePostingsClient.getEmployeeDetailsByLastHrVariableId(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] parity: an unmatched HR node must not be answered as a 2xx failure envelope', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByLastHrVariable({ lastHrVariableId: randomObjectId() });
    const response = await rolePostingsClient.getEmployeeDetailsByLastHrVariableId(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[2] boundary: an empty lastHrVariableId must be refused, not widened to every node', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByLastHrVariable({ lastHrVariableId: '' });
    const response = await rolePostingsClient.getEmployeeDetailsByLastHrVariableId(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'empty lastHrVariableId',
    });
  });

  test('[2b] boundary: a null lastHrVariableId must be refused', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByLastHrVariable({ lastHrVariableId: null });
    const response = await rolePostingsClient.getEmployeeDetailsByLastHrVariableId(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null lastHrVariableId' });
  });

  test('[2c] boundary: a 5000-character lastHrVariableId must not be processed as a lookup key', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByLastHrVariable({ lastHrVariableId: MAX_LENGTH_STRING });
    const response = await rolePostingsClient.getEmployeeDetailsByLastHrVariableId(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) lastHrVariableId',
    });
  });

  test('[2d] boundary: an empty companyId must be refused rather than searched unscoped', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByLastHrVariable({ companyId: '' });
    const response = await rolePostingsClient.getEmployeeDetailsByLastHrVariableId(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty companyId' });
  });

  test('[3] typefuzz: an array lastHrVariableId must be refused', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByLastHrVariable({ lastHrVariableId: ['a', 'b'] });
    const response = await rolePostingsClient.getEmployeeDetailsByLastHrVariableId(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'array lastHrVariableId' });
  });

  test('[3b] typefuzz: a numeric lastHrVariableId must be refused, not silently coerced', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByLastHrVariable({ lastHrVariableId: 1001 });
    const response = await rolePostingsClient.getEmployeeDetailsByLastHrVariableId(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'numeric lastHrVariableId',
    });
  });

  test('[3c] typefuzz: an object lastHrVariableId must be refused, not used as a Mongo operator', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByLastHrVariable({ lastHrVariableId: { $ne: null } });
    const response = await rolePostingsClient.getEmployeeDetailsByLastHrVariableId(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object lastHrVariableId ({ $ne: null }) — operator injection matching every HR node',
    });
  });

  test('[4] auth: an unauthenticated caller must not be served employee details', async ({
    rolePostingsClient,
  }) => {
    const body = buildByLastHrVariable();
    const response = await rolePostingsClient.getEmployeeDetailsByLastHrVariableId(body, {
      token: null,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a malformed bearer token must be refused', async ({ rolePostingsClient }) => {
    const body = buildByLastHrVariable();
    const response = await rolePostingsClient.getEmployeeDetailsByLastHrVariableId(body, {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a foreign companyId must not expose another tenant\'s HR-node staff', async ({
    rolePostingsClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * This lookup walks the HR hierarchy: given a node it returns everyone sitting under it.
     * Honouring a foreign companyId therefore leaks not only people but the shape of another
     * tenant's reporting structure.
     */
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildByLastHrVariable({ companyId: otherTenant });
    const response = await rolePostingsClient.getEmployeeDetailsByLastHrVariableId(body, { token });

    const { json } = await readBody(response);
    const value = json?.value;
    if (Array.isArray(value) && value.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await rolePostingsClient.getEmployeeDetailsByLastHrVariableId({ companyId: "${otherTenant}", lastHrVariableId: "<id>" }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, a body companyId of "${otherTenant}" returned ${value.length} foreign employee record(s) under a HR node. The endpoint scopes on the body rather than the token, disclosing both personal data and the reporting structure it hangs from.`,
          title: 'Cross-tenant HR-node employee read (IDOR) via body companyId',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a malformed ObjectId must not leak the parser exception', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByLastHrVariable({ lastHrVariableId: 'not-an-object-id' });
    const response = await rolePostingsClient.getEmployeeDetailsByLastHrVariableId(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, 'not-an-object-id');
  });

  test('[6b] injection: a script lastHrVariableId must not be reflected unescaped', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByLastHrVariable({ lastHrVariableId: XSS_PAYLOAD });
    const response = await rolePostingsClient.getEmployeeDetailsByLastHrVariableId(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /rolePosting/getSuspendOrTerminateEmployee ==== */
test.describe('POST /rolePosting/getSuspendOrTerminateEmployee', () => {
  const META = {
    method: 'POST',
    path: ROLE_POSTING_PATHS.getSuspendOrTerminateEmployee,
    repro: `await rolePostingsClient.getSuspendOrTerminateEmployee(buildSuspendListRequest(), { token });`,
  };

  test('[1] happy path: a company + requestType pair returns a well-formed posting-list envelope', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildSuspendListRequest();
    const response = await rolePostingsClient.getSuspendOrTerminateEmployee(body, { token });

    await expectValidContract(response, rolePostingListEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildSuspendListRequest();
    const response = await rolePostingsClient.getSuspendOrTerminateEmployee(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] parity: an unrecognised requestType must not be answered as a 2xx failure envelope', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildSuspendListRequest({ requestType: 'not-a-type' });
    const response = await rolePostingsClient.getSuspendOrTerminateEmployee(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[2] boundary: an empty requestType must be refused, not widened to every lifecycle state', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildSuspendListRequest({ requestType: '' });
    const response = await rolePostingsClient.getSuspendOrTerminateEmployee(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty requestType' });
  });

  test('[2b] boundary: a null companyId must be refused rather than treated as "all tenants"', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildSuspendListRequest({ companyId: null });
    const response = await rolePostingsClient.getSuspendOrTerminateEmployee(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null companyId' });
  });

  test('[2c] boundary: a 5000-character requestType must not be processed as a filter', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildSuspendListRequest({ requestType: MAX_LENGTH_STRING });
    const response = await rolePostingsClient.getSuspendOrTerminateEmployee(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) requestType',
    });
  });

  test('[3] typefuzz: an array requestType must be refused', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildSuspendListRequest({ requestType: ['suspend', 'terminate'] });
    const response = await rolePostingsClient.getSuspendOrTerminateEmployee(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'array requestType' });
  });

  test('[3b] typefuzz: a boolean requestType must not be coerced into a filter', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildSuspendListRequest({ requestType: true });
    const response = await rolePostingsClient.getSuspendOrTerminateEmployee(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean requestType' });
  });

  test('[3c] typefuzz: a numeric companyId must be refused, not silently coerced', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildSuspendListRequest({ companyId: 1001 });
    const response = await rolePostingsClient.getSuspendOrTerminateEmployee(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric companyId' });
  });

  test('[4] auth: an unauthenticated caller must not be served the suspended/terminated list', async ({
    rolePostingsClient,
  }) => {
    /*
     * This list is unusually sensitive even inside a tenant: it names the people a company has
     * suspended or terminated and why. Reaching it without a token is a disclosure of adverse
     * employment actions against identifiable individuals.
     */
    const body = buildSuspendListRequest();
    const response = await rolePostingsClient.getSuspendOrTerminateEmployee(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must be refused', async ({ rolePostingsClient }) => {
    const body = buildSuspendListRequest();
    const response = await rolePostingsClient.getSuspendOrTerminateEmployee(body, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] one tenant must not read another tenant\'s suspended/terminated staff', async ({
    rolePostingsClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildSuspendListRequest({ companyId: otherTenant });
    const response = await rolePostingsClient.getSuspendOrTerminateEmployee(body, { token });

    const { json } = await readBody(response);
    const value = json?.value;
    if (Array.isArray(value) && value.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await rolePostingsClient.getSuspendOrTerminateEmployee({ companyId: "${otherTenant}", requestType: "suspend" }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, the body companyId "${otherTenant}" returned ${value.length} foreign suspension/termination record(s), including the stated reason. This discloses adverse employment actions taken by another company against named individuals.`,
          title: 'Cross-tenant suspension/termination read (IDOR) via body companyId',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL-injection companyId must not surface a database error', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildSuspendListRequest({ companyId: SQLI_PAYLOAD });
    const response = await rolePostingsClient.getSuspendOrTerminateEmployee(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script requestType must not be reflected unescaped', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildSuspendListRequest({ requestType: XSS_PAYLOAD });
    const response = await rolePostingsClient.getSuspendOrTerminateEmployee(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /rolePosting/suspendOrTerminateEmployee ==== */
test.describe('POST /rolePosting/suspendOrTerminateEmployee', () => {
  const META = {
    method: 'POST',
    path: ROLE_POSTING_PATHS.suspendOrTerminateEmployee,
    repro: `await rolePostingsClient.suspendOrTerminateEmployee(buildSuspendRequest(), { token }); // random ids — matches no posting`,
  };

  test('[1] happy path: a suspend against a non-existent posting returns a well-formed envelope', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // Destructive by design: this changes a real person's employment state. Every case in this
    // block therefore carries randomly-minted employeeId/rolePostingId values.
    const body = buildSuspendRequest();
    const response = await rolePostingsClient.suspendOrTerminateEmployee(body, { token });

    await expectValidContract(response, looseEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildSuspendRequest();
    const response = await rolePostingsClient.suspendOrTerminateEmployee(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: suspending a posting that does not exist must not report SUCCESS', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const missingPostingId = randomObjectId();
    const body = buildSuspendRequest({ rolePostingId: missingPostingId });
    const response = await rolePostingsClient.suspendOrTerminateEmployee(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await rolePostingsClient.suspendOrTerminateEmployee({ rolePostingId: "${missingPostingId}", requestType: "suspend" }, { token });`,
          scenario: `A suspend against the non-existent posting "${missingPostingId}" reported SUCCESS. No lifecycle change occurred, but an HR workflow reading this response records the employee as suspended — the system's view of who is active silently diverges from the database. Body: ${text.slice(0, 200)}`,
          title: 'suspendOrTerminateEmployee reports SUCCESS with no matching posting',
        },
        'Business Logic Flaw',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[1d] business rule: an unrecognised requestType must not be processed as a lifecycle action', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // Only suspend and terminate are defined. Anything else must be refused rather than
    // defaulted — defaulting an unknown verb to "terminate" ends someone's employment.
    const body = buildSuspendRequest({ requestType: 'obliterate' });
    const response = await rolePostingsClient.suspendOrTerminateEmployee(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'unrecognised requestType (neither suspend nor terminate)',
    });
  });

  test('[1e] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildSuspendRequest({ employeeId: '' });
    const response = await rolePostingsClient.suspendOrTerminateEmployee(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[2] boundary: an empty employeeId must be refused, not applied to an arbitrary employee', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildSuspendRequest({ employeeId: '' });
    const response = await rolePostingsClient.suspendOrTerminateEmployee(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty employeeId' });
  });

  test('[2b] boundary: a null requestType must be refused', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildSuspendRequest({ requestType: null });
    const response = await rolePostingsClient.suspendOrTerminateEmployee(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null requestType' });
  });

  test('[2c] boundary: a 5000-character reason must be refused rather than stored', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildSuspendRequest({ reason: MAX_LENGTH_STRING });
    const response = await rolePostingsClient.suspendOrTerminateEmployee(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) reason',
    });
  });

  test('[3] typefuzz: an array employeeId must be refused, not fanned out across employees', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // If an array reaches the driver as a filter, one request suspends several people at once.
    const body = buildSuspendRequest({ employeeId: ['a', 'b'] });
    const response = await rolePostingsClient.suspendOrTerminateEmployee(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'array employeeId' });
  });

  test('[3b] typefuzz: an object rolePostingId must be refused, not used as a Mongo operator', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildSuspendRequest({ rolePostingId: { $ne: null } });
    const response = await rolePostingsClient.suspendOrTerminateEmployee(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object rolePostingId ({ $ne: null }) — operator injection that would match every posting',
    });
  });

  test('[3c] typefuzz: a numeric duration must be refused where a string is documented', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildSuspendRequest({ duration: 1001 });
    const response = await rolePostingsClient.suspendOrTerminateEmployee(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric duration' });
  });

  test('[4] auth: an unauthenticated caller must not be able to suspend or terminate anyone', async ({
    rolePostingsClient,
  }) => {
    // This is the most damaging anonymous write in the tag: it removes a person's access and
    // marks them as no longer employed.
    const body = buildSuspendRequest();
    const response = await rolePostingsClient.suspendOrTerminateEmployee(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must not authorise a lifecycle change', async ({
    rolePostingsClient,
  }) => {
    const body = buildSuspendRequest();
    const response = await rolePostingsClient.suspendOrTerminateEmployee(body, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4c] auth: a token forged with alg:none must never authorise a termination', async ({
    rolePostingsClient,
  }) => {
    const body = buildSuspendRequest();
    const response = await rolePostingsClient.suspendOrTerminateEmployee(body, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a caller must not be able to suspend an employee in another tenant', async ({
    rolePostingsClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * Random ids keep this from touching a live posting — what is being probed is whether the
     * endpoint scopes the action to the token's tenant at all. Accepting a foreign companyId
     * here means one company can deactivate another company's staff.
     */
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildSuspendRequest({ companyId: otherTenant });
    const response = await rolePostingsClient.suspendOrTerminateEmployee(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS' && json?.value) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await rolePostingsClient.suspendOrTerminateEmployee({ companyId: "${otherTenant}", requestType: "suspend", ... }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, a suspend action targeting tenant "${otherTenant}" was accepted and returned a document. The lifecycle action is scoped by the body rather than the token, so one company can suspend or terminate another company's employees — a denial of service against a competitor's workforce. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant suspend/terminate (IDOR): the action is scoped by the body companyId',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload in reason must not surface a database error', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildSuspendRequest({ reason: SQLI_DROP_PAYLOAD });
    const response = await rolePostingsClient.suspendOrTerminateEmployee(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });

  test('[6b] injection: a script remarks value must not be stored and echoed unescaped', async ({
    rolePostingsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // remarks is displayed verbatim on the HR case record, so a stored script executes for the
    // reviewer opening the suspension.
    const body = buildSuspendRequest({ remarks: XSS_PAYLOAD });
    const response = await rolePostingsClient.suspendOrTerminateEmployee(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});
