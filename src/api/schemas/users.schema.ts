import { z } from 'zod';
import { dataEnvelopeSchema } from './envelope.schema';
import { objectIdSchema } from './departments.schema';

/**
 * SignUpResponse — the identity projection returned in `value` by userDetails/signUp and
 * userDetails/login. A response-only DTO. It deliberately omits the password AND carries no
 * token (the JWT the auth filter expects is delivered elsewhere — see authSession.ts).
 */
export const signUpResponseSchema = z
  .object({
    id: objectIdSchema.optional(),
    country: z.string().optional(),
    name: z.string().optional(),
    mobileNumber: z.string().optional(),
    emailID: z.string().optional(),
    userID: z.string().optional(),
  })
  .passthrough();

export type SignUpResponse = z.infer<typeof signUpResponseSchema>;

export const signUpEnvelopeSchema = dataEnvelopeSchema.extend({
  value: signUpResponseSchema.nullable().optional(),
});

/** validateOTP / sendOTP responses put a human note in `message`. */
export const otpEnvelopeSchema = dataEnvelopeSchema.extend({
  message: z.string().nullish(),
});

/**
 * UserRegistration — the tenant onboarding record echoed back by userDetails/registration.
 *
 * `password` is deliberately NOT modelled here even though the live endpoint echoes it: the
 * schema describes the contract as it ought to be, and `.passthrough()` means an echoed
 * credential does not fail validation. The disclosure is caught by its own dedicated
 * business-rule case in the spec, where it is graded as the Critical defect it is.
 */
export const registrationSchema = z
  .object({
    id: objectIdSchema.optional(),
    country: z.string().optional(),
    typeOfOrganization: z.string().optional(),
    organizationName: z.string().optional(),
    userID: z.string().optional(),
    userName: z.string().optional(),
    userDesignation: z.string().optional(),
    contactNumber: z.string().optional(),
    contactEmailID: z.string().optional(),
    website: z.string().optional(),
    pincode: z.string().optional(),
    state: z.string().optional(),
    city: z.string().optional(),
    area: z.string().optional(),
    address: z.string().optional(),
    noOfEmployee: z.number().optional(),
    noOfUserLicenses: z.number().optional(),
    logo: z.string().optional(),
  })
  .passthrough();

export const registrationEnvelopeSchema = dataEnvelopeSchema.extend({
  value: registrationSchema.nullable().optional(),
});

/**
 * UserDetails — a directory entry from `table_admin_user_details`, the shape save/update
 * accept and getAllUser returns.
 *
 * `companyId` is an INTEGER on this collection alone; every other collection in the module
 * types it as a string. The schema models what api.json documents so the mismatch shows up
 * as a contract finding rather than being quietly absorbed.
 */
export const userDetailsSchema = z
  .object({
    id: objectIdSchema.optional(),
    companyId: z.number().optional(),
    userID: z.string().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    gender: z.string().optional(),
    mobileNumber: z.string().optional(),
    variableIds: z.array(z.unknown()).nullish(),
    reportingVariableIds: z.array(z.unknown()).nullish(),
  })
  .passthrough();

export type UserDetails = z.infer<typeof userDetailsSchema>;

/** save / update echo the persisted document back in `value`. */
export const userDetailsEnvelopeSchema = dataEnvelopeSchema.extend({
  value: userDetailsSchema.nullable().optional(),
});

/** getAllUser returns the tenant's whole directory — PII included — as an array in `value`. */
export const userListEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z.array(userDetailsSchema).nullable().optional(),
});

/**
 * generateUserIdSuggestions returns candidate login names. api.json types `value` only as the
 * generic envelope payload, so the array-of-strings shape is the documented intent taken from
 * the operation description; a divergence from it is a genuine contract finding.
 */
export const userIdSuggestionEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z.array(z.string()).nullable().optional(),
});

/**
 * checkAvailability answers with the verdict in `value` and the echoed `requestType` in the
 * human `message`. The verdict is reported as a boolean by some builds and as a word by
 * others, which is exactly the sort of shape drift this contract is here to surface.
 */
export const availabilityEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z.union([z.boolean(), z.string()]).nullable().optional(),
  message: z.string().nullish(),
});

/** createCommunicationId composes an identifier string from department/designation/role. */
export const communicationIdEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z.union([z.string(), z.record(z.string(), z.unknown())]).nullable().optional(),
});
