import { faker } from '@faker-js/faker';
import { env } from '../../config/env.config';
import { safeTestEmail, safeTestMobile, qaLabel } from '../../utils/safeTestData';
import { randomObjectId } from './departments.payload';

/** Faker-backed builders for the Product & Licensing subsystem. Overrides are Record<string, unknown>. */

/** Re-exported so a spec in this suite has one payload import, not two. */
export { randomObjectId };

export function buildProductMaster(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    productName: qaLabel('PROD'),
    productCode: faker.string.alpha({ length: 4, casing: 'upper' }),
    productDescription: faker.commerce.productDescription(),
    productLogo: 'https://cdn.example.com/logo.png',
    ...overrides,
  };
}
export function buildProductArray(count = 1, overrides: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  return Array.from({ length: count }, () => buildProductMaster(overrides));
}

export function buildProductPurchase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    productId: randomObjectId(),
    companyId: env.qaCompanyId,
    productType: 'SAAS',
    subscriptionType: 'ANNUAL',
    endDate: '2027-12-31T00:00:00.000+00:00',
    ...overrides,
  };
}

export function buildEmployeeMapping(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    companyId: env.qaCompanyId,
    productId: randomObjectId(),
    employeeId: randomObjectId(),
    rolePostingId: randomObjectId(),
    ...overrides,
  };
}
export function buildEmployeeMappingArray(count = 1, overrides: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  return Array.from({ length: count }, () => buildEmployeeMapping(overrides));
}

/** Lookups keyed on company + product. */
export function buildMappingQuery(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { companyId: env.qaCompanyId, productId: randomObjectId(), ...overrides };
}

/**
 * A public demo request. Contact fields are pinned to the safe destinations — a prospect's
 * real mobile/email must never be invented by faker in a suite that fires this repeatedly.
 */
export function buildDemoRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nameOfUser: qaLabel('LEAD'),
    contactEmailId: safeTestEmail(),
    contactMobileNumber: safeTestMobile(),
    preferredDateAndTime: '2027-09-02T15:30:00Z',
    projectList: ['KAMS'],
    ...overrides,
  };
}

export function buildProjectDetails(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: qaLabel('PROJECT'),
    abbreviation: faker.string.alpha({ length: 4, casing: 'upper' }),
    content: faker.lorem.sentence(),
    ...overrides,
  };
}
export function buildProjectArray(count = 1, overrides: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  return Array.from({ length: count }, () => buildProjectDetails(overrides));
}
