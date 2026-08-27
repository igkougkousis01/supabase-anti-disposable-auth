import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  printStatusReport,
  registerStatusCommand,
  runStatus,
  statusExitCode,
} from '../../src/commands/status.js';
import { calculateChecksum } from '../../src/database/migrations.js';
import type { MigrationFile } from '../../src/database/migration-types.js';
import {
  ConfigurationError,
  DatabaseConnectionError,
  DatabaseQueryError,
  EXIT_CODES,
} from '../../src/lib/errors.js';
import { FakeDatabase } from '../helpers/database.js';
import { createRecordingLogger } from '../helpers/logger.js';

const PASSWORD = 'hunter2';
const DB_URL = `postgresql://postgres:${PASSWORD}@db.example.supabase.co:5432/postgres?sslmode=require`;

function migration(version: string, name: string): MigrationFile {
  const sql = `select ${version};`;
  return {
    version,
    name,
    fileName: `${version}_${name}.sql`,
    sql,
    checksum: calculateChecksum(sql),
  };
}

const FIRST = migration('001', 'create_domain_functions');
const SECOND = migration('002', 'create_domain_tables');
const FILES = [FIRST, SECOND];

/** Every object a fully migrated guard schema must contain. */
const ALL_GUARD_OBJECTS = [
  'guard.schema_migrations',
  'guard.blocked_domains',
  'guard.allowed_domains',
  'guard.sync_metadata',
  'guard.normalize_domain(text)',
  'guard.is_blocked_domain(text)',
  'guard.is_allowed_domain(text)',
  'guard.is_disposable_domain(text)',
  'guard.before_user_created(jsonb)',
];

const ROW_COUNTS = { 'guard.blocked_domains': 3, 'guard.allowed_domains': 1 };

const FULL_HISTORY = [
  { version: FIRST.version, name: FIRST.name, checksum: FIRST.checksum },
  { version: SECOND.version, name: SECOND.name, checksum: SECOND.checksum },
];

/** A database where the guard layer is fully installed. */
function installedDatabase(): FakeDatabase {
  return new FakeDatabase({
    presentObjects: ALL_GUARD_OBJECTS,
    rowCounts: ROW_COUNTS,
  }).seedHistory(FULL_HISTORY);
}

/**
 * Exactly the privileges migration 007 grants, written as the status probe reports
 * them. Kept as a literal rather than derived, so a change to the required set has to
 * be made deliberately in both places.
 */
const AUTH_HOOK_GRANTS = [
  'USAGE on guard',
  'EXECUTE on guard.before_user_created(jsonb)',
  'EXECUTE on guard.is_disposable_domain(text)',
  'EXECUTE on guard.normalize_domain(text)',
  'SELECT on guard.blocked_domains',
  'SELECT on guard.allowed_domains',
];

/** A Supabase-shaped database: the auth role exists and holds every needed grant. */
function supabaseDatabase(grants: string[] = AUTH_HOOK_GRANTS): FakeDatabase {
  return new FakeDatabase({
    presentObjects: ALL_GUARD_OBJECTS,
    rowCounts: ROW_COUNTS,
    roles: ['supabase_auth_admin'],
    privileges: { supabase_auth_admin: grants },
  }).seedHistory(FULL_HISTORY);
}

/**
 * A database whose migration history is complete but which is missing objects --
 * the shape left behind when something was dropped by hand.
 */
function damagedDatabase(...absent: string[]): FakeDatabase {
  const present = ALL_GUARD_OBJECTS.filter((object) => !absent.includes(object));
  const rowCounts = Object.fromEntries(
    Object.entries(ROW_COUNTS).filter(([table]) => present.includes(table)),
  );

  return new FakeDatabase({ presentObjects: present, rowCounts }).seedHistory(FULL_HISTORY);
}

async function statusOf(database: FakeDatabase) {
  return runStatus({
    env: { SUPABASE_DB_URL: DB_URL },
    connect: async () => database,
    files: FILES,
  });
}

