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
import { PRODUCT_PATHS } from '../../src/api/clients/productLicensing.client';
import {
  productListEnvelopeSchema,
  purchaseListEnvelopeSchema,
  purchaseEnvelopeSchema,
  mappingListEnvelopeSchema,
  mappingEnvelopeSchema,
  mappedRolePostingListEnvelopeSchema,
  kpostIdsEnvelopeSchema,
  demoListEnvelopeSchema,
  demoEnvelopeSchema,
  projectListEnvelopeSchema,
} from '../../src/api/schemas/productLicensing.schema';
import {
  buildProductMaster,
  buildProductArray,
  buildProductPurchase,
  buildEmployeeMapping,
  buildEmployeeMappingArray,
  buildMappingQuery,
  buildDemoRequest,
  buildProjectDetails,
  buildProjectArray,
  randomObjectId,
} from '../../src/api/payloads/productLicensing.payload';
import { unroutableMobile } from '../../src/utils/safeTestData';

/*
 * Product & Licensing — the commercial subsystem.
 *
 * ## This suite bundles five Swagger tags
 *
 * `Product Catalogue` (/productMaster/*), `Product Subscriptions` (/productPurchase/*),
 * `Product ↔ Employee Licensing` (/productEmployeeMapping/*), `Product Demo Requests`
 * (/demo/*) and `Project Catalogue` (/project/*) run as one Playwright project because they
 * are one owning subsystem: a purchase decides what a tenant may open, a mapping decides who
 * inside that tenant may open it, and the two catalogues supply the things being bought.
 * **Bundling groups test execution only.** Bug ownership is still resolved per path by
 * `MODULE_BY_PATH`, so a defect on /demo/* routes to the demo tag's team and a defect on
 * /productPurchase/* routes to the subscriptions team, exactly as if they were separate files.
 *
 * One describe per endpoint titled with its bare `METHOD /path` signature, explicit standalone
 * cases — no loops, no factories — so every case is individually named, reportable and
 * skippable, and so `scripts/audit-vectors.ts` can group coverage by endpoint. Templated
 * segments are spelled as api.json spells them (`{companyId}`), never as a concrete value.
 *
 * ## What is dangerous here
 *
 * `POST /demo/createDemoRequest` is the public "request a demo" form and its records land in
 * a queue a human sales team works — a submission can reach a real inbox. Every case that
 * fills a contact field routes through `safeTestData.ts` (`TEST_MOBILE` / `TEST_EMAIL`) or
 * `unroutableMobile()`. **Faker must never generate a phone number or an e-mail address on
 * this route**: a random 10-digit Indian number is a real subscriber.
 *
 * Nothing in this subsystem is a hard delete, so the write paths are exercised for real — but
 * with throwaway faker labels (`QA-AUTOMATION-*`) and random ObjectIds, never against a
 * catalogue document a live tenant depends on.
 *
 * The valuable defects here are **commercial, not structural**. Entitlement is decided by
 * these five tags, so the cases that matter most are: a subscription bought with a negative,
 * zero or absurd licence quantity; more employees licensed to a product than the company
 * purchased, or than it purchased at all; a subscription whose end date precedes its start;
 * and — the sharpest of the set — a foreign `companyId` in the body or query. A cross-tenant
 * read here discloses **what a competitor has bought**, and the two mapped-employee routes
 * hand back kpostIDs, which are identifiers for named staff. Those are graded Critical.
 *
 * ## Envelope reminder
 *
 * Every route answers HTTP 200 or 500 only, carrying
 * `{ value, status: SUCCESS|FAILURE, statusCode, urlPath, error? }` — the payload is in
 * `value`, never `data`, and `status` is UPPERCASE. There is no 404: a missing document is
 * 200 with `value: null`/`[]`, or 500 with `status: FAILURE`. HTTP 200 says nothing about
 * success, so assertions read the envelope's status word, never the transport alone.
 */

