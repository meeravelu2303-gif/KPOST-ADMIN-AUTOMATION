import { APIResponse } from '@playwright/test';
import { BaseClient, RequestOptions } from './base.client';

/**
 * The routes this tag owns, in one place.
 *
 * Specs build their `META.path` from these rather than retyping the string, so a path and the
 * bug ticket that reports a defect on it can never drift apart. `audit-vectors.ts` groups
 * coverage by the `METHOD /path` signature in the describe title, which makes that string
 * load-bearing rather than decorative — these constants keep the two halves in step.
 *
 * The two templated routes keep their `{...}` braces exactly as api.json writes them, because
 * that is the signature the audit and the ownership registry both key on.
 */
export const USER_PATHS = {
  login: '/userDetails/login',
  registration: '/userDetails/registration',
  signUp: '/userDetails/signUp',
  save: '/userDetails/save',
  update: '/userDetails/update',
  delete: '/userDetails/delete/{id}',
  getAllUser: '/userDetails/getAllUser/{companyId}',
  checkAvailability: '/userDetails/checkAvailability',
  createCommunicationId: '/userDetails/createCommunicationId',
  generateUserIdSuggestions: '/userDetails/generateUserIdSuggestions',
  resetPassword: '/userDetails/resetPassword',
  sendOTP: '/userDetails/sendOTP',
  validateOTP: '/userDetails/validateOTP',
} as const;

/**
 * Thin client for the "Users, Onboarding & Authentication" tag (/userDetails/*).
 *
 * Every method is a one-line pass-through to BaseClient's transport so payloads reach the
 * wire verbatim — including deliberately malformed ones a fuzz test sends. No business
 * logic, no assertions: those live in the specs.
 */
export class UsersClient extends BaseClient {
  /** Public — the login call. Returns identity fields only, never a token. */
  login(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post('/userDetails/login', body, options);
  }

  signUp(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post('/userDetails/signUp', body, options);
  }

  registration(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post('/userDetails/registration', body, options);
  }

  /** Non-reserving uniqueness check — two concurrent callers can both pass. */
  checkAvailability(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post('/userDetails/checkAvailability', body, options);
  }

  generateUserIdSuggestions(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post('/userDetails/generateUserIdSuggestions', body, options);
  }

  /** Unauthenticated + unthrottled; dispatches a real SMS. Route only to a safe number. */
  sendOTP(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post('/userDetails/sendOTP', body, options);
  }

  /** No attempt counter / lockout — brute-forceable within the 10-minute window. */
  validateOTP(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post('/userDetails/validateOTP', body, options);
  }

  createCommunicationId(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post('/userDetails/createCommunicationId', body, options);
  }

  resetPassword(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post('/userDetails/resetPassword', body, options);
  }

  save(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post('/userDetails/save', body, options);
  }

  update(body: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    return this.post('/userDetails/update', body, options);
  }

  getAllUser(companyId: string | number, options: RequestOptions = {}): Promise<APIResponse> {
    return this.get(`/userDetails/getAllUser/${companyId}`, options);
  }

  /** Destructive: hard-deletes by ObjectId. Exercise on refusal / auth paths only. */
  deleteUser(id: string | number, options: RequestOptions = {}): Promise<APIResponse> {
    return this.fetchWithVerb('delete', `/userDetails/delete/${id}`, options);
  }

  /**
   * POSTs a raw string body to any route on this tag.
   *
   * Needed for the malformed-JSON cases: `post()` serialises whatever it is given, so a
   * deliberately truncated or corrupt document can only be produced by handing the transport
   * the exact bytes to send.
   */
  postRawTo(path: string, body: string, options: RequestOptions = {}): Promise<APIResponse> {
    return this.postRaw(path, body, options);
  }
}