describe('runStatus', () => {
  it('refuses to run without SUPABASE_DB_URL', async () => {
    const connect = vi.fn();

    await expect(runStatus({ env: {}, connect })).rejects.toThrow(ConfigurationError);
    expect(connect).not.toHaveBeenCalled();
  });

  it('reports an uninstalled database without creating anything', async () => {
    const database = new FakeDatabase();

    const report = await runStatus({
      env: { SUPABASE_DB_URL: DB_URL },
      connect: async () => database,
      files: FILES,
    });

    expect(report.schema.schemaInstalled).toBe(false);
    expect(report.schema.currentVersion).toBeUndefined();
    expect(report.schema.pending).toEqual(FILES);
    expect(report.schema.blockedDomainCount).toBeUndefined();
    expect(report.schema.lookupFunctionInstalled).toBe(false);
    // Read-only: no script was executed against the database at all.
    expect(database.executed).toEqual([]);
    expect(database.closed).toBe(true);
  });

  it('reports version, counts and the lookup function once installed', async () => {
    const report = await runStatus({
      env: { SUPABASE_DB_URL: DB_URL },
      connect: async () => installedDatabase(),
      files: FILES,
    });

    expect(report.schema.schemaInstalled).toBe(true);
    expect(report.schema.currentVersion).toBe('002');
    expect(report.schema.pending).toEqual([]);
    expect(report.schema.blockedDomainCount).toBe(3);
    expect(report.schema.allowedDomainCount).toBe(1);
    expect(report.schema.lookupFunctionInstalled).toBe(true);
  });

  it('lists migrations that have not been applied yet', async () => {
    const database = new FakeDatabase({
      presentObjects: ALL_GUARD_OBJECTS,
      rowCounts: ROW_COUNTS,
    }).seedHistory([{ version: FIRST.version, name: FIRST.name, checksum: FIRST.checksum }]);

    const report = await statusOf(database);

    expect(report.schema.pending).toEqual([SECOND]);
    expect(report.schema.currentVersion).toBe('001');
  });

  it('reports a fully migrated schema as complete', async () => {
    const report = await statusOf(installedDatabase());

    expect(report.schema.health).toBe('complete');
    expect(report.schema.missingObjects).toEqual([]);
  });

  it('reports an absent schema as not-installed rather than damaged', async () => {
    const report = await statusOf(new FakeDatabase());

    expect(report.schema.health).toBe('not-installed');
    // An uninstalled database is not a broken one; listing every object as missing
    // would obscure that.
    expect(report.schema.missingObjects).toEqual([]);
  });
});

describe('partial and damaged installations', () => {
  it('does not crash when allowed_domains is missing, and reports it', async () => {
    const report = await statusOf(damagedDatabase('guard.allowed_domains'));

    expect(report.schema.schemaInstalled).toBe(true);
    expect(report.schema.health).toBe('incomplete');
    expect(report.schema.missingObjects).toEqual(['guard.allowed_domains']);
    // The count query is skipped rather than raising an undefined-table error.
    expect(report.schema.allowedDomainCount).toBeUndefined();
    expect(report.schema.blockedDomainCount).toBe(3);
  });

  it('does not crash when an expected function is missing from a complete history', async () => {
    const report = await statusOf(damagedDatabase('guard.is_disposable_domain(text)'));

    expect(report.schema.health).toBe('incomplete');
    expect(report.schema.lookupFunctionInstalled).toBe(false);
    expect(report.schema.missingObjects).toEqual(['guard.is_disposable_domain(text)']);
    // The migration history still looks complete -- which is exactly why object
    // probing cannot be skipped in favour of trusting it.
    expect(report.schema.pending).toEqual([]);
    expect(report.schema.currentVersion).toBe('002');
  });

  it('treats a partially applied migration set as incomplete', async () => {
    const database = new FakeDatabase({
      presentObjects: ALL_GUARD_OBJECTS,
      rowCounts: ROW_COUNTS,
    }).seedHistory([{ version: FIRST.version, name: FIRST.name, checksum: FIRST.checksum }]);

    const report = await statusOf(database);

    expect(report.schema.health).toBe('incomplete');
    expect(report.schema.pending).toEqual([SECOND]);
    expect(report.schema.missingObjects).toEqual([]);
  });

  it('survives a schema that exists but is otherwise empty', async () => {
    const database = new FakeDatabase({ schemaPresent: true });

    const report = await statusOf(database);

    expect(report.schema.health).toBe('incomplete');
    expect(report.schema.missingObjects).toHaveLength(ALL_GUARD_OBJECTS.length);
    expect(report.schema.blockedDomainCount).toBeUndefined();
    expect(report.schema.allowedDomainCount).toBeUndefined();
  });

  it('reports several missing objects together', async () => {
    const report = await statusOf(
      damagedDatabase('guard.sync_metadata', 'guard.normalize_domain(text)'),
    );

    expect(report.schema.missingObjects).toEqual([
      'guard.sync_metadata',
      'guard.normalize_domain(text)',
    ]);
  });
});

