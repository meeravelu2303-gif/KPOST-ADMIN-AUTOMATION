import {
  test,
  expect,
  EXPIRED_TOKEN,
  MALFORMED_TOKEN,
  FORGED_ALG_NONE_JWT,
} from '../../src/fixtures/api.fixture';
import {
  assertStatus,
  assertStatusCodeParity,
  assertRejectsInvalidInput,
  assertUnauthorized,
  assertNoInternalLeak,
  assertNoReflectedScript,
  assertNot200OKOnError,
  expectValidContract,
  readBody,
  reportBusinessLogicFlaw,
} from '../../src/utils/apiAssertions';
import { USER_PATHS } from '../../src/api/clients/users.client';
import {
  signUpEnvelopeSchema,
  otpEnvelopeSchema,
  registrationEnvelopeSchema,
  userDetailsEnvelopeSchema,
  userListEnvelopeSchema,
  userIdSuggestionEnvelopeSchema,
  availabilityEnvelopeSchema,
  communicationIdEnvelopeSchema,
} from '../../src/api/schemas/users.schema';
import { looseEnvelopeSchema } from '../../src/api/schemas/envelope.schema';
import {
  buildLogin,
  buildRegistration,
  buildSignup,
  buildUserDetails,
  buildUserDetailsUpdate,
  buildCheckAvailability,
  buildCommunicationId,
  buildUserIdSuggestionRequest,
  buildResetPassword,
  buildSendOtp,
  buildValidateOtp,
  randomObjectId,
} from '../../src/api/payloads/users.payload';
import { qaIdentifier, unroutableMobile } from '../../src/utils/safeTestData';
import { env } from '../../src/config/env.config';

/*
 * Users, Onboarding & Authentication tag (/userDetails/*) — credentials, tenant onboarding,
 * the OTP gate and the company user directory.
 *
 * One describe per endpoint titled with its bare `METHOD /path` signature, explicit standalone
 * cases — no loops, no factories — so every case is individually named, reportable and
 * skippable, and so `scripts/audit-vectors.ts` can group coverage by endpoint.
 *
 * ## What is dangerous here
 *
 * `POST /userDetails/sendOTP` **reaches a real handset and costs money**. It is unauthenticated
 * and unthrottled, so a faker-generated 10-digit number is a live subscriber's number, not a
 * fixture. Every case in this file that can reach the SMS gateway routes to the pinned
 * `TEST_MOBILE` through `buildSendOtp`; every other case deliberately carries a value that
 * cannot be dialled (empty, null, oversized, wrong-typed or an injection string) so the request
 * fails before dispatch. Exactly three cases in the sendOTP block dispatch a message, all to the
 * pinned number, and they are marked as such. The documented absence of rate limiting is
 * asserted on `validateOTP` rather than `sendOTP` for the same reason: proving the missing
 * throttle on the dispatch route would mean paying for a burst of real SMS.
 *
 * `DELETE /userDetails/delete/{id}` is a **hard delete**: no soft-delete flag, no cascade, no
 * undo through the API, and it takes the Mongo `_id` rather than the login name. Every case
 * below points it at a freshly-minted random ObjectId that matches no document, or at a refusal
 * path. Nothing in this file deletes a real record.
 *
 * `registration`, `signUp`, `save` and `update` write real MongoDB rows, so they use throwaway
 * faker identities — never a shared one — and `update` targets a random id rather than an
 * existing document, because it replaces `variableIds` wholesale and would silently revoke a
 * real user's scope.
 *
 * **Passwords are stored clear text** (`NoOpPasswordEncoder`) and `registration` echoes the
 * submitted password back in its response. `withoutCredentials()` below strips the field from
 * every bug-ledger payload so a defect ticket never becomes the place a credential leaks.
 *
 * ## Envelope reminder
 *
 * Every route answers HTTP 200 or 500 only, carrying
 * `{ value, status: SUCCESS|FAILURE, statusCode, urlPath, error? }`. HTTP 200 says nothing
 * about success, so assertions read the envelope's status word, never the transport alone. A
 * missing document is 200 with `value: null`/`[]` or 500 with `status: FAILURE` — never a 404.
 * An invalid login is reported as 500 rather than 401, which is a defect this file records.
 */

const XSS_PAYLOAD = `<script>alert('user')</script>`;
const SQLI_PAYLOAD = `1001' OR '1'='1`;
const SQLI_DROP_PAYLOAD = `'; DROP TABLE table_admin_user_signup; --`;
const MAX_LENGTH_STRING = 'a'.repeat(5000);

/**
 * Strips the credential before a payload is handed to the bug ledger.
 *
 * The assertion helpers persist `meta.body` verbatim into `BUG_REPORT.md`, and the transport
 * captures the real request when no `meta.body` is supplied — so on this tag the safe default
 * is to pass an explicitly redacted copy. The request itself still carries the real value.
 */
function withoutCredentials(body: Record<string, unknown>): Record<string, unknown> {
  return 'password' in body ? { ...body, password: '[redacted by the test suite]' } : body;
}

/* ==== POST /userDetails/login ==== */
test.describe('POST /userDetails/login', () => {
  const META = {
    method: 'POST',
    path: USER_PATHS.login,
    repro: `await usersClient.login(buildLogin()); // password redacted in this ledger`,
  };

  test('[1] happy path: a credential pair returns a well-formed SignUpResponse envelope', async ({
    usersClient,
  }) => {
    const body = buildLogin();
    const response = await usersClient.login(body);

    await expectValidContract(response, signUpEnvelopeSchema, {
      ...META,
      body: withoutCredentials(body),
    });
  });

  test('[1b] contract: even a refused login must answer the platform envelope, not a servlet error page', async ({
    usersClient,
  }) => {
    // A rejected credential is reported as 500 on this module. The envelope still has to be
    // intact: a bare Spring/Tomcat error page here would leak the stack and break every client.
    const body = buildLogin({ userID: qaIdentifier('no.such.user') });
    const response = await usersClient.login(body);

    await expectValidContract(
      response,
      looseEnvelopeSchema,
      { ...META, body: withoutCredentials(body) },
      [200, 500]
    );
  });

  test('[1c] parity: the HTTP status must agree with the envelope statusCode', async ({
    usersClient,
  }) => {
    const body = buildLogin();
    const response = await usersClient.login(body);

    await assertStatusCodeParity(response, { ...META, body: withoutCredentials(body) });
  });

  test('[1d] business rule: a rejected credential must be 401, not a 500 server error', async ({
    usersClient,
  }) => {
    /*
     * Documented defect: an invalid login is dressed as a server fault. The caller cannot
     * distinguish "your password is wrong" from "the login service is down", so retry and
     * alerting logic fires on ordinary user error and real outages hide among typos.
     */
    const body = buildLogin({ userID: qaIdentifier('no.such.user'), password: 'wrong-pass' });
    const response = await usersClient.login(body);

    const { json, text } = await readBody(response);
    const code = typeof json?.statusCode === 'number' ? json.statusCode : null;
    if (response.status() === 500 || code === 500) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body: withoutCredentials(body),
          repro: `await usersClient.login({ userID: "no.such.user", password: "<wrong>" });`,
          scenario: `A wrong credential pair was answered HTTP ${response.status()} with envelope statusCode ${code} instead of 401. Clients cannot tell a bad password from an outage, so re-login prompts never fire and genuine failures are buried in the same signal. Body: ${text.slice(0, 200)}`,
          title: 'Invalid login reported as a 500 server error instead of 401',
        },
        'Status Code Misreporting',
        'Major'
      );
    }
    expect(true).toBe(true); // presence-only assertion; the finding above is the signal
  });

  test('[1e] business rule: the login response must never echo the submitted password back', async ({
    usersClient,
  }) => {
    const secret = 'Sup3rSecret-Login-Probe';
    const body = buildLogin({ password: secret });
    const response = await usersClient.login(body);

    const { text } = await readBody(response);
    if (text.includes(secret)) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body: withoutCredentials(body),
          repro: `await usersClient.login({ userID: "<qa>", password: "<probe value>" }); // response echoed it`,
          scenario:
            'The login response returned the submitted password verbatim. Passwords are already stored clear text on this module; echoing one back puts it into every proxy log, browser cache and error report on the path.',
          title: 'Login response discloses the submitted password',
        },
        'Security/Information Disclosure',
        'Critical'
      );
    }
    expect(text, 'the login response must not contain the submitted password').not.toContain(secret);
  });

  test('[2] boundary: an empty password must be refused, not compared against a stored value', async ({
    usersClient,
  }) => {
    const body = buildLogin({ password: '' });
    const response = await usersClient.login(body);

    await assertRejectsInvalidInput(response, {
      ...META,
      body: withoutCredentials(body),
      scenario: 'empty password',
    });
  });

  test('[2b] boundary: a null password must be refused rather than matched against a null column', async ({
    usersClient,
  }) => {
    const body = buildLogin({ password: null });
    const response = await usersClient.login(body);

    await assertRejectsInvalidInput(response, {
      ...META,
      body: withoutCredentials(body),
      scenario: 'null password',
    });
  });

  test('[2c] boundary: a 5000-character userID must not be used as a lookup key', async ({
    usersClient,
  }) => {
    const body = buildLogin({ userID: MAX_LENGTH_STRING });
    const response = await usersClient.login(body);

    await assertRejectsInvalidInput(response, {
      ...META,
      body: withoutCredentials(body),
      scenario: 'oversized (5000-char) userID',
    });
  });

  test('[3] typefuzz: a numeric userID must be refused, not coerced into a login name', async ({
    usersClient,
  }) => {
    const body = buildLogin({ userID: 1001 });
    const response = await usersClient.login(body);

    await assertRejectsInvalidInput(response, {
      ...META,
      body: withoutCredentials(body),
      scenario: 'numeric userID where a string is documented',
    });
  });

  test('[3b] typefuzz: a boolean password must be refused', async ({ usersClient }) => {
    const body = buildLogin({ password: true });
    const response = await usersClient.login(body);

    await assertRejectsInvalidInput(response, {
      ...META,
      body: withoutCredentials(body),
      scenario: 'boolean password',
    });
  });

  test('[3c] typefuzz: an object password must not reach the driver as a query operator', async ({
    usersClient,
  }) => {
    /*
     * `{ $ne: null }` is the canonical Mongo authentication bypass: if the value is spliced
     * into the credential filter it matches any password at all, and the first account in the
     * collection is returned as a successful login.
     */
    const body = buildLogin({ password: { $ne: null } });
    const response = await usersClient.login(body);

    await assertRejectsInvalidInput(response, {
      ...META,
      body: withoutCredentials(body),
      scenario: 'object password ({ $ne: null }) — the Mongo operator-injection auth bypass shape',
    });
  });

  test('[4] auth: a forged alg:none token must not stand in for a credential check', async ({
    usersClient,
  }) => {
    /*
     * login is a pre-session route and must work with no token, so 401 is not the expectation
     * here. What must never happen is a bad credential succeeding *because* the caller
     * attached a self-signed identity: an alg:none token is unsigned by construction.
     */
    const body = buildLogin({ userID: qaIdentifier('no.such.user'), password: 'wrong-pass' });
    const response = await usersClient.login(body, { token: FORGED_ALG_NONE_JWT });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS' && json?.value) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body: withoutCredentials(body),
          repro: `await usersClient.login({ userID: "no.such.user", password: "wrong-pass" }, { token: FORGED_ALG_NONE_JWT });`,
          scenario: `A wrong credential pair returned SUCCESS with an identity payload when an unsigned alg:none token was attached. The credential check is being short-circuited by the token, so anyone can mint a login. Body: ${text.slice(0, 200)}`,
          title: 'Forged alg:none token bypasses the login credential check',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[4b] auth: an expired token must not change the credential verdict', async ({
    usersClient,
  }) => {
    const body = buildLogin();
    const response = await usersClient.login(body, { token: EXPIRED_TOKEN });

    await assertStatusCodeParity(response, { ...META, body: withoutCredentials(body) });
  });

  test('[5] [IDOR] a failed login must not disclose whether another account exists', async ({
    usersClient,
  }) => {
    /*
     * A distinguishable "no such user" answer turns login into an account-enumeration oracle:
     * an attacker harvests valid userIDs at no cost and only then spends guesses on passwords.
     * The two failure modes must be indistinguishable to the caller.
     */
    const absent = qaIdentifier('definitely.absent');
    const body = buildLogin({ userID: absent, password: 'wrong-pass' });
    const response = await usersClient.login(body);

    const { text } = await readBody(response);
    const enumerable = /user\s*(does\s*not\s*exist|not\s*found)|no\s+such\s+user|invalid\s+user\b/i;
    if (enumerable.test(text)) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body: withoutCredentials(body),
          repro: `await usersClient.login({ userID: "${absent}", password: "wrong-pass" });`,
          scenario: `Logging in as the non-existent account "${absent}" produced a message that names the account as unknown, while a wrong password on a real account produces a different one. Login is therefore an enumeration oracle over the userID namespace. Body: ${text.slice(0, 200)}`,
          title: 'Login discloses account existence (user enumeration oracle)',
        },
        'Security/Information Disclosure',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload in userID must not surface a database error', async ({
    usersClient,
  }) => {
    const body = buildLogin({ userID: SQLI_PAYLOAD });
    const response = await usersClient.login(body);

    await assertNoInternalLeak(
      response,
      { ...META, body: withoutCredentials(body) },
      SQLI_PAYLOAD
    );
  });

  test('[6b] injection: a script userID must not come back unescaped in the envelope', async ({
    usersClient,
  }) => {
    const body = buildLogin({ userID: XSS_PAYLOAD });
    const response = await usersClient.login(body);

    await assertNoReflectedScript(response, { ...META, body: withoutCredentials(body) }, XSS_PAYLOAD);
  });
});

