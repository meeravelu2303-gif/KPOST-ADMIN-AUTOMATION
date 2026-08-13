import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

/**
 * Thin client for the "Employee Master Data" tag (/employeeDetails/*). Pass-through only.
 * Note `save`/`update` take a SINGLE composite object (not an array, unlike department/save).
 */
/**
 * The routes this tag owns, in one place.
 *
 * Specs build their `META.path` from these rather than retyping the string, so a path and the
 * bug ticket that reports a defect on it can never drift apart. `audit-vectors.ts` groups
 * coverage by the `METHOD /path` signature in the describe title, which makes that string
 * load-bearing rather than decorative.
 */
export const EMPLOYEE_MASTER_PATHS = {
  save: '/employeeDetails/save',
  update: '/employeeDetails/update',
  getEmployeeDetails: '/employeeDetails/getEmployeeDetails',
  getTransferOrPromotionDetails: '/employeeDetails/getTransferOrPromotionDetails',
  delete: '/employeeDetails/delete',
} as const;

export class EmployeeMasterClient extends BaseClient {
  save(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(EMPLOYEE_MASTER_PATHS.save, body, options);
  }

  update(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(EMPLOYEE_MASTER_PATHS.update, body, options);
  }

  /** Reads `companyId`; returns the tenant's employee records (PII-bearing). */
  getEmployeeDetails(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(EMPLOYEE_MASTER_PATHS.getEmployeeDetails, body, options);
  }

  getTransferOrPromotionDetails(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(EMPLOYEE_MASTER_PATHS.getTransferOrPromotionDetails, body, options);
  }

  /** Destructive hard delete by `id`. Exercise on refusal / auth paths only. */
  delete(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(EMPLOYEE_MASTER_PATHS.delete, body, options);
  }
}
