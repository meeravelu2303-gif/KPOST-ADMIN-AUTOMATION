import { env } from '../../config/env.config';
import { qaLabel } from '../../utils/safeTestData';
import { randomObjectId } from './departments.payload';

/**
 * Shared faker-backed builders for the hierarchy tiers. Overrides are Record<string, unknown>
 * so fuzz cases can submit wrong-typed values. The Level and Node shapes are identical across
 * every workplace/HR tier, so the builders are reused; the tests remain hand-written per tag.
 *
 * Three archetypes live here:
 *   LEVEL — a tier "attribute": { companyId, attributeName }
 *   NODE  — a tier "variable": { companyId, attributeId, variableName, parent*, reporting* }
 *   EDGE  — a WorkPlaceHierarchy link, which wires a node to its structural parent AND to its
 *           (independent) reporting counterpart. Note it carries **no companyId** — tenant
 *           scope on those routes can only come from the ids, which is why the IDOR cases in
 *           tests/workplaceHierarchy point a foreign id at it rather than a foreign companyId.
 *
 * Every default id is a freshly-minted random 24-char hex ObjectId that matches no document.
 * That is deliberate and load-bearing: every delete route in this subsystem is a hard,
 * non-cascading delete on a tree node, so a real id would orphan its children with no undo.
 */

/** A LEVEL / tier attribute: { companyId, attributeName }. */
export function buildLevel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { companyId: env.qaCompanyId, attributeName: qaLabel('LEVEL'), ...overrides };
}
export function buildLevelArray(
  count = 1,
  overrides: Record<string, unknown> = {}
): Array<Record<string, unknown>> {
  return Array.from({ length: count }, () => buildLevel(overrides));
}
/** A LEVEL update targets an existing document, so it carries an `id`. */
export function buildLevelUpdate(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { id: randomObjectId(), ...buildLevel(), ...overrides };
}

/** A NODE / tier variable hung off an attribute, optionally under a parent node. */
export function buildNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    companyId: env.qaCompanyId,
    attributeId: randomObjectId(),
    variableName: qaLabel('NODE'),
    ...overrides,
  };
}
export function buildNodeArray(
  count = 1,
  overrides: Record<string, unknown> = {}
): Array<Record<string, unknown>> {
  return Array.from({ length: count }, () => buildNode(overrides));
}
/** A NODE update targets an existing document, so it carries an `id`. */
export function buildNodeUpdate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: randomObjectId(), ...buildNode(), ...overrides };
}

/**
 * A NODE that also declares a reporting line. `reportingVariableId` is the link the
 * `getAllReporting*Hierarchy` walks follow, and it is independent of `parentVariableId` —
 * which is exactly why a cycle planted here can hang a recursive server-side traversal.
 */
export function buildReportingNode(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ...buildNode(),
    parentAttributeId: randomObjectId(),
    parentVariableId: randomObjectId(),
    reportingAttributeId: randomObjectId(),
    reportingVariableId: randomObjectId(),
    reportingJson: JSON.stringify([{ attributeName: 'QA-LEVEL', variableName: 'QA-NODE' }]),
    ...overrides,
  };
}

/** Lookups keyed on a single id or on the tenant. */
export function buildById(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: randomObjectId(), ...overrides };
}
export function buildByCompany(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { companyId: env.qaCompanyId, ...overrides };
}
/** getVariable-style lookup: parent node + tenant. */
export function buildNodeLookup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { companyId: env.qaCompanyId, parentVariableId: randomObjectId(), ...overrides };
}

/**
 * An EDGE of the workplace graph (`WorkPlaceHierarchy`). Four attribute/variable id pairs plus
 * two denormalised JSON-string snapshots. `workplaceJson` / `reportingJson` are JSON *strings*,
 * not nested objects — sending an object there is a documented type mismatch worth fuzzing.
 */
export function buildHierarchyLink(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    attributeId: randomObjectId(),
    variableId: randomObjectId(),
    parentAttributeId: randomObjectId(),
    parentVariableId: randomObjectId(),
    reportingAttributeId: randomObjectId(),
    reportingVariableId: randomObjectId(),
    reportingParentAttributeId: randomObjectId(),
    reportingParentVariableId: randomObjectId(),
    workplaceJson: JSON.stringify([{ attributeName: 'QA-Region', variableName: 'QA-South' }]),
    reportingJson: JSON.stringify([{ attributeName: 'QA-Region', variableName: 'QA-South' }]),
    ...overrides,
  };
}
/** An EDGE update targets an existing link, so it carries an `id`. */
export function buildHierarchyLinkUpdate(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { id: randomObjectId(), ...buildHierarchyLink(), ...overrides };
}
/** getWorkPlaceHierarchy is a query-by-example: only the non-null fields become filters. */
export function buildHierarchyQuery(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { attributeId: randomObjectId(), variableId: randomObjectId(), ...overrides };
}

export { randomObjectId };
