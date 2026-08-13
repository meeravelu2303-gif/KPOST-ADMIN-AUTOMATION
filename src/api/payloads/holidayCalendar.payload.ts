import { faker } from '@faker-js/faker';
import { env } from '../../config/env.config';
import { qaLabel } from '../../utils/safeTestData';

/**
 * Faker-backed builders for the Holiday Calendar tag. Overrides are Record<string, unknown>.
 * NOTE the tenant field is `companyID` (capital ID), unlike the rest of the module.
 */
export function buildHoliday(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    companyID: env.qaCompanyId,
    holidayType: 'Public',
    countryId: '1',
    stateName: 'Tamil Nadu',
    // Valid, varied date well in the future so it does not collide with real data.
    date: `2027-${String(faker.number.int({ min: 1, max: 12 })).padStart(2, '0')}-15`,
    holidayDescription: qaLabel('HOLIDAY'),
    repeatType: 0,
    ...overrides,
  };
}