describe('the Before User Created hook layer', () => {
  it('reports the hook function as installed', async () => {
    const report = await statusOf(installedDatabase());

    expect(report.schema.hookFunctionInstalled).toBe(true);
    expect(report.schema.missingObjects).toEqual([]);
  });

  it('treats a missing hook function as a damaged schema, not an unbuilt feature', async () => {
    const report = await statusOf(damagedDatabase('guard.before_user_created(jsonb)'));

    expect(report.schema.hookFunctionInstalled).toBe(false);
    expect(report.schema.health).toBe('incomplete');
    expect(report.schema.missingObjects).toEqual(['guard.before_user_created(jsonb)']);
    // Migration 006 shipped, so its absence is damage. Reporting it as "not
    // configured yet" would hide a guard layer that Supabase Auth cannot call.
    expect(statusExitCode(report)).toBe(EXIT_CODES.guardHealth);
  });

  it('reports grants as present when supabase_auth_admin holds all of them', async () => {
    const report = await statusOf(supabaseDatabase());

    expect(report.schema.authHookGrants).toBe('granted');
    expect(report.schema.missingAuthHookGrants).toEqual([]);
    expect(report.schema.health).toBe('complete');
  });

  it('names exactly the grants that are missing', async () => {
    const report = await statusOf(
      supabaseDatabase(
        AUTH_HOOK_GRANTS.filter((grant) => grant !== 'SELECT on guard.blocked_domains'),
      ),
    );

    expect(report.schema.authHookGrants).toBe('incomplete');
    expect(report.schema.missingAuthHookGrants).toEqual(['SELECT on guard.blocked_domains']);
  });

  it('fails the health check when the auth role cannot execute the hook', async () => {
    // Once the hook is activated in Supabase, a missing grant means the policy call
    // raises and every signup is rejected. That is a broken guard layer, and `status`
    // must be able to catch it before an operator flips the switch.
    const report = await statusOf(supabaseDatabase(['USAGE on guard']));

    expect(report.schema.health).toBe('incomplete');
    expect(statusExitCode(report)).toBe(EXIT_CODES.guardHealth);
  });

  it('requires the whole SECURITY INVOKER call chain, not just EXECUTE on the hook', async () => {
    // A hook that can be invoked but cannot read the blocklist is worse than useless:
    // it fails closed on every signup. EXECUTE on the entry point is not sufficient.
    const report = await statusOf(
      supabaseDatabase(['USAGE on guard', 'EXECUTE on guard.before_user_created(jsonb)']),
    );

    expect(report.schema.missingAuthHookGrants).toEqual([
      'EXECUTE on guard.is_disposable_domain(text)',
      'EXECUTE on guard.normalize_domain(text)',
      'SELECT on guard.blocked_domains',
      'SELECT on guard.allowed_domains',
    ]);
  });

  it('reports grants as unverifiable, not healthy, on a non-Supabase server', async () => {
    // installedDatabase() has no supabase_auth_admin role, like any plain PostgreSQL
    // instance. Asserting the grants are fine there would be a vacuous pass.
    const report = await statusOf(installedDatabase());

    expect(report.schema.authHookGrants).toBe('role-absent');
    expect(report.schema.missingAuthHookGrants).toEqual([]);
    // But it must not fail the health check either, or every local install breaks.
    expect(report.schema.health).toBe('complete');
  });

  it('does not probe grants at all while guard objects are missing', async () => {
    // has_*_privilege() raises for an unknown object, so probing a damaged schema
    // would turn a clear "incomplete" report into a query error.
    const report = await statusOf(damagedDatabase('guard.blocked_domains'));

    expect(report.schema.authHookGrants).toBe('unknown');
    expect(report.schema.health).toBe('incomplete');
  });

  it('reports grants as unknown rather than granted when nothing is installed', async () => {
    const report = await statusOf(new FakeDatabase());

    expect(report.schema.authHookGrants).toBe('unknown');
    expect(report.schema.hookFunctionInstalled).toBe(false);
  });
});

