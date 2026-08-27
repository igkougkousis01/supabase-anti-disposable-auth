/**
 * The access token must not appear anywhere except an Authorization header.
 *
 * `SUPABASE_ACCESS_TOKEN` is the highest-value secret this tool handles: a personal
 * access token carries the privileges of the account that issued it across every project
 * that account can reach, which is far wider than a database URL scoped to one database.
 * A single leak into a CI log, a screenshot or a bug report is a full compromise.
 *
 * So every path that could plausibly print something is driven with a sentinel token and
 * asserted against. These are not tests of a message's wording — they are tests that a
 * class of disclosure does not exist, and they are meant to fail loudly the first time
 * somebody adds a debug line that seemed harmless.
 */

import { describe, expect, it } from 'vitest';

import {
  printHookMutationReport,
  printHookStatusReport,
  runHookDisable,
  runHookEnable,
  runHookStatus,
} from '../../src/commands/hook.js';
import { printStatusReport, runStatus } from '../../src/commands/status.js';
import { loadConfig } from '../../src/config/env.js';
import { calculateChecksum } from '../../src/database/migrations.js';
import type { MigrationFile } from '../../src/database/migration-types.js';
import { formatErrorForUser, toAppError } from '../../src/lib/errors.js';
import { FakeDatabase } from '../helpers/database.js';
import { createRecordingLogger } from '../helpers/logger.js';
import {
  authConfigResponse,
  errorResponse,
  foreign,
  managementApiDouble,
  ours,
  SENTINEL_TOKEN,
  TEST_PROJECT_REF,
  unconfigured,
} from '../helpers/management-api.js';

const DB_PASSWORD = 'hunter2';
const DB_URL = `postgresql://postgres:${DB_PASSWORD}@db.example.supabase.co:5432/postgres?sslmode=require`;

const ENV = {
  SUPABASE_DB_URL: DB_URL,
  SUPABASE_PROJECT_REF: TEST_PROJECT_REF,
  SUPABASE_ACCESS_TOKEN: SENTINEL_TOKEN,
};

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
const HISTORY = [{ version: FIRST.version, name: FIRST.name, checksum: FIRST.checksum }];

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

const AUTH_HOOK_GRANTS = [
  'USAGE on guard',
  'EXECUTE on guard.before_user_created(jsonb)',
  'EXECUTE on guard.is_disposable_domain(text)',
  'EXECUTE on guard.normalize_domain(text)',
  'SELECT on guard.blocked_domains',
  'SELECT on guard.allowed_domains',
];

function healthyDatabase(): FakeDatabase {
  return new FakeDatabase({
    presentObjects: ALL_GUARD_OBJECTS,
    rowCounts: { 'guard.blocked_domains': 3, 'guard.allowed_domains': 0 },
    roles: ['supabase_auth_admin'],
    privileges: { supabase_auth_admin: AUTH_HOOK_GRANTS },
  }).seedHistory(HISTORY);
}

/** Everything an error would put on a terminal, including `--debug` diagnostics. */
function renderError(error: unknown): string {
  const appError = toAppError(error);
  return [
    ...formatErrorForUser(appError, { debug: true }),
    appError.message,
    appError.hint ?? '',
    appError.stack ?? '',
    JSON.stringify(appError, Object.getOwnPropertyNames(appError)),
  ].join('\n');
}