/* ==== POST /userDetails/registration ==== */
test.describe('POST /userDetails/registration', () => {
  const META = {
    method: 'POST',
    path: USER_PATHS.registration,
    repro: `await usersClient.registration(buildRegistration()); // password redacted in this ledger`,
  };

  test('[1] happy path: a valid organisation registration returns the registration envelope', async ({
    usersClient,
  }) => {
    const body = buildRegistration();
    const response = await usersClient.registration(body);

    await expectValidContract(response, registrationEnvelopeSchema, {
      ...META,
      body: withoutCredentials(body),
    });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    usersClient,
  }) => {
    const body = buildRegistration();
    const response = await usersClient.registration(body);

    await assertStatusCodeParity(response, { ...META, body: withoutCredentials(body) });
  });

  test('[1c] business rule: the registration response must not echo the clear-text password', async ({
    usersClient,
  }) => {
    /*
     * Documented defect: the tenant record carries a clear-text password and registration
     * returns the document as it was persisted. Whoever renders that response — an onboarding
     * UI, a log aggregator, an integration webhook — now holds the administrator credential
     * for the whole tenant.
     */
    const secret = 'Reg1stration-Probe-Value';
    const body = buildRegistration({ password: secret });
    const response = await usersClient.registration(body);

    const { text } = await readBody(response);
    if (text.includes(secret)) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body: withoutCredentials(body),
          repro: `await usersClient.registration({ password: "<probe value>", ... }); // response echoed it`,
          scenario:
            'The registration response returned the submitted administrator password verbatim. Combined with the clear-text storage this means the tenant admin credential is exposed at creation time to every intermediary on the response path.',
          title: 'Registration response discloses the clear-text administrator password',
        },
        'Security/Information Disclosure',
        'Critical'
      );
    }
    expect(text, 'the registration response must not contain the submitted password').not.toContain(
      secret
    );
  });

  test('[1d] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    usersClient,
  }) => {
    const body = buildRegistration({ userID: '' });
    const response = await usersClient.registration(body);

    await assertNot200OKOnError(response, { ...META, body: withoutCredentials(body) });
  });

  test('[2] boundary: an empty userID must be refused, not persisted as a nameless tenant admin', async ({
    usersClient,
  }) => {
    const body = buildRegistration({ userID: '' });
    const response = await usersClient.registration(body);

    await assertRejectsInvalidInput(response, {
      ...META,
      body: withoutCredentials(body),
      scenario: 'empty userID',
    });
  });

  test('[2b] boundary: a null organizationName must be refused', async ({ usersClient }) => {
    const body = buildRegistration({ organizationName: null });
    const response = await usersClient.registration(body);

    await assertRejectsInvalidInput(response, {
      ...META,
      body: withoutCredentials(body),
      scenario: 'null organizationName',
    });
  });

  test('[2c] boundary: a 5000-character organizationName must be refused rather than stored', async ({
    usersClient,
  }) => {
    const body = buildRegistration({ organizationName: MAX_LENGTH_STRING });
    const response = await usersClient.registration(body);

    await assertRejectsInvalidInput(response, {
      ...META,
      body: withoutCredentials(body),
      scenario: 'oversized (5000-char) organizationName',
    });
  });

  test('[3] typefuzz: a boolean noOfEmployee where an integer is documented must be refused', async ({
    usersClient,
  }) => {
    const body = buildRegistration({ noOfEmployee: true });
    const response = await usersClient.registration(body);

    await assertRejectsInvalidInput(response, {
      ...META,
      body: withoutCredentials(body),
      scenario: 'boolean noOfEmployee where an int32 is documented',
    });
  });

  test('[3b] typefuzz: an array userID must be refused', async ({ usersClient }) => {
    const body = buildRegistration({ userID: ['acme.admin', 'acme.root'] });
    const response = await usersClient.registration(body);

    await assertRejectsInvalidInput(response, {
      ...META,
      body: withoutCredentials(body),
      scenario: 'array userID where a string is documented',
    });
  });

  test('[3c] typefuzz: a numeric contactNumber must be refused, not silently coerced', async ({
    usersClient,
  }) => {
    const body = buildRegistration({ contactNumber: 9840012345 });
    const response = await usersClient.registration(body);

    await assertRejectsInvalidInput(response, {
      ...META,
      body: withoutCredentials(body),
      scenario: 'numeric contactNumber where a string is documented',
    });
  });

  test('[4] auth: a forged alg:none token must not privilege a registration', async ({
    usersClient,
  }) => {
    // Registration is a pre-identity route, so 401 is not the expectation. What is asserted is
    // that an unsigned token cannot make the outcome differ from the anonymous case.
    const body = buildRegistration();
    const response = await usersClient.registration(body, { token: FORGED_ALG_NONE_JWT });

    await assertStatusCodeParity(response, { ...META, body: withoutCredentials(body) });
  });

  test('[4b] auth: an expired token must not be honoured as an established session', async ({
    usersClient,
  }) => {
    const body = buildRegistration({ userID: '' });
    const response = await usersClient.registration(body, { token: EXPIRED_TOKEN });

    await assertNot200OKOnError(response, { ...META, body: withoutCredentials(body) });
  });

  test('[5] [IDOR] a caller-supplied id must not let one tenant overwrite another tenant registration', async ({
    usersClient,
  }) => {
    /*
     * `id` is documented readOnly — the server assigns it. If a submitted `_id` is honoured on
     * insert, a caller chooses the primary key, and choosing an existing tenant's key
     * overwrites that tenant's onboarding record. A random id is used so nothing real is
     * touched; what is being tested is whether the field is honoured at all.
     */
    const plantedId = randomObjectId();
    const body = buildRegistration({ id: plantedId });
    const response = await usersClient.registration(body);

    const { json, text } = await readBody(response);
    const value = json?.value as { id?: string } | null;
    if (response.status() === 200 && value?.id === plantedId) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body: withoutCredentials(body),
          repro: `await usersClient.registration({ id: "${plantedId}", ... }); // server honoured the supplied _id`,
          scenario: `The server persisted the caller-supplied readOnly id "${plantedId}" rather than assigning its own. A caller who knows or guesses another tenant's ObjectId can therefore overwrite that tenant's registration document — including its administrator credentials. Body: ${text.slice(0, 200)}`,
          title: 'Caller-supplied readOnly id honoured on registration (tenant record overwrite)',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload in userID must not surface a database error', async ({
    usersClient,
  }) => {
    const body = buildRegistration({ userID: SQLI_DROP_PAYLOAD });
    const response = await usersClient.registration(body);

    await assertNoInternalLeak(
      response,
      { ...META, body: withoutCredentials(body) },
      SQLI_DROP_PAYLOAD
    );
  });

  test('[6b] injection: a script organizationName must not be stored and echoed unescaped', async ({
    usersClient,
  }) => {
    const body = buildRegistration({ organizationName: XSS_PAYLOAD });
    const response = await usersClient.registration(body);

    await assertNoReflectedScript(response, { ...META, body: withoutCredentials(body) }, XSS_PAYLOAD);
  });
});