describe('printing the hook section', () => {
  it('separates "function installed" from "activation verified"', async () => {
    const { logger, output } = createRecordingLogger();

    printStatusReport(await statusOf(supabaseDatabase()), logger);

    expect(output()).toContain('Before User Created Hook');
    expect(output()).toContain('Function installed: guard.before_user_created(jsonb)');
    expect(output()).toContain('supabase_auth_admin can execute the hook');
    expect(output()).toContain('Supabase activation not verified');
  });

  it('says the grants were not checked on a non-Supabase server', async () => {
    const { logger, output } = createRecordingLogger();

    printStatusReport(await statusOf(installedDatabase()), logger);

    expect(output()).toContain('does not exist on this server');
    expect(output()).not.toContain('supabase_auth_admin can execute the hook');
  });

  it('reports missing grants and does not point the operator at install', async () => {
    const { logger, output } = createRecordingLogger();

    printStatusReport(await statusOf(supabaseDatabase(['USAGE on guard'])), logger);

    expect(output()).toContain('is missing EXECUTE on guard.before_user_created(jsonb)');
    // Migration 007 is recorded as applied, so `install` will not re-issue the
    // grants. Sending the operator there would waste their time.
    expect(output()).toContain('007_auth_hook_permissions.sql');
    expect(output()).toContain('applied migrations are never replayed');
    expect(output()).not.toContain('apply the pending migrations');
  });

  it('points missing grants at the documented remediation, not at migration history', async () => {
    const { logger, output } = createRecordingLogger();

    printStatusReport(await statusOf(supabaseDatabase(['USAGE on guard'])), logger);

    // The operator needs somewhere to go. The one place they must NOT be sent is
    // the migration history -- editing it or replaying a recorded migration by hand
    // is how a working installation gets broken further.
    expect(output()).toContain('Repairing the auth hook grants');
    expect(output()).not.toMatch(/re-?apply the grants from/i);
    expect(output()).not.toMatch(/re-?run .*migration/i);
    expect(output()).not.toMatch(/edit .*schema_migrations/i);
  });

  it('reports the hook as absent when nothing is installed', async () => {
    const { logger, output } = createRecordingLogger();

    printStatusReport(await statusOf(new FakeDatabase()), logger);

    expect(output()).toContain('Before User Created Hook');
    expect(output()).toContain('Function not installed');
    expect(output()).toContain('Supabase activation not verified');
  });
});

