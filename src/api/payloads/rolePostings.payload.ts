import { env } from '../../config/env.config';
import { qaLabel } from '../../utils/safeTestData';
import { randomObjectId } from './departments.payload';

/**
 * Faker-backed request builders for the Role Postings tag.
 *
 * Every builder takes `Record<string, unknown>` overrides — NOT `Partial<RolePosting>` — so a
 * fuzz test can deliberately submit wrong-typed values (a number where a string belongs, an
 * array where an object belongs) that a strict override type would forbid.
 *
 * Every id defaults to a freshly-minted random 24-char hex ObjectId that matches no document.
 * That is deliberate: `delete`, `softDelete` and `suspendOrTerminateEmployee` all mutate real
 * employment records, so nothing in this tag may ever point at a live row.
 */

/** Re-exported so specs in this tag get their ids from one place. */
export { randomObjectId };

/** A RolePostingRequest — the shape save / suspend / lookup routes take. */
export function buildRolePostingRequest(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    companyId: env.qaCompanyId,
    employeeId: randomObjectId(),
    displayName: qaLabel('EMP'),
    userType: 'employee',
    countryId: 1,
    countryCode: 91,
    ...overrides,
  };
}

/** save takes an ARRAY of RolePostingRequest. */
export function buildRolePostingArray(
  count = 1,
  overrides: Record<string, unknown> = {}
): Array<Record<string, unknown>> {
  return Array.from({ length: count }, () => buildRolePostingRequest(overrides));
}

/** update / softDelete / delete take a RolePosting, which carries the document `id`. */
export function buildRolePostingUpdate(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: randomObjectId(),
    ...buildRolePostingRequest(),
    activeStatus: true,
    remarks: qaLabel('REMARK'),
    ...overrides,
  };
}

/** A suspend / terminate action against an existing posting. */
export function buildSuspendRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    companyId: env.qaCompanyId,
    employeeId: randomObjectId(),
    rolePostingId: randomObjectId(),
    requestType: 'suspend',
    reason: 'Pending internal enquiry',
    remarks: 'QA automation refusal-path case',
    duration: '30',
    ...overrides,
  };
}

/** getSuspendOrTerminateEmployee: the read side of the lifecycle, keyed by company + type. */
export function buildSuspendListRequest(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { companyId: env.qaCompanyId, requestType: 'suspend', ...overrides };
}

/** Lookups keyed on company (and optionally employee). */
export function buildGetByCompany(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { companyId: env.qaCompanyId, ...overrides };
}

export function buildGetByCompanyAndEmployee(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { companyId: env.qaCompanyId, employeeId: randomObjectId(), ...overrides };
}

export function buildById(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: randomObjectId(), ...overrides };
}

/** getEmployeeDetailsByLastHrvariableId lookup: company + last HR variable node. */
export function buildByLastHrVariable(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { companyId: env.qaCompanyId, lastHrVariableId: randomObjectId(), ...overrides };
}
