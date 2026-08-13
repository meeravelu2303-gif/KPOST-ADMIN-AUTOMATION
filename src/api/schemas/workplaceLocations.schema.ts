import { z } from 'zod';
import { dataEnvelopeSchema } from './envelope.schema';
import { objectIdSchema } from './departments.schema';

/**
 * A workplace location under a workplace-tier attribute/variable node. Backed by
 * `table_admin_location`, scoped by `companyId`. `abbreviation`/`code` are server-generated.
 */
export const locationSchema = z
  .object({
    id: objectIdSchema.optional(),
    attributeId: z.string().optional(),
    variableId: z.string().optional(),
    companyId: z.string().optional(),
    locationName: z.string().optional(),
    workPlaceLocation: z.string().optional(),
    reportingWorkplaceLocationId: z.string().optional(),
    pincode: z.string().optional(),
    state: z.string().optional(),
    city: z.string().optional(),
    addressLine1: z.string().optional(),
    countryId: z.number().optional(),
    abbreviation: z.string().optional(),
    code: z.string().optional(),
  })
  .passthrough();

export type Location = z.infer<typeof locationSchema>;

export const locationListEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z.array(locationSchema).nullable().optional(),
});

export const locationEnvelopeSchema = dataEnvelopeSchema.extend({
  value: locationSchema.nullable().optional(),
});

/**
 * `location/getReportingLocationName` answers with an array of untyped maps rather than full
 * Location documents (api.json describes the payload exactly that way), so the contract that
 * can honestly be asserted is "envelope + array of objects" — not the Location shape.
 */
export const reportingLocationEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
});