describe('printStatusReport', () => {
  it('shows the installed database layer', async () => {
    const { logger, output } = createRecordingLogger();

    const report = await runStatus({
      env: { SUPABASE_DB_URL: DB_URL },
      connect: async () => installedDatabase(),
      files: FILES,
    });
    printStatusReport(report, logger);

    expect(output()).toContain('Connected');
    expect(output()).toContain('Installed');
    expect(output()).toContain('Schema version: 002');
    expect(output()).toContain('Blocked domains: 3');
    expect(output()).toContain('Allowed domains: 1');
    expect(output()).toContain('guard.is_disposable_domain(text)');
  });

  it('never claims the hook is activated, even when the function is installed', async () => {
    const { logger, output } = createRecordingLogger();

    const report = await runStatus({
      env: { SUPABASE_DB_URL: DB_URL },
      connect: async () => supabaseDatabase(),
      files: FILES,
    });
    printStatusReport(report, logger);

    // The function exists and the grants are in place -- the most favourable state
    // this branch can reach -- and it still must not read as "you are protected".
    expect(output()).toContain('Function installed: guard.before_user_created(jsonb)');
    expect(output()).toContain('Supabase activation not verified');
    expect(output()).not.toMatch(/hook (is )?(active|enabled|configured)\b/i);
    expect(output()).not.toMatch(/signups? (are|is) (now )?(protected|filtered|blocked)/i);
  });

  it('still reports automatic sync as not implemented', async () => {
    const { logger, output } = createRecordingLogger();

    printStatusReport(await statusOf(installedDatabase()), logger);

    expect(output()).toMatch(/Automatic sync\n.*Not configured/);
  });

  it('tells the user to install when the schema is absent', async () => {
    const { logger, output } = createRecordingLogger();

    const report = await runStatus({
      env: { SUPABASE_DB_URL: DB_URL },
      connect: async () => new FakeDatabase(),
      files: FILES,
    });
    printStatusReport(report, logger);

    expect(output()).toContain('Not installed');
    expect(output()).toContain('install');
    expect(output()).not.toContain('Schema version');
  });

  it('flags pending migrations and points at install', async () => {
    const { logger, output } = createRecordingLogger();
    const database = new FakeDatabase({
      presentObjects: ALL_GUARD_OBJECTS,
      rowCounts: ROW_COUNTS,
    }).seedHistory([{ version: FIRST.version, name: FIRST.name, checksum: FIRST.checksum }]);

    printStatusReport(await statusOf(database), logger);

    expect(output()).toContain('1 migration(s) pending');
    expect(output()).toContain('apply the pending migrations');
    // A half-migrated schema must never be described as installed and healthy.
    expect(output()).toContain('Incomplete installation');
    expect(output()).not.toContain('Database guard layer is up to date.');
  });

  it('never reports a damaged schema as healthy', async () => {
    const { logger, output } = createRecordingLogger();

    printStatusReport(await statusOf(damagedDatabase('guard.allowed_domains')), logger);

    expect(output()).toContain('Incomplete installation');
    expect(output()).toContain('guard layer requires repair');
    expect(output()).toContain('Allowed domains: table missing');
    expect(output()).toContain('guard.allowed_domains');
    expect(output()).not.toContain('Database guard layer is up to date.');
    // The bare word "Installed" is the specific false claim to guard against.
    expect(output().split('\n')).not.toContain('Installed');
  });

  it('flags a missing lookup function even when the history looks complete', async () => {
    const { logger, output } = createRecordingLogger();

    printStatusReport(await statusOf(damagedDatabase('guard.is_disposable_domain(text)')), logger);

    expect(output()).toContain('Lookup function: missing');
    expect(output()).toContain('requires repair');
    expect(output()).not.toContain('Database guard layer is up to date.');
  });

  it('says install cannot repair objects dropped by hand', async () => {
    const { logger, output } = createRecordingLogger();

    printStatusReport(await statusOf(damagedDatabase('guard.sync_metadata')), logger);

    // Re-running install replays nothing, because the migration row is still there.
    expect(output()).toContain('will not recreate them');
    expect(output()).toContain('Drop the guard schema and reinstall');
  });

  it('never prints the connection string or password', async () => {
    const { logger, output } = createRecordingLogger();

    const report = await runStatus({
      env: { SUPABASE_DB_URL: DB_URL },
      connect: async () => installedDatabase(),
      files: FILES,
    });
    printStatusReport(report, logger);

    expect(output()).not.toContain(PASSWORD);
    expect(output()).not.toContain(DB_URL);
  });
});

