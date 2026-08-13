import { APIResponse, expect } from '@playwright/test';
import { z } from 'zod';
import { capturedRequestFor } from '../api/clients/base.client';
import { errorEnvelopeSchema } from '../api/schemas/envelope.schema';
import { validateSchema } from './schemaValidator';
import {
  FlawClassification,
  recordBug,
  recordEndpointExercised,
  Severity,
} from './bugTracker';

export interface EndpointMeta {
  method: string;
  path: string;
  /** Minimal Playwright code that reproduces the call. */
  repro: string;
  /** Request body sent, for the bug ledger's Steps to Reproduce. */
  body?: unknown;
  /** Headers sent, for the bug ledger. Defaults to the standard JSON + bearer pair. */
  headers?: Record<string, string>;
  title?: string;
  severity?: Severity;
}

const DEFAULT_HEADERS = { 'Content-Type': 'application/json' };

/**
 * The transport records what it actually sent, so the ledger reports the real request
 * rather than whatever a test remembered to pass through. Explicit `meta` values still win,
 * for the rare case where a test wants to describe the call differently.
 */
function headersOf(meta: EndpointMeta, response?: APIResponse): Record<string, string> {
  if (meta.headers) return meta.headers;
  const captured = response ? capturedRequestFor(response) : undefined;
  return captured?.headers ?? DEFAULT_HEADERS;
}

function bodyOf(meta: EndpointMeta, response?: APIResponse): string | undefined {
  if (meta.body !== undefined) {
    try {
      return typeof meta.body === 'string' ? meta.body : JSON.stringify(meta.body, null, 2);
    } catch {
      return String(meta.body);
    }
  }
  return response ? capturedRequestFor(response)?.body : undefined;
}

function truncate(value: string, max = 400): string {
  return value.length <= max ? value : `${value.slice(0, max)}…<truncated>`;
}

/** Body text plus a best-effort JSON parse — many endpoints return bare strings. */
export async function readBody(
  response: APIResponse
): Promise<{ text: string; json: Record<string, unknown> | null }> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    return {
      text,
      json: parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null,
    };
  } catch {
    return { text, json: null };
  }
}

interface FileBug {
  meta: EndpointMeta;
  title: string;
  severity: Severity;
  classification: FlawClassification;
  description: string;
  expected: string;
  actual: string;
  /** The response the finding came from — supplies the real request for reproduction. */
  response?: APIResponse;
}

function file(bug: FileBug): string {
  return recordBug({
    title: bug.title,
    severity: bug.severity,
    module: '',
    method: bug.meta.method,
    endpointPath: bug.meta.path,
    classification: bug.classification,
    description: bug.description,
    requestHeaders: headersOf(bug.meta, bug.response),
    requestBody: bodyOf(bug.meta, bug.response),
    expected: bug.expected,
    actual: bug.actual,
    reproSnippet: bug.meta.repro,
  });
}

/**
 * Standard status assertion. On mismatch, records a finding before failing so the reporter
 * output and the durable ledger stay in sync.
 */
export async function assertStatus(
  response: APIResponse,
  expectedStatuses: number[],
  meta: EndpointMeta
): Promise<void> {
  recordEndpointExercised(meta.method, meta.path);
  const actual = response.status();
  if (expectedStatuses.includes(actual)) return;

  const { text } = await readBody(response);
  /*
   * A 5xx where a 4xx was required is a server fault and stays Critical. A merely *wrong*
   * status — 400 instead of 401, 200 instead of 404 — misleads the caller but corrupts
   * nothing, which is what the Medium band is for. Grading these Major alongside accepted
   * bad input made the two indistinguishable in the report.
   */
  const severity: Severity = meta.severity ?? (actual >= 500 ? 'Critical' : 'Medium');

  file({
    meta,
    response,
    title: meta.title ?? `Returns HTTP ${actual} where ${expectedStatuses.join('/')} is required`,
    severity,
    classification: actual >= 500 ? 'Unhandled NPE / Server Error' : 'Incorrect HTTP Status',
    description: `The endpoint answered HTTP ${actual}. The documented and REST-correct response for this request is ${expectedStatuses.join(' or ')}. Clients branching on the status code will take the wrong path.`,
    expected: `HTTP ${expectedStatuses.join(' or ')}`,
    actual: `HTTP ${actual} — body: ${truncate(text)}`,
  });

  expect(
    expectedStatuses,
    `Expected status [${expectedStatuses.join(', ')}] on ${meta.method} ${meta.path} but got ${actual}. Body: ${truncate(text, 300)}`
  ).toContain(actual);
}