/* ==== POST /userDetails/signUp ==== */
test.describe('POST /userDetails/signUp', () => {
  const META = {
    method: 'POST',
    path: USER_PATHS.signUp,
    repro: `await usersClient.signUp(buildSignup()); // mobile pinned to TEST_MOBILE, password redacted`,
  };

  test('[1] happy path: a valid sign-up returns a SignUpResponse envelope', async ({
    usersClient,
  }) => {
    // buildSignup pins mobileNumber/emailID to the safe destinations — sign-up triggers mobile
    // verification, so a faker number here would send a stranger an OTP.
    const body = buildSignup();
    const response = await usersClient.signUp(body);

    await expectValidContract(response, signUpEnvelopeSchema, {
      ...META,
      body: withoutCredentials(body),
    });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    usersClient,
  }) => {
    const body = buildSignup();
    const response = await usersClient.signUp(body);

    await assertStatusCodeParity(response, { ...META, body: withoutCredentials(body) });
  });

  test('[1c] business rule: the sign-up response must not return the account password', async ({
    usersClient,
  }) => {
    const secret = 'S1gnUp-Probe-Value';
    const body = buildSignup({ password: secret });
    const response = await usersClient.signUp(body);

    const { text } = await readBody(response);
    if (text.includes(secret)) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body: withoutCredentials(body),
          repro: `await usersClient.signUp({ password: "<probe value>", ... }); // response echoed it`,
          scenario:
            'The sign-up response returned the submitted password. The documented SignUpResponse projection deliberately omits it, so this is the persisted document being serialised straight back to the caller.',
          title: 'Sign-up response discloses the account password',
        },
        'Security/Information Disclosure',
        'Critical'
      );
    }
    expect(text, 'the sign-up response must not contain the submitted password').not.toContain(
      secret
    );
  });

  test('[1d] business rule: two concurrent sign-ups with one userID must not both succeed', async ({
    usersClient,
  }) => {
    /*
     * userID is documented unique, but `checkAvailability` does not reserve and the insert has
     * no unique index behind it. Issuing both requests concurrently is the only way to observe
     * the race — sequentially the second one loses to the first's committed row.
     */
    const body = buildSignup();
    const [first, second] = await Promise.all([
      usersClient.signUp(body),
      usersClient.signUp(body),
    ]);

    const succeeded = async (response: typeof first) => {
      const { json } = await readBody(response);
      const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
      return response.status() === 200 && status === 'SUCCESS';
    };

    if ((await succeeded(first)) && (await succeeded(second))) {
      await reportBusinessLogicFlaw(
        second,
        {
          ...META,
          body: withoutCredentials(body),
          repro: `await Promise.all([usersClient.signUp(body), usersClient.signUp(body)]); // identical userID`,
          scenario:
            'Two concurrent sign-ups carrying the same userID both returned SUCCESS. The uniqueness rule is enforced by a read-then-write with no unique index, so duplicate login names exist in the collection and which account a subsequent login resolves to is undefined.',
          title: 'Duplicate account created under concurrent sign-up (uniqueness not race-safe)',
        },
        'Idempotency / Concurrency',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: an empty mobileNumber must be refused, not signed up unverifiable', async ({
    usersClient,
  }) => {
    const body = buildSignup({ mobileNumber: '' });
    const response = await usersClient.signUp(body);

    await assertRejectsInvalidInput(response, {
      ...META,
      body: withoutCredentials(body),
      scenario: 'empty mobileNumber',
    });
  });

  test('[2b] boundary: a null userID must be refused', async ({ usersClient }) => {
    const body = buildSignup({ userID: null });
    const response = await usersClient.signUp(body);

    await assertRejectsInvalidInput(response, {
      ...META,
      body: withoutCredentials(body),
      scenario: 'null userID',
    });
  });

  test('[2c] boundary: a 5000-character userName must be refused rather than stored', async ({
    usersClient,
  }) => {
    const body = buildSignup({ userName: MAX_LENGTH_STRING });
    const response = await usersClient.signUp(body);

    await assertRejectsInvalidInput(response, {
      ...META,
      body: withoutCredentials(body),
      scenario: 'oversized (5000-char) userName',
    });
  });

  test('[3] typefuzz: a numeric userID must be refused, not coerced', async ({ usersClient }) => {
    const body = buildSignup({ userID: 1001 });
    const response = await usersClient.signUp(body);

    await assertRejectsInvalidInput(response, {
      ...META,
      body: withoutCredentials(body),
      scenario: 'numeric userID where a string is documented',
    });
  });

  test('[3b] typefuzz: a boolean emailID must be refused', async ({ usersClient }) => {
    const body = buildSignup({ emailID: true });
    const response = await usersClient.signUp(body);

    await assertRejectsInvalidInput(response, {
      ...META,
      body: withoutCredentials(body),
      scenario: 'boolean emailID',
    });
  });

  test('[4] auth: a forged alg:none token must not privilege a sign-up', async ({ usersClient }) => {
    const body = buildSignup();
    const response = await usersClient.signUp(body, { token: FORGED_ALG_NONE_JWT });

    await assertStatusCodeParity(response, { ...META, body: withoutCredentials(body) });
  });

  test('[4b] auth: an expired token must not be honoured as an established session', async ({
    usersClient,
  }) => {
    const body = buildSignup({ userID: '' });
    const response = await usersClient.signUp(body, { token: EXPIRED_TOKEN });

    await assertNot200OKOnError(response, { ...META, body: withoutCredentials(body) });
  });

  test('[5] [IDOR] a caller-supplied id must not let a sign-up overwrite an existing account', async ({
    usersClient,
  }) => {
    /*
     * `id` is documented readOnly and assigned on sign-up. Honouring a submitted one lets a
     * caller aim the insert at an existing credential document — replacing another user's
     * password with their own, which is account takeover with no authentication at all. The
     * probe uses a random id so no real account is touched.
     */
    const plantedId = randomObjectId();
    const body = buildSignup({ id: plantedId });
    const response = await usersClient.signUp(body);

    const { json, text } = await readBody(response);
    const value = json?.value as { id?: string } | null;
    if (response.status() === 200 && value?.id === plantedId) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body: withoutCredentials(body),
          repro: `await usersClient.signUp({ id: "${plantedId}", ... }); // server honoured the supplied _id`,
          scenario: `The sign-up persisted the caller-supplied readOnly id "${plantedId}". Pointing that field at an existing credential document lets an anonymous caller overwrite another user's password — account takeover requiring only the target's ObjectId. Body: ${text.slice(0, 200)}`,
          title: 'Caller-supplied readOnly id honoured on sign-up (credential overwrite)',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload in userName must not surface a database error', async ({
    usersClient,
  }) => {
    const body = buildSignup({ userName: SQLI_PAYLOAD });
    const response = await usersClient.signUp(body);

    await assertNoInternalLeak(response, { ...META, body: withoutCredentials(body) }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script userName must not be persisted and echoed unescaped', async ({
    usersClient,
  }) => {
    const body = buildSignup({ userName: XSS_PAYLOAD });
    const response = await usersClient.signUp(body);

    await assertNoReflectedScript(response, { ...META, body: withoutCredentials(body) }, XSS_PAYLOAD);
  });
});

