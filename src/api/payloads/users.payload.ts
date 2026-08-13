import { faker } from '@faker-js/faker';
import { env } from '../../config/env.config';
import { safeTestEmail, safeTestMobile, qaIdentifier } from '../../utils/safeTestData';
import { randomObjectId } from './departments.payload';

/**
 * Faker-backed request builders for the Users / Onboarding / Authentication tag.
 *
 * Builders take `Record<string, unknown>` overrides so fuzz tests can submit wrong-typed
 * values. Anything that can cause the backend to dispatch an SMS (sendOTP, validateOTP,
 * signUp) is PINNED to the safe TEST_MOBILE / TEST_EMAIL — never faker — because a random
 * 10-digit number is a real subscriber and these endpoints are unauthenticated + unthrottled.
 */

/** Re-exported so the users spec can mint a throwaway ObjectId without importing another tag. */
export { randomObjectId };

export interface SignupIdentity {
  userID: string;
  password: string;
  mobileNumber: string;
}

export function buildSignup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    country: 'India',
    userName: faker.person.fullName(),
    // Pinned — signUp verifies the mobile through OTP, so it must not reach a real handset.
    mobileNumber: safeTestMobile(),
    emailID: safeTestEmail(),
    userID: qaIdentifier('qa.admin'),
    password: faker.internet.password({ length: 12 }),
    requestType: 'signup',
    ...overrides,
  };
}

/**
 * login reads `userID` + `password` off the shared UserSignUp document. Defaults to the QA
 * credentials when the environment supplies them, and to an account that does not exist
 * otherwise — a wrong-credential probe is the safe default for a suite that must not lock
 * anybody out.
 */
export function buildLogin(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userID: env.qaUserId || qaIdentifier('no.such.user'),
    password: env.qaPassword || faker.internet.password({ length: 12 }),
    ...overrides,
  };
}

export function buildRegistration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    country: 'India',
    typeOfOrganization: 'Private Limited Organization',
    organizationName: faker.company.name(),
    userID: qaIdentifier('acme.admin'),
    password: faker.internet.password({ length: 12 }),
    userName: faker.person.fullName(),
    userDesignation: 'IT Administrator',
    contactNumber: safeTestMobile(),
    contactEmailID: safeTestEmail(),
    ...overrides,
  };
}

export function buildCheckAvailability(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { userID: qaIdentifier('qa.admin'), requestType: 'userID', ...overrides };
}

/**
 * sendOTP. `dialCode` is an INTEGER — the schema documents that a quoted string yields 400.
 * The destination is pinned to the safe number.
 */
export function buildSendOtp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dialCode: env.testDialCode,
    mobileNumber: safeTestMobile(),
    requestType: 'signup',
    ...overrides,
  };
}

export function buildValidateOtp(
  otp: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    dialCode: env.testDialCode,
    mobileNumber: safeTestMobile(),
    otp,
    type: 'signup',
    ...overrides,
  };
}

/** resetPassword takes a UserSignUp shape (userID + new password). */
export function buildResetPassword(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userID: qaIdentifier('qa.admin'),
    password: faker.internet.password({ length: 12 }),
    requestType: 'resetPassword',
    ...overrides,
  };
}

/** generateUserIdSuggestions derives candidates from userName (UserSignUp shape). */
export function buildUserIdSuggestionRequest(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { userName: faker.person.fullName(), country: 'India', ...overrides };
}

/**
 * UserDetails — used by save/update. NOTE companyId is an INTEGER here (unlike the string
 * companyId used across the rest of the module — a real cross-controller type inconsistency).
 * mobileNumber pinned to the safe destination.
 */
export function buildUserDetails(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    companyId: Number(env.qaCompanyId) || 1001,
    userID: qaIdentifier('meera.nair'),
    firstName: faker.person.firstName(),
    lastName: faker.person.lastName(),
    gender: 'Female',
    mobileNumber: safeTestMobile(),
    variableIds: [],
    reportingVariableIds: [],
    ...overrides,
  };
}

/**
 * An update targets an existing document, so it carries an `id`. Defaults to a freshly minted
 * ObjectId that matches nothing — `userDetails/update` writes wholesale, and pointing it at a
 * real row would rewrite a shared record.
 */
export function buildUserDetailsUpdate(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { id: randomObjectId(), ...buildUserDetails(), ...overrides };
}

/** createCommunicationId composes an ID from department/designation/role. */
export function buildCommunicationId(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { department: 'Engineering', designation: 'Software Engineer', role: 'Developer', ...overrides };
}
