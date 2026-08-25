/**
 * Live database tests for the guard policy engine.
 *
 * ⚠️  THESE TESTS ARE DESTRUCTIVE WITHIN THE `guard` SCHEMA.
 *
 * They run `drop schema if exists guard cascade` before and after each phase, then
 * apply the migrations from scratch. Nothing outside the `guard` schema is read or
 * written -- `public` and `auth` are never touched -- but any data you had in `guard`
 * is destroyed.
 *
 * For that reason they deliberately do NOT use SUPABASE_DB_URL. A developer's
 * SUPABASE_DB_URL usually points at a real Supabase project, and `npm run
 * test:integration` must never drop a schema there by accident. These tests require a
 * separate, explicitly named variable pointing at a scratch database:
 *
 *   createdb supabase_anti_disposable_auth_test
 *   SADA_TEST_DB_URL="postgresql://localhost:5432/supabase_anti_disposable_auth_test" \
 *     npm run test:integration
 *
 * With SADA_TEST_DB_URL unset, the whole suite skips, so `npm test` and CI stay
 * offline and no credentials are ever required.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresConnection } from '../../src/database/client.js';
import {
  calculateChecksum,
  loadMigrationFiles,
  readAppliedMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { statusExitCode } from '../../src/commands/status.js';
import { readGuardSchemaStatus } from '../../src/database/schema-status.js';
import type { MigrationFile } from '../../src/database/migration-types.js';
import type { DatabaseConnection } from '../../src/database/types.js';
import { EXIT_CODES, MigrationError } from '../../src/lib/errors.js';

const testDatabaseUrl = process.env['SADA_TEST_DB_URL'];
const describeIfConfigured = testDatabaseUrl === undefined ? describe.skip : describe;

/** Small, deterministic fixture. Never shipped, never inserted into a real database. */
const FIXTURE_BLOCKED = ['mailinator.com', '10minutemail.com', 'trashmail.example'];

let connection: DatabaseConnection;

/**
 * Supabase client roles present on this server, resolved once after connecting.
 *
 * Empty on a plain PostgreSQL instance. Tests that depend on them skip explicitly
 * rather than looping zero times and reporting a vacuous pass.
 */
let clientRoles: string[] = [];

async function readClientRoles(): Promise<string[]> {
  const result = await connection.query<{ rolname: string }>(
    `select rolname from pg_catalog.pg_roles
     where rolname in ('anon', 'authenticated') and not rolsuper
     order by rolname`,
  );

  return result.rows.map((row) => row.rolname);
}

async function dropGuardSchema(): Promise<void> {
  await connection.execute('drop schema if exists guard cascade');
}

/** Reads a single scalar, which is all these assertions ever need. */
async function scalar<T>(sql: string, parameters: (string | null)[] = []): Promise<T | undefined> {
  const result = await connection.query<{ value: T }>(sql, parameters);
  return result.rows[0]?.value;
}