describe('status exit codes', () => {
  describe('statusExitCode', () => {
    it('is success for a complete installation', async () => {
      expect(statusExitCode(await statusOf(installedDatabase()))).toBe(EXIT_CODES.success);
      expect(statusExitCode(await statusOf(installedDatabase()))).toBe(0);
    });

    it('is the guard-health code when nothing is installed', async () => {
      expect(statusExitCode(await statusOf(new FakeDatabase()))).toBe(EXIT_CODES.guardHealth);
    });

    it('is the guard-health code for a damaged installation', async () => {
      const report = await statusOf(damagedDatabase('guard.allowed_domains'));

      expect(report.schema.health).toBe('incomplete');
      expect(statusExitCode(report)).toBe(EXIT_CODES.guardHealth);
    });

    it('is the guard-health code for a partly applied migration set', async () => {
      const database = new FakeDatabase({
        presentObjects: ALL_GUARD_OBJECTS,
        rowCounts: ROW_COUNTS,
      }).seedHistory([{ version: FIRST.version, name: FIRST.name, checksum: FIRST.checksum }]);

      expect(statusExitCode(await statusOf(database))).toBe(EXIT_CODES.guardHealth);
    });

    it('does not reuse the database error code for a health verdict', () => {
      // A CI job must be able to tell "cannot reach the database" apart from
      // "reached it, the guard layer is broken".
      expect(EXIT_CODES.guardHealth).not.toBe(EXIT_CODES.database);
      expect(EXIT_CODES.guardHealth).not.toBe(EXIT_CODES.configuration);
      expect(EXIT_CODES.guardHealth).not.toBe(EXIT_CODES.success);
    });
  });

  describe('the registered status command', () => {
    let previousExitCode: typeof process.exitCode;

    beforeEach(() => {
      previousExitCode = process.exitCode;
      process.exitCode = undefined;
    });

    afterEach(() => {
      process.exitCode = previousExitCode;
    });

    /** Runs `status` through Commander exactly as the CLI does. */
    async function runCommand(database: FakeDatabase): Promise<void> {
      const { logger } = createRecordingLogger();
      const program = new Command();
      program.exitOverride();

      registerStatusCommand(program, logger, {
        env: { SUPABASE_DB_URL: DB_URL },
        connect: async () => database,
        files: FILES,
      });

      await program.parseAsync(['node', 'cli', 'status']);
    }

    it('exits 0 for a complete installation', async () => {
      await runCommand(installedDatabase());

      expect(process.exitCode).toBe(EXIT_CODES.success);
    });

    it('exits with the guard-health code when nothing is installed', async () => {
      await runCommand(new FakeDatabase());

      expect(process.exitCode).toBe(EXIT_CODES.guardHealth);
    });

    it('exits with the guard-health code for a damaged installation', async () => {
      await runCommand(damagedDatabase('guard.is_disposable_domain(text)'));

      expect(process.exitCode).toBe(EXIT_CODES.guardHealth);
    });

    it('still prints the full human-readable report when it exits non-zero', async () => {
      const { logger, output } = createRecordingLogger();
      const program = new Command();
      program.exitOverride();

      registerStatusCommand(program, logger, {
        env: { SUPABASE_DB_URL: DB_URL },
        connect: async () => damagedDatabase('guard.allowed_domains'),
        files: FILES,
      });
      await program.parseAsync(['node', 'cli', 'status']);

      // The exit code is additional signal, not a replacement for the report.
      expect(output()).toContain('Incomplete installation');
      expect(output()).toContain('Before User Created Hook');
      expect(process.exitCode).toBe(EXIT_CODES.guardHealth);
    });
  });

  describe('failures that are not health verdicts', () => {
    it('keeps the database exit code when the connection fails', async () => {
      const connect = vi.fn(async () => {
        throw new DatabaseConnectionError('Could not connect to db.example.test:5432/postgres');
      });

      await expect(
        runStatus({ env: { SUPABASE_DB_URL: DB_URL }, connect, files: FILES }),
      ).rejects.toMatchObject({ exitCode: EXIT_CODES.database });
    });

    it('keeps the database exit code when a query fails', async () => {
      const database = new FakeDatabase();
      vi.spyOn(database, 'query').mockRejectedValue(
        new DatabaseQueryError('Query failed against db.example.test:5432/postgres'),
      );

      await expect(
        runStatus({
          env: { SUPABASE_DB_URL: DB_URL },
          connect: async () => database,
          files: FILES,
        }),
      ).rejects.toMatchObject({ exitCode: EXIT_CODES.database });
    });

    it('keeps the configuration exit code when SUPABASE_DB_URL is missing', async () => {
      await expect(runStatus({ env: {}, connect: vi.fn(), files: FILES })).rejects.toMatchObject({
        exitCode: EXIT_CODES.configuration,
      });
    });

    it('reports a database failure as a rejection, never as a health verdict', async () => {
      const connect = vi.fn(async () => {
        throw new DatabaseConnectionError('Could not connect to db.example.test:5432/postgres');
      });

      // The promise rejects, so statusExitCode is never consulted and the guard-health
      // code can never mask an unreachable database.
      await expect(
        runStatus({ env: { SUPABASE_DB_URL: DB_URL }, connect, files: FILES }),
      ).rejects.toBeInstanceOf(DatabaseConnectionError);
    });
  });
});
