import { z } from 'zod';
import { dataEnvelopeSchema } from './envelope.schema';
import { objectIdSchema } from './departments.schema';

/**
 * Employee master record from `table_admin_employee_details`, scoped by `companyId`. The
 * document is a composite of nested objects (personal, residential, mailing, employment,
 * education, work experience, additional). Only the outer shape and the PII-bearing personal
 * block are modelled; nested detail passes through.
 */
export const personalInformationSchema = z
  .object({
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    dob: z.string().optional(),
    gender: z.string().optional(),
    maritalStatus: z.string().optional(),
    mobile: z.string().optional(),
    email: z.string().optional(),
  })
  .passthrough();

export const employeeDetailsSchema = z
  .object({
    id: objectIdSchema.optional(),
    companyId: z.string().optional(),
    personalInformationObj: personalInformationSchema.optional(),
    residentialObj: z.unknown().optional(),
    mailingObj: z.unknown().optional(),
    employmentObj: z.unknown().optional(),
    educationObj: z.array(z.unknown()).optional(),
    workExpObj: z.unknown().optional(),
    additionalObj: z.unknown().optional(),
  })
  .passthrough();

export type EmployeeDetails = z.infer<typeof employeeDetailsSchema>;

export const employeeListEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z.array(employeeDetailsSchema).nullable().optional(),
});

export const employeeEnvelopeSchema = dataEnvelopeSchema.extend({
  value: employeeDetailsSchema.nullable().optional(),
});