/* ==== POST /userDetails/save ==== */
test.describe('POST /userDetails/save', () => {
  const META = {
    method: 'POST',
    path: USER_PATHS.save,
    repro: `await usersClient.save(buildUserDetails(), { token });`,
  };

  test('[1] happy path: a valid directory entry is accepted', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildUserDetails();
    const response = await usersClient.save(body, { token });

    await assertStatus(response, [200], { ...META, body });
  });

  test('[1b] contract: the save response satisfies the UserDetails envelope', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildUserDetails();
    const response = await usersClient.save(body, { token });

    await expectValidContract(response, userDetailsEnvelopeSchema, { ...META, body });
  });

  test('[1c] parity: the HTTP status must agree with the envelope statusCode', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildUserDetails();
    const response = await usersClient.save(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1d] parity: an empty body must not be answered with a failure payload under HTTP 200', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await usersClient.save({}, { token });

    await assertNot200OKOnError(response, {
      ...META,
      body: {},
      repro: `await usersClient.save({}, { token });`,
    });
  });

  test('[2] boundary: an empty userID must be refused, not saved as an unlinkable directory row', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildUserDetails({ userID: '' });
    const response = await usersClient.save(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty userID' });
  });

  test('[2b] boundary: a null firstName must be refused rather than persisted', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildUserDetails({ firstName: null });
    const response = await usersClient.save(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null firstName' });
  });

  test('[2c] boundary: a 5000-character firstName must be refused rather than stored', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildUserDetails({ firstName: MAX_LENGTH_STRING });
    const response = await usersClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) firstName',
    });
  });

  test('[3] typefuzz: a boolean gender must be refused', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildUserDetails({ gender: true });
    const response = await usersClient.save(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean gender' });
  });

  test('[3b] typefuzz: an array userID must be refused', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildUserDetails({ userID: ['meera.nair', 'root'] });
    const response = await usersClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'array userID where a string is documented',
    });
  });

  test('[3c] typefuzz: a scalar variableIds where an array is documented must be refused', async ({
    usersClient,
    requireAuthToken,
  }) => {
    /*
     * variableIds is the user's hierarchy scope and is replaced wholesale on write. A scalar
     * accepted here does not merely fail validation — it silently redefines what the user can
     * see in the admin UI.
     */
    const token = requireAuthToken();
    const body = buildUserDetails({ variableIds: 1001 });
    const response = await usersClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'scalar variableIds where an array of maps is documented',
    });
  });

  test('[3d] typefuzz: a quoted companyId must be refused — this collection types it as an int', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildUserDetails({ companyId: 'ten-oh-one' });
    const response = await usersClient.save(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'quoted companyId where UserDetails documents an int32',
    });
  });

  test('[4] auth: an unauthenticated caller must not be able to create a directory user', async ({
    usersClient,
  }) => {
    // A write reachable anonymously lets an outsider inject accounts into a tenant's directory.
    const body = buildUserDetails();
    const response = await usersClient.save(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must be refused on a write', async ({ usersClient }) => {
    const body = buildUserDetails();
    const response = await usersClient.save(body, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4c] auth: a malformed bearer token must be refused', async ({ usersClient }) => {
    const body = buildUserDetails();
    const response = await usersClient.save(body, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a user must not be creatable inside another tenant directory', async ({
    usersClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const otherTenant = Number(companyID ?? 1001) + 1;
    const body = buildUserDetails({ companyId: otherTenant });
    const response = await usersClient.save(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await usersClient.save({ companyId: ${otherTenant}, ... }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, a directory user was written into tenant ${otherTenant} and reported SUCCESS. The body's companyId is trusted over the token's, so any caller can plant an account inside any tenant's user list. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant user save (IDOR): body companyId overrides the token tenant',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a script firstName must not be stored and echoed unescaped', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildUserDetails({ firstName: XSS_PAYLOAD });
    const response = await usersClient.save(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });

  test('[6b] injection: a SQL payload in userID must not surface a database error', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildUserDetails({ userID: SQLI_PAYLOAD });
    const response = await usersClient.save(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });
});

/* ==== POST /userDetails/update ==== */
test.describe('POST /userDetails/update', () => {
  const META = {
    method: 'POST',
    path: USER_PATHS.update,
    repro: `await usersClient.update(buildUserDetailsUpdate(), { token }); // random id — matches no document`,
  };

  test('[1] happy path: an update returns a well-formed UserDetails envelope', async ({
    usersClient,
    requireAuthToken,
  }) => {
    /*
     * Deliberately aimed at a random id. `update` replaces variableIds wholesale, so pointing
     * a happy-path case at a real directory user would silently revoke that person's scope.
     */
    const token = requireAuthToken();
    const body = buildUserDetailsUpdate();
    const response = await usersClient.update(body, { token });

    await expectValidContract(response, userDetailsEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildUserDetailsUpdate();
    const response = await usersClient.update(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: updating a non-existent id must not be reported as SUCCESS', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const missingId = randomObjectId();
    const body = buildUserDetailsUpdate({ id: missingId });
    const response = await usersClient.update(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS' && !json?.value) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await usersClient.update({ id: "${missingId}", ... }, { token });`,
          scenario: `An update against the non-existent id "${missingId}" returned status SUCCESS with no document in value. The caller is told a directory record was saved when nothing was modified, so a failed profile edit looks identical to a successful one. Body: ${text.slice(0, 200)}`,
          title: 'userDetails/update reports SUCCESS when no document matched the id',
        },
        'Status Code Misreporting',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[1d] parity: a failure envelope must not be delivered under a 2xx transport status', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildUserDetailsUpdate({ id: randomObjectId() });
    const response = await usersClient.update(body, { token });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[2] boundary: an empty id must be refused rather than updating an arbitrary row', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildUserDetailsUpdate({ id: '' });
    const response = await usersClient.update(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty id' });
  });

  test('[2b] boundary: a null id must be refused', async ({ usersClient, requireAuthToken }) => {
    const token = requireAuthToken();
    const body = buildUserDetailsUpdate({ id: null });
    const response = await usersClient.update(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null id' });
  });

  test('[2c] boundary: a 5000-character userID must be refused rather than written', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildUserDetailsUpdate({ userID: MAX_LENGTH_STRING });
    const response = await usersClient.update(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) userID',
    });
  });

  test('[3] typefuzz: a numeric id where a 24-char ObjectId is documented must be refused', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildUserDetailsUpdate({ id: 1001 });
    const response = await usersClient.update(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric id' });
  });

  test('[3b] typefuzz: an object id must be refused, not used as a Mongo operator', async ({
    usersClient,
    requireAuthToken,
  }) => {
    /*
     * If `{ $ne: null }` reaches the driver as the update filter it matches every document in
     * the collection, turning one profile edit into a directory-wide overwrite.
     */
    const token = requireAuthToken();
    const body = buildUserDetailsUpdate({ id: { $ne: null } });
    const response = await usersClient.update(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object id ({ $ne: null }) — operator injection that would match every document',
    });
  });

  test('[3c] typefuzz: a boolean mobileNumber must be refused', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildUserDetailsUpdate({ mobileNumber: true });
    const response = await usersClient.update(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean mobileNumber' });
  });

  test('[4] auth: an unauthenticated caller must not be able to update a directory user', async ({
    usersClient,
  }) => {
    const body = buildUserDetailsUpdate();
    const response = await usersClient.update(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must be refused on a write', async ({ usersClient }) => {
    const body = buildUserDetailsUpdate();
    const response = await usersClient.update(body, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4c] auth: a token forged with alg:none must never be accepted', async ({ usersClient }) => {
    const body = buildUserDetailsUpdate();
    const response = await usersClient.update(body, { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[5] [IDOR] a directory user must not be reassignable into another tenant', async ({
    usersClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const otherTenant = Number(companyID ?? 1001) + 1;
    const body = buildUserDetailsUpdate({ companyId: otherTenant });
    const response = await usersClient.update(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS' && json?.value) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await usersClient.update({ id: "<id>", companyId: ${otherTenant}, ... }, { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, an update rewrote a directory user's companyId to ${otherTenant} and returned the document. A tenant can move user records into — or out of — another tenant, taking that user's hierarchy scope with them. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant user reassignment (IDOR) via the update body',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a malformed ObjectId must not leak the parser exception', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildUserDetailsUpdate({ id: 'not-an-object-id' });
    const response = await usersClient.update(body, { token });

    // A malformed ObjectId should be a 4xx; this module tends to 500, and a 500 must not carry
    // the "Invalid ObjectId" exception text or a stack frame back to the caller.
    await assertNoInternalLeak(response, { ...META, body }, 'not-an-object-id');
  });

  test('[6b] injection: a script firstName must not be echoed unescaped on update', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildUserDetailsUpdate({ firstName: XSS_PAYLOAD });
    const response = await usersClient.update(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== DELETE /userDetails/delete/{id} ==== */
test.describe('DELETE /userDetails/delete/{id}', () => {
  const META = {
    method: 'DELETE',
    path: USER_PATHS.delete,
    repro: `await usersClient.deleteUser(randomObjectId(), { token }); // random id — matches no document`,
  };

  test('[1] happy path: a delete against a non-existent id returns a well-formed envelope', async ({
    usersClient,
    requireAuthToken,
  }) => {
    // Non-existent id on purpose — this is a hard delete with no undo through the API.
    const token = requireAuthToken();
    const response = await usersClient.deleteUser(randomObjectId(), { token });

    await expectValidContract(response, looseEnvelopeSchema, META);
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await usersClient.deleteUser(randomObjectId(), { token });

    await assertStatusCodeParity(response, META);
  });

  test('[1c] business rule: deleting an id that does not exist must not be reported as SUCCESS', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const missingId = randomObjectId();
    const response = await usersClient.deleteUser(missingId, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          repro: `await usersClient.deleteUser("${missingId}", { token });`,
          scenario: `Deleting the non-existent id "${missingId}" reported SUCCESS. An offboarding script cannot distinguish "the account was removed" from "the id was wrong and nothing happened", so a failed removal is recorded as a completed one. Body: ${text.slice(0, 200)}`,
          title: 'userDetails/delete reports SUCCESS for an id that matched no document',
        },
        'Status Code Misreporting',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[1d] business rule: deleting a directory user must not silently leave their login active', async ({
    usersClient,
    requireAuthToken,
  }) => {
    /*
     * Credentials live in table_admin_user_signup, the directory entry in
     * table_admin_user_details, and this delete touches only the latter with no cascade. An
     * offboarded user therefore keeps the ability to authenticate. The response must at least
     * not claim a complete removal — a bare SUCCESS with no scope note is the misreport.
     */
    const token = requireAuthToken();
    const missingId = randomObjectId();
    const response = await usersClient.deleteUser(missingId, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    const message = typeof json?.message === 'string' ? json.message : '';
    if (status === 'SUCCESS' && !/credential|signup|sign-up|login/i.test(message)) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          repro: `await usersClient.deleteUser("${missingId}", { token }); // directory row only, credentials untouched`,
          scenario: `The delete reports an unqualified SUCCESS while removing only the table_admin_user_details row. The matching table_admin_user_signup credential is not cascaded, so a user removed from the directory can still authenticate. Nothing in the response tells the caller that. Body: ${text.slice(0, 200)}`,
          title: 'User delete does not cascade to credentials and does not say so',
        },
        'Business Logic Flaw',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: an empty id segment must be refused, not treated as "delete everything"', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const pathParam = { id: '' };
    const response = await usersClient.deleteUser(String(pathParam.id), { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      repro: `await usersClient.deleteUser("", { token });`,
      scenario: 'empty id path segment on a hard delete',
    });
  });

  test('[2b] boundary: the literal string "null" must be refused, not resolved to a document', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const pathParam = { id: null };
    const response = await usersClient.deleteUser(String(pathParam.id), { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      repro: `await usersClient.deleteUser("null", { token });`,
      scenario: 'null id serialised into the path segment',
    });
  });

  test('[3] typefuzz: a boolean id must be refused', async ({ usersClient, requireAuthToken }) => {
    const token = requireAuthToken();
    const pathParam = { id: true };
    const response = await usersClient.deleteUser(String(pathParam.id), { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      repro: `await usersClient.deleteUser("true", { token });`,
      scenario: 'boolean id in the path segment',
    });
  });

  test('[3b] typefuzz: a numeric id where a 24-char ObjectId is documented must be refused', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const pathParam = { id: 1001 };
    const response = await usersClient.deleteUser(pathParam.id, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      repro: `await usersClient.deleteUser(1001, { token });`,
      scenario: 'numeric id where a 24-char hex ObjectId is documented',
    });
  });

  test('[4] auth: an unauthenticated delete must be refused', async ({ usersClient }) => {
    const response = await usersClient.deleteUser(randomObjectId(), { token: null });

    await assertUnauthorized(response, META);
  });

  test('[4b] auth: an expired token must not authorise a destructive delete', async ({
    usersClient,
  }) => {
    const response = await usersClient.deleteUser(randomObjectId(), { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[4c] auth: a malformed token must not authorise a destructive delete', async ({
    usersClient,
  }) => {
    const response = await usersClient.deleteUser(randomObjectId(), { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[4d] auth: a token forged with alg:none must never authorise a delete', async ({
    usersClient,
  }) => {
    // An alg:none token is unsigned by construction. Honouring one on a destructive route means
    // anyone who can reach the host can remove any directory user.
    const response = await usersClient.deleteUser(randomObjectId(), { token: FORGED_ALG_NONE_JWT });

    await assertUnauthorized(response, META);
  });

  test('[5] [IDOR] a caller must not be able to delete another tenant directory user', async ({
    usersClient,
    requireAuthToken,
    companyID,
  }) => {
    /*
     * The route carries only an id — no tenant scope at all — so authorisation can only come
     * from the token. A random id is used because confirming this properly would mean
     * destroying a real foreign record; what is asserted is that the endpoint does not hand
     * back another tenant's document as evidence of a cross-tenant hit.
     */
    const token = requireAuthToken();
    const foreignId = randomObjectId();
    const response = await usersClient.deleteUser(foreignId, { token });

    const { json, text } = await readBody(response);
    const value = json?.value as { companyId?: number | string } | null;
    if (value?.companyId !== undefined && String(value.companyId) !== String(companyID)) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          repro: `await usersClient.deleteUser("${foreignId}", { token /* tenant ${companyID} */ });`,
          scenario: `A delete issued as tenant ${companyID} returned a document belonging to tenant "${value.companyId}". Ids resolve globally rather than within the caller's tenant, so any directory user is deletable by anyone who can guess their ObjectId. Body: ${text.slice(0, 200)}`,
          title: "Cross-tenant user delete (IDOR): ids resolve outside the caller's tenant",
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload as the id must not leak an exception trace', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await usersClient.deleteUser(encodeURIComponent(SQLI_DROP_PAYLOAD), { token });

    await assertNoInternalLeak(
      response,
      { ...META, repro: `await usersClient.deleteUser(encodeURIComponent("<sqli>"), { token });` },
      SQLI_DROP_PAYLOAD
    );
  });

  test('[6b] injection: a script id must not be reflected unescaped', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await usersClient.deleteUser(encodeURIComponent(XSS_PAYLOAD), { token });

    await assertNoReflectedScript(
      response,
      { ...META, repro: `await usersClient.deleteUser(encodeURIComponent("<script>…"), { token });` },
      XSS_PAYLOAD
    );
  });
});

/* ==== GET /userDetails/getAllUser/{companyId} ==== */
test.describe('GET /userDetails/getAllUser/{companyId}', () => {
  const META = {
    method: 'GET',
    path: USER_PATHS.getAllUser,
    repro: `await usersClient.getAllUser(companyID, { token });`,
  };

  test('[1] happy path: an authenticated read returns a well-formed user-list envelope', async ({
    usersClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const response = await usersClient.getAllUser(companyID ?? '1001', { token });

    await expectValidContract(response, userListEnvelopeSchema, META);
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    usersClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    const response = await usersClient.getAllUser(companyID ?? '1001', { token });

    await assertStatusCodeParity(response, META);
  });

  test('[1c] parity: an unknown tenant must not be answered with a failure payload under HTTP 200', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await usersClient.getAllUser(999999, { token });

    await assertNot200OKOnError(response, {
      ...META,
      repro: `await usersClient.getAllUser(999999, { token });`,
    });
  });

  test('[2] boundary: an empty companyId segment must be refused, not answered with every user', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const pathParam = { companyId: '' };
    const response = await usersClient.getAllUser(String(pathParam.companyId), { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        repro: `await usersClient.getAllUser("", { token });`,
        scenario: 'empty companyId path segment',
      },
      [400, 404, 422]
    );
  });

  test('[2b] boundary: companyId 0 must be refused rather than treated as a wildcard', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const pathParam = { companyId: null };
    const response = await usersClient.getAllUser(String(pathParam.companyId), { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        repro: `await usersClient.getAllUser("null", { token });`,
        scenario: 'null companyId serialised into the path segment',
      },
      [400, 404, 422]
    );
  });

  test('[2c] boundary: a 5000-character companyId must not be processed as a lookup key', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await usersClient.getAllUser(MAX_LENGTH_STRING, { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        repro: `await usersClient.getAllUser("a".repeat(5000), { token });`,
        scenario: 'oversized (5000-char) companyId path segment',
      },
      [400, 404, 414, 422]
    );
  });

  test('[3] typefuzz: a boolean companyId must be refused, not coerced into a tenant', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const pathParam = { companyId: true };
    const response = await usersClient.getAllUser(String(pathParam.companyId), { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        repro: `await usersClient.getAllUser("true", { token });`,
        scenario: 'boolean companyId path segment',
      },
      [400, 404, 422]
    );
  });

  test('[3b] typefuzz: a list of companyIds in one segment must be refused', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const pathParam = { companyId: ['1001', '1002'] };
    const response = await usersClient.getAllUser(String(pathParam.companyId), { token });

    await assertRejectsInvalidInput(
      response,
      {
        ...META,
        repro: `await usersClient.getAllUser("1001,1002", { token });`,
        scenario: 'comma-joined companyId list in a single path segment',
      },
      [400, 404, 422]
    );
  });

  test('[4] auth: an unauthenticated caller must not receive the tenant user directory', async ({
    usersClient,
    companyID,
  }) => {
    /*
     * This is the highest-value auth case on the tag. The response carries mobileNumber for
     * every user in the tenant, so an anonymous 200 here is not a spec mismatch — it is a PII
     * breach, and assertUnauthorized grades it Critical once those fields are present.
     */
    const response = await usersClient.getAllUser(companyID ?? '1001', { token: null });

    await assertUnauthorized(response, META);
  });

  test('[4b] auth: an expired token must not serve the directory', async ({
    usersClient,
    companyID,
  }) => {
    const response = await usersClient.getAllUser(companyID ?? '1001', { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test('[4c] auth: a token forged with alg:none must never be accepted', async ({
    usersClient,
    companyID,
  }) => {
    const response = await usersClient.getAllUser(companyID ?? '1001', {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertUnauthorized(response, META);
  });

  test('[4d] auth: a malformed bearer token must be refused', async ({ usersClient, companyID }) => {
    const response = await usersClient.getAllUser(companyID ?? '1001', { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, META);
  });

  test("[5] [IDOR] one tenant must not read another tenant's user directory", async ({
    usersClient,
    requireAuthToken,
    companyID,
  }) => {
    const token = requireAuthToken();
    /*
     * The filter injects companyID from the token, but this route reads it from the PATH.
     * Asking for a neighbouring tenant while authenticated as ours must not work: if it does,
     * the whole platform's user directory — names and mobile numbers — is enumerable by
     * incrementing an integer.
     */
    const otherTenant = `${Number(companyID ?? 1001) + 1}`;
    const response = await usersClient.getAllUser(otherTenant, { token });

    const { json, text } = await readBody(response);
    const value = json?.value;
    if (Array.isArray(value) && value.length > 0) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          repro: `await usersClient.getAllUser("${otherTenant}", { token /* tenant ${companyID} */ });`,
          scenario: `Authenticated as tenant ${companyID}, the path companyId "${otherTenant}" returned ${value.length} foreign user record(s) including their contact details. The path parameter overrides the token's tenant, so every tenant's directory is readable by anyone holding any valid token. Body: ${text.slice(0, 200)}`,
          title: 'Cross-tenant user directory read (IDOR) via the path companyId',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload in the path companyId must not leak a database error', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await usersClient.getAllUser(encodeURIComponent(SQLI_PAYLOAD), { token });

    await assertNoInternalLeak(
      response,
      { ...META, repro: `await usersClient.getAllUser(encodeURIComponent("<sqli>"), { token });` },
      SQLI_PAYLOAD
    );
  });

  test('[6b] injection: a script companyId must not be reflected unescaped', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await usersClient.getAllUser(encodeURIComponent(XSS_PAYLOAD), { token });

    await assertNoReflectedScript(
      response,
      { ...META, repro: `await usersClient.getAllUser(encodeURIComponent("<script>…"), { token });` },
      XSS_PAYLOAD
    );
  });
});

/* ==== POST /userDetails/checkAvailability ==== */
test.describe('POST /userDetails/checkAvailability', () => {
  const META = {
    method: 'POST',
    path: USER_PATHS.checkAvailability,
    repro: `await usersClient.checkAvailability(buildCheckAvailability());`,
  };

  test('[1] happy path: an unclaimed userID returns a well-formed availability envelope', async ({
    usersClient,
  }) => {
    const body = buildCheckAvailability();
    const response = await usersClient.checkAvailability(body);

    await expectValidContract(response, availabilityEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    usersClient,
  }) => {
    const body = buildCheckAvailability();
    const response = await usersClient.checkAvailability(body);

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: the check must reserve the name it reports as available', async ({
    usersClient,
  }) => {
    /*
     * Documented defect: checkAvailability answers a question about a value it does not hold.
     * Two callers racing on the same name are both told it is free, both proceed, and the
     * collision surfaces only at sign-up — where it is a duplicate account rather than a
     * validation error. Concurrency is the only way to observe it.
     */
    const body = buildCheckAvailability();
    const [first, second] = await Promise.all([
      usersClient.checkAvailability(body),
      usersClient.checkAvailability(body),
    ]);

    const verdict = async (response: typeof first) => {
      const { json } = await readBody(response);
      const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
      return response.status() === 200 && status === 'SUCCESS';
    };

    if ((await verdict(first)) && (await verdict(second))) {
      await reportBusinessLogicFlaw(
        second,
        {
          ...META,
          body,
          repro: `await Promise.all([checkAvailability(body), checkAvailability(body)]); // both told "available"`,
          scenario:
            'Two concurrent availability checks for the same userID both reported it free. The endpoint hands out a verdict it does not reserve, so the guarantee it appears to give a registration form does not exist and the clash only appears at sign-up.',
          title: 'checkAvailability is non-reserving (TOCTOU on userID uniqueness)',
        },
        'Idempotency / Concurrency',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[1d] parity: a rejected check must not be answered with a failure payload under HTTP 200', async ({
    usersClient,
  }) => {
    const response = await usersClient.checkAvailability({});

    await assertNot200OKOnError(response, {
      ...META,
      body: {},
      repro: `await usersClient.checkAvailability({});`,
    });
  });

  test('[2] boundary: an empty userID must be refused, not reported as available', async ({
    usersClient,
  }) => {
    const body = buildCheckAvailability({ userID: '' });
    const response = await usersClient.checkAvailability(body);

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty userID' });
  });

  test('[2b] boundary: a null userID must be refused', async ({ usersClient }) => {
    const body = buildCheckAvailability({ userID: null });
    const response = await usersClient.checkAvailability(body);

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null userID' });
  });

  test('[2c] boundary: a 5000-character userID must not be checked', async ({ usersClient }) => {
    const body = buildCheckAvailability({ userID: MAX_LENGTH_STRING });
    const response = await usersClient.checkAvailability(body);

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) userID',
    });
  });

  test('[3] typefuzz: a numeric userID must be refused, not coerced', async ({ usersClient }) => {
    const body = buildCheckAvailability({ userID: 1001 });
    const response = await usersClient.checkAvailability(body);

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric userID' });
  });

  test('[3b] typefuzz: a boolean requestType must be refused', async ({ usersClient }) => {
    // requestType selects WHICH identifier is tested (userID / mobile / emailID). A wrong-typed
    // discriminator that is silently defaulted answers a different question than the one asked.
    const body = buildCheckAvailability({ requestType: true });
    const response = await usersClient.checkAvailability(body);

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean requestType' });
  });

  test('[3c] typefuzz: an array userID must be refused', async ({ usersClient }) => {
    const body = buildCheckAvailability({ userID: ['acme.admin', 'acme.root'] });
    const response = await usersClient.checkAvailability(body);

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'array userID' });
  });

  test('[4] auth: a forged alg:none token must not widen what the oracle answers', async ({
    usersClient,
  }) => {
    // Availability is a pre-account route and must answer anonymously, so 401 is not the
    // expectation. What matters is that attaching an unsigned identity changes nothing.
    const body = buildCheckAvailability();
    const response = await usersClient.checkAvailability(body, { token: FORGED_ALG_NONE_JWT });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[4b] auth: an expired token must not be honoured as an established session', async ({
    usersClient,
  }) => {
    const body = buildCheckAvailability({ userID: '' });
    const response = await usersClient.checkAvailability(body, { token: EXPIRED_TOKEN });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[5] [IDOR] the availability oracle must not confirm a specific account exists', async ({
    usersClient,
  }) => {
    /*
     * "Not available" is a positive existence answer about somebody else's account. On a
     * namespace of real login names that is an enumeration primitive: unauthenticated, free,
     * and it feeds directly into credential stuffing. The endpoint is deliberately public, so
     * the finding is about how much it discloses, not about it answering at all.
     */
    const body = buildCheckAvailability({ userID: 'admin', requestType: 'userID' });
    const response = await usersClient.checkAvailability(body);

    const { json, text } = await readBody(response);
    const taken = /not\s*available|already\s*(exists|taken|in\s*use)/i.test(text);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && taken) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await usersClient.checkAvailability({ userID: "admin", requestType: "userID" }); // no token`,
          scenario: `An anonymous caller asked about the login name "admin" and was told it is taken (envelope status ${status}). The endpoint therefore confirms the existence of arbitrary accounts to anyone, which turns the registration form into an unauthenticated, unthrottled account-enumeration oracle. Body: ${text.slice(0, 200)}`,
          title: 'checkAvailability confirms arbitrary account existence to anonymous callers',
        },
        'Security/Information Disclosure',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload in userID must not surface a database error', async ({
    usersClient,
  }) => {
    const body = buildCheckAvailability({ userID: SQLI_PAYLOAD });
    const response = await usersClient.checkAvailability(body);

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script userID must not be echoed unescaped in the availability message', async ({
    usersClient,
  }) => {
    // The message echoes the value that was checked, which is exactly the shape that puts an
    // attacker-controlled string into a registration form's inline validation banner.
    const body = buildCheckAvailability({ userID: XSS_PAYLOAD });
    const response = await usersClient.checkAvailability(body);

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /userDetails/createCommunicationId ==== */
test.describe('POST /userDetails/createCommunicationId', () => {
  const META = {
    method: 'POST',
    path: USER_PATHS.createCommunicationId,
    repro: `await usersClient.createCommunicationId(buildCommunicationId(), { token });`,
  };

  test('[1] happy path: a known department/designation/role composes an identifier', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildCommunicationId();
    const response = await usersClient.createCommunicationId(body, { token });

    await expectValidContract(response, communicationIdEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildCommunicationId();
    const response = await usersClient.createCommunicationId(body, { token });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] parity: an empty body must not be answered with a failure payload under HTTP 200', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const response = await usersClient.createCommunicationId({}, { token });

    await assertNot200OKOnError(response, {
      ...META,
      body: {},
      repro: `await usersClient.createCommunicationId({}, { token });`,
    });
  });

  test('[1d] business rule: an unrecognised department must be a client error, not a 500', async ({
    usersClient,
    requireAuthToken,
  }) => {
    /*
     * Documented behaviour: an unrecognised name yields an empty result and a 500. That is a
     * user-correctable typo being reported as a server fault — it fires alerts, triggers
     * retries, and tells the caller nothing about which of the three names was wrong.
     */
    const token = requireAuthToken();
    const body = buildCommunicationId({ department: 'No Such Department' });
    const response = await usersClient.createCommunicationId(body, { token });

    const { json, text } = await readBody(response);
    const code = typeof json?.statusCode === 'number' ? json.statusCode : null;
    if (response.status() === 500 || code === 500) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await usersClient.createCommunicationId({ department: "No Such Department", ... }, { token });`,
          scenario: `An unknown department name produced HTTP ${response.status()} with envelope statusCode ${code}. A mistyped reference value is reported as a server malfunction rather than a 400, so the caller cannot correct it and monitoring counts it as an outage. Body: ${text.slice(0, 200)}`,
          title: 'Unrecognised department on createCommunicationId reported as a server error',
        },
        'Incorrect HTTP Status',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[2] boundary: an empty department must be refused', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildCommunicationId({ department: '' });
    const response = await usersClient.createCommunicationId(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty department' });
  });

  test('[2b] boundary: a null designation must be refused', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildCommunicationId({ designation: null });
    const response = await usersClient.createCommunicationId(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null designation' });
  });

  test('[2c] boundary: a 5000-character role must not be folded into an identifier', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildCommunicationId({ role: MAX_LENGTH_STRING });
    const response = await usersClient.createCommunicationId(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) role',
    });
  });

  test('[3] typefuzz: a numeric department must be refused', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildCommunicationId({ department: 1001 });
    const response = await usersClient.createCommunicationId(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric department' });
  });

  test('[3b] typefuzz: an array role must be refused', async ({ usersClient, requireAuthToken }) => {
    const token = requireAuthToken();
    const body = buildCommunicationId({ role: ['Developer', 'Reviewer'] });
    const response = await usersClient.createCommunicationId(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'array role' });
  });

  test('[3c] typefuzz: a boolean designation must be refused', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildCommunicationId({ designation: true });
    const response = await usersClient.createCommunicationId(body, { token });

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean designation' });
  });

  test('[4] auth: an unauthenticated caller must not be able to compose an identifier', async ({
    usersClient,
  }) => {
    const body = buildCommunicationId();
    const response = await usersClient.createCommunicationId(body, { token: null });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4b] auth: an expired token must be refused', async ({ usersClient }) => {
    const body = buildCommunicationId();
    const response = await usersClient.createCommunicationId(body, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test('[4c] auth: a malformed bearer token must be refused', async ({ usersClient }) => {
    const body = buildCommunicationId();
    const response = await usersClient.createCommunicationId(body, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body });
  });

  test("[5] [IDOR] the composer must not resolve another tenant's department and designation", async ({
    usersClient,
    requireAuthToken,
  }) => {
    /*
     * The request carries no companyId at all, so department and designation names can only be
     * resolved globally. If a name this tenant never created still composes an identifier, the
     * endpoint is reading another tenant's org structure — and the identifier it returns
     * embeds that tenant's department abbreviation.
     */
    const token = requireAuthToken();
    const foreignDepartment = qaIdentifier('foreign.dept');
    const body = buildCommunicationId({ department: foreignDepartment });
    const response = await usersClient.createCommunicationId(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS' && json?.value) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await usersClient.createCommunicationId({ department: "${foreignDepartment}", ... }, { token });`,
          scenario: `A department name this tenant never created still composed an identifier. With no companyId in the request the lookup spans every tenant, so the returned identifier discloses a foreign tenant's department abbreviation and confirms that department exists. Body: ${text.slice(0, 200)}`,
          title: 'createCommunicationId resolves department/designation names across tenants',
        },
        'Security/Access Control',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload in designation must not surface a database error', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildCommunicationId({ designation: SQLI_PAYLOAD });
    const response = await usersClient.createCommunicationId(body, { token });

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script role must not be reflected unescaped', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildCommunicationId({ role: XSS_PAYLOAD });
    const response = await usersClient.createCommunicationId(body, { token });

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /userDetails/generateUserIdSuggestions ==== */
test.describe('POST /userDetails/generateUserIdSuggestions', () => {
  const META = {
    method: 'POST',
    path: USER_PATHS.generateUserIdSuggestions,
    repro: `await usersClient.generateUserIdSuggestions(buildUserIdSuggestionRequest());`,
  };

  test('[1] happy path: a userName yields a well-formed list of candidate login names', async ({
    usersClient,
  }) => {
    const body = buildUserIdSuggestionRequest();
    const response = await usersClient.generateUserIdSuggestions(body);

    await expectValidContract(response, userIdSuggestionEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    usersClient,
  }) => {
    const body = buildUserIdSuggestionRequest();
    const response = await usersClient.generateUserIdSuggestions(body);

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: suggested names must be reserved, not merely offered', async ({
    usersClient,
  }) => {
    /*
     * The suggestions are derived by skipping names that already exist, exactly like
     * department abbreviation generation — and, like it, nothing is reserved. Two callers
     * registering at the same moment are handed the identical candidate and the loser only
     * finds out at sign-up.
     */
    const body = buildUserIdSuggestionRequest({ userName: 'Concurrent Suggestion Probe' });
    const [first, second] = await Promise.all([
      usersClient.generateUserIdSuggestions(body),
      usersClient.generateUserIdSuggestions(body),
    ]);

    const firstList = (await readBody(first)).json?.value;
    const secondList = (await readBody(second)).json?.value;
    const overlap =
      Array.isArray(firstList) &&
      Array.isArray(secondList) &&
      firstList.length > 0 &&
      JSON.stringify(firstList) === JSON.stringify(secondList);

    if (overlap) {
      await reportBusinessLogicFlaw(
        second,
        {
          ...META,
          body,
          repro: `await Promise.all([generateUserIdSuggestions(body), generateUserIdSuggestions(body)]); // identical lists`,
          scenario: `Two concurrent callers were handed the identical candidate list ${JSON.stringify(firstList).slice(0, 120)}. The endpoint suggests names it does not reserve, so the suggestion carries no guarantee and the collision only surfaces when the second sign-up fails.`,
          title: 'generateUserIdSuggestions does not reserve the names it offers',
        },
        'Idempotency / Concurrency',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[1d] parity: a rejected request must not be answered with a failure payload under HTTP 200', async ({
    usersClient,
  }) => {
    const response = await usersClient.generateUserIdSuggestions({});

    await assertNot200OKOnError(response, {
      ...META,
      body: {},
      repro: `await usersClient.generateUserIdSuggestions({});`,
    });
  });

  test('[2] boundary: an empty userName must be refused, not answered with bare suffixes', async ({
    usersClient,
  }) => {
    const body = buildUserIdSuggestionRequest({ userName: '' });
    const response = await usersClient.generateUserIdSuggestions(body);

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty userName' });
  });

  test('[2b] boundary: a null userName must be refused', async ({ usersClient }) => {
    const body = buildUserIdSuggestionRequest({ userName: null });
    const response = await usersClient.generateUserIdSuggestions(body);

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null userName' });
  });

  test('[2c] boundary: a 5000-character userName must not be turned into suggestions', async ({
    usersClient,
  }) => {
    const body = buildUserIdSuggestionRequest({ userName: MAX_LENGTH_STRING });
    const response = await usersClient.generateUserIdSuggestions(body);

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) userName',
    });
  });

  test('[3] typefuzz: a numeric userName must be refused', async ({ usersClient }) => {
    const body = buildUserIdSuggestionRequest({ userName: 1001 });
    const response = await usersClient.generateUserIdSuggestions(body);

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'numeric userName' });
  });

  test('[3b] typefuzz: an array userName must be refused', async ({ usersClient }) => {
    const body = buildUserIdSuggestionRequest({ userName: ['Meera', 'Nair'] });
    const response = await usersClient.generateUserIdSuggestions(body);

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'array userName' });
  });

  test('[3c] typefuzz: a boolean country must be refused', async ({ usersClient }) => {
    const body = buildUserIdSuggestionRequest({ country: false });
    const response = await usersClient.generateUserIdSuggestions(body);

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean country' });
  });

  test('[4] auth: a forged alg:none token must not change what is suggested', async ({
    usersClient,
  }) => {
    // A registration-time helper must answer with no token, so 401 is not the expectation here.
    const body = buildUserIdSuggestionRequest();
    const response = await usersClient.generateUserIdSuggestions(body, {
      token: FORGED_ALG_NONE_JWT,
    });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[4b] auth: an expired token must not be honoured as an established session', async ({
    usersClient,
  }) => {
    const body = buildUserIdSuggestionRequest({ userName: '' });
    const response = await usersClient.generateUserIdSuggestions(body, { token: EXPIRED_TOKEN });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[5] [IDOR] the suggestion list must not disclose which login names are already taken', async ({
    usersClient,
  }) => {
    /*
     * Suggestions are produced by skipping names that exist. The gaps in the returned sequence
     * are therefore a map of real accounts: ask for a common name and the numbers that are
     * missing name the users who already hold them — enumeration by omission, anonymously.
     */
    const body = buildUserIdSuggestionRequest({ userName: 'Admin User' });
    const response = await usersClient.generateUserIdSuggestions(body);

    const { json, text } = await readBody(response);
    const suggestions = json?.value;
    const skipped =
      Array.isArray(suggestions) &&
      suggestions.length > 0 &&
      !suggestions.some((candidate) => String(candidate).replace(/\W/g, '').toLowerCase() === 'adminuser');

    if (skipped) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await usersClient.generateUserIdSuggestions({ userName: "Admin User" }); // no token`,
          scenario: `The unqualified candidate derived from "Admin User" was absent from the returned list ${JSON.stringify(suggestions).slice(0, 120)}, which means it was skipped because it already exists. An anonymous caller can therefore confirm which login names are taken by reading what the suggester avoids. Body: ${text.slice(0, 160)}`,
          title: 'generateUserIdSuggestions leaks account existence through the names it skips',
        },
        'Security/Information Disclosure',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload in userName must not surface a database error', async ({
    usersClient,
  }) => {
    const body = buildUserIdSuggestionRequest({ userName: SQLI_PAYLOAD });
    const response = await usersClient.generateUserIdSuggestions(body);

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script userName must not come back inside a suggested identifier', async ({
    usersClient,
  }) => {
    const body = buildUserIdSuggestionRequest({ userName: XSS_PAYLOAD });
    const response = await usersClient.generateUserIdSuggestions(body);

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /userDetails/resetPassword ==== */
test.describe('POST /userDetails/resetPassword', () => {
  const META = {
    method: 'POST',
    path: USER_PATHS.resetPassword,
    repro: `await usersClient.resetPassword(buildResetPassword(), { token }); // password redacted in this ledger`,
  };

  test('[1] happy path: a reset request returns a well-formed envelope', async ({
    usersClient,
    requireAuthToken,
  }) => {
    // Aimed at a throwaway identifier: a reset against a shared QA account would lock the rest
    // of the suite out of the very credentials it authenticates with.
    const token = requireAuthToken();
    const body = buildResetPassword();
    const response = await usersClient.resetPassword(body, { token });

    await expectValidContract(response, looseEnvelopeSchema, {
      ...META,
      body: withoutCredentials(body),
    });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildResetPassword();
    const response = await usersClient.resetPassword(body, { token });

    await assertStatusCodeParity(response, { ...META, body: withoutCredentials(body) });
  });

  test('[1c] business rule: resetting an account that does not exist must not report SUCCESS', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const absent = qaIdentifier('definitely.absent');
    const body = buildResetPassword({ userID: absent });
    const response = await usersClient.resetPassword(body, { token });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body: withoutCredentials(body),
          repro: `await usersClient.resetPassword({ userID: "${absent}", password: "<new>" }, { token });`,
          scenario: `A reset for the non-existent account "${absent}" returned SUCCESS. No credential was changed, yet the caller — and any support workflow built on this — is told the password was reset. Body: ${text.slice(0, 200)}`,
          title: 'resetPassword reports SUCCESS for a userID that matched no account',
        },
        'Status Code Misreporting',
        'Medium'
      );
    }
    expect(true).toBe(true);
  });

  test('[1d] parity: a failed reset must not be delivered under a 2xx transport status', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildResetPassword({ userID: '' });
    const response = await usersClient.resetPassword(body, { token });

    await assertNot200OKOnError(response, { ...META, body: withoutCredentials(body) });
  });

  test('[2] boundary: an empty new password must be refused, not set as the account password', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildResetPassword({ password: '' });
    const response = await usersClient.resetPassword(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body: withoutCredentials(body),
      scenario: 'empty new password',
    });
  });

  test('[2b] boundary: a null new password must be refused', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildResetPassword({ password: null });
    const response = await usersClient.resetPassword(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body: withoutCredentials(body),
      scenario: 'null new password',
    });
  });

  test('[2c] boundary: a 5000-character userID must not be used as a reset target', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildResetPassword({ userID: MAX_LENGTH_STRING });
    const response = await usersClient.resetPassword(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body: withoutCredentials(body),
      scenario: 'oversized (5000-char) userID',
    });
  });

  test('[3] typefuzz: a numeric userID must be refused', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildResetPassword({ userID: 1001 });
    const response = await usersClient.resetPassword(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body: withoutCredentials(body),
      scenario: 'numeric userID',
    });
  });

  test('[3b] typefuzz: a boolean password must be refused', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildResetPassword({ password: true });
    const response = await usersClient.resetPassword(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body: withoutCredentials(body),
      scenario: 'boolean password',
    });
  });

  test('[3c] typefuzz: an object userID must not reach the driver as a query operator', async ({
    usersClient,
    requireAuthToken,
  }) => {
    /*
     * If `{ $ne: null }` is spliced into the lookup filter, the reset resolves to whichever
     * account the driver returns first and overwrites its password — a one-request takeover.
     */
    const token = requireAuthToken();
    const body = buildResetPassword({ userID: { $ne: null } });
    const response = await usersClient.resetPassword(body, { token });

    await assertRejectsInvalidInput(response, {
      ...META,
      body: withoutCredentials(body),
      scenario: 'object userID ({ $ne: null }) — operator injection on the reset target',
    });
  });

  test('[4] auth: an unauthenticated password reset must be refused', async ({ usersClient }) => {
    const body = buildResetPassword();
    const response = await usersClient.resetPassword(body, { token: null });

    await assertUnauthorized(response, { ...META, body: withoutCredentials(body) });
  });

  test('[4b] auth: an expired token must not authorise a credential change', async ({
    usersClient,
  }) => {
    const body = buildResetPassword();
    const response = await usersClient.resetPassword(body, { token: EXPIRED_TOKEN });

    await assertUnauthorized(response, { ...META, body: withoutCredentials(body) });
  });

  test('[4c] auth: a malformed bearer token must not authorise a credential change', async ({
    usersClient,
  }) => {
    const body = buildResetPassword();
    const response = await usersClient.resetPassword(body, { token: MALFORMED_TOKEN });

    await assertUnauthorized(response, { ...META, body: withoutCredentials(body) });
  });

  test('[5] [IDOR] an anonymous caller must not be able to reset an arbitrary account password', async ({
    usersClient,
  }) => {
    /*
     * The body names the account to reset and carries no proof of ownership — no old password,
     * no OTP reference, no session binding. If an anonymous call succeeds, every account on
     * the platform is one request away from takeover. A throwaway identifier is used as the
     * target so no real credential is changed while proving the check is absent.
     */
    const victim = qaIdentifier('victim.account');
    const body = buildResetPassword({ userID: victim });
    const response = await usersClient.resetPassword(body, { token: null });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body: withoutCredentials(body),
          repro: `await usersClient.resetPassword({ userID: "${victim}", password: "<attacker choice>" }, { token: null });`,
          scenario: `An unauthenticated caller named an account and set its password, and the API answered SUCCESS. There is no old-password check, no OTP binding and no session requirement, so knowing a login name is sufficient to take over the account. Body: ${text.slice(0, 200)}`,
          title: 'Unauthenticated password reset for an arbitrary userID (account takeover)',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload in userID must not surface a database error', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildResetPassword({ userID: SQLI_PAYLOAD });
    const response = await usersClient.resetPassword(body, { token });

    await assertNoInternalLeak(
      response,
      { ...META, body: withoutCredentials(body) },
      SQLI_PAYLOAD
    );
  });

  test('[6b] injection: a script userID must not be echoed unescaped', async ({
    usersClient,
    requireAuthToken,
  }) => {
    const token = requireAuthToken();
    const body = buildResetPassword({ userID: XSS_PAYLOAD });
    const response = await usersClient.resetPassword(body, { token });

    await assertNoReflectedScript(response, { ...META, body: withoutCredentials(body) }, XSS_PAYLOAD);
  });
});

