/**
 * The `strict` command group: state machines, refusals, previews and exit codes.
 *
 * Two properties are asserted repeatedly and on purpose, because both are the kind that
 * regress silently: **`--dry-run` executes zero DDL**, and **a conflict is never
 * resolved by dropping something**.
 */

import { describe, expect, it } from 'vitest';

import {
  printStrictMutationReport,
  printStrictSection,
  printStrictStatusReport,
  runStrictDisable,
  runStrictEnable,
  runStrictStatus,
  strictStatusExitCode,
} from '../../src/commands/strict.js';
import { calculateChecksum } from '../../src/database/migrations.js';
import type { MigrationFile } from '../../src/database/migration-types.js';
import {
  CREATE_STRICT_TRIGGER_SQL,
  DROP_STRICT_TRIGGER_SQL,
  STRICT_TRIGGER_FUNCTION,
  STRICT_TRIGGER_NAME,
} from '../../src/database/strict-trigger.js';
import {
  ConfigurationError,
  EXIT_CODES,
  GuardHealthError,
  StrictTriggerConflictError,
} from '../../src/lib/errors.js';
import type { AppError } from '../../src/lib/errors.js';
import { FakeDatabase, OUR_STRICT_TRIGGER_ROW } from '../helpers/database.js';
import { rejection } from '../helpers/errors.js';
import { createRecordingLogger } from '../helpers/logger.js';

const DB_URL = 'postgresql://postgres:hunter2@db.example.supabase.co:5432/postgres?sslmode=require';
const ENV = { SUPABASE_DB_URL: DB_URL };

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
const FILES = [FIRST];

/** Every object a fully migrated guard schema must contain, plus a Supabase auth.users. */
const GUARD_OBJECTS = [
  'guard.schema_migrations',
  'guard.blocked_domains',
  'guard.allowed_domains',
  'guard.sync_metadata',
  'guard.normalize_domain(text)',
  'guard.is_blocked_domain(text)',
  'guard.is_allowed_domain(text)',
  'guard.is_disposable_domain(text)',
  'guard.before_user_created(jsonb)',
  STRICT_TRIGGER_FUNCTION,
];

const HISTORY = [{ version: FIRST.version, name: FIRST.name, checksum: FIRST.checksum }];

/** A healthy, Supabase-shaped database with strict mode switched off. */
function readyDatabase(overrides: Record<string, unknown> = {}): FakeDatabase {
  return new FakeDatabase({
    presentObjects: [...GUARD_OBJECTS, 'auth.users'],
    rowCounts: { 'guard.blocked_domains': 3, 'guard.allowed_domains': 1 },
    authUsersEmailColumn: { type_name: 'character varying(255)', category: 'S' },
    privileges: { current_user: ['USAGE on auth', 'TRIGGER on auth.users'] },
    ...overrides,
  }).seedHistory(HISTORY);
}

function withDatabase(database: FakeDatabase) {
  return { env: ENV, connect: async () => database, files: FILES };
}

