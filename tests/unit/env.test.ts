import { describe, expect, it } from 'vitest';

import { isSupportedNodeVersion, loadConfig } from '../../src/config/env.js';
import { ConfigurationError } from '../../src/lib/errors.js';

const VALID_URL =
  'postgresql://postgres:s3cr3t@db.example.supabase.co:5432/postgres?sslmode=require';

describe('loadConfig', () => {
  it('returns an undefined database url when SUPABASE_DB_URL is not set', () => {
    expect(loadConfig({}).databaseUrl).toBeUndefined();
  });

  it('treats a blank SUPABASE_DB_URL as missing', () => {
    expect(loadConfig({ SUPABASE_DB_URL: '   ' }).databaseUrl).toBeUndefined();
  });

  it('accepts a valid postgres connection string', () => {
    expect(loadConfig({ SUPABASE_DB_URL: VALID_URL }).databaseUrl).toBe(VALID_URL);
  });

  it('accepts the postgres:// protocol and trims surrounding whitespace', () => {
    const url = 'postgres://postgres:s3cr3t@db.example.supabase.co:5432/postgres';
    expect(loadConfig({ SUPABASE_DB_URL: `  ${url}  ` }).databaseUrl).toBe(url);
  });

  it('rejects a value that is not a URL', () => {
    expect(() => loadConfig({ SUPABASE_DB_URL: 'definitely-not-a-url' })).toThrow(
      ConfigurationError,
    );
  });

  it('rejects a non-postgres protocol', () => {
    expect(() => loadConfig({ SUPABASE_DB_URL: 'mysql://user:pw@host:3306/db' })).toThrow(
      ConfigurationError,
    );
  });

  it('never includes the offending value in the error message', () => {
    const secret = 'postgresql://postgres:hunter2@'; // malformed: no host
    let message = '';
    try {
      loadConfig({ SUPABASE_DB_URL: secret });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).not.toBe('');
    expect(message).not.toContain('hunter2');
  });

  it('ignores unrelated environment variables', () => {
    const config = loadConfig({ SUPABASE_DB_URL: VALID_URL, SOME_OTHER_SECRET: 'nope' });
    expect(config).toEqual({ databaseUrl: VALID_URL });
  });
});

describe('isSupportedNodeVersion', () => {
  it.each(['20.12.0', 'v20.12.1', '22.0.0', '24.3.1'])('accepts %s', (version) => {
    expect(isSupportedNodeVersion(version)).toBe(true);
  });

  it.each(['18.20.4', '20.11.9', 'v16.0.0', 'not-a-version'])('rejects %s', (version) => {
    expect(isSupportedNodeVersion(version)).toBe(false);
  });
});
