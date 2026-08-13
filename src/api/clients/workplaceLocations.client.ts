import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

/**
 * The routes this tag owns, in one place.
 *
 * Specs build their `META.path` from these rather than retyping the string, so a path and the
 * bug ticket that reports a defect on it can never drift apart. `audit-vectors.ts` groups
 * coverage by the `METHOD /path` signature in the describe title, which makes that string
 * load-bearing rather than decorative.
 */
export const LOCATION_PATHS = {
  save: '/location/save',
  update: '/location/update',
  delete: '/location/delete',
  getLocation: '/location/getLocation',
  getAllLocation: '/location/getAllLocation',
  getLocationById: '/location/getLocationById',
  getReportingLocationName: '/location/getReportingLocationName',
} as const;

/** Thin client for the "Workplace Locations" tag (/location/*). Pass-through only. */
export class WorkplaceLocationsClient extends BaseClient {
  /** Bulk create/replace. Body is an ARRAY of Location documents. */
  save(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post('/location/save', body, options);
  }

  update(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post('/location/update', body, options);
  }

  /** Reads `variableId` + `reportingWorkplaceLocationId` + `companyId`. */
  getAll(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post('/location/getAllLocation', body, options);
  }

  getById(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post('/location/getLocationById', body, options);
  }

  getLocation(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post('/location/getLocation', body, options);
  }

  getReportingLocationName(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post('/location/getReportingLocationName', body, options);
  }

  /** Destructive hard delete by `id`. Exercise on refusal / auth paths only. */
  delete(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post('/location/delete', body, options);
  }
}