describe('strict status', () => {
  it('refuses to run without SUPABASE_DB_URL', async () => {
    await expect(runStrictStatus({ env: {} })).rejects.toThrow(ConfigurationError);
  });

  it('reports a ready database as disabled, and exits 0', async () => {
    const report = await runStrictStatus(withDatabase(readyDatabase()));

    expect(report.strict.mode).toBe('disabled');
    // Optional means optional: off must never be a failing health check.
    expect(strictStatusExitCode(report)).toBe(EXIT_CODES.success);
  });

  it('reports an enabled database, and exits 0', async () => {
    const report = await runStrictStatus(
      withDatabase(readyDatabase({ strictTrigger: OUR_STRICT_TRIGGER_ROW })),
    );

    expect(report.strict.mode).toBe('enabled');
    expect(strictStatusExitCode(report)).toBe(EXIT_CODES.success);
  });

  it('reports a plain PostgreSQL database as unavailable, and exits 0', async () => {
    const report = await runStrictStatus(
      withDatabase(
        new FakeDatabase({
          presentObjects: GUARD_OBJECTS,
          rowCounts: { 'guard.blocked_domains': 3, 'guard.allowed_domains': 1 },
        }).seedHistory(HISTORY),
      ),
    );

    expect(report.strict.mode).toBe('unavailable');
    expect(strictStatusExitCode(report)).toBe(EXIT_CODES.success);
  });

  it('exits with the conflict code when the name is taken', async () => {
    const report = await runStrictStatus(
      withDatabase(
        readyDatabase({
          strictTrigger: { ...OUR_STRICT_TRIGGER_ROW, function_name: 'someone_elses_function' },
        }),
      ),
    );

    expect(report.strict.mode).toBe('conflict');
    expect(strictStatusExitCode(report)).toBe(EXIT_CODES.strictConflict);
  });

  it('exits with the guard-health code when strict mode is enabled and broken', async () => {
    const database = readyDatabase({
      presentObjects: [...GUARD_OBJECTS.filter((o) => o !== 'guard.blocked_domains'), 'auth.users'],
      strictTrigger: OUR_STRICT_TRIGGER_ROW,
    });

    const report = await runStrictStatus(withDatabase(database));

    expect(report.strict.mode).toBe('broken');
    expect(strictStatusExitCode(report)).toBe(EXIT_CODES.guardHealth);
  });

  it('creates and modifies nothing', async () => {
    const database = readyDatabase();

    await runStrictStatus(withDatabase(database));

    expect(database.executed).toEqual([]);
    expect(database.closed).toBe(true);
  });
});

describe('strict enable', () => {
  it('creates the trigger and verifies it from the catalog', async () => {
    const database = readyDatabase();

    const report = await runStrictEnable(withDatabase(database));

    expect(report.action).toBe('create');
    expect(report.changed).toBe(true);
    expect(report.verified?.kind).toBe('ours');
    expect(database.executed).toEqual([CREATE_STRICT_TRIGGER_SQL]);
  });

  it('is idempotent: a second run creates no duplicate', async () => {
    const database = readyDatabase({ strictTrigger: OUR_STRICT_TRIGGER_ROW });

    const report = await runStrictEnable(withDatabase(database));

    expect(report.action).toBe('no-op');
    expect(report.changed).toBe(false);
    // No drop-and-recreate: the trigger that is already correct is left alone.
    expect(database.executed).toEqual([]);
  });

  it('refuses when the trigger function is not installed', async () => {
    const database = readyDatabase({
      presentObjects: [...GUARD_OBJECTS.filter((o) => o !== STRICT_TRIGGER_FUNCTION), 'auth.users'],
    });

    const error = await rejection<AppError>(runStrictEnable(withDatabase(database)));

    expect(error).toBeInstanceOf(GuardHealthError);
    expect(error.exitCode).toBe(EXIT_CODES.guardHealth);
    expect(error.hint).toContain('install');
    expect(database.executed).toEqual([]);
  });

  it('refuses when auth.users does not exist', async () => {
    const database = new FakeDatabase({
      presentObjects: GUARD_OBJECTS,
      rowCounts: { 'guard.blocked_domains': 3, 'guard.allowed_domains': 1 },
    }).seedHistory(HISTORY);

    const error = await rejection<AppError>(runStrictEnable(withDatabase(database)));

    expect(error).toBeInstanceOf(GuardHealthError);
    expect(error.message).toContain('auth.users does not exist');
    expect(database.executed).toEqual([]);
  });

  it('refuses when the guard policy layer is damaged', async () => {
    // The trigger fails closed. Attaching it to a broken policy engine would not
    // weaken the filter -- it would stop every write to auth.users.
    const database = readyDatabase({
      presentObjects: [...GUARD_OBJECTS.filter((o) => o !== 'guard.allowed_domains'), 'auth.users'],
    });

    const error = await rejection<AppError>(runStrictEnable(withDatabase(database)));

    expect(error).toBeInstanceOf(GuardHealthError);
    expect(error.message).toContain('guard policy layer is not healthy');
    expect(database.executed).toEqual([]);
  });

  it('refuses when the connected role cannot create a trigger', async () => {
    const database = readyDatabase({ privileges: {} });

    const error = await rejection<AppError>(runStrictEnable(withDatabase(database)));

    expect(error).toBeInstanceOf(GuardHealthError);
    expect(`${error.message} ${error.hint ?? ''}`).toContain('TRIGGER privilege');
    expect(database.executed).toEqual([]);
  });

  it('refuses to overwrite a trigger that is not ours', async () => {
    const database = readyDatabase({
      strictTrigger: { ...OUR_STRICT_TRIGGER_ROW, function_schema: 'public', function_name: 'x' },
    });

    const error = await rejection<AppError>(runStrictEnable(withDatabase(database)));

    expect(error).toBeInstanceOf(StrictTriggerConflictError);
    expect(error.exitCode).toBe(EXIT_CODES.strictConflict);
    expect(error.hint).toContain('Refusing to create it');
    expect(database.executed).toEqual([]);
  });

  it('always closes the connection, even when it refuses', async () => {
    const database = readyDatabase({ privileges: {} });

    await rejection(runStrictEnable(withDatabase(database)));

    expect(database.closed).toBe(true);
  });
});

