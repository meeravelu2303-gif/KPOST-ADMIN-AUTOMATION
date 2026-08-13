import { APIRequestContext } from '@playwright/test';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.config';
import { recordAuthStrategy } from '../utils/bugTracker';

export type AuthStrategy = 'static-token' | 'minted-jwt' | 'unauthenticated';

export interface AuthSession {
  /** A token the backend's auth filter accepted (did not 401), or null. */
  token: string | null;
  /** The identity behind `token` — needed for tenant-scope / ownership assertions. */
  kpostID: string | null;
  companyID: string | null;
  strategy: AuthStrategy;
  /** Ordered log of what was tried and why it failed. Surfaced instead of a silent skip. */
  diagnostics: string[];
}

/**
 * A protected route was exercised without a session. Tests throw this so the failure reads
 * as "could not authenticate", never as "the endpoint is broken".
 */
export class AuthenticationUnavailableError extends Error {
  constructor(session: AuthSession) {
    super(
      [
        'No authenticated session could be established, so this assertion could not be evaluated.',
        'Resolution: set QA_AUTH_TOKEN in .env to a valid access token, or set ADMIN_JWT_SECRET',
        '(and QA_KPOST_ID / QA_COMPANY_ID) to the values this environment signs its tokens with.',
        '',
        'Authentication attempts:',
        ...session.diagnostics.map((line) => `  - ${line}`),
      ].join('\n')
    );
    this.name = 'AuthenticationUnavailableError';
  }
}

function snippet(value: string, max = 180): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
}

/**
 * Confirms the backend's authentication filter accepts a token, rather than trusting that we
 * built it correctly.
 *
 * The filter runs only when an `Authorization: Bearer` header is present: a valid token
 * passes through to the endpoint (any non-401 status), while a wrong-secret, malformed or
 * expired token is answered 401 with "Invalid token" / "Token expired". So "not 401" is the
 * discriminator for a token this server will actually honour.
 *
 * `department/getDepartmentByCompanyId` is a cheap, read-only, tenant-scoped probe.
 */
async function tokenAccepted(
  context: APIRequestContext,
  token: string
): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await context.post('/department/getDepartmentByCompanyId', {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      data: { companyId: env.qaCompanyId },
    });
    const status = response.status();
    const detail = `probe getDepartmentByCompanyId -> HTTP ${status} :: ${snippet(await response.text())}`;
    return { ok: status !== 401, detail };
  } catch (error) {
    return { ok: false, detail: `probe threw: ${(error as Error).message}` };
  }
}

/**
 * Mints a short-lived HS256 token the Admin auth filter can decode.
 *
 * **The secret is base64-decoded before signing, and that is not optional.** The backend's
 * `AuthenticationUtility` verifies with `Jwts.parser().setSigningKey(secretKey)` passing a
 * *String*, and jjwt interprets a String signing key as base64-encoded — it decodes it to the
 * raw HMAC key bytes. Signing here with the ASCII bytes of the same string therefore produces
 * a different key and the filter answers 401 "Invalid token".
 *
 * Verified against the live backend: the ASCII form is refused 401, the base64-decoded form is
 * accepted. This mattered more than it looks — a rejected mint drops the whole run to
 * unauthenticated, which shows up as *fewer* defects and reads like an improvement.
 */
function mintToken(): string {
  return jwt.sign({ companyID: env.qaCompanyId }, Buffer.from(env.adminJwtSecret, 'base64'), {
    algorithm: 'HS256',
    subject: env.qaKpostId,
    expiresIn: env.adminJwtTtlSeconds,
  });
}

/**
 * Establishes a session by trying, in order:
 *   1. QA_AUTH_TOKEN from .env (a real, already-issued token);
 *   2. a JWT minted locally from ADMIN_JWT_SECRET + QA_KPOST_ID / QA_COMPANY_ID.
 *
 * There is no credential-login route here: the Admin Module's `userDetails/login` returns
 * identity fields only and never a token, so there is nothing to extract. Every failure is
 * recorded so an unauthenticated run explains itself.
 */
export async function establishSession(context: APIRequestContext): Promise<AuthSession> {
  const diagnostics: string[] = [];

  // 1) Static token straight from the environment.
  if (env.authToken) {
    const probe = await tokenAccepted(context, env.authToken);
    if (probe.ok) {
      return {
        token: env.authToken,
        kpostID: env.qaKpostId || null,
        companyID: env.qaCompanyId || null,
        strategy: 'static-token',
        diagnostics: [`QA_AUTH_TOKEN accepted (${probe.detail})`],
      };
    }
    diagnostics.push(`QA_AUTH_TOKEN was set but rejected: ${probe.detail}`);
  } else {
    diagnostics.push('QA_AUTH_TOKEN not set');
  }

  // 2) Mint a token from the configured signing secret + identity.
  if (env.adminJwtSecret) {
    let minted: string;
    try {
      minted = mintToken();
    } catch (error) {
      diagnostics.push(`Minting a JWT threw: ${(error as Error).message}`);
      return { token: null, kpostID: null, companyID: null, strategy: 'unauthenticated', diagnostics };
    }

    const probe = await tokenAccepted(context, minted);
    if (probe.ok) {
      return {
        token: minted,
        kpostID: env.qaKpostId,
        companyID: env.qaCompanyId,
        strategy: 'minted-jwt',
        diagnostics: [
          `Minted HS256 token for sub="${env.qaKpostId}" companyID="${env.qaCompanyId}" and it was accepted (${probe.detail})`,
        ],
      };
    }
    diagnostics.push(
      `Minted token was rejected — ADMIN_JWT_SECRET likely does not match the server key: ${probe.detail}`
    );
  } else {
    diagnostics.push('ADMIN_JWT_SECRET not set — token minting skipped');
  }

  return { token: null, kpostID: null, companyID: null, strategy: 'unauthenticated', diagnostics };
}

const STRATEGY_SUMMARY: Record<AuthStrategy, string> = {
  'static-token': 'QA_AUTH_TOKEN (real issued token)',
  'minted-jwt': 'locally-minted HS256 JWT (ADMIN_JWT_SECRET)',
  unauthenticated: 'NONE — protected-route coverage could not run (see run log)',
};

let warned = false;

/** Prints the diagnostic block once per worker so the reason is visible in the run log. */
export function warnIfUnauthenticated(session: AuthSession): void {
  recordAuthStrategy(STRATEGY_SUMMARY[session.strategy]);
  if (session.token || warned || !env.verboseAuthDiagnostics) return;
  warned = true;

  console.warn(
    [
      '',
      '='.repeat(78),
      'WARNING: no authenticated session could be established.',
      'Protected-route assertions that need a real session will FAIL with an explicit',
      'AuthenticationUnavailableError rather than passing silently.',
      '',
      'Attempts:',
      ...session.diagnostics.map((line) => `  - ${line}`),
      '',
      'Fix: set QA_AUTH_TOKEN, or align ADMIN_JWT_SECRET with the server signing key.',
      '='.repeat(78),
      '',
    ].join('\n')
  );
}

/** Returns the session token or throws a diagnostic-rich error. */
export function requireToken(session: AuthSession): string {
  if (!session.token) {
    throw new AuthenticationUnavailableError(session);
  }
  return session.token;
}