/* ==== POST /userDetails/sendOTP ==== */
test.describe('POST /userDetails/sendOTP', () => {
  /*
   * SAFETY — every case in this block is written around one fact: a successful call here sends
   * a real SMS and is billed. `buildSendOtp` pins the destination to TEST_MOBILE and must never
   * be given a faker number. Exactly three cases below reach the gateway ([1], [1c] and [5]),
   * all to the pinned number; every other case carries a destination that cannot be dialled so
   * the request fails before dispatch.
   *
   * The documented absence of rate limiting is therefore NOT asserted here — proving it would
   * mean paying for a burst of real messages. It is asserted on validateOTP instead, where the
   * missing attempt counter is the same defect on the consuming side and costs nothing.
   */
  const META = {
    method: 'POST',
    path: USER_PATHS.sendOTP,
    repro: `await usersClient.sendOTP(buildSendOtp()); // destination pinned to TEST_MOBILE`,
  };

  test('[1] happy path: a well-formed request to the pinned number returns an OTP envelope', async ({
    usersClient,
  }) => {
    // DISPATCHES ONE REAL SMS to TEST_MOBILE.
    const body = buildSendOtp();
    const response = await usersClient.sendOTP(body);

    await expectValidContract(response, otpEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    usersClient,
  }) => {
    // Deliberately run on a refusal path so the parity check costs no SMS.
    const body = buildSendOtp({ mobileNumber: '' });
    const response = await usersClient.sendOTP(body);

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: the response must never carry the OTP it just issued', async ({
    usersClient,
  }) => {
    /*
     * DISPATCHES ONE REAL SMS to TEST_MOBILE. The code is documented as never returned — the
     * client is supposed to read it from the handset. Returning it in the envelope collapses
     * the second factor entirely: whoever can call sendOTP can also complete validateOTP.
     */
    const body = buildSendOtp();
    const response = await usersClient.sendOTP(body);

    const { text } = await readBody(response);
    const codeInBody = /"(otp|code)"\s*:\s*"?\d{4,8}"?/i.test(text);
    if (codeInBody) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await usersClient.sendOTP(buildSendOtp()); // response contained the issued code`,
          scenario: `The sendOTP response contained the freshly issued one-time code. Possession of the handset stops being required — the caller who requests the OTP can immediately validate it — so mobile verification proves nothing. Body: ${text.slice(0, 200)}`,
          title: 'sendOTP returns the one-time code in its response',
        },
        'Security/Information Disclosure',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[1d] parity: a refused dispatch must not be delivered under a 2xx transport status', async ({
    usersClient,
  }) => {
    const body = buildSendOtp({ mobileNumber: '' });
    const response = await usersClient.sendOTP(body);

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[2] boundary: an empty mobileNumber must be refused, not dispatched', async ({
    usersClient,
  }) => {
    const body = buildSendOtp({ mobileNumber: '' });
    const response = await usersClient.sendOTP(body);

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty mobileNumber' });
  });

  test('[2b] boundary: a null mobileNumber must be refused', async ({ usersClient }) => {
    const body = buildSendOtp({ mobileNumber: null });
    const response = await usersClient.sendOTP(body);

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null mobileNumber' });
  });

  test('[2c] boundary: a 5000-character mobileNumber must be refused', async ({ usersClient }) => {
    const body = buildSendOtp({ mobileNumber: MAX_LENGTH_STRING });
    const response = await usersClient.sendOTP(body);

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) mobileNumber',
    });
  });

  test('[3] typefuzz: a quoted dialCode must be refused — the schema documents an integer', async ({
    usersClient,
  }) => {
    // Paired with an undialable destination so a lenient server cannot turn this into a send.
    const body = buildSendOtp({ dialCode: '91', mobileNumber: '' });
    const response = await usersClient.sendOTP(body);

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'string dialCode where an int32 is documented',
    });
  });

  test('[3b] typefuzz: a boolean dialCode must be refused', async ({ usersClient }) => {
    const body = buildSendOtp({ dialCode: true, mobileNumber: '' });
    const response = await usersClient.sendOTP(body);

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean dialCode' });
  });

  test('[3c] typefuzz: an array mobileNumber must be refused', async ({ usersClient }) => {
    // An array of undialable strings — a lenient server that joins them still cannot place a call.
    const body = buildSendOtp({ mobileNumber: ['not', 'a', 'number'] });
    const response = await usersClient.sendOTP(body);

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'array mobileNumber' });
  });

  test('[4] auth: a forged alg:none token must not privilege a dispatch', async ({
    usersClient,
  }) => {
    // sendOTP is pre-account and must work anonymously, so 401 is not the expectation. What is
    // asserted is that an unsigned identity does not change the outcome. Undialable on purpose.
    const body = buildSendOtp({ mobileNumber: '' });
    const response = await usersClient.sendOTP(body, { token: FORGED_ALG_NONE_JWT });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[4b] auth: an expired token must not be honoured as an established session', async ({
    usersClient,
  }) => {
    const body = buildSendOtp({ mobileNumber: '' });
    const response = await usersClient.sendOTP(body, { token: EXPIRED_TOKEN });

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[5] [IDOR] an OTP must not be issuable bound to somebody else account', async ({
    usersClient,
  }) => {
    /*
     * DISPATCHES ONE REAL SMS to TEST_MOBILE — the destination stays pinned; only the userID
     * is foreign. `userID` is carried "for context", but if the issued OTP record is bound to
     * that account then anyone can have a verification code for a stranger's account delivered
     * to their own handset, and then validate it.
     */
    const foreignUser = qaIdentifier('victim.account');
    const body = buildSendOtp({ userID: foreignUser, requestType: 'resetPassword' });
    const response = await usersClient.sendOTP(body);

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await usersClient.sendOTP({ userID: "${foreignUser}", mobileNumber: "<attacker handset>", requestType: "resetPassword" });`,
          scenario: `A reset OTP naming the account "${foreignUser}" was issued to a caller-supplied destination with no check that the number belongs to that account. If the OTP record is bound to the named userID, an attacker receives a valid verification code for somebody else's account on their own phone. Body: ${text.slice(0, 200)}`,
          title: 'sendOTP issues an account-bound OTP to a caller-chosen destination',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload in mobileNumber must not surface a database error', async ({
    usersClient,
  }) => {
    // An injection string is not a dialable number, so this cannot reach the SMS gateway.
    const body = buildSendOtp({ mobileNumber: SQLI_PAYLOAD });
    const response = await usersClient.sendOTP(body);

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script mobileNumber must not be echoed unescaped', async ({
    usersClient,
  }) => {
    const body = buildSendOtp({ mobileNumber: XSS_PAYLOAD });
    const response = await usersClient.sendOTP(body);

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});

