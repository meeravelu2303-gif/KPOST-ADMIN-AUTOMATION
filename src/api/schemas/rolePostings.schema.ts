import { z } from 'zod';
import { dataEnvelopeSchema } from './envelope.schema';
import { objectIdSchema } from './departments.schema';

/**
 * A role posting — the assignment that places an employee at a workplace/HR tier node, with
 * suspend / terminate / transfer / promotion lifecycle. Backed by `table_admin_role_posting`.
 * Only a subset of the ~35 fields is modelled; unknown fields pass through.
 */
export const rolePostingSchema = z
  .object({
    id: objectIdSchema.optional(),
    companyId: z.string().optional(),
    employeeId: z.string().optional(),
    kpostID: z.string().optional(),
    displayName: z.string().optional(),
    workplaceLocationId: z.string().optional(),
    activeStatus: z.boolean().optional(),
    requestType: z.string().optional(),
    reason: z.string().optional(),
    remarks: z.string().optional(),
  })
  .passthrough();

export type RolePosting = z.infer<typeof rolePostingSchema>;

export const rolePostingListEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z.array(rolePostingSchema).nullable().optional(),
});

export const rolePostingEnvelopeSchema = dataEnvelopeSchema.extend({
  value: rolePostingSchema.nullable().optional(),
});

/**
 * The employee-shaped rows several `/rolePosting/*` lookups return
 * (`getEmployeeByCompanyId`, `getAssignedRolePostingEmployeeByCompanyId`,
 * `getEmployeeDetailsByLastHrvariableId`). They are `EmployeeDetails` documents joined onto the
 * posting rather than postings themselves, so they carry personal data — which is why the
 * unauthenticated cases on those routes grade Critical rather than Major when a row comes back.
 */
export const rolePostingEmployeeSchema = z
  .object({
    id: objectIdSchema.optional(),
    companyId: z.string().optional(),
    employeeId: z.string().optional(),
    kpostID: z.string().optional(),
    displayName: z.string().optional(),
    locationName: z.string().optional(),
    promotionDetails: z.string().nullish(),
    transferDetails: z.string().nullish(),
  })
  .passthrough();

export const rolePostingEmployeeListEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z.array(rolePostingEmployeeSchema).nullable().optional(),
});
