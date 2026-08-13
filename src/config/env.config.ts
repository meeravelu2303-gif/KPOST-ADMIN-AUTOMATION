import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be numeric, got "${raw}"`);
  }
  return parsed;
}

function optionalBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

export const env = {
  baseURL: required('BASE_URL', 'http://localhost:9595'),
  apiTimeout: optionalNumber('API_TIMEOUT', 30000),
  isCI: process.env.CI === 'true' || process.env.CI === '1',
  workers: optionalNumber('TEST_WORKERS', 4),

  /**
   * Authentication. Unlike the main KPOST platform, the Admin Module's `userDetails/login`
   * returns identity fields only and no token. The authentication filter instead validates
   * an HS256 JWT signed with `ADMIN_JWT_SECRET`, reading `sub` (kpostID) and `companyID`
   * from the claims. So `QA_AUTH_TOKEN` is the preferred real token; when absent, the
   * framework mints one from the secret + identity below.
   */
  authToken: optional('QA_AUTH_TOKEN', ''),
  /** Signing key for a minted token. Must match the server's key for the token to be honoured. */
  adminJwtSecret: optional('ADMIN_JWT_SECRET', 'kJuImTaErN0D9R0A7'),
  adminJwtTtlSeconds: optionalNumber('ADMIN_JWT_TTL_SECONDS', 3600),
  /** Identity baked into a minted token; needed for tenant-scoped and ownership assertions. */
  qaKpostId: optional('QA_KPOST_ID', 'qa.admin'),
  qaCompanyId: optional('QA_COMPANY_ID', '1001'),

  /** Real credentials, used only to exercise the login contract (login yields no session token). */
  qaUserId: optional('QA_USER_ID', ''),
  qaPassword: optional('QA_PASSWORD', ''),

  /**
   * userDetails/sendOTP dispatches a real SMS and is unauthenticated + unthrottled. Tests
   * that must clear an OTP gate use these mock codes; when the backend does not honour them
   * the affected assertions report the failure explicitly rather than passing silently.
   */
  mockOtp: optional('TEST_MOCK_OTP', '123456'),
  mockOtpFallback: optional('TEST_MOCK_OTP_FALLBACK', '000000'),

  /** Every OTP-dispatching test routes here so runs can't fan out SMS to real numbers. */
  testMobile: required('TEST_MOBILE', '9999999999'),
  testEmail: required('TEST_EMAIL', 'qa-test@example.com'),
  /** The Admin OTP schemas take `dialCode` as an integer (a quoted string yields 400). */
  testDialCode: optionalNumber('TEST_DIAL_CODE', 91),

  verboseAuthDiagnostics: optionalBool('VERBOSE_AUTH_DIAGNOSTICS', true),
} as const;

/** Candidate OTP values, in the order the auth helper will try them. */
export const MOCK_OTP_CANDIDATES: readonly string[] = Array.from(
  new Set([env.mockOtp, env.mockOtpFallback, '123456', '000000'])
);
