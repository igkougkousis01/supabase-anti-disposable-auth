/**
 * Live PostgreSQL tests for optional strict mode.
 *
 * ⚠️  THESE TESTS ARE DESTRUCTIVE WITHIN THE `guard` SCHEMA **AND** WITHIN A SYNTHETIC
 *     `auth` SCHEMA THAT THEY CREATE THEMSELVES.
 *
 * Unlike every other suite in this directory, these tests need an `auth.users` table,
 * because the whole feature is a trigger on one. A plain PostgreSQL server has no such
 * table, so the suite builds a **minimal synthetic fixture** with only the columns the
 * trigger touches.
 *
 * **This is not equivalent to Supabase.** What it validates is PostgreSQL trigger
 * semantics — firing rules, column filters, fail-closed behaviour, catalog shape and
 * privilege behaviour — against the real engine. It does not validate Supabase Auth,
 * GoTrue's write paths, or the real managed `auth` schema, and nothing here should be
 * read as claiming otherwise.
 *
 * ## The scratch-database guard
 *
 * SADA_TEST_DB_URL must point at a throwaway database, exactly as the other suites
 * require. Because this one creates and drops an `auth` schema, it additionally refuses
 * to run at all if it finds an `auth` schema it did not create: the suite stamps its own
 * fixture with a marker comment, and an unmarked `auth` schema aborts the run with a
 * loud error rather than being dropped. Failing loudly is deliberate — a developer who
 * pointed this at a real project must not see a quiet skip and assume the tests passed.
 *
 * ## Supabase-specific roles
 *
 * The tests that matter most — writing to `auth.users` as `supabase_auth_admin`, and
 * proving fail-closed behaviour under a role that is not the owner — need a role a plain
 * server does not have. They SKIP explicitly when it is absent rather than running as
 * the owner and reporting a vacuous pass, because the owner's implicit privileges hide
 * precisely the failures those tests exist to catch.
 *
 * To run them locally, create the role once on your scratch server:
 *
 *   psql -d supabase_anti_disposable_auth_test -c "create role supabase_auth_admin nologin"
 *
 * and drop it when you are done. Roles are cluster-wide, which is why this is a
 * documented manual step and not something the suite does to you.
 *
 * The fixture grants that role ordinary INSERT/UPDATE/SELECT on the synthetic
 * `auth.users`. On hosted Supabase the role OWNS the table instead. That difference is a
 * known limitation of the fixture and is documented rather than papered over.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runStrictDisable, runStrictEnable, runStrictStatus } from '../../src/commands/strict.js';
import { createPostgresConnection } from '../../src/database/client.js';
import { runMigrations } from '../../src/database/migrations.js';
import {
  readStrictTriggerState,
  AUTH_USERS_TABLE,
  EXPECTED_TRIGGER_TYPE,
  STRICT_TRIGGER_FUNCTION,
  STRICT_TRIGGER_NAME,
} from '../../src/database/strict-trigger.js';
import type { DatabaseConnection, SqlParameter } from '../../src/database/types.js';
import { EXIT_CODES, GuardHealthError, StrictTriggerConflictError } from '../../src/lib/errors.js';
import { rejection } from '../helpers/errors.js';

const testDatabaseUrl = process.env['SADA_TEST_DB_URL'];
const describeIfConfigured = testDatabaseUrl === undefined ? describe.skip : describe;

/** Stamped on the synthetic schema so the suite can tell its own fixture from a real one. */
const FIXTURE_MARKER = 'supabase-anti-disposable-auth integration fixture -- safe to drop';

const AUTH_ROLE = 'supabase_auth_admin';

/** An unrelated trigger, standing in for the `on_auth_user_created` pattern Supabase documents. */
const UNRELATED_TRIGGER = 'zz_unrelated_integration_trigger';

let connection: DatabaseConnection;
let authRolePresent = false;

/**
 * Whether this suite created the `auth` schema currently in the database.
 *
 * Teardown is gated on it, and that gate is not decoration. `afterAll` runs even when
 * `beforeAll` threw, so without this flag the safety abort below would refuse to touch a
 * foreign `auth` schema on the way in and then drop it on the way out -- the exact
 * catastrophe the abort exists to prevent.
 */
