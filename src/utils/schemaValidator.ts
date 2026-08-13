import { z } from 'zod';
import { expect } from '@playwright/test';
import { recordBug, recordEndpointExercised } from './bugTracker';

export interface ValidateContext {
  method: string;
  path: string;
  repro: string;
  body?: unknown;
  headers?: Record<string, string>;
  title?: string;
}

/**
 * Runtime contract assertion. Parses `data` against `schema`; on failure records a
 * structured finding (with the Zod issue list) and hard-fails the test.
 */
export function validateSchema<T extends z.ZodTypeAny>(
  data: unknown,
  schema: T,
  ctx: ValidateContext
): z.infer<T> {
  recordEndpointExercised(ctx.method, ctx.path);

  const result = schema.safeParse(data);
  if (result.success) {
    return result.data;
  }

  const issues = result.error.issues
    .map((issue) => `[${issue.path.join('.') || '<root>'}] ${issue.message}`)
    .join('; ');

  recordBug({
    title: ctx.title ?? 'Response body violates the documented contract',
    // Medium, not Low: a schema break is invisible to a human reading the JSON but fails a
    // generated or typed client at runtime, which is a real consumer outage.
    severity: 'Medium',
    module: '',
    method: ctx.method,
    endpointPath: ctx.path,
    classification: 'Schema Violation',
    description: `The response does not conform to the schema published in swagger.json: ${issues}. Generated clients and typed consumers will fail to deserialise this response.`,
    requestHeaders: ctx.headers ?? { 'Content-Type': 'application/json' },
    requestBody:
      ctx.body === undefined
        ? undefined
        : typeof ctx.body === 'string'
          ? ctx.body
          : JSON.stringify(ctx.body, null, 2),
    expected: 'Response body conforms to the documented contract schema',
    actual: `Zod validation failed: ${issues}. Body: ${JSON.stringify(data).slice(0, 400)}`,
    reproSnippet: ctx.repro,
  });

  expect(result.success, `Schema validation failed for ${ctx.method} ${ctx.path}: ${issues}`).toBe(
    true
  );
  throw new Error('unreachable');
}
