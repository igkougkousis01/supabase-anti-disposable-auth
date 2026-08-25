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

  it('never claims the auth hook or automatic sync exists', async () => {
    const { logger, output } = createRecordingLogger();

    const report = await runStatus({
      env: { SUPABASE_DB_URL: DB_URL },
      connect: async () => installedDatabase(),
      files: FILES,
    });
    printStatusReport(report, logger);

    expect(output()).toContain('Auth Hook');
    expect(output()).toContain('Automatic sync');
    // Both must be reported as absent, with no wording that implies protection.
    expect(output()).toMatch(/Auth Hook\n.*Not configured/);
    expect(output()).toMatch(/Automatic sync\n.*Not configured/);
    expect(output()).not.toMatch(/hook.*(installed|active|enabled)/i);
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
      expect(output()).toContain('Auth Hook');
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