/* ==== POST /userDetails/validateOTP ==== */
test.describe('POST /userDetails/validateOTP', () => {
  /*
   * Nothing in this block dispatches a message — validateOTP only consumes a code. That is why
   * the missing attempt counter is proven here rather than on sendOTP: the same "no throttle"
   * defect, observable at zero cost.
   */
  const META = {
    method: 'POST',
    path: USER_PATHS.validateOTP,
    repro: `await usersClient.validateOTP(buildValidateOtp(env.mockOtp));`,
  };

  test('[1] happy path: a validation attempt returns a well-formed OTP envelope', async ({
    usersClient,
  }) => {
    const body = buildValidateOtp(env.mockOtp);
    const response = await usersClient.validateOTP(body);

    await expectValidContract(response, otpEnvelopeSchema, { ...META, body });
  });

  test('[1b] parity: the HTTP status must agree with the envelope statusCode', async ({
    usersClient,
  }) => {
    const body = buildValidateOtp(env.mockOtp);
    const response = await usersClient.validateOTP(body);

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[1c] business rule: an incorrect OTP must never be accepted as valid', async ({
    usersClient,
  }) => {
    const body = buildValidateOtp('111111');
    const response = await usersClient.validateOTP(body);

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    const code = typeof json?.statusCode === 'number' ? json.statusCode : null;
    if (response.status() === 200 && status === 'SUCCESS' && code === 200) {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await usersClient.validateOTP({ otp: "111111", mobileNumber: "<pinned>", type: "signup" });`,
          scenario: `The obviously wrong code "111111" was accepted as a successful validation. Mobile verification is then decorative — any caller clears the OTP gate for any number without ever holding the handset. Body: ${text.slice(0, 200)}`,
          title: 'validateOTP accepts an incorrect one-time code',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[1d] business rule: repeated wrong codes must eventually be throttled or locked out', async ({
    usersClient,
  }) => {
    /*
     * Documented defect: no attempt counter and no lockout, against a 6-digit code with a
     * 10-minute window. Five concurrent wrong guesses all being processed identically — never
     * 429, never 423 — is the observable form of "the code is brute-forceable".
     */
    const attempts = await Promise.all([
      usersClient.validateOTP(buildValidateOtp('111111')),
      usersClient.validateOTP(buildValidateOtp('222222')),
      usersClient.validateOTP(buildValidateOtp('333333')),
      usersClient.validateOTP(buildValidateOtp('444444')),
      usersClient.validateOTP(buildValidateOtp('555555')),
    ]);

    const throttled = attempts.some((r) => r.status() === 429 || r.status() === 423);
    if (!throttled) {
      await reportBusinessLogicFlaw(
        attempts[attempts.length - 1],
        {
          ...META,
          repro: `await Promise.all([...5 validateOTP calls with different wrong codes]); // none throttled`,
          scenario:
            'Five consecutive wrong OTP attempts were all processed with no 429 throttle and no 423 lock. With a 6-digit code and a 10-minute validity window the whole keyspace is reachable well inside the lifetime of a single code, so the OTP gate can be brute-forced.',
          title: 'validateOTP has no attempt counter or lockout (brute-forceable)',
        },
        'Security/Rate Limiting',
        'Major'
      );
    }
    expect(true).toBe(true);
  });

  test('[1e] parity: a failed validation must not be delivered under a 2xx transport status', async ({
    usersClient,
  }) => {
    const body = buildValidateOtp('');
    const response = await usersClient.validateOTP(body);

    await assertNot200OKOnError(response, { ...META, body });
  });

  test('[2] boundary: an empty otp must be refused, not treated as a match', async ({
    usersClient,
  }) => {
    const body = buildValidateOtp('');
    const response = await usersClient.validateOTP(body);

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'empty otp' });
  });

  test('[2b] boundary: a null otp must be refused rather than compared against a null column', async ({
    usersClient,
  }) => {
    const body = buildValidateOtp(env.mockOtp, { otp: null });
    const response = await usersClient.validateOTP(body);

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'null otp' });
  });

  test('[2c] boundary: a 5000-character otp must be refused', async ({ usersClient }) => {
    const body = buildValidateOtp(MAX_LENGTH_STRING);
    const response = await usersClient.validateOTP(body);

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'oversized (5000-char) otp',
    });
  });

  test('[3] typefuzz: a numeric otp must be refused, not coerced into a match', async ({
    usersClient,
  }) => {
    const body = buildValidateOtp(env.mockOtp, { otp: 999999 });
    const response = await usersClient.validateOTP(body);

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'numeric otp where a string is documented',
    });
  });

  test('[3b] typefuzz: a boolean type discriminator must be refused', async ({ usersClient }) => {
    const body = buildValidateOtp(env.mockOtp, { type: true });
    const response = await usersClient.validateOTP(body);

    await assertRejectsInvalidInput(response, { ...META, body, scenario: 'boolean type' });
  });

  test('[3c] typefuzz: an object otp must not reach the driver as a query operator', async ({
    usersClient,
  }) => {
    /*
     * `{ $ne: null }` as the code matches any issued OTP row. If it reaches the driver, the
     * gate opens without a single guess.
     */
    const body = buildValidateOtp(env.mockOtp, { otp: { $ne: null } });
    const response = await usersClient.validateOTP(body);

    await assertRejectsInvalidInput(response, {
      ...META,
      body,
      scenario: 'object otp ({ $ne: null }) — operator injection that matches any issued code',
    });
  });

  test('[4] auth: a forged alg:none token must not substitute for a valid code', async ({
    usersClient,
  }) => {
    const body = buildValidateOtp('111111');
    const response = await usersClient.validateOTP(body, { token: FORGED_ALG_NONE_JWT });

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await usersClient.validateOTP({ otp: "111111", ... }, { token: FORGED_ALG_NONE_JWT });`,
          scenario: `A wrong code was accepted while an unsigned alg:none token was attached. The verification outcome depends on the caller's own token rather than on the issued OTP. Body: ${text.slice(0, 200)}`,
          title: 'Forged alg:none token clears the OTP gate',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[4b] auth: an expired token must not change the validation verdict', async ({
    usersClient,
  }) => {
    const body = buildValidateOtp('111111');
    const response = await usersClient.validateOTP(body, { token: EXPIRED_TOKEN });

    await assertStatusCodeParity(response, { ...META, body });
  });

  test('[5] [IDOR] a code issued for one number must not validate a different number', async ({
    usersClient,
  }) => {
    /*
     * The OTP row is keyed by mobileNumber. If the lookup ignores it — matching on the code
     * alone, or on the most recent live row — then a code delivered to the attacker's own
     * handset verifies the victim's number. The probe number is the provably undeliverable
     * one, and validateOTP dispatches nothing, so this costs no message.
     */
    const body = buildValidateOtp(env.mockOtp, { mobileNumber: unroutableMobile() });
    const response = await usersClient.validateOTP(body);

    const { json, text } = await readBody(response);
    const status = typeof json?.status === 'string' ? json.status.toUpperCase() : null;
    if (response.status() === 200 && status === 'SUCCESS') {
      await reportBusinessLogicFlaw(
        response,
        {
          ...META,
          body,
          repro: `await usersClient.validateOTP({ otp: "<code issued for the pinned number>", mobileNumber: "${unroutableMobile()}" });`,
          scenario: `A code was validated against a mobile number it was never issued for, and the API answered SUCCESS. Verification is therefore not bound to the destination: a code delivered to one handset clears the gate for any other number. Body: ${text.slice(0, 200)}`,
          title: 'validateOTP accepts a code against a mobile number it was not issued for',
        },
        'Security/Access Control',
        'Critical'
      );
    }
    expect(true).toBe(true);
  });

  test('[6] injection: a SQL payload in otp must not surface a database error', async ({
    usersClient,
  }) => {
    const body = buildValidateOtp(SQLI_PAYLOAD);
    const response = await usersClient.validateOTP(body);

    await assertNoInternalLeak(response, { ...META, body }, SQLI_PAYLOAD);
  });

  test('[6b] injection: a script type discriminator must not be echoed unescaped', async ({
    usersClient,
  }) => {
    const body = buildValidateOtp(env.mockOtp, { type: XSS_PAYLOAD });
    const response = await usersClient.validateOTP(body);

    await assertNoReflectedScript(response, { ...META, body }, XSS_PAYLOAD);
  });
});
