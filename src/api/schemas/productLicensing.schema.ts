import { z } from 'zod';
import { dataEnvelopeSchema } from './envelope.schema';
import { objectIdSchema } from './departments.schema';

/**
 * Schemas for the Product & Licensing subsystem — Product Catalogue, Product Subscriptions,
 * Product ↔ Employee Licensing, Product Demo Requests, Project Catalogue. All share the
 * module's standard envelope, with the payload in `value`.
 */

export const productMasterSchema = z
  .object({
    id: objectIdSchema.optional(),
    productName: z.string().optional(),
    productCode: z.string().optional(),
    productDescription: z.string().optional(),
    productLogo: z.string().optional(),
    isPurchased: z.boolean().optional(),
  })
  .passthrough();

export const productPurchaseSchema = z
  .object({
    id: objectIdSchema.optional(),
    productId: z.string().optional(),
    companyId: z.string().optional(),
    productType: z.string().optional(),
    subscriptionType: z.string().optional(),
    subscriptionDate: z.string().optional(),
    endDate: z.string().optional(),
  })
  .passthrough();

export const productEmployeeMappingSchema = z
  .object({
    id: objectIdSchema.optional(),
    employeeId: z.string().optional(),
    productId: z.string().optional(),
    companyId: z.string().optional(),
    rolePostingId: z.string().optional(),
    kpostId: z.string().optional(),
  })
  .passthrough();

/** A sales lead from the PUBLIC demo form — carries prospect PII. */
export const demoRequestSchema = z
  .object({
    id: objectIdSchema.optional(),
    nameOfUser: z.string().optional(),
    contactEmailId: z.string().optional(),
    contactMobileNumber: z.string().optional(),
    preferredDateAndTime: z.string().optional(),
    projectList: z.array(z.string()).optional(),
    status: z.string().optional(),
  })
  .passthrough();

export const projectDetailsSchema = z
  .object({
    id: objectIdSchema.optional(),
    title: z.string().optional(),
    abbreviation: z.string().optional(),
    content: z.string().optional(),
  })
  .passthrough();

export type ProductMaster = z.infer<typeof productMasterSchema>;
export type DemoRequest = z.infer<typeof demoRequestSchema>;

export const productListEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z.array(productMasterSchema).nullable().optional(),
});

export const purchaseListEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z.array(productPurchaseSchema).nullable().optional(),
});

export const demoListEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z.array(demoRequestSchema).nullable().optional(),
});

export const projectListEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z.array(projectDetailsSchema).nullable().optional(),
});

export const mappingListEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z.array(productEmployeeMappingSchema).nullable().optional(),
});

export const mappingEnvelopeSchema = dataEnvelopeSchema.extend({
  value: productEmployeeMappingSchema.nullable().optional(),
});

export const purchaseEnvelopeSchema = dataEnvelopeSchema.extend({
  value: productPurchaseSchema.nullable().optional(),
});

export const demoEnvelopeSchema = dataEnvelopeSchema.extend({
  value: demoRequestSchema.nullable().optional(),
});

/**
 * `getMappedEmployeeByCompanyIdAndProductId` answers with **RolePostingEntity** documents,
 * not with the ProductEmployeeMapping rows it queried — the join is done in Java and only the
 * resolved posting is returned. Kept loose (passthrough over an object) because the posting
 * entity is owned by the rolePostings tag, and duplicating its contract here would put two
 * copies of one shape in the repo.
 */
export const mappedRolePostingListEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z.array(z.object({}).passthrough()).nullable().optional(),
});

/**
 * `getKpostIDsByCompanyIdAndProductId` is the one route in the subsystem that does NOT use
 * `value`: the identifiers arrive under a non-standard top-level `kpostIDs` key, so a client
 * written against the documented envelope finds nothing. Modelling it explicitly is what makes
 * that deviation assertable rather than merely noted.
 */
export const kpostIdsEnvelopeSchema = dataEnvelopeSchema.extend({
  kpostIDs: z.array(z.string()).nullable().optional(),
});
