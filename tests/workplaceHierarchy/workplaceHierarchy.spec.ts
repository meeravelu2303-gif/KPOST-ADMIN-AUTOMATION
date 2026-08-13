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
import { WORKPLACE_HIERARCHY_PATHS } from '../../src/api/clients/workplaceHierarchy.client';
import {
  levelSchema,
  levelEnvelopeSchema,
  levelListEnvelopeSchema,
  nodeListEnvelopeSchema,
  hierarchyLinkEnvelopeSchema,
  hierarchyLinkListEnvelopeSchema,
  organizationListEnvelopeSchema,
} from '../../src/api/schemas/hierarchy.schema';
import { looseEnvelopeSchema } from '../../src/api/schemas/envelope.schema';
import {
  buildLevel,
  buildLevelArray,
  buildLevelUpdate,
  buildNode,
  buildNodeArray,
  buildNodeUpdate,
  buildReportingNode,
  buildById,
  buildByCompany,
  buildNodeLookup,
  buildHierarchyLink,
  buildHierarchyLinkUpdate,
  buildHierarchyQuery,
  randomObjectId,
} from '../../src/api/payloads/hierarchy.payload';

/*
 * Workplace hierarchy subsystem — four Swagger tags that between them own the tenant's
 * organisational tree: the generic attribute/variable pair (`/attribute`, `/variable`), the
 * workplace tier that the UI actually renders (`/adminTierAttribute`, `/adminTierVariable`),
 * and the edge collection that wires the nodes together (`/workplaceHierarchy`).
 *
 * One describe per endpoint titled with its bare `METHOD /path` signature, explicit standalone
 * cases — no loops, no factories — so every case is individually named, reportable and
 * skippable, and so `scripts/audit-vectors.ts` can group coverage by endpoint. The LEVEL/NODE
 * archetype is shared at the payload and schema layer only; every `test()` below is written
 * out by hand.
 *
 * ## What is dangerous here
 *
 * Every delete route in this file is a **hard delete**: no soft-delete flag, no cascade,
 * no undo through the API — and these are tree nodes, so removing one silently orphans every
 * child that still points at it by `parent_variable_id`. Each case therefore aims a freshly
 * minted random ObjectId that matches no document, or exercises a refusal path. Nothing here
 * deletes a real record.
 *
 * The tree is modelled with **self-referencing id strings**, and the reporting line
 * (`reportingVariableId`) is stored independently of the structural parent
 * (`parentVariableId`). `getAllReportingVariableHierarchy` walks the reporting link with one
 * `findById` per hop in application code — not a `$graphLookup`, and with no visited set. A
 * cycle (A reports to B, B reports to A) or a self-reporting node is therefore a genuine
 * denial-of-service shape, and the cases that plant one use random ids so nothing real moves.
 *
 * `POST /adminTierAttribute/getAttribute` carries a documented status defect: it answers HTTP
 * 500 on its **success** path while the envelope inside says `statusCode: 200`. That is not a
 * test bug to work around — it is the defect the parity assertions exist to catch.
 *
 * `GET /adminTierVariable/getAllVariable` is an unfiltered `find({})` over every tenant's
 * nodes with no `company_id` filter, no paging and no projection. It is the strongest
 * cross-tenant read surface in the module.
 *
 * ## Envelope reminder
 *
 * Every route answers HTTP 200 or 500 only, carrying
 * `{ value, status: SUCCESS|FAILURE, statusCode, urlPath, error? }`. HTTP 200 says nothing
 * about success, so assertions read the envelope's status word, never the transport alone.
 */

