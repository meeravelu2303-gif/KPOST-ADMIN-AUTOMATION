import { faker } from '@faker-js/faker';
import { env } from '../../config/env.config';
import { safeTestMobile, qaLabel } from '../../utils/safeTestData';
import { randomObjectId } from './departments.payload';

/** Faker-backed builders for the reference-data & onboarding tail. Overrides are Record<string, unknown>. */

/**
 * Re-exported so the reference-data spec mints unmatched/foreign ids from its own payload
 * module rather than reaching into another tag's.
 */
export { randomObjectId } from './departments.payload';

export function buildCountry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    countryName: qaLabel('COUNTRY'),
    dialCode: String(faker.number.int({ min: 1, max: 998 })),
    countryCode: faker.string.alpha({ length: 2, casing: 'upper' }),
    ...overrides,
  };
}
export function buildCountryArray(
  count = 1,
  overrides: Record<string, unknown> = {}
): Array<Record<string, unknown>> {
  return Array.from({ length: count }, () => buildCountry(overrides));
}

/** Admin Details — mobile pinned to the safe destination in case onboarding notifies it. */
export function buildAdminDetails(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    companyId: env.qaCompanyId,
    firstName: faker.person.firstName(),
    lastName: faker.person.lastName(),
    dob: '1988-04-17',
    gender: 'Female',
    mobile: safeTestMobile(),
    ...overrides,
  };
}

export function buildEmployeeRoleMapping(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    companyId: env.qaCompanyId,
    employeeId: randomObjectId(),
    rolePostingId: randomObjectId(),
    ...overrides,
  };
}