let fixtureIsOurs = false;

/**
 * The live connection, with `close()` neutered.
 *
 * The `strict` commands own their connection lifecycle and close it when they finish,
 * which is correct for the CLI and fatal for a suite that shares one connection across
 * every test. Everything else is passed straight through, so the commands run against a
 * real server exactly as they would in production.
 */
const shared: DatabaseConnection = {
  get target() {
    return connection.target;
  },
  async query<Row extends Record<string, unknown>>(sql: string, parameters?: SqlParameter[]) {
    return connection.query<Row>(sql, parameters);
  },
  async execute(sql: string) {
    return connection.execute(sql);
  },
  async close() {
    return undefined;
  },
};

function dependencies() {
  return { env: { SUPABASE_DB_URL: testDatabaseUrl as string }, connect: async () => shared };
}

async function scalar<T>(sql: string, parameters: SqlParameter[] = []): Promise<T | undefined> {
  const result = await connection.query<{ value: T }>(sql, parameters);
  return result.rows[0]?.value;
}

async function roleExists(role: string): Promise<boolean> {
  return (
    (await scalar<boolean>(
      'select exists (select 1 from pg_catalog.pg_roles where rolname = $1) as value',
      [role],
    )) === true
  );
}

/**
 * Refuses to touch an `auth` schema this suite did not create.
 *
 * A real Supabase `auth` schema behind SADA_TEST_DB_URL is a configuration mistake with
 * catastrophic consequences, so it aborts the run instead of dropping anything.
 */
async function assertAuthSchemaIsOursOrAbsent(): Promise<void> {
  const present = await scalar<boolean>(
    "select exists (select 1 from pg_catalog.pg_namespace where nspname = 'auth') as value",
  );
  if (present !== true) {
    return;
  }

  const comment = await scalar<string | null>(
    "select pg_catalog.obj_description(oid, 'pg_namespace') as value from pg_catalog.pg_namespace where nspname = 'auth'",
  );

  if (comment === FIXTURE_MARKER) {
    // Left behind by an interrupted previous run. Ours to clean up.
    fixtureIsOurs = true;
    return;
  }

  throw new Error(
    'SADA_TEST_DB_URL points at a database with an `auth` schema this suite did not create. ' +
      'Refusing to touch it. Point SADA_TEST_DB_URL at a throwaway database instead — ' +
      'these tests drop and recreate `auth`.',
  );
}

/** Drops the synthetic schema. Only ever called once {@link fixtureIsOurs} is true. */
async function dropFixture(): Promise<void> {
  if (!fixtureIsOurs) {
    return;
  }

  await connection.execute('drop schema if exists auth cascade');
  fixtureIsOurs = false;
}

/**
 * The minimal synthetic `auth.users`.
 *
 * `email` is `varchar(255)` and nullable, matching GoTrue's own
 * `00_init_auth_schema.up.sql`, because both facts are load-bearing: the nullability is
 * what phone-only and anonymous accounts rely on, and the type is what the trigger
 * function's explicit `::text` cast exists for.
 */
async function createFixture(): Promise<void> {
  fixtureIsOurs = true;
  await connection.execute(`
    create schema auth;

    comment on schema auth is '${FIXTURE_MARKER}';

    create table auth.users (
      id uuid primary key default gen_random_uuid(),
      email varchar(255) null,
      phone text null,
      raw_user_meta_data jsonb null,
      is_anonymous boolean not null default false
    );
  `);

  if (authRolePresent) {
    // An approximation of Supabase's model: on a hosted project this role OWNS the
    // table. Ordinary DML grants are the closest a plain fixture can get without
    // handing the role privileges it does not have on Supabase.
    await connection.execute(`
      grant usage on schema auth to ${AUTH_ROLE};
      grant select, insert, update on auth.users to ${AUTH_ROLE};
    `);
  }
}

async function seedPolicy(): Promise<void> {
  await connection.query(
    "insert into guard.blocked_domains (domain, source) values ($1, 'integration-fixture') on conflict do nothing",
    ['mailinator.com'],
  );
}

