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
 * `hrTier` and `hrSetUpTierAttribute` are structurally identical but back **different
 * collections** — `table_admin_hr_tier` and `table_admin_hr_setup_tier_attribute`. Role
 * postings bind to the set-up tier, so the two are not interchangeable.
 */
export const HR_HIERARCHY_PATHS = {
  // HR Tier — LEVELS (table_admin_hr_tier)
  tierSave: '/hrTier/save',
  tierUpdate: '/hrTier/update',
  tierDelete: '/hrTier/delete',
  tierGet: '/hrTier/getAttribute',
  tierGetByCompanyId: '/hrTier/getAttributeByCompanyId',

  // HR Tier — NODES (table_admin_hr_variable)
  variableSave: '/hrVariable/save',
  variableUpdate: '/hrVariable/update',
  variableDelete: '/hrVariable/delete',
  variableGet: '/hrVariable/getVariable',

  // HR Set-Up Tier — LEVELS (table_admin_hr_setup_tier_attribute)
  setUpAttributeSave: '/hrSetUpTierAttribute/save',
  setUpAttributeUpdate: '/hrSetUpTierAttribute/update',
  setUpAttributeDelete: '/hrSetUpTierAttribute/delete',
  setUpAttributeGet: '/hrSetUpTierAttribute/getAttribute',
  setUpAttributeGetByCompanyId: '/hrSetUpTierAttribute/getAttributeByCompanyId',

  // HR Set-Up Tier — NODES (table_admin_hr_setup_tier_variable)
  setUpVariableSave: '/hrSetUpTierVariable/save',
  setUpVariableUpdate: '/hrSetUpTierVariable/update',
  setUpVariableDelete: '/hrSetUpTierVariable/delete',
  setUpVariableGet: '/hrSetUpTierVariable/getHrSetUpTierVariable',
  setUpVariableReportingHierarchy: '/hrSetUpTierVariable/getAllReportingHrTierVariableHierarchy',
} as const;

/**
 * Thin client for the HR-hierarchy subsystem (team: HR Hierarchy):
 *   - HR Tier Levels (/hrTier/*)
 *   - HR Tier Variables (/hrVariable/*)
 *   - HR Set-Up Tier Levels (/hrSetUpTierAttribute/*)
 *   - HR Set-Up Tier Variables (/hrSetUpTierVariable/*)
 *
 * Pass-through only. `save` takes an ARRAY on `/hrTier`, `/hrSetUpTierAttribute` and
 * `/hrSetUpTierVariable`; the HR Variable `save` takes a **single object** per the spec —
 * an inconsistency inside one subsystem that is itself worth a case.
 *
 * Every `delete` is a destructive, non-cascading hard delete on a tree node, and
 * `hrSetUpTierVariable` documents are what role postings record in `lastHrVariableId` — so a
 * real deletion breaks employee placement. Use random ObjectIds or refusal / auth paths only.
 */
export class HrHierarchyClient extends BaseClient {
  // --- HR Tier Levels ---
  /** Body is an ARRAY of HrTier documents. */
  saveTier(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(HR_HIERARCHY_PATHS.tierSave, body, o);
  }
  updateTier(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(HR_HIERARCHY_PATHS.tierUpdate, body, o);
  }
  /** findById on `table_admin_hr_tier`; a miss is 200 with `value: null`, never a 404. */
  getTier(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(HR_HIERARCHY_PATHS.tierGet, body, o);
  }
  getTierByCompanyId(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(HR_HIERARCHY_PATHS.tierGetByCompanyId, body, o);
  }
  deleteTier(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(HR_HIERARCHY_PATHS.tierDelete, body, o);
  }

  // --- HR Tier Variables ---
  /** Body is a SINGLE HrVariable document — unlike every other save in this subsystem. */
  saveVariable(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(HR_HIERARCHY_PATHS.variableSave, body, o);
  }
  /** Whole-document write; changing `parentVariableId` moves the node's subtree implicitly. */
  updateVariable(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(HR_HIERARCHY_PATHS.variableUpdate, body, o);
  }
  /** Direct children of `parentVariableId` within `companyId`. */
  getVariable(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(HR_HIERARCHY_PATHS.variableGet, body, o);
  }
  deleteVariable(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(HR_HIERARCHY_PATHS.variableDelete, body, o);
  }

  // --- HR Set-Up Tier Levels ---
  /** Body is an ARRAY of HrSetUpTierAttribute documents. */
  saveSetUpAttribute(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(HR_HIERARCHY_PATHS.setUpAttributeSave, body, o);
  }
  updateSetUpAttribute(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(HR_HIERARCHY_PATHS.setUpAttributeUpdate, body, o);
  }
  /** findById on `table_admin_hr_setup_tier_attribute`; a miss is 200 with `value: null`. */
  getSetUpAttribute(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(HR_HIERARCHY_PATHS.setUpAttributeGet, body, o);
  }
  getSetUpAttributeByCompanyId(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(HR_HIERARCHY_PATHS.setUpAttributeGetByCompanyId, body, o);
  }
  deleteSetUpAttribute(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(HR_HIERARCHY_PATHS.setUpAttributeDelete, body, o);
  }

  // --- HR Set-Up Tier Variables ---
  /** Body is an ARRAY of HrSetUpTierVariable documents. */
  saveSetUpVariable(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(HR_HIERARCHY_PATHS.setUpVariableSave, body, o);
  }
  updateSetUpVariable(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(HR_HIERARCHY_PATHS.setUpVariableUpdate, body, o);
  }
  /** Direct children of `parentVariableId` within `companyId`. */
  getHrSetUpTierVariable(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(HR_HIERARCHY_PATHS.setUpVariableGet, body, o);
  }
  /**
   * Follows `reporting_variable_id` from the node identified by `id`. Despite the plural
   * name it returns a **single node**, not a list — unlike its workplace-tier counterpart.
   */
  getAllReportingHrTierVariableHierarchy(
    body: unknown,
    o: RequestOptions = {}
  ): Promise<APIResponse> {
    return this.post(HR_HIERARCHY_PATHS.setUpVariableReportingHierarchy, body, o);
  }
  deleteSetUpVariable(body: unknown, o: RequestOptions = {}): Promise<APIResponse> {
    return this.post(HR_HIERARCHY_PATHS.setUpVariableDelete, body, o);
  }
}