const XSS_PAYLOAD = `<script>alert('licensing')</script>`;
const SQLI_PAYLOAD = `1001' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE table_product_purchase; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);

/* ==== GET /productMaster/productList/{companyId} ==== */
test.describe('GET /productMaster/productList/{companyId}', () => {
  const META = {
    method: 'GET',
    path: PRODUCT_PATHS.productList,
    repro: `await productLicensingClient.getProductListByCompany(companyID, { token });`,
  };

  test('[1] happy path: a tenant number returns the catalogue decorated with its subscription state', async ({
    productLicensingClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const response = await productLicensingClient.getProductListByCompany(companyID ?? '1001', {
      token,
    });

    await expectValidContract(response, productListEnvelopeSchema, META);
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    productLicensingClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const response = await productLicensingClient.getProductListByCompany(companyID ?? '1001', {
      token,
    });

    await assertStatusCodeParity(response, META);
  });

  test('[1c] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    productLicensingClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const response = await productLicensingClient.getProductListByCompany(companyID ?? '1001', {
      token,
    });

    await assertNot200OKOnError(response, META);
  });

  test('[1d] contract: the envelope urlPath must name this route, not a copy-pasted one', async ({
    productLicensingClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * Documented defect: `urlPath` on this route is hardcoded to "countryList". It is the only
     * field in the envelope that tells a log aggregator which endpoint produced a record, so a
     * wrong value silently attributes this route's errors to the country lookup. Cosmetic in
     * isolation, corrosive in a dashboard — Low.
     */
    const response = await productLicensingClient.getProductListByCompany(companyID ?? '1001', {
      token,
    });

    const { json } = await readBody(response);
    const urlPath = typeof json?.urlPath === 'string' ? json.urlPath : null;
    if (urlPath !== null && !urlPath.toLowerCase().includes('productlist')) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          scenario: `The product-list response reported urlPath "${urlPath}" instead of naming this route. Every consumer of the envelope — log aggregation, error attribution, the audit trail — reads urlPath to identify the origin endpoint, so this route's failures are filed against a different one.`,
          title: 'productList envelope reports a copy-pasted urlPath',
        },
        'Schema Violation',
        'Low'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: an empty companyId path segment must be refused, not answered', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const pathParam = { companyId: '' };
    const response = await productLicensingClient.getProductListByCompany(pathParam.companyId, {
      token,
    });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        repro: `await productLicensingClient.getProductListByCompany("", { token });`,
        scenario: 'empty companyId path segment',
        severity: 'Major',
      },
      [400, 422]
    );
  });

  test('[2b] boundary: a null companyId must not be treated as "every tenant"', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const pathParam = { companyId: null };
    const response = await productLicensingClient.getProductListByCompany(pathParam.companyId, {
      token,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, scenario: 'null companyId path segment', severity: 'Major' },
      [400, 422]
    );
  });

  test('[2c] boundary: a 5000-character companyId must not be processed as a lookup key', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await productLicensingClient.getProductListByCompany(MAX_LENGTH_STRING, {
      token,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, scenario: 'oversized (5000-char) companyId path segment', severity: 'Major' },
      [400, 422]
    );
  });

  test('[3] typefuzz: a boolean companyId must not be coerced into a tenant lookup', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const pathParam = { companyId: true };
    const response = await productLicensingClient.getProductListByCompany(pathParam.companyId, {
      token,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, scenario: 'boolean companyId path segment', severity: 'Major' },
      [400, 422]
    );
  });

  test('[3b] typefuzz: an array companyId must be refused, not flattened into a key', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // String(['1001','1002']) is "1001,1002" — a value that resembles two tenants at once.
    const pathParam = { companyId: ['1001', '1002'] };
    const response = await productLicensingClient.getProductListByCompany(pathParam.companyId, {
      token,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, scenario: 'array companyId path segment', severity: 'Major' },
      [400, 422]
    );
  });

  test('[4] auth: an unauthenticated caller must not be served a tenant catalogue view', async ({
    productLicensingClient,
    companyID,
  }) => {
    /*
     * api.json places every route except the eight registration ones under the global
     * bearerAuth requirement, but SecurityConfiguration permits "/**". A 200 here is a real
     * spec/implementation mismatch: Major on its own, Critical if protected material returns.
     */
    const response = await productLicensingClient.getProductListByCompany(companyID ?? '1001', {
      token: null,
    });

    await assertUnauthorized(response, META);
  });

  test('[4b] auth: an expired token must be refused', async ({
    productLicensingClient,
    companyID,
  }) => {
    const response = await productLicensingClient.getProductListByCompany(companyID ?? '1001', {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, META);
  });

  test('[4c] auth: a token forged with alg:none must never be accepted', async ({
    productLicensingClient,
    companyID,
  }) => {
    // An alg:none token is unsigned by construction. Honouring one means the filter trusts the
    // header's algorithm claim, so anyone can mint any tenant identity.
    const response = await productLicensingClient.getProductListByCompany(companyID ?? '1001', {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, META);
  });

  test("[5] [IDOR] one tenant must not read another tenant's subscription state", async ({
    productLicensingClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * The catalogue itself is global, but the `isPurchased` flag and the nested
     * `productPurchase` are the calling tenant's commercial position. Serving them for a
     * foreign companyId tells any customer exactly which KPOST products a competitor has
     * bought, on what plan, and when the subscription lapses.
     */
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const response = await productLicensingClient.getProductListByCompany(otherTenant, { token });

    const { json, text } = await readBody(response);
    const value = json?.value;
    const disclosed =
      Array.isArray(value) &&
      value.some(
        (product) =>
          product !== null &&
          typeof product === 'object' &&
          ((product as Record<string, unknown>).isPurchased === true ||
            (product as Record<string, unknown>).productPurchase != null)
      );
    if (disclosed) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          repro: `await productLicensingClient.getProductListByCompany("${otherTenant}", { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, the path companyId "${otherTenant}" returned that tenant's purchase state — products flagged isPurchased with their subscription sub-documents. The path segment overrides the token's tenant, so any customer can enumerate a competitor's product entitlements, plan and renewal dates. Body: ${text.slice(0, 200)}`,
          title: "Cross-tenant subscription-state disclosure (IDOR) via the productList path segment",
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true); // presence-only assertion; the finding above is the signal
  });

  test('[6] injection: a SQL payload in the path segment must not surface a database error', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await productLicensingClient.getProductListByCompany(SQLI_PAYLOAD, { token });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script path segment must not come back unescaped in the envelope', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await productLicensingClient.getProductListByCompany(XSS_PAYLOAD, { token });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });
});

/* ==== POST /productMaster/save ==== */
test.describe('POST /productMaster/save', () => {
  const META = {
    method: 'POST',
    path: PRODUCT_PATHS.saveProducts,
    repro: `await productLicensingClient.saveProducts(buildProductArray(2), { token });`,
  };

  test('[1] happy path: a valid array of catalogue products is accepted', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProductArray(2);
    const response = await productLicensingClient.saveProducts(body, { token });

    await assertStatus(response, [200], { ...META, body });
  });

  test('[1b] contract: the save response satisfies the product-list envelope', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProductArray(1);
    const response = await productLicensingClient.saveProducts(body, { token });

    await expectValidContract(response, productListEnvelopeSchema, { ...META, body });
  });

  test('[1c] parity: the HTTP status must agree with the envelope statusCode', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProductArray(1);
    const response = await productLicensingClient.saveProducts(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1d] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProductArray(1);
    const response = await productLicensingClient.saveProducts(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[1e] business rule: a duplicate productCode must not be accepted as a second catalogue entry', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * `productCode` is documented as "the stable cross-module product reference… should be
     * unique, though nothing enforces it". Two products sharing a code make every downstream
     * entitlement lookup ambiguous: a subscription resolves to whichever document the driver
     * returns first.
     */
    const sharedCode = 'QADUP';
    const body = buildProductArray(2, { productCode: sharedCode });
    const response = await productLicensingClient.saveProducts(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await productLicensingClient.saveProducts(buildProductArray(2, { productCode: "${sharedCode}" }), { token });`,
          scenario: `Two catalogue products sharing productCode "${sharedCode}" were both accepted. The code is the cross-module product reference, so entitlement lookups that resolve a product by code now match two documents and pick one arbitrarily. Body: ${text.slice(0, 200)}`,
          title: 'Duplicate productCode accepted into the global catalogue',
        },
        'Business Logic Flaw',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: an empty array must not be reported as a successful catalogue load', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body: unknown[] = [];
    const response = await productLicensingClient.saveProducts(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      repro: `await productLicensingClient.saveProducts([], { token });`,
      scenario: 'empty product array',
    });
  });

  test('[2b] boundary: a null productName must be refused, not stored as a nameless product', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProductArray(1, { productName: null });
    const response = await productLicensingClient.saveProducts(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null productName' });
  });

  test('[2c] boundary: a 5000-character productDescription must be refused rather than stored', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProductArray(1, { productDescription: MAX_LENGTH_STRING });
    const response = await productLicensingClient.saveProducts(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) productDescription',
    });
  });

  test('[3] typefuzz: an object body where the documented shape is an array must be refused', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProductMaster(); // a single object where an array is required
    const response = await productLicensingClient.saveProducts(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      repro: `await productLicensingClient.saveProducts(buildProductMaster(), { token }); // object, not array`,
      scenario: 'object body instead of a JSON array',
    });
  });

  test('[3b] typefuzz: a numeric productCode must be refused, not silently coerced', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProductArray(1, { productCode: 1001 });
    const response = await productLicensingClient.saveProducts(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'numeric productCode where a string is documented',
    });
  });

  test('[3c] typefuzz: a boolean productLogo must be refused', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProductArray(1, { productLogo: true });
    const response = await productLicensingClient.saveProducts(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean productLogo' });
  });

  test('[4] auth: an unauthenticated caller must not be able to write the global catalogue', async ({
    productLicensingClient,
  }) => {
    // This collection is platform-wide: an anonymous write here is visible to every tenant,
    // which makes it worse than an anonymous write scoped to one company.
    const body = buildProductArray(1);
    const response = await productLicensingClient.saveProducts(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a malformed bearer token must be refused on a catalogue write', async ({
    productLicensingClient,
  }) => {
    const body = buildProductArray(1);
    const response = await productLicensingClient.saveProducts(body, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] an ordinary tenant must not be able to replace a catalogue document every tenant reads', async ({
    productLicensingClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * `table_product_master` has no owning tenant, and an element carrying an `id` REPLACES
     * that document in full. So an ordinary customer token is enough to rewrite a product's
     * name, description and logo for the entire platform. A random ObjectId is used so nothing
     * real is clobbered — what is being proved is that the write is authorised at all, not
     * that a specific product can be destroyed.
     */
    const foreignDocId = randomObjectId();
    const body = buildProductArray(1, { id: foreignDocId, productName: 'QA-AUTOMATION-TAMPER' });
    const response = await productLicensingClient.saveProducts(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await productLicensingClient.saveProducts([{ id: "${foreignDocId}", productName: "QA-AUTOMATION-TAMPER" }], { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as ordinary tenant ${companyID}, a write addressed by document id into the platform-wide product catalogue was accepted with status SUCCESS. Supplying a real product's id replaces that document in full, so any customer can rename, re-describe or re-logo a product that every other tenant sees. Body: ${text.slice(0, 200)}`,
          title: 'Any tenant can overwrite global catalogue documents by id (productMaster/save)',
        },
        'Security/Access Control',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a <script> productName must not be stored and echoed unescaped', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProductArray(1, { productName: XSS_PAYLOAD });
    const response = await productLicensingClient.saveProducts(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });

  test('[6b] injection: a SQL payload in productDescription must not surface a database error', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProductArray(1, { productDescription: SQLI_DROP_PAYLOAD });
    const response = await productLicensingClient.saveProducts(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });
});

/* ==== GET /productPurchase/getPurchaseProductByCompanyId ==== */
test.describe('GET /productPurchase/getPurchaseProductByCompanyId', () => {
  const META = {
    method: 'GET',
    path: PRODUCT_PATHS.getPurchaseByCompanyId,
    repro: `await productLicensingClient.getPurchaseByCompanyId(companyID, { token });`,
  };

  test('[1] happy path: a tenant number returns a well-formed subscription-list envelope', async ({
    productLicensingClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const response = await productLicensingClient.getPurchaseByCompanyId(companyID ?? '1001', {
      token,
    });

    await expectValidContract(response, purchaseListEnvelopeSchema, META);
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    productLicensingClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const response = await productLicensingClient.getPurchaseByCompanyId(companyID ?? '1001', {
      token,
    });

    await assertStatusCodeParity(response, META);
  });

  test('[1c] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    productLicensingClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const response = await productLicensingClient.getPurchaseByCompanyId(companyID ?? '1001', {
      token,
    });

    await assertNot200OKOnError(response, META);
  });

  test('[1d] business rule: omitting the required companyId must be an error, not an empty result', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * api.json marks companyId `required: true` and then notes it is "technically optional;
     * omitting it yields an empty result rather than an error". A billing screen that drops
     * the parameter therefore renders "you have no subscriptions" instead of failing — the
     * customer is shown that they own nothing, which is the worst possible silent default on
     * an entitlement read.
     */
    const response = await productLicensingClient.getPurchaseWithoutCompanyId({ token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          repro: `await productLicensingClient.getPurchaseWithoutCompanyId({ token }); // no companyId at all`,
          scenario: `The read was issued with no companyId query parameter — a parameter the contract marks required — and answered status SUCCESS instead of refusing. A caller that loses the parameter is told the tenant has no subscriptions rather than that the request was malformed. Body: ${text.slice(0, 200)}`,
          title: 'Required companyId omitted is answered SUCCESS with an empty entitlement list',
        },
        'Input Validation Gap',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: an empty companyId must be refused, not answered with an empty entitlement list', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const params = { companyId: '' };
    const response = await productLicensingClient.getPurchaseByCompanyId(params.companyId, {
      token,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, scenario: 'empty companyId query parameter', severity: 'Major' },
      [400, 422]
    );
  });

  test('[2b] boundary: a null companyId must not be treated as "all tenants"', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const params = { companyId: null };
    const response = await productLicensingClient.getPurchaseByCompanyId(params.companyId, {
      token,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, scenario: 'null companyId query parameter', severity: 'Major' },
      [400, 422]
    );
  });

  test('[2c] boundary: a 5000-character companyId must not be processed as a lookup key', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await productLicensingClient.getPurchaseByCompanyId(MAX_LENGTH_STRING, {
      token,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, scenario: 'oversized (5000-char) companyId query parameter', severity: 'Major' },
      [400, 422]
    );
  });

  test('[3] typefuzz: a boolean companyId must be refused', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const params = { companyId: true };
    const response = await productLicensingClient.getPurchaseByCompanyId(params.companyId, {
      token,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, scenario: 'boolean companyId query parameter', severity: 'Major' },
      [400, 422]
    );
  });

  test('[3b] typefuzz: an array companyId must be refused, not flattened into one key', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const params = { companyId: ['1001', '1002'] };
    const response = await productLicensingClient.getPurchaseByCompanyId(params.companyId, {
      token,
    });

    await assertRejectsInvalidInput(
      response,
      { ...META, scenario: 'array companyId query parameter', severity: 'Major' },
      [400, 422]
    );
  });

  test('[4] auth: an unauthenticated caller must not read a tenant\'s subscriptions', async ({
    productLicensingClient,
    companyID,
  }) => {
    const response = await productLicensingClient.getPurchaseByCompanyId(companyID ?? '1001', {
      token: null,
    });

    await assertUnauthorized(response, META);
  });

  test('[4b] auth: an expired token must be refused', async ({
    productLicensingClient,
    companyID,
  }) => {
    const response = await productLicensingClient.getPurchaseByCompanyId(companyID ?? '1001', {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, META);
  });

  test('[4c] auth: a token forged with alg:none must never be accepted', async ({
    productLicensingClient,
    companyID,
  }) => {
    const response = await productLicensingClient.getPurchaseByCompanyId(companyID ?? '1001', {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, META);
  });

  test("[5] [IDOR] one tenant must not read another tenant's purchased products", async ({
    productLicensingClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * The filter injects companyID from the token, but this endpoint reads companyId from the
     * QUERY STRING. A foreign value returns the other tenant's subscription history — which
     * products they bought, on which plan, and when each lapses. That is a competitor's
     * commercial position, readable by changing one digit in a URL.
     */
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const response = await productLicensingClient.getPurchaseByCompanyId(otherTenant, { token });

    const { json, text } = await readBody(response);
    const value = json?.value;
    if (Array.isArray(value) && value.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          repro: `await productLicensingClient.getPurchaseByCompanyId("${otherTenant}", { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, the companyId query "${otherTenant}" returned ${value.length} foreign subscription(s) — product ids, plan types and end dates. The query parameter overrides the token's tenant, so any customer can enumerate what any other customer has bought. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant subscription read (IDOR) via the companyId query parameter',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload as companyId must not surface a database error', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await productLicensingClient.getPurchaseByCompanyId(SQLI_PAYLOAD, { token });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script companyId must not come back unescaped', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await productLicensingClient.getPurchaseByCompanyId(XSS_PAYLOAD, { token });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });
});

/* ==== POST /productPurchase/save ==== */
test.describe('POST /productPurchase/save', () => {
  const META = {
    method: 'POST',
    path: PRODUCT_PATHS.savePurchase,
    repro: `await productLicensingClient.savePurchase(buildProductPurchase(), { token });`,
  };

  test('[1] happy path: a valid subscription is recorded', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProductPurchase();
    const response = await productLicensingClient.savePurchase(body, { token });

    await assertStatus(response, [200], { ...META, body });
  });

  test('[1b] contract: the save response satisfies the subscription envelope', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProductPurchase();
    const response = await productLicensingClient.savePurchase(body, { token });

    await expectValidContract(response, purchaseEnvelopeSchema, { ...META, body });
  });

  test('[1c] parity: the HTTP status must agree with the envelope statusCode', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProductPurchase();
    const response = await productLicensingClient.savePurchase(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1d] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProductPurchase();
    const response = await productLicensingClient.savePurchase(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[1e] business rule: a subscription that ends before it starts must be refused', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * `endDate` is stored but never enforced, and no read path filters on it. A record whose
     * end precedes its start is therefore accepted and then reads as a live entitlement
     * forever: `productList` marks the product purchased on existence alone. That is a
     * subscription which can never expire — free product access, permanently.
     */
    const body = buildProductPurchase({
      subscriptionDate: '2027-12-31T00:00:00.000+00:00',
      endDate: '2020-01-01T00:00:00.000+00:00',
    });
    const response = await productLicensingClient.savePurchase(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await productLicensingClient.savePurchase({ subscriptionDate: "2027-12-31…", endDate: "2020-01-01…" }, { token });`,
          scenario: `A subscription whose endDate (2020-01-01) precedes its subscriptionDate (2027-12-31) was accepted with status SUCCESS. No read path filters on endDate, so this inverted record still marks the product as purchased — an entitlement that is simultaneously expired and permanent, and which no renewal process will ever pick up. Body: ${text.slice(0, 200)}`,
          title: 'Subscription accepted with endDate before subscriptionDate',
        },
        'Business Logic Flaw',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[1f] business rule: a negative licence quantity must not be recorded', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * The subscription entity models no seat count at all — nothing in ProductPurchase caps
     * how many employees may be licensed. Submitting one is a probe: if the field is accepted
     * and echoed, entitlement quantity is caller-controlled and unvalidated; if it is silently
     * dropped, seat limits are simply not a concept here, which is why the over-allocation
     * case on productEmployeeMapping/save can succeed at all.
     */
    const body = buildProductPurchase({ numberOfLicense: -1 });
    const response = await productLicensingClient.savePurchase(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      repro: `await productLicensingClient.savePurchase({ ..., numberOfLicense: -1 }, { token });`,
      scenario: 'negative licence quantity (-1) on a subscription',
      severity: 'Major',
    });
  });

  test('[1g] business rule: a zero-seat subscription must not be recorded as an entitlement', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // A zero-seat purchase still flips `isPurchased` to true on productList, because that flag
    // is computed from the mere existence of a subscription document.
    const body = buildProductPurchase({ numberOfLicense: 0 });
    const response = await productLicensingClient.savePurchase(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'zero licence quantity on a subscription that still reads as purchased',
      severity: 'Major',
    });
  });

  test('[1h] business rule: an absurd licence quantity must not be accepted unchecked', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProductPurchase({ numberOfLicense: 999999999 });
    const response = await productLicensingClient.savePurchase(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'licence quantity of 999999999 accepted without a ceiling',
      severity: 'Major',
    });
  });

  test('[2] boundary: a null productId must be refused, not stored as a dangling subscription', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProductPurchase({ productId: null });
    const response = await productLicensingClient.savePurchase(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null productId' });
  });

  test('[2b] boundary: an empty companyId must be refused, not stored as an ownerless subscription', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProductPurchase({ companyId: '' });
    const response = await productLicensingClient.savePurchase(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty companyId' });
  });

  test('[2c] boundary: a 5000-character subscriptionType must be refused rather than stored', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProductPurchase({ subscriptionType: MAX_LENGTH_STRING });
    const response = await productLicensingClient.savePurchase(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) subscriptionType',
    });
  });

  test('[3] typefuzz: an object productId must be refused, not used as a Mongo operator', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * `{ $ne: null }` is the classic operator-injection shape. Reaching the driver as a filter
     * on a replace path would let one request match — and overwrite — an unrelated document.
     */
    const body = buildProductPurchase({ productId: { $ne: null } });
    const response = await productLicensingClient.savePurchase(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object productId ({ $ne: null }) — a Mongo operator injection shape',
    });
  });

  test('[3b] typefuzz: a boolean endDate must be refused, not parsed into a date', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProductPurchase({ endDate: true });
    const response = await productLicensingClient.savePurchase(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'boolean endDate where a date-time string is documented',
    });
  });

  test('[4] auth: an unauthenticated caller must not be able to grant an entitlement', async ({
    productLicensingClient,
  }) => {
    // This is the write that decides what a company has paid for. Anonymous access to it is a
    // free-product-access primitive, not merely a contract defect.
    const body = buildProductPurchase();
    const response = await productLicensingClient.savePurchase(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a malformed bearer token must not authorise a subscription write', async ({
    productLicensingClient,
  }) => {
    const body = buildProductPurchase();
    const response = await productLicensingClient.savePurchase(body, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a subscription must not be writable into another tenant', async ({
    productLicensingClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * Writing into a foreign tenant cuts both ways commercially: it grants that tenant a
     * product they never bought (revenue loss, and a support incident they did not cause), and
     * because a replace-by-id is the documented renewal path, it is also the primitive for
     * overwriting someone else's live subscription.
     */
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildProductPurchase({ companyId: otherTenant });
    const response = await productLicensingClient.savePurchase(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await productLicensingClient.savePurchase({ companyId: "${otherTenant}", productId }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, a subscription was written into tenant "${otherTenant}" and reported SUCCESS. The body's companyId is trusted over the token's, so any caller can grant — or, via the replace-by-id renewal path, rewrite — another company's product entitlements. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant subscription write (IDOR): body companyId overrides the token tenant',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a script productType must not be stored and echoed unescaped', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProductPurchase({ productType: XSS_PAYLOAD });
    const response = await productLicensingClient.savePurchase(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });

  test('[6b] injection: a SQL payload as companyId must not surface a database error', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProductPurchase({ companyId: SQLI_DROP_PAYLOAD });
    const response = await productLicensingClient.savePurchase(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });
});

/* ==== POST /productEmployeeMapping/save ==== */
test.describe('POST /productEmployeeMapping/save', () => {
  const META = {
    method: 'POST',
    path: PRODUCT_PATHS.saveEmployeeMapping,
    repro: `await productLicensingClient.saveEmployeeMapping(buildEmployeeMappingArray(1), { token });`,
  };

  test('[1] happy path: a valid array of licence records is accepted', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeMappingArray(1);
    const response = await productLicensingClient.saveEmployeeMapping(body, { token });

    await assertStatus(response, [200], { ...META, body });
  });

  test('[1b] contract: the save response satisfies the mapping-list envelope', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeMappingArray(1);
    const response = await productLicensingClient.saveEmployeeMapping(body, { token });

    await expectValidContract(response, mappingListEnvelopeSchema, { ...META, body });
  });

  test('[1c] parity: the HTTP status must agree with the envelope statusCode', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeMappingArray(1);
    const response = await productLicensingClient.saveEmployeeMapping(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1d] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeMappingArray(1);
    const response = await productLicensingClient.saveEmployeeMapping(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[1e] business rule: employees must not be licensed to a product the company never purchased', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * This is the over-allocation case in its purest form. A random productId has no
     * corresponding row in `table_product_purchase`, so the company has bought nothing — yet
     * 25 licences are issued against it. Nothing in the write path consults the subscription,
     * and downstream KPOST services resolve entitlement through exactly these mapping rows, so
     * 25 people gain access to a product that was never sold. Seat counts cannot be exceeded
     * because they are never checked.
     */
    const unpurchasedProductId = randomObjectId();
    const body = buildEmployeeMappingArray(25, { productId: unpurchasedProductId });
    const response = await productLicensingClient.saveEmployeeMapping(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    const persisted = Array.isArray(json?.value) ? (json.value as unknown[]).length : 0;
    if (response.status() === 200 && status === 'SUCCESS' && persisted > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await productLicensingClient.saveEmployeeMapping(buildEmployeeMappingArray(25, { productId: "${unpurchasedProductId}" }), { token });`,
          scenario: `25 employee licences were issued for productId "${unpurchasedProductId}", for which the tenant holds no subscription at all, and ${persisted} mapping(s) were persisted with status SUCCESS. The write never consults table_product_purchase, so there is no seat ceiling to exceed: any number of employees can be licensed to any product, bought or not. Downstream KPOST services grant access on these rows. Body: ${text.slice(0, 200)}`,
          title: 'Employees licensed to a product with no subscription (unbounded over-allocation)',
        },
        'Business Logic Flaw',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[1f] business rule: a retried licence grant must not double-license the same employee', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * Documented defect: there is no duplicate guard, so re-sending the same employee/product
     * pair without an `id` inserts a second mapping. Issuing both concurrently is how a real
     * retry behaves — and it inflates the seat count a billing report would derive from these
     * rows.
     */
    const body = buildEmployeeMappingArray(1, {
      productId: randomObjectId(),
      employeeId: randomObjectId(),
    });
    const [first, second] = await Promise.all([
      productLicensingClient.saveEmployeeMapping(body, { token }),
      productLicensingClient.saveEmployeeMapping(body, { token }),
    ]);

    const a = (await readBody(first)).json?.value;
    const b = (await readBody(second)).json?.value;
    if (Array.isArray(a) && a.length > 0 && Array.isArray(b) && b.length > 0) {
      await reportBusinessLogicFlaw(
        second,
        {
          ...META,
          body,
          repro: `await Promise.all([saveEmployeeMapping(body), saveEmployeeMapping(body)]); // identical employee/product pair`,
          scenario: `Two concurrent identical licence grants for the same employee/product pair both persisted. With no duplicate guard, an ordinary client retry double-licenses the employee and inflates any seat count derived from table_product_employee_mapping.`,
          title: 'productEmployeeMapping/save has no duplicate guard — a retry double-licenses',
        },
        'Idempotency / Concurrency',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: an empty array must not be reported as a successful licence grant', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body: unknown[] = [];
    const response = await productLicensingClient.saveEmployeeMapping(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      repro: `await productLicensingClient.saveEmployeeMapping([], { token });`,
      scenario: 'empty licence array',
    });
  });

  test('[2b] boundary: a null employeeId must be refused, not stored as an unattributed licence', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeMappingArray(1, { employeeId: null });
    const response = await productLicensingClient.saveEmployeeMapping(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null employeeId' });
  });

  test('[2c] boundary: a 5000-character kpostId must be refused rather than stored', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeMappingArray(1, { kpostId: MAX_LENGTH_STRING });
    const response = await productLicensingClient.saveEmployeeMapping(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) kpostId',
    });
  });

  test('[3] typefuzz: an object body where the documented shape is an array must be refused', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeMapping(); // a single object where an array is required
    const response = await productLicensingClient.saveEmployeeMapping(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      repro: `await productLicensingClient.saveEmployeeMapping(buildEmployeeMapping(), { token }); // object, not array`,
      scenario: 'object body instead of a JSON array',
    });
  });

  test('[3b] typefuzz: a numeric productId where a 24-char ObjectId is documented must be refused', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeMappingArray(1, { productId: 1001 });
    const response = await productLicensingClient.saveEmployeeMapping(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric productId' });
  });

  test('[3c] typefuzz: an object companyId must be refused, not used as a Mongo operator', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeMappingArray(1, { companyId: { $ne: null } });
    const response = await productLicensingClient.saveEmployeeMapping(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object companyId ({ $ne: null }) — a Mongo operator injection shape',
    });
  });

  test('[4] auth: an unauthenticated caller must not be able to license employees', async ({
    productLicensingClient,
  }) => {
    const body = buildEmployeeMappingArray(1);
    const response = await productLicensingClient.saveEmployeeMapping(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must not authorise a licence grant', async ({
    productLicensingClient,
  }) => {
    const body = buildEmployeeMappingArray(1);
    const response = await productLicensingClient.saveEmployeeMapping(body, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test("[5] [IDOR] a licence must not be creatable inside another tenant", async ({
    productLicensingClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildEmployeeMappingArray(1, { companyId: otherTenant });
    const response = await productLicensingClient.saveEmployeeMapping(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await productLicensingClient.saveEmployeeMapping([{ companyId: "${otherTenant}", ... }], { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, a licence record was written into tenant "${otherTenant}" and reported SUCCESS. The body's companyId is trusted over the token's, so a caller can grant an arbitrary identity access to another company's product — and every downstream KPOST service resolves entitlement from these rows. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant licence write (IDOR): body companyId overrides the token tenant',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a script kpostId must not be stored and echoed unescaped', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeMappingArray(1, { kpostId: XSS_PAYLOAD });
    const response = await productLicensingClient.saveEmployeeMapping(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });

  test('[6b] injection: a SQL payload as employeeId must not leak an exception trace', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeMappingArray(1, { employeeId: SQLI_DROP_PAYLOAD });
    const response = await productLicensingClient.saveEmployeeMapping(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });
});

/* ==== POST /productEmployeeMapping/saveKpostIdForKams ==== */
test.describe('POST /productEmployeeMapping/saveKpostIdForKams', () => {
  const META = {
    method: 'POST',
    path: PRODUCT_PATHS.saveKpostIdForKams,
    repro: `await productLicensingClient.saveKpostIdForKams(buildEmployeeMapping(), { token });`,
  };

  test('[1] happy path: a service write recording a kpostId is accepted', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeMapping({ kpostId: 'KP-QA-0001' });
    const response = await productLicensingClient.saveKpostIdForKams(body, { token });

    await assertStatus(response, [200], { ...META, body });
  });

  test('[1b] contract: the response satisfies the single-mapping envelope', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeMapping({ kpostId: 'KP-QA-0002' });
    const response = await productLicensingClient.saveKpostIdForKams(body, { token });

    await expectValidContract(response, mappingEnvelopeSchema, { ...META, body });
  });

  test('[1c] parity: the HTTP status must agree with the envelope statusCode', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeMapping({ kpostId: 'KP-QA-0003' });
    const response = await productLicensingClient.saveKpostIdForKams(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1d] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeMapping({ kpostId: 'KP-QA-0004' });
    const response = await productLicensingClient.saveKpostIdForKams(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[1e] business rule: an anonymous caller must not be able to write an entitlement record', async ({
    productLicensingClient,
  }) => {
    /*
     * SecurityConfiguration lists this path explicitly among the permitted routes, so it is
     * not merely reachable by accident — it is a deliberately public write into the collection
     * that decides who may open a paid product. Anyone on the network can mint a mapping.
     */
    const body = buildEmployeeMapping({ kpostId: 'KP-INJECTED-0001' });
    const response = await productLicensingClient.saveKpostIdForKams(body, { token: null });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await productLicensingClient.saveKpostIdForKams({ ..., kpostId: "KP-INJECTED-0001" }, { token: null });`,
          scenario: `An unauthenticated caller wrote a product-employee mapping and the envelope reported SUCCESS. The route is explicitly permitted in SecurityConfiguration, so anyone who can reach the host can inject or overwrite entitlement records — the rows downstream KPOST services grant product access from. Body: ${text.slice(0, 200)}`,
          title: 'Unauthenticated entitlement write (saveKpostIdForKams)',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[1f] business rule: omitting id must not silently create a second identity record', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * Documented behaviour: supply `id` to amend in place, omit it and a NEW document is
     * created. A KAMS write-back that loses the id therefore does not correct the employee's
     * kpostId — it adds a second, contradictory mapping, and entitlement resolution then
     * depends on which one the driver returns first.
     */
    const employeeId = randomObjectId();
    const productId = randomObjectId();
    const body = buildEmployeeMapping({ employeeId, productId, kpostId: 'KP-QA-REBIND' });
    const first = await productLicensingClient.saveKpostIdForKams(body, { token });
    const second = await productLicensingClient.saveKpostIdForKams(body, { token });

    const idA = (await readBody(first)).json?.value as { id?: string } | null;
    const idB = (await readBody(second)).json?.value as { id?: string } | null;
    if (idA?.id && idB?.id && idA.id !== idB.id) {
      await reportBusinessLogicFlaw(
        second,
        {
          ...META,
          body,
          repro: `await saveKpostIdForKams(body); await saveKpostIdForKams(body); // no id — two documents`,
          scenario: `Two write-backs for the same employee/product pair created two distinct mappings ("${idA.id}" and "${idB.id}") because no id was supplied. The employee now has two kpostId records for one product and entitlement resolution picks one arbitrarily.`,
          title: 'saveKpostIdForKams creates a duplicate mapping instead of amending in place',
        },
        'Idempotency / Concurrency',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: a null kpostId must be refused, not stored as an identity-less mapping', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeMapping({ kpostId: null });
    const response = await productLicensingClient.saveKpostIdForKams(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null kpostId' });
  });

  test('[2b] boundary: an empty companyId must be refused on an entitlement write', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeMapping({ companyId: '', kpostId: 'KP-QA-0005' });
    const response = await productLicensingClient.saveKpostIdForKams(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty companyId' });
  });

  test('[2c] boundary: a 5000-character kpostId must be refused rather than stored', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeMapping({ kpostId: MAX_LENGTH_STRING });
    const response = await productLicensingClient.saveKpostIdForKams(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) kpostId',
    });
  });

  test('[3] typefuzz: a numeric kpostId must be refused, not coerced into a cross-system identity', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeMapping({ kpostId: 1001 });
    const response = await productLicensingClient.saveKpostIdForKams(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric kpostId' });
  });

  test('[3b] typefuzz: a boolean employeeId must be refused', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeMapping({ employeeId: true, kpostId: 'KP-QA-0006' });
    const response = await productLicensingClient.saveKpostIdForKams(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean employeeId' });
  });

  test('[4] auth: the KAMS write-back must be refused without a valid token', async ({
    productLicensingClient,
  }) => {
    const body = buildEmployeeMapping({ kpostId: 'KP-QA-0007' });
    const response = await productLicensingClient.saveKpostIdForKams(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a token forged with alg:none must never be accepted', async ({
    productLicensingClient,
  }) => {
    const body = buildEmployeeMapping({ kpostId: 'KP-QA-0008' });
    const response = await productLicensingClient.saveKpostIdForKams(body, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test("[5] [IDOR] an anonymous caller must not be able to write into another tenant's licences", async ({
    productLicensingClient,
    companyID,
  }) => {
    /*
     * The two defects compound here: the route is public AND it trusts the body's companyId.
     * Together they mean an attacker needs no credential at all to attach an identity they
     * control to a product inside a company they have never heard of.
     */
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildEmployeeMapping({ companyId: otherTenant, kpostId: 'KP-INJECTED-0002' });
    const response = await productLicensingClient.saveKpostIdForKams(body, { token: null });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await productLicensingClient.saveKpostIdForKams({ companyId: "${otherTenant}", kpostId: "KP-INJECTED-0002" }, { token: null });`,
          scenario: `With no token at all, a licence record was written into tenant "${otherTenant}" and reported SUCCESS. The public route combined with a body-supplied companyId lets an anonymous caller attach a kpostId of their choosing to any product in any company. Body: ${text.slice(0, 200)}`,
          title: 'Anonymous cross-tenant entitlement write (IDOR) via saveKpostIdForKams',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a script kpostId must not be stored and echoed unescaped', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeMapping({ kpostId: XSS_PAYLOAD });
    const response = await productLicensingClient.saveKpostIdForKams(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });

  test('[6b] injection: a malformed ObjectId in id must not leak the parser exception', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildEmployeeMapping({ id: SQLI_PAYLOAD, kpostId: 'KP-QA-0009' });
    const response = await productLicensingClient.saveKpostIdForKams(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });
});

/* ==== POST /productEmployeeMapping/getMappedEmployeeByCompanyIdAndProductId ==== */
test.describe('POST /productEmployeeMapping/getMappedEmployeeByCompanyIdAndProductId', () => {
  const META = {
    method: 'POST',
    path: PRODUCT_PATHS.getMappedEmployees,
    repro: `await productLicensingClient.getMappedEmployees(buildMappingQuery(), { token });`,
  };

  test('[1] happy path: a company/product pair returns a well-formed posting-list envelope', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildMappingQuery();
    /*
     * 500 is accepted here on purpose: the documented "no employee is licensed" outcome is an
     * HTTP 500 with `status: FAILURE`, not an empty 200. Demanding 200 would file a Critical
     * server-fault ticket on every clean run and bury the real findings. The misreporting
     * itself is graded honestly by [1d].
     */
    const response = await productLicensingClient.getMappedEmployees(body, { token });

    await expectValidContract(
      response,
      mappedRolePostingListEnvelopeSchema,
      { ...META, body },
      [200, 500]
    );
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildMappingQuery();
    const response = await productLicensingClient.getMappedEmployees(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildMappingQuery();
    const response = await productLicensingClient.getMappedEmployees(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[1d] business rule: "nobody is licensed" must not be reported as a server failure', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * A product nobody uses yet is an ordinary state of the world, not a fault. Reporting it as
     * 500/FAILURE means the "manage product users" screen cannot distinguish an empty licence
     * list from a broken backend, and every such view raises an alert.
     */
    const body = buildMappingQuery({ productId: randomObjectId() });
    const response = await productLicensingClient.getMappedEmployees(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (status === 'FAILURE' && json?.error == null) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await productLicensingClient.getMappedEmployees({ companyId, productId: "<unlicensed>" }, { token });`,
          scenario: `A product with no licensed employees answered status FAILURE with no error key (HTTP ${response.status()}) instead of an empty successful list. An empty result is not a fault; conflating the two makes a normal screen state indistinguishable from an outage and floods alerting. Body: ${text.slice(0, 200)}`,
          title: 'Empty licence list reported as FAILURE rather than an empty success',
        },
        'Status Code Misreporting',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: a null productId must be refused, not resolved as "any product"', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildMappingQuery({ productId: null });
    const response = await productLicensingClient.getMappedEmployees(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'null productId', severity: 'Major' },
      [400, 422]
    );
  });

  test('[2b] boundary: an empty companyId must be refused, not answered across tenants', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildMappingQuery({ companyId: '' });
    const response = await productLicensingClient.getMappedEmployees(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'empty companyId', severity: 'Major' },
      [400, 422]
    );
  });

  test('[2c] boundary: a 5000-character productId must not be processed as a lookup key', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildMappingQuery({ productId: MAX_LENGTH_STRING });
    const response = await productLicensingClient.getMappedEmployees(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'oversized (5000-char) productId', severity: 'Major' },
      [400, 422]
    );
  });

  test('[3] typefuzz: an object productId must be refused, not used as a Mongo operator', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * On a read, `{ $ne: null }` reaching the driver returns EVERY mapping rather than one
     * product's — the query stops being a filter and becomes a dump of the collection.
     */
    const body = buildMappingQuery({ productId: { $ne: null } });
    const response = await productLicensingClient.getMappedEmployees(body, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body,
        scenario: 'object productId ({ $ne: null }) — operator injection that would match every mapping',
        severity: 'Major',
      },
      [400, 422]
    );
  });

  test('[3b] typefuzz: a boolean companyId must be refused', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildMappingQuery({ companyId: true });
    const response = await productLicensingClient.getMappedEmployees(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'boolean companyId', severity: 'Major' },
      [400, 422]
    );
  });

  test('[3c] typefuzz: an array productId must be refused', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildMappingQuery({ productId: ['a', 'b'] });
    const response = await productLicensingClient.getMappedEmployees(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'array productId', severity: 'Major' },
      [400, 422]
    );
  });

  test('[4] auth: an unauthenticated caller must not see who is licensed to a product', async ({
    productLicensingClient,
  }) => {
    // The response is a list of role postings — display names, hierarchy paths and locations
    // for named staff. Anonymous access to it is a staff-directory leak, not just a contract
    // defect.
    const body = buildMappingQuery();
    const response = await productLicensingClient.getMappedEmployees(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must be refused', async ({ productLicensingClient }) => {
    const body = buildMappingQuery();
    const response = await productLicensingClient.getMappedEmployees(body, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4c] auth: a malformed bearer token must be refused', async ({ productLicensingClient }) => {
    const body = buildMappingQuery();
    const response = await productLicensingClient.getMappedEmployees(body, {
      token: MALFORMED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test("[5] [IDOR] one tenant must not read another tenant's licensed staff", async ({
    productLicensingClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * This is the highest-value cross-tenant read in the subsystem. The response is not a
     * count — it is resolved RolePostingEntity documents: who works at the competitor, what
     * their posting is called, where they sit in the hierarchy and at which location. A single
     * substituted companyId turns an entitlement screen into an org chart of another company.
     */
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildMappingQuery({ companyId: otherTenant });
    const response = await productLicensingClient.getMappedEmployees(body, { token });

    const { json, text } = await readBody(response);
    const value = json?.value;
    if (Array.isArray(value) && value.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await productLicensingClient.getMappedEmployees({ companyId: "${otherTenant}", productId }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, the body companyId "${otherTenant}" returned ${value.length} foreign role posting(s). The endpoint trusts the body over the token, so any customer can read which named staff at another company are licensed to a product — postings, hierarchy paths and locations included. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant licensed-staff disclosure (IDOR) via the body companyId',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload as productId must not surface a database error', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildMappingQuery({ productId: SQLI_PAYLOAD });
    const response = await productLicensingClient.getMappedEmployees(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script companyId must not come back unescaped in the envelope', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildMappingQuery({ companyId: XSS_PAYLOAD });
    const response = await productLicensingClient.getMappedEmployees(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /productEmployeeMapping/getKpostIDsByCompanyIdAndProductId ==== */
test.describe('POST /productEmployeeMapping/getKpostIDsByCompanyIdAndProductId', () => {
  const META = {
    method: 'POST',
    path: PRODUCT_PATHS.getKpostIDs,
    repro: `await productLicensingClient.getKpostIDs(buildMappingQuery(), { token });`,
  };

  test('[1] happy path: a company/product pair returns a well-formed kpostIDs envelope', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildMappingQuery();
    // 500 is accepted for the documented "nothing licensed" case; [1e] grades that separately.
    const response = await productLicensingClient.getKpostIDs(body, { token });

    await expectValidContract(response, kpostIdsEnvelopeSchema, { ...META, body }, [200, 500]);
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildMappingQuery();
    const response = await productLicensingClient.getKpostIDs(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildMappingQuery();
    const response = await productLicensingClient.getKpostIDs(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[1d] contract: the payload must arrive under `value`, not a route-specific key', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * This is the one route in the module that abandons the shared envelope: the identifiers
     * come back under a top-level `kpostIDs` key and `value` is absent entirely. Every generic
     * client, SDK and response interceptor written against the documented envelope reads
     * `value` and finds nothing, so the call looks like an empty success.
     */
    const body = buildMappingQuery();
    const response = await productLicensingClient.getKpostIDs(body, { token });

    const { json, text } = await readBody(response);
    if (json !== null && json.kpostIDs !== undefined && json.value === undefined) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          scenario: `The response carried its payload under a non-standard top-level "kpostIDs" key with no "value" present. Every other route in the module answers under "value", so a generic client reading the documented envelope sees an empty result rather than the identifiers. Body: ${text.slice(0, 200)}`,
          title: 'getKpostIDs returns its payload under `kpostIDs` instead of the envelope `value`',
        },
        'Schema Violation',
        'Low'
      );
    }
    expect(true).toBe(true);
  });

  test('[1e] business rule: "nothing licensed" must not be reported as a server failure', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildMappingQuery({ productId: randomObjectId() });
    const response = await productLicensingClient.getKpostIDs(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (status === 'FAILURE' && json?.error == null) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await productLicensingClient.getKpostIDs({ companyId, productId: "<unlicensed>" }, { token });`,
          scenario: `A product with no licensed identities answered status FAILURE with no error key (HTTP ${response.status()}) instead of an empty successful list. The KPOST service consuming this integration cannot tell "nobody is licensed" from "the lookup broke", so it must either retry a healthy call or treat an outage as an empty entitlement set. Body: ${text.slice(0, 200)}`,
          title: 'Empty kpostIDs result reported as FAILURE rather than an empty success',
        },
        'Status Code Misreporting',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: a null companyId must be refused, not resolved across tenants', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildMappingQuery({ companyId: null });
    const response = await productLicensingClient.getKpostIDs(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'null companyId', severity: 'Major' },
      [400, 422]
    );
  });

  test('[2b] boundary: an empty productId must be refused', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildMappingQuery({ productId: '' });
    const response = await productLicensingClient.getKpostIDs(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'empty productId', severity: 'Major' },
      [400, 422]
    );
  });

  test('[2c] boundary: a 5000-character companyId must not be processed as a lookup key', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildMappingQuery({ companyId: MAX_LENGTH_STRING });
    const response = await productLicensingClient.getKpostIDs(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'oversized (5000-char) companyId', severity: 'Major' },
      [400, 422]
    );
  });

  test('[3] typefuzz: a boolean companyId must be refused', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildMappingQuery({ companyId: true });
    const response = await productLicensingClient.getKpostIDs(body, { token });

    await assertRejectsInvalidInput(
      response,
      { ...META, body, scenario: 'boolean companyId', severity: 'Major' },
      [400, 422]
    );
  });

  test('[3b] typefuzz: an object productId must be refused, not used as a Mongo operator', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildMappingQuery({ productId: { $ne: null } });
    const response = await productLicensingClient.getKpostIDs(body, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        body,
        scenario: 'object productId ({ $ne: null }) — operator injection that would dump every kpostId',
        severity: 'Major',
      },
      [400, 422]
    );
  });

  test('[4] auth: an unauthenticated caller must not resolve a product\'s KPOST identities', async ({
    productLicensingClient,
  }) => {
    const body = buildMappingQuery();
    const response = await productLicensingClient.getKpostIDs(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a token forged with alg:none must never be accepted', async ({
    productLicensingClient,
  }) => {
    const body = buildMappingQuery();
    const response = await productLicensingClient.getKpostIDs(body, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test("[5] [IDOR] one tenant must not enumerate another tenant's KPOST identities", async ({
    productLicensingClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * kpostIDs are identifiers, not statistics: each one names a specific person's cross-system
     * account, and they are what downstream KPOST services resolve entitlement against. Reading
     * a competitor's set therefore discloses both their staff and the handles an attacker would
     * need to impersonate them in another service. Critical.
     */
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const body = buildMappingQuery({ companyId: otherTenant });
    const response = await productLicensingClient.getKpostIDs(body, { token });

    const { json, text } = await readBody(response);
    const ids = json?.kpostIDs ?? json?.value;
    if (Array.isArray(ids) && ids.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await productLicensingClient.getKpostIDs({ companyId: "${otherTenant}", productId }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, the body companyId "${otherTenant}" returned ${ids.length} foreign KPOST identity string(s). These are per-person cross-system identifiers that downstream services resolve entitlement against, so the read discloses both who works at the other company and the handles needed to act as them elsewhere. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant KPOST identity enumeration (IDOR) via the body companyId',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload as companyId must not surface a database error', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildMappingQuery({ companyId: SQLI_PAYLOAD });
    const response = await productLicensingClient.getKpostIDs(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script productId must not come back unescaped in the envelope', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildMappingQuery({ productId: XSS_PAYLOAD });
    const response = await productLicensingClient.getKpostIDs(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== GET /demo/fetchDemoRequest ==== */
test.describe('GET /demo/fetchDemoRequest', () => {
  const META = {
    method: 'GET',
    path: PRODUCT_PATHS.fetchDemoRequest,
    repro: `await productLicensingClient.fetchDemoRequest({ token });`,
  };

  test('[1] happy path: the sales queue returns a well-formed demo-list envelope', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await productLicensingClient.fetchDemoRequest({ token });

    await expectValidContract(response, demoListEnvelopeSchema, META);
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await productLicensingClient.fetchDemoRequest({ token });

    await assertStatusCodeParity(response, META);
  });

  test('[1c] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await productLicensingClient.fetchDemoRequest({ token });

    await assertNot200OKOnError(response, META);
  });

  test('[2] boundary: an empty status filter must not be honoured as an undocumented query', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * The route is an unfiltered find({}) with no declared parameters. Sending one probes
     * whether an undeclared filter is quietly honoured — a hidden query surface is both an
     * undocumented contract and a place for operator injection to land.
     */
    const params = { status: '' };
    const response = await productLicensingClient.fetchDemoRequest({ token, params });

    await assertStatusCodeParity(response, {
      ...META,
      repro: `await productLicensingClient.fetchDemoRequest({ token, params: { status: "" } });`,
    });
  });

  test('[2b] boundary: a 5000-character undeclared query parameter must not destabilise the read', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await productLicensingClient.fetchDemoRequest({
      token,
      params: { status: MAX_LENGTH_STRING },
    });

    await assertNot200OKOnError(response, {
      ...META,
      repro: `await productLicensingClient.fetchDemoRequest({ token, params: { status: "a".repeat(5000) } });`,
    });
  });

  test('[3] typefuzz: a numeric undeclared paging parameter must not silently truncate the queue', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // If `limit` were honoured, the sales dashboard would silently drop leads beyond it — and
    // the absence of paging on an unbounded find({}) would have a hidden workaround nobody
    // documented.
    const params = { limit: 1001 };
    const response = await productLicensingClient.fetchDemoRequest({ token, params });

    await assertStatusCodeParity(response, {
      ...META,
      repro: `await productLicensingClient.fetchDemoRequest({ token, params: { limit: 1001 } });`,
    });
  });

  test('[3b] typefuzz: a boolean undeclared parameter must not change the result set', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const params = { paged: true };
    const response = await productLicensingClient.fetchDemoRequest({ token, params });

    await assertNot200OKOnError(response, {
      ...META,
      repro: `await productLicensingClient.fetchDemoRequest({ token, params: { paged: true } });`,
    });
  });

  test('[4] auth: the whole lead database must not be served to an unauthenticated caller', async ({
    productLicensingClient,
  }) => {
    const response = await productLicensingClient.fetchDemoRequest({ token: null });
    const { text, json } = await readBody(response);

    // An unfiltered find({}) over every lead. If it answers anonymously with contact fields,
    // that is bulk PII exposure with no credential at all — Critical, not a contract defect.
    const served = response.status() >= 200 && response.status() < 300;
    const leakedPii =
      served &&
      (/"contactEmailId"\s*:\s*"[^"]+"/i.test(text) ||
        /"contactMobileNumber"\s*:\s*"[^"]+"/i.test(text));
    if (leakedPii) {
      const count = Array.isArray(json?.value) ? (json.value as unknown[]).length : undefined;
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          repro: `await productLicensingClient.fetchDemoRequest({ token: null });`,
          scenario: `An unauthenticated fetchDemoRequest returned prospect PII${count !== undefined ? ` for ${count} lead(s)` : ''} — names, e-mail addresses and mobile numbers. The route is an unfiltered find({}) over the entire lead table and api.json itself notes it should be restricted to internal callers. This is an unauthenticated bulk-PII exposure and, incidentally, a complete sales pipeline handed to a competitor.`,
          title: 'Unauthenticated bulk PII exposure via fetchDemoRequest',
        },
        'Security/Information Disclosure',
        'Critical'
      );
    } else {
      // Even with no PII in the body, a route the spec declares secured serving anonymous
      // callers is a contract defect in its own right.
      await assertUnauthorized(response, META);
    }
    expect(true).toBe(true);
  });

  test('[4b] auth: an expired token must be refused on the sales queue', async ({
    productLicensingClient,
  }) => {
    const response = await productLicensingClient.fetchDemoRequest({ token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[4c] auth: a malformed bearer token must be refused', async ({ productLicensingClient }) => {
    const response = await productLicensingClient.fetchDemoRequest({ token: MALFORMED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[5] [IDOR] an ordinary tenant must not read the platform-wide sales pipeline', async ({
    productLicensingClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * Leads are prospects, so they carry no companyId and there is no per-tenant copy to
     * cross-read in the usual sense. The ownership boundary crossed here is a different one:
     * the queue belongs to the KPOST sales organisation, not to any customer, yet an ordinary
     * tenant token reads all of it. That hands one customer every other prospect's name,
     * e-mail and mobile — and the identity of everyone currently evaluating the platform.
     */
    const response = await productLicensingClient.fetchDemoRequest({ token });

    const { json, text } = await readBody(response);
    const value = json?.value;
    if (Array.isArray(value) && value.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          repro: `await productLicensingClient.fetchDemoRequest({ token /* ordinary tenant ${companyID} */ });`,
          scenario: `An ordinary tenant token (company ${companyID}) read ${value.length} demo request(s) from the internal sales queue. These records belong to the KPOST sales organisation, not to the calling customer, and carry prospect names, e-mail addresses and mobile numbers. Any customer can therefore enumerate the full pre-sales pipeline. Body: ${text.slice(0, 200)}`,
          title: 'Any tenant can read the internal sales pipeline (cross-boundary PII read)',
        },
        'Security/Information Disclosure',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a script lead name must not be served unescaped to the sales dashboard', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    // The public form feeds this internal dashboard. A script in nameOfUser that is stored and
    // echoed back here executes in a salesperson's authenticated browser session — the classic
    // stored-XSS path from an anonymous input to a privileged reader.
    await productLicensingClient.createDemoRequest(buildDemoRequest({ nameOfUser: XSS_PAYLOAD }), {
      token: null,
    });

    const token = requireAuthToken();
    const response = await productLicensingClient.fetchDemoRequest({ token });

    await assertNoReflectedScript(
      response,
      {
        ...META,
        repro: `await createDemoRequest(buildDemoRequest({ nameOfUser: "${XSS_PAYLOAD}" }), { token: null }); await fetchDemoRequest({ token });`,
      },
      XSS_PAYLOAD
    );
  });

  test('[6b] injection: a SQL payload in an undeclared query parameter must not leak a driver error', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await productLicensingClient.fetchDemoRequest({
      token,
      params: { status: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });
});

/* ==== POST /demo/createDemoRequest ==== */
test.describe('POST /demo/createDemoRequest', () => {
  const META = {
    method: 'POST',
    path: PRODUCT_PATHS.createDemoRequest,
    repro: `await productLicensingClient.createDemoRequest(buildDemoRequest(), { token });`,
  };

  test('[1] happy path: a well-formed lead is recorded (safe contact destinations only)', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * SAFETY: every contact field on this route comes from `safeTestData.ts` via the builder —
     * TEST_MOBILE and TEST_EMAIL. This record lands in a queue a human sales team works, so a
     * faker-generated number would page a real stranger and a faker e-mail would mail one.
     */
    const body = buildDemoRequest();
    const response = await productLicensingClient.createDemoRequest(body, { token });

    await assertStatus(response, [200], { ...META, body });
  });

  test('[1b] contract: the create response satisfies the demo-request envelope', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDemoRequest();
    const response = await productLicensingClient.createDemoRequest(body, { token });

    await expectValidContract(response, demoEnvelopeSchema, { ...META, body });
  });

  test('[1c] parity: the HTTP status must agree with the envelope statusCode', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDemoRequest();
    const response = await productLicensingClient.createDemoRequest(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1d] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDemoRequest();
    const response = await productLicensingClient.createDemoRequest(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[1e] business rule: a caller must not be able to set the sales workflow status', async ({
    productLicensingClient,
  }) => {
    /*
     * `status` (`demo_status`) is documented as server-assigned and defaulted to "pending" —
     * it is the field the sales queue filters on. If an anonymous submitter can post
     * `status: "completed"`, they can file a lead that never appears in the queue: a way to
     * suppress a competitor's demo request, or to bury one's own spam below the fold.
     */
    const body = buildDemoRequest({ status: 'completed' });
    const response = await productLicensingClient.createDemoRequest(body, { token: null });

    const { json, text } = await readBody(response);
    const value = json?.value as { status?: string } | null;
    if (response.status() === 200 && value?.status === 'completed') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await productLicensingClient.createDemoRequest({ ..., status: "completed" }, { token: null });`,
          scenario: `An anonymous submission set the server-assigned workflow status to "completed" and the stored record came back carrying it. demo_status is what the sales dashboard filters on, so a lead can be created pre-closed and never surface in the queue. Body: ${text.slice(0, 200)}`,
          title: 'Server-assigned demo status is settable by the anonymous submitter',
        },
        'Business Logic Flaw',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[1f] business rule: a lead with no reachable contact channel must be refused', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * api.json: "Supply at least nameOfUser plus one contact channel — nothing is enforced at
     * the schema level, so an unreachable lead will be accepted." A record nobody can be
     * contacted through occupies a sales queue permanently and can never be closed, which also
     * makes the endpoint a cheap queue-flooding primitive on a route that needs no credential.
     */
    const body = buildDemoRequest({ contactEmailId: null, contactMobileNumber: null });
    const response = await productLicensingClient.createDemoRequest(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      repro: `await productLicensingClient.createDemoRequest({ nameOfUser, contactEmailId: null, contactMobileNumber: null }, { token });`,
      scenario: 'lead accepted with neither an e-mail address nor a mobile number',
      severity: 'Major',
    });
  });

  test('[2] boundary: a null nameOfUser must be refused, not filed as an anonymous lead', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDemoRequest({ nameOfUser: null });
    const response = await productLicensingClient.createDemoRequest(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null nameOfUser' });
  });

  test('[2b] boundary: an empty contactEmailId must be refused rather than stored blank', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // The mobile stays on the provably-undeliverable number so this case cannot reach a handset
    // even if the backend ignores its own validation.
    const body = buildDemoRequest({ contactEmailId: '', contactMobileNumber: unroutableMobile() });
    const response = await productLicensingClient.createDemoRequest(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty contactEmailId' });
  });

  test('[2c] boundary: a 5000-character nameOfUser must be refused rather than stored', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDemoRequest({ nameOfUser: MAX_LENGTH_STRING });
    const response = await productLicensingClient.createDemoRequest(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) nameOfUser',
    });
  });

  test('[3] typefuzz: an object projectList where an array is documented must be refused', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDemoRequest({ projectList: { $ne: null } });
    const response = await productLicensingClient.createDemoRequest(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object projectList ({ $ne: null }) where a string array is documented',
    });
  });

  test('[3b] typefuzz: a numeric preferredDateAndTime must be refused, not parsed as a slot', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDemoRequest({ preferredDateAndTime: 1001 });
    const response = await productLicensingClient.createDemoRequest(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'numeric preferredDateAndTime where an ISO-8601 local date-time is documented',
    });
  });

  test('[3c] typefuzz: a boolean contactMobileNumber must be refused', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // A boolean is used deliberately rather than a wrong-but-plausible number: no value sent
    // here may ever resemble a dialable subscriber line.
    const body = buildDemoRequest({ contactMobileNumber: true });
    const response = await productLicensingClient.createDemoRequest(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'boolean contactMobileNumber',
    });
  });

  test('[4] auth: the demo form must match its declared security, one way or the other', async ({
    productLicensingClient,
  }) => {
    /*
     * api.json exempts eight registration routes with `security: []` but NOT this one, so the
     * published contract says a bearer token is required here. In practice the "Request a demo"
     * form is public and must work before any account exists. One of the two is wrong: either
     * the operation needs `security: []` in the spec, or an anonymous submitter is writing to a
     * collection they were never meant to reach. Recording it is what forces that decision.
     */
    const body = buildDemoRequest();
    const response = await productLicensingClient.createDemoRequest(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must not be treated as a valid submitter identity', async ({
    productLicensingClient,
  }) => {
    const body = buildDemoRequest();
    const response = await productLicensingClient.createDemoRequest(body, {
      token: EXPIRED_TOKEN,
    });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a submitter must not be able to bind a lead to an id of their choosing', async ({
    productLicensingClient,
  }) => {
    /*
     * `id` is documented readOnly and assigned on insert. A lead carries no companyId, so the
     * ownership boundary here is the document identifier itself: if a caller-supplied `id` is
     * honoured, an anonymous submitter can address — and therefore overwrite — an existing
     * lead belonging to someone else, replacing a real prospect's contact details with theirs.
     */
    const targetId = randomObjectId();
    const body = buildDemoRequest({ id: targetId, nameOfUser: 'QA-AUTOMATION-IDBIND' });
    const response = await productLicensingClient.createDemoRequest(body, { token: null });

    const { json, text } = await readBody(response);
    const value = json?.value as { id?: string } | null;
    if (response.status() === 200 && value?.id === targetId) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await productLicensingClient.createDemoRequest({ id: "${targetId}", ... }, { token: null });`,
          scenario: `An anonymous submission supplied the readOnly document id "${targetId}" and the stored record came back under it. The insert honours a caller-chosen _id, so an unauthenticated caller can address an existing lead and replace another prospect's name and contact details wholesale. Body: ${text.slice(0, 200)}`,
          title: 'Anonymous submitter controls the demo-request document id (overwrite by id)',
        },
        'Security/Access Control',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a script nameOfUser must not be echoed unescaped on create', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDemoRequest({ nameOfUser: XSS_PAYLOAD });
    const response = await productLicensingClient.createDemoRequest(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });

  test('[6b] injection: a SQL payload in nameOfUser must not surface a database error', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildDemoRequest({ nameOfUser: SQLI_DROP_PAYLOAD });
    const response = await productLicensingClient.createDemoRequest(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });
});

