/**
 * `hook enable` / `hook disable` / `hook status`, end to end against a fake API.
 *
 * The invariant almost every test here defends:
 *
 * > **No PATCH is sent unless the database hook layer has been proven healthy and the
 * > remote slot has been proven to be ours.**
 *
 * `api.patches()` is therefore the assertion that matters most. A test that says "this
 * fails" is only half the story; the other half is that nothing was written on the way
 * to failing.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  hookStatusExitCode,
  printHookMutationReport,
  printHookStatusReport,
  runHookDisable,
  runHookEnable,
  runHookStatus,
} from '../../src/commands/hook.js';
import { calculateChecksum } from '../../src/database/migrations.js';
import type { MigrationFile } from '../../src/database/migration-types.js';
import {
  AuthHookConflictError,
  AuthHookVerificationError,
  ConfigurationError,
  EXIT_CODES,
  GuardHealthError,
  SupabaseApiError,
} from '../../src/lib/errors.js';
import { BEFORE_USER_CREATED_HOOK_URI } from '../../src/supabase/constants.js';
import { FakeDatabase } from '../helpers/database.js';
import { rejection } from '../helpers/errors.js';
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

const DB_URL = 'postgresql://postgres:hunter2@db.example.supabase.co:5432/postgres?sslmode=require';

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
const SECOND = migration('002', 'create_domain_tables');
const FILES = [FIRST, SECOND];
const HISTORY = [
  { version: FIRST.version, name: FIRST.name, checksum: FIRST.checksum },
  { version: SECOND.version, name: SECOND.name, checksum: SECOND.checksum },
];

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

/** A Supabase-shaped database with a complete, correctly granted guard layer. */
function healthyDatabase(grants: string[] = AUTH_HOOK_GRANTS): FakeDatabase {
  return new FakeDatabase({
    presentObjects: ALL_GUARD_OBJECTS,
    rowCounts: { 'guard.blocked_domains': 3, 'guard.allowed_domains': 0 },
    roles: ['supabase_auth_admin'],
    privileges: { supabase_auth_admin: grants },
  }).seedHistory(HISTORY);
}

/** A guard layer with objects missing, as if something was dropped by hand. */
function damagedDatabase(...absent: string[]): FakeDatabase {
  return new FakeDatabase({
    presentObjects: ALL_GUARD_OBJECTS.filter((object) => !absent.includes(object)),
    rowCounts: { 'guard.blocked_domains': 3, 'guard.allowed_domains': 0 },
    roles: ['supabase_auth_admin'],
    privileges: { supabase_auth_admin: AUTH_HOOK_GRANTS },
  }).seedHistory(HISTORY);
}

// ---------------------------------------------------------------------------
// enable — happy path
// ---------------------------------------------------------------------------

