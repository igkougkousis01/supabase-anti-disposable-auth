import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  calculateChecksum,
  loadMigrationFiles,
  parseMigrationFileName,
  planMigrations,
  resolveMigrationsDirectory,
  runMigrations,
} from '../../src/database/migrations.js';
import type { AppliedMigration, MigrationFile } from '../../src/database/migration-types.js';
import { MigrationError } from '../../src/lib/errors.js';
import { FakeDatabase } from '../helpers/database.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** Creates a throwaway migrations directory containing the given files. */
async function createMigrationsDirectory(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sada-migrations-'));
  temporaryDirectories.push(directory);

  for (const [fileName, sql] of Object.entries(files)) {
    await writeFile(join(directory, fileName), sql, 'utf8');
  }

  return directory;
}

function migration(version: string, name: string, sql = `select ${version};`): MigrationFile {
  return {
    version,
    name,
    fileName: `${version}_${name}.sql`,
    sql,
    checksum: calculateChecksum(sql),
  };
}

function applied(file: MigrationFile): AppliedMigration {
  return {
    version: file.version,
    name: file.name,
    checksum: file.checksum,
    appliedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

describe('parseMigrationFileName', () => {
  it('splits a valid filename into version and name', () => {
    expect(parseMigrationFileName('001_create_domain_tables.sql')).toEqual({
      version: '001',
      name: 'create_domain_tables',
    });
  });

  it('accepts digits inside the descriptive name', () => {
    expect(parseMigrationFileName('012_add_rfc5321_limits.sql')?.name).toBe('add_rfc5321_limits');
  });

  it.each([
    ['no version prefix', 'create_domain_tables.sql'],
    ['too few digits', '01_create_tables.sql'],
    ['too many digits', '0001_create_tables.sql'],
    ['uppercase in the name', '001_Create_Tables.sql'],
    ['hyphens instead of underscores', '001_create-tables.sql'],
    ['a trailing underscore', '001_create_.sql'],
    ['a missing name', '001_.sql'],
    ['no extension', '001_create_tables'],
    ['the wrong extension', '001_create_tables.txt'],
  ])('rejects %s', (_label, fileName) => {
    expect(parseMigrationFileName(fileName)).toBeUndefined();
  });
});

describe('calculateChecksum', () => {
  it('is stable for identical content', () => {
    expect(calculateChecksum('select 1;')).toBe(calculateChecksum('select 1;'));
  });

  it('changes when a single character changes', () => {
    expect(calculateChecksum('select 1;')).not.toBe(calculateChecksum('select 2;'));
  });

  it('ignores CRLF, so a Windows checkout does not read as tampering', () => {
    expect(calculateChecksum('select 1;\r\nselect 2;\r\n')).toBe(
      calculateChecksum('select 1;\nselect 2;\n'),
    );
  });

  it('produces a lowercase hex sha256', () => {
    expect(calculateChecksum('select 1;')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('loadMigrationFiles', () => {
  it('orders migrations by version rather than by directory listing order', async () => {
    const directory = await createMigrationsDirectory({
      '010_third.sql': 'select 10;',
      '002_second.sql': 'select 2;',
      '001_first.sql': 'select 1;',
    });

    const files = await loadMigrationFiles(directory);

    expect(files.map((file) => file.version)).toEqual(['001', '002', '010']);
    expect(files.map((file) => file.name)).toEqual(['first', 'second', 'third']);
  });

  it('reads content and checksums each file', async () => {
    const directory = await createMigrationsDirectory({ '001_first.sql': 'select 1;' });

    const [file] = await loadMigrationFiles(directory);

    expect(file?.sql).toBe('select 1;');
    expect(file?.checksum).toBe(calculateChecksum('select 1;'));
  });

  it('ignores non-SQL files so documentation can live alongside the migrations', async () => {
    const directory = await createMigrationsDirectory({
      '001_first.sql': 'select 1;',
      'README.md': '# not a migration',
      '.keep': '',
    });

    expect(await loadMigrationFiles(directory)).toHaveLength(1);
  });

  it('rejects an invalid migration filename', async () => {
    const directory = await createMigrationsDirectory({ 'oops.sql': 'select 1;' });

    await expect(loadMigrationFiles(directory)).rejects.toThrow(MigrationError);
    await expect(loadMigrationFiles(directory)).rejects.toThrow(/Invalid migration filename/);
  });

  it('rejects two files claiming the same version', async () => {
    const directory = await createMigrationsDirectory({
      '001_first.sql': 'select 1;',
      '001_also_first.sql': 'select 2;',
    });

    await expect(loadMigrationFiles(directory)).rejects.toThrow(/Duplicate migration version 001/);
  });

  it('reports a missing directory as a migration error, not a raw filesystem error', async () => {
    await expect(loadMigrationFiles(join(tmpdir(), 'sada-does-not-exist-1234'))).rejects.toThrow(
      MigrationError,
    );
  });
});

describe('planMigrations', () => {
  const first = migration('001', 'first');
  const second = migration('002', 'second');

  it('marks everything pending against an empty database', () => {
    const plan = planMigrations([first, second], []);

    expect(plan.pending).toEqual([first, second]);
    expect(plan.applied).toEqual([]);
    expect(plan.currentVersion).toBeUndefined();
  });

  it('skips migrations that are already applied and unchanged', () => {
    const plan = planMigrations([first, second], [applied(first)]);

    expect(plan.applied).toEqual([first]);
    expect(plan.pending).toEqual([second]);
    expect(plan.currentVersion).toBe('001');
  });

  it('reports nothing pending once every migration is applied', () => {
    const plan = planMigrations([first, second], [applied(first), applied(second)]);

    expect(plan.pending).toEqual([]);
    expect(plan.currentVersion).toBe('002');
  });

  it('fails loudly when an applied migration file was edited', () => {
    const tampered: AppliedMigration = {
      ...applied(first),
      checksum: calculateChecksum('drop table users;'),
    };

    expect(() => planMigrations([first, second], [tampered])).toThrow(MigrationError);
    expect(() => planMigrations([first, second], [tampered])).toThrow(
      /001_first\.sql changed after it was applied/,
    );
  });

  it('does not re-run an altered migration -- it refuses the whole plan', () => {
    const tampered: AppliedMigration = { ...applied(first), checksum: 'deadbeef' };

    // The failure happens while planning, before anything could execute.
    expect(() => planMigrations([first], [tampered])).toThrow(MigrationError);
  });

  it('fails when an applied migration file has disappeared', () => {
    expect(() => planMigrations([second], [applied(first)])).toThrow(
      /recorded as applied but its file is missing/,
    );
  });

  it('fails when an applied migration was renamed', () => {
    const renamed = migration('001', 'first_renamed');

    expect(() => planMigrations([renamed], [applied(first)])).toThrow(
      /applied as "first" but the file is now "first_renamed"/,
    );
  });

  it('fails when a new migration is numbered below an applied one', () => {
    // 002 is applied, but 001 has appeared since and would otherwise run after it.
    expect(() => planMigrations([first, second], [applied(second)])).toThrow(
      /numbered below the applied version 002/,
    );
  });

  it('describes every migration with its state', () => {
    const plan = planMigrations([first, second], [applied(first)]);

    expect(plan.entries).toEqual([
      { migration: first, state: 'applied' },
      { migration: second, state: 'pending' },
    ]);
  });
});

describe('runMigrations', () => {
  const first = migration('001', 'first');
  const second = migration('002', 'second');

  it('bootstraps the schema, applies every migration in order and records them', async () => {
    const database = new FakeDatabase();

    const result = await runMigrations(database, { files: [first, second] });

    expect(result.applied).toEqual([first, second]);
    expect(result.skipped).toEqual([]);
    expect(result.currentVersion).toBe('002');

    expect(database.executed[0]).toContain('create schema if not exists guard');
    expect(database.executed.slice(1)).toEqual([first.sql, second.sql]);
    expect(database.history.map((row) => row.version)).toEqual(['001', '002']);
  });

  it('applies nothing on a second run and still succeeds', async () => {
    const database = new FakeDatabase();
    await runMigrations(database, { files: [first, second] });

    const executedAfterFirstRun = database.executed.length;
    const result = await runMigrations(database, { files: [first, second] });

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([first, second]);
    expect(result.currentVersion).toBe('002');
    // Only the idempotent bootstrap ran again; no migration was re-executed.
    expect(database.executed.length).toBe(executedAfterFirstRun + 1);
    expect(database.history).toHaveLength(2);
  });

  it('applies only the migrations that are new', async () => {
    const database = new FakeDatabase();
    await runMigrations(database, { files: [first] });

    const result = await runMigrations(database, { files: [first, second] });

    expect(result.applied).toEqual([second]);
    expect(result.skipped).toEqual([first]);
  });

  it('reports progress for each applied migration', async () => {
    const database = new FakeDatabase();
    const onApplied = vi.fn<(migration: MigrationFile) => void>();

    await runMigrations(database, { files: [first, second], onApplied });

    expect(onApplied).toHaveBeenCalledTimes(2);
    expect(onApplied.mock.calls.map((call) => call[0].version)).toEqual(['001', '002']);
  });

  it('refuses to run when another migration run holds the lock', async () => {
    const database = new FakeDatabase({ lockAvailable: false });

    await expect(runMigrations(database, { files: [first] })).rejects.toThrow(
      /Another migration run is already in progress/,
    );
    expect(database.executed).toHaveLength(0);
  });

  it('releases the advisory lock even when a migration fails', async () => {
    const database = new FakeDatabase({ failOnSqlContaining: second.sql });

    await expect(runMigrations(database, { files: [first, second] })).rejects.toThrow(
      MigrationError,
    );
    expect(database.lockHeld).toBe(false);
  });

  it('stops at the first failure and does not record the failed migration', async () => {
    const third = migration('003', 'third');
    const database = new FakeDatabase({ failOnSqlContaining: second.sql });

    await expect(runMigrations(database, { files: [first, second, third] })).rejects.toThrow(
      /Migration 002_second\.sql failed/,
    );

    // 001 committed; 002 rolled back; 003 never attempted.
    expect(database.history.map((row) => row.version)).toEqual(['001']);
    expect(database.executed).not.toContain(third.sql);
  });

  it('resumes from the last successful migration after a failure is fixed', async () => {
    const failing = new FakeDatabase({ failOnSqlContaining: second.sql });
    await expect(runMigrations(failing, { files: [first, second] })).rejects.toThrow(
      MigrationError,
    );

    // A fresh connection to the same database state, with the migration now working.
    const repaired = new FakeDatabase().seedHistory([
      { version: first.version, name: first.name, checksum: first.checksum },
    ]);

    const result = await runMigrations(repaired, { files: [first, second] });

    expect(result.applied).toEqual([second]);
  });

  it('rejects a tampered migration before executing anything', async () => {
    const database = new FakeDatabase().seedHistory([
      { version: first.version, name: first.name, checksum: 'not-the-real-checksum' },
    ]);

    await expect(runMigrations(database, { files: [first, second] })).rejects.toThrow(
      /changed after it was applied/,
    );
    // The bootstrap is the only script that ran; no migration SQL was executed.
    expect(database.executed).not.toContain(first.sql);
    expect(database.executed).not.toContain(second.sql);
  });
});

describe('the migrations bundled with this package', () => {
  it('resolves to a directory inside the package', () => {
    expect(resolveMigrationsDirectory()).toMatch(/migrations$/);
  });

  it('all have valid, uniquely versioned filenames', async () => {
    const files = await loadMigrationFiles();

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(parseMigrationFileName(file.fileName)).toBeDefined();
    }
    expect(new Set(files.map((file) => file.version)).size).toBe(files.length);
  });

  it('are ordered so the schema is created before it is used', async () => {
    const files = await loadMigrationFiles();
    const versions = files.map((file) => file.version);

    expect([...versions].sort()).toEqual(versions);
  });

  it('never open or close a transaction themselves -- the runner owns that', async () => {
    for (const file of await loadMigrationFiles()) {
      const statements = file.sql
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .toLowerCase();

      expect(statements).not.toMatch(/^\s*begin\s*;/m);
      expect(statements).not.toMatch(/^\s*commit\s*;/m);
      expect(statements).not.toMatch(/^\s*rollback\s*;/m);
    }
  });
});