/**
 * The platform embeds its own `statusCode` in the response envelope. When that disagrees
 * with the transport status the client is actively misled — a 200 carrying `statusCode: 500`
 * makes every well-behaved HTTP client treat a server error as success.
 */
export async function assertStatusCodeParity(
  response: APIResponse,
  meta: EndpointMeta
): Promise<void> {
  recordEndpointExercised(meta.method, meta.path);
  const httpStatus = response.status();
  const { text, json } = await readBody(response);
  if (!json || typeof json.statusCode !== 'number') return;

  const bodyStatus = json.statusCode;
  if (bodyStatus === httpStatus) return;

  const masksError = httpStatus < 400 && bodyStatus >= 400;

  file({
    meta,
    response,
    title: `HTTP ${httpStatus} contradicts envelope statusCode ${bodyStatus}`,
    // Masking a failure behind HTTP 200 is Critical — monitoring never sees it. A parity
    // mismatch that does not hide a failure is a contract defect: Medium.
    severity: masksError ? 'Critical' : 'Medium',
    classification: 'Status Code Misreporting',
    description: masksError
      ? `The transport status (${httpStatus}) reports success while the response envelope reports ${bodyStatus}. Any client, proxy, retry policy, or monitoring rule that keys on the HTTP status will treat a server-side failure as a success, so the error is invisible in dashboards and never retried.`
      : `The transport status (${httpStatus}) and the envelope statusCode (${bodyStatus}) disagree, so the same outcome is described two different ways in one response.`,
    expected: `HTTP status to equal the envelope statusCode (${bodyStatus})`,
    actual: `HTTP ${httpStatus} with body statusCode ${bodyStatus} — body: ${truncate(text)}`,
  });

  expect(
    bodyStatus,
    `${meta.method} ${meta.path}: HTTP status ${httpStatus} disagrees with envelope statusCode ${bodyStatus}. A client trusting the HTTP status is misled. Body: ${truncate(text, 300)}`
  ).toBe(httpStatus);
}

const LEAK_PATTERNS: Array<{ label: string; pattern: RegExp; classification: FlawClassification }> = [
  {
    label: 'Java stack trace',
    pattern: /(at\s+(?:com|org|java|jakarta|javax)\.[\w.$]+\([^)]*\))/i,
    classification: 'Security/Information Disclosure',
  },
  {
    label: 'Java exception class',
    pattern: /\b(?:java|jakarta|javax|org\.springframework)\.[\w.]*Exception\b/i,
    classification: 'Security/Information Disclosure',
  },
  {
    label: 'NullPointerException',
    pattern: /NullPointerException/i,
    classification: 'Unhandled NPE / Server Error',
  },
  {
    label: 'SQL error',
    pattern: /\b(SQLException|SQLSyntaxError|ORA-\d{4,}|ER_\w+|syntax error at or near)\b/i,
    classification: 'Security/SQL Injection',
  },
  {
    label: 'SQL statement echo',
    pattern: /\b(select\s+.+\s+from\s+\w+|insert\s+into\s+\w+|update\s+\w+\s+set)\b/i,
    classification: 'Security/SQL Injection',
  },
  {
    label: 'Hibernate internals',
    pattern: /\borg\.hibernate\b|\bHibernateException\b/i,
    classification: 'Security/Information Disclosure',
  },
  {
    // KPOST streams avatars and attachments from S3 and, on failure, returns the SDK's raw
    // error verbatim — including the S3 Request ID and Extended Request ID, which identify
    // internal infrastructure to an unauthenticated caller.
    label: 'AWS/S3 SDK error',
    pattern: /\b(S3 error|Service:\s*Amazon\s*S3|S3 Extended Request ID|AmazonS3Exception|AmazonServiceException)\b/i,
    classification: 'Security/Information Disclosure',
  },
  {
    // The RedBus controller puts the partner client's exception message straight into
    // `errorvalue`, so an ordinary "ticket not found" hands the caller the upstream base URL,
    // the exact path, the query string it was called with, and the partner's HTTP status —
    // e.g. "GET http://api.seatseller.travel/ticket?tin=… returned 403 Forbidden". That maps
    // the integration's private surface for anyone holding any valid token, and the echoed
    // query string can carry the reference the caller supplied.
    label: 'Upstream integration endpoint disclosure',
    pattern:
      /\b(?:GET|POST|PUT|DELETE|PATCH)\s+https?:\/\/[^\s"]+\s+returned a response status of\b/i,
    classification: 'Security/Information Disclosure',
  },
  {
    label: 'Cloud provider request identifier',
    pattern: /\b(Request ID:\s*[A-Z0-9]{8,}|x-amz-request-id)\b/i,
    classification: 'Security/Information Disclosure',
  },
];

