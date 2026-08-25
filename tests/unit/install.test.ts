import { describe, expect, it, vi } from 'vitest';

import { printInstallSummary, runInstall } from '../../src/commands/install.js';
import { calculateChecksum } from '../../src/database/migrations.js';
import type { MigrationFile } from '../../src/database/migration-types.js';
import { ConfigurationError, EXIT_CODES, MigrationError } from '../../src/lib/errors.js';
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

describe('runInstall', () => {
  it('refuses to run without SUPABASE_DB_URL and never opens a connection', async () => {
    const connect = vi.fn();

    await expect(runInstall({ env: {}, connect })).rejects.toThrow(ConfigurationError);
    expect(connect).not.toHaveBeenCalled();
  });

  it('exits with the configuration code when the url is missing', async () => {
    await expect(runInstall({ env: {}, connect: vi.fn() })).rejects.toMatchObject({
      exitCode: EXIT_CODES.configuration,
    });
  });

  it('applies every migration and closes the connection', async () => {
    const database = new FakeDatabase();

    const report = await runInstall({
      env: { SUPABASE_DB_URL: DB_URL },
      connect: async () => database,
      files: [FIRST, SECOND],
    });

    expect(report.applied).toEqual([FIRST, SECOND]);
    expect(report.skipped).toEqual([]);
    expect(report.currentVersion).toBe('002');
    expect(database.closed).toBe(true);
  });

  it('is idempotent: a second install applies nothing', async () => {
    const database = new FakeDatabase();
    const dependencies = {
      env: { SUPABASE_DB_URL: DB_URL },
      connect: async () => database,
      files: [FIRST, SECOND],
    };

    await runInstall(dependencies);
    const report = await runInstall(dependencies);

    expect(report.applied).toEqual([]);
    expect(report.skipped).toEqual([FIRST, SECOND]);
  });

  it('reports connection and per-migration progress as it happens', async () => {
    const onConnected = vi.fn();
    const onMigrationApplied = vi.fn();

    await runInstall(
      {
        env: { SUPABASE_DB_URL: DB_URL },
        connect: async () => new FakeDatabase(),
        files: [FIRST, SECOND],
      },
      { onConnected, onMigrationApplied },
    );

    expect(onConnected).toHaveBeenCalledWith('db.example.test:5432/postgres');
    expect(onMigrationApplied).toHaveBeenCalledTimes(2);
  });

  it('closes the connection even when a migration fails', async () => {
    const database = new FakeDatabase({ failOnSqlContaining: SECOND.sql });

    await expect(
      runInstall({
        env: { SUPABASE_DB_URL: DB_URL },
        connect: async () => database,
        files: [FIRST, SECOND],
      }),
    ).rejects.toThrow(MigrationError);

    expect(database.closed).toBe(true);
  });
});

describe('printInstallSummary', () => {
  it('confirms the install when migrations were applied', () => {
    const { logger, output } = createRecordingLogger();

    printInstallSummary(
      { target: 'db:5432/postgres', applied: [FIRST], skipped: [], currentVersion: '001' },
      logger,
    );

    expect(output()).toContain('Database guard layer installed.');
  });

  it('says the layer is already current when nothing was applied', () => {
    const { logger, output } = createRecordingLogger();

    printInstallSummary(
      { target: 'db:5432/postgres', applied: [], skipped: [FIRST], currentVersion: '001' },
      logger,
    );

    expect(output()).toContain('Database guard layer already up to date.');
    expect(output()).not.toContain('Database guard layer installed.');
  });

  it('never prints the connection string or password', async () => {
    const { logger, output } = createRecordingLogger();

    const report = await runInstall({
      env: { SUPABASE_DB_URL: DB_URL },
      connect: async () => new FakeDatabase(),
      files: [FIRST],
    });
    printInstallSummary(report, logger);

    expect(output()).not.toContain(PASSWORD);
    expect(output()).not.toContain(DB_URL);
  });
});
