import { describe, expect, it, vi } from 'vitest';

import { printDoctorReport, runDoctor } from '../../src/commands/doctor.js';
import type { DatabaseConnection, QueryResult } from '../../src/database/types.js';
import { ConfigurationError, DatabaseConnectionError, EXIT_CODES } from '../../src/lib/errors.js';
import { createRecordingLogger } from '../helpers/logger.js';

const PASSWORD = 'hunter2';
const DB_URL = `postgresql://postgres:${PASSWORD}@db.example.supabase.co:5432/postgres?sslmode=require`;
const SUPPORTED_NODE = '22.11.0';

interface FakeConnectionOptions {
  serverVersion?: string;
  closeError?: Error;
}

function createFakeConnection(options: FakeConnectionOptions = {}) {
  const close = vi.fn(async () => {
    if (options.closeError) {
      throw options.closeError;
    }
  });

  const query = vi.fn(async (): Promise<QueryResult<Record<string, unknown>>> => ({
    rows: [{ server_version: options.serverVersion ?? '17.4' }],
    rowCount: 1,
  }));

  const connection: DatabaseConnection = {
    target: 'db.example.supabase.co:5432/postgres',
    query: query as DatabaseConnection['query'],
    execute: vi.fn(async () => undefined),
    close,
  };

  return { connection, close, query };
}

describe('runDoctor', () => {
  it('fails immediately on an unsupported Node.js version', async () => {
    const connect = vi.fn();
    const report = await runDoctor({ env: {}, nodeVersion: '18.20.4', connect });

    expect(report.ok).toBe(false);
    expect(report.failure?.exitCode).toBe(EXIT_CODES.configuration);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]?.message).toContain('18.20.4');
    expect(connect).not.toHaveBeenCalled();
  });

  it('reports a missing SUPABASE_DB_URL without attempting a connection', async () => {
    const connect = vi.fn();
    const report = await runDoctor({ env: {}, nodeVersion: SUPPORTED_NODE, connect });

    expect(report.ok).toBe(false);
    expect(report.failure).toBeInstanceOf(ConfigurationError);
    expect(report.checks.at(-1)).toEqual({ status: 'fail', message: 'SUPABASE_DB_URL is missing' });
    expect(report.failure?.hint).toContain('SUPABASE_DB_URL');
    expect(connect).not.toHaveBeenCalled();
  });

  it('reports an invalid SUPABASE_DB_URL as a configuration failure', async () => {
    const report = await runDoctor({
      env: { SUPABASE_DB_URL: 'http://example.com' },
      nodeVersion: SUPPORTED_NODE,
      connect: vi.fn(),
    });

    expect(report.ok).toBe(false);
    expect(report.failure).toBeInstanceOf(ConfigurationError);
    expect(report.checks.at(-1)?.message).toContain('Invalid configuration');
  });

  it('surfaces a connection failure with the database exit code', async () => {
    const connect = vi.fn(async () => {
      throw new DatabaseConnectionError(
        'Could not connect to db.example.supabase.co:5432/postgres',
        {
          cause: new Error('ECONNREFUSED'),
          hint: 'Check SUPABASE_DB_URL.',
        },
      );
    });

    const report = await runDoctor({
      env: { SUPABASE_DB_URL: DB_URL },
      nodeVersion: SUPPORTED_NODE,
      connect,
    });

    expect(report.ok).toBe(false);
    expect(report.failure?.exitCode).toBe(EXIT_CODES.database);
    expect(connect).toHaveBeenCalledOnce();
  });

  it('passes and closes the connection when the database is reachable', async () => {
    const { connection, close, query } = createFakeConnection({ serverVersion: '17.4' });

    const report = await runDoctor({
      env: { SUPABASE_DB_URL: DB_URL },
      nodeVersion: SUPPORTED_NODE,
      connect: async () => connection,
    });

    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.status)).toEqual(['pass', 'pass', 'pass', 'pass']);
    expect(report.checks.at(-1)?.message).toBe('PostgreSQL 17.4 detected');
    expect(close).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledOnce();
  });

  it('strips the vendor suffix from the reported server version', async () => {
    const { connection } = createFakeConnection({ serverVersion: '18.3 (Homebrew)' });

    const report = await runDoctor({
      env: { SUPABASE_DB_URL: DB_URL },
      nodeVersion: SUPPORTED_NODE,
      connect: async () => connection,
    });

    expect(report.checks.at(-1)?.message).toBe('PostgreSQL 18.3 detected');
  });

  it('warns but still passes when closing the connection fails', async () => {
    const { connection } = createFakeConnection({ closeError: new Error('already closed') });

    const report = await runDoctor({
      env: { SUPABASE_DB_URL: DB_URL },
      nodeVersion: SUPPORTED_NODE,
      connect: async () => connection,
    });

    expect(report.ok).toBe(true);
    expect(report.checks.some((check) => check.status === 'warn')).toBe(true);
  });

  it('closes the connection even when the version query fails', async () => {
    const close = vi.fn(async () => undefined);
    const connection: DatabaseConnection = {
      target: 'db.example.supabase.co:5432/postgres',
      query: vi.fn(async () => {
        throw new DatabaseConnectionError(
          'Query failed against db.example.supabase.co:5432/postgres',
        );
      }),
      execute: vi.fn(async () => undefined),
      close,
    };

    const report = await runDoctor({
      env: { SUPABASE_DB_URL: DB_URL },
      nodeVersion: SUPPORTED_NODE,
      connect: async () => connection,
    });

    expect(report.ok).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('printDoctorReport', () => {
  it('never prints the connection string or password', async () => {
    const { connection } = createFakeConnection();
    const { logger, lines } = createRecordingLogger();

    const report = await runDoctor({
      env: { SUPABASE_DB_URL: DB_URL },
      nodeVersion: SUPPORTED_NODE,
      connect: async () => connection,
    });
    printDoctorReport(report, logger);

    const output = lines.join('\n');
    expect(output).not.toContain(PASSWORD);
    expect(output).not.toContain(DB_URL);
    expect(output).toContain('Supabase Anti-Disposable Auth');
    expect(output).toContain('Environment looks healthy.');
  });

  it('adds diagnostics only when debug is requested', async () => {
    const failing = vi.fn(async () => {
      throw new DatabaseConnectionError(
        'Could not connect to db.example.supabase.co:5432/postgres',
        {
          cause: new Error('ECONNREFUSED'),
          hint: 'Check SUPABASE_DB_URL.',
        },
      );
    });
    const report = await runDoctor({
      env: { SUPABASE_DB_URL: DB_URL },
      nodeVersion: SUPPORTED_NODE,
      connect: failing,
    });

    const plain = createRecordingLogger();
    printDoctorReport(report, plain.logger);
    expect(plain.lines.join('\n')).not.toContain('ECONNREFUSED');

    const debug = createRecordingLogger();
    printDoctorReport(report, debug.logger, { debug: true });
    const output = debug.lines.join('\n');
    expect(output).toContain('ECONNREFUSED');
    expect(output).not.toContain(PASSWORD);
  });

  it('ends with the failure hint when a check fails', async () => {
    const { logger, lines } = createRecordingLogger();

    const report = await runDoctor({ env: {}, nodeVersion: SUPPORTED_NODE, connect: vi.fn() });
    printDoctorReport(report, logger);

    expect(lines.at(-1)).toContain('SUPABASE_DB_URL');
  });
});