/**
 * Injection payloads must not come back as database errors or stack traces — that is both an
 * information leak and a strong signal the input reached the query layer unsanitized.
 */
export async function assertNoInternalLeak(
  response: APIResponse,
  meta: EndpointMeta,
  injectedValue: string
): Promise<void> {
  recordEndpointExercised(meta.method, meta.path);
  const { text } = await readBody(response);

  for (const { label, pattern, classification } of LEAK_PATTERNS) {
    if (!pattern.test(text)) continue;

    file({
      meta,
      response,
      title: `Injected input triggers an internals leak (${label})`,
      severity: 'Critical',
      classification,
      description: `Submitting \`${injectedValue}\` caused the response to disclose ${label}. This leaks server internals to an attacker and indicates the value reached the persistence layer without being parameterised or sanitised.`,
      expected: 'Malicious input rejected or sanitised, with a generic client error and no internals disclosed',
      actual: `Response matched ${label} — body: ${truncate(text)}`,
    });

    expect(
      text,
      `${meta.method} ${meta.path}: injecting "${injectedValue}" leaked ${label}. Body: ${truncate(text, 300)}`
    ).not.toMatch(pattern);
  }
}

/**
 * A reflected script payload returned verbatim is an XSS sink for any consumer that renders it.
 */
export async function assertNoReflectedScript(
  response: APIResponse,
  meta: EndpointMeta,
  injectedValue: string
): Promise<void> {
  recordEndpointExercised(meta.method, meta.path);
  const { text, json } = await readBody(response);
  const dangerous = /<script|onerror\s*=|onload\s*=|javascript:/i;

  if (!dangerous.test(text) || !text.includes(injectedValue)) return;

  /*
   * Distinguishing "persisted" from "echoed in an error" cannot rely on the HTTP status
   * alone: this API routinely answers HTTP 200 carrying `status: FAILURE`, so a 2xx check
   * classifies every rejected-and-echoed payload as stored XSS. The envelope has to agree
   * that the write succeeded before the word "persisted" is justified.
   */
  const envelopeStatus = json && typeof json.status === 'string' ? json.status.toUpperCase() : null;
  const envelopeCode = json && typeof json.statusCode === 'number' ? json.statusCode : null;
  const succeeded =
    response.status() >= 200 &&
    response.status() < 300 &&
    envelopeStatus !== 'FAILURE' &&
    envelopeStatus !== 'ERROR' &&
    (envelopeCode === null || envelopeCode < 400);

  /*
   * Severity turns on whether a browser would actually run it. Script reflected into a
   * correctly-typed `application/json` body is inert on arrival — it only becomes live if a
   * client renders the field as HTML, which is a real but conditional risk. Reflected into
   * `text/html`, or persisted for later display, it executes.
   */
  const contentType = response.headers()['content-type'] ?? '';
  const rendersAsHtml = /text\/html/i.test(contentType);

  file({
    meta,
    response,
    title: succeeded
      ? 'Script payload accepted and persisted unescaped (stored XSS)'
      : rendersAsHtml
        ? 'Script payload reflected unescaped into an HTML response (reflected XSS)'
        : 'Script payload echoed unescaped in an error message',
    severity: succeeded || rendersAsHtml ? 'Critical' : 'Major',
    classification: 'Security/XSS',
    description: succeeded
      ? `The payload \`${injectedValue}\` was accepted with a success status and returned verbatim, indicating it was persisted without encoding. Any UI that later renders this record executes attacker-controlled script in the viewer's session.`
      : rendersAsHtml
        ? `The payload \`${injectedValue}\` was echoed back unencoded in a text/html response, so a browser executes it directly.`
        : `The payload \`${injectedValue}\` was echoed back verbatim inside an error message on a \`${contentType || 'unknown'}\` response. A browser will not execute it there, but the message is written for display: any client that renders the error text as HTML — a toast, a banner — runs attacker-controlled script. The input should be encoded or omitted from the message.`,
    expected: 'Input HTML-encoded or rejected before being stored or echoed',
    actual: `Raw payload returned — body: ${truncate(text)}`,
  });

  expect(
    text,
    `${meta.method} ${meta.path}: reflected unescaped script payload "${injectedValue}"`
  ).not.toContain(injectedValue);
}

