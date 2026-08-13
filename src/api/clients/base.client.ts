import { APIRequestContext, APIResponse } from '@playwright/test';
import { recordApiCall } from '../../../reporters/telemetry';

export interface RequestOptions {
  /** Bearer token to attach. Pass `null` to send no Authorization header at all. */
  token?: string | null;
  headers?: Record<string, string>;
  params?: Record<string, string | number | boolean>;
}

export interface CapturedRequest {
  body?: string;
  headers: Record<string, string>;
}

/**
 * What was actually sent, keyed by the response it produced.
 *
 * Playwright's `APIResponse` exposes no handle back to its request, but the bug ledger's
 * "Steps to Reproduce" needs the exact payload and headers. Capturing here means every
 * assertion gets them automatically instead of each of the ~1,500 call sites having to
 * pass the body through by hand. A WeakMap keeps this from retaining responses.
 */
const REQUEST_LOG = new WeakMap<APIResponse, CapturedRequest>();

export function capturedRequestFor(response: APIResponse): CapturedRequest | undefined {
  return REQUEST_LOG.get(response);
}

/** Records a request issued outside `BaseClient`'s own helpers (see GenericClient). */
export function recordRequest(
  response: APIResponse,
  headers: Record<string, string>,
  body: string | undefined
): void {
  REQUEST_LOG.set(response, { body, headers: safeHeaders(headers) });
}

/** Redacts credential headers so tokens never reach a committed report. */
function safeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = key.toLowerCase() === 'authorization' ? 'Bearer <redacted>' : value;
  }
  return out;
}

/**
 * Awaits the response, records what was sent, and hands the round trip to the TestBench
 * reporter's telemetry sink.
 *
 * The telemetry call is purely observational — it does not read, delay or alter the response,
 * and `recordApiCall` swallows its own failures — so a request behaves identically whether or
 * not the reporter is enabled. It lives here because a Playwright reporter sees test outcomes,
 * never HTTP traffic, and the report has to show a status code and a latency per test.
 */
async function capture(
  method: string,
  responsePromise: Promise<APIResponse>,
  headers: Record<string, string>,
  body: string | undefined
): Promise<APIResponse> {
  const startedAt = Date.now();
  const response = await responsePromise;
  REQUEST_LOG.set(response, { body, headers: safeHeaders(headers) });
  recordApiCall({
    method,
    url: response.url(),
    status: response.status(),
    latencyMs: Date.now() - startedAt,
    body,
  });
  return response;
}

function serialize(data: unknown): string | undefined {
  if (data === undefined) return undefined;
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

/**
 * Thin shared transport for every module client. `data` is sent as-is (including
 * deliberately malformed values), which is what lets fuzz tests drive the same code
 * path as happy-path tests.
 */
export abstract class BaseClient {
  constructor(protected readonly request: APIRequestContext) {}

  protected buildHeaders(options: RequestOptions = {}): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options.headers,
    };
    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }
    return headers;
  }

  protected post(path: string, data: unknown, options: RequestOptions = {}): Promise<APIResponse> {
    const headers = this.buildHeaders(options);
    return capture(
      'POST',
      this.request.post(path, { headers, params: options.params, data: data as never }),
      headers,
      serialize(data)
    );
  }

  /** POST a raw string body — used for malformed-JSON fuzzing. */
  protected postRaw(path: string, body: string, options: RequestOptions = {}): Promise<APIResponse> {
    const headers = this.buildHeaders(options);
    return capture(
      'POST',
      this.request.post(path, { headers, params: options.params, data: body }),
      headers,
      body
    );
  }

  protected postMultipart(
    path: string,
    multipart: Record<string, string | number | boolean | { name: string; mimeType: string; buffer: Buffer }>,
    options: RequestOptions = {}
  ): Promise<APIResponse> {
    const headers = this.buildHeaders(options);
    delete headers['Content-Type'];
    const summary = Object.entries(multipart)
      .map(([key, value]) =>
        value && typeof value === 'object' && 'buffer' in value
          ? `${key}: <file ${value.name} (${value.mimeType}, ${value.buffer.length} bytes)>`
          : `${key}: ${String(value)}`
      )
      .join('\n');
    return capture(
      'POST',
      this.request.post(path, { headers, params: options.params, multipart }),
      headers,
      `multipart/form-data:\n${summary}`
    );
  }

  /**
   * Issues an arbitrary HTTP verb against a path.
   *
   * Needed because several KPOST routes are declared with a bare Spring `@RequestMapping`
   * and therefore answer every method, not the one the spec implies. Proving that requires
   * sending DELETE/PATCH/HEAD at a route the client would otherwise only POST to.
   */
  protected fetchWithVerb(
    method: 'get' | 'delete' | 'put' | 'patch' | 'head' | 'options',
    path: string,
    options: RequestOptions = {}
  ): Promise<APIResponse> {
    const headers = this.buildHeaders(options);
    return capture(
      method.toUpperCase(),
      this.request.fetch(path, { method, headers, params: options.params }),
      headers,
      undefined
    );
  }

  protected get(path: string, options: RequestOptions = {}): Promise<APIResponse> {
    const headers = this.buildHeaders(options);
    return capture(
      'GET',
      this.request.get(path, { headers, params: options.params }),
      headers,
      undefined
    );
  }
}
