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
import { EMPLOYEE_MASTER_PATHS } from '../../src/api/clients/employeeMaster.client';
import {
  employeeEnvelopeSchema,
  employeeListEnvelopeSchema,
} from '../../src/api/schemas/employeeMaster.schema';
import { looseEnvelopeSchema } from '../../src/api/schemas/envelope.schema';
import {
  buildEmployee,
  buildEmployeeUpdate,
  buildPersonalInformation,
  buildGetByCompany,
  buildTransferOrPromotionRequest,
  buildDeleteById,
  randomObjectId,
} from '../../src/api/payloads/employeeMaster.payload';

/*
 * Employee Master Data tag (/employeeDetails/*) — the tenant's people records.
 *
 * One describe per endpoint titled with its bare `METHOD /path` signature, explicit standalone
 * cases — no loops, no factories — so every case is individually named, reportable and
 * skippable, and so `scripts/audit-vectors.ts` can group coverage by endpoint.
 *
 * ## What is dangerous here
 *
 * This is the most PII-dense collection in the module. `getEmployeeDetails` runs an unprojected,
 * unpaged `find({ companyId })` and returns **complete** documents — names, dates of birth,
 * mobile numbers, e-mail addresses, home and mailing addresses, employment history. Anything
 * that hands one of those documents to a caller who should not have it is graded **Critical**,
 * not Major: an anonymous read here is an outright personal-data breach, and a cross-tenant read
 * is the same breach with the victim named. That is why the auth cases in this file are worded
 * around the data rather than around the status code.
 *
 * `POST /employeeDetails/delete` is a **hard delete** of the document and every embedded
 * sub-document: no soft-delete flag, no cascade, no undo through the API. Every case below
 * therefore points it at a freshly-minted random ObjectId that matches no document, or at a
 * refusal path. Nothing in this file deletes a real record.
 *
 * `POST /employeeDetails/update` replaces sub-documents rather than merging them — a partial
 * body silently discards whatever it omits — and, like the rest of the module, it has no failure
 * branch, so it answers `status: SUCCESS` even when no document matched the id. Cases here read
 * `value` rather than trusting `status`.
 *
 * `POST /employeeDetails/getTransferOrPromotionDetails` assembles its Mongo filter from the
 * submitted key/value map, so the request body is not merely validated input — it is query
 * material. It is also declared in api.json with a request body of `type: string` while every
 * example is a JSON object, a contract defect exercised directly below.
 *
 * ## Envelope reminder
 *
 * Every route answers HTTP 200 or 500 only, carrying
 * `{ value, status: SUCCESS|FAILURE, statusCode, urlPath, error? }`. HTTP 200 says nothing
 * about success, so assertions read the envelope's status word, never the transport alone.
 */

