import { z } from 'zod';

/**
 * The Admin Module's uniform response envelope (`ApiResponseEnvelope` in api.json).
 *
 * EVERY endpoint returns HTTP 200 or 500 carrying this exact shape:
 *   { value, status: "SUCCESS" | "FAILURE", statusCode: 200 | 500, urlPath, error?, message? }
 *
 * Notable divergences from the main KPOST platform this framework is modelled on:
 *   - the payload lives in `value`, not `data`;
 *   - there is a top-level `error` string on failures (the caught exception message);
 *   - the module never emits 404 — a missing document is either 200 with `value: null`/`[]`
 *     or 500 with `status: FAILURE`. Each operation's description says which.
 *
 * Fields are optional and unknown fields pass through, so this is safe as a baseline
 * against any endpoint. `status` is a plain string, not an enum, because the live values
 * are UPPERCASE (`SUCCESS`/`FAILURE`) — the casing contract is asserted once by a dedicated
 * test (see DOCUMENTED_STATUS_VALUES), not on every call.
 */
export const looseEnvelopeSchema = z
  .object({
    value: z.unknown().optional(),
    status: z.string().optional(),
    statusCode: z.number().optional(),
    urlPath: z.string().optional(),
    error: z.string().nullish(),
    message: z.string().nullish(),
  })
  .passthrough();

export type LooseEnvelope = z.infer<typeof looseEnvelopeSchema>;

/**
 * Error envelope. The module reports handled failures as HTTP 200/500 with
 * `status: FAILURE`, `statusCode: 500` and the exception text in `error`.
 */
export const errorEnvelopeSchema = z
  .object({
    status: z.string().optional(),
    statusCode: z.number().optional(),
    urlPath: z.string().optional(),
    error: z.string().nullish(),
    message: z.string().nullish(),
  })
  .passthrough();

/**
 * Success envelope for endpoints that return a real `value` payload. `status` is typed as a
 * plain string (the live API emits UPPERCASE), and `statusCode`/`status`/`urlPath` are the
 * three fields the spec marks required.
 */
export const dataEnvelopeSchema = z
  .object({
    statusCode: z.number(),
    status: z.string(),
    urlPath: z.string(),
    value: z.unknown().optional(),
    message: z.string().nullish(),
    error: z.string().nullish(),
  })
  .passthrough();

/** Casing exactly as documented in api.json (the `status` enum). */
export const DOCUMENTED_STATUS_VALUES = ['SUCCESS', 'FAILURE'] as const;

/**
 * Strict variant used only by the dedicated envelope-contract test. The spec's enum is
 * already UPPERCASE here (unlike the main platform), so this asserts the live API keeps to
 * the two documented words and does not invent a third.
 */
export const strictDocumentedEnvelopeSchema = z
  .object({
    statusCode: z.number(),
    status: z.enum(DOCUMENTED_STATUS_VALUES),
    urlPath: z.string(),
    value: z.unknown().optional(),
    message: z.string().nullish(),
    error: z.string().nullish(),
  })
  .passthrough();