async function insertUser(email: string | null): Promise<void> {
  await connection.query('insert into auth.users (email) values ($1)', [email]);
}

async function countUsers(email: string): Promise<number> {
  return (
    (await scalar<number>('select count(*)::int as value from auth.users where email = $1', [
      email,
    ])) ?? 0
  );
}

/** Runs `body` inside a transaction that is always rolled back. */
async function inRolledBackTransaction(body: () => Promise<void>): Promise<void> {
  await connection.execute('begin');
  try {
    await body();
  } finally {
    await connection.execute('rollback');
  }
}

async function asRole<T>(role: string, body: () => Promise<T>): Promise<T> {
  await connection.execute(`set role ${role}`);
  try {
    return await body();
  } finally {
    // Tolerant on purpose: a fail-closed test leaves the transaction aborted, and the
    // failure the test is asserting on must not be replaced by a cleanup error. The
    // enclosing ROLLBACK reverts the SET either way.
    await connection.execute('reset role').catch(() => undefined);
  }
}

/**
 * Asserts a write is rejected, and leaves the transaction usable afterwards.
 *
 * A failed statement aborts the whole transaction, so a test that wants to keep going --
 * to prove nothing was written, or to try a second case -- has to rewind to a savepoint.
 */
async function expectWriteRejected(body: () => Promise<unknown>): Promise<void> {
  await connection.execute('savepoint attempt');
  await expect(body()).rejects.toThrow();
  await connection.execute('rollback to savepoint attempt');
}

