import { faker } from '@faker-js/faker';
import { env } from '../config/env.config';

/**
 * Contact details for any payload that can cause the backend to dispatch an SMS or email.
 *
 * A faker-generated 10-digit Indian mobile number is a **real subscriber's number**, and this
 * suite fires OTP/notification endpoints hundreds of times per run. Every builder that feeds
 * a dispatching endpoint must route through these helpers rather than faker directly.
 */
export function safeTestMobile(): string {
  return env.testMobile;
}

export function safeTestEmail(): string {
  return env.testEmail;
}

/**
 * A mobile number that is well-formed but provably undeliverable, for negative cases that
 * must not reach a real handset even if the backend ignores validation.
 */
export function unroutableMobile(): string {
  return '0000000000';
}

/** Random-but-safe identifiers for fields that never trigger a dispatch. */
export function qaIdentifier(prefix = 'qa'): string {
  return `${prefix}${faker.string.alphanumeric({ length: 8, casing: 'lower' })}`;
}

/** Marks records this suite creates so they are recognisable in a shared environment. */
export function qaLabel(subject: string): string {
  return `QA-AUTOMATION-${subject}-${faker.string.alphanumeric(6)}`;
}
