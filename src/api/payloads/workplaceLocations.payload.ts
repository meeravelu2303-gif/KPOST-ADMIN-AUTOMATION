import { faker } from '@faker-js/faker';
import { env } from '../../config/env.config';
import { qaLabel } from '../../utils/safeTestData';
import { randomObjectId } from './departments.payload';

/** Faker-backed builders for the Workplace Locations tag. Overrides are Record<string, unknown>. */

export function buildLocation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    companyId: env.qaCompanyId,
    attributeId: randomObjectId(),
    variableId: randomObjectId(),
    locationName: qaLabel('LOC'),
    workPlaceLocation: qaLabel('LOC'),
    pincode: faker.string.numeric(6),
    state: 'Tamil Nadu',
    city: 'Chennai',
    addressLine1: faker.location.streetAddress(),
    countryId: 1,
    ...overrides,
  };
}

/** save takes an ARRAY of locations. */
export function buildLocationArray(
  count = 1,
  overrides: Record<string, unknown> = {}
): Array<Record<string, unknown>> {
  return Array.from({ length: count }, () => buildLocation(overrides));
}

export function buildLocationUpdate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: randomObjectId(), ...buildLocation(), ...overrides };
}

export function buildGetAll(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    companyId: env.qaCompanyId,
    variableId: randomObjectId(),
    reportingWorkplaceLocationId: randomObjectId(),
    ...overrides,
  };
}

/** `location/getLocation` reads only the hierarchy node — `attributeId` + `variableId`. */
export function buildLocationNode(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    attributeId: randomObjectId(),
    variableId: randomObjectId(),
    ...overrides,
  };
}

export function buildById(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: randomObjectId(), ...overrides };
}

/**
 * Re-exported so the location specs can mint a throwaway ObjectId without reaching into the
 * departments payload module. Every destructive case in this tag is pointed at one of these.
 */
export { randomObjectId };