describeIfConfigured('strict mode against a live PostgreSQL server', () => {
  beforeAll(async () => {
    connection = await createPostgresConnection({ connectionString: testDatabaseUrl as string });
    authRolePresent = await roleExists(AUTH_ROLE);

    await assertAuthSchemaIsOursOrAbsent();
    await dropFixture();

    await connection.execute('drop schema if exists guard cascade');
    await runMigrations(connection);

    await createFixture();
    await seedPolicy();
  }, 60_000);

  afterAll(async () => {
    if (connection !== undefined) {
      await dropFixture();
      await connection.execute('drop schema if exists guard cascade');
      await connection.close();
    }
  });

  // -------------------------------------------------------------------------
  describe('migration 008', () => {
    it('installs the trigger function', async () => {
      expect(
        await scalar<boolean>('select to_regprocedure($1) is not null as value', [
          STRICT_TRIGGER_FUNCTION,
        ]),
      ).toBe(true);
    });

    it('creates no trigger of its own', async () => {
      // install != enable strict mode. A fresh migration run must leave auth.users
      // completely untouched.
      expect(await readStrictTriggerState(connection)).toEqual({ kind: 'absent' });
    });

    it('makes the function SECURITY INVOKER with a pinned empty search_path', async () => {
      const row = await connection.query<{ secdef: boolean; config: string[] | null }>(
        `select p.prosecdef as secdef, p.proconfig as config
           from pg_catalog.pg_proc p
           join pg_catalog.pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'guard' and p.proname = 'enforce_auth_user_email'`,
      );

      expect(row.rows[0]?.secdef).toBe(false);
      // PostgreSQL stores the pinned empty search_path as the literal `search_path=""`.
      expect(row.rows[0]?.config).toContain('search_path=""');
    });

    it('leaves the function un-executable by PUBLIC', async () => {
      expect(
        await scalar<boolean>("select has_function_privilege('public', $1, 'EXECUTE') as value", [
          STRICT_TRIGGER_FUNCTION,
        ]),
      ).toBe(false);
    });

    it('grants nothing new to the auth role', async (ctx) => {
      if (!authRolePresent) ctx.skip();

      // The empirical claim in the migration's header: PostgreSQL checks EXECUTE on a
      // trigger function when the TRIGGER is created, not when it fires. If that were
      // wrong, this test would pass and the role-execution test below would fail.
      expect(
        await scalar<boolean>('select has_function_privilege($1, $2, $3) as value', [
          AUTH_ROLE,
          STRICT_TRIGGER_FUNCTION,
          'EXECUTE',
        ]),
      ).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('enable and disable', () => {
    afterAll(async () => {
      await connection.execute(
        `drop trigger if exists ${STRICT_TRIGGER_NAME} on ${AUTH_USERS_TABLE}`,
      );
    });

    it('creates exactly one trigger', async () => {
      const report = await runStrictEnable(dependencies());

      expect(report.changed).toBe(true);
      expect(report.verified?.kind).toBe('ours');
      expect(
        await scalar<number>(
          `select count(*)::int as value from pg_catalog.pg_trigger
            where tgrelid = 'auth.users'::regclass and tgname = $1 and not tgisinternal`,
          [STRICT_TRIGGER_NAME],
        ),
      ).toBe(1);
    });

    it('has exactly the catalog shape it claims', async () => {
      const row = await connection.query<{
        tgtype: number;
        tgenabled: string;
        columns: string[];
        fn: string;
      }>(
        `select t.tgtype::int as tgtype,
                t.tgenabled::text as tgenabled,
                (select array_agg(a.attname::text order by a.attnum)
                   from pg_catalog.pg_attribute a
                  where a.attrelid = t.tgrelid and a.attnum = any (t.tgattr::int2[])) as columns,
                t.tgfoid::regprocedure::text as fn
           from pg_catalog.pg_trigger t
          where t.tgrelid = 'auth.users'::regclass and t.tgname = $1`,
        [STRICT_TRIGGER_NAME],
      );

      expect(row.rows[0]?.tgtype).toBe(EXPECTED_TRIGGER_TYPE);
      expect(row.rows[0]?.tgenabled).toBe('O');
      expect(row.rows[0]?.columns).toEqual(['email']);
      expect(row.rows[0]?.fn).toBe(STRICT_TRIGGER_FUNCTION);
    });

    it('is idempotent: running enable again creates no duplicate', async () => {
      const report = await runStrictEnable(dependencies());

      expect(report.action).toBe('no-op');
      expect(
        await scalar<number>(
          `select count(*)::int as value from pg_catalog.pg_trigger
            where tgrelid = 'auth.users'::regclass and tgname = $1 and not tgisinternal`,
          [STRICT_TRIGGER_NAME],
        ),
      ).toBe(1);
    });

    it('reports enabled through status', async () => {
      const report = await runStrictStatus(dependencies());

      expect(report.strict.mode).toBe('enabled');
    });

    it('removes the trigger on disable, and is idempotent', async () => {
      const first = await runStrictDisable(dependencies());
      expect(first.changed).toBe(true);
      expect(first.verified?.kind).toBe('absent');

      const second = await runStrictDisable(dependencies());
      expect(second.action).toBe('no-op');
      expect(second.changed).toBe(false);
    });

    it('leaves the trigger function in place after disable', async () => {
      expect(
        await scalar<boolean>('select to_regprocedure($1) is not null as value', [
          STRICT_TRIGGER_FUNCTION,
        ]),
      ).toBe(true);
    });

    it('executes no DDL under --dry-run', async () => {
      await runStrictEnable(dependencies(), { dryRun: true });

      expect(await readStrictTriggerState(connection)).toEqual({ kind: 'absent' });
    });
  });

  // -------------------------------------------------------------------------
  describe('trigger semantics', () => {
    beforeAll(async () => {
      await runStrictEnable(dependencies());
    });

    afterAll(async () => {
      await runStrictDisable(dependencies());
    });

    it('allows an ordinary address', async () => {
      await inRolledBackTransaction(async () => {
        await insertUser('person@gmail.com');
        expect(await countUsers('person@gmail.com')).toBe(1);
      });
    });

    it('blocks a disposable address', async () => {
      await inRolledBackTransaction(async () => {
        await expect(insertUser('person@mailinator.com')).rejects.toThrow();
      });
    });

    it('blocks a disposable address regardless of case', async () => {
      await inRolledBackTransaction(async () => {
        await expect(insertUser('PERSON@MAILINATOR.COM')).rejects.toThrow();
      });
    });

    it('raises check_violation, not a bare plpgsql exception', async () => {
      // 23514 is deliberate: class 23 says integrity-constraint violation, which is what
      // this is. The default P0001 would say only "some PL/pgSQL raised something".
      await inRolledBackTransaction(async () => {
        const error = await rejection<{ cause?: { code?: string } }>(
          insertUser('person@mailinator.com'),
        );

        expect(error.cause?.code).toBe('23514');
      });
    });

    it('leaks nothing about the policy in its message', async () => {
      await inRolledBackTransaction(async () => {
        const error = await rejection<{ cause?: { message?: string } }>(
          insertUser('person@mailinator.com'),
        );
        const message = error.cause?.message ?? '';

        expect(message).toBe('Email address rejected by database policy');
        for (const secret of ['mailinator', 'blocked_domains', 'allowed_domains', 'guard.']) {
          expect(message).not.toContain(secret);
        }
      });
    });

    it('lets the allowlist override the blocklist', async () => {
      await inRolledBackTransaction(async () => {
        await connection.query(
          "insert into guard.allowed_domains (domain, reason) values ($1, 'integration-fixture')",
          ['mailinator.com'],
        );

        await insertUser('person@mailinator.com');
        expect(await countUsers('person@mailinator.com')).toBe(1);
      });
    });

    it('allows a NULL email, so phone-only and anonymous accounts still work', async () => {
      await inRolledBackTransaction(async () => {
        await insertUser(null);
        expect(
          await scalar<number>('select count(*)::int as value from auth.users where email is null'),
        ).toBe(1);
      });
    });

    it('allows a blank email', async () => {
      await inRolledBackTransaction(async () => {
        await insertUser('');
        expect(await countUsers('')).toBe(1);
      });
    });

    it('allows an address the policy engine cannot parse', async () => {
      // Refusing to classify is not evidence of abuse, and the trigger must not invent
      // a rejection the policy engine never made.
      await inRolledBackTransaction(async () => {
        await insertUser('not-an-address');
        expect(await countUsers('not-an-address')).toBe(1);
      });
    });

    it('blocks an email UPDATE onto a disposable domain', async () => {
      // The case the Before User Created hook structurally cannot see: it runs at
      // creation only, and GoTrue's ConfirmEmailChange() issues an UPDATE.
      await inRolledBackTransaction(async () => {
        await insertUser('person@gmail.com');

        await expect(
          connection.query('update auth.users set email = $1 where email = $2', [
            'person@mailinator.com',
            'person@gmail.com',
          ]),
        ).rejects.toThrow();
      });
    });

    it('allows an email UPDATE onto an allowlisted domain', async () => {
      await inRolledBackTransaction(async () => {
        await connection.query(
          "insert into guard.allowed_domains (domain, reason) values ($1, 'integration-fixture')",
          ['mailinator.com'],
        );
        await insertUser('person@gmail.com');

        await connection.query('update auth.users set email = $1 where email = $2', [
          'person@mailinator.com',
          'person@gmail.com',
        ]);

        expect(await countUsers('person@mailinator.com')).toBe(1);
      });
    });

    it('allows an email UPDATE onto an ordinary domain', async () => {
      await inRolledBackTransaction(async () => {
        await insertUser('person@gmail.com');
        await connection.query('update auth.users set email = $1 where email = $2', [
          'other@gmail.com',
          'person@gmail.com',
        ]);

        expect(await countUsers('other@gmail.com')).toBe(1);
      });
    });

    it('does not fire on an update that does not touch email', async () => {
      // Proven rather than asserted: the policy function is removed inside the
      // transaction, so a trigger that fired would raise "function does not exist".
      // The metadata update succeeds and the email update fails, in one transaction.
      await inRolledBackTransaction(async () => {
        await insertUser('person@gmail.com');
        await connection.execute('drop function guard.is_disposable_domain(text)');

        await connection.query(
          `update auth.users set raw_user_meta_data = '{"seen": true}'::jsonb where email = $1`,
          ['person@gmail.com'],
        );

        await expect(
          connection.query('update auth.users set email = $1 where email = $2', [
            'person@gmail.com',
            'person@gmail.com',
          ]),
        ).rejects.toThrow();
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('fail-closed behaviour', () => {
    beforeAll(async () => {
      await runStrictEnable(dependencies());
    });

    afterAll(async () => {
      await runStrictDisable(dependencies());
    });

    it('aborts the write when the policy function is gone', async () => {
      await inRolledBackTransaction(async () => {
        await connection.execute('drop function guard.is_disposable_domain(text)');

        await expect(insertUser('person@gmail.com')).rejects.toThrow();
      });
    });

    it('aborts the write when the blocklist table is gone', async () => {
      await inRolledBackTransaction(async () => {
        await connection.execute('drop table guard.blocked_domains cascade');

        await expect(insertUser('person@gmail.com')).rejects.toThrow();
      });
    });

    it('aborts the write when the writer cannot read the blocklist', async (ctx) => {
      if (!authRolePresent) ctx.skip();

      await inRolledBackTransaction(async () => {
        await connection.execute(`revoke select on guard.blocked_domains from ${AUTH_ROLE}`);

        await asRole(AUTH_ROLE, async () => {
          await expectWriteRejected(() => insertUser('person@gmail.com'));
        });
      });
    });

    it('aborts the write when the writer cannot execute the policy function', async (ctx) => {
      if (!authRolePresent) ctx.skip();

      await inRolledBackTransaction(async () => {
        await connection.execute(
          `revoke execute on function guard.is_disposable_domain(text) from ${AUTH_ROLE}`,
        );

        await asRole(AUTH_ROLE, async () => {
          await expectWriteRejected(() => insertUser('person@gmail.com'));
        });
      });
    });

    it('aborts the write when the writer loses USAGE on the guard schema', async (ctx) => {
      if (!authRolePresent) ctx.skip();

      await inRolledBackTransaction(async () => {
        await connection.execute(`revoke usage on schema guard from ${AUTH_ROLE}`);

        await asRole(AUTH_ROLE, async () => {
          await expectWriteRejected(() => insertUser('person@gmail.com'));
        });
      });
    });

    it('never allows the write in any damaged state', async () => {
      // The one assertion that must hold across every case above: nothing survived.
      expect(await scalar<number>('select count(*)::int as value from auth.users')).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('execution as supabase_auth_admin', () => {
    beforeAll(async () => {
      await runStrictEnable(dependencies());
    });

    afterAll(async () => {
      await runStrictDisable(dependencies());
    });

    it('fires for the real runtime role using only the grants migration 007 issues', async (ctx) => {
      if (!authRolePresent) ctx.skip();

      await inRolledBackTransaction(async () => {
        await asRole(AUTH_ROLE, async () => {
          await insertUser('person@gmail.com');
          await expectWriteRejected(() => insertUser('person@mailinator.com'));
        });
      });
    });

    it('blocks an email change made by the runtime role', async (ctx) => {
      if (!authRolePresent) ctx.skip();

      await inRolledBackTransaction(async () => {
        await asRole(AUTH_ROLE, async () => {
          await insertUser('person@gmail.com');
          await expectWriteRejected(() =>
            connection.query('update auth.users set email = $1 where email = $2', [
              'person@mailinator.com',
              'person@gmail.com',
            ]),
          );
        });
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('conflicts and unrelated triggers', () => {
    afterAll(async () => {
      await connection.execute(
        `drop trigger if exists ${STRICT_TRIGGER_NAME} on ${AUTH_USERS_TABLE}`,
      );
      await connection.execute(
        `drop trigger if exists ${UNRELATED_TRIGGER} on ${AUTH_USERS_TABLE}`,
      );
      await connection.execute('drop function if exists public.sada_test_noop() cascade');
    });

    it('refuses to touch a trigger that merely shares our name', async () => {
      await connection.execute(`
        create or replace function public.sada_test_noop() returns trigger
        language plpgsql as $$ begin return new; end $$;

        create trigger ${STRICT_TRIGGER_NAME}
          before insert on ${AUTH_USERS_TABLE}
          for each row execute function public.sada_test_noop();
      `);

      const enableError = await rejection<StrictTriggerConflictError>(
        runStrictEnable(dependencies()),
      );
      expect(enableError).toBeInstanceOf(StrictTriggerConflictError);
      expect(enableError.exitCode).toBe(EXIT_CODES.strictConflict);

      const disableError = await rejection<StrictTriggerConflictError>(
        runStrictDisable(dependencies()),
      );
      expect(disableError).toBeInstanceOf(StrictTriggerConflictError);

      // Still there. Neither command removed somebody else's trigger.
      expect(
        await scalar<string>(
          `select p.proname as value from pg_catalog.pg_trigger t
             join pg_catalog.pg_proc p on p.oid = t.tgfoid
            where t.tgrelid = 'auth.users'::regclass and t.tgname = $1`,
          [STRICT_TRIGGER_NAME],
        ),
      ).toBe('sada_test_noop');

      await connection.execute(`drop trigger ${STRICT_TRIGGER_NAME} on ${AUTH_USERS_TABLE}`);
    });

    it('treats an unrelated trigger as none of its business', async () => {
      await connection.execute(`
        create or replace function public.sada_test_noop() returns trigger
        language plpgsql as $$ begin return new; end $$;

        create trigger ${UNRELATED_TRIGGER}
          after insert on ${AUTH_USERS_TABLE}
          for each row execute function public.sada_test_noop();
      `);

      await runStrictEnable(dependencies());
      await runStrictDisable(dependencies());

      expect(
        await scalar<number>(
          `select count(*)::int as value from pg_catalog.pg_trigger
            where tgrelid = 'auth.users'::regclass and tgname = $1 and not tgisinternal`,
          [UNRELATED_TRIGGER],
        ),
      ).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('preflight against a damaged guard layer', () => {
    it('refuses to enable when the policy function is missing', async () => {
      await inRolledBackTransaction(async () => {
        await connection.execute('drop function guard.is_disposable_domain(text) cascade');

        const error = await rejection<GuardHealthError>(runStrictEnable(dependencies()));

        expect(error).toBeInstanceOf(GuardHealthError);
        expect(error.exitCode).toBe(EXIT_CODES.guardHealth);
        expect(await readStrictTriggerState(connection)).toEqual({ kind: 'absent' });
      });
    });

    it('refuses to enable when the strict trigger function is missing', async () => {
      await inRolledBackTransaction(async () => {
        await connection.execute('drop function guard.enforce_auth_user_email()');

        const error = await rejection<GuardHealthError>(runStrictEnable(dependencies()));

        expect(error).toBeInstanceOf(GuardHealthError);
        expect(await readStrictTriggerState(connection)).toEqual({ kind: 'absent' });
      });
    });

    it('reports strict mode as broken when the trigger outlives a healthy guard layer', async () => {
      await inRolledBackTransaction(async () => {
        await runStrictEnable(dependencies());
        await connection.execute('drop table guard.allowed_domains cascade');

        const report = await runStrictStatus(dependencies());

        expect(report.strict.mode).toBe('broken');
      });
    });

    it('can still disable strict mode while the policy layer is destroyed', async () => {
      // The rollback path must stay open at the exact moment it is needed most: the
      // trigger is rejecting every write precisely because the policy engine is broken.
      await inRolledBackTransaction(async () => {
        await runStrictEnable(dependencies());
        await connection.execute('drop table guard.blocked_domains cascade');
        await expectWriteRejected(() => insertUser('person@gmail.com'));

        const report = await runStrictDisable(dependencies());

        expect(report.changed).toBe(true);
        expect(report.verified?.kind).toBe('absent');

        // And the writes flow again.
        await insertUser('person@gmail.com');
      });
    });

    it('takes the trigger with it when the guard schema is dropped', async () => {
      // Load-bearing for the documented uninstall order: DROP SCHEMA guard CASCADE
      // removes the trigger function, and PostgreSQL refuses to orphan a trigger, so the
      // trigger goes too. auth.users is never left pointing at a function that is gone.
      await inRolledBackTransaction(async () => {
        await runStrictEnable(dependencies());
        await connection.execute('drop schema guard cascade');

        expect(await readStrictTriggerState(connection)).toEqual({ kind: 'absent' });
      });
    });
  });
});
