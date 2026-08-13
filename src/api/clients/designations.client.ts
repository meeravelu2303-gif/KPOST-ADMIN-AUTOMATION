import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

/** Thin client for the "Designations" tag (/designation/*). Pass-through only. */
/**
 * The routes this tag owns, in one place.
 *
 * Specs build their `META.path` from these rather than retyping the string, so a path and the
 * bug ticket that reports a defect on it can never drift apart. `audit-vectors.ts` groups
 * coverage by the `METHOD /path` signature in the describe title, which makes that string
 * load-bearing rather than decorative.
 */
export const DESIGNATION_PATHS = {
  save: '/designation/save',
  update: '/designation/update',
  getDesignationByCompanyIdAndDepartmentId: '/designation/getDesignationByCompanyIdAndDepartmentId',
  abbreviationAndCodeCreation: '/designation/abbreviationAndCodeCreation',
  delete: '/designation/delete',
} as const;

export class DesignationsClient extends BaseClient {
  /** Bulk create/replace. Body is an ARRAY of Designation documents. */
  save(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(DESIGNATION_PATHS.save, body, options);
  }

  update(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(DESIGNATION_PATHS.update, body, options);
  }

  /** Reads `companyId` + `departmentIdList` (an array of department ObjectIds). */
  getByCompanyAndDepartment(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(DESIGNATION_PATHS.getDesignationByCompanyIdAndDepartmentId, body, options);
  }

  /** Read-only, non-reserving abbreviation/code generator. */
  abbreviationAndCodeCreation(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(DESIGNATION_PATHS.abbreviationAndCodeCreation, body, options);
  }

  /** Destructive hard delete by `id`. Orphans nothing that references it. */
  delete(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(DESIGNATION_PATHS.delete, body, options);
  }
}
