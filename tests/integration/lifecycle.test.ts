/**
 * Live PostgreSQL lifecycle tests.
 *
 * ⚠️ DESTRUCTIVE WITHIN `guard` ONLY. SADA_TEST_DB_URL must name a dedicated scratch
 * database. Hosted Auth is always represented by the in-memory Management API double;
 * this suite never sends a live Management API request.
 *
 * The fixture is synthetic: it validates PostgreSQL catalogs, grants, dependencies,
 * transactions, and explicit removal ordering. It does not claim to reproduce a hosted
 * Supabase control plane.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runRepair } from '../../src/commands/repair.js';
import { runUninstall } from '../../src/commands/uninstall.js';
import { createPostgresConnection } from '../../src/database/client.js';
import { inspectGuardLifecycle } from '../../src/database/lifecycle.js';
import { readAppliedMigrations, runMigrations } from '../../src/database/migrations.js';
import { inspectAuthHookGrants } from '../../src/database/schema-status.js';
import type { DatabaseConnection, SqlParameter } from '../../src/database/types.js';
import {
  authConfigResponse,
  foreign,
  managementApiDouble,
  ours,
  SENTINEL_TOKEN,
  TEST_PROJECT_REF,
} from '../helpers/management-api.js';

const testDatabaseUrl = process.env['SADA_TEST_DB_URL'];
const describeIfConfigured = testDatabaseUrl === undefined ? describe.skip : describe;
const AUTH_ROLE = 'supabase_auth_admin';

let connection: DatabaseConnection;
let authRolePresent = false;
let failCleanup = false;

/** Shared connection whose close is intentionally inert for command lifecycle tests. */
const shared: DatabaseConnection = {
  get target() {
    return connection.target;
  },
  query<Row extends Record<string, unknown>>(sql: string, parameters?: SqlParameter[]) {
    return connection.query<Row>(sql, parameters);
  },
  async execute(sql: string) {
    if (failCleanup && sql.includes('drop function if exists guard.before_user_created')) {
      throw new Error('simulated database cleanup failure');
    }
    return connection.execute(sql);
  },
  async close() {
    return undefined;
  },
};

function databaseDependencies() {
  return {
    env: { SUPABASE_DB_URL: testDatabaseUrl as string },
    connect: async () => shared,
  };
}

function fullDependencies(client: ReturnType<typeof managementApiDouble>['client']) {
  return {
    env: {
      SUPABASE_DB_URL: testDatabaseUrl as string,
      SUPABASE_PROJECT_REF: TEST_PROJECT_REF,
      SUPABASE_ACCESS_TOKEN: SENTINEL_TOKEN,
    },
    connect: async () => shared,
    client,
  };
}

async function dropGuard(): Promise<void> {
  await connection.execute('drop schema if exists guard cascade');
}

async function scalar<T>(sql: string, parameters: SqlParameter[] = []): Promise<T | undefined> {
  const result = await connection.query<{ value: T }>(sql, parameters);
  return result.rows[0]?.value;
}

