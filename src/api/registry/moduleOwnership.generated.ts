/**
 * GENERATED FILE — do not edit by hand.
 * Regenerate with: node scripts/generateModuleOwnership.js
 *
 * Ownership data only: maps an endpoint path to its owning Swagger tag and the team a
 * defect should be routed to. Contains no test logic — every test is hand-written under
 * tests/<tag>/.
 *
 * Covers 112 active endpoints across 25 tags.
 */

export interface ModuleOwnership {
  module: string;
  team: string;
}

export const MODULE_BY_PATH: Record<string, ModuleOwnership> = {
  "/workplaceHierarchy/update": {
    "module": "Workplace Hierarchy Links",
    "team": "Workplace Hierarchy"
  },
  "/workplaceHierarchy/save": {
    "module": "Workplace Hierarchy Links",
    "team": "Workplace Hierarchy"
  },
  "/workplaceHierarchy/getWorkPlaceHierarchy": {
    "module": "Workplace Hierarchy Links",
    "team": "Workplace Hierarchy"
  },
  "/workplaceHierarchy/delete": {
    "module": "Workplace Hierarchy Links",
    "team": "Workplace Hierarchy"
  },
  "/variable/update": {
    "module": "Generic Variables (Base Hierarchy Nodes)",
    "team": "Workplace Hierarchy"
  },
  "/variable/save": {
    "module": "Generic Variables (Base Hierarchy Nodes)",
    "team": "Workplace Hierarchy"
  },
  "/variable/getVariable": {
    "module": "Generic Variables (Base Hierarchy Nodes)",
    "team": "Workplace Hierarchy"
  },
  "/variable/delete": {
    "module": "Generic Variables (Base Hierarchy Nodes)",
    "team": "Workplace Hierarchy"
  },
  "/userDetails/validateOTP": {
    "module": "Users, Onboarding & Authentication",
    "team": "Identity & Access"
  },
  "/userDetails/update": {
    "module": "Users, Onboarding & Authentication",
    "team": "Identity & Access"
  },
  "/userDetails/signUp": {
    "module": "Users, Onboarding & Authentication",
    "team": "Identity & Access"
  },
  "/userDetails/sendOTP": {
    "module": "Users, Onboarding & Authentication",
    "team": "Identity & Access"
  },
  "/userDetails/save": {
    "module": "Users, Onboarding & Authentication",
    "team": "Identity & Access"
  },
  "/userDetails/resetPassword": {
    "module": "Users, Onboarding & Authentication",
    "team": "Identity & Access"
  },
  "/userDetails/registration": {
    "module": "Users, Onboarding & Authentication",
    "team": "Identity & Access"
  },
  "/userDetails/login": {
    "module": "Users, Onboarding & Authentication",
    "team": "Identity & Access"
  },
  "/userDetails/generateUserIdSuggestions": {
    "module": "Users, Onboarding & Authentication",
    "team": "Identity & Access"
  },
  "/userDetails/createCommunicationId": {
    "module": "Users, Onboarding & Authentication",
    "team": "Identity & Access"
  },
  "/userDetails/checkAvailability": {
    "module": "Users, Onboarding & Authentication",
    "team": "Identity & Access"
  },
  "/rolePosting/update": {
    "module": "Role Postings",
    "team": "Role Postings"
  },
  "/rolePosting/suspendOrTerminateEmployee": {
    "module": "Role Postings",
    "team": "Role Postings"
  },
  "/rolePosting/softDelete": {
    "module": "Role Postings",
    "team": "Role Postings"
  },
  "/rolePosting/save": {
    "module": "Role Postings",
    "team": "Role Postings"
  },
  "/rolePosting/getSuspendOrTerminateEmployee": {
    "module": "Role Postings",
    "team": "Role Postings"
  },
  "/rolePosting/getRolePostingById": {
    "module": "Role Postings",
    "team": "Role Postings"
  },
  "/rolePosting/getRolePostingByCompanyId": {
    "module": "Role Postings",
    "team": "Role Postings"
  },
  "/rolePosting/getRolePostingByCompanyIdAndEmployeeId": {
    "module": "Role Postings",
    "team": "Role Postings"
  },
  "/rolePosting/getEmployeeDetailsByLastHrvariableId": {
    "module": "Role Postings",
    "team": "Role Postings"
  },
  "/rolePosting/getEmployeeByCompanyId": {
    "module": "Role Postings",
    "team": "Role Postings"
  },
  "/rolePosting/getAssignedRolePostingEmployeeByCompanyId": {
    "module": "Role Postings",
    "team": "Role Postings"
  },
  "/rolePosting/delete": {
    "module": "Role Postings",
    "team": "Role Postings"
  },
  "/project/saveAllProject": {
    "module": "Project Catalogue",
    "team": "Product & Licensing"
  },
  "/productPurchase/save": {
    "module": "Product Subscriptions",
    "team": "Product & Licensing"
  },
  "/productMaster/save": {
    "module": "Product Catalogue",
    "team": "Product & Licensing"
  },
  "/productEmployeeMapping/save": {
    "module": "Product ↔ Employee Licensing",
    "team": "Product & Licensing"
  },
  "/productEmployeeMapping/saveKpostIdForKams": {
    "module": "Product ↔ Employee Licensing",
    "team": "Product & Licensing"
  },
  "/productEmployeeMapping/getMappedEmployeeByCompanyIdAndProductId": {
    "module": "Product ↔ Employee Licensing",
    "team": "Product & Licensing"
  },
  "/productEmployeeMapping/getKpostIDsByCompanyIdAndProductId": {
    "module": "Product ↔ Employee Licensing",
    "team": "Product & Licensing"
  },
  "/location/update": {
    "module": "Workplace Locations",
    "team": "Workplace Hierarchy"
  },
  "/location/save": {
    "module": "Workplace Locations",
    "team": "Workplace Hierarchy"
  },
  "/location/getReportingLocationName": {
    "module": "Workplace Locations",
    "team": "Workplace Hierarchy"
  },
  "/location/getLocation": {
    "module": "Workplace Locations",
    "team": "Workplace Hierarchy"
  },
  "/location/getLocationById": {
    "module": "Workplace Locations",
    "team": "Workplace Hierarchy"
  },
  "/location/getAllLocation": {
    "module": "Workplace Locations",
    "team": "Workplace Hierarchy"
  },
  "/location/delete": {
    "module": "Workplace Locations",
    "team": "Workplace Hierarchy"
  },
  "/hrVariable/update": {
    "module": "HR Tier — Variables (Nodes)",
    "team": "HR Hierarchy"
  },
  "/hrVariable/save": {
    "module": "HR Tier — Variables (Nodes)",
    "team": "HR Hierarchy"
  },
  "/hrVariable/getVariable": {
    "module": "HR Tier — Variables (Nodes)",
    "team": "HR Hierarchy"
  },
  "/hrVariable/delete": {
    "module": "HR Tier — Variables (Nodes)",
    "team": "HR Hierarchy"
  },
  "/hrTier/update": {
    "module": "HR Tier — Levels",
    "team": "HR Hierarchy"
  },
  "/hrTier/save": {
    "module": "HR Tier — Levels",
    "team": "HR Hierarchy"
  },
  "/hrTier/getAttribute": {
    "module": "HR Tier — Levels",
    "team": "HR Hierarchy"
  },
  "/hrTier/getAttributeByCompanyId": {
    "module": "HR Tier — Levels",
    "team": "HR Hierarchy"
  },
  "/hrTier/delete": {
    "module": "HR Tier — Levels",
    "team": "HR Hierarchy"
  },
  "/hrSetUpTierVariable/update": {
    "module": "HR Set-Up Tier — Variables (Nodes)",
    "team": "HR Hierarchy"
  },
  "/hrSetUpTierVariable/save": {
    "module": "HR Set-Up Tier — Variables (Nodes)",
    "team": "HR Hierarchy"
  },
  "/hrSetUpTierVariable/getHrSetUpTierVariable": {
    "module": "HR Set-Up Tier — Variables (Nodes)",
    "team": "HR Hierarchy"
  },
  "/hrSetUpTierVariable/getAllReportingHrTierVariableHierarchy": {
    "module": "HR Set-Up Tier — Variables (Nodes)",
    "team": "HR Hierarchy"
  },
  "/hrSetUpTierVariable/delete": {
    "module": "HR Set-Up Tier — Variables (Nodes)",
    "team": "HR Hierarchy"
  },
  "/hrSetUpTierAttribute/update": {
    "module": "HR Set-Up Tier — Levels",
    "team": "HR Hierarchy"
  },
  "/hrSetUpTierAttribute/save": {
    "module": "HR Set-Up Tier — Levels",
    "team": "HR Hierarchy"
  },
  "/hrSetUpTierAttribute/getAttribute": {
    "module": "HR Set-Up Tier — Levels",
    "team": "HR Hierarchy"
  },
  "/hrSetUpTierAttribute/getAttributeByCompanyId": {
    "module": "HR Set-Up Tier — Levels",
    "team": "HR Hierarchy"
  },
  "/hrSetUpTierAttribute/delete": {
    "module": "HR Set-Up Tier — Levels",
    "team": "HR Hierarchy"
  },
  "/holiday/saveHoliday": {
    "module": "Holiday Calendar",
    "team": "Company Administration"
  },
  "/employeeRoleMapping/save": {
    "module": "Employee ↔ Role Posting Mapping",
    "team": "Employee Master"
  },
  "/employeeDetails/update": {
    "module": "Employee Master Data",
    "team": "Employee Master"
  },
  "/employeeDetails/save": {
    "module": "Employee Master Data",
    "team": "Employee Master"
  },
  "/employeeDetails/getTransferOrPromotionDetails": {
    "module": "Employee Master Data",
    "team": "Employee Master"
  },
  "/employeeDetails/getEmployeeDetails": {
    "module": "Employee Master Data",
    "team": "Employee Master"
  },
  "/employeeDetails/delete": {
    "module": "Employee Master Data",
    "team": "Employee Master"
  },
  "/designation/update": {
    "module": "Designations",
    "team": "Org Structure"
  },
  "/designation/save": {
    "module": "Designations",
    "team": "Org Structure"
  },
  "/designation/getDesignationByCompanyIdAndDepartmentId": {
    "module": "Designations",
    "team": "Org Structure"
  },
  "/designation/delete": {
    "module": "Designations",
    "team": "Org Structure"
  },
  "/designation/abbreviationAndCodeCreation": {
    "module": "Designations",
    "team": "Org Structure"
  },
  "/department/update": {
    "module": "Departments",
    "team": "Org Structure"
  },
  "/department/save": {
    "module": "Departments",
    "team": "Org Structure"
  },
  "/department/getDepartmentByCompanyId": {
    "module": "Departments",
    "team": "Org Structure"
  },
  "/department/delete": {
    "module": "Departments",
    "team": "Org Structure"
  },
  "/department/abbreviationAndCodeCreation": {
    "module": "Departments",
    "team": "Org Structure"
  },
  "/demo/createDemoRequest": {
    "module": "Product Demo Requests",
    "team": "Product & Licensing"
  },
  "/country/save": {
    "module": "Country & Address Reference Data",
    "team": "Reference Data"
  },
  "/attribute/update": {
    "module": "Generic Attributes (Base Hierarchy Levels)",
    "team": "Workplace Hierarchy"
  },
  "/attribute/save": {
    "module": "Generic Attributes (Base Hierarchy Levels)",
    "team": "Workplace Hierarchy"
  },
  "/attribute/getAttribute": {
    "module": "Generic Attributes (Base Hierarchy Levels)",
    "team": "Workplace Hierarchy"
  },
  "/attribute/getAttributeByCompanyId": {
    "module": "Generic Attributes (Base Hierarchy Levels)",
    "team": "Workplace Hierarchy"
  },
  "/attribute/delete": {
    "module": "Generic Attributes (Base Hierarchy Levels)",
    "team": "Workplace Hierarchy"
  },
  "/adminTierVariable/update": {
    "module": "Workplace Tier — Variables (Nodes)",
    "team": "Workplace Hierarchy"
  },
  "/adminTierVariable/save": {
    "module": "Workplace Tier — Variables (Nodes)",
    "team": "Workplace Hierarchy"
  },
  "/adminTierVariable/getAllReportingVariableHierarchy": {
    "module": "Workplace Tier — Variables (Nodes)",
    "team": "Workplace Hierarchy"
  },
  "/adminTierVariable/getAdminTierVariable": {
    "module": "Workplace Tier — Variables (Nodes)",
    "team": "Workplace Hierarchy"
  },
  "/adminTierVariable/delete": {
    "module": "Workplace Tier — Variables (Nodes)",
    "team": "Workplace Hierarchy"
  },
  "/adminTierAttribute/update": {
    "module": "Workplace Tier — Attributes (Levels)",
    "team": "Workplace Hierarchy"
  },
  "/adminTierAttribute/save": {
    "module": "Workplace Tier — Attributes (Levels)",
    "team": "Workplace Hierarchy"
  },
  "/adminTierAttribute/getAttribute": {
    "module": "Workplace Tier — Attributes (Levels)",
    "team": "Workplace Hierarchy"
  },
  "/adminTierAttribute/getAttributeByCompanyId": {
    "module": "Workplace Tier — Attributes (Levels)",
    "team": "Workplace Hierarchy"
  },
  "/adminTierAttribute/delete": {
    "module": "Workplace Tier — Attributes (Levels)",
    "team": "Workplace Hierarchy"
  },
  "/adminDetails/save": {
    "module": "Admin Details",
    "team": "Identity & Access"
  },
  "/workplaceHierarchy/getOrganization": {
    "module": "Workplace Hierarchy Links",
    "team": "Workplace Hierarchy"
  },
  "/userDetails/getAllUser/{companyId}": {
    "module": "Users, Onboarding & Authentication",
    "team": "Identity & Access"
  },
  "/project/fetchAllProject": {
    "module": "Project Catalogue",
    "team": "Product & Licensing"
  },
  "/productPurchase/getPurchaseProductByCompanyId": {
    "module": "Product Subscriptions",
    "team": "Product & Licensing"
  },
  "/productMaster/productList/{companyId}": {
    "module": "Product Catalogue",
    "team": "Product & Licensing"
  },
  "/holiday/getHoliday": {
    "module": "Holiday Calendar",
    "team": "Company Administration"
  },
  "/demo/fetchDemoRequest": {
    "module": "Product Demo Requests",
    "team": "Product & Licensing"
  },
  "/country/getAddressUsingPincodeAndCountry/{pincode}/{country}": {
    "module": "Country & Address Reference Data",
    "team": "Reference Data"
  },
  "/country/getAddressUsingPincode/{pincode}": {
    "module": "Country & Address Reference Data",
    "team": "Reference Data"
  },
  "/country/countryList": {
    "module": "Country & Address Reference Data",
    "team": "Reference Data"
  },
  "/adminTierVariable/getAllVariable": {
    "module": "Workplace Tier — Variables (Nodes)",
    "team": "Workplace Hierarchy"
  },
  "/": {
    "module": "admin-module-application",
    "team": "Platform Infrastructure"
  },
  "/userDetails/delete/{id}": {
    "module": "Users, Onboarding & Authentication",
    "team": "Identity & Access"
  }
};
