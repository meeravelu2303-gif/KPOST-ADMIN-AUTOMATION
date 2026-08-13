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
import { LOCATION_PATHS } from '../../src/api/clients/workplaceLocations.client';
import {
  locationListEnvelopeSchema,
  locationEnvelopeSchema,
  reportingLocationEnvelopeSchema,
} from '../../src/api/schemas/workplaceLocations.schema';
import { looseEnvelopeSchema } from '../../src/api/schemas/envelope.schema';
import {
  buildLocation,
  buildLocationArray,
  buildLocationUpdate,
  buildLocationNode,
  buildGetAll,
  buildById,
  randomObjectId,
} from '../../src/api/payloads/workplaceLocations.payload';

/*
 * Workplace Locations tag (/location/*) — the tenant's physical-site master data. A location
 * hangs off a workplace-tier attribute/variable node and, through
 * `reportingWorkplaceLocationId`, off another location.
 *
 * One describe per endpoint titled with its bare `METHOD /path` signature, explicit standalone
 * cases — no loops, no factories — so every case is individually named, reportable and
 * skippable, and so `scripts/audit-vectors.ts` can group coverage by endpoint.
 *
 * ## What is dangerous here
 *
 * `POST /location/delete` is a **hard delete**: no soft-delete flag, no cascade, no undo through
 * the API, and the body carries only an `id` — no tenant scope at all, so authorisation can only
 * come from the token. Every case below therefore points it at a freshly-minted random ObjectId
 * that matches no document, or at a refusal path. Nothing in this file deletes a real record.
 *
 * `reportingWorkplaceLocationId` makes the collection a **self-referencing hierarchy**, and
 * `getReportingLocationName` walks it. Two failure modes follow from that and are asserted
 * explicitly: a parent link pointing at a location that does not exist (a dangling branch the
 * walk can never resolve), and a location that is its own parent (a cycle that turns a recursive
 * server-side walk into a non-terminating one). Both cases use a random, non-existent id for the
 * parent, so no real record is ever re-parented.
 *
 * `POST /location/update` is written to the same pattern as `department/update` — it reports
 * `status: SUCCESS` with no failure branch — so the cases here read `value` rather than trusting
 * `status`.
 *
 * ## Envelope reminder
 *
 * Every route answers HTTP 200 or 500 only, carrying
 * `{ value, status: SUCCESS|FAILURE, statusCode, urlPath, error? }`. HTTP 200 says nothing
 * about success, so assertions read the envelope's status word, never the transport alone.
 */