/**
 * Invalid input must be refused, not silently accepted. Records the specific
 * "HTTP 200 on an error case" pattern the audit brief calls out.
 */
export async function assertRejectsInvalidInput(
  response: APIResponse,
  meta: EndpointMeta & { scenario: string },
  acceptableStatuses: number[] = [400, 422]
): Promise<void> {
  recordEndpointExercised(meta.method, meta.path);
  const httpStatus = response.status();
  if (acceptableStatuses.includes(httpStatus)) return;

  const { text, json } = await readBody(response);
  const bodyStatus = json && typeof json.statusCode === 'number' ? json.statusCode : null;
  /*
   * `statusCode` is absent from some envelopes — the RedBus tag answers
   * `{ status, value, errorcode, errorvalue }` with no numeric code at all. Reading only
   * `statusCode` there yields null, and "no code" must not be mistaken for "succeeded": the
   * word in `status` is the only signal those routes give, and it is routinely FAILURE on an
   * HTTP 200. Without this the helper reports every rejected-upstream call as silently
   * accepted, which is the difference between Critical and Major.
   */
  const envelopeStatus = json && typeof json.status === 'string' ? json.status.toUpperCase() : null;
  const envelopeSaysFailed = envelopeStatus === 'FAILURE' || envelopeStatus === 'ERROR';
  const silentlyAccepted =
    httpStatus >= 200 &&
    httpStatus < 300 &&
    !envelopeSaysFailed &&
    (bodyStatus === null || bodyStatus < 400);

  file({
    meta,
    response,
    title: `${meta.scenario} is not rejected with 400/422`,
    // Callers may downgrade explicitly. The default treats any 2xx as acceptance, which is
    // right for a write — an invalid body that returns 200 has persisted a corrupt row. On a
    // pure read, "200 with No Data" accepts nothing and creates nothing, so those sites pass
    // severity: 'Major' and the finding is graded as the status-code defect it actually is.
    severity: meta.severity ?? (silentlyAccepted ? 'Critical' : 'Medium'),
    classification: silentlyAccepted
      ? 'Input Validation Gap'
      : httpStatus >= 500
        ? 'Unhandled NPE / Server Error'
        : 'Incorrect HTTP Status',
    description: silentlyAccepted
      ? `Invalid input (${meta.scenario}) was ACCEPTED with HTTP ${httpStatus}. The request should have been refused; instead the API either silently defaulted the value or persisted an invalid record, so corrupt data enters the system with no error surfaced to the caller.`
      : `Invalid input (${meta.scenario}) was refused with HTTP ${httpStatus} instead of a 4xx client error. A ${httpStatus} tells the caller the server malfunctioned rather than that their request was wrong, which hides a user-correctable error and triggers pointless retries and alerts.`,
    expected: `HTTP ${acceptableStatuses.join(' or ')} (input validation failure)`,
    actual: silentlyAccepted
      ? `HTTP ${httpStatus} — invalid input accepted. Body: ${truncate(text)}`
      : `HTTP ${httpStatus}${bodyStatus !== null ? ` (envelope statusCode ${bodyStatus})` : ''} — body: ${truncate(text)}`,
  });

  expect(
    acceptableStatuses,
    `${meta.method} ${meta.path} [${meta.scenario}]: expected ${acceptableStatuses.join('/')} but got ${httpStatus}. Body: ${truncate(text, 300)}`
  ).toContain(httpStatus);
}

