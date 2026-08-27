import { describe, expect, it } from 'vitest';

import {
  isSupportedNodeVersion,
  loadConfig,
  requireDatabaseUrl,
  requireManagementCredentials,
} from '../../src/config/env.js';
import { ConfigurationError } from '../../src/lib/errors.js';

const VALID_REF = 'abcdefghijklmnopqrst';
const TOKEN = 'sbp_TOKEN_SENTINEL';

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
    expect(config).toEqual({
      databaseUrl: VALID_URL,
      projectRef: undefined,
      accessToken: undefined,
    });
  });
});

describe('loadConfig — Management API credentials', () => {
  it('leaves both undefined when neither is set', () => {
    const config = loadConfig({ SUPABASE_DB_URL: VALID_URL });

    expect(config.projectRef).toBeUndefined();
    expect(config.accessToken).toBeUndefined();
  });

  it('does not fail a database-only environment', () => {
    // The rule that keeps `doctor`, `install`, `sync` and `status` working for anyone
    // who never intends to touch the Management API.
    expect(() => loadConfig({ SUPABASE_DB_URL: VALID_URL })).not.toThrow();
  });

  it('does not fail a Management-API-only environment', () => {
    expect(() =>
      loadConfig({ SUPABASE_PROJECT_REF: VALID_REF, SUPABASE_ACCESS_TOKEN: TOKEN }),
    ).not.toThrow();
  });

  it('accepts a valid project ref', () => {
    expect(loadConfig({ SUPABASE_PROJECT_REF: VALID_REF }).projectRef).toBe(VALID_REF);
  });

  it('accepts a project ref containing digits', () => {
    expect(loadConfig({ SUPABASE_PROJECT_REF: 'abcdefghijklmnop1234' }).projectRef).toBe(
      'abcdefghijklmnop1234',
    );
  });

  it.each([
    'tooshort',
    'abcdefghijklmnopqrstu',
    'ABCDEFGHIJKLMNOPQRST',
    'abcdefghijklmnopqrs/',
    'abcdefghijklmnopqr.s',
    '../projects/other/co',
  ])('rejects the malformed project ref %j', (ref) => {
    expect(() => loadConfig({ SUPABASE_PROJECT_REF: ref })).toThrow(ConfigurationError);
  });

  it('trims whitespace around a project ref and a token', () => {
    const config = loadConfig({
      SUPABASE_PROJECT_REF: `  ${VALID_REF}\n`,
      SUPABASE_ACCESS_TOKEN: `  ${TOKEN}\n`,
    });

    // Trailing newlines arrive routinely from `$(cat token-file)`.
    expect(config.projectRef).toBe(VALID_REF);
    expect(config.accessToken).toBe(TOKEN);
  });

  it.each(['', '   '])('treats a blank token (%j) as missing', (token) => {
    expect(loadConfig({ SUPABASE_ACCESS_TOKEN: token }).accessToken).toBeUndefined();
  });

  it('never includes the token in a validation error', () => {
    // Zod builds issue messages from the value's shape, so a schema that constrained the
    // token's format could quote it back. This asserts that path stays closed.
    let message = '';
    try {
      loadConfig({ SUPABASE_PROJECT_REF: 'bad', SUPABASE_ACCESS_TOKEN: TOKEN });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).not.toBe('');
    expect(message).not.toContain(TOKEN);
  });

  it('never includes the offending project ref in the error message', () => {
    let message = '';
    try {
      loadConfig({ SUPABASE_PROJECT_REF: 'WRONGLY_PASTED_TOKEN_VALUE' });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).not.toContain('WRONGLY_PASTED_TOKEN_VALUE');
  });
});

describe('requireDatabaseUrl', () => {
  it('returns the URL when present', () => {
    expect(requireDatabaseUrl(loadConfig({ SUPABASE_DB_URL: VALID_URL }), 'status')).toBe(
      VALID_URL,
    );
  });

  it('throws a configuration error naming the command', () => {
    const error = (() => {
      try {
        requireDatabaseUrl(loadConfig({}), 'sync');
        return undefined;
      } catch (cause) {
        return cause as ConfigurationError;
      }
    })();

    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error?.hint).toContain('sync');
  });
});

describe('requireManagementCredentials', () => {
  it('returns both credentials when present', () => {
    const config = loadConfig({
      SUPABASE_PROJECT_REF: VALID_REF,
      SUPABASE_ACCESS_TOKEN: TOKEN,
    });

    expect(requireManagementCredentials(config, 'hook enable')).toEqual({
      projectRef: VALID_REF,
      accessToken: TOKEN,
    });
  });

  it.each([
    [{ SUPABASE_ACCESS_TOKEN: TOKEN }, 'SUPABASE_PROJECT_REF'],
    [{ SUPABASE_PROJECT_REF: VALID_REF }, 'SUPABASE_ACCESS_TOKEN'],
  ])('names the missing variable', (env, expected) => {
    const error = (() => {
      try {
        requireManagementCredentials(loadConfig(env), 'hook enable');
        return undefined;
      } catch (cause) {
        return cause as ConfigurationError;
      }
    })();

    expect(error?.message).toContain(expected);
  });

  it('names both when both are missing, in one error', () => {
    // One attempt, one complete answer. Discovering the second variable only after
    // fixing the first is a bad first-run experience.
    const error = (() => {
      try {
        requireManagementCredentials(loadConfig({}), 'hook status');
        return undefined;
      } catch (cause) {
        return cause as ConfigurationError;
      }
    })();

    expect(error?.message).toContain('SUPABASE_PROJECT_REF');
    expect(error?.message).toContain('SUPABASE_ACCESS_TOKEN');
  });

  it('never echoes the token, even when only the ref is missing', () => {
    const error = (() => {
      try {
        requireManagementCredentials(loadConfig({ SUPABASE_ACCESS_TOKEN: TOKEN }), 'hook enable');
        return undefined;
      } catch (cause) {
        return cause as ConfigurationError;
      }
    })();

    expect(`${error?.message ?? ''} ${error?.hint ?? ''}`).not.toContain(TOKEN);
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