describe('the access token never reaches a request URL', () => {
  it.each([
    ['unconfigured', unconfigured()],
    ['ours', ours(true)],
    ['foreign', foreign(true)],
  ])('for a %s project', async (_label, fields) => {
    const api = managementApiDouble([authConfigResponse(fields)]);

    await runHookStatus({ env: ENV, client: api.client }).catch(() => undefined);

    for (const request of api.requests) {
      expect(request.url).not.toContain(SENTINEL_TOKEN);
      expect(request.url).not.toMatch(/token|secret|bearer/i);
    }
  });

  it('across a full enable round trip', async () => {
    const api = managementApiDouble([
      authConfigResponse(unconfigured()),
      authConfigResponse(ours(true)),
      authConfigResponse(ours(true)),
    ]);

    await runHookEnable({
      env: ENV,
      connect: async () => healthyDatabase(),
      files: FILES,
      client: api.client,
    });

    expect(api.requests).toHaveLength(3);
    for (const request of api.requests) {
      expect(request.url).not.toContain(SENTINEL_TOKEN);
      // It belongs in exactly one place, and it is there.
      expect(request.headers['authorization']).toBe(`Bearer ${SENTINEL_TOKEN}`);
    }
  });

  it('and never in a PATCH body', async () => {
    const api = managementApiDouble([
      authConfigResponse(unconfigured()),
      authConfigResponse(ours(true)),
      authConfigResponse(ours(true)),
    ]);

    await runHookEnable({
      env: ENV,
      connect: async () => healthyDatabase(),
      files: FILES,
      client: api.client,
    });

    for (const request of api.requests) {
      expect(request.body ?? '').not.toContain(SENTINEL_TOKEN);
    }
  });
});

describe('the access token never reaches an error message', () => {
  it.each([401, 403, 404, 429, 500, 503])('for HTTP %i', async (status) => {
    const api = managementApiDouble([errorResponse(status, `denied for ${SENTINEL_TOKEN}`)]);

    const error = await runHookStatus({ env: ENV, client: api.client }).catch(
      (cause: unknown) => cause,
    );

    // Note the server itself echoing the token back: even then it must not be printed.
    expect(renderError(error)).not.toContain(SENTINEL_TOKEN);
  });

  it('for a transport failure', async () => {
    const api = managementApiDouble([
      () => {
        throw new Error(`connect failed while sending ${SENTINEL_TOKEN}`);
      },
    ]);

    const error = await runHookStatus({ env: ENV, client: api.client }).catch(
      (cause: unknown) => cause,
    );

    // The cause is attached for diagnostics, so this asserts the rendered `--debug`
    // output too -- the one place a careless `cause` would surface it.
    expect(renderError(error)).not.toContain(SENTINEL_TOKEN);
  });

  it('for a malformed response', async () => {
    const api = managementApiDouble([
      new Response('{oops', { status: 200, headers: { 'content-type': 'application/json' } }),
    ]);

    const error = await runHookStatus({ env: ENV, client: api.client }).catch(
      (cause: unknown) => cause,
    );

    expect(renderError(error)).not.toContain(SENTINEL_TOKEN);
  });

  it('for a hook conflict', async () => {
    const api = managementApiDouble([authConfigResponse(foreign(true))]);

    const error = await runHookEnable({
      env: ENV,
      connect: async () => healthyDatabase(),
      files: FILES,
      client: api.client,
    }).catch((cause: unknown) => cause);

    expect(renderError(error)).not.toContain(SENTINEL_TOKEN);
  });

  it('for a post-write verification failure', async () => {
    const api = managementApiDouble([
      authConfigResponse(unconfigured()),
      authConfigResponse(ours(true)),
      authConfigResponse(ours(false)),
    ]);

    const error = await runHookEnable({
      env: ENV,
      connect: async () => healthyDatabase(),
      files: FILES,
      client: api.client,
    }).catch((cause: unknown) => cause);

    expect(renderError(error)).not.toContain(SENTINEL_TOKEN);
  });

  it('for a configuration error raised while the token is set', async () => {
    const error = await runHookStatus({
      env: { SUPABASE_ACCESS_TOKEN: SENTINEL_TOKEN },
    }).catch((cause: unknown) => cause);

    expect(renderError(error)).not.toContain(SENTINEL_TOKEN);
  });

  it('for an invalid token value that fails validation', async () => {
    // Zod issue messages are built from the value's own shape. A schema that quoted the
    // received value would leak the secret through a "helpful" validation message.
    const error = (() => {
      try {
        loadConfig({ SUPABASE_ACCESS_TOKEN: SENTINEL_TOKEN, SUPABASE_PROJECT_REF: 'bad' });
        return undefined;
      } catch (cause) {
        return cause;
      }
    })();

    expect(renderError(error)).not.toContain(SENTINEL_TOKEN);
  });
});

