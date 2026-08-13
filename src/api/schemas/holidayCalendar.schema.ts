import { z } from 'zod';
import { dataEnvelopeSchema } from './envelope.schema';
import { objectIdSchema } from './departments.schema';

/**
 * A holiday from `table_holiday`. NOTE the tenant field is `companyID` (capital ID) here,
 * unlike the `companyId` used across the rest of the module — a real casing inconsistency.
 */
/*
 * Fields are `.nullish()`, not `.optional()`, and the difference is load-bearing here.
 *
 * `.optional()` admits `undefined` but rejects an explicit `null`, and this endpoint returns
 * explicit nulls by design: api.json documents "Leave null for a company-wide holiday" on
 * `countryId` and "Leave null for a country-wide or company-wide holiday" on `stateName`. With
 * `.optional()` the contract test failed on a scope-wide holiday — a documented, correct
 * response — and would have filed a schema-violation ticket against working behaviour. A ledger
 * that cries wolf costs more than one that misses a bug, because it trains readers to skim.
 *
 * Genuine contract deviations are still caught: unknown-but-wrong TYPES (a number where a
 * string belongs) fail exactly as before.
 */
export const holidaySchema = z
  .object({
    id: objectIdSchema.nullish(),
    holidayType: z.string().nullish(),
    countryId: z.string().nullish(),
    companyID: z.string().nullish(),
    stateName: z.string().nullish(),
    date: z.string().nullish(),
    holidayDescription: z.string().nullish(),
    repeatType: z.number().nullish(),
  })
  .passthrough();

export type Holiday = z.infer<typeof holidaySchema>;

export const holidayListEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z.array(holidaySchema).nullable().optional(),
});

/** `holiday/saveHoliday` answers with the single stored HolidayEntity, not a list. */
export const holidayEnvelopeSchema = dataEnvelopeSchema.extend({
  value: holidaySchema.nullable().optional(),
});
