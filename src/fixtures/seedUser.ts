import fs from 'fs';
import path from 'path';
import { request } from '@playwright/test';
import { env } from '../config/env.config';
import { establishSession } from './authSession';

/**
 * Seeding for the Admin Module: obtain a session token and persist it into `.env` as
 * `QA_AUTH_TOKEN`, so every later run starts from a token this backend has already accepted.
 *
 * This diverges from the main KPOST framework's seed, and the reason is the auth model. There,
 * seeding registers a throwaway user and logs in, because the login route issues an access
 * token. Here `userDetails/login` returns identity fields and **no token at all** — there is
 * nothing to extract — so the session comes from `establishSession()`, which mints an HS256
 * JWT from `ADMIN_JWT_SECRET` and proves the backend's filter accepts it before returning it.
 *
 * No user is registered. Registration on this module writes a real MongoDB row to a live
 * tenant and echoes the password back in clear text; there is no reason to create one when the
 * token that matters can be minted without it.
 */

const ENV_PATH = path.resolve(__dirname, '../../.env');

/**
 * Writes `QA_AUTH_TOKEN` into `.env`, replacing any existing value and leaving every other
 * line untouched. `.env` is gitignored, so the token never reaches version control.
 */
function persistToken(token: string): void {
  const line = `QA_AUTH_TOKEN=${token}`;

  let contents = '';
  if (fs.existsSync(ENV_PATH)) {
    contents = fs.readFileSync(ENV_PATH, 'utf-8');
  }

  const updated = /^QA_AUTH_TOKEN=.*$/m.test(contents)
    ? contents.replace(/^QA_AUTH_TOKEN=.*$/m, line)
    : `${contents.replace(/\s*$/, '')}\n${line}\n`;

  fs.writeFileSync(ENV_PATH, updated, 'utf-8');
}

/** Returns a process-style exit code: 0 when `.env` now holds a token the backend accepted. */
export async function seedUser(): Promise<number> {
  const api = await request.newContext({ baseURL: env.baseURL });

  try {
    const session = await establishSession(api);

    console.log('\nAuthentication attempts:');
    for (const line of session.diagnostics) console.log(`  - ${line}`);

    if (!session.token) {
      console.log(
        [
          '',
          'No token could be established, so .env was left unchanged.',
          '',
          'On this module the token is minted locally rather than issued by the API, so the',
          'usual cause is ADMIN_JWT_SECRET not matching the key this environment signs with',
          '(the filter answers 401 "Invalid token"). Set either of these in .env and re-run:',
          '',
          '    ADMIN_JWT_SECRET=<the server signing key>   # preferred — mints on demand',
          '    QA_AUTH_TOKEN=<an already-issued token>',
          '',
        ].join('\n')
      );
      return 1;
    }

    persistToken(session.token);
    console.log(
      `\nQA_AUTH_TOKEN written to .env via ${session.strategy} ` +
        `(sub="${session.kpostID ?? 'unset'}" companyID="${session.companyID ?? 'unset'}").\n`
    );
    return 0;
  } finally {
    await api.dispose();
  }
}