/**
 * Markers that an anonymous response actually handed back protected material, rather than
 * public reference data. Used to separate a true auth bypass from a spec/implementation
 * mismatch on a deliberately-public lookup.
 */
const SENSITIVE_RESPONSE_MARKERS =
  /"(mobileNumber|alternateMobileno|email|otherEmail|aadhaarNumber|panNumber|password|kmailPassword|accessCode|accessToken|refreshToken|dateOfBirth|presentAddress|permanentAddress)"\s*:\s*"[^"]{3,}"/i;

/**
 * A secured endpoint reached without a usable token must answer 401/403 — never 400
 * (which reads as "your payload was wrong") and never 200.
 */
export async function assertUnauthorized(
  response: APIResponse,
  meta: EndpointMeta
): Promise<void> {
  recordEndpointExercised(meta.method, meta.path);
  const httpStatus = response.status();
  if (httpStatus === 401 || httpStatus === 403) return;

  const { text } = await readBody(response);
  const served = httpStatus >= 200 && httpStatus < 300;
  // Serving anonymously only rises to Critical when protected material actually came back.
  // Many KPOST routes are registration-time lookups (name availability, language lists)
  // that must work before a token exists; grading those Critical would bury the real
  // bypasses in noise.
  const leakedData = served && SENSITIVE_RESPONSE_MARKERS.test(text);

  let title: string;
  let severity: Severity;
  let description: string;

  if (leakedData) {
    title = 'Unauthenticated caller received protected user data';
    severity = 'Critical';
    description =
      'The endpoint returned a success status, and personal or credential fields, to a caller presenting no valid token. This is an authentication bypass exposing protected data.';
  } else if (served) {
    title = 'Endpoint declared as secured serves anonymous callers';
    severity = 'Major';
    description =
      'swagger.json places this route under the global `bearerAuth` requirement, but it answered successfully with no Authorization header. The response did not contain personal data, so this is not an outright data breach; it is still a contract defect. Either the route is deliberately public and the spec must declare `security: []`, or the authentication filter is not applied to it. Left unresolved, the published contract cannot be trusted to describe which routes are protected.';
  } else {
    title = `Unauthenticated request answered ${httpStatus} instead of 401/403`;
    severity = 'Major';
    description = `An unauthenticated caller received HTTP ${httpStatus} rather than 401/403. Clients cannot distinguish "you are not signed in" from "your request was malformed", so token-refresh and re-login flows never trigger; a ${httpStatus} also hides genuine auth failures from security monitoring.`;
  }

  file({
    meta,
    response,
    title,
    severity,
    classification: 'Security/Access Control',
    description,
    expected: 'HTTP 401 Unauthorized or 403 Forbidden',
    actual: `HTTP ${httpStatus} — body: ${truncate(text)}`,
  });

  expect(
    [401, 403],
    `${meta.method} ${meta.path}: expected 401/403 without a valid token but got ${httpStatus}. Body: ${truncate(text, 300)}`
  ).toContain(httpStatus);
}

/**
 * Detects a success transport status carrying a failure payload.
 *
 * KPOST frequently answers HTTP 200 with `status: "FAILURE"`, `statusCode: 500`, or a raw
 * exception trace in the body. Every client, proxy, retry policy and monitoring rule keys on
 * the HTTP status, so these failures are invisible in dashboards and never retried.
 */