describe('strict enable --dry-run', () => {
  it('plans the change and executes no DDL', async () => {
    const database = readyDatabase();

    const report = await runStrictEnable(withDatabase(database), { dryRun: true });

    expect(report.action).toBe('create');
    expect(report.changed).toBe(false);
    expect(database.executed).toEqual([]);
  });

  it('surfaces a conflict rather than previewing a change it could not make', async () => {
    const database = readyDatabase({
      strictTrigger: { ...OUR_STRICT_TRIGGER_ROW, tgenabled: 'D' },
    });

    await expect(runStrictEnable(withDatabase(database), { dryRun: true })).rejects.toThrow(
      StrictTriggerConflictError,
    );
    expect(database.executed).toEqual([]);
  });

  it('fails the same preflight the real run fails', async () => {
    // A preview whose verdict differs from the run it previews is worse than none.
    const database = readyDatabase({ privileges: {} });

    await expect(runStrictEnable(withDatabase(database), { dryRun: true })).rejects.toThrow(
      GuardHealthError,
    );
  });

  it('reports a no-op when strict mode is already on', async () => {
    const report = await runStrictEnable(
      withDatabase(readyDatabase({ strictTrigger: OUR_STRICT_TRIGGER_ROW })),
      { dryRun: true },
    );

    expect(report.action).toBe('no-op');
  });
});

describe('strict disable', () => {
  it('drops our trigger and verifies its absence', async () => {
    const database = readyDatabase({ strictTrigger: OUR_STRICT_TRIGGER_ROW });

    const report = await runStrictDisable(withDatabase(database));

    expect(report.action).toBe('drop');
    expect(report.changed).toBe(true);
    expect(report.verified?.kind).toBe('absent');
    expect(database.executed).toEqual([DROP_STRICT_TRIGGER_SQL]);
  });

  it('is idempotent: a second run is a successful no-op', async () => {
    const database = readyDatabase();

    const report = await runStrictDisable(withDatabase(database));

    expect(report.action).toBe('no-op');
    expect(database.executed).toEqual([]);
  });

  it('refuses to drop a trigger that is not ours', async () => {
    const database = readyDatabase({
      strictTrigger: { ...OUR_STRICT_TRIGGER_ROW, function_name: 'someone_elses_function' },
    });

    const error = await rejection<AppError>(runStrictDisable(withDatabase(database)));

    expect(error).toBeInstanceOf(StrictTriggerConflictError);
    expect(error.hint).toContain('Refusing to drop it');
    expect(database.executed).toEqual([]);
  });

  it('works even when the guard layer is completely gone', async () => {
    // This is the moment an operator most needs it: the trigger is failing closed
    // because the policy engine is broken. Requiring a healthy guard schema to switch
    // it off would close the only exit.
    const database = new FakeDatabase({
      presentObjects: ['auth.users'],
      strictTrigger: OUR_STRICT_TRIGGER_ROW,
    });

    const report = await runStrictDisable(withDatabase(database));

    expect(report.changed).toBe(true);
    expect(database.executed).toEqual([DROP_STRICT_TRIGGER_SQL]);
  });

  it('executes no DDL under --dry-run', async () => {
    const database = readyDatabase({ strictTrigger: OUR_STRICT_TRIGGER_ROW });

    const report = await runStrictDisable(withDatabase(database), { dryRun: true });

    expect(report.action).toBe('drop');
    expect(report.changed).toBe(false);
    expect(database.executed).toEqual([]);
  });
});

