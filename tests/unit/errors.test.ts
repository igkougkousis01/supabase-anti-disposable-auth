import { describe, expect, it } from 'vitest';

import {
  ConfigurationError,
  DatabaseConnectionError,
  EXIT_CODES,
  formatErrorForUser,
  isAppError,
  toAppError,
  UnexpectedError,
} from '../../src/lib/errors.js';
import { describeConnectionTarget } from '../../src/lib/redact.js';

describe('error kinds', () => {
  it('maps each error to a stable exit code', () => {
    expect(new ConfigurationError('bad config').exitCode).toBe(EXIT_CODES.configuration);
    expect(new DatabaseConnectionError('no route').exitCode).toBe(EXIT_CODES.database);
    expect(new UnexpectedError('boom').exitCode).toBe(EXIT_CODES.unexpected);
  });

  it('keeps the class name for readable stack traces', () => {
    expect(new ConfigurationError('bad config').name).toBe('ConfigurationError');
  });
});

describe('toAppError', () => {
  it('passes application errors through untouched', () => {
    const original = new ConfigurationError('missing');
    expect(toAppError(original)).toBe(original);
  });

  it('wraps unknown throwables and preserves the cause', () => {
    const cause = new Error('socket hang up');
    const wrapped = toAppError(cause);

    expect(isAppError(wrapped)).toBe(true);
    expect(wrapped.kind).toBe('unexpected');
    expect(wrapped.cause).toBe(cause);
  });

  it('wraps non-error values', () => {
    expect(toAppError('nope').message).toContain('nope');
  });
});

describe('formatErrorForUser', () => {
  it('shows a friendly message and hint for expected failures, without a stack', () => {
    const lines = formatErrorForUser(
      new ConfigurationError('SUPABASE_DB_URL is missing', { hint: 'Set it and retry.' }),
    );

    expect(lines).toEqual(['SUPABASE_DB_URL is missing', 'Set it and retry.']);
  });

  it('includes diagnostics for unexpected errors', () => {
    const lines = formatErrorForUser(new Error('kaboom'));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('\n')).toContain('kaboom');
  });

  it('includes diagnostics for expected errors only in debug mode', () => {
    const error = new DatabaseConnectionError('Could not connect to db.example:5432/postgres', {
      cause: new Error('ECONNREFUSED'),
    });

    expect(formatErrorForUser(error).join('\n')).not.toContain('ECONNREFUSED');
    expect(formatErrorForUser(error, { debug: true }).join('\n')).toContain('ECONNREFUSED');
  });
});

describe('describeConnectionTarget', () => {
  it('drops the user and password', () => {
    const target = describeConnectionTarget(
      'postgresql://postgres:hunter2@db.example.supabase.co:5432/postgres?sslmode=require',
    );

    expect(target).toBe('db.example.supabase.co:5432/postgres');
    expect(target).not.toContain('hunter2');
    expect(target).not.toContain('postgres:');
  });

  it('defaults the port when the connection string omits it', () => {
    expect(describeConnectionTarget('postgresql://user:pw@localhost/postgres')).toBe(
      'localhost:5432/postgres',
    );
  });

  it('falls back to a generic description for unparseable input', () => {
    expect(describeConnectionTarget('nonsense')).toBe('the configured database');
  });
});
