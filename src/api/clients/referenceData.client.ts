import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

/**
 * Thin client for the reference-data & onboarding tail (country/address reference, admin
 * details, employee↔role-posting mapping) plus the application's liveness page. Pass-through
 * only — every assertion lives in tests/referenceData/.
 */

/**
 * The routes this project drives, in one place.
 *
 * Specs build their `META.path` from these rather than retyping the string, so a path and the
 * bug ticket that reports a defect on it can never drift apart. The two address lookups keep
 * their **templated** form (`{pincode}`) exactly as api.json declares it: `audit-vectors.ts`
 * groups coverage by the `METHOD /path` signature in the describe title, and `MODULE_BY_PATH`
 * routes ownership by the same templated key, which makes these strings load-bearing rather
 * than decorative.
 *
 * Three Swagger tags share this map — Country & Address Reference Data, Admin Details and
 * Employee ↔ Role Posting Mapping — plus the untagged root page. Bundling groups test
 * execution only; ownership is still resolved per path.
 */
export const REFERENCE_PATHS = {
  countryList: '/country/countryList',
  countrySave: '/country/save',
  getAddressUsingPincode: '/country/getAddressUsingPincode/{pincode}',
  getAddressUsingPincodeAndCountry: '/country/getAddressUsingPincodeAndCountry/{pincode}/{country}',
  adminDetailsSave: '/adminDetails/save',
  employeeRoleMappingSave: '/employeeRoleMapping/save',
  index: '/',
} as const;

export class ReferenceDataClient extends BaseClient {
  // --- Country & Address Reference Data (/country/*) ---
  /**
   * Seed the country catalogue. Body is an ARRAY of Country.
   *
   * Writes to the GLOBAL `table_admin_country` collection — the documents it creates are read
   * by every tenant, and `dialCode` feeds OTP delivery.
   */
  saveCountries(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(REFERENCE_PATHS.countrySave, body, o);
  }

  /** Registration-time dropdown source — unfiltered find({}). */
  countryList(o: RequestOptions = {}): Promise<APIResponse> {
    return this.get(REFERENCE_PATHS.countryList, o);
  }

  /**
   * Pincode -> localities. Issues an OUTBOUND HTTP call to the external KPOST address service
   * with the segment taken straight from the path, so the path parameter is the whole attack
   * surface. `pincode` is sent verbatim — callers encode it themselves when fuzzing.
   */
  getAddressUsingPincode(pincode: string, o: RequestOptions = {}): Promise<APIResponse> {
    return this.get(`/country/getAddressUsingPincode/${pincode}`, o);
  }

  /** Single-result variant. Indexes element 0 unconditionally, so an unmatched pincode 500s. */
  getAddressUsingPincodeAndCountry(
    pincode: string,
    country: string,
    o: RequestOptions = {}
  ): Promise<APIResponse> {
    return this.get(`/country/getAddressUsingPincodeAndCountry/${pincode}/${country}`, o);
  }

  // --- Admin Details (/adminDetails/*) ---
  /** Full-document save: a supplied `id` replaces that document wholesale, omitted fields null. */
  saveAdminDetails(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(REFERENCE_PATHS.adminDetailsSave, body, o);
  }

  // --- Employee ↔ Role Posting Mapping (/employeeRoleMapping/*) ---
  /** Append-only insert; neither referenced id is validated to exist and nothing is unique. */
  saveEmployeeRoleMapping(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(REFERENCE_PATHS.employeeRoleMappingSave, body, o);
  }

  // --- admin-module-application (the liveness page) ---
  /** Returns an HTML banner page, NOT the JSON envelope. */
  indexPage(o: RequestOptions = {}): Promise<APIResponse> {
    return this.get(REFERENCE_PATHS.index, o);
  }
}
