import { z } from 'zod';
import { dataEnvelopeSchema } from './envelope.schema';

/** 24-character hex MongoDB ObjectId. */
export const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, 'not a 24-char hex ObjectId');

/**
 * A department document from `table_admin_department`. This entity declares no `@Field`
 * mappings, so properties persist under camelCase. Null fields are omitted from responses,
 * hence everything is optional.
 */
export const departmentSchema = z
  .object({
    id: objectIdSchema.optional(),
    companyId: z.string().optional(),
    departmentName: z.string().optional(),
    abbreviation: z.string().optional(),
    code: z.string().optional(),
  })
  .passthrough();

export type Department = z.infer<typeof departmentSchema>;

/** getDepartmentByCompanyId / save return the array of documents in `value`. */
export const departmentListEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z.array(departmentSchema).nullable().optional(),
});

/** A single-document response (e.g. a persisted department echoed back). */
export const departmentEnvelopeSchema = dataEnvelopeSchema.extend({
  value: departmentSchema.nullable().optional(),
});

/**
 * abbreviationAndCodeCreation returns the generated pair. The concrete map keys are not
 * strongly documented, so `value` is validated as a loose string map with the two fields
 * of interest surfaced.
 */
export const abbreviationEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z
    .object({
      abbreviation: z.string().optional(),
      code: z.string().optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
});
