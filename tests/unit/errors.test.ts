import { describe, expect, it } from 'vitest';

import {
  AuthHookConflictError,
  AuthHookVerificationError,
  ConfigurationError,
  DatabaseConnectionError,
  EXIT_CODES,
  formatErrorForUser,
  GuardHealthError,
  isAppError,
  SupabaseApiError,
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

  it('maps each remote error to its own stable exit code', () => {
    expect(new SupabaseApiError('api down').exitCode).toBe(EXIT_CODES.remote);
    expect(new AuthHookConflictError('someone else').exitCode).toBe(EXIT_CODES.hookConflict);
    expect(new AuthHookVerificationError('not applied').exitCode).toBe(EXIT_CODES.hookVerification);
  });

  it('reuses the guard-health code for a failed preflight', () => {
    // The same verdict `status` reaches, acted on instead of merely reported -- so it
    // gets the same code rather than a fourth one.
    expect(new GuardHealthError('layer broken').exitCode).toBe(EXIT_CODES.guardHealth);
  });

  it('keeps every exit code distinct', () => {
    // The point of the hierarchy: a CI job must be able to route "wrong token" and
    // "somebody else's hook" and "we wrote it and it did not stick" to different places.
    const codes = Object.values(EXIT_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('does not conflate a remote failure with a configuration or database failure', () => {
    for (const remote of [
      new SupabaseApiError('x'),
      new AuthHookConflictError('x'),
      new AuthHookVerificationError('x'),
    ]) {
      expect(remote.exitCode).not.toBe(EXIT_CODES.configuration);
      expect(remote.exitCode).not.toBe(EXIT_CODES.database);
      expect(remote.exitCode).not.toBe(EXIT_CODES.guardHealth);
      expect(remote.kind).toBe('remote');
    }
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