/* ==== GET /project/fetchAllProject ==== */
test.describe('GET /project/fetchAllProject', () => {
  const META = {
    method: 'GET',
    path: PRODUCT_PATHS.fetchAllProject,
    repro: `await productLicensingClient.fetchAllProject({ token });`,
  };

  test('[1] happy path: the catalogue returns a well-formed project-list envelope', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await productLicensingClient.fetchAllProject({ token });

    await expectValidContract(response, projectListEnvelopeSchema, META);
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await productLicensingClient.fetchAllProject({ token });

    await assertStatusCodeParity(response, META);
  });

  test('[1c] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await productLicensingClient.fetchAllProject({ token });

    await assertNot200OKOnError(response, META);
  });

  test('[2] boundary: an empty undeclared filter parameter must not be honoured', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // The route declares no parameters at all. Anything honoured here is a hidden query
    // surface — undocumented behaviour, and somewhere for operator injection to land.
    const params = { abbreviation: '' };
    const response = await productLicensingClient.fetchAllProject({ token, params });

    await assertStatusCodeParity(response, {
      ...META,
      repro: `await productLicensingClient.fetchAllProject({ token, params: { abbreviation: "" } });`,
    });
  });

  test('[2b] boundary: a 5000-character undeclared parameter must not destabilise the read', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await productLicensingClient.fetchAllProject({
      token,
      params: { abbreviation: MAX_LENGTH_STRING },
    });

    await assertNot200OKOnError(response, {
      ...META,
      repro: `await productLicensingClient.fetchAllProject({ token, params: { abbreviation: "a".repeat(5000) } });`,
    });
  });

  test('[3] typefuzz: a numeric undeclared paging parameter must not truncate the catalogue', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const params = { page: 1001 };
    const response = await productLicensingClient.fetchAllProject({ token, params });

    await assertStatusCodeParity(response, {
      ...META,
      repro: `await productLicensingClient.fetchAllProject({ token, params: { page: 1001 } });`,
    });
  });

  test('[3b] typefuzz: a boolean undeclared parameter must not change the result set', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const params = { all: true };
    const response = await productLicensingClient.fetchAllProject({ token, params });

    await assertNot200OKOnError(response, {
      ...META,
      repro: `await productLicensingClient.fetchAllProject({ token, params: { all: true } });`,
    });
  });

  test('[4] auth: an unauthenticated caller must be refused', async ({ productLicensingClient }) => {
    // This one is a genuinely global reference list that the public demo form needs, so an
    // anonymous 200 is a spec/implementation mismatch (Major) rather than a data breach —
    // exactly the distinction assertUnauthorized grades on the response content.
    const response = await productLicensingClient.fetchAllProject({ token: null });

    await assertUnauthorized(response, META);
  });

  test('[4b] auth: an expired token must be refused', async ({ productLicensingClient }) => {
    const response = await productLicensingClient.fetchAllProject({ token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[4c] auth: a malformed bearer token must be refused', async ({ productLicensingClient }) => {
    const response = await productLicensingClient.fetchAllProject({ token: MALFORMED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[5] [IDOR] the catalogue must be genuinely global, not silently tenant-scoped', async ({
    productLicensingClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * api.json calls this platform-level reference data shared by all tenants, so there should
     * be no per-tenant copy to cross-read. This case proves the claim rather than assuming it:
     * if injecting a foreign companyId changes the result, the catalogue has a hidden tenant
     * dimension — and a route documented as global is in fact serving one tenant's view to
     * another, which is an ownership boundary nobody knew existed.
     */
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const ownView = await productLicensingClient.fetchAllProject({ token });
    const foreignView = await productLicensingClient.fetchAllProject({
      token,
      params: { companyId: otherTenant },
    });

    const own = (await readBody(ownView)).json?.value;
    const foreign = (await readBody(foreignView)).json?.value;
    if (Array.isArray(own) && Array.isArray(foreign) && own.length !== foreign.length) {
      await reportBusinessLogicFlaw(
        foreignView,
        {
          ...META,
          repro: `await fetchAllProject({ token }); await fetchAllProject({ token, params: { companyId: "${otherTenant}" } });`,
          scenario: `The project catalogue returned ${own.length} entries for the caller's own tenant and ${foreign.length} for companyId "${otherTenant}". A route documented as global platform reference data is in fact scoped by an undeclared companyId parameter, so one tenant is being served another tenant's view of the catalogue.`,
          title: 'Project catalogue is silently tenant-scoped by an undeclared companyId parameter',
        },
        'Security/Access Control',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload in an undeclared parameter must not leak a driver error', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await productLicensingClient.fetchAllProject({
      token,
      params: { abbreviation: SQLI_PAYLOAD },
    });

    await assertNoInternalLeak(response, META, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script parameter must not come back unescaped in the envelope', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await productLicensingClient.fetchAllProject({
      token,
      params: { abbreviation: XSS_PAYLOAD },
    });

    await assertNoReflectedScript(response, META, XSS_PAYLOAD);
  });
});

/* ==== POST /project/saveAllProject ==== */
test.describe('POST /project/saveAllProject', () => {
  const META = {
    method: 'POST',
    path: PRODUCT_PATHS.saveAllProject,
    repro: `await productLicensingClient.saveAllProject(buildProjectArray(2), { token });`,
  };

  test('[1] happy path: a valid array of projects is accepted', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProjectArray(2);
    const response = await productLicensingClient.saveAllProject(body, { token });

    await assertStatus(response, [200], { ...META, body });
  });

  test('[1b] contract: the save response satisfies the project-list envelope', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProjectArray(1);
    const response = await productLicensingClient.saveAllProject(body, { token });

    await expectValidContract(response, projectListEnvelopeSchema, { ...META, body });
  });

  test('[1c] parity: the HTTP status must agree with the envelope statusCode', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProjectArray(1);
    const response = await productLicensingClient.saveAllProject(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1d] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProjectArray(1);
    const response = await productLicensingClient.saveAllProject(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[1e] business rule: a duplicate abbreviation must not be accepted', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    /*
     * `abbreviation` is the cross-module reference — it is the literal value stored in a demo
     * request's `projectList`. Two catalogue entries sharing one abbreviation make every lead
     * that mentions it ambiguous, and the `projectDetailsMap` expansion on the sales dashboard
     * then displays whichever document the driver happened to return.
     */
    const sharedAbbreviation = 'QADUP';
    const body = buildProjectArray(2, { abbreviation: sharedAbbreviation });
    const response = await productLicensingClient.saveAllProject(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await productLicensingClient.saveAllProject(buildProjectArray(2, { abbreviation: "${sharedAbbreviation}" }), { token });`,
          scenario: `Two catalogue projects sharing abbreviation "${sharedAbbreviation}" were both accepted. The abbreviation is the cross-module reference stored in every demo request's projectList, so a lead naming it now resolves to two documents and the dashboard expands whichever comes back first. Body: ${text.slice(0, 200)}`,
          title: 'Duplicate project abbreviation accepted into the global catalogue',
        },
        'Business Logic Flaw',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: an empty array must not be reported as a successful catalogue load', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body: unknown[] = [];
    const response = await productLicensingClient.saveAllProject(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      repro: `await productLicensingClient.saveAllProject([], { token });`,
      scenario: 'empty project array',
    });
  });

  test('[2b] boundary: a null title must be refused, not stored as a nameless project', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProjectArray(1, { title: null });
    const response = await productLicensingClient.saveAllProject(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null title' });
  });

  test('[2c] boundary: a 5000-character content must be refused rather than stored', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProjectArray(1, { content: MAX_LENGTH_STRING });
    const response = await productLicensingClient.saveAllProject(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) project content',
    });
  });

  test('[3] typefuzz: an object body where the documented shape is an array must be refused', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProjectDetails(); // a single object where an array is required
    const response = await productLicensingClient.saveAllProject(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      repro: `await productLicensingClient.saveAllProject(buildProjectDetails(), { token }); // object, not array`,
      scenario: 'object body instead of a JSON array',
    });
  });

  test('[3b] typefuzz: a numeric abbreviation must be refused, not silently coerced', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProjectArray(1, { abbreviation: 1001 });
    const response = await productLicensingClient.saveAllProject(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric abbreviation' });
  });

  test('[3c] typefuzz: a boolean title must be refused', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProjectArray(1, { title: true });
    const response = await productLicensingClient.saveAllProject(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean title' });
  });

  test('[4] auth: an unauthenticated caller must not be able to write the project catalogue', async ({
    productLicensingClient,
  }) => {
    const body = buildProjectArray(1);
    const response = await productLicensingClient.saveAllProject(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: a malformed bearer token must be refused on a catalogue write', async ({
    productLicensingClient,
  }) => {
    const body = buildProjectArray(1);
    const response = await productLicensingClient.saveAllProject(body, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] an ordinary tenant must not be able to replace a shared catalogue document', async ({
    productLicensingClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * `table_admin_project_details` has no owning tenant and an element carrying an `id`
     * replaces that document wholesale. So an ordinary customer token is enough to rewrite the
     * title, abbreviation or copy of a project every other tenant — and the public demo form —
     * reads. A random ObjectId is used so no live catalogue entry is touched; what is being
     * proved is that the addressed write is authorised at all.
     */
    const foreignDocId = randomObjectId();
    const body = buildProjectArray(1, { id: foreignDocId, title: 'QA-AUTOMATION-TAMPER' });
    const response = await productLicensingClient.saveAllProject(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await productLicensingClient.saveAllProject([{ id: "${foreignDocId}", title: "QA-AUTOMATION-TAMPER" }], { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as ordinary tenant ${companyID}, a write addressed by document id into the platform-wide project catalogue was accepted with status SUCCESS. Supplying a live project's id replaces it in full, so any customer can rewrite the abbreviation that every demo request references and the copy shown on the public form. Body: ${text.slice(0, 200)}`,
          title: 'Any tenant can overwrite global project-catalogue documents by id',
        },
        'Security/Access Control',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a <script> project title must not be stored and echoed unescaped', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    // The project catalogue is rendered on the PUBLIC demo form's multi-select, so a script
    // stored here executes for unauthenticated visitors, not just internal users.
    const body = buildProjectArray(1, { title: XSS_PAYLOAD });
    const response = await productLicensingClient.saveAllProject(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });

  test('[6b] injection: a SQL payload in content must not surface a database error', async ({
    productLicensingClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildProjectArray(1, { content: SQLI_DROP_PAYLOAD });
    const response = await productLicensingClient.saveAllProject(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_DROP_PAYLOAD);
  });
});