describeIfConfigured('guard schema against a live database', () => {
  beforeAll(async () => {
    connection = await createPostgresConnection({ connectionString: testDatabaseUrl as string });
    clientRoles = await readClientRoles();
    await dropGuardSchema();
    await runMigrations(connection);
  }, 60_000);

  afterAll(async () => {
    if (connection !== undefined) {
      await dropGuardSchema();
      await connection.close();
    }
  });

  describe('guard.normalize_domain', () => {
    it.each([
      ['MAILINATOR.COM', 'mailinator.com'],
      [' mailinator.com ', 'mailinator.com'],
      ['@mailinator.com', 'mailinator.com'],
      ['user@mailinator.com', 'mailinator.com'],
      ['User.Name+tag@Mailinator.COM', 'mailinator.com'],
      ['mailinator.com.', 'mailinator.com'],
      ['sub.mailinator.com', 'sub.mailinator.com'],
    ])('normalises %j to %j', async (input, expected) => {
      expect(await scalar('select guard.normalize_domain($1) as value', [input])).toBe(expected);
    });

    it.each([
      ['null', null],
      ['an empty string', ''],
      ['whitespace only', '   '],
      ['a bare @', '@'],
      ['a missing domain', 'user@'],
      ['a name with no dot', 'nodot'],
      ['a leading dot', '.leading.com'],
      ['a doubled dot', 'double..dot.com'],
      ['a leading hyphen', '-hyphen.com'],
      ['an underscore', 'under_score.com'],
      ['an IP address', '192.168.0.1'],
      ['embedded whitespace', 'has space.com'],
    ])('returns null for %s', async (_label, input) => {
      expect(await scalar('select guard.normalize_domain($1) as value', [input])).toBeNull();
    });

    it('treats a SQL-looking string as ordinary text', async () => {
      const attack = "robert'); drop table guard.blocked_domains;--@evil.com";

      expect(await scalar('select guard.normalize_domain($1) as value', [attack])).toBe('evil.com');
      // The table is still there, which is the actual assertion.
      expect(await scalar("select to_regclass('guard.blocked_domains') is not null as value")).toBe(
        true,
      );
    });
  });

  describe('guard.is_disposable_domain', () => {
    // Every test in this block inserts fixture rows and rolls them back, so the
    // database is left exactly as it was found.
    beforeAll(async () => {
      await connection.execute('begin');
      for (const domain of FIXTURE_BLOCKED) {
        await connection.query(
          'insert into guard.blocked_domains (domain, source) values ($1, $2)',
          [domain, 'integration-fixture'],
        );
      }
    });

    afterAll(async () => {
      await connection.execute('rollback');
    });

    it('is true for a blocked domain, whatever form the input takes', async () => {
      for (const input of [
        'mailinator.com',
        'user@mailinator.com',
        'MAILINATOR.COM',
        'USER@MAILINATOR.COM',
        '  @Mailinator.Com  ',
      ]) {
        expect(await scalar('select guard.is_disposable_domain($1) as value', [input])).toBe(true);
      }
    });

    it('is false for a domain on neither list', async () => {
      expect(await scalar('select guard.is_disposable_domain($1) as value', ['gmail.com'])).toBe(
        false,
      );
    });

    it.each([
      ['null', null],
      ['an empty string', ''],
      ['whitespace', '   '],
      ['a malformed value', '!!!'],
      ['an unparseable address', 'user@'],
    ])('is false for %s rather than raising', async (_label, input) => {
      expect(await scalar('select guard.is_disposable_domain($1) as value', [input])).toBe(false);
    });

    it('lets the allowlist override the blocklist', async () => {
      await connection.query('savepoint allowlist_test');
      try {
        await connection.query(
          'insert into guard.allowed_domains (domain, reason) values ($1, $2)',
          ['mailinator.com', 'integration-fixture'],
        );

        expect(
          await scalar('select guard.is_blocked_domain($1) as value', ['mailinator.com']),
        ).toBe(true);
        expect(
          await scalar('select guard.is_allowed_domain($1) as value', ['mailinator.com']),
        ).toBe(true);
        // The rule this whole branch exists to prove: allowlist wins.
        expect(
          await scalar('select guard.is_disposable_domain($1) as value', ['mailinator.com']),
        ).toBe(false);
        expect(
          await scalar('select guard.is_disposable_domain($1) as value', ['user@mailinator.com']),
        ).toBe(false);
      } finally {
        await connection.query('rollback to savepoint allowlist_test');
      }
    });

    it('is false for an allowlisted domain that was never blocked', async () => {
      await connection.query('savepoint allow_only_test');
      try {
        await connection.query('insert into guard.allowed_domains (domain) values ($1)', [
          'company.example',
        ]);

        expect(
          await scalar('select guard.is_disposable_domain($1) as value', ['company.example']),
        ).toBe(false);
      } finally {
        await connection.query('rollback to savepoint allow_only_test');
      }
    });
  });

  describe('normalisation constraints', () => {
    it.each([['MAILINATOR.COM'], ['user@mailinator.com'], ['not a domain'], [' padded.com ']])(
      'rejects %j at insert time',
      async (domain) => {
        await expect(
          connection.query('insert into guard.blocked_domains (domain) values ($1)', [domain]),
        ).rejects.toThrow();
      },
    );

    it('cannot store the same domain twice in different cases', async () => {
      await connection.execute('begin');
      try {
        await connection.query('insert into guard.blocked_domains (domain) values ($1)', [
          'casetest.example',
        ]);
        await expect(
          connection.query('insert into guard.blocked_domains (domain) values ($1)', [
            'casetest.example',
          ]),
        ).rejects.toThrow();
      } finally {
        await connection.execute('rollback');
      }
    });
  });

  describe('privileges', () => {
    it('does not grant PUBLIC usage or create on the guard schema', async () => {
      // has_schema_privilege() resolves the real, inherited privilege, which ACL
      // string parsing would miss when a privilege arrives through role membership.
      expect(
        await scalar('select has_schema_privilege($1, $2, $3) as value', [
          'public',
          'guard',
          'USAGE',
        ]),
      ).toBe(false);
      expect(
        await scalar('select has_schema_privilege($1, $2, $3) as value', [
          'public',
          'guard',
          'CREATE',
        ]),
      ).toBe(false);
    });

    it('does not grant anon or authenticated any access to the schema', async (ctx) => {
      const roles = clientRoles;
      // Explicit skip, so a server without these roles reports as skipped rather than
      // passing an assertion loop that ran zero times.
      if (roles.length === 0) ctx.skip();

      for (const role of roles) {
        expect(
          await scalar('select has_schema_privilege($1, $2, $3) as value', [
            role,
            'guard',
            'USAGE',
          ]),
        ).toBe(false);
        expect(
          await scalar('select has_schema_privilege($1, $2, $3) as value', [
            role,
            'guard',
            'CREATE',
          ]),
        ).toBe(false);
      }
    });

    it('does not let anon or authenticated read or write the policy lists', async (ctx) => {
      const roles = clientRoles;
      if (roles.length === 0) ctx.skip();

      for (const role of roles) {
        for (const table of [
          'guard.blocked_domains',
          'guard.allowed_domains',
          'guard.sync_metadata',
        ]) {
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

    it('does not let anon or authenticated execute any guard function', async (ctx) => {
      const roles = clientRoles;
      if (roles.length === 0) ctx.skip();

      for (const role of roles) {
        const result = await connection.query<{ proname: string }>(
          `select p.proname
           from pg_catalog.pg_proc p
           join pg_catalog.pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'guard' and has_function_privilege($1, p.oid, 'EXECUTE')`,
          [role],
        );

        expect(result.rows).toEqual([]);
      }
    });

    it('does not leave any function executable by PUBLIC', async () => {
      // PostgreSQL grants EXECUTE to PUBLIC on every new function by default;
      // 005_permissions.sql revokes it. This asserts the revoke actually took.
      const result = await connection.query<{ proname: string }>(
        `select p.proname
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'guard'
           and has_function_privilege('public', p.oid, 'EXECUTE')`,
      );

      expect(result.rows).toEqual([]);
    });

    it('does not let PUBLIC read the policy lists', async () => {
      for (const table of ['guard.blocked_domains', 'guard.allowed_domains']) {
        expect(
          await scalar('select has_table_privilege($1, $2, $3) as value', [
            'public',
            table,
            'SELECT',
          ]),
        ).toBe(false);
        expect(
          await scalar('select has_table_privilege($1, $2, $3) as value', [
            'public',
            table,
            'INSERT',
          ]),
        ).toBe(false);
        expect(
          await scalar('select has_table_privilege($1, $2, $3) as value', [
            'public',
            table,
            'UPDATE',
          ]),
        ).toBe(false);
        expect(
          await scalar('select has_table_privilege($1, $2, $3) as value', [
            'public',
            table,
            'DELETE',
          ]),
        ).toBe(false);
      }
    });

    it('does not grant anything on the schema to PUBLIC', async () => {
      expect(await scalar("select has_schema_privilege('public', 'guard', 'USAGE') as value")).toBe(
        false,
      );
    });

    it('uses no SECURITY DEFINER functions', async () => {
      const result = await connection.query<{ proname: string }>(
        `select p.proname
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'guard' and p.prosecdef`,
      );

      expect(result.rows).toEqual([]);
    });

    it('pins search_path on every function', async () => {
      const result = await connection.query<{ proname: string }>(
        `select p.proname
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'guard'
           and not coalesce(array_to_string(p.proconfig, ',') like 'search_path=%', false)`,
      );

      expect(result.rows).toEqual([]);
    });
  });

  describe('default privilege scope', () => {
    it('leaves the role-global default privileges untouched', async () => {
      // The strongest guarantee this tool offers is that it does not reach outside the
      // guard schema. A role-global ALTER DEFAULT PRIVILEGES would change how EVERY
      // function that role creates behaves, in `public` and in the user's own schemas.
      const result = await connection.query<{ count: number }>(
        `select count(*)::int as count
         from pg_catalog.pg_default_acl
         where defaclnamespace = 0`,
      );

      expect(result.rows[0]?.count).toBe(0);
    });

    it('records no schema-scoped default ACL, because the revoke form is a no-op', async () => {
      // Documents real PostgreSQL behaviour: `ALTER DEFAULT PRIVILEGES IN SCHEMA ...
      // REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` writes nothing to pg_default_acl,
      // because the built-in PUBLIC EXECUTE default is not represented there. That is
      // why migration 005 does not pretend to use it.
      const result = await connection.query<{ count: number }>(
        `select count(*)::int as count
         from pg_catalog.pg_default_acl
         where defaclnamespace = 'guard'::regnamespace`,
      );

      expect(result.rows[0]?.count).toBe(0);
    });

    it('does not protect a function added after 005 -- the schema USAGE gate does', async () => {
      await connection.execute('begin');
      try {
        await connection.execute(
          'create function guard.default_privilege_probe() returns int language sql immutable as $probe$ select 1 $probe$',
        );

        // The honest, verified behaviour: PostgreSQL grants EXECUTE to PUBLIC on the
        // new function, and nothing in migration 005 prevents that. A future migration
        // adding a function MUST repeat the explicit revoke.
        expect(
          await scalar('select has_function_privilege($1, $2, $3) as value', [
            'public',
            'guard.default_privilege_probe()',
            'EXECUTE',
          ]),
        ).toBe(true);

        // It is nevertheless unreachable: invoking a function requires USAGE on its
        // schema, and PUBLIC has none. This is the control that actually contains it.
        expect(
          await scalar('select has_schema_privilege($1, $2, $3) as value', [
            'public',
            'guard',
            'USAGE',
          ]),
        ).toBe(false);
      } finally {
        await connection.execute('rollback');
      }
    });

    it('keeps every shipped function non-executable by PUBLIC', async () => {
      // The invariant that must hold after every migration, enforced here so that a
      // future migration which forgets the explicit revoke fails the build.
      const result = await connection.query<{ proname: string }>(
        `select p.proname
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'guard' and has_function_privilege('public', p.oid, 'EXECUTE')`,
      );

      expect(result.rows).toEqual([]);
    });
  });

  describe('reported status', () => {
    it('reflects a complete installation', async () => {
      const status = await readGuardSchemaStatus(connection);

      expect(status.schemaInstalled).toBe(true);
      expect(status.health).toBe('complete');
      expect(status.missingObjects).toEqual([]);
      expect(status.pending).toEqual([]);
      expect(status.lookupFunctionInstalled).toBe(true);
      expect(status.blockedDomainCount).toBeGreaterThanOrEqual(0);
      expect(status.allowedDomainCount).toBeGreaterThanOrEqual(0);
    });

    it('exits zero only while the installation is complete', async () => {
      const status = await readGuardSchemaStatus(connection);

      expect(statusExitCode({ target: connection.target, schema: status })).toBe(
        EXIT_CODES.success,
      );
    });

    it('exits with the guard-health code against a really damaged schema', async () => {
      await connection.execute('begin');
      try {
        await connection.execute('drop table guard.sync_metadata');

        const status = await readGuardSchemaStatus(connection);

        expect(statusExitCode({ target: connection.target, schema: status })).toBe(
          EXIT_CODES.guardHealth,
        );
      } finally {
        await connection.execute('rollback');
      }
    });

    it('reports a dropped table as incomplete instead of healthy', async () => {
      await connection.execute('begin');
      try {
        await connection.execute('drop table guard.allowed_domains');

        const status = await readGuardSchemaStatus(connection);

        expect(status.health).toBe('incomplete');
        expect(status.missingObjects).toContain('guard.allowed_domains');
        // The migration history still claims everything was applied, which is exactly
        // why object probing cannot be replaced by trusting the history.
        expect(status.pending).toEqual([]);
        expect(status.allowedDomainCount).toBeUndefined();
      } finally {
        await connection.execute('rollback');
      }
    });

    it('reports a dropped lookup function as incomplete instead of healthy', async () => {
      await connection.execute('begin');
      try {
        await connection.execute('drop function guard.is_disposable_domain(text)');

        const status = await readGuardSchemaStatus(connection);

        expect(status.health).toBe('incomplete');
        expect(status.lookupFunctionInstalled).toBe(false);
        expect(status.missingObjects).toContain('guard.is_disposable_domain(text)');
      } finally {
        await connection.execute('rollback');
      }
    });

    it('survives an empty guard schema without raising', async () => {
      await connection.execute('begin');
      try {
        await connection.execute('drop schema guard cascade');
        await connection.execute('create schema guard');

        const status = await readGuardSchemaStatus(connection);

        expect(status.schemaInstalled).toBe(true);
        expect(status.health).toBe('incomplete');
        expect(status.missingObjects.length).toBeGreaterThan(0);
        expect(status.blockedDomainCount).toBeUndefined();
        expect(status.allowedDomainCount).toBeUndefined();
      } finally {
        await connection.execute('rollback');
      }
    });
  });
});

describeIfConfigured('migration runner against a live database', () => {
  beforeAll(async () => {
    connection = await createPostgresConnection({ connectionString: testDatabaseUrl as string });
  }, 60_000);

  afterAll(async () => {
    if (connection !== undefined) {
      await dropGuardSchema();
      await connection.close();
    }
  });

  it('applies every bundled migration on a clean database', async () => {
    await dropGuardSchema();

    const files = await loadMigrationFiles();
    const result = await runMigrations(connection);

    expect(result.applied.map((file) => file.version)).toEqual(files.map((file) => file.version));
    expect(result.skipped).toEqual([]);
  }, 60_000);

  it('is idempotent: a second run applies nothing and succeeds', async () => {
    const result = await runMigrations(connection);

    expect(result.applied).toEqual([]);
    expect(result.skipped.length).toBeGreaterThan(0);

    const history = await readAppliedMigrations(connection);
    expect(history.length).toBe(result.skipped.length);
  }, 60_000);

  it('records one history row per migration, with its checksum', async () => {
    const files = await loadMigrationFiles();
    const history = await readAppliedMigrations(connection);

    expect(history.map((row) => row.version)).toEqual(files.map((file) => file.version));
    expect(history.map((row) => row.checksum)).toEqual(files.map((file) => file.checksum));
  });

  it('refuses to run when an applied migration file has been altered', async () => {
    // Uses a throwaway fixture migration rather than editing a real one: the tamper
    // path must be provable without ever mutating a file that ships to users.
    const original = 'create table if not exists guard.tamper_fixture (id int primary key);';
    const fixture: MigrationFile = {
      version: '900',
      name: 'tamper_fixture',
      fileName: '900_tamper_fixture.sql',
      sql: original,
      checksum: calculateChecksum(original),
    };

    const files = [...(await loadMigrationFiles()), fixture];
    await runMigrations(connection, { files });

    const altered = `${original}\n-- edited after the fact`;
    const tampered: MigrationFile = {
      ...fixture,
      sql: altered,
      checksum: calculateChecksum(altered),
    };

    await expect(
      runMigrations(connection, { files: [...(await loadMigrationFiles()), tampered] }),
    ).rejects.toThrow(MigrationError);

    await expect(
      runMigrations(connection, { files: [...(await loadMigrationFiles()), tampered] }),
    ).rejects.toThrow(/changed after it was applied/);
  }, 60_000);

  it('does not record a migration whose SQL failed', async () => {
    await dropGuardSchema();

    const broken: MigrationFile = {
      version: '901',
      name: 'broken_fixture',
      fileName: '901_broken_fixture.sql',
      sql: 'create table guard.broken_fixture (id int primary key); select this_function_does_not_exist();',
      checksum: 'irrelevant',
    };

    await expect(runMigrations(connection, { files: [broken] })).rejects.toThrow(MigrationError);

    // Neither the history row nor the table survived: the transaction rolled back.
    expect(await readAppliedMigrations(connection)).toEqual([]);
    expect(await scalar("select to_regclass('guard.broken_fixture') is not null as value")).toBe(
      false,
    );
  }, 60_000);
});