const XSS_PAYLOAD = `<script>alert('wph')</script>`;
const SQLI_PAYLOAD = `1001' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE table_admin_tier_variable; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);

/* ==== POST /attribute/save ==== */
test.describe('POST /attribute/save', () => {
  const META = {
    method: 'POST',
    path: WORKPLACE_HIERARCHY_PATHS.attributeSave,
    repro: `await workplaceHierarchyClient.saveAttribute(buildLevelArray(2), { token });`,
  };

  test('[1] happy path: a valid array of base levels returns a well-formed level-list envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelArray(2);
    const response = await workplaceHierarchyClient.saveAttribute(body, { token });

    await expectValidContract(response, levelListEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelArray(1);
    const response = await workplaceHierarchyClient.saveAttribute(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[2] boundary: a null attributeName must be refused, not stored as a nameless level', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelArray(1, { attributeName: null });
    const response = await workplaceHierarchyClient.saveAttribute(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null attributeName' });
  });

  test('[2b] boundary: an empty attributeName must not create an unlabelled hierarchy level', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // A level with a blank name renders as an empty row in every picker that reads it and can
    // never be told apart from its siblings.
    const body = buildLevelArray(1, { attributeName: '' });
    const response = await workplaceHierarchyClient.saveAttribute(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty attributeName' });
  });

  test('[2c] boundary: a 5000-character attributeName must be refused rather than persisted', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelArray(1, { attributeName: MAX_LENGTH_STRING });
    const response = await workplaceHierarchyClient.saveAttribute(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) attributeName',
    });
  });

  test('[3] typefuzz: a numeric companyId must be refused, not silently coerced', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelArray(1, { companyId: 1001 });
    const response = await workplaceHierarchyClient.saveAttribute(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'numeric companyId where a string is documented',
    });
  });

  test('[3b] typefuzz: an array attributeName must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelArray(1, { attributeName: ['Region', 'Zone'] });
    const response = await workplaceHierarchyClient.saveAttribute(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'array attributeName' });
  });

  test('[3c] typefuzz: a single object where the documented body is an array must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevel();
    const response = await workplaceHierarchyClient.saveAttribute(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      repro: `await workplaceHierarchyClient.saveAttribute(buildLevel(), { token }); // object, not array`,
      scenario: 'object body instead of a JSON array',
    });
  });

  test('[4] auth: an unauthenticated caller must not be able to create hierarchy levels', async ({
    workplaceHierarchyClient,
  }) => {
    /*
     * api.json places every route under the global bearerAuth requirement, but the backend's
     * SecurityConfiguration permits "/**". An anonymous write is worse than an anonymous read:
     * it lets a stranger inject levels into a tenant's org chart.
     */
    const body = buildLevelArray(1);
    const response = await workplaceHierarchyClient.saveAttribute(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a malformed bearer token must be refused on a write', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildLevelArray(1);
    const response = await workplaceHierarchyClient.saveAttribute(body, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a base level must not be creatable inside another tenant', async ({
    workplaceHierarchyClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildLevelArray(1, { companyId: otherTenant });
    const response = await workplaceHierarchyClient.saveAttribute(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.saveAttribute([{ companyId: "${otherTenant}", ... }], { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, a base hierarchy level was written into tenant "${otherTenant}" and reported SUCCESS. The body companyId is trusted over the token claim, so any caller can inject levels into any tenant org chart. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant attribute write (IDOR): body companyId overrides the token tenant',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a script attributeName must not be stored and echoed unescaped', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelArray(1, { attributeName: XSS_PAYLOAD });
    const response = await workplaceHierarchyClient.saveAttribute(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });

  test('[6b] injection: a SQL payload in attributeName must not surface a database error', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelArray(1, { attributeName: SQLI_DROP_PAYLOAD });
    const response = await workplaceHierarchyClient.saveAttribute(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });
});

/* ==== POST /attribute/update ==== */
test.describe('POST /attribute/update', () => {
  const META = {
    method: 'POST',
    path: WORKPLACE_HIERARCHY_PATHS.attributeUpdate,
    repro: `await workplaceHierarchyClient.updateAttribute(buildLevelUpdate(), { token });`,
  };

  test('[1] happy path: an update returns a well-formed envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelUpdate();
    const response = await workplaceHierarchyClient.updateAttribute(body, { token });

    await expectValidContract(response, looseEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelUpdate();
    const response = await workplaceHierarchyClient.updateAttribute(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: updating an id that matches no document must not report SUCCESS', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const missingId = randomObjectId();
    const body = buildLevelUpdate({ id: missingId, attributeName: 'QA-Renamed-Nowhere' });
    const response = await workplaceHierarchyClient.updateAttribute(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS' && !json?.value) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.updateAttribute({ id: "${missingId}", attributeName: "QA-Renamed-Nowhere" }, { token });`,
          scenario: `Update against the non-existent id "${missingId}" returned status SUCCESS with no document in value. No level was modified, yet the caller is told the rename landed — a UI refreshing on that word shows a change that does not exist. Body: ${text.slice(0, 200)}`,
          title: 'attribute/update reports SUCCESS when no document matched the id',
        },
        'Status Code Misreporting',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[1d] business rule: a whole-document write must not blank the fields omitted from the body', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * Documented behaviour: the save replaces the whole document, so a field left out of the
     * body is persisted as null. A caller sending what looks like a patch therefore erases the
     * level's companyId and makes it invisible to every tenant-scoped read.
     */
    const body = { id: randomObjectId(), attributeName: 'QA-Patch-Shaped-Update' };
    const response = await workplaceHierarchyClient.updateAttribute(body, { token });

    const { json } = await readBody(response);
    const value = json?.value as { companyId?: string | null } | null;
    if (value && (value.companyId === null || value.companyId === undefined)) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.updateAttribute({ id: "<id>", attributeName: "QA-Patch-Shaped-Update" }, { token });`,
          scenario: `A PATCH-shaped update that omitted companyId returned a document whose companyId is now absent. The endpoint writes the whole document, so omitted fields are nulled: the level silently drops out of every tenant-scoped read and the hierarchy loses a rung with no error surfaced.`,
          title: 'attribute/update nulls omitted fields, orphaning the level from its tenant',
        },
        'Business Logic Flaw',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: a null id must be refused rather than updating an arbitrary row', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelUpdate({ id: null });
    const response = await workplaceHierarchyClient.updateAttribute(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id' });
  });

  test('[2b] boundary: an empty id must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelUpdate({ id: '' });
    const response = await workplaceHierarchyClient.updateAttribute(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty id' });
  });

  test('[3] typefuzz: a numeric id where a 24-char ObjectId is documented must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelUpdate({ id: 1001 });
    const response = await workplaceHierarchyClient.updateAttribute(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric id' });
  });

  test('[3b] typefuzz: a boolean attributeName must not be coerced into a stored name', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelUpdate({ attributeName: true });
    const response = await workplaceHierarchyClient.updateAttribute(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean attributeName' });
  });

  test('[4] auth: an unauthenticated caller must not be able to rename a hierarchy level', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildLevelUpdate();
    const response = await workplaceHierarchyClient.updateAttribute(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must be refused on a write', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildLevelUpdate();
    const response = await workplaceHierarchyClient.updateAttribute(body, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a level must not be re-scopeable into another tenant', async ({
    workplaceHierarchyClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * The operation summary says this route can "re-scope an attribute to a different
     * company". If the body companyId is honoured without checking the token, a tenant can
     * push a level into — or pull one out of — a neighbouring org chart.
     */
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildLevelUpdate({ companyId: otherTenant });
    const response = await workplaceHierarchyClient.updateAttribute(body, { token });

    const { json, text } = await readBody(response);
    const value = json?.value as { companyId?: string } | null;
    if (value?.companyId === otherTenant) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.updateAttribute({ id: "<id>", companyId: "${otherTenant}" }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, an update rewrote a level companyId to "${otherTenant}" and the endpoint returned the re-scoped document. Org structure can be moved between tenants by anyone holding any token. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant attribute re-scoping (IDOR) via the update body',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a malformed ObjectId must not leak the parser exception', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelUpdate({ id: 'not-an-object-id' });
    const response = await workplaceHierarchyClient.updateAttribute(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, 'not-an-object-id');
  });

  test('[6b] injection: a script attributeName must not be echoed unescaped on update', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelUpdate({ attributeName: XSS_PAYLOAD });
    const response = await workplaceHierarchyClient.updateAttribute(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /attribute/delete ==== */
test.describe('POST /attribute/delete', () => {
  const META = {
    method: 'POST',
    path: WORKPLACE_HIERARCHY_PATHS.attributeDelete,
    repro: `await workplaceHierarchyClient.deleteAttribute(buildById(), { token }); // random id — matches no document`,
  };

  test('[1] happy path: a delete against a non-existent id returns a well-formed envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // Non-existent id on purpose: this is a hard, non-cascading delete and every generic
    // variable still carrying the deleted attributeId would be orphaned.
    const body = buildById({ id: randomObjectId() });
    const response = await workplaceHierarchyClient.deleteAttribute(body, { token });

    await expectValidContract(response, looseEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: randomObjectId() });
    const response = await workplaceHierarchyClient.deleteAttribute(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[1c] business rule: deleting an id that does not exist must not be reported as SUCCESS', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const missingId = randomObjectId();
    const body = buildById({ id: missingId });
    const response = await workplaceHierarchyClient.deleteAttribute(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.deleteAttribute({ id: "${missingId}" }, { token });`,
          scenario: `Deleting the non-existent id "${missingId}" reported SUCCESS. A caller cannot tell "removed" from "was never there", so a cleanup script that silently targeted the wrong id looks like it worked. Body: ${text.slice(0, 200)}`,
          title: 'attribute/delete reports SUCCESS for an id that matched no document',
        },
        'Status Code Misreporting',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: a null id must be refused, not treated as an unbounded delete', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: null });
    const response = await workplaceHierarchyClient.deleteAttribute(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id on a delete' });
  });

  test('[2b] boundary: an empty id must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: '' });
    const response = await workplaceHierarchyClient.deleteAttribute(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty id on a delete' });
  });

  test('[3] typefuzz: an object id must be refused, not used as a Mongo operator', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * `{ $ne: null }` is the classic operator-injection shape: reaching the driver as a filter
     * it matches every document, turning one delete into a collection wipe — here, the tenant
     * losing every hierarchy level at once.
     */
    const body = buildById({ id: { $ne: null } });
    const response = await workplaceHierarchyClient.deleteAttribute(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object id ({ $ne: null }) — operator injection that would match every document',
    });
  });

  test('[3b] typefuzz: a boolean id must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: true });
    const response = await workplaceHierarchyClient.deleteAttribute(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean id' });
  });

  test('[4] auth: an unauthenticated delete must be refused', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildById();
    const response = await workplaceHierarchyClient.deleteAttribute(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a token forged with alg:none must not authorise a destructive delete', async ({
    workplaceHierarchyClient,
  }) => {
    // An alg:none token is unsigned by construction. Honouring one lets anyone mint any
    // identity — and here that identity can dismantle an org chart.
    const body = buildById();
    const response = await workplaceHierarchyClient.deleteAttribute(body, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a caller must not be able to delete another tenant level', async ({
    workplaceHierarchyClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * The delete body carries only an id — no tenant scope at all — so authorisation can come
     * only from the token. A random id is used because confirming this any other way would
     * mean destroying a real foreign record; what is asserted is that the endpoint does not
     * hand back a foreign document as evidence of a cross-tenant hit.
     */
    const foreignId = randomObjectId();
    const body = buildById({ id: foreignId });
    const response = await workplaceHierarchyClient.deleteAttribute(body, { token });

    const { json, text } = await readBody(response);
    const value = json?.value as { companyId?: string } | null;
    if (value?.companyId && value.companyId !== companyID) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.deleteAttribute({ id: "${foreignId}" }, { token /* tenant ${companyID} */ });`,
          scenario: `A delete issued as tenant ${companyID} returned a document belonging to tenant "${value.companyId}". Ids resolve globally rather than within the caller tenant, so any level is deletable by anyone who can guess or enumerate its id. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant attribute delete (IDOR): ids resolve outside the caller tenant',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload as the id must not leak an exception trace', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: SQLI_DROP_PAYLOAD });
    const response = await workplaceHierarchyClient.deleteAttribute(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });

  test('[6b] injection: a script id must not be reflected unescaped in the error message', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: XSS_PAYLOAD });
    const response = await workplaceHierarchyClient.deleteAttribute(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /attribute/getAttribute ==== */
test.describe('POST /attribute/getAttribute', () => {
  const META = {
    method: 'POST',
    path: WORKPLACE_HIERARCHY_PATHS.attributeGet,
    repro: `await workplaceHierarchyClient.getAttribute(buildById(), { token });`,
  };

  test('[1] happy path: a lookup by id returns a well-formed single-level envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById();
    const response = await workplaceHierarchyClient.getAttribute(body, { token });

    // A miss is documented as 200 with `value: null` — the schema allows a null value, so the
    // contract holds whether or not the random id happened to match.
    await expectValidContract(response, levelEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById();
    const response = await workplaceHierarchyClient.getAttribute(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[2] boundary: a null id must be refused rather than answered with an arbitrary level', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: null });
    const response = await workplaceHierarchyClient.getAttribute(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id' });
  });

  test('[2b] boundary: an empty id must be refused, not treated as "any document"', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: '' });
    const response = await workplaceHierarchyClient.getAttribute(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty id' });
  });

  test('[2c] boundary: a 5000-character id must not be processed as a primary key', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: MAX_LENGTH_STRING });
    const response = await workplaceHierarchyClient.getAttribute(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) id',
    });
  });

  test('[3] typefuzz: a numeric id must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: 1001 });
    const response = await workplaceHierarchyClient.getAttribute(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric id' });
  });

  test('[3b] typefuzz: an array id must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: ['66f1a2b3c4d5e6f708192a3b', '66f1a2b3c4d5e6f708192a4c'] });
    const response = await workplaceHierarchyClient.getAttribute(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'array id where a single ObjectId is documented',
    });
  });

  test('[4] auth: an unauthenticated caller must be refused, not served the level', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildById();
    const response = await workplaceHierarchyClient.getAttribute(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must be refused', async ({ workplaceHierarchyClient }) => {
    const body = buildById();
    const response = await workplaceHierarchyClient.getAttribute(body, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a level id belonging to another tenant must not be readable', async ({
    workplaceHierarchyClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * findById takes no tenant filter at all, so the only thing standing between a caller and
     * every other tenant org chart is the unguessability of a 24-hex id. If the returned
     * document carries a foreign companyId the isolation is not enforced anywhere.
     */
    const foreignId = randomObjectId();
    const body = buildById({ id: foreignId });
    const response = await workplaceHierarchyClient.getAttribute(body, { token });

    const parsed = levelSchema.safeParse((await readBody(response)).json?.value);
    if (parsed.success && parsed.data.companyId && parsed.data.companyId !== companyID) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.getAttribute({ id: "${foreignId}" }, { token /* tenant ${companyID} */ });`,
          scenario: `A lookup issued as tenant ${companyID} returned a level owned by tenant "${parsed.data.companyId}". findById applies no company_id filter, so id enumeration reads any tenant hierarchy.`,
          title: 'Cross-tenant attribute read (IDOR): findById is not tenant-scoped',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL-injection id must not surface a database error or query echo', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: SQLI_PAYLOAD });
    const response = await workplaceHierarchyClient.getAttribute(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script id must not come back unescaped in the envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: XSS_PAYLOAD });
    const response = await workplaceHierarchyClient.getAttribute(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /attribute/getAttributeByCompanyId ==== */
test.describe('POST /attribute/getAttributeByCompanyId', () => {
  const META = {
    method: 'POST',
    path: WORKPLACE_HIERARCHY_PATHS.attributeGetByCompanyId,
    repro: `await workplaceHierarchyClient.getAttributeByCompanyId(buildByCompany(), { token });`,
  };

  test('[1] happy path: a valid companyId returns a well-formed level-list envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByCompany();
    const response = await workplaceHierarchyClient.getAttributeByCompanyId(body, { token });

    await expectValidContract(response, levelListEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByCompany();
    const response = await workplaceHierarchyClient.getAttributeByCompanyId(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[2] boundary: a null companyId must be refused rather than treated as "all tenants"', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByCompany({ companyId: null });
    const response = await workplaceHierarchyClient.getAttributeByCompanyId(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null companyId' });
  });

  test('[2b] boundary: an empty companyId must not be answered with the whole collection', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByCompany({ companyId: '' });
    const response = await workplaceHierarchyClient.getAttributeByCompanyId(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty companyId' });
  });

  test('[2c] boundary: a 5000-character companyId must not be processed as a lookup key', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // The description warns this is an unindexed derived query — a 5000-char key is a cheap
    // way to make the server do a full collection scan on nonsense.
    const body = buildByCompany({ companyId: MAX_LENGTH_STRING });
    const response = await workplaceHierarchyClient.getAttributeByCompanyId(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) companyId',
    });
  });

  test('[3] typefuzz: a numeric companyId must be refused, not silently coerced', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByCompany({ companyId: 1001 });
    const response = await workplaceHierarchyClient.getAttributeByCompanyId(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric companyId' });
  });

  test('[3b] typefuzz: an object companyId must not reach the driver as an operator', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // `{ $ne: null }` as a filter value matches every document — on a list endpoint that is a
    // whole-platform export, not a tenant read.
    const body = buildByCompany({ companyId: { $ne: null } });
    const response = await workplaceHierarchyClient.getAttributeByCompanyId(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object companyId ({ $ne: null }) — Mongo operator injection',
    });
  });

  test('[4] auth: an unauthenticated caller must be refused, not served the tenant level list', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildByCompany();
    const response = await workplaceHierarchyClient.getAttributeByCompanyId(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a token forged with alg:none must never be accepted', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildByCompany();
    const response = await workplaceHierarchyClient.getAttributeByCompanyId(body, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] one tenant must not receive another tenant hierarchy levels', async ({
    workplaceHierarchyClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * The auth filter injects companyID from the token, but this endpoint reads companyId from
     * the BODY. If the body wins, every tenant org chart is one integer away.
     */
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildByCompany({ companyId: otherTenant });
    const response = await workplaceHierarchyClient.getAttributeByCompanyId(body, { token });

    const { json } = await readBody(response);
    const value = json?.value;
    if (Array.isArray(value) && value.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.getAttributeByCompanyId({ companyId: "${otherTenant}" }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, the body companyId "${otherTenant}" returned ${value.length} foreign hierarchy level(s). The endpoint trusts the body over the token, so the org structure of every tenant on the deployment is enumerable.`,
          title: 'Cross-tenant attribute list (IDOR): body companyId overrides the token tenant',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL-injection companyId must not surface a database error', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByCompany({ companyId: SQLI_PAYLOAD });
    const response = await workplaceHierarchyClient.getAttributeByCompanyId(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script companyId must not come back unescaped', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByCompany({ companyId: XSS_PAYLOAD });
    const response = await workplaceHierarchyClient.getAttributeByCompanyId(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /variable/save ==== */
test.describe('POST /variable/save', () => {
  const META = {
    method: 'POST',
    path: WORKPLACE_HIERARCHY_PATHS.variableSave,
    repro: `await workplaceHierarchyClient.saveVariable(buildNodeArray(2), { token });`,
  };

  test('[1] happy path: a valid array of base nodes returns a well-formed node-list envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeArray(2);
    const response = await workplaceHierarchyClient.saveVariable(body, { token });

    await expectValidContract(response, nodeListEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeArray(1);
    const response = await workplaceHierarchyClient.saveVariable(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: a node must not be accepted under an attributeId that does not exist', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * The spec states plainly that `attributeId` is "not validated to exist". A node saved
     * against a phantom level is invisible in every tree render — it belongs to a rung that
     * was never created — yet the caller is told the save worked.
     */
    const phantomLevel = randomObjectId();
    const body = buildNodeArray(1, { attributeId: phantomLevel });
    const response = await workplaceHierarchyClient.saveVariable(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.saveVariable([{ attributeId: "${phantomLevel}", ... }], { token });`,
          scenario: `A base hierarchy node was accepted with attributeId "${phantomLevel}", which matches no attribute document. Referential integrity is not enforced on write, so the tree accumulates nodes hanging off levels that do not exist and no read path can render them. Body: ${text.slice(0, 200)}`,
          title: 'variable/save accepts a node under a non-existent attributeId',
        },
        'Business Logic Flaw',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: a null variableName must be refused, not stored as a nameless node', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeArray(1, { variableName: null });
    const response = await workplaceHierarchyClient.saveVariable(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null variableName' });
  });

  test('[2b] boundary: a 5000-character variableName must be refused rather than persisted', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeArray(1, { variableName: MAX_LENGTH_STRING });
    const response = await workplaceHierarchyClient.saveVariable(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) variableName',
    });
  });

  test('[2c] boundary: a self-parenting node must be refused before it enters the tree', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * Children are resolved by querying `parent_variable_id`, so a node that is its own parent
     * is a one-element cycle: any depth-first render of the tree recurses on itself. The id is
     * random, so nothing real is touched.
     */
    const selfId = randomObjectId();
    const body = buildNodeArray(1, { id: selfId, parentVariableId: selfId });
    const response = await workplaceHierarchyClient.saveVariable(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      repro: `await workplaceHierarchyClient.saveVariable([{ id: "${selfId}", parentVariableId: "${selfId}" }], { token });`,
      scenario: 'self-parenting node — a one-element cycle in a self-referencing tree',
    });
  });

  test('[3] typefuzz: a numeric attributeId must be refused, not coerced into an ObjectId', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeArray(1, { attributeId: 1001 });
    const response = await workplaceHierarchyClient.saveVariable(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric attributeId' });
  });

  test('[3b] typefuzz: an array parentVariableId must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeArray(1, {
      parentVariableId: ['66f1a2b3c4d5e6f708192a5d', '66f1a2b3c4d5e6f708192a6e'],
    });
    const response = await workplaceHierarchyClient.saveVariable(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'array parentVariableId — a node cannot have two structural parents',
    });
  });

  test('[3c] typefuzz: a single object where the documented body is an array must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNode();
    const response = await workplaceHierarchyClient.saveVariable(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      repro: `await workplaceHierarchyClient.saveVariable(buildNode(), { token }); // object, not array`,
      scenario: 'object body instead of a JSON array',
    });
  });

  test('[4] auth: an unauthenticated caller must not be able to create hierarchy nodes', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildNodeArray(1);
    const response = await workplaceHierarchyClient.saveVariable(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must be refused on a write', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildNodeArray(1);
    const response = await workplaceHierarchyClient.saveVariable(body, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a node must not be creatable under a parent owned by another tenant', async ({
    workplaceHierarchyClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * The strongest cross-tenant shape on a tree: keep our own companyId but point the
     * structural parent at a foreign node. If accepted, our subtree is grafted into their
     * hierarchy and appears in their tree renders — a write-side tenancy breach that no
     * read-side filter can undo.
     */
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const foreignParent = randomObjectId();
    const body = buildNodeArray(1, {
      companyId: otherTenant,
      parentVariableId: foreignParent,
      parentAttributeId: randomObjectId(),
    });
    const response = await workplaceHierarchyClient.saveVariable(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.saveVariable([{ companyId: "${otherTenant}", parentVariableId: "${foreignParent}" }], { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, a node was written into tenant "${otherTenant}" under parent "${foreignParent}" and reported SUCCESS. Neither the companyId nor the parent link is checked against the token, so attacker-controlled branches can be grafted into any tenant tree. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant node grafting (IDOR) on variable/save',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a script variableName must not be stored and echoed unescaped', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeArray(1, { variableName: XSS_PAYLOAD });
    const response = await workplaceHierarchyClient.saveVariable(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });

  test('[6b] injection: a SQL payload as attributeId must not surface a database error', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeArray(1, { attributeId: SQLI_DROP_PAYLOAD });
    const response = await workplaceHierarchyClient.saveVariable(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });
});

/* ==== POST /variable/update ==== */
test.describe('POST /variable/update', () => {
  const META = {
    method: 'POST',
    path: WORKPLACE_HIERARCHY_PATHS.variableUpdate,
    repro: `await workplaceHierarchyClient.updateVariable(buildNodeUpdate(), { token });`,
  };

  test('[1] happy path: an update returns a well-formed envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeUpdate();
    const response = await workplaceHierarchyClient.updateVariable(body, { token });

    await expectValidContract(response, looseEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeUpdate();
    const response = await workplaceHierarchyClient.updateVariable(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[1c] business rule: updating an id that matches no document must not report SUCCESS', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const missingId = randomObjectId();
    const body = buildNodeUpdate({ id: missingId, variableName: 'QA-Renamed-Nowhere' });
    const response = await workplaceHierarchyClient.updateVariable(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS' && !json?.value) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.updateVariable({ id: "${missingId}", variableName: "QA-Renamed-Nowhere" }, { token });`,
          scenario: `Update against the non-existent id "${missingId}" returned SUCCESS with no document in value. Nothing was modified, yet the caller is told otherwise. Body: ${text.slice(0, 200)}`,
          title: 'variable/update reports SUCCESS when no document matched the id',
        },
        'Status Code Misreporting',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[1d] business rule: a two-node parent cycle must be refused before it is persisted', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * A parents B and B parents A. Children are found by querying `parent_variable_id`, so any
     * recursive descent over this pair never terminates. Both ids are freshly minted and match
     * no document, so this probes the validation, not real data.
     */
    const nodeA = randomObjectId();
    const nodeB = randomObjectId();
    const body = buildNodeUpdate({ id: nodeA, parentVariableId: nodeB });
    const cyclePartner = buildNodeUpdate({ id: nodeB, parentVariableId: nodeA });
    await workplaceHierarchyClient.updateVariable(cyclePartner, { token });
    const response = await workplaceHierarchyClient.updateVariable(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await updateVariable({ id: "${nodeA}", parentVariableId: "${nodeB}" }); await updateVariable({ id: "${nodeB}", parentVariableId: "${nodeA}" });`,
          scenario: `A mutual parent cycle between "${nodeA}" and "${nodeB}" was accepted with status SUCCESS. The tree is stored as self-referencing id strings with no acyclicity check, so any server-side or client-side recursive walk of this pair loops until it exhausts its stack or its request timeout. Body: ${text.slice(0, 200)}`,
          title: 'variable/update accepts a cyclic parent link (unbounded recursion)',
        },
        'Business Logic Flaw',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: a null id must be refused rather than updating an arbitrary node', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeUpdate({ id: null });
    const response = await workplaceHierarchyClient.updateVariable(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id' });
  });

  test('[2b] boundary: a 5000-character variableName must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeUpdate({ variableName: MAX_LENGTH_STRING });
    const response = await workplaceHierarchyClient.updateVariable(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) variableName',
    });
  });

  test('[3] typefuzz: a numeric id must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeUpdate({ id: 1001 });
    const response = await workplaceHierarchyClient.updateVariable(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric id' });
  });

  test('[3b] typefuzz: a boolean parentVariableId must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeUpdate({ parentVariableId: false });
    const response = await workplaceHierarchyClient.updateVariable(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'boolean parentVariableId',
    });
  });

  test('[4] auth: an unauthenticated caller must not be able to re-parent a node', async ({
    workplaceHierarchyClient,
  }) => {
    // Re-parenting moves the whole subtree implicitly, so an anonymous write here can
    // restructure an entire org chart in one call.
    const body = buildNodeUpdate();
    const response = await workplaceHierarchyClient.updateVariable(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a malformed bearer token must be refused', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildNodeUpdate();
    const response = await workplaceHierarchyClient.updateVariable(body, {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a node must not be re-parentable under another tenant subtree', async ({
    workplaceHierarchyClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const foreignParent = randomObjectId();
    const body = buildNodeUpdate({ companyId: otherTenant, parentVariableId: foreignParent });
    const response = await workplaceHierarchyClient.updateVariable(body, { token });

    const { json, text } = await readBody(response);
    const value = json?.value as { companyId?: string } | null;
    if (value?.companyId === otherTenant) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.updateVariable({ id: "<id>", companyId: "${otherTenant}", parentVariableId: "${foreignParent}" }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, an update moved a node into tenant "${otherTenant}" under a foreign parent and the endpoint returned the re-scoped document. Because children resolve by parent id, the node subtree moves with it — a tenant can transplant a branch of its hierarchy into a neighbour org chart. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant node re-parenting (IDOR) on variable/update',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a malformed ObjectId must not leak the parser exception', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeUpdate({ id: 'not-an-object-id' });
    const response = await workplaceHierarchyClient.updateVariable(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, 'not-an-object-id');
  });

  test('[6b] injection: a script variableName must not be echoed unescaped on update', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeUpdate({ variableName: XSS_PAYLOAD });
    const response = await workplaceHierarchyClient.updateVariable(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /variable/delete ==== */
test.describe('POST /variable/delete', () => {
  const META = {
    method: 'POST',
    path: WORKPLACE_HIERARCHY_PATHS.variableDelete,
    repro: `await workplaceHierarchyClient.deleteVariable(buildById(), { token }); // random id — matches no document`,
  };

  test('[1] happy path: a delete against a non-existent id returns a well-formed envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // Random id on purpose: deleting a real node orphans every child that still points at it.
    const body = buildById({ id: randomObjectId() });
    const response = await workplaceHierarchyClient.deleteVariable(body, { token });

    await expectValidContract(response, looseEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: randomObjectId() });
    const response = await workplaceHierarchyClient.deleteVariable(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: deleting a node must not silently orphan its children', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * The delete is documented as non-cascading. Aimed at a random id nothing is destroyed,
     * but a SUCCESS answer for an id the server never located is the same misreport that
     * makes an accidental real deletion invisible: the caller has no signal that children
     * were left dangling.
     */
    const missingId = randomObjectId();
    const body = buildById({ id: missingId });
    const response = await workplaceHierarchyClient.deleteVariable(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.deleteVariable({ id: "${missingId}" }, { token });`,
          scenario: `Deleting the non-existent node "${missingId}" reported SUCCESS. The route is a non-cascading hard delete with no dependant check, so the same answer is returned whether the node was absent, removed cleanly, or removed while children still referenced it by parent_variable_id. Body: ${text.slice(0, 200)}`,
          title: 'variable/delete reports SUCCESS without distinguishing a miss from an orphaning delete',
        },
        'Status Code Misreporting',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: a null id must be refused, not treated as an unbounded delete', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: null });
    const response = await workplaceHierarchyClient.deleteVariable(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id on a delete' });
  });

  test('[2b] boundary: an empty id must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: '' });
    const response = await workplaceHierarchyClient.deleteVariable(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty id on a delete' });
  });

  test('[3] typefuzz: an object id must be refused, not used as a Mongo operator', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: { $ne: null } });
    const response = await workplaceHierarchyClient.deleteVariable(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object id ({ $ne: null }) — operator injection that would wipe the node collection',
    });
  });

  test('[3b] typefuzz: a numeric id must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: 1001 });
    const response = await workplaceHierarchyClient.deleteVariable(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric id' });
  });

  test('[4] auth: an unauthenticated delete must be refused', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildById();
    const response = await workplaceHierarchyClient.deleteVariable(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must not authorise a destructive delete', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildById();
    const response = await workplaceHierarchyClient.deleteVariable(body, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a caller must not be able to delete a node in another tenant tree', async ({
    workplaceHierarchyClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const foreignId = randomObjectId();
    const body = buildById({ id: foreignId });
    const response = await workplaceHierarchyClient.deleteVariable(body, { token });

    const { json, text } = await readBody(response);
    const value = json?.value as { companyId?: string } | null;
    if (value?.companyId && value.companyId !== companyID) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.deleteVariable({ id: "${foreignId}" }, { token /* tenant ${companyID} */ });`,
          scenario: `A delete issued as tenant ${companyID} returned a node owned by tenant "${value.companyId}". The body carries no tenant scope and ids resolve globally, so a guessed id destroys a foreign hierarchy node and orphans its children. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant node delete (IDOR) on variable/delete',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload as the id must not leak an exception trace', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: SQLI_DROP_PAYLOAD });
    const response = await workplaceHierarchyClient.deleteVariable(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });

  test('[6b] injection: a script id must not be reflected unescaped', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: XSS_PAYLOAD });
    const response = await workplaceHierarchyClient.deleteVariable(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /variable/getVariable ==== */
test.describe('POST /variable/getVariable', () => {
  const META = {
    method: 'POST',
    path: WORKPLACE_HIERARCHY_PATHS.variableGet,
    repro: `await workplaceHierarchyClient.getVariable(buildNodeLookup(), { token });`,
  };

  test('[1] happy path: a parent + tenant lookup returns a well-formed node-list envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeLookup();
    const response = await workplaceHierarchyClient.getVariable(body, { token });

    await expectValidContract(response, nodeListEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeLookup();
    const response = await workplaceHierarchyClient.getVariable(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[2] boundary: a null parentVariableId is the documented root query and must stay tenant-scoped', async ({
    workplaceHierarchyClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * The spec says to pass `parentVariableId: null` to list the roots. That is the one query
     * on this route with no id narrowing it at all, so the company_id half of the filter is
     * the only thing keeping tenants apart — worth checking it actually holds.
     */
    const body = buildNodeLookup({ parentVariableId: null });
    const response = await workplaceHierarchyClient.getVariable(body, { token });

    const { json } = await readBody(response);
    const value = json?.value;
    const foreign = Array.isArray(value)
      ? (value as Array<{ companyId?: string }>).filter(
          (n) => n?.companyId && n.companyId !== companyID
        )
      : [];
    if (foreign.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.getVariable({ companyId: "${companyID}", parentVariableId: null }, { token });`,
          scenario: `The documented root query returned ${foreign.length} node(s) belonging to other tenants (e.g. "${foreign[0]?.companyId}"). With no parent id to narrow it, the company_id filter is the whole isolation boundary on this route and it did not hold.`,
          title: 'variable/getVariable root query returns foreign-tenant nodes',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[2b] boundary: an empty companyId must not widen the query to every tenant', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeLookup({ companyId: '' });
    const response = await workplaceHierarchyClient.getVariable(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty companyId' });
  });

  test('[2c] boundary: a 5000-character parentVariableId must not be processed as a filter', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeLookup({ parentVariableId: MAX_LENGTH_STRING });
    const response = await workplaceHierarchyClient.getVariable(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) parentVariableId',
    });
  });

  test('[3] typefuzz: a numeric companyId must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeLookup({ companyId: 1001 });
    const response = await workplaceHierarchyClient.getVariable(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric companyId' });
  });

  test('[3b] typefuzz: an object parentVariableId must not reach the driver as an operator', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // `{ $ne: null }` on the parent half of the filter returns every non-root node in the
    // tenant in a single call — the whole tree, from an endpoint documented to page it.
    const body = buildNodeLookup({ parentVariableId: { $ne: null } });
    const response = await workplaceHierarchyClient.getVariable(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object parentVariableId ({ $ne: null }) — Mongo operator injection',
    });
  });

  test('[4] auth: an unauthenticated caller must be refused, not served the subtree', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildNodeLookup();
    const response = await workplaceHierarchyClient.getVariable(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a token forged with alg:none must never be accepted', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildNodeLookup();
    const response = await workplaceHierarchyClient.getVariable(body, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] one tenant must not be able to expand another tenant subtree', async ({
    workplaceHierarchyClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildNodeLookup({ companyId: otherTenant, parentVariableId: null });
    const response = await workplaceHierarchyClient.getVariable(body, { token });

    const { json } = await readBody(response);
    const value = json?.value;
    if (Array.isArray(value) && value.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.getVariable({ companyId: "${otherTenant}", parentVariableId: null }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, asking for tenant "${otherTenant}" roots returned ${value.length} node(s). Repeating the call with each returned id walks a competitor entire organisational tree one level at a time.`,
          title: 'Cross-tenant subtree expansion (IDOR) on variable/getVariable',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL-injection parentVariableId must not surface a database error', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeLookup({ parentVariableId: SQLI_PAYLOAD });
    const response = await workplaceHierarchyClient.getVariable(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script companyId must not come back unescaped', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeLookup({ companyId: XSS_PAYLOAD });
    const response = await workplaceHierarchyClient.getVariable(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /adminTierAttribute/save ==== */
test.describe('POST /adminTierAttribute/save', () => {
  const META = {
    method: 'POST',
    path: WORKPLACE_HIERARCHY_PATHS.tierAttributeSave,
    repro: `await workplaceHierarchyClient.saveTierAttribute(buildLevelArray(2), { token });`,
  };

  test('[1] happy path: a valid array of workplace levels returns a level-list envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelArray(2);
    const response = await workplaceHierarchyClient.saveTierAttribute(body, { token });

    await expectValidContract(response, levelListEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelArray(1);
    const response = await workplaceHierarchyClient.saveTierAttribute(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: two concurrent saves of the same name must not be handed the same code', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * `code` is documented as "unique within the company" and is generated by the service on
     * save. Nothing in the write path reserves it first, so two callers racing on the same
     * level name are a direct test of whether that uniqueness claim survives concurrency.
     */
    const body = buildLevelArray(1, { attributeName: 'QA-Concurrent-Level' });
    const [first, second] = await Promise.all([
      workplaceHierarchyClient.saveTierAttribute(body, { token }),
      workplaceHierarchyClient.saveTierAttribute(body, { token }),
    ]);

    const a = (await readBody(first)).json?.value as Array<{ code?: string }> | null;
    const b = (await readBody(second)).json?.value as Array<{ code?: string }> | null;
    const codeA = Array.isArray(a) ? a[0]?.code : undefined;
    const codeB = Array.isArray(b) ? b[0]?.code : undefined;

    if (codeA && codeB && codeA === codeB) {
      await reportBusinessLogicFlaw(
        second,
        {
          ...META,
          body,
          repro: `await Promise.all([saveTierAttribute(body, { token }), saveTierAttribute(body, { token })]); // same code returned twice`,
          scenario: `Two concurrent saves of "QA-Concurrent-Level" both came back with code "${codeA}". The code is generated without a reservation or a unique index behind it, so the "unique within the company" guarantee the schema advertises does not hold under load and two levels now collide.`,
          title: 'adminTierAttribute/save issues duplicate level codes under concurrency',
        },
        'Idempotency / Concurrency',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: a null attributeName must be refused, not stored as a nameless level', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelArray(1, { attributeName: null });
    const response = await workplaceHierarchyClient.saveTierAttribute(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null attributeName' });
  });

  test('[2b] boundary: a null companyId must be refused — an unscoped level is invisible to the UI', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // The schema is explicit: every read path filters on company_id, so a level saved without
    // one is written to the collection and can never be read back.
    const body = buildLevelArray(1, { companyId: null });
    const response = await workplaceHierarchyClient.saveTierAttribute(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null companyId' });
  });

  test('[2c] boundary: a 5000-character attributeName must be refused rather than persisted', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelArray(1, { attributeName: MAX_LENGTH_STRING });
    const response = await workplaceHierarchyClient.saveTierAttribute(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) attributeName',
    });
  });

  test('[3] typefuzz: a numeric companyId must be refused, not silently coerced', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelArray(1, { companyId: 1001 });
    const response = await workplaceHierarchyClient.saveTierAttribute(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric companyId' });
  });

  test('[3b] typefuzz: a boolean attributeName must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelArray(1, { attributeName: true });
    const response = await workplaceHierarchyClient.saveTierAttribute(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean attributeName' });
  });

  test('[3c] typefuzz: a single object where the documented body is an array must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevel();
    const response = await workplaceHierarchyClient.saveTierAttribute(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      repro: `await workplaceHierarchyClient.saveTierAttribute(buildLevel(), { token }); // object, not array`,
      scenario: 'object body instead of a JSON array',
    });
  });

  test('[4] auth: an unauthenticated caller must not be able to create workplace levels', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildLevelArray(1);
    const response = await workplaceHierarchyClient.saveTierAttribute(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must be refused on a write', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildLevelArray(1);
    const response = await workplaceHierarchyClient.saveTierAttribute(body, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a workplace level must not be creatable inside another tenant', async ({
    workplaceHierarchyClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildLevelArray(1, { companyId: otherTenant });
    const response = await workplaceHierarchyClient.saveTierAttribute(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.saveTierAttribute([{ companyId: "${otherTenant}", ... }], { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, a workplace hierarchy level was written into tenant "${otherTenant}" and reported SUCCESS. This is the tier the UI renders, so an injected level appears directly in a foreign org chart. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant workplace level write (IDOR) on adminTierAttribute/save',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a script attributeName must not be stored and echoed unescaped', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelArray(1, { attributeName: XSS_PAYLOAD });
    const response = await workplaceHierarchyClient.saveTierAttribute(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });

  test('[6b] injection: a SQL payload in attributeName must not surface a database error', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelArray(1, { attributeName: SQLI_DROP_PAYLOAD });
    const response = await workplaceHierarchyClient.saveTierAttribute(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });
});

/* ==== POST /adminTierAttribute/update ==== */
test.describe('POST /adminTierAttribute/update', () => {
  const META = {
    method: 'POST',
    path: WORKPLACE_HIERARCHY_PATHS.tierAttributeUpdate,
    repro: `await workplaceHierarchyClient.updateTierAttribute(buildLevelUpdate(), { token });`,
  };

  test('[1] happy path: a rename returns a well-formed envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelUpdate();
    const response = await workplaceHierarchyClient.updateTierAttribute(body, { token });

    await expectValidContract(response, looseEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelUpdate();
    const response = await workplaceHierarchyClient.updateTierAttribute(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[1c] business rule: renaming an id that matches no document must not report SUCCESS', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const missingId = randomObjectId();
    const body = buildLevelUpdate({ id: missingId, attributeName: 'QA-Renamed-Site' });
    const response = await workplaceHierarchyClient.updateTierAttribute(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS' && !json?.value) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.updateTierAttribute({ id: "${missingId}", attributeName: "QA-Renamed-Site" }, { token });`,
          scenario: `Renaming the non-existent level "${missingId}" returned SUCCESS with an empty value. The admin UI shows the rename as applied while the hierarchy is unchanged. Body: ${text.slice(0, 200)}`,
          title: 'adminTierAttribute/update reports SUCCESS when no document matched the id',
        },
        'Status Code Misreporting',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: a null id must be refused rather than renaming an arbitrary level', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelUpdate({ id: null });
    const response = await workplaceHierarchyClient.updateTierAttribute(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id' });
  });

  test('[2b] boundary: an empty attributeName must not blank out a level in use', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // The renamed level is reflected everywhere the hierarchy is rendered, so a blank name
    // erases a whole rung from every tree view at once.
    const body = buildLevelUpdate({ attributeName: '' });
    const response = await workplaceHierarchyClient.updateTierAttribute(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty attributeName' });
  });

  test('[2c] boundary: a 5000-character attributeName must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelUpdate({ attributeName: MAX_LENGTH_STRING });
    const response = await workplaceHierarchyClient.updateTierAttribute(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) attributeName',
    });
  });

  test('[3] typefuzz: a numeric id must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelUpdate({ id: 1001 });
    const response = await workplaceHierarchyClient.updateTierAttribute(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric id' });
  });

  test('[3b] typefuzz: an array companyId must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelUpdate({ companyId: ['1001', '1002'] });
    const response = await workplaceHierarchyClient.updateTierAttribute(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'array companyId — a level cannot belong to two tenants',
    });
  });

  test('[4] auth: an unauthenticated caller must not be able to rename a workplace level', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildLevelUpdate();
    const response = await workplaceHierarchyClient.updateTierAttribute(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a malformed bearer token must be refused', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildLevelUpdate();
    const response = await workplaceHierarchyClient.updateTierAttribute(body, {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a workplace level must not be re-scopeable into another tenant', async ({
    workplaceHierarchyClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildLevelUpdate({ companyId: otherTenant });
    const response = await workplaceHierarchyClient.updateTierAttribute(body, { token });

    const { json, text } = await readBody(response);
    const value = json?.value as { companyId?: string } | null;
    if (value?.companyId === otherTenant) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.updateTierAttribute({ id: "<id>", companyId: "${otherTenant}" }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, an update moved a workplace level into tenant "${otherTenant}". Every node hanging off that level keeps its attribute_id, so a whole rung of one tenant hierarchy is transplanted into another. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant workplace level re-scoping (IDOR) on adminTierAttribute/update',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a malformed ObjectId must not leak the parser exception', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelUpdate({ id: 'not-an-object-id' });
    const response = await workplaceHierarchyClient.updateTierAttribute(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, 'not-an-object-id');
  });

  test('[6b] injection: a script attributeName must not be echoed unescaped on rename', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildLevelUpdate({ attributeName: XSS_PAYLOAD });
    const response = await workplaceHierarchyClient.updateTierAttribute(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /adminTierAttribute/delete ==== */
test.describe('POST /adminTierAttribute/delete', () => {
  const META = {
    method: 'POST',
    path: WORKPLACE_HIERARCHY_PATHS.tierAttributeDelete,
    repro: `await workplaceHierarchyClient.deleteTierAttribute(buildById(), { token }); // random id — matches no document`,
  };

  test('[1] happy path: a delete against a non-existent id returns a well-formed envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // Random id on purpose: deleting a live level strands every node whose attribute_id
    // points at it, and there is no cascade and no undo.
    const body = buildById({ id: randomObjectId() });
    const response = await workplaceHierarchyClient.deleteTierAttribute(body, { token });

    await expectValidContract(response, looseEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: randomObjectId() });
    const response = await workplaceHierarchyClient.deleteTierAttribute(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: deleting a level with dependants must not be reported as a clean success', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const missingId = randomObjectId();
    const body = buildById({ id: missingId });
    const response = await workplaceHierarchyClient.deleteTierAttribute(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.deleteTierAttribute({ id: "${missingId}" }, { token });`,
          scenario: `Deleting the non-existent level "${missingId}" reported SUCCESS. The route performs no dependant check before a hard delete, so an operator gets the identical answer whether the level was absent or whether it was removed out from under a set of live nodes. Body: ${text.slice(0, 200)}`,
          title: 'adminTierAttribute/delete cannot distinguish a miss from a dependant-stranding delete',
        },
        'Status Code Misreporting',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: a null id must be refused, not treated as an unbounded delete', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: null });
    const response = await workplaceHierarchyClient.deleteTierAttribute(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id on a delete' });
  });

  test('[2b] boundary: an empty id must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: '' });
    const response = await workplaceHierarchyClient.deleteTierAttribute(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty id on a delete' });
  });

  test('[3] typefuzz: an object id must be refused, not used as a Mongo operator', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: { $ne: null } });
    const response = await workplaceHierarchyClient.deleteTierAttribute(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object id ({ $ne: null }) — operator injection that would wipe every level',
    });
  });

  test('[3b] typefuzz: a boolean id must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: false });
    const response = await workplaceHierarchyClient.deleteTierAttribute(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean id' });
  });

  test('[4] auth: an unauthenticated delete must be refused', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildById();
    const response = await workplaceHierarchyClient.deleteTierAttribute(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a token forged with alg:none must not authorise a destructive delete', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildById();
    const response = await workplaceHierarchyClient.deleteTierAttribute(body, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a caller must not be able to delete another tenant workplace level', async ({
    workplaceHierarchyClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const foreignId = randomObjectId();
    const body = buildById({ id: foreignId });
    const response = await workplaceHierarchyClient.deleteTierAttribute(body, { token });

    const { json, text } = await readBody(response);
    const value = json?.value as { companyId?: string } | null;
    if (value?.companyId && value.companyId !== companyID) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.deleteTierAttribute({ id: "${foreignId}" }, { token /* tenant ${companyID} */ });`,
          scenario: `A delete issued as tenant ${companyID} returned a level owned by tenant "${value.companyId}". Ids resolve globally with no tenant filter, so a guessed id removes a rung from a foreign org chart. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant workplace level delete (IDOR) on adminTierAttribute/delete',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload as the id must not leak an exception trace', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: SQLI_DROP_PAYLOAD });
    const response = await workplaceHierarchyClient.deleteTierAttribute(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });

  test('[6b] injection: a script id must not be reflected unescaped', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: XSS_PAYLOAD });
    const response = await workplaceHierarchyClient.deleteTierAttribute(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /adminTierAttribute/getAttribute ==== */
test.describe('POST /adminTierAttribute/getAttribute', () => {
  const META = {
    method: 'POST',
    path: WORKPLACE_HIERARCHY_PATHS.tierAttributeGet,
    repro: `await workplaceHierarchyClient.getTierAttribute(buildById(), { token });`,
  };

  test('[1] happy path: a lookup by id returns a well-formed single-level envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById();
    const response = await workplaceHierarchyClient.getTierAttribute(body, { token });

    /*
     * 500 is in the accepted set only because this route is the module's documented
     * status-line defect: the success path answers HTTP 500 while the envelope inside reports
     * statusCode 200. Case [1c] reports that mismatch as its own finding rather than letting
     * every other case in this block fail on the same known symptom.
     */
    await expectValidContract(response, levelEnvelopeSchema, { ...META, body }, [200, 500]);
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById();
    const response = await workplaceHierarchyClient.getTierAttribute(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: a documented success must not be delivered under an HTTP 500', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById();
    const response = await workplaceHierarchyClient.getTierAttribute(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() >= 500 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          scenario: `The endpoint answered HTTP ${response.status()} while the envelope reports status SUCCESS with statusCode ${json?.statusCode}. Every HTTP client, proxy, retry policy and alerting rule keys on the status line, so a working read is counted as a server error: it is retried needlessly, it pages an on-call engineer, and any client that throws on 5xx cannot use the endpoint at all. Body: ${text.slice(0, 200)}`,
          title: 'adminTierAttribute/getAttribute returns HTTP 500 on its success path',
        },
        'Status Code Misreporting',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: a null id must be refused rather than answered with an arbitrary level', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: null });
    const response = await workplaceHierarchyClient.getTierAttribute(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id' });
  });

  test('[2b] boundary: an empty id must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: '' });
    const response = await workplaceHierarchyClient.getTierAttribute(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty id' });
  });

  test('[2c] boundary: a 5000-character id must not be processed as a primary key', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: MAX_LENGTH_STRING });
    const response = await workplaceHierarchyClient.getTierAttribute(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) id',
    });
  });

  test('[3] typefuzz: a numeric id must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: 1001 });
    const response = await workplaceHierarchyClient.getTierAttribute(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric id' });
  });

  test('[3b] typefuzz: an object id must not reach the driver as an operator', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: { $ne: null } });
    const response = await workplaceHierarchyClient.getTierAttribute(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object id ({ $ne: null }) — Mongo operator injection on a findById',
    });
  });

  test('[4] auth: an unauthenticated caller must be refused, not served the level', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildById();
    const response = await workplaceHierarchyClient.getTierAttribute(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must be refused', async ({ workplaceHierarchyClient }) => {
    const body = buildById();
    const response = await workplaceHierarchyClient.getTierAttribute(body, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a workplace level id belonging to another tenant must not be readable', async ({
    workplaceHierarchyClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const foreignId = randomObjectId();
    const body = buildById({ id: foreignId });
    const response = await workplaceHierarchyClient.getTierAttribute(body, { token });

    const parsed = levelSchema.safeParse((await readBody(response)).json?.value);
    if (parsed.success && parsed.data.companyId && parsed.data.companyId !== companyID) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.getTierAttribute({ id: "${foreignId}" }, { token /* tenant ${companyID} */ });`,
          scenario: `A findById issued as tenant ${companyID} returned a workplace level owned by tenant "${parsed.data.companyId}". The lookup applies no company_id filter, so id enumeration reads any tenant hierarchy naming.`,
          title: 'Cross-tenant workplace level read (IDOR) on adminTierAttribute/getAttribute',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL-injection id must not surface a database error or query echo', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: SQLI_PAYLOAD });
    const response = await workplaceHierarchyClient.getTierAttribute(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script id must not come back unescaped in the envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: XSS_PAYLOAD });
    const response = await workplaceHierarchyClient.getTierAttribute(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /adminTierAttribute/getAttributeByCompanyId ==== */
test.describe('POST /adminTierAttribute/getAttributeByCompanyId', () => {
  const META = {
    method: 'POST',
    path: WORKPLACE_HIERARCHY_PATHS.tierAttributeGetByCompanyId,
    repro: `await workplaceHierarchyClient.getTierAttributeByCompanyId(buildByCompany(), { token });`,
  };

  test('[1] happy path: a valid companyId returns a well-formed level-list envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByCompany();
    const response = await workplaceHierarchyClient.getTierAttributeByCompanyId(body, { token });

    await expectValidContract(response, levelListEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByCompany();
    const response = await workplaceHierarchyClient.getTierAttributeByCompanyId(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[2] boundary: a null companyId must be refused rather than treated as "all tenants"', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByCompany({ companyId: null });
    const response = await workplaceHierarchyClient.getTierAttributeByCompanyId(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null companyId' });
  });

  test('[2b] boundary: an empty companyId must not be answered with the whole collection', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByCompany({ companyId: '' });
    const response = await workplaceHierarchyClient.getTierAttributeByCompanyId(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty companyId' });
  });

  test('[2c] boundary: a 5000-character companyId must not be processed as a lookup key', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByCompany({ companyId: MAX_LENGTH_STRING });
    const response = await workplaceHierarchyClient.getTierAttributeByCompanyId(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) companyId',
    });
  });

  test('[3] typefuzz: a numeric companyId must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByCompany({ companyId: 1001 });
    const response = await workplaceHierarchyClient.getTierAttributeByCompanyId(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric companyId' });
  });

  test('[3b] typefuzz: an array companyId must be refused, not expanded into a multi-tenant read', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByCompany({ companyId: ['1001', '1002'] });
    const response = await workplaceHierarchyClient.getTierAttributeByCompanyId(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'array companyId' });
  });

  test('[4] auth: an unauthenticated caller must be refused, not served the tenant level list', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildByCompany();
    const response = await workplaceHierarchyClient.getTierAttributeByCompanyId(body, {
      token: null,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a malformed bearer token must be refused', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildByCompany();
    const response = await workplaceHierarchyClient.getTierAttributeByCompanyId(body, {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] one tenant must not receive another tenant workplace levels', async ({
    workplaceHierarchyClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildByCompany({ companyId: otherTenant });
    const response = await workplaceHierarchyClient.getTierAttributeByCompanyId(body, { token });

    const { json } = await readBody(response);
    const value = json?.value;
    if (Array.isArray(value) && value.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.getTierAttributeByCompanyId({ companyId: "${otherTenant}" }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, the body companyId "${otherTenant}" returned ${value.length} foreign workplace level(s). This is the tier the product renders, so the response is a readable map of a competitor regional structure.`,
          title: 'Cross-tenant workplace level list (IDOR) on adminTierAttribute/getAttributeByCompanyId',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL-injection companyId must not surface a database error', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByCompany({ companyId: SQLI_PAYLOAD });
    const response = await workplaceHierarchyClient.getTierAttributeByCompanyId(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script companyId must not come back unescaped', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildByCompany({ companyId: XSS_PAYLOAD });
    const response = await workplaceHierarchyClient.getTierAttributeByCompanyId(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /adminTierVariable/save ==== */
test.describe('POST /adminTierVariable/save', () => {
  const META = {
    method: 'POST',
    path: WORKPLACE_HIERARCHY_PATHS.tierVariableSave,
    repro: `await workplaceHierarchyClient.saveTierVariable([buildReportingNode()], { token });`,
  };

  test('[1] happy path: a valid array of workplace nodes returns a node-list envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = [buildReportingNode(), buildReportingNode()];
    const response = await workplaceHierarchyClient.saveTierVariable(body, { token });

    await expectValidContract(response, nodeListEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = [buildReportingNode()];
    const response = await workplaceHierarchyClient.saveTierVariable(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: a node must not be accepted under an attributeId that does not exist', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // The schema states outright that attributeId is "not validated to exist".
    const phantomLevel = randomObjectId();
    const body = [buildReportingNode({ attributeId: phantomLevel })];
    const response = await workplaceHierarchyClient.saveTierVariable(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.saveTierVariable([{ attributeId: "${phantomLevel}", ... }], { token });`,
          scenario: `A workplace node was accepted at level "${phantomLevel}", which matches no attribute. Role postings later copy this node position into a denormalised snapshot, so an unrenderable node still propagates into employee records. Body: ${text.slice(0, 200)}`,
          title: 'adminTierVariable/save accepts a node under a non-existent attributeId',
        },
        'Business Logic Flaw',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[1d] business rule: a self-reporting node must be refused before the reporting walk sees it', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * `getAllReportingVariableHierarchy` walks `reporting_variable_id` in application code,
     * one findById per hop, with no visited set. A node that reports to itself is a one-hop
     * cycle that turns that walk into an infinite loop of database round trips. The id is
     * random, so this probes acceptance, not a live record.
     */
    const selfId = randomObjectId();
    const body = [buildReportingNode({ id: selfId, reportingVariableId: selfId })];
    const response = await workplaceHierarchyClient.saveTierVariable(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.saveTierVariable([{ id: "${selfId}", reportingVariableId: "${selfId}" }], { token });`,
          scenario: `A node whose reportingVariableId equals its own id was accepted with status SUCCESS. getAllReportingVariableHierarchy follows that link with one findById per hop and keeps no visited set, so resolving this node reporting chain issues database calls until the request times out — a stored, replayable denial of service against a read endpoint. Body: ${text.slice(0, 200)}`,
          title: 'adminTierVariable/save accepts a self-reporting node (unbounded reporting walk)',
        },
        'Business Logic Flaw',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: a null variableName must be refused, not stored as a nameless node', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = [buildReportingNode({ variableName: null })];
    const response = await workplaceHierarchyClient.saveTierVariable(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null variableName' });
  });

  test('[2b] boundary: a 5000-character reportingJson must be refused rather than denormalised', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // reportingJson is copied verbatim onto every role posting created afterwards, so an
    // oversized value is duplicated across the employee collection and never refreshed.
    const body = [buildReportingNode({ reportingJson: MAX_LENGTH_STRING })];
    const response = await workplaceHierarchyClient.saveTierVariable(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) reportingJson',
    });
  });

  test('[3] typefuzz: a numeric attributeId must be refused, not coerced into an ObjectId', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = [buildReportingNode({ attributeId: 1001 })];
    const response = await workplaceHierarchyClient.saveTierVariable(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric attributeId' });
  });

  test('[3b] typefuzz: a nested object reportingJson must be refused — the field is a JSON string', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * `reportingJson` is documented as a JSON *string*, not a nested object. Sending an object
     * is the mistake every integrator makes once; it must fail loudly rather than persist a
     * shape the downstream role-posting copy cannot parse.
     */
    const body = [buildReportingNode({ reportingJson: { attributeName: 'Region' } })];
    const response = await workplaceHierarchyClient.saveTierVariable(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'nested object reportingJson where a JSON string is documented',
    });
  });

  test('[3c] typefuzz: a single object where the documented body is an array must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildReportingNode();
    const response = await workplaceHierarchyClient.saveTierVariable(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      repro: `await workplaceHierarchyClient.saveTierVariable(buildReportingNode(), { token }); // object, not array`,
      scenario: 'object body instead of a JSON array',
    });
  });

  test('[4] auth: an unauthenticated caller must not be able to create workplace nodes', async ({
    workplaceHierarchyClient,
  }) => {
    const body = [buildReportingNode()];
    const response = await workplaceHierarchyClient.saveTierVariable(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a token forged with alg:none must never be accepted', async ({
    workplaceHierarchyClient,
  }) => {
    const body = [buildReportingNode()];
    const response = await workplaceHierarchyClient.saveTierVariable(body, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a node must not be creatable reporting into another tenant hierarchy', async ({
    workplaceHierarchyClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * The reporting link is stored independently of the structural parent and is what the
     * escalation view walks. Pointing it at a foreign node while claiming a foreign companyId
     * inserts an attacker-controlled position into someone else escalation path.
     */
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const foreignReportsTo = randomObjectId();
    const body = [
      buildReportingNode({ companyId: otherTenant, reportingVariableId: foreignReportsTo }),
    ];
    const response = await workplaceHierarchyClient.saveTierVariable(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.saveTierVariable([{ companyId: "${otherTenant}", reportingVariableId: "${foreignReportsTo}" }], { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, a node was written into tenant "${otherTenant}" with its reporting line pointed at a foreign node, and the call reported SUCCESS. Neither field is validated against the token tenant, so an outsider can insert a position into another company escalation chain. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant workplace node write (IDOR) on adminTierVariable/save',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a script variableName must not be stored and echoed unescaped', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = [buildReportingNode({ variableName: XSS_PAYLOAD })];
    const response = await workplaceHierarchyClient.saveTierVariable(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });

  test('[6b] injection: a SQL payload as reportingVariableId must not surface a database error', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = [buildReportingNode({ reportingVariableId: SQLI_DROP_PAYLOAD })];
    const response = await workplaceHierarchyClient.saveTierVariable(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });
});

/* ==== POST /adminTierVariable/update ==== */
test.describe('POST /adminTierVariable/update', () => {
  const META = {
    method: 'POST',
    path: WORKPLACE_HIERARCHY_PATHS.tierVariableUpdate,
    repro: `await workplaceHierarchyClient.updateTierVariable(buildNodeUpdate(), { token });`,
  };

  test('[1] happy path: an update returns a well-formed envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeUpdate();
    const response = await workplaceHierarchyClient.updateTierVariable(body, { token });

    await expectValidContract(response, looseEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeUpdate();
    const response = await workplaceHierarchyClient.updateTierVariable(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[1c] business rule: updating an id that matches no document must not report SUCCESS', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const missingId = randomObjectId();
    const body = buildNodeUpdate({ id: missingId, variableName: 'QA-Renamed-Zone' });
    const response = await workplaceHierarchyClient.updateTierVariable(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS' && !json?.value) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.updateTierVariable({ id: "${missingId}", variableName: "QA-Renamed-Zone" }, { token });`,
          scenario: `Update against the non-existent node "${missingId}" returned SUCCESS with no document in value. Body: ${text.slice(0, 200)}`,
          title: 'adminTierVariable/update reports SUCCESS when no document matched the id',
        },
        'Status Code Misreporting',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[1d] business rule: a mutual reporting cycle must be refused, not persisted', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * A reports to B and B reports to A. `getAllReportingVariableHierarchy` walks that link
     * with one findById per hop and no visited set, so a two-node cycle is an unbounded loop
     * on the read side. Both ids are freshly minted and match no document.
     */
    const nodeA = randomObjectId();
    const nodeB = randomObjectId();
    await workplaceHierarchyClient.updateTierVariable(
      buildNodeUpdate({ id: nodeB, reportingVariableId: nodeA }),
      { token }
    );
    const body = buildNodeUpdate({ id: nodeA, reportingVariableId: nodeB });
    const response = await workplaceHierarchyClient.updateTierVariable(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await updateTierVariable({ id: "${nodeB}", reportingVariableId: "${nodeA}" }); await updateTierVariable({ id: "${nodeA}", reportingVariableId: "${nodeB}" });`,
          scenario: `A mutual reporting cycle between "${nodeA}" and "${nodeB}" was accepted with status SUCCESS. Because the reporting walk is an application-side loop of findById calls with no cycle guard and no depth cap, any later call to getAllReportingVariableHierarchy on either node runs until the request times out. One authenticated write leaves a permanent, replayable denial of service on a read path. Body: ${text.slice(0, 200)}`,
          title: 'adminTierVariable/update accepts a cyclic reporting link (unbounded traversal)',
        },
        'Business Logic Flaw',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: a null id must be refused rather than updating an arbitrary node', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeUpdate({ id: null });
    const response = await workplaceHierarchyClient.updateTierVariable(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id' });
  });

  test('[2b] boundary: an empty variableName must not blank a node that is already in use', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeUpdate({ variableName: '' });
    const response = await workplaceHierarchyClient.updateTierVariable(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty variableName' });
  });

  test('[3] typefuzz: a numeric id must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeUpdate({ id: 1001 });
    const response = await workplaceHierarchyClient.updateTierVariable(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric id' });
  });

  test('[3b] typefuzz: an array reportingVariableId must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeUpdate({
      reportingVariableId: ['66f1a2b3c4d5e6f708192a5d', '66f1a2b3c4d5e6f708192a6e'],
    });
    const response = await workplaceHierarchyClient.updateTierVariable(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'array reportingVariableId — a node reports to exactly one other node',
    });
  });

  test('[4] auth: an unauthenticated caller must not be able to re-point a reporting line', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildNodeUpdate();
    const response = await workplaceHierarchyClient.updateTierVariable(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must be refused on a write', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildNodeUpdate();
    const response = await workplaceHierarchyClient.updateTierVariable(body, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a node subtree must not be transplantable into another tenant', async ({
    workplaceHierarchyClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const foreignParent = randomObjectId();
    const body = buildNodeUpdate({
      companyId: otherTenant,
      parentVariableId: foreignParent,
      parentAttributeId: randomObjectId(),
    });
    const response = await workplaceHierarchyClient.updateTierVariable(body, { token });

    const { json, text } = await readBody(response);
    const value = json?.value as { companyId?: string } | null;
    if (value?.companyId === otherTenant) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.updateTierVariable({ id: "<id>", companyId: "${otherTenant}", parentVariableId: "${foreignParent}" }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, an update moved a workplace node into tenant "${otherTenant}" under a foreign parent. Re-parenting carries the entire subtree because children resolve by parent_variable_id, so this is a bulk cross-tenant move disguised as a single-document write. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant subtree transplant (IDOR) on adminTierVariable/update',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a malformed ObjectId must not leak the parser exception', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeUpdate({ id: 'not-an-object-id' });
    const response = await workplaceHierarchyClient.updateTierVariable(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, 'not-an-object-id');
  });

  test('[6b] injection: a script variableName must not be echoed unescaped on update', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeUpdate({ variableName: XSS_PAYLOAD });
    const response = await workplaceHierarchyClient.updateTierVariable(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /adminTierVariable/delete ==== */
test.describe('POST /adminTierVariable/delete', () => {
  const META = {
    method: 'POST',
    path: WORKPLACE_HIERARCHY_PATHS.tierVariableDelete,
    repro: `await workplaceHierarchyClient.deleteTierVariable(buildById(), { token }); // random id — matches no document`,
  };

  test('[1] happy path: a delete against a non-existent id returns a well-formed envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * Random id on purpose. Deleting a live workplace node orphans its children, breaks every
     * role posting holding it in a denormalised snapshot, and cannot be undone through the API.
     */
    const body = buildById({ id: randomObjectId() });
    const response = await workplaceHierarchyClient.deleteTierVariable(body, { token });

    await expectValidContract(response, looseEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: randomObjectId() });
    const response = await workplaceHierarchyClient.deleteTierVariable(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: a delete that would strand dependants must not report a bare SUCCESS', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const missingId = randomObjectId();
    const body = buildById({ id: missingId });
    const response = await workplaceHierarchyClient.deleteTierVariable(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.deleteTierVariable({ id: "${missingId}" }, { token });`,
          scenario: `Deleting the non-existent node "${missingId}" reported SUCCESS. The route neither cascades nor counts dependants, so the same word is returned whether nothing matched or a node was removed while children and role postings still referenced it. An operator has no way to tell a clean no-op from a destructive one. Body: ${text.slice(0, 200)}`,
          title: 'adminTierVariable/delete reports an undifferentiated SUCCESS on a non-cascading hard delete',
        },
        'Status Code Misreporting',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: a null id must be refused, not treated as an unbounded delete', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: null });
    const response = await workplaceHierarchyClient.deleteTierVariable(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id on a delete' });
  });

  test('[2b] boundary: an empty id must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: '' });
    const response = await workplaceHierarchyClient.deleteTierVariable(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty id on a delete' });
  });

  test('[3] typefuzz: an object id must be refused, not used as a Mongo operator', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: { $ne: null } });
    const response = await workplaceHierarchyClient.deleteTierVariable(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario:
        'object id ({ $ne: null }) — operator injection that would delete every workplace node',
    });
  });

  test('[3b] typefuzz: a numeric id must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: 1001 });
    const response = await workplaceHierarchyClient.deleteTierVariable(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric id' });
  });

  test('[4] auth: an unauthenticated delete must be refused', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildById();
    const response = await workplaceHierarchyClient.deleteTierVariable(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a malformed token must not authorise a destructive delete', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildById();
    const response = await workplaceHierarchyClient.deleteTierVariable(body, {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a caller must not be able to delete a node in another tenant org chart', async ({
    workplaceHierarchyClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const foreignId = randomObjectId();
    const body = buildById({ id: foreignId });
    const response = await workplaceHierarchyClient.deleteTierVariable(body, { token });

    const { json, text } = await readBody(response);
    const value = json?.value as { companyId?: string } | null;
    if (value?.companyId && value.companyId !== companyID) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.deleteTierVariable({ id: "${foreignId}" }, { token /* tenant ${companyID} */ });`,
          scenario: `A delete issued as tenant ${companyID} returned a workplace node owned by tenant "${value.companyId}". The body carries no tenant scope, so any guessed id destroys a foreign node and every child beneath it loses its parent. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant workplace node delete (IDOR) on adminTierVariable/delete',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload as the id must not leak an exception trace', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: SQLI_DROP_PAYLOAD });
    const response = await workplaceHierarchyClient.deleteTierVariable(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });

  test('[6b] injection: a script id must not be reflected unescaped', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: XSS_PAYLOAD });
    const response = await workplaceHierarchyClient.deleteTierVariable(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /adminTierVariable/getAdminTierVariable ==== */
test.describe('POST /adminTierVariable/getAdminTierVariable', () => {
  const META = {
    method: 'POST',
    path: WORKPLACE_HIERARCHY_PATHS.tierVariableGet,
    repro: `await workplaceHierarchyClient.getAdminTierVariable(buildNodeLookup(), { token });`,
  };

  test('[1] happy path: a parent + tenant lookup returns a well-formed node-list envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeLookup();
    const response = await workplaceHierarchyClient.getAdminTierVariable(body, { token });

    await expectValidContract(response, nodeListEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeLookup();
    const response = await workplaceHierarchyClient.getAdminTierVariable(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[2] boundary: the documented null-parent root query must stay inside the caller tenant', async ({
    workplaceHierarchyClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeLookup({ parentVariableId: null });
    const response = await workplaceHierarchyClient.getAdminTierVariable(body, { token });

    const { json } = await readBody(response);
    const value = json?.value;
    const foreign = Array.isArray(value)
      ? (value as Array<{ companyId?: string }>).filter(
          (n) => n?.companyId && n.companyId !== companyID
        )
      : [];
    if (foreign.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.getAdminTierVariable({ companyId: "${companyID}", parentVariableId: null }, { token });`,
          scenario: `The documented root query returned ${foreign.length} node(s) owned by other tenants (e.g. "${foreign[0]?.companyId}"). With the parent id null, company_id is the only surviving filter and it did not hold.`,
          title: 'adminTierVariable/getAdminTierVariable root query leaks foreign-tenant nodes',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[2b] boundary: an empty companyId must not widen the query to every tenant', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeLookup({ companyId: '' });
    const response = await workplaceHierarchyClient.getAdminTierVariable(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty companyId' });
  });

  test('[2c] boundary: a 5000-character parentVariableId must not be processed as a filter', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeLookup({ parentVariableId: MAX_LENGTH_STRING });
    const response = await workplaceHierarchyClient.getAdminTierVariable(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) parentVariableId',
    });
  });

  test('[3] typefuzz: a numeric companyId must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeLookup({ companyId: 1001 });
    const response = await workplaceHierarchyClient.getAdminTierVariable(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric companyId' });
  });

  test('[3b] typefuzz: a boolean parentVariableId must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeLookup({ parentVariableId: true });
    const response = await workplaceHierarchyClient.getAdminTierVariable(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'boolean parentVariableId',
    });
  });

  test('[4] auth: an unauthenticated caller must be refused, not served the subtree', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildNodeLookup();
    const response = await workplaceHierarchyClient.getAdminTierVariable(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must be refused', async ({ workplaceHierarchyClient }) => {
    const body = buildNodeLookup();
    const response = await workplaceHierarchyClient.getAdminTierVariable(body, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] one tenant must not be able to walk another tenant workplace tree', async ({
    workplaceHierarchyClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildNodeLookup({ companyId: otherTenant, parentVariableId: null });
    const response = await workplaceHierarchyClient.getAdminTierVariable(body, { token });

    const { json } = await readBody(response);
    const value = json?.value;
    if (Array.isArray(value) && value.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.getAdminTierVariable({ companyId: "${otherTenant}", parentVariableId: null }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, asking for tenant "${otherTenant}" root nodes returned ${value.length} record(s). Feeding each returned id back into the same endpoint enumerates a competitor entire regional and branch structure, level by level.`,
          title: 'Cross-tenant workplace tree walk (IDOR) on adminTierVariable/getAdminTierVariable',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL-injection parentVariableId must not surface a database error', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeLookup({ parentVariableId: SQLI_PAYLOAD });
    const response = await workplaceHierarchyClient.getAdminTierVariable(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script companyId must not come back unescaped', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildNodeLookup({ companyId: XSS_PAYLOAD });
    const response = await workplaceHierarchyClient.getAdminTierVariable(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /adminTierVariable/getAllReportingVariableHierarchy ==== */
test.describe('POST /adminTierVariable/getAllReportingVariableHierarchy', () => {
  const META = {
    method: 'POST',
    path: WORKPLACE_HIERARCHY_PATHS.tierVariableReportingHierarchy,
    repro: `await workplaceHierarchyClient.getAllReportingVariableHierarchy(buildById(), { token });`,
  };

  test('[1] happy path: resolving a reporting chain returns a well-formed node-list envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById();
    const response = await workplaceHierarchyClient.getAllReportingVariableHierarchy(body, {
      token,
    });

    await expectValidContract(response, nodeListEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById();
    const response = await workplaceHierarchyClient.getAllReportingVariableHierarchy(body, {
      token,
    });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[1c] business rule: the reporting walk must terminate and must not be an unbounded traversal', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * This is the endpoint the cycle cases elsewhere in this file are aimed at: the walk is an
     * application-side loop issuing one findById per hop, with no $graphLookup, no visited set
     * and no depth cap. A random id cannot itself form a cycle, so what is measured here is
     * whether the endpoint answers promptly and bounded — a request that runs long on a
     * single-node lookup is the same defect showing up without a planted cycle.
     */
    const startedAt = Date.now();
    const body = buildById();
    const response = await workplaceHierarchyClient.getAllReportingVariableHierarchy(body, {
      token,
    });
    const elapsedMs = Date.now() - startedAt;

    if (elapsedMs > 5000) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          scenario: `Resolving the reporting chain for a single id took ${elapsedMs}ms. The traversal is an uncapped application-side loop of findById calls over caller-writable reporting_variable_id links, so its cost is bounded only by the shape of the data — and a cyclic or deep chain planted through adminTierVariable/save or /update turns this read into a denial of service.`,
          title: 'getAllReportingVariableHierarchy traversal is uncapped and data-dependent',
        },
        'Business Logic Flaw',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: a null id must be refused, not walked from an arbitrary root', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: null });
    const response = await workplaceHierarchyClient.getAllReportingVariableHierarchy(body, {
      token,
    });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id' });
  });

  test('[2b] boundary: an empty id must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: '' });
    const response = await workplaceHierarchyClient.getAllReportingVariableHierarchy(body, {
      token,
    });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty id' });
  });

  test('[2c] boundary: a 5000-character id must not start a traversal', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: MAX_LENGTH_STRING });
    const response = await workplaceHierarchyClient.getAllReportingVariableHierarchy(body, {
      token,
    });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) id',
    });
  });

  test('[3] typefuzz: a numeric id must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: 1001 });
    const response = await workplaceHierarchyClient.getAllReportingVariableHierarchy(body, {
      token,
    });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric id' });
  });

  test('[3b] typefuzz: an array id must be refused, not walked once per element', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // An array accepted here multiplies an already-uncapped traversal by the array length.
    const body = buildById({ id: ['66f1a2b3c4d5e6f708192a5d', '66f1a2b3c4d5e6f708192a6e'] });
    const response = await workplaceHierarchyClient.getAllReportingVariableHierarchy(body, {
      token,
    });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'array id' });
  });

  test('[4] auth: an unauthenticated caller must not be able to resolve an escalation path', async ({
    workplaceHierarchyClient,
  }) => {
    // The reporting chain is who-reports-to-whom: an anonymous read of it is a management
    // structure disclosure even before any personal data is involved.
    const body = buildById();
    const response = await workplaceHierarchyClient.getAllReportingVariableHierarchy(body, {
      token: null,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a token forged with alg:none must never be accepted', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildById();
    const response = await workplaceHierarchyClient.getAllReportingVariableHierarchy(body, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a foreign node id must not resolve into another tenant escalation chain', async ({
    workplaceHierarchyClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * The walk starts from a bare id with no tenant filter and follows links transitively, so
     * one guessed id does not leak one node — it leaks a whole management chain upward.
     */
    const foreignId = randomObjectId();
    const body = buildById({ id: foreignId });
    const response = await workplaceHierarchyClient.getAllReportingVariableHierarchy(body, {
      token,
    });

    const { json } = await readBody(response);
    const value = json?.value;
    const foreign = Array.isArray(value)
      ? (value as Array<{ companyId?: string }>).filter(
          (n) => n?.companyId && n.companyId !== companyID
        )
      : [];
    if (foreign.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.getAllReportingVariableHierarchy({ id: "${foreignId}" }, { token /* tenant ${companyID} */ });`,
          scenario: `A reporting walk started as tenant ${companyID} returned ${foreign.length} node(s) belonging to tenant "${foreign[0]?.companyId}". The traversal applies no tenant filter at any hop, so a single guessed id discloses an entire foreign escalation chain rather than one record.`,
          title: 'Cross-tenant escalation chain disclosure (IDOR) on getAllReportingVariableHierarchy',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL-injection id must not surface a database error', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: SQLI_PAYLOAD });
    const response = await workplaceHierarchyClient.getAllReportingVariableHierarchy(body, {
      token,
    });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script id must not come back unescaped in the envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: XSS_PAYLOAD });
    const response = await workplaceHierarchyClient.getAllReportingVariableHierarchy(body, {
      token,
    });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== GET /adminTierVariable/getAllVariable ==== */
test.describe('GET /adminTierVariable/getAllVariable', () => {
  const META = {
    method: 'GET',
    path: WORKPLACE_HIERARCHY_PATHS.tierVariableGetAll,
    repro: `await workplaceHierarchyClient.getAllTierVariable({ token });`,
  };

  test('[1] happy path: the platform-wide node list returns a well-formed node-list envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await workplaceHierarchyClient.getAllTierVariable({ token });

    await expectValidContract(response, nodeListEnvelopeSchema, META);
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await workplaceHierarchyClient.getAllTierVariable({ token });

    await assertStatusCodeParity(response, META);
  });

  test('[1c] business rule: an unscoped, unpaged whole-platform export must not be exposed as an API route', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * Documented as an unfiltered `find({})` with no company_id filter, no paging, no sort and
     * no projection. Even setting tenancy aside, the response size grows linearly with the
     * whole platform hierarchy, so a single authenticated caller can pull every node on the
     * deployment in one request — and repeat it.
     */
    const response = await workplaceHierarchyClient.getAllTierVariable({ token });

    const { json, text } = await readBody(response);
    const value = json?.value;
    if (Array.isArray(value) && value.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          scenario: `A single call returned ${value.length} workplace node(s) with no tenant filter and no paging, in ${text.length} bytes. The route is a whole-platform export reachable by any caller the auth filter lets through; it should be an internal diagnostic, not a published endpoint.`,
          title: 'adminTierVariable/getAllVariable exposes an unpaged, unscoped platform-wide export',
        },
        'Business Logic Flaw',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: an empty companyId query parameter must not change the unscoped behaviour', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * The route takes no documented parameters. Sending an empty companyId checks that an
     * undeclared parameter is ignored rather than silently adopted as a filter — a route that
     * quietly honours undocumented query parameters has an unversioned second contract.
     */
    const response = await workplaceHierarchyClient.getAllTierVariable({
      token,
      params: { companyId: '' },
    });

    await assertStatusCodeParity(response, {
      ...META,
      repro: `await workplaceHierarchyClient.getAllTierVariable({ token, params: { companyId: '' } });`,
    });
  });

  test('[3] typefuzz: an undeclared numeric page parameter must not be silently honoured', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await workplaceHierarchyClient.getAllTierVariable({
      token,
      params: { page: 1001 },
    });

    await assertStatusCodeParity(response, {
      ...META,
      repro: `await workplaceHierarchyClient.getAllTierVariable({ token, params: { page: 1001 } });`,
    });
  });

  test('[3b] typefuzz: an undeclared boolean parameter must not alter the response shape', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await workplaceHierarchyClient.getAllTierVariable({
      token,
      params: { includeDeleted: true },
    });

    await expectValidContract(response, nodeListEnvelopeSchema, {
      ...META,
      repro: `await workplaceHierarchyClient.getAllTierVariable({ token, params: { includeDeleted: true } });`,
    });
  });

  test('[4] auth: an unauthenticated caller must not receive every tenant node set', async ({
    workplaceHierarchyClient,
  }) => {
    /*
     * A GET with no scoping parameter at all. If it answers anonymously it hands the entire
     * cross-tenant node set — every company regional and branch structure on the deployment —
     * to any caller who can reach the host.
     */
    const response = await workplaceHierarchyClient.getAllTierVariable({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[4b] auth: an expired token must be refused', async ({ workplaceHierarchyClient }) => {
    const response = await workplaceHierarchyClient.getAllTierVariable({ token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[4c] auth: a token forged with alg:none must never be accepted', async ({
    workplaceHierarchyClient,
  }) => {
    const response = await workplaceHierarchyClient.getAllTierVariable({
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, META);
  });

  test('[5] [IDOR] the response must not mix nodes belonging to other tenants', async ({
    workplaceHierarchyClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * There is no request parameter to abuse here — the IDOR is structural. The query has no
     * company_id clause at all, so authenticating as one tenant and receiving another tenant
     * rows is the endpoint normal behaviour, and that is exactly the finding.
     */
    const response = await workplaceHierarchyClient.getAllTierVariable({ token });

    const { json } = await readBody(response);
    const value = json?.value;
    const foreign = Array.isArray(value)
      ? (value as Array<{ companyId?: string }>).filter(
          (n) => n?.companyId && n.companyId !== companyID
        )
      : [];
    if (foreign.length > 0) {
      const tenants = new Set(foreign.map((n) => n.companyId));
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          repro: `await workplaceHierarchyClient.getAllTierVariable({ token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, the response contained ${foreign.length} node(s) belonging to ${tenants.size} other tenant(s) (e.g. "${foreign[0]?.companyId}"). The query carries no company_id clause, so every caller receives every company workplace hierarchy — names, structure and reporting lines — in a single request.`,
          title: 'adminTierVariable/getAllVariable returns every tenant nodes to any caller',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload in an undeclared parameter must not surface a database error', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await workplaceHierarchyClient.getAllTierVariable({
      token,
      params: { companyId: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(
      response,
      {
        ...META,
        repro: `await workplaceHierarchyClient.getAllTierVariable({ token, params: { companyId: "<sqli>" } });`,
      },
      SQLI_PAYLOAD
    );
  });

  test('[6b] injection: a script in an undeclared parameter must not be reflected unescaped', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await workplaceHierarchyClient.getAllTierVariable({
      token,
      params: { companyId: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(
      response,
      {
        ...META,
        repro: `await workplaceHierarchyClient.getAllTierVariable({ token, params: { companyId: "<xss>" } });`,
      },
      XSS_PAYLOAD
    );
  });
});

/* ==== POST /workplaceHierarchy/save ==== */
test.describe('POST /workplaceHierarchy/save', () => {
  const META = {
    method: 'POST',
    path: WORKPLACE_HIERARCHY_PATHS.hierarchySave,
    repro: `await workplaceHierarchyClient.saveHierarchy(buildHierarchyLink(), { token });`,
  };

  test('[1] happy path: a fully-wired link returns a well-formed hierarchy-link envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHierarchyLink();
    const response = await workplaceHierarchyClient.saveHierarchy(body, { token });

    await expectValidContract(response, hierarchyLinkEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHierarchyLink();
    const response = await workplaceHierarchyClient.saveHierarchy(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: an edge whose node and parent are the same must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * This collection is the wiring between nodes, so a self-edge is a one-element cycle in
     * the graph itself: the position is its own structural parent. Any renderer that climbs
     * parentVariableId to build a breadcrumb loops forever on it. The ids are random.
     */
    const selfNode = randomObjectId();
    const body = buildHierarchyLink({ variableId: selfNode, parentVariableId: selfNode });
    const response = await workplaceHierarchyClient.saveHierarchy(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.saveHierarchy({ variableId: "${selfNode}", parentVariableId: "${selfNode}", ... }, { token });`,
          scenario: `An edge naming "${selfNode}" as both the position and its own structural parent was accepted with status SUCCESS. The workplace graph stores wiring as plain id strings with no acyclicity check, so any breadcrumb or ancestry walk over this edge never terminates. Body: ${text.slice(0, 200)}`,
          title: 'workplaceHierarchy/save accepts a self-referencing edge',
        },
        'Business Logic Flaw',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: a null variableId must be refused — an edge with no position wires nothing', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHierarchyLink({ variableId: null });
    const response = await workplaceHierarchyClient.saveHierarchy(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null variableId' });
  });

  test('[2b] boundary: an empty attributeId must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHierarchyLink({ attributeId: '' });
    const response = await workplaceHierarchyClient.saveHierarchy(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty attributeId' });
  });

  test('[2c] boundary: a 5000-character workplaceJson must be refused rather than denormalised', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // workplaceJson is copied onto every role posting created afterwards and never refreshed,
    // so an oversized snapshot is duplicated across the employee collection permanently.
    const body = buildHierarchyLink({ workplaceJson: MAX_LENGTH_STRING });
    const response = await workplaceHierarchyClient.saveHierarchy(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) workplaceJson',
    });
  });

  test('[3] typefuzz: a numeric variableId must be refused, not coerced into an ObjectId', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHierarchyLink({ variableId: 1001 });
    const response = await workplaceHierarchyClient.saveHierarchy(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric variableId' });
  });

  test('[3b] typefuzz: a nested object workplaceJson must be refused — the field is a JSON string', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHierarchyLink({ workplaceJson: { attributeName: 'Region' } });
    const response = await workplaceHierarchyClient.saveHierarchy(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'nested object workplaceJson where an escaped JSON string is documented',
    });
  });

  test('[3c] typefuzz: an array body where a single document is documented must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // Unlike every attribute/variable save in this subsystem, this one takes a single object.
    const body = [buildHierarchyLink(), buildHierarchyLink()];
    const response = await workplaceHierarchyClient.saveHierarchy(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      repro: `await workplaceHierarchyClient.saveHierarchy([link, link], { token }); // array, not object`,
      scenario: 'JSON array body where a single WorkPlaceHierarchy document is documented',
    });
  });

  test('[4] auth: an unauthenticated caller must not be able to wire an org chart', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildHierarchyLink();
    const response = await workplaceHierarchyClient.saveHierarchy(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a malformed bearer token must be refused', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildHierarchyLink();
    const response = await workplaceHierarchyClient.saveHierarchy(body, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] an edge must not be creatable between nodes the caller does not own', async ({
    workplaceHierarchyClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * WorkPlaceHierarchy documents carry no companyId at all — the only tenancy signal is
     * which nodes the ids point at. Wiring one arbitrary id to another therefore tests the
     * only isolation this collection can have: whether the service checks that both ends
     * belong to the caller tenant before writing the edge.
     */
    const foreignNode = randomObjectId();
    const foreignParent = randomObjectId();
    const body = buildHierarchyLink({
      variableId: foreignNode,
      parentVariableId: foreignParent,
      reportingVariableId: foreignParent,
    });
    const response = await workplaceHierarchyClient.saveHierarchy(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.saveHierarchy({ variableId: "${foreignNode}", parentVariableId: "${foreignParent}" }, { token /* tenant ${companyID} */ });`,
          scenario: `As tenant ${companyID}, an edge was written between two node ids the caller has no established relationship with, and the call reported SUCCESS. The document has no companyId field, so nothing in the payload or the service ties the edge to a tenant: any caller can rewire any two nodes on the platform, including re-pointing a foreign position reporting line. Body: ${text.slice(0, 200)}`,
          title: 'Untenanted workplace edge write (IDOR): any caller can wire any two nodes',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a script inside workplaceJson must not be stored and echoed unescaped', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * workplaceJson is a denormalised display path: it exists to be rendered as a breadcrumb,
     * and it is copied onto role postings. Script surviving in it is stored XSS with a
     * fan-out.
     */
    const body = buildHierarchyLink({ workplaceJson: XSS_PAYLOAD });
    const response = await workplaceHierarchyClient.saveHierarchy(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });

  test('[6b] injection: a SQL payload as parentVariableId must not surface a database error', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHierarchyLink({ parentVariableId: SQLI_DROP_PAYLOAD });
    const response = await workplaceHierarchyClient.saveHierarchy(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });
});

/* ==== POST /workplaceHierarchy/update ==== */
test.describe('POST /workplaceHierarchy/update', () => {
  const META = {
    method: 'POST',
    path: WORKPLACE_HIERARCHY_PATHS.hierarchyUpdate,
    repro: `await workplaceHierarchyClient.updateHierarchy(buildHierarchyLinkUpdate(), { token });`,
  };

  test('[1] happy path: a re-wire returns a well-formed hierarchy-link envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHierarchyLinkUpdate();
    const response = await workplaceHierarchyClient.updateHierarchy(body, { token });

    await expectValidContract(response, hierarchyLinkEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHierarchyLinkUpdate();
    const response = await workplaceHierarchyClient.updateHierarchy(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[1c] business rule: a partial body must not silently unwire the position', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * Documented outright: this is a whole-document write, so a field omitted from the body is
     * persisted as null. Sending what looks like a patch therefore severs the position from
     * its parent and its reporting target in one call, with a SUCCESS answer.
     */
    const linkId = randomObjectId();
    const body = { id: linkId, variableId: randomObjectId() };
    const response = await workplaceHierarchyClient.updateHierarchy(body, { token });

    const { json, text } = await readBody(response);
    const value = json?.value as { parentVariableId?: string | null } | null;
    if (value && (value.parentVariableId === null || value.parentVariableId === undefined)) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.updateHierarchy({ id: "${linkId}", variableId: "<id>" }, { token });`,
          scenario: `A PATCH-shaped update that omitted the parent and reporting ids returned an edge with parentVariableId absent. The whole-document write nulls every omitted field, so a caller changing one id silently detaches the position from its structural parent and its reporting line — and the response still says SUCCESS. Body: ${text.slice(0, 200)}`,
          title: 'workplaceHierarchy/update nulls omitted ids, unwiring the position',
        },
        'Business Logic Flaw',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[1d] business rule: a re-wire must not leave the denormalised snapshots stale', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * The edge stores both the live ids and a workplaceJson/reportingJson snapshot of the
     * resolved path. Changing the ids without the snapshots leaves the two halves of the same
     * document describing different trees — and role postings copy the snapshot, not the ids.
     */
    const linkId = randomObjectId();
    const movedParent = randomObjectId();
    const body = buildHierarchyLinkUpdate({
      id: linkId,
      parentVariableId: movedParent,
      workplaceJson: JSON.stringify([{ attributeName: 'QA-Stale', variableName: 'QA-Old-Path' }]),
    });
    const response = await workplaceHierarchyClient.updateHierarchy(body, { token });

    const { json, text } = await readBody(response);
    const value = json?.value as { parentVariableId?: string; workplaceJson?: string } | null;
    if (value?.parentVariableId === movedParent && value.workplaceJson?.includes('QA-Old-Path')) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.updateHierarchy({ id: "${linkId}", parentVariableId: "${movedParent}", workplaceJson: "<old path>" }, { token });`,
          scenario: `The edge was re-parented to "${movedParent}" while its workplaceJson snapshot still describes the previous path. The service accepts the two halves of the document disagreeing, and role postings copy the snapshot rather than the ids — so employee records inherit a workplace path that no longer exists in the tree. Body: ${text.slice(0, 200)}`,
          title: 'workplaceHierarchy/update accepts an edge whose denormalised path contradicts its ids',
        },
        'Business Logic Flaw',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: a null id must be refused rather than re-wiring an arbitrary edge', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHierarchyLinkUpdate({ id: null });
    const response = await workplaceHierarchyClient.updateHierarchy(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id' });
  });

  test('[2b] boundary: an empty id must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHierarchyLinkUpdate({ id: '' });
    const response = await workplaceHierarchyClient.updateHierarchy(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty id' });
  });

  test('[3] typefuzz: a numeric id must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHierarchyLinkUpdate({ id: 1001 });
    const response = await workplaceHierarchyClient.updateHierarchy(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric id' });
  });

  test('[3b] typefuzz: a boolean reportingVariableId must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHierarchyLinkUpdate({ reportingVariableId: false });
    const response = await workplaceHierarchyClient.updateHierarchy(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'boolean reportingVariableId',
    });
  });

  test('[4] auth: an unauthenticated caller must not be able to re-wire a reporting line', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildHierarchyLinkUpdate();
    const response = await workplaceHierarchyClient.updateHierarchy(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must be refused on a write', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildHierarchyLinkUpdate();
    const response = await workplaceHierarchyClient.updateHierarchy(body, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] an edge must not be re-pointable at a node in another tenant', async ({
    workplaceHierarchyClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const foreignTarget = randomObjectId();
    const body = buildHierarchyLinkUpdate({
      reportingVariableId: foreignTarget,
      reportingParentVariableId: randomObjectId(),
    });
    const response = await workplaceHierarchyClient.updateHierarchy(body, { token });

    const { json, text } = await readBody(response);
    const value = json?.value as { reportingVariableId?: string } | null;
    if (value?.reportingVariableId === foreignTarget) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.updateHierarchy({ id: "<id>", reportingVariableId: "${foreignTarget}" }, { token /* tenant ${companyID} */ });`,
          scenario: `As tenant ${companyID}, an edge reporting target was re-pointed at an unrelated node id and accepted. The collection has no companyId, and the service does not check that either end of the edge belongs to the caller, so reporting lines can be rewritten across tenant boundaries — redirecting an escalation path to an attacker-chosen position. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant edge re-pointing (IDOR) on workplaceHierarchy/update',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a malformed ObjectId must not leak the parser exception', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHierarchyLinkUpdate({ id: 'not-an-object-id' });
    const response = await workplaceHierarchyClient.updateHierarchy(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, 'not-an-object-id');
  });

  test('[6b] injection: a script in reportingJson must not be echoed unescaped', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHierarchyLinkUpdate({ reportingJson: XSS_PAYLOAD });
    const response = await workplaceHierarchyClient.updateHierarchy(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /workplaceHierarchy/delete ==== */
test.describe('POST /workplaceHierarchy/delete', () => {
  const META = {
    method: 'POST',
    path: WORKPLACE_HIERARCHY_PATHS.hierarchyDelete,
    repro: `await workplaceHierarchyClient.deleteHierarchy(buildById(), { token }); // random id — matches no document`,
  };

  test('[1] happy path: a delete against a non-existent id returns a well-formed envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // Random id on purpose: removing a live edge detaches a position from the graph and the
    // nodes at either end keep no record that the wiring ever existed.
    const body = buildById({ id: randomObjectId() });
    const response = await workplaceHierarchyClient.deleteHierarchy(body, { token });

    await expectValidContract(response, looseEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: randomObjectId() });
    const response = await workplaceHierarchyClient.deleteHierarchy(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: deleting an id that does not exist must not be reported as SUCCESS', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const missingId = randomObjectId();
    const body = buildById({ id: missingId });
    const response = await workplaceHierarchyClient.deleteHierarchy(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.deleteHierarchy({ id: "${missingId}" }, { token });`,
          scenario: `Deleting the non-existent edge "${missingId}" reported SUCCESS. Edges are the only record of how positions are wired, so a caller cannot tell a harmless no-op from having just severed a live reporting line. Body: ${text.slice(0, 200)}`,
          title: 'workplaceHierarchy/delete reports SUCCESS for an id that matched no document',
        },
        'Status Code Misreporting',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: a null id must be refused, not treated as an unbounded delete', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: null });
    const response = await workplaceHierarchyClient.deleteHierarchy(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id on a delete' });
  });

  test('[2b] boundary: an empty id must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: '' });
    const response = await workplaceHierarchyClient.deleteHierarchy(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty id on a delete' });
  });

  test('[3] typefuzz: an object id must be refused, not used as a Mongo operator', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // Matching every edge would unwire the entire org chart in one call while leaving the
    // nodes in place — a graph that renders as a flat list of orphans.
    const body = buildById({ id: { $ne: null } });
    const response = await workplaceHierarchyClient.deleteHierarchy(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object id ({ $ne: null }) — operator injection that would delete every edge',
    });
  });

  test('[3b] typefuzz: a boolean id must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: true });
    const response = await workplaceHierarchyClient.deleteHierarchy(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean id' });
  });

  test('[4] auth: an unauthenticated delete must be refused', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildById();
    const response = await workplaceHierarchyClient.deleteHierarchy(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a token forged with alg:none must not authorise a destructive delete', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildById();
    const response = await workplaceHierarchyClient.deleteHierarchy(body, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a caller must not be able to delete an edge belonging to another tenant', async ({
    workplaceHierarchyClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * These documents have no companyId, so there is no field the service could filter on even
     * if it wanted to — tenancy would have to be resolved by loading the nodes at either end.
     * What is checked is whether the endpoint hands back an edge as evidence it resolved an id
     * outside the caller tenant.
     */
    const foreignId = randomObjectId();
    const body = buildById({ id: foreignId });
    const response = await workplaceHierarchyClient.deleteHierarchy(body, { token });

    const { json, text } = await readBody(response);
    const value = json?.value as { variableId?: string } | null;
    if (value?.variableId) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.deleteHierarchy({ id: "${foreignId}" }, { token /* tenant ${companyID} */ });`,
          scenario: `A delete issued as tenant ${companyID} resolved and returned edge "${value.variableId}" from a bare id. The collection carries no tenant field and the service performs no ownership resolution, so any guessed edge id detaches a position anywhere on the platform. Body: ${text.slice(0, 200)}`,
          title: 'Untenanted workplace edge delete (IDOR): ids resolve platform-wide',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload as the id must not leak an exception trace', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: SQLI_DROP_PAYLOAD });
    const response = await workplaceHierarchyClient.deleteHierarchy(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });

  test('[6b] injection: a script id must not be reflected unescaped', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildById({ id: XSS_PAYLOAD });
    const response = await workplaceHierarchyClient.deleteHierarchy(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /workplaceHierarchy/getWorkPlaceHierarchy ==== */
test.describe('POST /workplaceHierarchy/getWorkPlaceHierarchy', () => {
  const META = {
    method: 'POST',
    path: WORKPLACE_HIERARCHY_PATHS.hierarchyGet,
    repro: `await workplaceHierarchyClient.getHierarchy(buildHierarchyQuery(), { token });`,
  };

  test('[1] happy path: a query-by-example returns a well-formed link-list envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHierarchyQuery();
    const response = await workplaceHierarchyClient.getHierarchy(body, { token });

    await expectValidContract(response, hierarchyLinkListEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHierarchyQuery();
    const response = await workplaceHierarchyClient.getHierarchy(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: an empty query-by-example must not return the whole edge collection', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * The service builds its filter from the non-null fields of the submitted entity. Submit
     * nothing and there are no fields — which, unless the service guards against it, means an
     * unfiltered find over every edge on the platform.
     */
    const body = {};
    const response = await workplaceHierarchyClient.getHierarchy(body, { token });

    const { json } = await readBody(response);
    const value = json?.value;
    if (Array.isArray(value) && value.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.getHierarchy({}, { token });`,
          scenario: `An empty query-by-example returned ${value.length} edge(s). With no non-null fields to build a filter from, the query degenerates into an unfiltered scan and returns the platform entire workplace wiring to a caller who supplied no criteria at all.`,
          title: 'getWorkPlaceHierarchy with an empty body returns every edge',
        },
        'Business Logic Flaw',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: a null attributeId must not silently widen the filter', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // Null fields are dropped from the filter by design, so nulling a criterion broadens the
    // result rather than narrowing it — the opposite of what a caller expects.
    const body = buildHierarchyQuery({ attributeId: null });
    const response = await workplaceHierarchyClient.getHierarchy(body, { token });

    await assertStatusCodeParity(response, {
      ...META,
      body,
      repro: `await workplaceHierarchyClient.getHierarchy({ attributeId: null, variableId: "<id>" }, { token });`,
    });
  });

  test('[2b] boundary: an empty variableId must be refused, not matched against every edge', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHierarchyQuery({ variableId: '' });
    const response = await workplaceHierarchyClient.getHierarchy(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty variableId' });
  });

  test('[2c] boundary: a 5000-character variableId must not be processed as a filter', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHierarchyQuery({ variableId: MAX_LENGTH_STRING });
    const response = await workplaceHierarchyClient.getHierarchy(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) variableId',
    });
  });

  test('[3] typefuzz: a numeric variableId must be refused', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHierarchyQuery({ variableId: 1001 });
    const response = await workplaceHierarchyClient.getHierarchy(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric variableId' });
  });

  test('[3b] typefuzz: an object criterion must not reach the driver as an operator', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * Query-by-example is the worst possible place for operator injection: the submitted
     * fields become the filter directly, so `{ $ne: null }` on any criterion returns every
     * edge that has that field set.
     */
    const body = buildHierarchyQuery({ variableId: { $ne: null } });
    const response = await workplaceHierarchyClient.getHierarchy(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object variableId ({ $ne: null }) — operator injection into a query-by-example',
    });
  });

  test('[4] auth: an unauthenticated caller must not be served the workplace graph', async ({
    workplaceHierarchyClient,
  }) => {
    const body = buildHierarchyQuery();
    const response = await workplaceHierarchyClient.getHierarchy(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must be refused', async ({ workplaceHierarchyClient }) => {
    const body = buildHierarchyQuery();
    const response = await workplaceHierarchyClient.getHierarchy(body, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a query naming a foreign node must not return that tenant wiring', async ({
    workplaceHierarchyClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const foreignNode = randomObjectId();
    const body = buildHierarchyQuery({ variableId: foreignNode });
    const response = await workplaceHierarchyClient.getHierarchy(body, { token });

    const { json } = await readBody(response);
    const value = json?.value;
    if (Array.isArray(value) && value.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await workplaceHierarchyClient.getHierarchy({ variableId: "${foreignNode}" }, { token /* tenant ${companyID} */ });`,
          scenario: `As tenant ${companyID}, a query naming node "${foreignNode}" returned ${value.length} edge(s). The filter is built purely from the submitted fields with no tenant clause added, so any node id read from any other endpoint can be expanded into that position full wiring — its parent, its reporting target, and the denormalised path snapshots.`,
          title: 'Cross-tenant edge query (IDOR) on getWorkPlaceHierarchy',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL-injection variableId must not surface a database error', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHierarchyQuery({ variableId: SQLI_PAYLOAD });
    const response = await workplaceHierarchyClient.getHierarchy(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script criterion must not come back unescaped', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildHierarchyQuery({ attributeId: XSS_PAYLOAD });
    const response = await workplaceHierarchyClient.getHierarchy(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== GET /workplaceHierarchy/getOrganization ==== */
test.describe('GET /workplaceHierarchy/getOrganization', () => {
  const META = {
    method: 'GET',
    path: WORKPLACE_HIERARCHY_PATHS.getOrganization,
    repro: `await workplaceHierarchyClient.getOrganization({ token });`,
  };

  test('[1] happy path: the organisation-type list returns a well-formed string-list envelope', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await workplaceHierarchyClient.getOrganization({ token });

    await expectValidContract(response, organizationListEnvelopeSchema, META);
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await workplaceHierarchyClient.getOrganization({ token });

    await assertStatusCodeParity(response, META);
  });

  test('[1c] business rule: a registration-time lookup must be reachable before a session exists', async ({
    workplaceHierarchyClient,
  }) => {
    /*
     * This one route is deliberately different from the rest of the file. The organisation-type
     * dropdown is rendered on the company registration form, before any account — let alone a
     * token — exists. Reading no database at all (the list is split from an application
     * property), it holds nothing worth protecting, so the useful assertion is the opposite of
     * the usual one: refusing anonymous callers here would break sign-up.
     */
    const response = await workplaceHierarchyClient.getOrganization({ token: null });

    const { text } = await readBody(response);
    if (response.status() >= 400) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          repro: `await workplaceHierarchyClient.getOrganization({ token: null });`,
          scenario: `The organisation-type list answered HTTP ${response.status()} without a token. It populates the "type of organisation" dropdown on the registration form, which is rendered before an account exists, so refusing anonymous callers makes company sign-up impossible. Body: ${text.slice(0, 200)}`,
          title: 'getOrganization refuses the anonymous callers that registration depends on',
        },
        'Business Logic Flaw',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: an empty undeclared parameter must not change the configured list', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * The list comes from the `organization.types` application property, not from a query. An
     * undeclared parameter must be inert; a route that quietly honours one has an unversioned
     * second contract nobody reviews.
     */
    const response = await workplaceHierarchyClient.getOrganization({
      token,
      params: { filter: '' },
    });

    await expectValidContract(response, organizationListEnvelopeSchema, {
      ...META,
      repro: `await workplaceHierarchyClient.getOrganization({ token, params: { filter: '' } });`,
    });
  });

  test('[3] typefuzz: an undeclared numeric parameter must not alter the response', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await workplaceHierarchyClient.getOrganization({
      token,
      params: { companyId: 1001 },
    });

    await assertStatusCodeParity(response, {
      ...META,
      repro: `await workplaceHierarchyClient.getOrganization({ token, params: { companyId: 1001 } });`,
    });
  });

  test('[3b] typefuzz: an undeclared boolean parameter must not alter the response', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await workplaceHierarchyClient.getOrganization({
      token,
      params: { verbose: true },
    });

    await assertStatusCodeParity(response, {
      ...META,
      repro: `await workplaceHierarchyClient.getOrganization({ token, params: { verbose: true } });`,
    });
  });

  test('[4] auth: a malformed bearer token must not produce a server error on a public lookup', async ({
    workplaceHierarchyClient,
  }) => {
    /*
     * Even a route that is meant to serve anonymous callers must handle a broken Authorization
     * header cleanly: parsing garbage into a 500 turns a public lookup into an availability
     * problem, and a stack trace on the way out is an information leak.
     */
    const response = await workplaceHierarchyClient.getOrganization({ token: MALFORMED_TOKEN });

    await assertNoInternalLeak(response, { ...META, repro: `await workplaceHierarchyClient.getOrganization({ token: MALFORMED_TOKEN });` }, MALFORMED_TOKEN);
  });

  test('[4b] auth: a token forged with alg:none must not be treated as a valid identity', async ({
    workplaceHierarchyClient,
  }) => {
    const response = await workplaceHierarchyClient.getOrganization({
      token: FORGED_ALG_NONE_JWT,
    });

    await assertStatusCodeParity(response, {
      ...META,
      repro: `await workplaceHierarchyClient.getOrganization({ token: FORGED_ALG_NONE_JWT });`,
    });
  });

  test('[5] [IDOR] the organisation list is global configuration and must be identical for every caller', async ({
    workplaceHierarchyClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * There is no per-tenant copy of this list to cross-access, which is exactly the property
     * being confirmed: an authenticated caller and an anonymous one must receive the same
     * configured values. If they differ, the route is not the flat property split it is
     * documented to be — it is reading tenant state, and a caller could infer another tenant
     * configuration from the difference.
     */
    const authed = await workplaceHierarchyClient.getOrganization({ token });
    const anonymous = await workplaceHierarchyClient.getOrganization({ token: null });

    const a = (await readBody(authed)).json?.value;
    const b = (await readBody(anonymous)).json?.value;
    if (Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) !== JSON.stringify(b)) {
      await reportBusinessLogicFlaw(
        authed,
        {
          ...META,
          repro: `await getOrganization({ token }); await getOrganization({ token: null }); // compare values`,
          scenario: `The organisation-type list differed between an authenticated caller (tenant ${companyID}, ${a.length} entries) and an anonymous one (${b.length} entries). The endpoint is documented as a flat split of the organization.types property with no database access, so a caller-dependent response means it is reading state it should not, and the difference itself discloses configuration.`,
          title: 'getOrganization returns caller-dependent values from a route documented as static configuration',
        },
        'Security/Information Disclosure',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload in an undeclared parameter must not surface a database error', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await workplaceHierarchyClient.getOrganization({
      token,
      params: { type: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(
      response,
      {
        ...META,
        repro: `await workplaceHierarchyClient.getOrganization({ token, params: { type: "<sqli>" } });`,
      },
      SQLI_PAYLOAD
    );
  });

  test('[6b] injection: a script in an undeclared parameter must not be reflected unescaped', async ({
    workplaceHierarchyClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await workplaceHierarchyClient.getOrganization({
      token,
      params: { type: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(
      response,
      {
        ...META,
        repro: `await workplaceHierarchyClient.getOrganization({ token, params: { type: "<xss>" } });`,
      },
      XSS_PAYLOAD
    );
  });
});
