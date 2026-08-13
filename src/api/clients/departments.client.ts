import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

/**
 * Thin client for the "Departments" tag (/department/*), backed by the
 * `table_admin_department` MongoDB collection and scoped by `companyId`.
 *
 * Pass-through only. The transport sends `data` verbatim so a fuzz test can drive the same
 * path as a happy-path test; every assertion lives in tests/departments/.
 */
/**
 * The routes this tag owns, in one place.
 *
 * Specs build their `META.path` from these rather than retyping the string, so a path and the
 * bug ticket that reports a defect on it can never drift apart. `audit-vectors.ts` groups
 * coverage by the `METHOD /path` signature in the describe title, which makes that string
 * load-bearing rather than decorative.
 */
export const DEPARTMENT_PATHS = {
  save: '/department/save',
  update: '/department/update',
  getDepartmentByCompanyId: '/department/getDepartmentByCompanyId',
  abbreviationAndCodeCreation: '/department/abbreviationAndCodeCreation',
  delete: '/department/delete',
} as const;

export class DepartmentsClient extends BaseClient {
  /** Bulk create/replace. Body is an ARRAY of Department documents. */
  save(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post('/department/save', body, options);
  }

  /** Update a single department by `id`. Documented to always return SUCCESS — inspect `value`. */
  update(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post('/department/update', body, options);
  }

  /** List departments for a company. Reads only `companyId` from the body. */
  getByCompanyId(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post('/department/getDepartmentByCompanyId', body, options);
  }

  /** Read-only: derives a non-reserved abbreviation/code from `departmentName`. */
  abbreviationAndCodeCreation(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post('/department/abbreviationAndCodeCreation', body, options);
  }

  /** Destructive hard delete by `id`, non-cascading. Exercise on refusal / auth paths only. */
  delete(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post('/department/delete', body, options);
  }
}