export async function assertNot200OKOnError(
  response: APIResponse,
  meta: EndpointMeta
): Promise<void> {
  recordEndpointExercised(meta.method, meta.path);
  const httpStatus = response.status();
  if (httpStatus < 200 || httpStatus >= 300) return;

  const { text, json } = await readBody(response);

  const bodyStatusCode = json && typeof json.statusCode === 'number' ? json.statusCode : null;
  const bodyStatus = json && typeof json.status === 'string' ? json.status.toUpperCase() : null;
  const failureWord = bodyStatus !== null && ['FAILURE', 'FAILED', 'ERROR'].includes(bodyStatus);
  const exceptionTrace = /NullPointerException|Exception|at\s+(?:com|org|java)\./i.test(text);

  const symptoms: string[] = [];
  if (bodyStatusCode !== null && bodyStatusCode >= 400) {
    symptoms.push(`envelope statusCode ${bodyStatusCode}`);
  }
  if (failureWord) symptoms.push(`envelope status "${bodyStatus}"`);
  if (exceptionTrace) symptoms.push('an exception trace in the body');
  if (symptoms.length === 0) return;

  file({
    meta,
    response,
    title: `HTTP ${httpStatus} returned with a failure payload (${symptoms.join(', ')})`,
    severity: exceptionTrace || (bodyStatusCode !== null && bodyStatusCode >= 500) ? 'Critical' : 'Major',
    classification: exceptionTrace ? 'Unhandled NPE / Server Error' : 'Status Code Misreporting',
    description: `The endpoint answered HTTP ${httpStatus} while the body reports failure (${symptoms.join(', ')}). Callers that branch on the HTTP status — every HTTP client library, load balancer health check, retry policy and alerting rule — will treat this error as a success. The failure is therefore silent: it is never retried and never appears in error dashboards.`,
    expected: `A 4xx or 5xx transport status matching the failure described in the body`,
    actual: `HTTP ${httpStatus} — body: ${truncate(text)}`,
  });

  expect(
    symptoms,
    `${meta.method} ${meta.path}: HTTP ${httpStatus} but the body reports failure (${symptoms.join(', ')}). Body: ${truncate(text, 300)}`
  ).toEqual([]);
}

/**
 * Asserts the response both carries an expected status and satisfies its Zod contract.
 * Pairs the transport check and the shape check so a finding records which one failed.
 *
 * The success schema is applied only to 2xx responses. A 4xx/5xx carries the platform's
 * error envelope (`{status, timestamp, message, debugMessage}`), which legitimately has no
 * `statusCode` or `data`; validating the success schema against it would report a schema
 * violation for every ordinary error response and bury real contract defects.
 */
export async function expectValidContract<T extends z.ZodTypeAny>(
  response: APIResponse,
  schema: T,
  meta: EndpointMeta,
  acceptableStatuses: number[] = [200, 201]
): Promise<z.infer<T> | null> {
  await assertStatus(response, acceptableStatuses, meta);

  const { json } = await readBody(response);
  if (json === null) {
    // A bare-string body is legitimate for several KPOST routes; the status assertion above
    // has already covered the transport contract, so there is nothing further to validate.
    return null;
  }

  const ctx = {
    method: meta.method,
    path: meta.path,
    repro: meta.repro,
    body: meta.body,
    headers: meta.headers,
  };

  const httpStatus = response.status();
  if (httpStatus < 200 || httpStatus >= 300) {
    validateSchema(json, errorEnvelopeSchema, {
      ...ctx,
      title: 'Error response does not match the platform error envelope',
    });
    return null;
  }

  return validateSchema(json, schema, ctx);
}

/** Records a business-rule violation discovered by a hand-written assertion. */
export async function reportBusinessLogicFlaw(
  response: APIResponse,
  meta: EndpointMeta & { scenario: string },
  classification: FlawClassification = 'Business Logic Flaw',
  severity: Severity = 'Critical'
): Promise<string> {
  recordEndpointExercised(meta.method, meta.path);
  const { text } = await readBody(response);

  return file({
    meta,
    response,
    title: meta.title ?? meta.scenario,
    severity,
    classification,
    description: meta.scenario,
    expected: 'The operation is refused and no state changes',
    actual: `HTTP ${response.status()} — body: ${truncate(text)}`,
  });
}
