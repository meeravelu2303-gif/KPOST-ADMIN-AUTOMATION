import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

/**
 * The routes this subsystem owns, in one place.
 *
 * Specs build their `META.path` from these rather than retyping the string, so a path and the
 * bug ticket that reports a defect on it can never drift apart. `audit-vectors.ts` groups
 * coverage by the `METHOD /path` signature in the describe title, which makes that string
 * load-bearing rather than decorative — the templated segment is spelled exactly as api.json
 * spells it (`{companyId}`), not as a concrete value.
 *
 * Five Swagger tags are bundled here because they share one owning subsystem. Bug ownership
 * is still resolved per path by `MODULE_BY_PATH`, so each tag routes to its own team.
 */
export const PRODUCT_PATHS = {
  // Product Catalogue
  productList: '/productMaster/productList/{companyId}',
  saveProducts: '/productMaster/save',
  // Product Subscriptions
  getPurchaseByCompanyId: '/productPurchase/getPurchaseProductByCompanyId',
  savePurchase: '/productPurchase/save',
  // Product ↔ Employee Licensing
  saveEmployeeMapping: '/productEmployeeMapping/save',
  saveKpostIdForKams: '/productEmployeeMapping/saveKpostIdForKams',
  getMappedEmployees: '/productEmployeeMapping/getMappedEmployeeByCompanyIdAndProductId',
  getKpostIDs: '/productEmployeeMapping/getKpostIDsByCompanyIdAndProductId',
  // Product Demo Requests
  fetchDemoRequest: '/demo/fetchDemoRequest',
  createDemoRequest: '/demo/createDemoRequest',
  // Project Catalogue
  fetchAllProject: '/project/fetchAllProject',
  saveAllProject: '/project/saveAllProject',
} as const;

/**
 * Thin client for the Product & Licensing subsystem (product catalogue, subscriptions,
 * employee licensing, demo requests, project catalogue). Pass-through only.
 *
 * The two `companyId`-carrying reads take `unknown` rather than `string`: a fuzz case has to
 * be able to put a boolean, an array or an object where a tenant number is documented, and a
 * narrow parameter type would forbid exactly the requests worth sending. The value is
 * stringified at the transport boundary, so the wire carries whatever the test supplied.
 */
export class ProductLicensingClient extends BaseClient {
  // --- Product Catalogue (/productMaster/*) ---
  /** Bulk seed. Body is an ARRAY of ProductMaster. */
  saveProducts(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(PRODUCT_PATHS.saveProducts, body, options);
  }
  /** `companyId` is a PATH segment — the business tenant number, not an ObjectId. */
  getProductListByCompany(companyId: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.get(`/productMaster/productList/${String(companyId)}`, options);
  }

  // --- Product Subscriptions (/productPurchase/*) ---
  /** Grant a company access to a product. Body is a single ProductPurchase. */
  savePurchase(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(PRODUCT_PATHS.savePurchase, body, options);
  }
  /** `companyId` is a QUERY parameter. Omitting it yields an empty result rather than an error. */
  getPurchaseByCompanyId(companyId: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.get(PRODUCT_PATHS.getPurchaseByCompanyId, {
      ...options,
      params: {
        companyId: companyId as string | number | boolean,
        ...(options.params ?? {}),
      },
    });
  }
  /** The same read with no `companyId` at all — the missing-parameter case. */
  getPurchaseWithoutCompanyId(options: RequestOptions = {}): Promise<APIResponse> {
    return this.get(PRODUCT_PATHS.getPurchaseByCompanyId, options);
  }

  // --- Product ↔ Employee Licensing (/productEmployeeMapping/*) ---
  /** Assign employees to a product. Body is an ARRAY of ProductEmployeeMapping. */
  saveEmployeeMapping(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(PRODUCT_PATHS.saveEmployeeMapping, body, options);
  }
  /** Service-to-service write. Explicitly permitAll in SecurityConfiguration — a public write. */
  saveKpostIdForKams(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(PRODUCT_PATHS.saveKpostIdForKams, body, options);
  }
  /** Reads only `companyId` + `productId`. `value` is an array of RolePostingEntity. */
  getMappedEmployees(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(PRODUCT_PATHS.getMappedEmployees, body, options);
  }
  /** Identity-only variant. Answers under a non-standard `kpostIDs` key, not `value`. */
  getKpostIDs(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(PRODUCT_PATHS.getKpostIDs, body, options);
  }

  // --- Product Demo Requests (/demo/*) ---
  /** PUBLIC "request a demo" form. Records prospect PII and can notify a real sales inbox. */
  createDemoRequest(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(PRODUCT_PATHS.createDemoRequest, body, options);
  }
  /** Unfiltered find({}) over every lead — prospect names, e-mails, mobiles. Internal-only. */
  fetchDemoRequest(options: RequestOptions = {}): Promise<APIResponse> {
    return this.get(PRODUCT_PATHS.fetchDemoRequest, options);
  }

  // --- Project Catalogue (/project/*) ---
  /** Bulk seed. Body is an ARRAY of ProjectDetails. */
  saveAllProject(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(PRODUCT_PATHS.saveAllProject, body, options);
  }
  fetchAllProject(options: RequestOptions = {}): Promise<APIResponse> {
    return this.get(PRODUCT_PATHS.fetchAllProject, options);
  }
}
