/**
 * Live database tests for the Supabase Before User Created auth hook.
 *
 * ⚠️  THESE TESTS ARE DESTRUCTIVE WITHIN THE `guard` SCHEMA.
 *
 * Same rules as tests/integration/guard-schema.test.ts: they drop and recreate the
 * `guard` schema, they require SADA_TEST_DB_URL (never SUPABASE_DB_URL), and with it
 * unset the whole suite skips so CI stays offline. Nothing outside `guard` is read or
 * written; `public` and `auth` are never touched, and no Supabase project is contacted.
 *
 * Every destructive case below runs inside a transaction that is rolled back, so the
 * damage a fail-closed test needs is real while it runs and gone the moment it ends.
 * The database is never weakened permanently to make a test easier.
 *
 * ## Supabase-specific roles
 *
 * The tests that matter most -- executing the hook as `supabase_auth_admin`, and the
 * privilege boundaries -- need Supabase's roles, which a plain PostgreSQL server does
 * not have. Those tests SKIP explicitly when a role is absent rather than looping zero
 * times and reporting a vacuous pass.
 *
 * To run them locally, create the role once on your scratch server:
 *
 *   psql -d supabase_anti_disposable_auth_test -c "create role supabase_auth_admin nologin"
 *
 * and drop it when you are done. Roles are cluster-wide, so this is the one piece of
 * setup that reaches outside the scratch database -- which is why it is a documented
 * manual step and not something the suite does to you.
 */

import { readFile } from 'node:fs/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresConnection } from '../../src/database/client.js';
import { runMigrations } from '../../src/database/migrations.js';
import { readGuardSchemaStatus } from '../../src/database/schema-status.js';
import { statusExitCode } from '../../src/commands/status.js';
import type { DatabaseConnection } from '../../src/database/types.js';
import { EXIT_CODES } from '../../src/lib/errors.js';

const testDatabaseUrl = process.env['SADA_TEST_DB_URL'];
const describeIfConfigured = testDatabaseUrl === undefined ? describe.skip : describe;

/** The exact allow response Supabase Auth expects. */
const ALLOW = {};

const REJECT_DISPOSABLE = {
  error: { http_code: 403, message: 'Disposable email addresses are not allowed.' },
};

const REJECT_UNAVAILABLE = {
  error: { http_code: 503, message: 'Signup could not be validated. Please try again later.' },
};

/** The role Supabase Auth connects as. Absent on a plain PostgreSQL server. */
const AUTH_ROLE = 'supabase_auth_admin';

let connection: DatabaseConnection;

/** Whether this server has the Supabase auth role, resolved once after connecting. */
let authRolePresent = false;

/** Supabase client roles present here. Empty on a plain PostgreSQL instance. */
let clientRoles: string[] = [];

type HookResponse = Record<string, unknown>;

async function roleExists(role: string): Promise<boolean> {
  const result = await connection.query<{ present: boolean }>(
    'select exists (select 1 from pg_catalog.pg_roles where rolname = $1) as present',
    [role],
  );
  return result.rows[0]?.present === true;
}

/** Invokes the hook exactly as Supabase Auth does: one jsonb in, one jsonb out. */
async function callHook(event: unknown): Promise<HookResponse> {
  const result = await connection.query<{ value: HookResponse }>(
    'select guard.before_user_created($1::jsonb) as value',
    [event === null ? null : JSON.stringify(event)],
  );

  return result.rows[0]?.value;
}

async function scalar<T>(sql: string, parameters: (string | null)[] = []): Promise<T | undefined> {
  const result = await connection.query<{ value: T }>(sql, parameters);
  return result.rows[0]?.value;
}

async function dropGuardSchema(): Promise<void> {
  await connection.execute('drop schema if exists guard cascade');
}

/**
 * Extracts the grant-repair snippet the README documents, so the test runs the
 * *published* remediation rather than a copy of it.
 *
 * A copy would pass forever while the README drifted into something that no longer
 * works -- and the README is the only place an operator is sent when `status` reports
 * missing grants, so a snippet that does not work there is a real defect.
 */
async function readDocumentedGrantRepair(): Promise<string> {
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');

  const section = readme.indexOf('#### The remediation');
  expect(section).toBeGreaterThan(-1);

  const open = readme.indexOf('```sql', section);
  const start = readme.indexOf('\n', open) + 1;
  const end = readme.indexOf('```', start);
  expect(open).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);

  const snippet = readme.slice(start, end).trim();

  // Sanity-check what was extracted before running it against a database.
  expect(snippet).toContain('supabase_auth_admin');
  expect(snippet).toContain('pg_catalog.pg_roles');

  return snippet;
}

/**
 * Runs a statement expected to fail and returns its PostgreSQL SQLSTATE.
 *
 * Two things make this necessary rather than a plain `.rejects.toThrow(/.../)`:
 *
 *  - The client wraps every failure in a DatabaseQueryError whose message is
 *    "Query failed against ...", so the PostgreSQL text lives on `cause`. Matching
 *    the wrapper's message would assert nothing about *why* it failed.
 *  - A failed statement aborts the surrounding transaction. Without rolling back to
 *    a savepoint, every later statement -- including the test's own cleanup -- fails
 *    with 25P02 and masks the real result.
 */
async function sqlstateOf(statement: string, parameter: string): Promise<string | undefined> {
  await connection.query('savepoint write_attempt');
  try {
    await connection.query(statement, [parameter]);
    return undefined; // The statement succeeded, which is itself the failure.
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    return cause?.code;
  } finally {
    await connection.query('rollback to savepoint write_attempt');
  }
}

