import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

/**
 * The routes this subsystem owns, in one place.
 *
 * Specs build their `META.path` from these rather than retyping the string, so a path and the
 * bug ticket that reports a defect on it can never drift apart. `audit-vectors.ts` groups
 * coverage by the `METHOD /path` signature in the describe title, which makes that string
 * load-bearing rather than decorative.
 *
 * Four Swagger tags share this client because they share an owning team; bug ownership is
 * still resolved per path by `MODULE_BY_PATH`, so each tag routes to its own queue.
 */
export const WORKPLACE_HIERARCHY_PATHS = {
  // Generic Attributes — base hierarchy LEVELS (table_admin_attribute)
  attributeSave: '/attribute/save',
  attributeUpdate: '/attribute/update',
  attributeDelete: '/attribute/delete',
  attributeGet: '/attribute/getAttribute',
  attributeGetByCompanyId: '/attribute/getAttributeByCompanyId',

  // Generic Variables — base hierarchy NODES (table_admin_variable)
  variableSave: '/variable/save',
  variableUpdate: '/variable/update',
  variableDelete: '/variable/delete',
  variableGet: '/variable/getVariable',

  // Workplace Tier — LEVELS (table_admin_tier_attribute)
  tierAttributeSave: '/adminTierAttribute/save',
  tierAttributeUpdate: '/adminTierAttribute/update',
  tierAttributeDelete: '/adminTierAttribute/delete',
  tierAttributeGet: '/adminTierAttribute/getAttribute',
  tierAttributeGetByCompanyId: '/adminTierAttribute/getAttributeByCompanyId',

  // Workplace Tier — NODES (table_admin_tier_variable)
  tierVariableSave: '/adminTierVariable/save',
  tierVariableUpdate: '/adminTierVariable/update',
  tierVariableDelete: '/adminTierVariable/delete',
  tierVariableGet: '/adminTierVariable/getAdminTierVariable',
  tierVariableReportingHierarchy: '/adminTierVariable/getAllReportingVariableHierarchy',
  tierVariableGetAll: '/adminTierVariable/getAllVariable',

  // Workplace Hierarchy Links — EDGES (table_admin_workplace_hierarchy)
  hierarchySave: '/workplaceHierarchy/save',
  hierarchyUpdate: '/workplaceHierarchy/update',
  hierarchyDelete: '/workplaceHierarchy/delete',
  hierarchyGet: '/workplaceHierarchy/getWorkPlaceHierarchy',
  getOrganization: '/workplaceHierarchy/getOrganization',
} as const;

/**
 * Thin client for the workplace-hierarchy subsystem (team: Workplace Hierarchy):
 *   - Generic Attributes (/attribute/*)         base hierarchy LEVELS
 *   - Generic Variables (/variable/*)           base hierarchy NODES
 *   - Workplace Tier Attributes (/adminTierAttribute/*)
 *   - Workplace Tier Variables (/adminTierVariable/*)
 *   - Workplace Hierarchy Links (/workplaceHierarchy/*)
 *
 * Pass-through only; `save` on every *Attribute/*Variable route takes an ARRAY, while
 * `workplaceHierarchy/save` takes a single object. Every `update` is a whole-document write:
 * a field omitted from the body is persisted as `null`.
 *
 * Every `delete` here is a destructive, non-cascading hard delete on a tree node. Exercise
 * them with freshly-minted random ObjectIds or on refusal / auth paths only.
 */
export class WorkplaceHierarchyClient extends BaseClient {
  // --- Generic Attributes (base LEVELS) ---
  saveAttribute(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(WORKPLACE_HIERARCHY_PATHS.attributeSave, body, o);
  }
  updateAttribute(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(WORKPLACE_HIERARCHY_PATHS.attributeUpdate, body, o);
  }
  /** findById on `table_admin_attribute`; a miss is 200 with `value: null`, never a 404. */
  getAttribute(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(WORKPLACE_HIERARCHY_PATHS.attributeGet, body, o);
  }
  getAttributeByCompanyId(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(WORKPLACE_HIERARCHY_PATHS.attributeGetByCompanyId, body, o);
  }
  /** Hard delete; orphans any generic variable still carrying this `attributeId`. */
  deleteAttribute(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(WORKPLACE_HIERARCHY_PATHS.attributeDelete, body, o);
  }

