import { faker } from '@faker-js/faker';
import { env } from '../../config/env.config';
import { qaLabel } from '../../utils/safeTestData';

/**
 * Faker-backed request builders for the Departments tag.
 *
 * Every builder takes `Record<string, unknown>` overrides — NOT `Partial<Department>` — so a
 * fuzz test can deliberately submit wrong-typed values (a number where a string belongs, an
 * array where an object belongs) that a strict override type would forbid.
 */

/** A syntactically valid 24-char hex ObjectId that (almost certainly) matches no document. */
export function randomObjectId(): string {
  return faker.string.hexadecimal({ length: 24, casing: 'lower', prefix: '' });
}

/** A single Department document. Defaults to a labelled, tenant-scoped, fully-formed record. */
export function buildDepartment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const abbreviation = faker.string.alpha({ length: 3, casing: 'upper' });
  return {
    companyId: env.qaCompanyId,
    departmentName: qaLabel('DEPT'),
    abbreviation,
    code: `D${faker.number.int({ min: 10, max: 99 })}`,
    ...overrides,
  };
}

/** The bulk-save body is an ARRAY of departments. */
export function buildDepartmentArray(
  count = 1,
  overrides: Record<string, unknown> = {}
): Array<Record<string, unknown>> {
  return Array.from({ length: count }, () => buildDepartment(overrides));
}

/** An update targets an existing document, so it carries an `id`. */
export function buildDepartmentUpdate(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { id: randomObjectId(), ...buildDepartment(), ...overrides };
}

/** getDepartmentByCompanyId reads only `companyId`. */
export function buildGetByCompany(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { companyId: env.qaCompanyId, ...overrides };
}

/** abbreviationAndCodeCreation reads only `departmentName`. */
export function buildAbbreviationRequest(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { departmentName: qaLabel('DEPT'), ...overrides };
}

/** delete reads only `id`. */
export function buildDeleteById(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: randomObjectId(), ...overrides };
}
