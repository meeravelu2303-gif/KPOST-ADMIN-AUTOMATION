import { z } from 'zod';
import { dataEnvelopeSchema } from './envelope.schema';
import { objectIdSchema } from './departments.schema';

/**
 * Shared archetypes for the workplace/HR hierarchy tiers. The whole hierarchy subsystem is
 * built from exactly three document shapes, repeated across nine tags:
 *
 *   LEVEL (a tier "attribute"): { id, companyId, attributeName, abbreviation, code }
 *     — Generic Attributes, Workplace Tier Attributes, HR Tier Levels, HR Set-Up Levels
 *   NODE  (a tier "variable"):  { id, attributeId, companyId, variableName, parent ids, ... }
 *     — Generic Variables, Workplace Tier Variables, HR Variables, HR Set-Up Variables
 *   EDGE  (a WorkPlaceHierarchy link): four attribute/variable id pairs plus two denormalised
 *     JSON-string path snapshots — the wiring between the nodes.
 *
 * Sharing the schema is not a test factory — the tests stay hand-written per tag. It just
 * avoids nine identical copies of the same contract.
 */

export const levelSchema = z
  .object({
    id: objectIdSchema.optional(),
    companyId: z.string().optional(),
    attributeName: z.string().optional(),
    abbreviation: z.string().optional(),
    code: z.string().optional(),
  })
  .passthrough();

export const nodeSchema = z
  .object({
    id: objectIdSchema.optional(),
    attributeId: z.string().optional(),
    companyId: z.string().optional(),
    variableName: z.string().optional(),
    parentVariableId: z.string().optional(),
    parentAttributeId: z.string().optional(),
    /** A JSON *string*, not a nested object — the snapshot is denormalised at write time. */
    reportingJson: z.string().optional(),
    reportingAttributeId: z.string().optional(),
    reportingVariableId: z.string().optional(),
    abbreviation: z.string().optional(),
    code: z.string().optional(),
  })
  .passthrough();

/**
 * An edge of the workplace graph. Note the absence of `companyId`: these documents carry no
 * tenant field at all, so nothing in the payload scopes them — the ids are the only handle.
 */
export const hierarchyLinkSchema = z
  .object({
    id: objectIdSchema.optional(),
    attributeId: z.string().optional(),
    variableId: z.string().optional(),
    parentAttributeId: z.string().optional(),
    parentVariableId: z.string().optional(),
    reportingAttributeId: z.string().optional(),
    reportingVariableId: z.string().optional(),
    reportingParentAttributeId: z.string().optional(),
    reportingParentVariableId: z.string().optional(),
    workplaceJson: z.string().optional(),
    reportingJson: z.string().optional(),
    abbreviation: z.string().optional(),
    code: z.string().optional(),
  })
  .passthrough();

export type Level = z.infer<typeof levelSchema>;
export type HierarchyNode = z.infer<typeof nodeSchema>;
export type HierarchyLink = z.infer<typeof hierarchyLinkSchema>;

export const levelListEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z.array(levelSchema).nullable().optional(),
});
export const levelEnvelopeSchema = dataEnvelopeSchema.extend({
  value: levelSchema.nullable().optional(),
});
export const nodeListEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z.array(nodeSchema).nullable().optional(),
});
export const nodeEnvelopeSchema = dataEnvelopeSchema.extend({
  value: nodeSchema.nullable().optional(),
});
export const hierarchyLinkListEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z.array(hierarchyLinkSchema).nullable().optional(),
});
export const hierarchyLinkEnvelopeSchema = dataEnvelopeSchema.extend({
  value: hierarchyLinkSchema.nullable().optional(),
});

/**
 * `workplaceHierarchy/getOrganization` reads no database at all — it splits the
 * `organization.types` application property on commas. The payload is therefore a plain list
 * of strings, identical for every caller on the deployment.
 */
export const organizationListEnvelopeSchema = dataEnvelopeSchema.extend({
  value: z.array(z.string()).nullable().optional(),
});
