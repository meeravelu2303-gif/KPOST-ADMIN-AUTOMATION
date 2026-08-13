import { faker } from '@faker-js/faker';
import { env } from '../../config/env.config';
import { qaLabel } from '../../utils/safeTestData';
import { randomObjectId } from './departments.payload';

export { randomObjectId };

/** Faker-backed builders for the Designations tag. Overrides are Record<string, unknown>. */

export function buildDesignation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    companyId: env.qaCompanyId,
    departmentId: randomObjectId(),
    designationName: qaLabel('DESIG'),
    abbreviation: faker.string.alpha({ length: 2, casing: 'upper' }),
    code: `ENG-${faker.number.int({ min: 10, max: 99 })}`,
    ...overrides,
  };
}

/** save takes an ARRAY of designations. */
export function buildDesignationArray(
  count = 1,
  overrides: Record<string, unknown> = {}
): Array<Record<string, unknown>> {
  return Array.from({ length: count }, () => buildDesignation(overrides));
}

export function buildDesignationUpdate(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { id: randomObjectId(), ...buildDesignation(), ...overrides };
}

/** getDesignationByCompanyIdAndDepartmentId reads companyId + departmentIdList (an array). */
export function buildGetByCompanyAndDept(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { companyId: env.qaCompanyId, departmentIdList: [randomObjectId()], ...overrides };
}

export function buildAbbreviationRequest(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { designationName: qaLabel('DESIG'), departmentId: randomObjectId(), ...overrides };
}

export function buildDeleteById(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: randomObjectId(), ...overrides };
}