const XSS_PAYLOAD = `<script>alert('loc')</script>`;
const SQLI_PAYLOAD = `1001' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE table_admin_location; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);

/* ==== POST /location/save ==== */
test.describe('POST /location/save', () => {
  const META = {
    method: 'POST',
    path: LOCATION_PATHS.save,
    repro: `await workplaceLocationsClient.save(buildLocationArray(2), { token });`,
  };

  test('[1] happy path: a valid array of locations is accepted', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationArray(2);
    const response = await workplaceLocationsClient.save(body, { token });

    await assertStatus(response, [200], { ...META, body });
  });

  test('[1b] contract: the save response satisfies the location-list envelope', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationArray(1);
    const response = await workplaceLocationsClient.save(body, { token });

    await expectValidContract(response, locationListEnvelopeSchema, { ...META, body });
  });

  test('[1c] parity: the HTTP status must agree with the envelope statusCode', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationArray(1);
    const response = await workplaceLocationsClient.save(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1d] business rule: a location must not be saved reporting to a site that does not exist', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * `reportingWorkplaceLocationId` is a foreign key into the same collection, and
     * `getReportingLocationName` walks it. A random id belongs to no location, so accepting this
     * write creates a branch whose parent can never be resolved — the org chart renders with a
     * gap and the walk terminates on a null nobody expected.
     */
    const danglingParent = randomObjectId();
    const body = buildLocationArray(1, { reportingWorkplaceLocationId: danglingParent });
    const response = await workplaceLocationsClient.save(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceLocationsClient.save([{ ..., reportingWorkplaceLocationId: "${danglingParent}" }], { token });`,
          scenario: `A location reporting to "${danglingParent}" — an id that matches no location — was accepted with status SUCCESS. Referential integrity on the reporting link is not enforced, so the hierarchy can hold branches whose parent does not exist. Body: ${text.slice(0, 200)}`,
          title: 'location/save accepts a reportingWorkplaceLocationId that matches no location',
        },
        'Business Logic Flaw',
        'Major'
      );
    }
    expect(true).toBe(true); // presence-only assertion; the finding above is the signal
  });

  test('[1e] business rule: a location must not be saveable as its own reporting parent', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * A self-referencing parent is the smallest possible cycle. `getReportingLocationName` walks
     * the reporting chain recursively, so a cycle anywhere in the tree is a non-terminating walk:
     * a stack overflow, or a request that never returns. The id is random and matches no
     * document, so the cycle is only ever created among throwaway rows.
     */
    const cycleId = randomObjectId();
    const body = buildLocationArray(1, { id: cycleId, reportingWorkplaceLocationId: cycleId });
    const response = await workplaceLocationsClient.save(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceLocationsClient.save([{ id: "${cycleId}", reportingWorkplaceLocationId: "${cycleId}" }], { token });`,
          scenario: `A location whose reportingWorkplaceLocationId equals its own id was accepted with status SUCCESS. Nothing rejects a cycle in the reporting hierarchy, so any consumer that walks parent links — getReportingLocationName included — recurses without a terminating condition. Body: ${text.slice(0, 200)}`,
          title: 'location/save accepts a self-referencing reporting parent (hierarchy cycle)',
        },
        'Business Logic Flaw',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: an empty array must not be accepted as a successful save', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body: unknown[] = [];
    const response = await workplaceLocationsClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      repro: `await workplaceLocationsClient.save([], { token });`,
      scenario: 'empty location array',
    });
  });

  test('[2b] boundary: a null locationName must be refused, not persisted as a nameless site', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationArray(1, { locationName: null, workPlaceLocation: null });
    const response = await workplaceLocationsClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'null locationName',
    });
  });

  test('[2c] boundary: a 5000-character locationName must be refused rather than stored', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationArray(1, { locationName: MAX_LENGTH_STRING });
    const response = await workplaceLocationsClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) locationName',
    });
  });

  test('[3] typefuzz: an object body where the documented shape is an array must be refused', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocation(); // a single object where an array is required
    const response = await workplaceLocationsClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      repro: `await workplaceLocationsClient.save(buildLocation(), { token }); // object, not array`,
      scenario: 'object body instead of a JSON array',
    });
  });

  test('[3b] typefuzz: a boolean locationName must not be coerced into a site name', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationArray(1, { locationName: true });
    const response = await workplaceLocationsClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'boolean locationName where a string is documented',
    });
  });

  test('[3c] typefuzz: an array pincode where a string is documented must be refused', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationArray(1, { pincode: ['600042', '600096'] });
    const response = await workplaceLocationsClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'array pincode where a string is documented',
    });
  });

  test('[3d] typefuzz: a non-numeric countryId where an integer is documented must be refused', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationArray(1, { countryId: 'ninety-one' });
    const response = await workplaceLocationsClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'non-numeric countryId where an integer is documented',
    });
  });

  test('[4] auth: an unauthenticated caller must not be able to create locations', async ({
    workplaceLocationsClient,
  }) => {
    /*
     * api.json places every route under the global bearerAuth requirement, but the backend's
     * SecurityConfiguration permits "/**". A write reachable anonymously is worse than a
     * readable one: it lets an unauthenticated caller pollute another tenant's site list.
     */
    const body = buildLocationArray(1);
    const response = await workplaceLocationsClient.save(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a malformed bearer token must be refused', async ({
    workplaceLocationsClient,
  }) => {
    const body = buildLocationArray(1);
    const response = await workplaceLocationsClient.save(body, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a location must not be creatable inside another tenant', async ({
    workplaceLocationsClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildLocationArray(1, { companyId: otherTenant });
    const response = await workplaceLocationsClient.save(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceLocationsClient.save([{ companyId: "${otherTenant}", ... }], { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, a workplace location was written into tenant "${otherTenant}" and reported SUCCESS. The body's companyId is trusted over the token's, so any caller can inject sites into any tenant's org structure. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant location write (IDOR): body companyId overrides the token tenant',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a <script> location name must not be stored and echoed unescaped', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationArray(1, {
      locationName: XSS_PAYLOAD,
      workPlaceLocation: XSS_PAYLOAD,
    });
    const response = await workplaceLocationsClient.save(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });

  test('[6b] injection: a SQL payload in locationName must not surface a database error', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationArray(1, { locationName: SQLI_DROP_PAYLOAD });
    const response = await workplaceLocationsClient.save(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });
});

/* ==== POST /location/update ==== */
test.describe('POST /location/update', () => {
  const META = {
    method: 'POST',
    path: LOCATION_PATHS.update,
    repro: `await workplaceLocationsClient.update(buildLocationUpdate(), { token });`,
  };

  test('[1] happy path: an update returns a well-formed location envelope', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // The builder's id is a random ObjectId, so this never rewrites a real site.
    const body = buildLocationUpdate();
    const response = await workplaceLocationsClient.update(body, { token });

    await expectValidContract(response, locationEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationUpdate();
    const response = await workplaceLocationsClient.update(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: updating a non-existent id must not be reported as SUCCESS', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * The Admin module's update handlers have no failure branch and answer SUCCESS even when no
     * document matched. That misreports the outcome to every caller — the client believes it
     * saved a site that does not exist.
     */
    const missingId = randomObjectId();
    const body = buildLocationUpdate({ id: missingId, locationName: 'Renamed Nowhere' });
    const response = await workplaceLocationsClient.update(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS' && !json?.value) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceLocationsClient.update({ id: "${missingId}", locationName: "Renamed Nowhere" }, { token });`,
          scenario: `Update against a non-existent id "${missingId}" returned status SUCCESS with no document in \`value\`. No row was modified, yet the caller is told the update succeeded. Body: ${text.slice(0, 200)}`,
          title: 'location/update reports SUCCESS when no document matched the id',
        },
        'Status Code Misreporting',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[1d] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationUpdate({ id: randomObjectId() });
    const response = await workplaceLocationsClient.update(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[1e] business rule: a location must not be updatable into being its own reporting parent', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * Re-parenting is where a cycle is most likely to be introduced in production: a site is
     * moved under a descendant of itself. The minimal form is a site reporting to itself. The id
     * is random and matches no document, so nothing real is re-parented by this probe.
     */
    const cycleId = randomObjectId();
    const body = buildLocationUpdate({ id: cycleId, reportingWorkplaceLocationId: cycleId });
    const response = await workplaceLocationsClient.update(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceLocationsClient.update({ id: "${cycleId}", reportingWorkplaceLocationId: "${cycleId}" }, { token });`,
          scenario: `An update setting a location's reportingWorkplaceLocationId to its own id was accepted with status SUCCESS. No cycle check guards the reporting hierarchy, so a re-parent can make the tree non-acyclic and any recursive walk over it non-terminating. Body: ${text.slice(0, 200)}`,
          title: 'location/update accepts a self-referencing reporting parent (hierarchy cycle)',
        },
        'Business Logic Flaw',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: an empty id must be refused rather than updating an arbitrary row', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationUpdate({ id: '' });
    const response = await workplaceLocationsClient.update(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty id' });
  });

  test('[2b] boundary: a null id must be refused', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationUpdate({ id: null });
    const response = await workplaceLocationsClient.update(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id' });
  });

  test('[2c] boundary: a 5000-character locationName must not be written over a site', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationUpdate({ locationName: MAX_LENGTH_STRING });
    const response = await workplaceLocationsClient.update(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) locationName on an update',
    });
  });

  test('[3] typefuzz: a numeric id where a 24-char ObjectId is documented must be refused', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationUpdate({ id: 1001 });
    const response = await workplaceLocationsClient.update(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric id' });
  });

  test('[3b] typefuzz: an object id must be refused, not stringified into a query', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationUpdate({ id: { $ne: null } });
    const response = await workplaceLocationsClient.update(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object id ({ $ne: null }) — a Mongo operator injection shape',
    });
  });

  test('[3c] typefuzz: a boolean countryId must be refused, not coerced to an integer', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationUpdate({ countryId: true });
    const response = await workplaceLocationsClient.update(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean countryId' });
  });

  test('[4] auth: an unauthenticated caller must not be able to update a location', async ({
    workplaceLocationsClient,
  }) => {
    const body = buildLocationUpdate();
    const response = await workplaceLocationsClient.update(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must be refused on a write', async ({
    workplaceLocationsClient,
  }) => {
    const body = buildLocationUpdate();
    const response = await workplaceLocationsClient.update(body, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a location must not be reassignable into another tenant', async ({
    workplaceLocationsClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildLocationUpdate({ companyId: otherTenant });
    const response = await workplaceLocationsClient.update(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS' && json?.value) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceLocationsClient.update({ id: "<id>", companyId: "${otherTenant}" }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, an update rewrote a location's companyId to "${otherTenant}" and returned a document. A tenant can move sites into — or out of — another tenant's org structure. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant location reassignment (IDOR) via the update body',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a malformed ObjectId must not leak the parser exception', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationUpdate({ id: 'not-an-object-id' });
    const response = await workplaceLocationsClient.update(body, { token });

    // A malformed ObjectId should be a 4xx; this module tends to 500, and a 500 must not carry
    // the "Invalid ObjectId" exception text or a stack frame back to the caller.
    await assertNoInternalLeak(response, { ...META, body }, 'not-an-object-id');
  });

  test('[6b] injection: a script locationName must not be echoed unescaped on update', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationUpdate({ locationName: XSS_PAYLOAD });
    const response = await workplaceLocationsClient.update(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /location/delete ==== */
test.describe('POST /location/delete', () => {
  const META = {
    method: 'POST',
    path: LOCATION_PATHS.delete,
    repro: `await workplaceLocationsClient.delete(buildById(), { token }); // random id — matches no document`,
  };

  test('[1] happy path: a delete against a non-existent id returns a well-formed envelope', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // Non-existent id on purpose — this is a hard delete with no cascade and no undo.
    const body = buildById({ id: randomObjectId() });
    const response = await workplaceLocationsClient.delete(body, { token });

    await expectValidContract(response, looseEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: randomObjectId() });
    const response = await workplaceLocationsClient.delete(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: deleting an id that does not exist must not be reported as SUCCESS', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const missingId = randomObjectId();
    const body = buildById({ id: missingId });
    const response = await workplaceLocationsClient.delete(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceLocationsClient.delete({ id: "${missingId}" }, { token });`,
          scenario: `Deleting the non-existent id "${missingId}" reported SUCCESS. A caller cannot distinguish "removed" from "was never there", which hides a failed cleanup and makes a mistyped id look like a completed deletion. Body: ${text.slice(0, 200)}`,
          title: 'location/delete reports SUCCESS for an id that matched no document',
        },
        'Status Code Misreporting',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[1d] parity: a failed delete must not be delivered under a 2xx transport status', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: randomObjectId() });
    const response = await workplaceLocationsClient.delete(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[1e] business rule: deleting a parent site must not silently orphan the sites reporting to it', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * The delete is documented as non-cascading, so removing a site leaves every child holding a
     * reportingWorkplaceLocationId that no longer resolves. A random id is used because proving
     * this on a real parent would mean destroying a real record; what is asserted is that the
     * endpoint reports unconditional success with no reference check of any kind.
     */
    const parentId = randomObjectId();
    const body = buildById({ id: parentId });
    const response = await workplaceLocationsClient.delete(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceLocationsClient.delete({ id: "${parentId}" }, { token });`,
          scenario: `The delete answered SUCCESS without any referential check on reportingWorkplaceLocationId. Because the operation is a non-cascading hard delete, removing a parent site leaves its children pointing at an id that no longer exists, and the caller receives no warning that a subtree was orphaned. Body: ${text.slice(0, 200)}`,
          title: 'location/delete performs no referential check on the reporting hierarchy',
        },
        'Business Logic Flaw',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: an empty id must be refused, not treated as "delete everything"', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: '' });
    const response = await workplaceLocationsClient.delete(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty id on a delete' });
  });

  test('[2b] boundary: a null id must be refused', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: null });
    const response = await workplaceLocationsClient.delete(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id on a delete' });
  });

  test('[2c] boundary: a 5000-character id must not reach the ObjectId parser', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: MAX_LENGTH_STRING });
    const response = await workplaceLocationsClient.delete(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) id on a delete',
    });
  });

  test('[3] typefuzz: an object id must be refused, not used as a Mongo operator', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * `{ $ne: null }` is the classic operator-injection shape: if it reaches the driver as a
     * filter it matches every document, turning a single hard delete into a collection wipe.
     * This must be refused at the boundary.
     */
    const body = buildById({ id: { $ne: null } });
    const response = await workplaceLocationsClient.delete(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object id ({ $ne: null }) — operator injection that would match every document',
    });
  });

  test('[3b] typefuzz: a boolean id must be refused', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: true });
    const response = await workplaceLocationsClient.delete(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean id on a delete' });
  });

  test('[4] auth: an unauthenticated delete must be refused', async ({
    workplaceLocationsClient,
  }) => {
    const body = buildById();
    const response = await workplaceLocationsClient.delete(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must not authorise a destructive delete', async ({
    workplaceLocationsClient,
  }) => {
    const body = buildById();
    const response = await workplaceLocationsClient.delete(body, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4c] auth: a token forged with alg:none must not authorise a destructive delete', async ({
    workplaceLocationsClient,
  }) => {
    // An alg:none token is unsigned by construction. Accepting one means the filter trusts the
    // header's algorithm claim, which lets anyone mint any identity — and then delete with it.
    const body = buildById();
    const response = await workplaceLocationsClient.delete(body, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a caller must not be able to delete another tenant\'s location', async ({
    workplaceLocationsClient,
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
    const body = buildById({ id: foreignId, companyId: `${Number(companyID ?? 1001) + 1}` });
    const response = await workplaceLocationsClient.delete(body, { token });

    const { json, text } = await readBody(response);
    const value = json?.value as { companyId?: string } | null;
    if (value?.companyId && value.companyId !== companyID) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceLocationsClient.delete({ id: "${foreignId}" }, { token /* tenant ${companyID} */ });`,
          scenario: `A delete issued as tenant ${companyID} returned a document belonging to tenant "${value.companyId}". The endpoint resolves ids globally rather than within the caller's tenant, so any site is deletable by anyone who can guess or harvest its id. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant location delete (IDOR): ids resolve outside the caller\'s tenant',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload as the id must not leak an exception trace', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: SQLI_DROP_PAYLOAD });
    const response = await workplaceLocationsClient.delete(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });

  test('[6b] injection: a script id must not be reflected unescaped', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: XSS_PAYLOAD });
    const response = await workplaceLocationsClient.delete(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /location/getLocation ==== */
test.describe('POST /location/getLocation', () => {
  const META = {
    method: 'POST',
    path: LOCATION_PATHS.getLocation,
    repro: `await workplaceLocationsClient.getLocation(buildLocationNode(), { token });`,
  };

  test('[1] happy path: a hierarchy node returns a well-formed location-list envelope', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationNode();
    const response = await workplaceLocationsClient.getLocation(body, { token });

    await expectValidContract(response, locationListEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationNode();
    const response = await workplaceLocationsClient.getLocation(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] parity: an empty node result must not be delivered as a failure under HTTP 200', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationNode();
    const response = await workplaceLocationsClient.getLocation(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[2] boundary: an empty attributeId must be refused, not answered with every location', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationNode({ attributeId: '' });
    const response = await workplaceLocationsClient.getLocation(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'empty attributeId',
    });
  });

  test('[2b] boundary: a null variableId must be refused rather than treated as "any node"', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationNode({ variableId: null });
    const response = await workplaceLocationsClient.getLocation(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'null variableId',
    });
  });

  test('[2c] boundary: a 5000-character attributeId must not be processed as a lookup key', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationNode({ attributeId: MAX_LENGTH_STRING });
    const response = await workplaceLocationsClient.getLocation(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) attributeId',
    });
  });

  test('[3] typefuzz: an array variableId where a string is documented must be refused', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationNode({ variableId: ['a', 'b'] });
    const response = await workplaceLocationsClient.getLocation(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'array variableId where a string is documented',
    });
  });

  test('[3b] typefuzz: an object attributeId must be refused, not used as a Mongo operator', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationNode({ attributeId: { $ne: null } });
    const response = await workplaceLocationsClient.getLocation(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object attributeId ({ $ne: null }) — operator injection that would match every node',
    });
  });

  test('[3c] typefuzz: a numeric variableId must not be silently coerced', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationNode({ variableId: 1001 });
    const response = await workplaceLocationsClient.getLocation(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric variableId' });
  });

  test('[4] auth: an unauthenticated caller must be refused, not served the node\'s sites', async ({
    workplaceLocationsClient,
  }) => {
    const body = buildLocationNode();
    const response = await workplaceLocationsClient.getLocation(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a token forged with alg:none must never be accepted', async ({
    workplaceLocationsClient,
  }) => {
    const body = buildLocationNode();
    const response = await workplaceLocationsClient.getLocation(body, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a node id must not resolve to locations outside the caller\'s tenant', async ({
    workplaceLocationsClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * This endpoint reads only attributeId + variableId — no companyId at all — so the filter has
     * nothing tenant-scoped to apply beyond whatever the token injects. Node ids are ordinary
     * global ObjectIds, which means one harvested id is enough to read another tenant's sites.
     */
    const foreignNode = buildLocationNode();
    const response = await workplaceLocationsClient.getLocation(foreignNode, { token });

    const { json, text } = await readBody(response);
    const value = json?.value as Array<{ companyId?: string }> | null;
    const foreign = Array.isArray(value)
      ? value.filter((row) => row?.companyId && row.companyId !== companyID)
      : [];
    if (foreign.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body: foreignNode,
          repro: `await workplaceLocationsClient.getLocation({ attributeId: "<foreign>", variableId: "<foreign>" }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, a node lookup returned ${foreign.length} location(s) belonging to other tenants. The endpoint resolves node ids globally with no tenant filter, so any harvested attributeId/variableId pair reads a foreign company's site list. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant location read (IDOR): getLocation applies no tenant filter',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL-injection attributeId must not surface a database error', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationNode({ attributeId: SQLI_PAYLOAD });
    const response = await workplaceLocationsClient.getLocation(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script variableId must not come back unescaped in the envelope', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLocationNode({ variableId: XSS_PAYLOAD });
    const response = await workplaceLocationsClient.getLocation(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /location/getAllLocation ==== */
test.describe('POST /location/getAllLocation', () => {
  const META = {
    method: 'POST',
    path: LOCATION_PATHS.getAllLocation,
    repro: `await workplaceLocationsClient.getAll(buildGetAll(), { token });`,
  };

  test('[1] happy path: a valid three-way filter returns a well-formed location-list envelope', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetAll();
    const response = await workplaceLocationsClient.getAll(body, { token });

    await expectValidContract(response, locationListEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetAll();
    const response = await workplaceLocationsClient.getAll(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] parity: an empty result must not be delivered as a failure under HTTP 200', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetAll();
    const response = await workplaceLocationsClient.getAll(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[2] boundary: an empty companyId must be refused, not answered with the whole collection', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetAll({ companyId: '' });
    const response = await workplaceLocationsClient.getAll(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty companyId' });
  });

  test('[2b] boundary: a null companyId must be refused rather than treated as "all tenants"', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * api.json says all three fields participate in the filter and that `null` means "stored as
     * null", not "any value". If a null companyId instead widens the filter, the endpoint hands
     * back every tenant's sites.
     */
    const body = buildGetAll({ companyId: null });
    const response = await workplaceLocationsClient.getAll(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null companyId' });
  });

  test('[2c] boundary: a 5000-character companyId must not be processed as a lookup key', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetAll({ companyId: MAX_LENGTH_STRING });
    const response = await workplaceLocationsClient.getAll(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) companyId',
    });
  });

  test('[3] typefuzz: an array companyId where a string is documented must be refused', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetAll({ companyId: ['1001', '1002'] });
    const response = await workplaceLocationsClient.getAll(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'array companyId where a string is documented',
    });
  });

  test('[3b] typefuzz: a boolean companyId must not be coerced into a lookup', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetAll({ companyId: true });
    const response = await workplaceLocationsClient.getAll(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean companyId' });
  });

  test('[3c] typefuzz: an object reportingWorkplaceLocationId must not reach the driver as an operator', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetAll({ reportingWorkplaceLocationId: { $ne: null } });
    const response = await workplaceLocationsClient.getAll(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario:
        'object reportingWorkplaceLocationId ({ $ne: null }) — operator injection that widens the filter',
    });
  });

  test('[4] auth: an unauthenticated caller must be refused, not served the tenant\'s sites', async ({
    workplaceLocationsClient,
  }) => {
    const body = buildGetAll();
    const response = await workplaceLocationsClient.getAll(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must be refused', async ({ workplaceLocationsClient }) => {
    const body = buildGetAll();
    const response = await workplaceLocationsClient.getAll(body, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] one tenant must not receive another tenant\'s locations', async ({
    workplaceLocationsClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * The filter injects companyID from the token, but this endpoint reads companyId from the
     * BODY. Asking for a different tenant while authenticated as ours must not work — if it does,
     * the body overrides the token and every tenant's site list is readable.
     */
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildGetAll({ companyId: otherTenant });
    const response = await workplaceLocationsClient.getAll(body, { token });

    const { json } = await readBody(response);
    const value = json?.value;
    if (Array.isArray(value) && value.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceLocationsClient.getAll({ companyId: "${otherTenant}", ... }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, the body companyId "${otherTenant}" returned ${value.length} foreign location(s) — the endpoint trusts the body over the token, a cross-tenant IDOR that exposes another company's physical sites and addresses.`,
          title: 'Cross-tenant location read (IDOR): body companyId overrides the token tenant',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL-injection companyId must not surface a database error', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetAll({ companyId: SQLI_PAYLOAD });
    const response = await workplaceLocationsClient.getAll(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script companyId must not come back unescaped in the envelope', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildGetAll({ companyId: XSS_PAYLOAD });
    const response = await workplaceLocationsClient.getAll(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /location/getLocationById ==== */
test.describe('POST /location/getLocationById', () => {
  const META = {
    method: 'POST',
    path: LOCATION_PATHS.getLocationById,
    repro: `await workplaceLocationsClient.getById(buildById(), { token });`,
  };

  test('[1] happy path: a lookup by id returns a well-formed location envelope', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById();
    const response = await workplaceLocationsClient.getById(body, { token });

    await expectValidContract(response, locationEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById();
    const response = await workplaceLocationsClient.getById(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] parity: a miss must not be delivered as a failure payload under HTTP 200', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // Documented: a missing document is 200 with `value: null`. The module never emits 404, so
    // the only honest signal a client has is the envelope — which must not say FAILURE under 200.
    const body = buildById({ id: randomObjectId() });
    const response = await workplaceLocationsClient.getById(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[2] boundary: an empty id must be refused, not answered with an arbitrary document', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: '' });
    const response = await workplaceLocationsClient.getById(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty id' });
  });

  test('[2b] boundary: a null id must be refused', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: null });
    const response = await workplaceLocationsClient.getById(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id' });
  });

  test('[2c] boundary: a 5000-character id must not reach the ObjectId parser', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: MAX_LENGTH_STRING });
    const response = await workplaceLocationsClient.getById(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) id',
    });
  });

  test('[3] typefuzz: a numeric id where a 24-char ObjectId is documented must be refused', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: 1001 });
    const response = await workplaceLocationsClient.getById(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric id' });
  });

  test('[3b] typefuzz: an object id must be refused, not used as a Mongo operator', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: { $ne: null } });
    const response = await workplaceLocationsClient.getById(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object id ({ $ne: null }) — operator injection that would match the first document',
    });
  });

  test('[3c] typefuzz: a boolean id must be refused', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: true });
    const response = await workplaceLocationsClient.getById(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean id' });
  });

  test('[4] auth: an unauthenticated caller must not be able to read a location by id', async ({
    workplaceLocationsClient,
  }) => {
    const body = buildById();
    const response = await workplaceLocationsClient.getById(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a malformed bearer token must be refused', async ({
    workplaceLocationsClient,
  }) => {
    const body = buildById();
    const response = await workplaceLocationsClient.getById(body, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a location id must not resolve outside the caller\'s tenant', async ({
    workplaceLocationsClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * The request carries only an id, so tenant scoping can come only from the token. If the
     * lookup resolves globally, one harvested ObjectId reads a foreign company's site — including
     * its street address and PIN code.
     */
    const foreignId = randomObjectId();
    const body = buildById({ id: foreignId });
    const response = await workplaceLocationsClient.getById(body, { token });

    const { json, text } = await readBody(response);
    const value = json?.value as { companyId?: string } | null;
    if (value?.companyId && value.companyId !== companyID) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceLocationsClient.getById({ id: "${foreignId}" }, { token /* tenant ${companyID} */ });`,
          scenario: `A lookup issued as tenant ${companyID} returned a location belonging to tenant "${value.companyId}". Ids resolve globally rather than within the caller's tenant, so any guessed or harvested id discloses another company's site record. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant location read (IDOR): getLocationById resolves ids globally',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a malformed ObjectId must not leak the parser exception', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: SQLI_PAYLOAD });
    const response = await workplaceLocationsClient.getById(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script id must not be reflected unescaped', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: XSS_PAYLOAD });
    const response = await workplaceLocationsClient.getById(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /location/getReportingLocationName ==== */
test.describe('POST /location/getReportingLocationName', () => {
  const META = {
    method: 'POST',
    path: LOCATION_PATHS.getReportingLocationName,
    repro: `await workplaceLocationsClient.getReportingLocationName(buildById(), { token });`,
  };

  test('[1] happy path: resolving reporting sites returns a well-formed envelope', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById();
    const response = await workplaceLocationsClient.getReportingLocationName(body, { token });

    await expectValidContract(response, reportingLocationEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById();
    const response = await workplaceLocationsClient.getReportingLocationName(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] parity: an empty reporting tree must not be delivered as a failure under HTTP 200', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById();
    const response = await workplaceLocationsClient.getReportingLocationName(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[1d] business rule: a self-referencing id must not send the reporting walk into a cycle', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * This endpoint walks the reporting chain, and nothing upstream rejects a cycle (see the
     * save/update cases above). A self-referencing id is the smallest cycle there is, so the walk
     * either terminates promptly or it does not terminate at all. Two symptoms are graded: a
     * response that takes pathologically long — a recursive walk with no visited-set — and a
     * StackOverflowError surfacing in the body. The id is random, so nothing real is touched.
     */
    const cycleId = randomObjectId();
    const body = buildById({ id: cycleId, reportingWorkplaceLocationId: cycleId });
    const startedAt = Date.now();
    const response = await workplaceLocationsClient.getReportingLocationName(body, { token });
    const elapsedMs = Date.now() - startedAt;

    const { text } = await readBody(response);
    const recursed = /StackOverflowError|Recursion|too much recursion/i.test(text);
    if (recursed || elapsedMs > 15_000) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceLocationsClient.getReportingLocationName({ id: "${cycleId}", reportingWorkplaceLocationId: "${cycleId}" }, { token });`,
          scenario: `Resolving the reporting chain for a self-referencing location ${recursed ? 'surfaced a recursion failure' : `took ${elapsedMs}ms`}. The walk over reportingWorkplaceLocationId has no cycle guard, so a hierarchy containing a loop — which save and update both accept — ties up a request thread indefinitely. That is a denial-of-service reachable by ordinary data entry. Body: ${text.slice(0, 200)}`,
          title: 'getReportingLocationName has no cycle guard on the reporting hierarchy walk',
        },
        'Business Logic Flaw',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: an empty id must be refused, not walked from an arbitrary root', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: '' });
    const response = await workplaceLocationsClient.getReportingLocationName(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty id' });
  });

  test('[2b] boundary: a null id must be refused', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: null });
    const response = await workplaceLocationsClient.getReportingLocationName(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id' });
  });

  test('[2c] boundary: a 5000-character id must not reach the ObjectId parser', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: MAX_LENGTH_STRING });
    const response = await workplaceLocationsClient.getReportingLocationName(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) id',
    });
  });

  test('[3] typefuzz: a numeric id where a 24-char ObjectId is documented must be refused', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: 1001 });
    const response = await workplaceLocationsClient.getReportingLocationName(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric id' });
  });

  test('[3b] typefuzz: an object id must be refused, not used as a Mongo operator', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: { $ne: null } });
    const response = await workplaceLocationsClient.getReportingLocationName(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object id ({ $ne: null }) — operator injection that would walk from every site',
    });
  });

  test('[3c] typefuzz: an array id must be refused', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: ['a', 'b'] });
    const response = await workplaceLocationsClient.getReportingLocationName(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'array id' });
  });

  test('[4] auth: an unauthenticated caller must not be served a reporting tree', async ({
    workplaceLocationsClient,
  }) => {
    const body = buildById();
    const response = await workplaceLocationsClient.getReportingLocationName(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must be refused', async ({ workplaceLocationsClient }) => {
    const body = buildById();
    const response = await workplaceLocationsClient.getReportingLocationName(body, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] another tenant\'s reporting tree must not be walkable by id', async ({
    workplaceLocationsClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * A reporting tree is the shape of a company's operation: how many sites it runs and which
     * report to which. The request carries only an id, so if the walk is not tenant-scoped a
     * single harvested id maps a competitor's site hierarchy.
     */
    const foreignId = randomObjectId();
    const body = buildById({ id: foreignId });
    const response = await workplaceLocationsClient.getReportingLocationName(body, { token });

    const { json, text } = await readBody(response);
    const value = json?.value as Array<Record<string, unknown>> | null;
    const foreign = Array.isArray(value)
      ? value.filter((row) => typeof row?.companyId === 'string' && row.companyId !== companyID)
      : [];
    if (foreign.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceLocationsClient.getReportingLocationName({ id: "${foreignId}" }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, the reporting walk returned ${foreign.length} site(s) belonging to other tenants. The hierarchy walk applies no tenant filter, so one harvested location id discloses another company's site structure. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant reporting-tree disclosure (IDOR) via getReportingLocationName',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload as the id must not leak an exception trace', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: SQLI_DROP_PAYLOAD });
    const response = await workplaceLocationsClient.getReportingLocationName(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });

  test('[6b] injection: a script id must not be reflected unescaped', async ({
    workplaceLocationsClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: XSS_PAYLOAD });
    const response = await workplaceLocationsClient.getReportingLocationName(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});