describe('output', () => {
  it('marks a disabled strict mode as optional, never as an error', async () => {
    const { logger, output } = createRecordingLogger();
    const report = await runStrictStatus(withDatabase(readyDatabase()));

    printStrictSection(report.strict, logger);

    expect(output()).toContain('Strict database enforcement');
    expect(output()).toContain('Disabled (optional)');
  });

  it('shows the trigger shape and the policy it delegates to when enabled', async () => {
    const { logger, output } = createRecordingLogger();
    const report = await runStrictStatus(
      withDatabase(readyDatabase({ strictTrigger: OUR_STRICT_TRIGGER_ROW })),
    );

    printStrictStatusReport(report, logger);

    expect(output()).toContain('Trigger function installed');
    expect(output()).toContain('auth.users compatible');
    expect(output()).toContain('Strict mode enabled');
    expect(output()).toContain('BEFORE INSERT OR UPDATE OF email');
    expect(output()).toContain('guard.is_disposable_domain(email)');
    // The hook must never be presented as replaceable by this.
    expect(output()).toContain('Before User Created hook');
  });

  it('names every reason for a conflict', async () => {
    const { logger, output } = createRecordingLogger();
    const report = await runStrictStatus(
      withDatabase(
        readyDatabase({ strictTrigger: { ...OUR_STRICT_TRIGGER_ROW, function_name: 'other' } }),
      ),
    );

    printStrictStatusReport(report, logger);

    expect(output()).toContain('Trigger configuration conflict');
    expect(output()).toContain('guard.other()');
    expect(output()).toContain('This tool will not change it.');
  });

  it('says loudly when strict mode is on and the policy layer is damaged', async () => {
    const { logger, output } = createRecordingLogger();
    const report = await runStrictStatus(
      withDatabase(
        readyDatabase({
          presentObjects: [
            ...GUARD_OBJECTS.filter((o) => o !== 'guard.blocked_domains'),
            'auth.users',
          ],
          strictTrigger: OUR_STRICT_TRIGGER_ROW,
        }),
      ),
    );

    printStrictStatusReport(report, logger);

    expect(output()).toContain('ENABLED and the policy layer it calls is damaged');
    expect(output()).toContain('strict disable');
  });

  it('prints the dry-run preview with the trigger shape and no change claim', async () => {
    const { logger, output } = createRecordingLogger();
    const report = await runStrictEnable(withDatabase(readyDatabase()), { dryRun: true });

    printStrictMutationReport(report, logger);

    expect(output()).toContain('Would create:');
    expect(output()).toContain(STRICT_TRIGGER_NAME);
    expect(output()).toContain('BEFORE INSERT OR UPDATE OF email');
    expect(output()).toContain('ON auth.users');
    expect(output()).toContain('guard.is_disposable_domain(email)');
    expect(output()).toContain('No database changes made.');
  });

  it('states that disabling leaves the function and unrelated triggers alone', async () => {
    const { logger, output } = createRecordingLogger();
    const report = await runStrictDisable(
      withDatabase(readyDatabase({ strictTrigger: OUR_STRICT_TRIGGER_ROW })),
    );

    printStrictMutationReport(report, logger);

    expect(output()).toContain('Strict mode disabled');
    expect(output()).toContain(STRICT_TRIGGER_FUNCTION);
    expect(output()).toContain('Unrelated triggers on the table were not touched.');
  });

  it('does not claim protection when enabling — the hook stays the primary layer', async () => {
    const { logger, output } = createRecordingLogger();
    const report = await runStrictEnable(withDatabase(readyDatabase()));

    printStrictMutationReport(report, logger);

    expect(output()).toContain('This is a backstop.');
    expect(output()).toContain('Before User Created hook remains');
  });
});
