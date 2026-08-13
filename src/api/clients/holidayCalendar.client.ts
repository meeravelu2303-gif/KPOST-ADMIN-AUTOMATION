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
export const HOLIDAY_PATHS = {
  getHoliday: '/holiday/getHoliday',
  saveHoliday: '/holiday/saveHoliday',
} as const;

/** Thin client for the "Holiday Calendar" tag (/holiday/*). Pass-through only. */
export class HolidayCalendarClient extends BaseClient {
  /** Insert a holiday. A same-date duplicate is rejected as HTTP 500 "Holiday already exists". */
  saveHoliday(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post('/holiday/saveHoliday', body, options);
  }

  /**
   * GET the signed-in company's calendar. Company scope comes from the TOKEN's companyID
   * attribute — there is no path/query/body param, so you cannot request another tenant's
   * calendar. An empty calendar answers with envelope statusCode 204.
   */
  getHoliday(options: RequestOptions = {}): Promise<APIResponse> {
    return this.get('/holiday/getHoliday', options);
  }
}