describe('hook enable', () => {
  it('enables a hook that is not configured, then verifies it', async () => {
    const api = managementApiDouble([
      authConfigResponse(unconfigured()),
      authConfigResponse(ours(true)),
      authConfigResponse(ours(true)),
    ]);

    const report = await runHookEnable({
      env: ENV,
      connect: async () => healthyDatabase(),
      files: FILES,
      client: api.client,
    });

    expect(report.patched).toBe(true);
    expect(report.finalState.enabled).toBe(true);
    expect(report.finalState.isOurs).toBe(true);
    // GET, PATCH, GET. The trailing GET is the proof; without it a 200 would be taken
    // as evidence of a state nobody read back.
    expect(api.requests.map((request) => request.method)).toEqual(['GET', 'PATCH', 'GET']);
  });

  it('sends only the two fields this feature owns', async () => {
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

    // Round-tripping the GET response would rewrite SMTP, OAuth and CAPTCHA settings
    // with values that were already stale -- and the fixture deliberately contains such
    // fields, so a whole-document PATCH would show up right here.
    expect(JSON.parse(api.patches()[0]?.body ?? '{}')).toEqual({
      hook_before_user_created_enabled: true,
      hook_before_user_created_uri: BEFORE_USER_CREATED_HOOK_URI,
    });
  });

  it('is idempotent: an already-correct project is a no-op success', async () => {
    const api = managementApiDouble([authConfigResponse(ours(true))]);

    const report = await runHookEnable({
      env: ENV,
      connect: async () => healthyDatabase(),
      files: FILES,
      client: api.client,
    });

    expect(report.patched).toBe(false);
    expect(report.plan.action).toBe('no-op');
    expect(api.patches()).toHaveLength(0);
  });

  it('re-enables a hook that is configured but switched off', async () => {
    const api = managementApiDouble([
      authConfigResponse(ours(false)),
      authConfigResponse(ours(true)),
      authConfigResponse(ours(true)),
    ]);

    const report = await runHookEnable({
      env: ENV,
      connect: async () => healthyDatabase(),
      files: FILES,
      client: api.client,
    });

    expect(report.patched).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// enable — conflict
// ---------------------------------------------------------------------------

describe('hook enable — configuration conflict', () => {
  it('refuses to replace an enabled foreign hook, and sends no PATCH', async () => {
    const api = managementApiDouble([authConfigResponse(foreign(true))]);

    await expect(
      runHookEnable({
        env: ENV,
        connect: async () => healthyDatabase(),
        files: FILES,
        client: api.client,
      }),
    ).rejects.toThrow(AuthHookConflictError);

    expect(api.patches()).toHaveLength(0);
  });

  it('refuses to take a DISABLED foreign hook slot either', async () => {
    const api = managementApiDouble([authConfigResponse(foreign(false))]);

    await expect(
      runHookEnable({
        env: ENV,
        connect: async () => healthyDatabase(),
        files: FILES,
        client: api.client,
      }),
    ).rejects.toThrow(AuthHookConflictError);

    expect(api.patches()).toHaveLength(0);
  });

  it('names the existing hook and the requested one', async () => {
    const api = managementApiDouble([authConfigResponse(foreign(true))]);

    const error = await rejection<AuthHookConflictError>(
      runHookEnable({
        env: ENV,
        connect: async () => healthyDatabase(),
        files: FILES,
        client: api.client,
      }),
    );

    expect(error.message).toContain('pg-functions://postgres/custom/existing_hook');
    expect(error.hint).toContain(BEFORE_USER_CREATED_HOOK_URI);
    expect(error.exitCode).toBe(EXIT_CODES.hookConflict);
  });

  it('withholds the path and query of an HTTP hook that may carry a secret', async () => {
    const api = managementApiDouble([
      authConfigResponse(foreign(true, 'https://hooks.example.test/before?signing_token=s3cr3t')),
    ]);

    const error = await rejection<AuthHookConflictError>(
      runHookEnable({
        env: ENV,
        connect: async () => healthyDatabase(),
        files: FILES,
        client: api.client,
      }),
    );

    expect(error.message).toContain('hooks.example.test');
    expect(error.message).not.toContain('s3cr3t');
    expect(error.message).not.toContain('signing_token');
  });
});

// ---------------------------------------------------------------------------
// enable — database preflight
// ---------------------------------------------------------------------------

describe('hook enable — database preflight', () => {
  it('proceeds when the guard layer is healthy', async () => {
    const api = managementApiDouble([
      authConfigResponse(unconfigured()),
      authConfigResponse(ours(true)),
      authConfigResponse(ours(true)),
    ]);

    const report = await runHookEnable({
      env: ENV,
      connect: async () => healthyDatabase(),
      files: FILES,
      client: api.client,
    });

    expect(report.preflight?.schema.health).toBe('complete');
  });

  it('refuses when the hook function is missing, and contacts the API not at all', async () => {
    const api = managementApiDouble([authConfigResponse(unconfigured())]);

    await expect(
      runHookEnable({
        env: ENV,
        connect: async () => damagedDatabase('guard.before_user_created(jsonb)'),
        files: FILES,
        client: api.client,
      }),
    ).rejects.toThrow(GuardHealthError);

    // Not merely "no PATCH": the preflight runs first, so the token is never even sent.
    expect(api.requests).toHaveLength(0);
  });

  it('refuses when supabase_auth_admin is missing a grant', async () => {
    // The exact state that makes activation catastrophic: the function exists, so the
    // hook looks installed, but Auth cannot execute it and every signup fails closed.
    const api = managementApiDouble([authConfigResponse(unconfigured())]);
    const grants = AUTH_HOOK_GRANTS.filter((grant) => grant !== 'SELECT on guard.blocked_domains');

    const error = await rejection<GuardHealthError>(
      runHookEnable({
        env: ENV,
        connect: async () => healthyDatabase(grants),
        files: FILES,
        client: api.client,
      }),
    );

    expect(error).toBeInstanceOf(GuardHealthError);
    expect(error.message).toContain('SELECT on guard.blocked_domains');
    expect(api.requests).toHaveLength(0);
  });

  it('refuses when the guard schema is incomplete', async () => {
    const api = managementApiDouble([authConfigResponse(unconfigured())]);

    await expect(
      runHookEnable({
        env: ENV,
        connect: async () => damagedDatabase('guard.allowed_domains'),
        files: FILES,
        client: api.client,
      }),
    ).rejects.toThrow(GuardHealthError);

    expect(api.requests).toHaveLength(0);
  });

  it('refuses when the guard schema is not installed at all', async () => {
    const api = managementApiDouble([authConfigResponse(unconfigured())]);

    await expect(
      runHookEnable({
        env: ENV,
        connect: async () => new FakeDatabase(),
        files: FILES,
        client: api.client,
      }),
    ).rejects.toThrow(/not installed/i);

    expect(api.requests).toHaveLength(0);
  });

  it('refuses when migrations are pending', async () => {
    const api = managementApiDouble([authConfigResponse(unconfigured())]);
    const behind = new FakeDatabase({
      presentObjects: ALL_GUARD_OBJECTS,
      roles: ['supabase_auth_admin'],
      privileges: { supabase_auth_admin: AUTH_HOOK_GRANTS },
    }).seedHistory(HISTORY.slice(0, 1));

    await expect(
      runHookEnable({ env: ENV, connect: async () => behind, files: FILES, client: api.client }),
    ).rejects.toThrow(GuardHealthError);

    expect(api.requests).toHaveLength(0);
  });

  it('refuses when supabase_auth_admin does not exist on the target database', async () => {
    // A hosted project always has the role. Not finding it means SUPABASE_DB_URL points
    // somewhere other than the project SUPABASE_PROJECT_REF names -- so the health check
    // that just "passed" was performed against the wrong database.
    const api = managementApiDouble([authConfigResponse(unconfigured())]);
    const plainPostgres = new FakeDatabase({
      presentObjects: ALL_GUARD_OBJECTS,
      rowCounts: { 'guard.blocked_domains': 3, 'guard.allowed_domains': 0 },
    }).seedHistory(HISTORY);

    const error = await rejection<GuardHealthError>(
      runHookEnable({
        env: ENV,
        connect: async () => plainPostgres,
        files: FILES,
        client: api.client,
      }),
    );

    expect(error).toBeInstanceOf(GuardHealthError);
    expect(error.hint).toContain('same project');
    expect(api.requests).toHaveLength(0);
  });

  it('refuses by default when SUPABASE_DB_URL is absent', async () => {
    // The check is not silently skipped just because credentials are missing. Inferring
    // "activate unverified" from an unset variable would make the dangerous path the
    // default for anyone who has not configured a database.
    const api = managementApiDouble([authConfigResponse(unconfigured())]);
    const connect = vi.fn();

    const error = await rejection<ConfigurationError>(
      runHookEnable({
        env: { SUPABASE_PROJECT_REF: TEST_PROJECT_REF, SUPABASE_ACCESS_TOKEN: SENTINEL_TOKEN },
        connect,
        files: FILES,
        client: api.client,
      }),
    );

    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error.hint).toContain('--skip-db-check');
    expect(connect).not.toHaveBeenCalled();
    expect(api.requests).toHaveLength(0);
  });

  it('exits with the guard-health code, not a database or remote code', async () => {
    const api = managementApiDouble([authConfigResponse(unconfigured())]);

    const error = await rejection<GuardHealthError>(
      runHookEnable({
        env: ENV,
        connect: async () => damagedDatabase('guard.before_user_created(jsonb)'),
        files: FILES,
        client: api.client,
      }),
    );

    expect(error.exitCode).toBe(EXIT_CODES.guardHealth);
  });
});

// ---------------------------------------------------------------------------
// enable — --skip-db-check
// ---------------------------------------------------------------------------

describe('hook enable --skip-db-check', () => {
  it('proceeds without a database connection', async () => {
    const api = managementApiDouble([
      authConfigResponse(unconfigured()),
      authConfigResponse(ours(true)),
      authConfigResponse(ours(true)),
    ]);
    const connect = vi.fn();

    const report = await runHookEnable(
      {
        env: { SUPABASE_PROJECT_REF: TEST_PROJECT_REF, SUPABASE_ACCESS_TOKEN: SENTINEL_TOKEN },
        connect,
        client: api.client,
      },
      { skipDbCheck: true },
    );

    expect(report.patched).toBe(true);
    expect(report.preflight).toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
  });

  it('proceeds even against a database that is known to be broken', async () => {
    // This is what makes the flag dangerous, stated as a test rather than only in a
    // doc comment: the operator is explicitly buying the right to break their signups.
    const api = managementApiDouble([
      authConfigResponse(unconfigured()),
      authConfigResponse(ours(true)),
      authConfigResponse(ours(true)),
    ]);

    const report = await runHookEnable(
      {
        env: ENV,
        connect: async () => damagedDatabase('guard.before_user_created(jsonb)'),
        files: FILES,
        client: api.client,
      },
      { skipDbCheck: true },
    );

    expect(report.patched).toBe(true);
  });

  it('emits the danger warning before anything is mutated', async () => {
    const api = managementApiDouble([
      authConfigResponse(unconfigured()),
      authConfigResponse(ours(true)),
      authConfigResponse(ours(true)),
    ]);
    const warned: string[] = [];

    await runHookEnable(
      { env: ENV, client: api.client },
      { skipDbCheck: true },
      {
        onPreflightSkipped: () => warned.push('skipped'),
        onPatchSent: () => warned.push('patched'),
      },
    );

    expect(warned).toEqual(['skipped', 'patched']);
  });

  it('emits the same warning during a dry run', async () => {
    // A preview whose warnings differ from the real run teaches an operator that the
    // dangerous flag is quiet.
    const api = managementApiDouble([authConfigResponse(unconfigured())]);
    let warned = false;

    await runHookEnable(
      { env: ENV, client: api.client },
      { skipDbCheck: true, dryRun: true },
      { onPreflightSkipped: () => (warned = true) },
    );

    expect(warned).toBe(true);
    expect(api.patches()).toHaveLength(0);
  });

  it('does not bypass the conflict check', async () => {
    // The flag buys out of the DATABASE check only. It is not a --force, and it does not
    // license overwriting somebody else's hook.
    const api = managementApiDouble([authConfigResponse(foreign(true))]);

    await expect(
      runHookEnable({ env: ENV, client: api.client }, { skipDbCheck: true }),
    ).rejects.toThrow(AuthHookConflictError);

    expect(api.patches()).toHaveLength(0);
  });

  it('does not bypass post-write verification', async () => {
    const api = managementApiDouble([
      authConfigResponse(unconfigured()),
      authConfigResponse(ours(true)),
      authConfigResponse(unconfigured()),
    ]);

    await expect(
      runHookEnable({ env: ENV, client: api.client }, { skipDbCheck: true }),
    ).rejects.toThrow(AuthHookVerificationError);
  });
});

// ---------------------------------------------------------------------------
// enable — post-write verification
// ---------------------------------------------------------------------------

describe('hook enable — post-write verification', () => {
  it('fails when the read-back state does not show the change', async () => {
    // HTTP 200 is not proof. A partially applied update, a server-side normalisation or
    // a competing dashboard change all look like success until the state is re-read.
    const api = managementApiDouble([
      authConfigResponse(unconfigured()),
      authConfigResponse(ours(true)),
      authConfigResponse(ours(false)),
    ]);

    const error = await rejection<AuthHookVerificationError>(
      runHookEnable({
        env: ENV,
        connect: async () => healthyDatabase(),
        files: FILES,
        client: api.client,
      }),
    );

    expect(error).toBeInstanceOf(AuthHookVerificationError);
    expect(error.exitCode).toBe(EXIT_CODES.hookVerification);
    expect(error.exitCode).not.toBe(EXIT_CODES.remote);
  });

  it("fails when the URI came back as somebody else's", async () => {
    const api = managementApiDouble([
      authConfigResponse(unconfigured()),
      authConfigResponse(ours(true)),
      authConfigResponse(foreign(true)),
    ]);

    await expect(
      runHookEnable({
        env: ENV,
        connect: async () => healthyDatabase(),
        files: FILES,
        client: api.client,
      }),
    ).rejects.toThrow(AuthHookVerificationError);
  });

  it('surfaces a failure of the verification GET itself', async () => {
    const api = managementApiDouble([
      authConfigResponse(unconfigured()),
      authConfigResponse(ours(true)),
      errorResponse(500),
    ]);

    await expect(
      runHookEnable({
        env: ENV,
        connect: async () => healthyDatabase(),
        files: FILES,
        client: api.client,
      }),
    ).rejects.toThrow(SupabaseApiError);
  });

  it('warns rather than claims success, in the message', async () => {
    const api = managementApiDouble([
      authConfigResponse(unconfigured()),
      authConfigResponse(ours(true)),
      authConfigResponse(ours(false)),
    ]);

    const error = await rejection<AuthHookVerificationError>(
      runHookEnable({
        env: ENV,
        connect: async () => healthyDatabase(),
        files: FILES,
        client: api.client,
      }),
    );

    expect(error.hint).toMatch(/do not assume/i);
  });
});

// ---------------------------------------------------------------------------
// enable — dry run
// ---------------------------------------------------------------------------

describe('hook enable --dry-run', () => {
  it('reads remote state and sends no PATCH', async () => {
    const api = managementApiDouble([authConfigResponse(unconfigured())]);

    const report = await runHookEnable(
      { env: ENV, connect: async () => healthyDatabase(), files: FILES, client: api.client },
      { dryRun: true },
    );

    expect(report.dryRun).toBe(true);
    expect(report.patched).toBe(false);
    expect(report.plan.action).toBe('change');
    expect(api.requests.map((request) => request.method)).toEqual(['GET']);
  });

  it('still performs the database preflight', async () => {
    const api = managementApiDouble([authConfigResponse(unconfigured())]);

    const report = await runHookEnable(
      { env: ENV, connect: async () => healthyDatabase(), files: FILES, client: api.client },
      { dryRun: true },
    );

    expect(report.preflight?.schema.health).toBe('complete');
  });

  it('fails the preflight the same way a real run would', async () => {
    const api = managementApiDouble([authConfigResponse(unconfigured())]);

    await expect(
      runHookEnable(
        {
          env: ENV,
          connect: async () => damagedDatabase('guard.before_user_created(jsonb)'),
          files: FILES,
          client: api.client,
        },
        { dryRun: true },
      ),
    ).rejects.toThrow(GuardHealthError);
  });

  it('surfaces a conflict rather than previewing a change it could not make', async () => {
    const api = managementApiDouble([authConfigResponse(foreign(true))]);

    await expect(
      runHookEnable(
        { env: ENV, connect: async () => healthyDatabase(), files: FILES, client: api.client },
        { dryRun: true },
      ),
    ).rejects.toThrow(AuthHookConflictError);
  });

  it('reports "nothing to do" when the project is already correct', async () => {
    const api = managementApiDouble([authConfigResponse(ours(true))]);

    const report = await runHookEnable(
      { env: ENV, connect: async () => healthyDatabase(), files: FILES, client: api.client },
      { dryRun: true },
    );

    expect(report.plan.action).toBe('no-op');
    expect(api.patches()).toHaveLength(0);
  });

  it('prints the exact fields it would set', async () => {
    const api = managementApiDouble([authConfigResponse(unconfigured())]);
    const { logger, output } = createRecordingLogger();

    const report = await runHookEnable(
      { env: ENV, connect: async () => healthyDatabase(), files: FILES, client: api.client },
      { dryRun: true },
    );
    printHookMutationReport(report, logger);

    expect(output()).toContain('hook_before_user_created_enabled: true');
    expect(output()).toContain(`hook_before_user_created_uri: ${BEFORE_USER_CREATED_HOOK_URI}`);
    expect(output()).toContain('No remote changes made.');
  });
});

// ---------------------------------------------------------------------------
// disable
// ---------------------------------------------------------------------------

describe('hook disable', () => {
  it('disables our own enabled hook and verifies it', async () => {
    const api = managementApiDouble([
      authConfigResponse(ours(true)),
      authConfigResponse(ours(false)),
      authConfigResponse(ours(false)),
    ]);

    const report = await runHookDisable({ env: ENV, client: api.client });

    expect(report.patched).toBe(true);
    expect(report.finalState.enabled).toBe(false);
  });

  it('sends only the enabled flag, leaving the URI in place', async () => {
    const api = managementApiDouble([
      authConfigResponse(ours(true)),
      authConfigResponse(ours(false)),
      authConfigResponse(ours(false)),
    ]);

    await runHookDisable({ env: ENV, client: api.client });

    expect(JSON.parse(api.patches()[0]?.body ?? '{}')).toEqual({
      hook_before_user_created_enabled: false,
    });
  });

  it('is idempotent: an already-disabled hook is a no-op', async () => {
    const api = managementApiDouble([authConfigResponse(ours(false))]);

    const report = await runHookDisable({ env: ENV, client: api.client });

    expect(report.patched).toBe(false);
    expect(api.patches()).toHaveLength(0);
  });

  it('is a no-op when nothing is configured at all', async () => {
    const api = managementApiDouble([authConfigResponse(unconfigured())]);

    const report = await runHookDisable({ env: ENV, client: api.client });

    expect(report.patched).toBe(false);
    expect(api.patches()).toHaveLength(0);
  });

  it("refuses to disable somebody else's hook", async () => {
    const api = managementApiDouble([authConfigResponse(foreign(true))]);

    await expect(runHookDisable({ env: ENV, client: api.client })).rejects.toThrow(
      AuthHookConflictError,
    );

    expect(api.patches()).toHaveLength(0);
  });

  it("refuses even when somebody else's hook is already disabled", async () => {
    const api = managementApiDouble([authConfigResponse(foreign(false))]);

    await expect(runHookDisable({ env: ENV, client: api.client })).rejects.toThrow(
      AuthHookConflictError,
    );
  });

  it('needs no database at all', async () => {
    // Deliberate. Requiring database credentials to turn a hook OFF would strand an
    // operator whose database is unreachable -- exactly when the fail-closed hook is
    // rejecting every signup and `hook disable` is the one command that helps.
    const api = managementApiDouble([
      authConfigResponse(ours(true)),
      authConfigResponse(ours(false)),
      authConfigResponse(ours(false)),
    ]);
    const connect = vi.fn();

    const report = await runHookDisable({
      env: { SUPABASE_PROJECT_REF: TEST_PROJECT_REF, SUPABASE_ACCESS_TOKEN: SENTINEL_TOKEN },
      connect,
      client: api.client,
    });

    expect(report.patched).toBe(true);
    expect(connect).not.toHaveBeenCalled();
  });

  it('fails verification when the hook is still enabled afterwards', async () => {
    const api = managementApiDouble([
      authConfigResponse(ours(true)),
      authConfigResponse(ours(false)),
      authConfigResponse(ours(true)),
    ]);

    await expect(runHookDisable({ env: ENV, client: api.client })).rejects.toThrow(
      AuthHookVerificationError,
    );
  });

  it('accepts a server that clears the URI as well', async () => {
    const api = managementApiDouble([
      authConfigResponse(ours(true)),
      authConfigResponse(unconfigured()),
      authConfigResponse(unconfigured()),
    ]);

    await expect(runHookDisable({ env: ENV, client: api.client })).resolves.toMatchObject({
      patched: true,
    });
  });

  it('sends no PATCH in a dry run', async () => {
    const api = managementApiDouble([authConfigResponse(ours(true))]);

    const report = await runHookDisable({ env: ENV, client: api.client }, { dryRun: true });

    expect(report.plan.action).toBe('change');
    expect(report.patched).toBe(false);
    expect(api.patches()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

describe('hook commands — configuration', () => {
  it.each(['enable', 'disable', 'status'] as const)(
    'refuses %s without Management API credentials',
    async (command) => {
      const run = { enable: runHookEnable, disable: runHookDisable, status: runHookStatus }[
        command
      ];

      await expect(run({ env: { SUPABASE_DB_URL: DB_URL } })).rejects.toThrow(ConfigurationError);
    },
  );

  it('names both missing variables in one error', async () => {
    const error = await rejection<ConfigurationError>(runHookStatus({ env: {} }));

    expect(error.message).toContain('SUPABASE_PROJECT_REF');
    expect(error.message).toContain('SUPABASE_ACCESS_TOKEN');
  });

  it('refuses a malformed project ref before any request', async () => {
    const api = managementApiDouble([authConfigResponse(unconfigured())]);

    await expect(
      runHookStatus({
        env: { SUPABASE_PROJECT_REF: 'not-a-ref', SUPABASE_ACCESS_TOKEN: SENTINEL_TOKEN },
        client: api.client,
      }),
    ).rejects.toThrow(ConfigurationError);

    expect(api.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// hook status
// ---------------------------------------------------------------------------

describe('hook status', () => {
  it('reports an enabled guard hook', async () => {
    const api = managementApiDouble([authConfigResponse(ours(true))]);
    const { logger, output } = createRecordingLogger();

    const report = await runHookStatus({ env: ENV, client: api.client });
    printHookStatusReport(report, logger);

    expect(output()).toContain('Enabled');
    expect(output()).toContain(BEFORE_USER_CREATED_HOOK_URI);
    expect(hookStatusExitCode(report)).toBe(EXIT_CODES.success);
  });

  it('reports a disabled guard hook without calling it a failure', async () => {
    const api = managementApiDouble([authConfigResponse(ours(false))]);
    const { logger, output } = createRecordingLogger();

    const report = await runHookStatus({ env: ENV, client: api.client });
    printHookStatusReport(report, logger);

    expect(output()).toContain('Disabled');
    expect(hookStatusExitCode(report)).toBe(EXIT_CODES.success);
  });

  it('reports an unconfigured slot', async () => {
    const api = managementApiDouble([authConfigResponse(unconfigured())]);
    const { logger, output } = createRecordingLogger();

    const report = await runHookStatus({ env: ENV, client: api.client });
    printHookStatusReport(report, logger);

    expect(output()).toContain('Not configured');
    expect(hookStatusExitCode(report)).toBe(EXIT_CODES.success);
  });

  it('reports a conflict, and exits non-zero for it', async () => {
    const api = managementApiDouble([authConfigResponse(foreign(true))]);
    const { logger, output } = createRecordingLogger();

    const report = await runHookStatus({ env: ENV, client: api.client });
    printHookStatusReport(report, logger);

    expect(output()).toContain('Conflict');
    expect(hookStatusExitCode(report)).toBe(EXIT_CODES.hookConflict);
  });

  it('never dumps the whole Auth configuration', async () => {
    const api = managementApiDouble([authConfigResponse(ours(true))]);
    const { logger, output } = createRecordingLogger();

    printHookStatusReport(await runHookStatus({ env: ENV, client: api.client }), logger);

    // The fixture carries SMTP and OAuth secrets. One flag and one URI is the whole
    // remit of this report.
    expect(output()).not.toContain('UNRELATED_SMTP_PASSWORD');
    expect(output()).not.toContain('UNRELATED_OAUTH_SECRET');
    expect(output()).not.toContain('UNRELATED_HOOK_SECRET');
  });

  it('is read-only', async () => {
    const api = managementApiDouble([authConfigResponse(ours(false))]);

    await runHookStatus({ env: ENV, client: api.client });

    expect(api.patches()).toHaveLength(0);
  });
});