describe('the access token never reaches normal output', () => {
  it('through hook status', async () => {
    const api = managementApiDouble([authConfigResponse(ours(true))]);
    const { logger, output } = createRecordingLogger();

    printHookStatusReport(await runHookStatus({ env: ENV, client: api.client }), logger);

    expect(output()).not.toContain(SENTINEL_TOKEN);
  });

  it('through a successful hook enable', async () => {
    const api = managementApiDouble([
      authConfigResponse(unconfigured()),
      authConfigResponse(ours(true)),
      authConfigResponse(ours(true)),
    ]);
    const { logger, output } = createRecordingLogger();

    const report = await runHookEnable(
      { env: ENV, connect: async () => healthyDatabase(), files: FILES, client: api.client },
      {},
      {
        onPreflightPassed: (preflight) => logger.success(preflight.target),
        onRemoteRead: () => logger.success('read'),
        onPatchSent: () => logger.success('patched'),
        onVerified: () => logger.success('verified'),
      },
    );
    printHookMutationReport(report, logger);

    expect(output()).not.toContain(SENTINEL_TOKEN);
    // The database password must not appear either -- the target is redacted.
    expect(output()).not.toContain(DB_PASSWORD);
  });

  it('through a dry run', async () => {
    const api = managementApiDouble([authConfigResponse(unconfigured())]);
    const { logger, output } = createRecordingLogger();

    const report = await runHookEnable(
      { env: ENV, connect: async () => healthyDatabase(), files: FILES, client: api.client },
      { dryRun: true },
    );
    printHookMutationReport(report, logger);

    expect(output()).not.toContain(SENTINEL_TOKEN);
  });

  it('through hook disable', async () => {
    const api = managementApiDouble([
      authConfigResponse(ours(true)),
      authConfigResponse(ours(false)),
      authConfigResponse(ours(false)),
    ]);
    const { logger, output } = createRecordingLogger();

    printHookMutationReport(await runHookDisable({ env: ENV, client: api.client }), logger);

    expect(output()).not.toContain(SENTINEL_TOKEN);
  });

  it('through the main status report, including its remote section', async () => {
    const api = managementApiDouble([authConfigResponse(ours(true))]);
    const { logger, output } = createRecordingLogger();

    printStatusReport(
      await runStatus({
        env: ENV,
        connect: async () => healthyDatabase(),
        files: FILES,
        client: api.client,
      }),
      logger,
    );

    expect(output()).not.toContain(SENTINEL_TOKEN);
    expect(output()).not.toContain(DB_PASSWORD);
  });

  it('through the main status report when the remote check fails', async () => {
    const api = managementApiDouble([errorResponse(401, `bad token ${SENTINEL_TOKEN}`)]);
    const { logger, output } = createRecordingLogger();

    printStatusReport(
      await runStatus({
        env: ENV,
        connect: async () => healthyDatabase(),
        files: FILES,
        client: api.client,
      }),
      logger,
    );

    // The failure is reported honestly -- and still without the secret.
    expect(output()).toContain('Remote activation check failed');
    expect(output()).not.toContain(SENTINEL_TOKEN);
  });
});

describe('the Auth configuration document is never dumped', () => {
  it('not on success', async () => {
    const api = managementApiDouble([authConfigResponse(ours(true))]);
    const { logger, output } = createRecordingLogger();

    printHookStatusReport(await runHookStatus({ env: ENV, client: api.client }), logger);

    for (const secret of [
      'UNRELATED_SMTP_PASSWORD',
      'UNRELATED_OAUTH_SECRET',
      'UNRELATED_HOOK_SECRET',
    ]) {
      expect(output()).not.toContain(secret);
    }
  });

  it('not on a schema validation failure', async () => {
    const api = managementApiDouble([
      authConfigResponse({ hook_before_user_created_enabled: 'nope' as unknown as boolean }),
    ]);

    const error = await runHookStatus({ env: ENV, client: api.client }).catch(
      (cause: unknown) => cause,
    );

    const rendered = renderError(error);
    for (const secret of [
      'UNRELATED_SMTP_PASSWORD',
      'UNRELATED_OAUTH_SECRET',
      'UNRELATED_HOOK_SECRET',
    ]) {
      expect(rendered).not.toContain(secret);
    }
  });
});