describeIfConfigured('guard.before_user_created against a live database', () => {
  beforeAll(async () => {
    connection = await createPostgresConnection({ connectionString: testDatabaseUrl as string });
    await dropGuardSchema();
    await runMigrations(connection);
    authRolePresent = await roleExists(AUTH_ROLE);

    const roles = await connection.query<{ rolname: string }>(
      `select rolname from pg_catalog.pg_roles
       where rolname in ('anon', 'authenticated') and not rolsuper
       order by rolname`,
    );
    clientRoles = roles.rows.map((row) => row.rolname);
  }, 60_000);

  afterAll(async () => {
    if (connection !== undefined) {
      await dropGuardSchema();
      await connection.close();
    }
  });

  describe('the hook contract', () => {
    it('has the signature Supabase Auth invokes', async () => {
      // GoTrue calls `select "guard"."before_user_created"($1)` with one jsonb
      // argument. A different argument type or arity means the hook silently never
      // resolves once activated.
      expect(
        await scalar(
          "select to_regprocedure('guard.before_user_created(jsonb)') is not null as value",
        ),
      ).toBe(true);

      const signature = await connection.query<{
        result_type: string;
        volatility: string;
        secdef: boolean;
        config: string | null;
      }>(
        `select pg_catalog.pg_get_function_result(p.oid) as result_type,
                p.provolatile as volatility,
                p.prosecdef as secdef,
                array_to_string(p.proconfig, ',') as config
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'guard' and p.proname = 'before_user_created'`,
      );

      const row = signature.rows[0];
      expect(row?.result_type).toBe('jsonb');
      // 's' = STABLE. It reads two tables and must not be marked IMMUTABLE.
      expect(row?.volatility).toBe('s');
      // The decision recorded in 007: INVOKER, never DEFINER.
      expect(row?.secdef).toBe(false);
      // PostgreSQL stores the pinned empty path as the quoted empty string.
      expect(row?.config).toBe('search_path=""');
    });
  });

  describe('core policy behaviour', () => {
    // Fixture rows are inserted once and rolled back at the end, so the database is
    // left exactly as it was found.
    beforeAll(async () => {
      await connection.execute('begin');
      await connection.query('insert into guard.blocked_domains (domain, source) values ($1, $2)', [
        'mailinator.com',
        'integration-fixture',
      ]);
    });

    afterAll(async () => {
      await connection.execute('rollback');
    });

    it('allows a normal, non-disposable address', async () => {
      expect(await callHook({ user: { email: 'person@gmail.com' } })).toEqual(ALLOW);
    });

    it('rejects a disposable address with the documented error shape', async () => {
      expect(await callHook({ user: { email: 'person@mailinator.com' } })).toEqual(
        REJECT_DISPOSABLE,
      );
    });

    it('allows a domain on neither list', async () => {
      expect(await callHook({ user: { email: 'person@unknown-domain.example' } })).toEqual(ALLOW);
    });

    it('normalises case before deciding', async () => {
      for (const email of [
        'PERSON@MAILINATOR.COM',
        'Person@Mailinator.Com',
        'person@MAILINATOR.com',
        '  person@mailinator.com  ',
      ]) {
        expect(await callHook({ user: { email } })).toEqual(REJECT_DISPOSABLE);
      }
    });

    it('lets the allowlist override the blocklist', async () => {
      // This is the test that proves the hook delegates rather than duplicating
      // policy: allowlist precedence lives in guard.is_disposable_domain(), and the
      // hook has no lookup logic of its own that could disagree with it.
      await connection.query('savepoint allowlist_precedence');
      try {
        await connection.query(
          'insert into guard.allowed_domains (domain, reason) values ($1, $2)',
          ['mailinator.com', 'integration-fixture'],
        );

        expect(
          await scalar('select guard.is_blocked_domain($1) as value', ['mailinator.com']),
        ).toBe(true);
        expect(await callHook({ user: { email: 'person@mailinator.com' } })).toEqual(ALLOW);
        expect(await callHook({ user: { email: 'PERSON@MAILINATOR.COM' } })).toEqual(ALLOW);
      } finally {
        await connection.query('rollback to savepoint allowlist_precedence');
      }
    });

    it('agrees with guard.is_disposable_domain() on every input', async () => {
      // The hook must never reach a different verdict from the policy engine. If
      // these two ever disagree, there are two policies rather than one.
      for (const email of [
        'person@mailinator.com',
        'person@gmail.com',
        'PERSON@MAILINATOR.COM',
        'person@sub.mailinator.com',
        'a@b@mailinator.com',
        'not-an-email',
      ]) {
        const engine = await scalar<boolean>('select guard.is_disposable_domain($1) as value', [
          email,
        ]);
        const expected = engine === true ? REJECT_DISPOSABLE : ALLOW;

        expect(await callHook({ user: { email } })).toEqual(expected);
      }
    });
  });

  describe('missing email', () => {
    // Phone-only and anonymous signups are supported Supabase flows that carry no
    // email. A disposable-EMAIL filter that silently disabled them would be a far
    // worse bug than the one it prevents.
    it.each([
      ['an absent user key', {}],
      ['a null user', { user: null }],
      ['a user with no email key', { user: {} }],
      ['a null email', { user: { email: null } }],
      ['an empty email', { user: { email: '' } }],
      ['a whitespace-only email', { user: { email: '   ' } }],
      ['a phone-only signup', { user: { email: '', phone: '+15550100', is_anonymous: false } }],
      ['an anonymous signup', { user: { email: '', phone: '', is_anonymous: true } }],
    ])('allows %s', async (_label, event) => {
      expect(await callHook(event)).toEqual(ALLOW);
    });

    it('allows the documented Supabase payload shape for a phone signup', async () => {
      // Supabase serialises the email as a Go NullString, so a phone signup arrives
      // as "" rather than as an absent key or a JSON null. That is the case that
      // actually happens in production, so it is asserted on its real shape.
      expect(
        await callHook({
          metadata: { uuid: '8b34dcdd-9df1-4c10-850a-b3277c653040', name: 'before-user-created' },
          user: {
            id: 'ff7fc9ae-3b1b-4642-9241-64adb9848a03',
            aud: 'authenticated',
            email: '',
            phone: '+15550100',
            app_metadata: { provider: 'phone', providers: ['phone'] },
            is_anonymous: false,
          },
        }),
      ).toEqual(ALLOW);
    });
  });

  describe('malformed email type', () => {
    // `user.email` is a Go string field in GoTrue. It can arrive absent, as JSON
    // null, or as a string -- never as a number, boolean, array or object. A payload
    // that carries one of those did not come from the contract this hook implements,
    // and is answered as a malformed payload rather than as an email-less signup.
    //
    // The distinction is deliberate and is the whole point of this block: Supabase
    // legitimately represents non-email flows with an empty or null email, so those
    // must keep working, while a non-string value violates the expected hook contract
    // and must not be quietly read as "no email to check".
    it.each([
      ['a number email', { user: { email: 12345 } }],
      ['a float email', { user: { email: 1.5 } }],
      ['an object email', { user: { email: { address: 'a@mailinator.com' } } }],
      ['an empty object email', { user: { email: {} } }],
      ['an array email', { user: { email: ['a@mailinator.com'] } }],
      ['an empty array email', { user: { email: [] } }],
      ['a true email', { user: { email: true } }],
      ['a false email', { user: { email: false } }],
    ])('rejects %s as a malformed hook payload', async (_label, event) => {
      expect(await callHook(event)).toEqual(REJECT_UNAVAILABLE);
    });

    it('rejects rather than allowing a disposable domain hidden in a non-string', async () => {
      // The failure this rule prevents, stated as a test: reading a non-string as
      // "no usable email" would let a payload through a disposable-email filter
      // without the filter ever looking at an address.
      expect(await callHook({ user: { email: ['person@mailinator.com'] } })).toEqual(
        REJECT_UNAVAILABLE,
      );
    });

    it('still allows every shape that legitimately carries no email', async () => {
      // The contrast case. Supabase serialises a phone-only or anonymous signup with
      // an empty email, so these are supported flows and must not be swept up by the
      // type gate above.
      for (const event of [
        {},
        { user: null },
        { user: {} },
        { user: { email: null } },
        { user: { email: '' } },
        { user: { email: '   ' } },
      ]) {
        expect(await callHook(event)).toEqual(ALLOW);
      }
    });

    it('uses the same generic response as every other unavailable-validation case', async () => {
      // One stable 5xx message for "validation could not be completed", whatever
      // caused it. A client must not be able to tell a malformed payload from a
      // dropped table, and neither must be confusable with a policy rejection.
      const malformed = await callHook({ user: { email: 12345 } });

      expect(malformed).toEqual(await callHook(null));
      expect(malformed).not.toEqual(REJECT_DISPOSABLE);
    });

    it('exposes nothing about the payload in the rejection message', async () => {
      const response = await callHook({
        user: { email: { address: 'person@mailinator.com' }, phone: '+15550100' },
      });

      const message = (response['error'] as { message: string }).message;

      // Not the value, not the field, not the JSON type, not the reason.
      for (const leak of ['person', 'mailinator', '15550100', 'email', 'object', 'jsonb', 'user']) {
        expect(message.toLowerCase()).not.toContain(leak);
      }
    });

    it('reports a 5xx code so the client sees a server-side failure', async () => {
      const response = await callHook({ user: { email: true } });
      const httpCode = (response['error'] as { http_code: number }).http_code;

      expect(httpCode).toBeGreaterThanOrEqual(500);
      expect(httpCode).toBeLessThan(600);
    });

    it('rejects a non-string email under the real role too', async (ctx) => {
      // The type gate must not depend on who is calling. Skipped rather than
      // vacuously passed on a server without the Supabase auth role.
      if (!authRolePresent) {
        ctx.skip();
        return;
      }

      await connection.execute('begin');
      try {
        await connection.execute(`set local role ${AUTH_ROLE}`);
        expect(await callHook({ user: { email: 12345 } })).toEqual(REJECT_UNAVAILABLE);
      } finally {
        await connection.execute('rollback');
      }
    });
  });

  describe('malformed events', () => {
    it.each([
      ['a JSON scalar', '"nope"'],
      ['a JSON number', '42'],
      ['a JSON array', '[1,2,3]'],
      ['a JSON null', 'null'],
      ['a JSON boolean', 'true'],
    ])('rejects %s as structural corruption', async (_label, literal) => {
      // Supabase Auth always sends a JSON object. Anything else means this function
      // is not being called under the contract it was written for, and a hook that
      // cannot tell who is asking must not hand out approvals.
      expect(
        await scalar('select guard.before_user_created($1::jsonb) as value', [literal]),
      ).toEqual(REJECT_UNAVAILABLE);
    });

    it('rejects a SQL NULL event', async () => {
      expect(await callHook(null)).toEqual(REJECT_UNAVAILABLE);
    });

    it.each([
      ['a scalar user', { user: 'nope' }],
      ['an array user', { user: [1, 2] }],
    ])('allows %s rather than raising', async (_label, event) => {
      // Neither carries a `user.email` member at all -- `->` returns SQL NULL for a
      // non-object parent -- so both land on the absent-email path. The line between
      // "corrupt" and "no email" is still drawn at the outermost structure only.
      expect(await callHook(event)).toEqual(ALLOW);
    });

    it.each([
      ['no at sign', 'not-an-email'],
      ['a trailing at sign', 'user@'],
      ['a leading at sign', '@mailinator.com'],
      ['an underscore domain', 'user@under_score.com'],
      ['an IP address', 'user@192.168.0.1'],
      ['embedded whitespace', 'user@has space.com'],
      ['punctuation only', '!!!'],
      ['a very long local part', `${'a'.repeat(300)}@gmail.com`],
      ['a SQL-looking string', "robert'); drop table guard.blocked_domains;--@gmail.com"],
    ])('handles a malformed address (%s) without crashing', async (_label, email) => {
      // Not an RFC validator, and not required to be one. The only contract is that
      // it never raises and never disagrees with the policy engine.
      const engine = await scalar<boolean>('select guard.is_disposable_domain($1) as value', [
        email,
      ]);

      expect(await callHook({ user: { email } })).toEqual(
        engine === true ? REJECT_DISPOSABLE : ALLOW,
      );
    });

    it('treats an injection attempt as inert text', async () => {
      const attack = "x'); drop table guard.blocked_domains;--@gmail.com";

      await callHook({ user: { email: attack } });

      // The actual assertion: the table is still there.
      expect(await scalar("select to_regclass('guard.blocked_domains') is not null as value")).toBe(
        true,
      );
    });
  });

  describe('client-facing responses', () => {
    it('returns exactly {} to allow, with no extra keys', async () => {
      // GoTrue's BeforeUserCreatedOutput is an empty struct. Extra keys are not
      // errors, but an empty object is the contract and is what is asserted.
      const response = await callHook({ user: { email: 'person@gmail.com' } });

      expect(Object.keys(response)).toEqual([]);
    });

    it('always sends a non-empty message with a rejection', async () => {
      // hookserrors.check() treats an error object with an empty message as "no
      // error" and ALLOWS the signup. A blank message here would silently disable
      // the entire filter, so this is a correctness assertion, not a cosmetic one.
      await connection.execute('begin');
      try {
        await connection.query('insert into guard.blocked_domains (domain) values ($1)', [
          'mailinator.com',
        ]);

        for (const response of [
          await callHook({ user: { email: 'p@mailinator.com' } }),
          await callHook(null),
          await callHook({ user: { email: 12345 } }),
        ]) {
          const error = response['error'] as { http_code: number; message: string };
          expect(error.message.length).toBeGreaterThan(0);
          expect(error.http_code).toBeGreaterThanOrEqual(400);
        }
      } finally {
        await connection.execute('rollback');
      }
    });

    it('never leaks internals in a rejection message', async () => {
      await connection.execute('begin');
      try {
        await connection.query(
          'insert into guard.blocked_domains (domain, source) values ($1, $2)',
          ['mailinator.com', 'disposable-email-domains'],
        );

        const response = await callHook({ user: { email: 'person@mailinator.com' } });
        const message = JSON.stringify(response);

        // No provider, no table, no function, no schema, no SQLSTATE, no checksum.
        for (const secret of [
          'disposable-email-domains',
          'blocked_domains',
          'allowed_domains',
          'sync_metadata',
          'guard.',
          'is_disposable_domain',
          'normalize_domain',
          'SQLSTATE',
          'mailinator',
        ]) {
          expect(message).not.toContain(secret);
        }
      } finally {
        await connection.execute('rollback');
      }
    });

    it('uses a different message for engine failure than for policy rejection', async () => {
      // An operator reading logs, and a client showing a message, must be able to
      // tell "we refuse this address" apart from "we could not check".
      await connection.execute('begin');
      try {
        await connection.query('insert into guard.blocked_domains (domain) values ($1)', [
          'mailinator.com',
        ]);
        const policy = await callHook({ user: { email: 'p@mailinator.com' } });

        await connection.execute('drop function guard.is_disposable_domain(text)');
        const failure = await callHook({ user: { email: 'p@gmail.com' } });

        expect(policy).toEqual(REJECT_DISPOSABLE);
        expect(failure).toEqual(REJECT_UNAVAILABLE);
        expect(policy).not.toEqual(failure);
      } finally {
        await connection.execute('rollback');
      }
    });
  });

  describe('infrastructure failure fails closed', () => {
    /**
     * Damages the policy layer inside a transaction, calls the hook, and rolls back.
     *
     * The damage is real while the assertion runs and gone the instant it finishes,
     * so nothing is permanently weakened to make the test pass.
     */
    async function withDamage(
      damage: string,
      assertion: (response: HookResponse) => Promise<void> | void,
    ): Promise<void> {
      await connection.execute('begin');
      try {
        await connection.execute(damage);
        await assertion(await callHook({ user: { email: 'person@gmail.com' } }));
      } finally {
        await connection.execute('rollback');
      }
    }

    it.each([
      ['the lookup function is dropped', 'drop function guard.is_disposable_domain(text)'],
      ['the blocklist table is dropped', 'drop table guard.blocked_domains cascade'],
      ['the allowlist table is dropped', 'drop table guard.allowed_domains cascade'],
      ['the normaliser is dropped', 'drop function guard.normalize_domain(text) cascade'],
      [
        'the whole schema is emptied',
        'drop table guard.blocked_domains, guard.allowed_domains cascade',
      ],
    ])('rejects the signup when %s', async (_label, damage) => {
      await withDamage(damage, (response) => {
        // The decision this branch turns on: a policy engine that cannot answer has
        // not said "allow". Treating silence as approval would let one revoked
        // privilege disable the whole filter while every signup keeps succeeding.
        expect(response).toEqual(REJECT_UNAVAILABLE);
        expect(response).not.toEqual(ALLOW);
      });
    });

    it('does not leak the SQL error to the client', async () => {
      await withDamage('drop function guard.is_disposable_domain(text)', (response) => {
        const message = JSON.stringify(response);

        expect(message).not.toContain('does not exist');
        expect(message).not.toContain('42883');
        expect(message).not.toContain('guard.');
        expect(message).toContain('Signup could not be validated');
      });
    });

    it('keeps the transaction usable after a caught failure', async () => {
      // The exception handler runs in a subtransaction. If it did not, the caught
      // error would poison GoTrue's signup transaction and the clean error response
      // would never reach the client.
      await connection.execute('begin');
      try {
        await connection.execute('drop function guard.is_disposable_domain(text)');

        expect(await callHook({ user: { email: 'a@gmail.com' } })).toEqual(REJECT_UNAVAILABLE);
        // A poisoned transaction would fail this query with 25P02.
        expect(await scalar<number>('select 1 as value')).toBe(1);
      } finally {
        await connection.execute('rollback');
      }
    });

    it('does not send the diagnostic to the client at default settings', async () => {
      // RAISE LOG writes the real SQLSTATE and message to the PostgreSQL server log
      // for the operator, and LOG sits above the default client_min_messages so the
      // caller never receives it. Both halves matter.
      await withDamage('drop function guard.is_disposable_domain(text)', (response) => {
        expect(JSON.stringify(response)).not.toContain('42883');
      });
    });
  });

  describe('no side effects', () => {
    it('changes no policy data, whatever the verdict', async () => {
      await connection.execute('begin');
      try {
        await connection.query(
          'insert into guard.blocked_domains (domain, source) values ($1, $2)',
          ['mailinator.com', 'integration-fixture'],
        );
        await connection.query(
          'insert into guard.allowed_domains (domain, reason) values ($1, $2)',
          ['corp.example', 'integration-fixture'],
        );

        const snapshot = async (): Promise<string> =>
          JSON.stringify({
            blocked: (
              await connection.query<{ domain: string }>(
                'select domain from guard.blocked_domains order by domain',
              )
            ).rows,
            allowed: (
              await connection.query<{ domain: string }>(
                'select domain from guard.allowed_domains order by domain',
              )
            ).rows,
            metadata: (
              await connection.query<{ source: string }>(
                'select source, status from guard.sync_metadata order by source',
              )
            ).rows,
            migrations: (
              await connection.query<{ version: string }>(
                'select version from guard.schema_migrations order by version',
              )
            ).rows,
          });

        const before = await snapshot();

        // Every branch of the function: allow, reject, allowlist override, no email,
        // absent user, corruption, malformed email type.
        await callHook({ user: { email: 'person@gmail.com' } });
        await callHook({ user: { email: 'person@mailinator.com' } });
        await callHook({ user: { email: 'person@corp.example' } });
        await callHook({ user: { email: '' } });
        await callHook({});
        await callHook(null);
        await callHook({ user: { email: 12345 } });

        expect(await snapshot()).toBe(before);
      } finally {
        await connection.execute('rollback');
      }
    });

    it('writes nothing when called outside a transaction', async () => {
      // The suite's other cases run inside a rolled-back transaction, which would
      // hide a write. This one deliberately does not.
      const before = await scalar<number>(
        'select (select count(*) from guard.blocked_domains) + (select count(*) from guard.allowed_domains) + (select count(*) from guard.sync_metadata) as value',
      );

      await callHook({ user: { email: 'person@gmail.com' } });
      await callHook({ user: { email: 'person@mailinator.com' } });

      expect(
        await scalar<number>(
          'select (select count(*) from guard.blocked_domains) + (select count(*) from guard.allowed_domains) + (select count(*) from guard.sync_metadata) as value',
        ),
      ).toBe(before);
    });

    it('never touches auth.users', async () => {
      // The tool's standing guarantee. Asserted here because the hook is the first
      // component that runs inside an auth flow at all.
      const references = await connection.query<{ definition: string }>(
        `select pg_catalog.pg_get_functiondef(p.oid) as definition
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'guard'`,
      );

      for (const row of references.rows) {
        expect(row.definition).not.toMatch(/\bauth\.users\b/);
        expect(row.definition).not.toMatch(/\bauth\./);
      }
    });

    it('makes no remote call and reads no extension', async () => {
      const definition = await scalar<string>(
        `select pg_catalog.pg_get_functiondef('guard.before_user_created(jsonb)'::regprocedure) as value`,
      );

      // Matched as calls, not as bare substrings: "http" legitimately occurs inside
      // the `http_code` response key, and asserting on that would fail for the wrong
      // reason while catching nothing.
      for (const forbidden of [
        /\bhttp_(get|post|put|delete|head|patch)\s*\(/, // pgsql-http
        /\bnet\.http_/, // pg_net
        /\bdblink\w*\s*\(/,
        /\bcron\.schedule\b/,
        /\bpostgres_fdw\b/,
        /\bpg_read_file\b/,
        /\bcopy\s+\w+\s+from\b/,
        /\bdns\w*\s*\(/,
      ]) {
        expect(definition?.toLowerCase() ?? '').not.toMatch(forbidden);
      }

      // And positively: the only non-builtin thing it calls is the policy engine.
      expect(definition).toContain('guard.is_disposable_domain');
    });
  });

  describe('privilege boundaries', () => {
    it('grants supabase_auth_admin exactly what the hook needs', async (ctx) => {
      if (!authRolePresent) ctx.skip();

      for (const [object, privilege, probe] of [
        ['guard', 'USAGE', 'has_schema_privilege'],
        ['guard.before_user_created(jsonb)', 'EXECUTE', 'has_function_privilege'],
        ['guard.is_disposable_domain(text)', 'EXECUTE', 'has_function_privilege'],
        ['guard.normalize_domain(text)', 'EXECUTE', 'has_function_privilege'],
        ['guard.blocked_domains', 'SELECT', 'has_table_privilege'],
        ['guard.allowed_domains', 'SELECT', 'has_table_privilege'],
      ] as const) {
        expect(
          await scalar(`select ${probe}($1, $2, $3) as value`, [AUTH_ROLE, object, privilege]),
          `${AUTH_ROLE} should have ${privilege} on ${object}`,
        ).toBe(true);
      }
    });

    it('grants supabase_auth_admin no write access to the policy lists', async (ctx) => {
      if (!authRolePresent) ctx.skip();

      // A write grant here would let a compromised auth service allowlist a domain
      // and walk straight through its own filter.
      for (const table of [
        'guard.blocked_domains',
        'guard.allowed_domains',
        'guard.sync_metadata',
        'guard.schema_migrations',
      ]) {
        for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES']) {
          expect(
            await scalar('select has_table_privilege($1, $2, $3) as value', [
              AUTH_ROLE,
              table,
              privilege,
            ]),
            `${AUTH_ROLE} must not have ${privilege} on ${table}`,
          ).toBe(false);
        }
      }
    });

    it('grants supabase_auth_admin no CREATE on the schema and no read of operational state', async (ctx) => {
      if (!authRolePresent) ctx.skip();

      expect(
        await scalar('select has_schema_privilege($1, $2, $3) as value', [
          AUTH_ROLE,
          'guard',
          'CREATE',
        ]),
      ).toBe(false);

      // The hook reads neither, so neither is granted.
      for (const table of ['guard.sync_metadata', 'guard.schema_migrations']) {
        expect(
          await scalar('select has_table_privilege($1, $2, $3) as value', [
            AUTH_ROLE,
            table,
            'SELECT',
          ]),
        ).toBe(false);
      }
    });

    it('grants supabase_auth_admin no execute on the functions the hook does not call', async (ctx) => {
      if (!authRolePresent) ctx.skip();

      for (const signature of ['guard.is_blocked_domain(text)', 'guard.is_allowed_domain(text)']) {
        expect(
          await scalar('select has_function_privilege($1, $2, $3) as value', [
            AUTH_ROLE,
            signature,
            'EXECUTE',
          ]),
        ).toBe(false);
      }
    });

    it('does not let PUBLIC execute the hook', async () => {
      expect(
        await scalar('select has_function_privilege($1, $2, $3) as value', [
          'public',
          'guard.before_user_created(jsonb)',
          'EXECUTE',
        ]),
      ).toBe(false);
    });

    it('does not let anon or authenticated execute the hook', async (ctx) => {
      if (clientRoles.length === 0) ctx.skip();

      for (const role of clientRoles) {
        expect(
          await scalar('select has_function_privilege($1, $2, $3) as value', [
            role,
            'guard.before_user_created(jsonb)',
            'EXECUTE',
          ]),
          `${role} must not be able to execute the hook`,
        ).toBe(false);
        expect(
          await scalar('select has_schema_privilege($1, $2, $3) as value', [
            role,
            'guard',
            'USAGE',
          ]),
        ).toBe(false);
      }
    });

    it('does not give anon or authenticated new access to the policy lists', async (ctx) => {
      if (clientRoles.length === 0) ctx.skip();

      // Adding the hook must not widen anything for the client roles as a side
      // effect. This re-asserts the 005 guarantee after 006 and 007 have run.
      for (const role of clientRoles) {
        for (const table of ['guard.blocked_domains', 'guard.allowed_domains']) {
          for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
            expect(
              await scalar('select has_table_privilege($1, $2, $3) as value', [
                role,
                table,
                privilege,
              ]),
            ).toBe(false);
          }
        }
      }
    });

    it('leaves no guard function executable by PUBLIC after the new migrations', async () => {
      // Migration 006 adds a function, and PostgreSQL grants PUBLIC EXECUTE on every
      // new one. This is the invariant that catches a migration which forgot the
      // revoke required by migrations/README.md rule 8.
      const result = await connection.query<{ proname: string }>(
        `select p.proname
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'guard' and has_function_privilege('public', p.oid, 'EXECUTE')`,
      );

      expect(result.rows).toEqual([]);
    });

    it('still uses no SECURITY DEFINER function anywhere in guard', async () => {
      const result = await connection.query<{ proname: string }>(
        `select p.proname
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'guard' and p.prosecdef`,
      );

      expect(result.rows).toEqual([]);
    });
  });

  describe('execution as supabase_auth_admin', () => {
    /**
     * Runs a body with the session role set to `supabase_auth_admin`.
     *
     * This is the test that matters most in the file. A hook that works as the owner
     * but fails as `supabase_auth_admin` is broken for real Supabase Auth, and the
     * owner's implicit privileges hide exactly that failure.
     */
    async function asAuthRole<T>(body: () => Promise<T>): Promise<T> {
      await connection.execute(`set role ${AUTH_ROLE}`);
      try {
        return await body();
      } finally {
        await connection.execute('reset role');
      }
    }

    it('runs the whole policy path under the real role', async (ctx) => {
      if (!authRolePresent) ctx.skip();

      await connection.execute('begin');
      try {
        await connection.query(
          'insert into guard.blocked_domains (domain, source) values ($1, $2)',
          ['mailinator.com', 'integration-fixture'],
        );

        await asAuthRole(async () => {
          expect(await scalar<string>('select current_user as value')).toBe(AUTH_ROLE);

          expect(await callHook({ user: { email: 'person@gmail.com' } })).toEqual(ALLOW);
          expect(await callHook({ user: { email: 'person@mailinator.com' } })).toEqual(
            REJECT_DISPOSABLE,
          );
          expect(await callHook({ user: { email: 'PERSON@MAILINATOR.COM' } })).toEqual(
            REJECT_DISPOSABLE,
          );
          expect(await callHook({ user: { email: '' } })).toEqual(ALLOW);
          expect(await callHook({})).toEqual(ALLOW);
        });
      } finally {
        await connection.execute('rollback');
      }
    });

    it('honours allowlist precedence under the real role', async (ctx) => {
      if (!authRolePresent) ctx.skip();

      await connection.execute('begin');
      try {
        await connection.query('insert into guard.blocked_domains (domain) values ($1)', [
          'mailinator.com',
        ]);
        await connection.query('insert into guard.allowed_domains (domain) values ($1)', [
          'mailinator.com',
        ]);

        await asAuthRole(async () => {
          expect(await callHook({ user: { email: 'person@mailinator.com' } })).toEqual(ALLOW);
        });
      } finally {
        await connection.execute('rollback');
      }
    });

    it('cannot write to the policy lists under the real role', async (ctx) => {
      if (!authRolePresent) ctx.skip();

      await connection.execute('begin');
      try {
        await asAuthRole(async () => {
          // Attempted as real statements, not just as catalog assertions: this is
          // what a compromised auth service would actually try. Allowlisting its own
          // domain is the specific attack the write revokes exist to stop.
          for (const statement of [
            'insert into guard.allowed_domains (domain) values ($1)',
            'insert into guard.blocked_domains (domain) values ($1)',
            'delete from guard.blocked_domains where domain = $1',
            'update guard.blocked_domains set source = $1',
          ]) {
            expect(await sqlstateOf(statement, 'attacker.example'), statement).toBe('42501');
          }
        });
      } finally {
        await connection.execute('rollback');
      }
    });

    it('fails closed under the real role when a privilege is revoked', async (ctx) => {
      if (!authRolePresent) ctx.skip();

      await connection.execute('begin');
      try {
        await connection.query('insert into guard.blocked_domains (domain) values ($1)', [
          'mailinator.com',
        ]);
        await connection.execute(`revoke select on guard.blocked_domains from ${AUTH_ROLE}`);

        await asAuthRole(async () => {
          // Note which domain is used: a BLOCKED one. If a revoked privilege were
          // silently treated as "not found", this would wrongly return allow.
          expect(await callHook({ user: { email: 'person@mailinator.com' } })).toEqual(
            REJECT_UNAVAILABLE,
          );
          expect(await callHook({ user: { email: 'person@gmail.com' } })).toEqual(
            REJECT_UNAVAILABLE,
          );
        });
      } finally {
        await connection.execute('rollback');
      }
    });

    it('fails closed under the real role when EXECUTE on the lookup is revoked', async (ctx) => {
      if (!authRolePresent) ctx.skip();

      await connection.execute('begin');
      try {
        await connection.execute(
          `revoke execute on function guard.is_disposable_domain(text) from ${AUTH_ROLE}`,
        );

        await asAuthRole(async () => {
          expect(await callHook({ user: { email: 'person@gmail.com' } })).toEqual(
            REJECT_UNAVAILABLE,
          );
        });
      } finally {
        await connection.execute('rollback');
      }
    });

    it('still allows email-less signups when the policy engine is unreachable', async (ctx) => {
      if (!authRolePresent) ctx.skip();

      // The two decisions are independent by construction: there is no email to
      // judge, so the engine is never consulted and its state is irrelevant. A
      // phone-only signup must not be collateral damage from a broken blocklist.
      await connection.execute('begin');
      try {
        await connection.execute(`revoke select on guard.blocked_domains from ${AUTH_ROLE}`);

        await asAuthRole(async () => {
          expect(await callHook({ user: { email: '', phone: '+15550100' } })).toEqual(ALLOW);
        });
      } finally {
        await connection.execute('rollback');
      }
    });
  });

  describe('reported status', () => {
    it('reports the hook function as installed and the layer as complete', async () => {
      const status = await readGuardSchemaStatus(connection);

      expect(status.hookFunctionInstalled).toBe(true);
      expect(status.health).toBe('complete');
      expect(status.missingObjects).toEqual([]);
      expect(
        statusExitCode({
          target: connection.target,
          schema: status,
          remote: { kind: 'not-checked' },
        }),
      ).toBe(EXIT_CODES.success);
    });

    it('reports the grants honestly for this server', async () => {
      const status = await readGuardSchemaStatus(connection);

      if (authRolePresent) {
        // The list in schema-status.ts and the grants in 007 must agree. If they
        // drift, this names exactly which privilege is missing.
        expect(status.missingAuthHookGrants).toEqual([]);
        expect(status.authHookGrants).toBe('granted');
      } else {
        // Not a vacuous pass: on a plain PostgreSQL server the correct answer is
        // "cannot be verified here", and it must not fail the health check.
        expect(status.authHookGrants).toBe('role-absent');
      }
    });

    it('reports a dropped hook function as incomplete rather than healthy', async () => {
      await connection.execute('begin');
      try {
        await connection.execute('drop function guard.before_user_created(jsonb)');

        const status = await readGuardSchemaStatus(connection);

        expect(status.hookFunctionInstalled).toBe(false);
        expect(status.health).toBe('incomplete');
        expect(status.missingObjects).toContain('guard.before_user_created(jsonb)');
        // The migration history still claims 006 was applied, which is why object
        // probing cannot be replaced by trusting the history.
        expect(status.pending).toEqual([]);
        expect(
          statusExitCode({
            target: connection.target,
            schema: status,
            remote: { kind: 'not-checked' },
          }),
        ).toBe(EXIT_CODES.guardHealth);
      } finally {
        await connection.execute('rollback');
      }
    });

    it('reports revoked grants as an incomplete installation', async (ctx) => {
      if (!authRolePresent) ctx.skip();

      await connection.execute('begin');
      try {
        await connection.execute(`revoke select on guard.blocked_domains from ${AUTH_ROLE}`);

        const status = await readGuardSchemaStatus(connection);

        expect(status.authHookGrants).toBe('incomplete');
        expect(status.missingAuthHookGrants).toEqual(['SELECT on guard.blocked_domains']);
        // Every object still exists, so only the grant check can catch this. Without
        // it, `status` would call a hook that rejects every signup "healthy".
        expect(status.missingObjects).toEqual([]);
        expect(status.health).toBe('incomplete');
        expect(
          statusExitCode({
            target: connection.target,
            schema: status,
            remote: { kind: 'not-checked' },
          }),
        ).toBe(EXIT_CODES.guardHealth);
      } finally {
        await connection.execute('rollback');
      }
    });
  });

  describe('grants that migration 007 never issued', () => {
    /**
     * The one operational gap the conditional migration cannot close.
     *
     * 007_auth_hook_permissions.sql wraps every GRANT in a check that
     * `supabase_auth_admin` exists, because the role is absent on a plain PostgreSQL
     * server. That check runs ONCE, when the migration is applied. If the role is
     * created afterwards, the grants do not appear -- and `install` will not replay
     * 007, because applied migrations are never re-run.
     *
     * The state below is exactly that: the schema is whole, 007 is recorded as
     * applied, the role exists, and it holds nothing. It is produced by revoking
     * inside a transaction that is rolled back, so nothing is permanently weakened.
     */
    async function withNoGrants(body: () => Promise<void>): Promise<void> {
      await connection.execute('begin');
      try {
        await connection.execute(`revoke all on schema guard from ${AUTH_ROLE}`);
        await connection.execute(`revoke all on all tables in schema guard from ${AUTH_ROLE}`);
        await connection.execute(
          `revoke all privileges on all functions in schema guard from ${AUTH_ROLE}`,
        );
        await body();
      } finally {
        await connection.execute('rollback');
      }
    }

    it('reports every missing grant even though 007 is recorded as applied', async (ctx) => {
      if (!authRolePresent) ctx.skip();

      await withNoGrants(async () => {
        const status = await readGuardSchemaStatus(connection);

        // The history is intact and says 007 applied -- which is true, it ran and
        // took its no-op branch. Trusting it would report this database healthy.
        expect(status.applied.map((row) => row.version)).toContain('007');
        expect(status.pending).toEqual([]);
        expect(status.missingObjects).toEqual([]);

        // The catalog probe is what actually catches it, and it names all six.
        expect(status.authHookGrants).toBe('incomplete');
        expect(status.missingAuthHookGrants).toEqual([
          'USAGE on guard',
          'EXECUTE on guard.before_user_created(jsonb)',
          'EXECUTE on guard.is_disposable_domain(text)',
          'EXECUTE on guard.normalize_domain(text)',
          'SELECT on guard.blocked_domains',
          'SELECT on guard.allowed_domains',
        ]);

        expect(status.health).toBe('incomplete');
        expect(
          statusExitCode({
            target: connection.target,
            schema: status,
            remote: { kind: 'not-checked' },
          }),
        ).toBe(EXIT_CODES.guardHealth);
      });
    });

    it('is repaired by the snippet the README documents', async (ctx) => {
      if (!authRolePresent) ctx.skip();

      const repair = await readDocumentedGrantRepair();

      await withNoGrants(async () => {
        expect((await readGuardSchemaStatus(connection)).authHookGrants).toBe('incomplete');

        await connection.execute(repair);

        const repaired = await readGuardSchemaStatus(connection);
        expect(repaired.authHookGrants).toBe('granted');
        expect(repaired.missingAuthHookGrants).toEqual([]);
        expect(repaired.health).toBe('complete');
        expect(
          statusExitCode({
            target: connection.target,
            schema: repaired,
            remote: { kind: 'not-checked' },
          }),
        ).toBe(EXIT_CODES.success);
      });
    });

    it('grants nothing wider than 007 does', async (ctx) => {
      if (!authRolePresent) ctx.skip();

      const repair = await readDocumentedGrantRepair();

      await withNoGrants(async () => {
        await connection.execute(repair);

        // Everything 007 deliberately withholds must still be withheld. A repair
        // snippet that quietly hands over more than the migration would is worse
        // than the gap it fixes.
        for (const [object, privilege] of [
          ['guard.blocked_domains', 'INSERT'],
          ['guard.blocked_domains', 'UPDATE'],
          ['guard.blocked_domains', 'DELETE'],
          ['guard.allowed_domains', 'INSERT'],
          ['guard.allowed_domains', 'UPDATE'],
          ['guard.allowed_domains', 'DELETE'],
          ['guard.sync_metadata', 'SELECT'],
          ['guard.schema_migrations', 'SELECT'],
        ] as const) {
          expect(
            await scalar<boolean>('select has_table_privilege($1, $2, $3) as value', [
              AUTH_ROLE,
              object,
              privilege,
            ]),
          ).toBe(false);
        }

        expect(
          await scalar<boolean>('select has_schema_privilege($1, $2, $3) as value', [
            AUTH_ROLE,
            'guard',
            'CREATE',
          ]),
        ).toBe(false);

        for (const signature of [
          'guard.is_blocked_domain(text)',
          'guard.is_allowed_domain(text)',
        ]) {
          expect(
            await scalar<boolean>('select has_function_privilege($1, $2, $3) as value', [
              AUTH_ROLE,
              signature,
              'EXECUTE',
            ]),
          ).toBe(false);
        }
      });
    });

    it('is idempotent and safe to run when the grants are already correct', async (ctx) => {
      if (!authRolePresent) ctx.skip();

      const repair = await readDocumentedGrantRepair();

      // No revoke here: this is the healthy database, and the snippet must be a
      // no-op on it rather than something an operator has to reason about first.
      await connection.execute('begin');
      try {
        await connection.execute(repair);
        await connection.execute(repair);

        const status = await readGuardSchemaStatus(connection);
        expect(status.authHookGrants).toBe('granted');
        expect(status.health).toBe('complete');
      } finally {
        await connection.execute('rollback');
      }
    });

    it('runs without error on a server that has no supabase_auth_admin', async () => {
      // The role guard is not decoration: an operator on a plain PostgreSQL database
      // must be able to paste this without it failing. Asserted unconditionally by
      // pointing the check at a role name that cannot exist.
      const repair = (await readDocumentedGrantRepair()).replaceAll(
        AUTH_ROLE,
        'guard_absent_role_for_test',
      );

      await connection.execute('begin');
      try {
        await expect(connection.execute(repair)).resolves.not.toThrow();
      } finally {
        await connection.execute('rollback');
      }
    });
  });

  describe('the lookup path', () => {
    it('resolves the blocklist through the primary key index', async () => {
      // The hook sits in the signup path, so the plan matters. A sequential scan
      // over a full disposable-domain list would be a real regression.
      await connection.execute('begin');
      try {
        await connection.execute(
          `insert into guard.blocked_domains (domain, source)
           select 'domain' || g || '.example', 'perf-fixture'
           from generate_series(1, 20000) g`,
        );
        await connection.execute('analyze guard.blocked_domains');

        const plan = await connection.query<{ 'QUERY PLAN': string }>(
          `explain (costs off) select 1 from guard.blocked_domains b where b.domain = 'domain500.example'`,
        );
        const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');

        expect(text).toContain('blocked_domains_pkey');
        expect(text).not.toContain('Seq Scan');
      } finally {
        await connection.execute('rollback');
      }
    });
  });
});
