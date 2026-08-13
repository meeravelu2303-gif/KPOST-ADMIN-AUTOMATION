import { test, expect } from '@playwright/test';
import { seedUser } from '../../src/fixtures/seedUser';

/**
 * Entry point for `npm run seed`.
 *
 * The seeding logic lives in `src/fixtures/seedUser.ts`; this file only drives it. Playwright
 * is used as the runner because it already transpiles TypeScript for this project — adding a
 * separate TS runner just to execute one script would be a dependency with no other purpose.
 *
 * This is a setup task, not a test of the API, so it lives in its own `seed` project, which
 * `playwright.config.ts` registers only when KPOST_RUN_SEED is set — a bare `npm test` never
 * runs it. It fails only when a token could not be obtained, and the console output explains
 * which step blocked it.
 */
test('establish a session and persist QA_AUTH_TOKEN into .env', async () => {
  test.setTimeout(120_000);

  const exitCode = await seedUser();

  expect(
    exitCode,
    'Seeding could not obtain a token the backend accepts — see the attempt log above. Align ADMIN_JWT_SECRET with this environment\'s signing key, or set QA_AUTH_TOKEN in .env manually.'
  ).toBe(0);
});
