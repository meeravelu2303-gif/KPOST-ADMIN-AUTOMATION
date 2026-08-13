#!/usr/bin/env node
/**
 * `npm run seed` — mints a fresh QA_AUTH_TOKEN and writes it into `.env`.
 *
 * This wrapper exists for one reason: the seed project is registered in
 * `playwright.config.ts` only when `KPOST_RUN_SEED` is set, and there is no portable way to
 * set an environment variable inside an npm script. `VAR=1 cmd` is bash-only and fails on
 * PowerShell; `set VAR=1 && cmd` is cmd-only and fails on bash. Adding `cross-env` would pull
 * a dependency into a repository whose whole point is auditing someone else's security, for
 * something Node can do in four lines.
 *
 * Run this when the token is stale — the digest header says `Authentication | NONE`, or a run
 * reports far fewer defects than usual. Both mean the suite ran unauthenticated, which looks
 * like an improvement and is the opposite.
 */
const { spawnSync } = require('child_process');

/*
 * `shell: true` is required, not incidental. Node 20 refuses to spawn a `.cmd` directly
 * (EINVAL) after the Windows command-injection hardening, and on Windows `npx` *is*
 * `npx.cmd`. Routing through the shell is the supported way to invoke it; the argument list
 * is a fixed literal here, so there is no injection surface to reintroduce.
 */
const result = spawnSync(
  'npx',
  ['playwright', 'test', '--project=seed', '--reporter=list'],
  {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, KPOST_RUN_SEED: '1' },
    cwd: __dirname + '/..',
  }
);

if (result.error) {
  console.error(`[seed] could not start Playwright: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(
    '\n[seed] Seeding failed. The step-by-step output above shows which call blocked it.\n' +
      '       On this module a token is minted locally rather than issued by a login route,\n' +
      "       so the usual cause is ADMIN_JWT_SECRET not matching the server's signing key\n" +
      '       (the filter answers 401 "Invalid token"), or the backend being unreachable.\n' +
      '       Set QA_AUTH_TOKEN in .env manually to proceed.'
  );
}

process.exit(result.status ?? 1);
