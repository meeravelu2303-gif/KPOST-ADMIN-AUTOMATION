import { z } from 'zod';
import { dataEnvelopeSchema } from './envelope.schema';
import { objectIdSchema } from './departments.schema';

/**
 * Schemas for the reference-data & onboarding tail:
 *   - Country & Address Reference Data (/country/*)
 *   - Admin Details (/adminDetails/*)
 *   - Employee ↔ Role Posting Mapping (/employeeRoleMapping/*)
 * Bug ownership is still resolved per path by MODULE_BY_PATH, so these three tags route to
 * their own teams (Reference Data, Identity & Access, Employee Master) despite sharing a
 * test project.
 */

export const countrySchema = z
  .object({
    id: objectIdSchema.optional(),
    countryName: z.string().optional(),
    dialCode: z.string().optional(),
    countryCode: z.string().optional(),
  })
  .passthrough();

/**
 * `value` is the whole catalogue. An EMPTY catalogue is a documented success — the live
 * backend currently answers `{"value":[],"status":"SUCCESS","statusCode":200}` — so an empty
 * array must validate rather than be reported as a contract defect.
 */
export const countryListEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z.array(countrySchema).nullable().optional(),
});

/**
 * getAddressUsingPincode returns a list of loose key/value maps shaped by the EXTERNAL KPOST
 * address service, not a local schema — so the item shape is deliberately unconstrained.
 */
export const addressListEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
});

/**
 * getAddressUsingPincodeAndCountry returns only the FIRST upstream entry, so `value` is a
 * single untyped map rather than a list.
 */
export const addressEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z.record(z.string(), z.unknown()).nullable().optional(),
});

/** Admin Details — carries the administrator's personal data (dob, mobile). */
export const adminDetailsSchema = z
  .object({
    id: objectIdSchema.optional(),
    companyId: z.string().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    dob: z.string().optional(),
    gender: z.string().optional(),
    mobile: z.string().optional(),
    kpostID: z.string().optional(),
  })
  .passthrough();

/** The saved administrator profile comes back in `value`. */
export const adminDetailsEnvelopeSchema = dataEnvelopeSchema.extend({
  value: adminDetailsSchema.nullable().optional(),
});

export const employeeRoleMappingSchema = z
  .object({
    id: objectIdSchema.optional(),
    companyId: z.string().optional(),
    employeeId: z.string().optional(),
    rolePostingId: z.string().optional(),
    createdDate: z.string().optional(),
  })
  .passthrough();

/**
 * `value` holds the persisted mapping — but the endpoint has no failure branch, so a null
 * service result is still reported as SUCCESS with `value: null`. The nullable is therefore
 * describing the real contract, not being lenient.
 */
/*
 * `value` admits a bare string as well as the mapping document, because api.json declares this
 * response as the generic `ApiResponseEnvelope` and never constrains `value` at all. The live
 * endpoint answers `value: "Employee -RoleMapping Creates Successfully!!"` — a status message.
 *
 * Modelling `value` as the persisted entity was an inference, not a contract read, and it made
 * every save report a schema violation against behaviour the spec permits. Asserting a contract
 * the document does not state manufactures defects; where the spec is silent, the test must be
 * silent too. A genuinely wrong shape (a number, an array) still fails.
 */
export const employeeRoleMappingEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z.union([employeeRoleMappingSchema, z.string()]).nullable().optional(),
});