const XSS_PAYLOAD = `<script>alert('employee')</script>`;
const SQLI_PAYLOAD = `1001' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE table_admin_employee_details; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);

/* ==== POST /employeeDetails/getEmployeeDetails ==== */
test.describe('POST /employeeDetails/getEmployeeDetails', () => {
  const META = {
    method: 'POST',
    path: EMPLOYEE_MASTER_PATHS.getEmployeeDetails,
    repro: `await employeeMasterClient.getEmployeeDetails(buildGetByCompany(), { token });`,
  };

  test('[1] happy path: a valid companyId returns a well-formed employee-list envelope', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany();
    const response = await employeeMasterClient.getEmployeeDetails(body, { token });

    await expectValidContract(response, employeeListEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany();
    const response = await employeeMasterClient.getEmployeeDetails(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // A tenant that does not exist is the ordinary "nothing found" path; the module answers it
    // as 200 with an empty value or as a FAILURE envelope, and only the latter is a defect.
    const body = buildGetByCompany({ companyId: randomObjectId() });
    const response = await employeeMasterClient.getEmployeeDetails(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[2] boundary: an empty companyId must be refused, not answered with the whole directory', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: '' });
    const response = await employeeMasterClient.getEmployeeDetails(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'empty companyId on a PII-bearing directory read' },
      [400, 422]
    );
  });

  test('[2b] boundary: a null companyId must be refused rather than treated as "all tenants"', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: null });
    const response = await employeeMasterClient.getEmployeeDetails(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'null companyId' },
      [400, 422]
    );
  });

  test('[2c] boundary: a 5000-character companyId must not be processed as a lookup key', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: MAX_LENGTH_STRING });
    const response = await employeeMasterClient.getEmployeeDetails(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'oversized (5000-char) companyId' },
      [400, 422]
    );
  });

  test('[3] typefuzz: an array companyId where a string is documented must be refused', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: ['1001', '1002'] });
    const response = await employeeMasterClient.getEmployeeDetails(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'array companyId where a string is documented' },
      [400, 422]
    );
  });

  test('[3b] typefuzz: a numeric companyId must be refused, not silently coerced', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: 1001 });
    const response = await employeeMasterClient.getEmployeeDetails(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'numeric companyId where a string is documented' },
      [400, 422]
    );
  });

  test('[3c] typefuzz: a boolean companyId must not be coerced into a directory lookup', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: true });
    const response = await employeeMasterClient.getEmployeeDetails(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'boolean companyId' },
      [400, 422]
    );
  });

  test('[4] auth: an unauthenticated caller must not receive the employee directory', async ({
    employeeMasterClient,
  }) => {
    /*
     * api.json places every route under the global bearerAuth requirement, but the backend's
     * SecurityConfiguration permits "/**". A 200 here is not the usual Major spec mismatch: the
     * response body is a list of complete employee documents, so an anonymous success is a
     * personal-data breach. `assertUnauthorized` grades it Critical automatically once the
     * sensitive-field markers (mobile, email, dateOfBirth, addresses) appear in the body.
     */
    const body = buildGetByCompany();
    const response = await employeeMasterClient.getEmployeeDetails(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must not unlock employee PII', async ({
    employeeMasterClient,
  }) => {
    const body = buildGetByCompany();
    const response = await employeeMasterClient.getEmployeeDetails(body, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4c] auth: a token forged with alg:none must never be accepted', async ({
    employeeMasterClient,
  }) => {
    // An alg:none token is unsigned by construction. Accepting one means the filter trusts the
    // header's algorithm claim, which lets anyone mint any identity and read any tenant's staff.
    const body = buildGetByCompany();
    const response = await employeeMasterClient.getEmployeeDetails(body, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] one tenant must not receive another tenant\'s employee records', async ({
    employeeMasterClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * The filter injects companyID from the token, but this endpoint reads companyId from the
     * BODY. Asking for a different tenant while authenticated as ours must not work — if it
     * does, every employer's staff list, with contact details and dates of birth, is readable
     * by any other tenant on the platform.
     */
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildGetByCompany({ companyId: otherTenant });
    const response = await employeeMasterClient.getEmployeeDetails(body, { token });

    const { json } = await readBody(response);
    const value = json?.value;
    if (Array.isArray(value) && value.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await employeeMasterClient.getEmployeeDetails({ companyId: "${otherTenant}" }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, the body companyId "${otherTenant}" returned ${value.length} foreign employee record(s). The endpoint trusts the body over the token, so one employer can read another employer's complete staff files — names, dates of birth, mobile numbers, e-mail and home addresses.`,
          title:
            'Cross-tenant employee-master read (IDOR): body companyId overrides the token tenant',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true); // presence-only assertion; the finding above is the signal
  });

  test('[6] injection: a SQL-injection companyId must not surface a database error or query echo', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: SQLI_PAYLOAD });
    const response = await employeeMasterClient.getEmployeeDetails(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script companyId must not come back unescaped in the envelope', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetByCompany({ companyId: XSS_PAYLOAD });
    const response = await employeeMasterClient.getEmployeeDetails(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /employeeDetails/save ==== */
test.describe('POST /employeeDetails/save', () => {
  const META = {
    method: 'POST',
    path: EMPLOYEE_MASTER_PATHS.save,
    repro: `await employeeMasterClient.save(buildEmployee(), { token });`,
  };

  test('[1] happy path: a valid composite employee record is accepted', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // Unlike department/save this takes a SINGLE object, not an array.
    const body = buildEmployee();
    const response = await employeeMasterClient.save(body, { token });

    await assertStatus(response, [200], { ...META, body });
  });

  test('[1b] contract: the save response satisfies the employee envelope', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployee();
    const response = await employeeMasterClient.save(body, { token });

    await expectValidContract(response, employeeEnvelopeSchema, { ...META, body });
  });

  test('[1c] parity: the HTTP status must agree with the envelope statusCode', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployee();
    const response = await employeeMasterClient.save(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1d] parity: a rejected save must not be delivered as a 2xx with a failure payload', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = {};
    const response = await employeeMasterClient.save(body, { token });

    await assertNot200OKOnError(response, {
      ...META,
      body,
      repro: `await employeeMasterClient.save({}, { token });`,
    });
  });

  test('[2] boundary: an empty body must not be accepted as an employee record', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = {};
    const response = await employeeMasterClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      repro: `await employeeMasterClient.save({}, { token });`,
      scenario: 'empty body — no companyId, no personal information',
    });
  });

  test('[2b] boundary: a null companyId must be refused, not persisted as an unowned record', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // A person stored with no owning tenant is invisible to every tenant-scoped read and to
    // every tenant-scoped deletion, so it becomes undeletable PII.
    const body = buildEmployee({ companyId: null });
    const response = await employeeMasterClient.save(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null companyId' });
  });

  test('[2c] boundary: a 5000-character firstName must be refused rather than stored', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployee({
      personalInformationObj: buildPersonalInformation({ firstName: MAX_LENGTH_STRING }),
    });
    const response = await employeeMasterClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) firstName inside personalInformationObj',
    });
  });

  test('[3] typefuzz: an array personalInformationObj where an object is documented must be refused', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployee({ personalInformationObj: ['Arun', 'Prakash'] });
    const response = await employeeMasterClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'array personalInformationObj where an object is documented',
    });
  });

  test('[3b] typefuzz: a numeric companyId must be refused, not silently coerced', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployee({ companyId: 1001 });
    const response = await employeeMasterClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'numeric companyId where a string is documented',
    });
  });

  test('[3c] typefuzz: a boolean personalInformationObj must be refused', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployee({ personalInformationObj: true });
    const response = await employeeMasterClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'boolean personalInformationObj where a nested document is documented',
    });
  });

  test('[4] auth: an unauthenticated caller must not be able to create employee records', async ({
    employeeMasterClient,
  }) => {
    // An anonymous write here injects a person — with contact details — into someone else's HR
    // master data, where it will be treated as a real joiner by every downstream flow.
    const body = buildEmployee();
    const response = await employeeMasterClient.save(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a malformed bearer token must be refused', async ({ employeeMasterClient }) => {
    const body = buildEmployee();
    const response = await employeeMasterClient.save(body, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] an employee must not be creatable inside another tenant', async ({
    employeeMasterClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildEmployee({ companyId: otherTenant });
    const response = await employeeMasterClient.save(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await employeeMasterClient.save({ companyId: "${otherTenant}", personalInformationObj: {...} }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, an employee record was written into tenant "${otherTenant}" and reported SUCCESS. The body's companyId is trusted over the token's, so any caller can plant a person — and a mobile number and e-mail address the payroll and notification flows will use — inside any employer's master data. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant employee write (IDOR): body companyId overrides the token tenant',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a <script> lastName must not be stored and echoed unescaped', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // The employee grid renders these fields for every HR user in the tenant, so a stored
    // script in a name field executes in an administrator's session, not the attacker's.
    const body = buildEmployee({
      personalInformationObj: buildPersonalInformation({ lastName: XSS_PAYLOAD }),
    });
    const response = await employeeMasterClient.save(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });

  test('[6b] injection: a SQL payload in firstName must not surface a database error', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployee({
      personalInformationObj: buildPersonalInformation({ firstName: SQLI_DROP_PAYLOAD }),
    });
    const response = await employeeMasterClient.save(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });
});

/* ==== POST /employeeDetails/update ==== */
test.describe('POST /employeeDetails/update', () => {
  const META = {
    method: 'POST',
    path: EMPLOYEE_MASTER_PATHS.update,
    repro: `await employeeMasterClient.update(buildEmployeeUpdate(), { token });`,
  };

  test('[1] happy path: an update returns a well-formed envelope', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeUpdate();
    const response = await employeeMasterClient.update(body, { token });

    await expectValidContract(response, employeeEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeUpdate();
    const response = await employeeMasterClient.update(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: updating a non-existent id must not be reported as SUCCESS', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * Documented module-wide defect: update has no failure branch and returns SUCCESS even when
     * no document matched. On HR data that misreport is expensive — an address or bank-relevant
     * correction is shown as saved to the employee while nothing changed.
     */
    const missingId = randomObjectId();
    const body = buildEmployeeUpdate({ id: missingId });
    const response = await employeeMasterClient.update(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await employeeMasterClient.update({ id: "${missingId}", ... }, { token });`,
          scenario: `Update against a non-existent employee id "${missingId}" returned status SUCCESS. No document was modified, yet the caller — and the HR user watching the screen — is told the correction was saved. Body: ${text.slice(0, 200)}`,
          title: 'employeeDetails/update reports SUCCESS when no document matched the id',
        },
        'Status Code Misreporting',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[1d] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeUpdate({ id: randomObjectId() });
    const response = await employeeMasterClient.update(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[2] boundary: an empty id must be refused rather than updating an arbitrary record', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeUpdate({ id: '' });
    const response = await employeeMasterClient.update(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty id' });
  });

  test('[2b] boundary: a null id must be refused, not turned into an insert', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeUpdate({ id: null });
    const response = await employeeMasterClient.update(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id' });
  });

  test('[2c] boundary: a 5000-character firstName must be refused on update', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeUpdate({
      personalInformationObj: buildPersonalInformation({ firstName: MAX_LENGTH_STRING }),
    });
    const response = await employeeMasterClient.update(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) firstName on update',
    });
  });

  test('[3] typefuzz: a numeric id where a 24-char ObjectId is documented must be refused', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeUpdate({ id: 1001 });
    const response = await employeeMasterClient.update(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric id' });
  });

  test('[3b] typefuzz: an object id must be refused, not used as a Mongo operator', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * `{ $ne: null }` is the classic operator-injection shape: reaching the driver as a filter it
     * matches every document, so a single-record update becomes a collection-wide overwrite of
     * everyone's personal details with this one payload.
     */
    const body = buildEmployeeUpdate({ id: { $ne: null } });
    const response = await employeeMasterClient.update(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object id ({ $ne: null }) — a Mongo operator injection shape',
    });
  });

  test('[3c] typefuzz: a boolean personalInformationObj must be refused on update', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeUpdate({ personalInformationObj: false });
    const response = await employeeMasterClient.update(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'boolean personalInformationObj — sub-documents are replaced wholesale on update',
    });
  });

  test('[4] auth: an unauthenticated caller must not be able to update an employee record', async ({
    employeeMasterClient,
  }) => {
    const body = buildEmployeeUpdate();
    const response = await employeeMasterClient.update(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must be refused on a write', async ({
    employeeMasterClient,
  }) => {
    const body = buildEmployeeUpdate();
    const response = await employeeMasterClient.update(body, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] an employee must not be reassignable into another tenant', async ({
    employeeMasterClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * The update body carries the tenant, so a rewritten companyId either moves a person out of
     * their employer's records or plants them inside someone else's. Either direction is a
     * cross-tenant write, and the moved document takes its PII with it.
     */
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildEmployeeUpdate({ companyId: otherTenant });
    const response = await employeeMasterClient.update(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS' && json?.value) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await employeeMasterClient.update({ id: "<id>", companyId: "${otherTenant}" }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, an update rewrote an employee's companyId to "${otherTenant}" and returned a document. A tenant can move people records — and the personal data embedded in them — into or out of another tenant. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant employee reassignment (IDOR) via the update body',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a malformed ObjectId must not leak the parser exception', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeUpdate({ id: 'not-an-object-id' });
    const response = await employeeMasterClient.update(body, { token });

    // A malformed ObjectId should be a 4xx; this module tends to 500, and a 500 must not carry
    // the "Invalid ObjectId" exception text or a stack frame back to the caller.
    await assertNoInternalLeak(response, { ...META, body }, 'not-an-object-id');
  });

  test('[6b] injection: a script firstName must not be echoed unescaped on update', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeUpdate({
      personalInformationObj: buildPersonalInformation({ firstName: XSS_PAYLOAD }),
    });
    const response = await employeeMasterClient.update(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /employeeDetails/getTransferOrPromotionDetails ==== */
test.describe('POST /employeeDetails/getTransferOrPromotionDetails', () => {
  const META = {
    method: 'POST',
    path: EMPLOYEE_MASTER_PATHS.getTransferOrPromotionDetails,
    repro: `await employeeMasterClient.getTransferOrPromotionDetails(buildTransferOrPromotionRequest(), { token });`,
  };

  test('[1] happy path: the documented object body returns a well-formed employee-list envelope', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildTransferOrPromotionRequest();
    const response = await employeeMasterClient.getTransferOrPromotionDetails(body, { token });

    await expectValidContract(response, employeeListEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildTransferOrPromotionRequest();
    const response = await employeeMasterClient.getTransferOrPromotionDetails(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] contract: the body declared as `string` in api.json must not 500 when a string is sent', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * api.json declares this request body as `type: string` while every example it ships is a
     * JSON object. A generated client follows the declared type. Sending exactly what the
     * contract says must not produce a server error — either the declaration is wrong or the
     * handler is, and the caller cannot tell which.
     */
    const body = 'promote';
    const response = await employeeMasterClient.getTransferOrPromotionDetails(body, { token });

    await assertNot200OKOnError(response, {
      ...META,
      body,
      repro: `await employeeMasterClient.getTransferOrPromotionDetails('promote', { token });`,
    });
  });

  test('[1d] business rule: an unrecognised requestType must not be answered with the whole worklist', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * The filter is assembled from the submitted key/value map, so an unknown requestType may
     * simply contribute nothing to it and leave a bare `find({ companyId })` behind — turning a
     * narrow worklist into the full employee dump this endpoint was scoped to avoid.
     */
    const body = buildTransferOrPromotionRequest({ requestType: 'teleport' });
    const response = await employeeMasterClient.getTransferOrPromotionDetails(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    const value = json?.value;
    if (response.status() === 200 && status === 'SUCCESS' && Array.isArray(value) && value.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await employeeMasterClient.getTransferOrPromotionDetails({ companyId, requestType: 'teleport' }, { token });`,
          scenario: `An unrecognised requestType "teleport" returned ${value.length} employee record(s) with status SUCCESS. The unknown key is dropped from the assembled filter instead of rejecting the request, so a typo silently widens a transfer/promotion worklist into an unfiltered read of the employee master. Body: ${text.slice(0, 200)}`,
          title: 'getTransferOrPromotionDetails ignores an invalid requestType and widens the filter',
        },
        'Business Logic Flaw',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: an empty requestType must be refused, not treated as "no filter"', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildTransferOrPromotionRequest({ requestType: '' });
    const response = await employeeMasterClient.getTransferOrPromotionDetails(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'empty requestType' },
      [400, 422]
    );
  });

  test('[2b] boundary: a null companyId must be refused rather than spanning every tenant', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildTransferOrPromotionRequest({ companyId: null });
    const response = await employeeMasterClient.getTransferOrPromotionDetails(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'null companyId on a filter-assembling read' },
      [400, 422]
    );
  });

  test('[2c] boundary: a 5000-character requestType must not be assembled into the filter', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildTransferOrPromotionRequest({ requestType: MAX_LENGTH_STRING });
    const response = await employeeMasterClient.getTransferOrPromotionDetails(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'oversized (5000-char) requestType' },
      [400, 422]
    );
  });

  test('[3] typefuzz: an array requestType must be refused', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildTransferOrPromotionRequest({ requestType: ['promote', 'reallocate'] });
    const response = await employeeMasterClient.getTransferOrPromotionDetails(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'array requestType where a single keyword is documented' },
      [400, 422]
    );
  });

  test('[3b] typefuzz: a numeric companyId must be refused, not silently coerced', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildTransferOrPromotionRequest({ companyId: 1001 });
    const response = await employeeMasterClient.getTransferOrPromotionDetails(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'numeric companyId where a string is documented' },
      [400, 422]
    );
  });

  test('[3c] typefuzz: a boolean requestType must be refused', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildTransferOrPromotionRequest({ requestType: true });
    const response = await employeeMasterClient.getTransferOrPromotionDetails(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'boolean requestType' },
      [400, 422]
    );
  });

  test('[4] auth: an unauthenticated caller must not receive the transfer/promotion worklist', async ({
    employeeMasterClient,
  }) => {
    // The worklist rows are full employee documents, so an anonymous 200 here leaks the same
    // PII as the directory read plus the fact that those people are being moved or promoted.
    const body = buildTransferOrPromotionRequest();
    const response = await employeeMasterClient.getTransferOrPromotionDetails(body, {
      token: null,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a forged alg:none token must be refused', async ({ employeeMasterClient }) => {
    const body = buildTransferOrPromotionRequest();
    const response = await employeeMasterClient.getTransferOrPromotionDetails(body, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] one tenant must not read another tenant\'s transfer/promotion worklist', async ({
    employeeMasterClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildTransferOrPromotionRequest({ companyId: otherTenant });
    const response = await employeeMasterClient.getTransferOrPromotionDetails(body, { token });

    const { json } = await readBody(response);
    const value = json?.value;
    if (Array.isArray(value) && value.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await employeeMasterClient.getTransferOrPromotionDetails({ companyId: "${otherTenant}", requestType: "promote" }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, the body companyId "${otherTenant}" returned ${value.length} foreign employee record(s) from the transfer/promotion worklist. Beyond the PII in each document, the list itself discloses which of a competitor's staff are being moved or promoted before those changes are announced.`,
          title: 'Cross-tenant transfer/promotion worklist read (IDOR)',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL-injection companyId must not surface a database error', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildTransferOrPromotionRequest({ companyId: SQLI_PAYLOAD });
    const response = await employeeMasterClient.getTransferOrPromotionDetails(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script requestType must not come back unescaped', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildTransferOrPromotionRequest({ requestType: XSS_PAYLOAD });
    const response = await employeeMasterClient.getTransferOrPromotionDetails(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /employeeDetails/delete ==== */
test.describe('POST /employeeDetails/delete', () => {
  const META = {
    method: 'POST',
    path: EMPLOYEE_MASTER_PATHS.delete,
    repro: `await employeeMasterClient.delete(buildDeleteById(), { token }); // random id — matches no document`,
  };

  test('[1] happy path: a delete against a non-existent id returns a well-formed envelope', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // Non-existent id on purpose — this is a hard delete of a person's whole record, embedded
    // sub-documents included, with no soft-delete flag and no undo through the API.
    const body = buildDeleteById({ id: randomObjectId() });
    const response = await employeeMasterClient.delete(body, { token });

    await expectValidContract(response, looseEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDeleteById({ id: randomObjectId() });
    const response = await employeeMasterClient.delete(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: deleting an id that does not exist must not be reported as SUCCESS', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const missingId = randomObjectId();
    const body = buildDeleteById({ id: missingId });
    const response = await employeeMasterClient.delete(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await employeeMasterClient.delete({ id: "${missingId}" }, { token });`,
          scenario: `Deleting the non-existent employee id "${missingId}" reported SUCCESS. A caller cannot distinguish "the record was removed" from "there was nothing there", so a data-retention erasure that quietly did nothing still reports as completed. Body: ${text.slice(0, 200)}`,
          title: 'employeeDetails/delete reports SUCCESS for an id that matched no document',
        },
        'Status Code Misreporting',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[1d] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDeleteById({ id: randomObjectId() });
    const response = await employeeMasterClient.delete(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[2] boundary: an empty id must be refused, not treated as "delete everything"', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDeleteById({ id: '' });
    const response = await employeeMasterClient.delete(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty id on a delete' });
  });

  test('[2b] boundary: a null id must be refused', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDeleteById({ id: null });
    const response = await employeeMasterClient.delete(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id on a delete' });
  });

  test('[3] typefuzz: an object id must be refused, not used as a Mongo operator', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * `{ $ne: null }` is the classic operator-injection shape: if it reaches the driver as a
     * filter it matches every document, turning one deletion into the destruction of an entire
     * employer's people records. This must be refused at the boundary.
     */
    const body = buildDeleteById({ id: { $ne: null } });
    const response = await employeeMasterClient.delete(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object id ({ $ne: null }) — operator injection that would match every document',
    });
  });

  test('[3b] typefuzz: a boolean id must be refused', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDeleteById({ id: true });
    const response = await employeeMasterClient.delete(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean id' });
  });

  test('[4] auth: an unauthenticated delete must be refused', async ({ employeeMasterClient }) => {
    const body = buildDeleteById();
    const response = await employeeMasterClient.delete(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must not authorise a destructive delete', async ({
    employeeMasterClient,
  }) => {
    const body = buildDeleteById();
    const response = await employeeMasterClient.delete(body, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4c] auth: a malformed token must not authorise a destructive delete', async ({
    employeeMasterClient,
  }) => {
    const body = buildDeleteById();
    const response = await employeeMasterClient.delete(body, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a caller must not be able to delete another tenant\'s employee', async ({
    employeeMasterClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * The delete body carries only an id — no tenant scope at all — so authorisation can only
     * come from the token. A random id is used because confirming this properly would mean
     * destroying a real person's record; what is asserted here is that the endpoint does not
     * answer with another tenant's document as evidence of a cross-tenant hit.
     */
    const foreignId = randomObjectId();
    const body = buildDeleteById({ id: foreignId, companyId: `${Number(companyID ?? 1001) + 1}` });
    const response = await employeeMasterClient.delete(body, { token });

    const { json, text } = await readBody(response);
    const value = json?.value as { companyId?: string } | null;
    if (value?.companyId && value.companyId !== companyID) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await employeeMasterClient.delete({ id: "${foreignId}" }, { token /* tenant ${companyID} */ });`,
          scenario: `A delete issued as tenant ${companyID} returned an employee document belonging to tenant "${value.companyId}". The endpoint resolves ids globally rather than within the caller's tenant, so any employee record is destroyable by anyone who can guess or harvest its id — and the hard delete leaves nothing to restore. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant employee delete (IDOR): ids resolve outside the caller\'s tenant',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload as the id must not leak an exception trace', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDeleteById({ id: SQLI_DROP_PAYLOAD });
    const response = await employeeMasterClient.delete(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });

  test('[6b] injection: a script id must not be reflected unescaped', async ({
    employeeMasterClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDeleteById({ id: XSS_PAYLOAD });
    const response = await employeeMasterClient.delete(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});
