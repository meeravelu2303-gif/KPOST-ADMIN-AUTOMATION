import { z } from 'zod';
import { dataEnvelopeSchema } from './envelope.schema';
import { objectIdSchema } from './departments.schema';

/**
 * A designation document from `table_admin_designation`, scoped by `companyId` and hung off a
 * department via `departmentId`. Deleting a department leaves its designations orphaned.
 */
export const designationSchema = z
  .object({
    id: objectIdSchema.optional(),
    departmentId: z.string().optional(),
    companyId: z.string().optional(),
    parentDesignationId: z.string().optional(),
    designationName: z.string().optional(),
    abbreviation: z.string().optional(),
    code: z.string().optional(),
    departmentIdList: z.array(z.string()).optional(),
  })
  .passthrough();

export type Designation = z.infer<typeof designationSchema>;

export const designationListEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z.array(designationSchema).nullable().optional(),
});

export const abbreviationEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z
    .object({ abbreviation: z.string().optional(), code: z.string().optional() })
    .passthrough()
    .nullable()
    .optional(),
});
