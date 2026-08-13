import { faker } from '@faker-js/faker';
import { env } from '../../config/env.config';
import { safeTestEmail, safeTestMobile } from '../../utils/safeTestData';
import { randomObjectId } from './departments.payload';

/** Re-exported so the spec can mint throwaway ids without importing another tag's payloads. */
export { randomObjectId };

/**
 * Faker-backed builders for the Employee Master Data tag. Overrides are
 * Record<string, unknown>. The employee record carries PII; the mobile/email are pinned to
 * the safe destinations in case any downstream flow notifies them.
 */

export function buildPersonalInformation(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    firstName: faker.person.firstName(),
    lastName: faker.person.lastName(),
    dob: '1994-06-12',
    gender: 'Male',
    maritalStatus: 'Single',
    mobile: safeTestMobile(),
    email: safeTestEmail(),
    ...overrides,
  };
}

/** save/update take a SINGLE composite object (not an array). */
export function buildEmployee(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    companyId: env.qaCompanyId,
    personalInformationObj: buildPersonalInformation(),
    ...overrides,
  };
}

export function buildEmployeeUpdate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: randomObjectId(), ...buildEmployee(), ...overrides };
}

export function buildGetByCompany(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { companyId: env.qaCompanyId, ...overrides };
}

/**
 * getTransferOrPromotionDetails body. NOTE the swagger declares the request body type as
 * `string` yet its example is a JSON object ({companyId, requestType}) — a documented
 * contract anti-pattern the tests exercise directly.
 */
export function buildTransferOrPromotionRequest(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { companyId: env.qaCompanyId, requestType: 'promote', ...overrides };
}

export function buildDeleteById(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: randomObjectId(), ...overrides };
}
