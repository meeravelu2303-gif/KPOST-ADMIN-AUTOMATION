import { test as base, APIRequestContext, request as playwrightRequest } from '@playwright/test';
import { env } from '../config/env.config';
import { UsersClient } from '../api/clients/users.client';
import { DepartmentsClient } from '../api/clients/departments.client';
import { DesignationsClient } from '../api/clients/designations.client';
import { RolePostingsClient } from '../api/clients/rolePostings.client';
import { WorkplaceLocationsClient } from '../api/clients/workplaceLocations.client';
import { EmployeeMasterClient } from '../api/clients/employeeMaster.client';
import { HolidayCalendarClient } from '../api/clients/holidayCalendar.client';
import { ProductLicensingClient } from '../api/clients/productLicensing.client';
import { WorkplaceHierarchyClient } from '../api/clients/workplaceHierarchy.client';
import { HrHierarchyClient } from '../api/clients/hrHierarchy.client';
import { ReferenceDataClient } from '../api/clients/referenceData.client';
import {
  AuthSession,
  establishSession,
  requireToken,
  warnIfUnauthenticated,
} from './authSession';

export interface WorkerFixtures {
  /**
   * Authentication is resolved once per worker rather than per test: even a minted-token
   * probe is a round trip, and re-doing it for every test would dominate the run.
   */
  authSession: AuthSession;
}

export interface ApiFixtures {
  apiContext: APIRequestContext;
  usersClient: UsersClient;
  departmentsClient: DepartmentsClient;
  designationsClient: DesignationsClient;
  rolePostingsClient: RolePostingsClient;
  workplaceLocationsClient: WorkplaceLocationsClient;
  employeeMasterClient: EmployeeMasterClient;
  holidayCalendarClient: HolidayCalendarClient;
  productLicensingClient: ProductLicensingClient;
  workplaceHierarchyClient: WorkplaceHierarchyClient;
  hrHierarchyClient: HrHierarchyClient;
  referenceDataClient: ReferenceDataClient;
  /** Token from the worker session, or null when authentication was not possible. */
  authToken: string | null;
  /** The tenant the session token is scoped to — for tenant-isolation assertions. */
  companyID: string | null;
  /** Returns the session token, or throws a diagnostic-rich AuthenticationUnavailableError. */
  requireAuthToken: () => string;
}

export const test = base.extend<ApiFixtures, WorkerFixtures>({
  authSession: [
    async ({}, use) => {
      const context = await playwrightRequest.newContext({
        baseURL: env.baseURL,
        timeout: env.apiTimeout,
        ignoreHTTPSErrors: true,
      });

      let session: AuthSession;
      try {
        session = await establishSession(context);
      } catch (error) {
        // A transport failure while authenticating must not abort the whole worker; the
        // suite still has substantial unauthenticated coverage to contribute.
        session = {
          token: null,
          kpostID: null,
          companyID: null,
          strategy: 'unauthenticated',
          diagnostics: [`Authentication threw: ${(error as Error).message}`],
        };
      }

      warnIfUnauthenticated(session);
      await use(session);
      await context.dispose();
    },
    { scope: 'worker' },
  ],

  apiContext: async ({}, use) => {
    const context = await playwrightRequest.newContext({
      baseURL: env.baseURL,
      timeout: env.apiTimeout,
      ignoreHTTPSErrors: true,
    });
    await use(context);
    await context.dispose();
  },

  usersClient: async ({ apiContext }, use) => {
    await use(new UsersClient(apiContext));
  },

  departmentsClient: async ({ apiContext }, use) => {
    await use(new DepartmentsClient(apiContext));
  },

  designationsClient: async ({ apiContext }, use) => {
    await use(new DesignationsClient(apiContext));
  },

  rolePostingsClient: async ({ apiContext }, use) => {
    await use(new RolePostingsClient(apiContext));
  },

  workplaceLocationsClient: async ({ apiContext }, use) => {
    await use(new WorkplaceLocationsClient(apiContext));
  },

  employeeMasterClient: async ({ apiContext }, use) => {
    await use(new EmployeeMasterClient(apiContext));
  },

  holidayCalendarClient: async ({ apiContext }, use) => {
    await use(new HolidayCalendarClient(apiContext));
  },

  productLicensingClient: async ({ apiContext }, use) => {
    await use(new ProductLicensingClient(apiContext));
  },

  workplaceHierarchyClient: async ({ apiContext }, use) => {
    await use(new WorkplaceHierarchyClient(apiContext));
  },

  hrHierarchyClient: async ({ apiContext }, use) => {
    await use(new HrHierarchyClient(apiContext));
  },

  referenceDataClient: async ({ apiContext }, use) => {
    await use(new ReferenceDataClient(apiContext));
  },

  authToken: async ({ authSession }, use) => {
    await use(authSession.token);
  },

  companyID: async ({ authSession }, use) => {
    await use(authSession.companyID);
  },

  requireAuthToken: async ({ authSession }, use) => {
    await use(() => requireToken(authSession));
  },
});

export const expect = test.expect;

/** Deliberately malformed / forged tokens used by the auth-enforcement assertions. */
export const EXPIRED_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJxYS1leHBpcmVkIiwiY29tcGFueUlEIjoiMTAwMSIsImV4cCI6MTAwMDAwMDAwMH0.invalid-signature-for-testing';
export const MALFORMED_TOKEN = 'not-a-jwt-at-all';
/** `{"alg":"none"}` token claiming admin identity — must never be honoured. */
export const FORGED_ALG_NONE_JWT =
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJhZG1pbiIsImNvbXBhbnlJRCI6Ijk5OTkifQ.';

export type { AuthSession } from './authSession';
export { AuthenticationUnavailableError } from './authSession';
