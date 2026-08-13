import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

/**
 * The routes this tag owns, in one place.
 *
 * Specs build their `META.path` from these rather than retyping the string, so a path and the
 * bug ticket that reports a defect on it can never drift apart. `audit-vectors.ts` groups
 * coverage by the `METHOD /path` signature in the describe title, which makes that string
 * load-bearing rather than decorative.
 *
 * Note the lower-case `v` in `getEmployeeDetailsByLastHrvariableId` — that is the spelling the
 * backend actually publishes, and correcting it would 404 (or, on this module, 500).
 */
export const ROLE_POSTING_PATHS = {
  save: '/rolePosting/save',
  update: '/rolePosting/update',
  delete: '/rolePosting/delete',
  softDelete: '/rolePosting/softDelete',
  getRolePostingById: '/rolePosting/getRolePostingById',
  getRolePostingByCompanyId: '/rolePosting/getRolePostingByCompanyId',
  getRolePostingByCompanyIdAndEmployeeId: '/rolePosting/getRolePostingByCompanyIdAndEmployeeId',
  getAssignedRolePostingEmployeeByCompanyId:
    '/rolePosting/getAssignedRolePostingEmployeeByCompanyId',
  getEmployeeByCompanyId: '/rolePosting/getEmployeeByCompanyId',
  getEmployeeDetailsByLastHrvariableId: '/rolePosting/getEmployeeDetailsByLastHrvariableId',
  getSuspendOrTerminateEmployee: '/rolePosting/getSuspendOrTerminateEmployee',
  suspendOrTerminateEmployee: '/rolePosting/suspendOrTerminateEmployee',
} as const;

/**
 * Thin client for the "Role Postings" tag (/rolePosting/*), backed by
 * `table_admin_role_posting`. A posting is what places an employee at a workplace/HR tier node
 * and carries the suspend / terminate / transfer / promotion lifecycle.
 *
 * Pass-through only. The transport sends `data` verbatim so a fuzz test can drive the same
 * path as a happy-path test; every assertion lives in tests/rolePostings/.
 */
export class RolePostingsClient extends BaseClient {
  /** Bulk create. Body is an ARRAY of RolePostingRequest documents. */
  save(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(ROLE_POSTING_PATHS.save, body, options);
  }

  /** Update a single posting by `id`. Inspect `value` — `status` is SUCCESS either way. */
  update(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(ROLE_POSTING_PATHS.update, body, options);
  }

  getByCompanyId(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(ROLE_POSTING_PATHS.getRolePostingByCompanyId, body, options);
  }

  getById(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(ROLE_POSTING_PATHS.getRolePostingById, body, options);
  }

  getByCompanyAndEmployee(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(ROLE_POSTING_PATHS.getRolePostingByCompanyIdAndEmployeeId, body, options);
  }

  /**
   * Lifecycle action — suspends or terminates an employee's posting. DESTRUCTIVE: it mutates
   * a real person's employment state. Point it at random, non-existent ids only.
   */
  suspendOrTerminateEmployee(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(ROLE_POSTING_PATHS.suspendOrTerminateEmployee, body, options);
  }

  getSuspendOrTerminateEmployee(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(ROLE_POSTING_PATHS.getSuspendOrTerminateEmployee, body, options);
  }

  getEmployeeByCompanyId(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(ROLE_POSTING_PATHS.getEmployeeByCompanyId, body, options);
  }

  getAssignedRolePostingEmployeeByCompanyId(
    body: unknown,
    options: RequestOptions = {}
  ): Promise<APIResponse> {
    return this.post(ROLE_POSTING_PATHS.getAssignedRolePostingEmployeeByCompanyId, body, options);
  }

  getEmployeeDetailsByLastHrVariableId(
    body: unknown,
    options: RequestOptions = {}
  ): Promise<APIResponse> {
    return this.post(ROLE_POSTING_PATHS.getEmployeeDetailsByLastHrvariableId, body, options);
  }

  /** Reversible delete (sets a flag). Still a mutation — exercise with random ids only. */
  softDelete(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(ROLE_POSTING_PATHS.softDelete, body, options);
  }

  /** Destructive hard delete by `id`, non-cascading. Random / refusal-path ids only. */
  delete(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post(ROLE_POSTING_PATHS.delete, body, options);
  }
}