describeIfConfigured('repair and uninstall against a scratch PostgreSQL database', () => {
  beforeAll(async () => {
    connection = await createPostgresConnection({ connectionString: testDatabaseUrl as string });
    authRolePresent =
      (await scalar<boolean>(
        'select exists (select 1 from pg_catalog.pg_roles where rolname = $1) as value',
        [AUTH_ROLE],
      )) === true;
  }, 30_000);

  beforeEach(async () => {
    failCleanup = false;
    await dropGuard();
    await runMigrations(connection);
  }, 30_000);

  afterEach(async () => {
    failCleanup = false;
    await dropGuard();
  });

  afterAll(async () => {
    await connection?.close();
  });

  it('verifies a healthy installation by migration, catalog identity, owner, and definition', async () => {
    const inspection = await inspectGuardLifecycle(connection);

    expect(inspection.historyVerified).toBe(true);
    expect(inspection.appliedVersions).toEqual([
      '001',
      '002',
      '003',
      '004',
      '005',
      '006',
      '007',
      '008',
    ]);
    expect(inspection.missingTables).toEqual([]);
    expect(inspection.missingFunctions).toEqual([]);
    expect(inspection.modifiedObjects).toEqual([]);
    expect(inspection.unexpectedObjects).toEqual([]);
    expect(inspection.ownerMismatches).toEqual([]);
    expect(inspection.externalDependencies).toEqual([]);
  });

  it('is a no-op repair on a healthy Supabase-role fixture', async (ctx) => {
    if (!authRolePresent) {
      ctx.skip();
      return;
    }

    const report = await runRepair(databaseDependencies());
    expect(report.assessment.state).toBe('healthy');
    expect(report.changed).toBe(false);
  });

  it('dry-runs and restores missing Auth Hook grants without editing history', async (ctx) => {
    if (!authRolePresent) {
      ctx.skip();
      return;
    }
    const historyBefore = await readAppliedMigrations(connection);
    await connection.execute(`revoke usage on schema guard from ${AUTH_ROLE}`);
    await connection.execute(`revoke select on table guard.blocked_domains from ${AUTH_ROLE}`);

    const preview = await runRepair(databaseDependencies(), { dryRun: true });
    expect(preview.assessment.state).toBe('repairable');
    expect((await inspectAuthHookGrants(connection)).missing).toEqual([
      'USAGE on guard',
      'SELECT on guard.blocked_domains',
    ]);

    const repaired = await runRepair(databaseDependencies());
    expect(repaired.finalState).toBe('healthy');
    expect((await inspectAuthHookGrants(connection)).missing).toEqual([]);
    expect(await readAppliedMigrations(connection)).toEqual(historyBefore);
  });

  it('recreates a missing hook function without replaying migration 006', async (ctx) => {
    if (!authRolePresent) {
      ctx.skip();
      return;
    }
    const historyBefore = await readAppliedMigrations(connection);
    await connection.execute('drop function guard.before_user_created(jsonb)');

    const repaired = await runRepair(databaseDependencies());

    expect(repaired.finalState).toBe('healthy');
    expect(
      await scalar<boolean>(
        "select to_regprocedure('guard.before_user_created(jsonb)') is not null as value",
      ),
    ).toBe(true);
    expect(await readAppliedMigrations(connection)).toEqual(historyBefore);
  });

  it('refuses core table loss and leaves the remaining schema untouched', async () => {
    await connection.execute('drop table guard.blocked_domains cascade');
    const historyBefore = await readAppliedMigrations(connection);

    const report = await runRepair(databaseDependencies());

    expect(report.assessment.state).toBe('manual-action-required');
    expect(report.assessment.reasons.join('\n')).toContain('Data loss may have occurred');
    expect(await readAppliedMigrations(connection)).toEqual(historyBefore);
  });

  it('dry-runs full uninstall with one remote GET, zero PATCH, and zero DDL', async () => {
    const api = managementApiDouble([authConfigResponse(ours(true))]);
    const report = await runUninstall(fullDependencies(api.client), { dryRun: true });

    expect(report.state).toBe('dry-run');
    expect(api.patches()).toHaveLength(0);
    expect(await scalar<boolean>("select to_regnamespace('guard') is not null as value")).toBe(
      true,
    );
  });

  it('performs full remote-first cleanup and leaves guard absent', async () => {
    const api = managementApiDouble([
      authConfigResponse(ours(true)),
      authConfigResponse(ours(true)),
      authConfigResponse(ours(false)),
      authConfigResponse(ours(false)),
    ]);
    const report = await runUninstall(fullDependencies(api.client), { yes: true });

    expect(report.state).toBe('complete');
    expect(report.remotePatched).toBe(true);
    expect(report.databaseRemoved).toBe(true);
    expect(api.patches()).toHaveLength(1);
    expect(await scalar<boolean>("select to_regnamespace('guard') is not null as value")).toBe(
      false,
    );
  });

  it('refuses a foreign object inside guard before remote or DDL mutation', async () => {
    await connection.execute('create view guard.operator_view as select 1 as value');
    await connection.execute(
      "create procedure guard.operator_procedure() language sql as 'select 1'",
    );
    const api = managementApiDouble([authConfigResponse(ours(false))]);

    const report = await runUninstall(fullDependencies(api.client), { yes: true });

    expect(report.state).toBe('conflict');
    expect(report.assessment.conflicts.join('\n')).toContain('operator_view');
    expect(report.assessment.conflicts.join('\n')).toContain('operator_procedure');
    expect(api.patches()).toHaveLength(0);
    expect(
      await scalar<boolean>("select to_regclass('guard.operator_view') is not null as value"),
    ).toBe(true);
  });

  it('refuses a guard schema owned by another role', async (ctx) => {
    if (!authRolePresent) {
      ctx.skip();
      return;
    }
    await connection.execute(`alter schema guard owner to ${AUTH_ROLE}`);

    const report = await runUninstall(databaseDependencies(), {
      databaseOnly: true,
      yes: true,
    });

    expect(report.state).toBe('conflict');
    expect(report.assessment.conflicts.join('\n')).toContain(
      `schema guard is owned by ${AUTH_ROLE}, not current role`,
    );
    expect(await scalar<boolean>("select to_regnamespace('guard') is not null as value")).toBe(
      true,
    );
  });

  it('refuses an external dependency rather than cascading through it', async () => {
    await connection.execute('create schema sada_lifecycle_external_fixture');
    try {
      await connection.execute(
        'create view sada_lifecycle_external_fixture.operator_view as select * from guard.allowed_domains',
      );
      const report = await runUninstall(databaseDependencies(), {
        databaseOnly: true,
        yes: true,
      });

      expect(report.state).toBe('conflict');
      expect(report.assessment.conflicts.join('\n')).toContain('operator_view');
      expect(
        await scalar<boolean>("select to_regclass('guard.allowed_domains') is not null as value"),
      ).toBe(true);
    } finally {
      await connection.execute('drop schema sada_lifecycle_external_fixture cascade');
    }
  });

  it('resumes a verified partial database-only uninstall safely', async () => {
    await connection.execute('drop function guard.before_user_created(jsonb)');

    const first = await runUninstall(databaseDependencies(), { databaseOnly: true, yes: true });
    const second = await runUninstall(databaseDependencies(), { databaseOnly: true, yes: true });

    expect(first.state).toBe('complete');
    expect(second.state).toBe('already-uninstalled');
  });

  it('resumes after remote disable committed and database cleanup rolled back', async () => {
    const firstApi = managementApiDouble([
      authConfigResponse(ours(true)),
      authConfigResponse(ours(true)),
      authConfigResponse(ours(false)),
      authConfigResponse(ours(false)),
    ]);
    failCleanup = true;

    await expect(runUninstall(fullDependencies(firstApi.client), { yes: true })).rejects.toThrow(
      'simulated database cleanup failure',
    );
    expect(await scalar<boolean>("select to_regnamespace('guard') is not null as value")).toBe(
      true,
    );

    failCleanup = false;
    const secondApi = managementApiDouble([
      authConfigResponse(ours(false)),
      authConfigResponse(ours(false)),
    ]);
    const resumed = await runUninstall(fullDependencies(secondApi.client), { yes: true });

    expect(resumed.state).toBe('complete');
    expect(resumed.remotePatched).toBe(false);
    expect(resumed.databaseRemoved).toBe(true);
  });

  it('never exposes a foreign remote hook URI path during a conflict', async () => {
    const api = managementApiDouble([
      authConfigResponse(
        foreign(true, 'https://hooks.example.test/private?signing_secret=sentinel'),
      ),
    ]);
    const report = await runUninstall(fullDependencies(api.client), { yes: true });
    const conflicts = report.assessment.conflicts.join('\n');

    expect(conflicts).toContain('hooks.example.test');
    expect(conflicts).not.toContain('private');
    expect(conflicts).not.toContain('sentinel');
  });
});