  // --- Generic Variables (base NODES) ---
  /** Body is an ARRAY of Variable documents. */
  saveVariable(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(WORKPLACE_HIERARCHY_PATHS.variableSave, body, o);
  }
  updateVariable(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(WORKPLACE_HIERARCHY_PATHS.variableUpdate, body, o);
  }
  /** Direct children of `parentVariableId` within `companyId`. */
  getVariable(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(WORKPLACE_HIERARCHY_PATHS.variableGet, body, o);
  }
  deleteVariable(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(WORKPLACE_HIERARCHY_PATHS.variableDelete, body, o);
  }

  // --- Workplace Tier Attributes (LEVELS) ---
  saveTierAttribute(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(WORKPLACE_HIERARCHY_PATHS.tierAttributeSave, body, o);
  }
  updateTierAttribute(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(WORKPLACE_HIERARCHY_PATHS.tierAttributeUpdate, body, o);
  }
  /**
   * Documented defect: this route answers HTTP 500 on its SUCCESS path while the envelope
   * inside reports `statusCode: 200`. Branch on the envelope, never the transport status.
   */
  getTierAttribute(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(WORKPLACE_HIERARCHY_PATHS.tierAttributeGet, body, o);
  }
  getTierAttributeByCompanyId(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(WORKPLACE_HIERARCHY_PATHS.tierAttributeGetByCompanyId, body, o);
  }
  deleteTierAttribute(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(WORKPLACE_HIERARCHY_PATHS.tierAttributeDelete, body, o);
  }

  // --- Workplace Tier Variables (NODES) ---
  /** Body is an ARRAY of AdminTierVariable documents. */
  saveTierVariable(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(WORKPLACE_HIERARCHY_PATHS.tierVariableSave, body, o);
  }
  /** Re-parenting moves the whole subtree implicitly — children resolve by parent id. */
  updateTierVariable(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(WORKPLACE_HIERARCHY_PATHS.tierVariableUpdate, body, o);
  }
  /** Direct children of `parentVariableId` within `companyId`. */
  getAdminTierVariable(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(WORKPLACE_HIERARCHY_PATHS.tierVariableGet, body, o);
  }
  /** Application-side walk of `reporting_variable_id`, one findById per hop — no cycle guard. */
  getAllReportingVariableHierarchy(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(WORKPLACE_HIERARCHY_PATHS.tierVariableReportingHierarchy, body, o);
  }
  /** Unfiltered `find({})` across every tenant — no companyId filter, no paging. */
  getAllTierVariable(o: RequestOptions = {}): Promise<APIResponse> {
    return this.get(WORKPLACE_HIERARCHY_PATHS.tierVariableGetAll, o);
  }
  deleteTierVariable(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(WORKPLACE_HIERARCHY_PATHS.tierVariableDelete, body, o);
  }

  // --- Workplace Hierarchy Links (EDGES) ---
  /** Body is a single WorkPlaceHierarchy document, not an array. */
  saveHierarchy(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(WORKPLACE_HIERARCHY_PATHS.hierarchySave, body, o);
  }
  updateHierarchy(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(WORKPLACE_HIERARCHY_PATHS.hierarchyUpdate, body, o);
  }
  /** Query-by-example: the non-null fields of the submitted document become the filter. */
  getHierarchy(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(WORKPLACE_HIERARCHY_PATHS.hierarchyGet, body, o);
  }
  deleteHierarchy(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(WORKPLACE_HIERARCHY_PATHS.hierarchyDelete, body, o);
  }
  /** GET org-type reference list — a registration-time lookup that must work before a token. */
  getOrganization(o: RequestOptions = {}): Promise<APIResponse> {
    return this.get(WORKPLACE_HIERARCHY_PATHS.getOrganization, o);
  }
}
