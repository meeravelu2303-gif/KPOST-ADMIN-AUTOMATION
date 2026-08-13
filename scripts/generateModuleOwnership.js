/**
 * Generates src/api/registry/moduleOwnership.generated.ts from api.json (the KPOST Admin
 * Module OpenAPI contract).
 *
 * This emits ownership data only — a path -> {module, team} map used by the bug ledger to
 * route each ticket to the right team. It generates no tests: every test in this suite is
 * hand-written under tests/<tag>/.
 *
 * The map is derived from the Swagger tag rather than guessed from URL prefixes, because
 * routes here do not follow their tag names (e.g. "Users, Onboarding & Authentication" lives
 * under /userDetails, "Workplace Tier — Variables" under /adminTierVariable), so prefix
 * matching silently mis-routes defects.
 *
 *   node scripts/generateModuleOwnership.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const swagger = JSON.parse(fs.readFileSync(path.join(ROOT, 'api.json'), 'utf-8'));

/** Tags whose own name declares them dead; excluded from the active surface. */
const LEGACY_TAG = /superseded|abandoned|deprecated/i;

/** Owning team per Swagger tag. A wrong entry here routes a defect to the wrong team. */
const TEAM_BY_TAG = {
  'Users, Onboarding & Authentication': 'Identity & Access',
  'Admin Details': 'Identity & Access',
  'Employee Master Data': 'Employee Master',
  'Employee ↔ Role Posting Mapping': 'Employee Master',
  'Role Postings': 'Role Postings',
  Departments: 'Org Structure',
  Designations: 'Org Structure',
  'Country & Address Reference Data': 'Reference Data',
  'Workplace Locations': 'Workplace Hierarchy',
  'Workplace Hierarchy Links': 'Workplace Hierarchy',
  'Workplace Tier — Attributes (Levels)': 'Workplace Hierarchy',
  'Workplace Tier — Variables (Nodes)': 'Workplace Hierarchy',
  'Generic Attributes (Base Hierarchy Levels)': 'Workplace Hierarchy',
  'Generic Variables (Base Hierarchy Nodes)': 'Workplace Hierarchy',
  'HR Tier — Levels': 'HR Hierarchy',
  'HR Tier — Variables (Nodes)': 'HR Hierarchy',
  'HR Set-Up Tier — Levels': 'HR Hierarchy',
  'HR Set-Up Tier — Variables (Nodes)': 'HR Hierarchy',
  'Product Catalogue': 'Product & Licensing',
  'Product Subscriptions': 'Product & Licensing',
  'Product Demo Requests': 'Product & Licensing',
  'Product ↔ Employee Licensing': 'Product & Licensing',
  'Project Catalogue': 'Product & Licensing',
  'Holiday Calendar': 'Company Administration',
  'admin-module-application': 'Platform Infrastructure',
};

const moduleByPath = {};
const tagCounts = {};
const unmapped = new Set();

for (const [routePath, item] of Object.entries(swagger.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;

    const tag = (op.tags ?? ['Untagged'])[0];
    if (LEGACY_TAG.test(tag)) continue;

    if (!(tag in TEAM_BY_TAG)) unmapped.add(tag);
    moduleByPath[routePath] = { module: tag, team: TEAM_BY_TAG[tag] ?? 'Platform' };
    tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
  }
}

const contents = `/**
 * GENERATED FILE — do not edit by hand.
 * Regenerate with: node scripts/generateModuleOwnership.js
 *
 * Ownership data only: maps an endpoint path to its owning Swagger tag and the team a
 * defect should be routed to. Contains no test logic — every test is hand-written under
 * tests/<tag>/.
 *
 * Covers ${Object.keys(moduleByPath).length} active endpoints across ${Object.keys(tagCounts).length} tags.
 */

export interface ModuleOwnership {
  module: string;
  team: string;
}

export const MODULE_BY_PATH: Record<string, ModuleOwnership> = ${JSON.stringify(
  moduleByPath,
  null,
  2
)};
`;

const outDir = path.join(ROOT, 'src', 'api', 'registry');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'moduleOwnership.generated.ts'), contents, 'utf-8');

if (unmapped.size > 0) {
  console.warn(
    `WARNING: ${unmapped.size} tag(s) have no TEAM_BY_TAG entry and defaulted to "Platform": ${[...unmapped].join(', ')}`
  );
}
console.log(
  `Wrote ownership for ${Object.keys(moduleByPath).length} endpoints across ${Object.keys(tagCounts).length} tags.`
);
