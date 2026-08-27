import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as LifecycleModule from '../../src/database/lifecycle.js';
import type * as SchemaStatusModule from '../../src/database/schema-status.js';
import type * as StrictTriggerModule from '../../src/database/strict-trigger.js';
import type * as UninstallModule from '../../src/database/uninstall.js';

const mocks = vi.hoisted(() => ({
  inspectLifecycle: vi.fn(),
  readSchema: vi.fn(),
  readStrict: vi.fn(),
  readTrigger: vi.fn(),
  dropTrigger: vi.fn(),
  dropGuard: vi.fn(),
}));

vi.mock('../../src/database/lifecycle.js', async (importOriginal) => ({
  ...(await importOriginal<typeof LifecycleModule>()),
  inspectGuardLifecycle: mocks.inspectLifecycle,
}));
vi.mock('../../src/database/schema-status.js', async (importOriginal) => ({
  ...(await importOriginal<typeof SchemaStatusModule>()),
  readGuardSchemaStatus: mocks.readSchema,
}));
vi.mock('../../src/database/strict-trigger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof StrictTriggerModule>()),
  readStrictModeStatus: mocks.readStrict,
  readStrictTriggerState: mocks.readTrigger,
  dropStrictTrigger: mocks.dropTrigger,
}));
vi.mock('../../src/database/uninstall.js', async (importOriginal) => ({
  ...(await importOriginal<typeof UninstallModule>()),
  dropGuardObjects: mocks.dropGuard,
}));

import { runUninstall, uninstallExitCode } from '../../src/commands/uninstall.js';
import type { MigrationFile } from '../../src/database/migration-types.js';
import type { DatabaseConnection } from '../../src/database/types.js';
import {
  AuthHookVerificationError,
  ConfigurationError,
  EXIT_CODES,
  SupabaseApiError,
} from '../../src/lib/errors.js';
import {
  authConfigResponse,
  errorResponse,
  foreign,
  managementApiDouble,
  ours,
  SENTINEL_TOKEN,
  TEST_PROJECT_REF,
} from '../helpers/management-api.js';
import {
  absentLifecycle,
  healthyLifecycle,
  healthySchema,
  strictDisabled,
  strictEnabled,
} from '../helpers/lifecycle.js';

const DB_URL = 'postgresql://postgres:password@db.example.test:5432/postgres';
const ENV = {
  SUPABASE_DB_URL: DB_URL,
  SUPABASE_PROJECT_REF: TEST_PROJECT_REF,
  SUPABASE_ACCESS_TOKEN: SENTINEL_TOKEN,
};
const FILES: MigrationFile[] = [];

function connection(): DatabaseConnection & { closed: boolean } {
  let closed = false;
  return {
    target: 'db.example.test:5432/postgres',
    get closed() {
      return closed;
    },
    execute: async () => undefined,
    query: async () => ({ rows: [], rowCount: 0 }),
    close: async () => {
      closed = true;
    },
  };
}

function queueHealthyCleanup(): void {
  mocks.inspectLifecycle
    .mockResolvedValueOnce(healthyLifecycle())
    .mockResolvedValueOnce(healthyLifecycle())
    .mockResolvedValueOnce(absentLifecycle());
}

function activeDisableApi() {
  return managementApiDouble([
    // Assessment GET.
    authConfigResponse(ours(true)),
    // Fresh execution GET, PATCH response, verification GET.
    authConfigResponse(ours(true)),
    authConfigResponse(ours(false)),
    authConfigResponse(ours(false)),
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inspectLifecycle.mockResolvedValue(healthyLifecycle());
  mocks.readSchema.mockResolvedValue(healthySchema());
  mocks.readStrict.mockResolvedValue(strictDisabled());
  mocks.readTrigger.mockResolvedValue({ kind: 'absent' });
  mocks.dropTrigger.mockResolvedValue(undefined);
  mocks.dropGuard.mockResolvedValue(undefined);
});

describe('runUninstall orchestration', () => {
  it('removes strict, disables and verifies remote, then removes database objects', async () => {
    queueHealthyCleanup();
    mocks.readStrict.mockResolvedValue(strictEnabled());
    mocks.readTrigger
      .mockResolvedValueOnce({ kind: 'ours', definition: 'CREATE TRIGGER expected' })
      .mockResolvedValueOnce({ kind: 'absent' });
    const api = activeDisableApi();
    const order: string[] = [];

    const report = await runUninstall(
      {
        env: ENV,
        connect: async () => connection(),
        files: FILES,
        client: api.client,
      },
      { yes: true },
      {
        onStrictRemoved: () => order.push('strict'),
        onRemoteDisabled: () => order.push('remote-disable'),
        onRemoteVerified: () => order.push('remote-verify'),
        onDatabaseRemoved: () => order.push('database'),
      },
    );

    expect(order).toEqual(['strict', 'remote-disable', 'remote-verify', 'database']);
    expect(report.state).toBe('complete');
    expect(report.strictRemoved).toBe(true);
    expect(report.remotePatched).toBe(true);
    expect(report.databaseRemoved).toBe(true);
    expect(api.patches()).toHaveLength(1);
  });

  it('requires confirmation after assessment and performs zero mutation without --yes', async () => {
    const api = managementApiDouble([authConfigResponse(ours(true))]);
    const report = await runUninstall({
      env: ENV,
      connect: async () => connection(),
      files: FILES,
      client: api.client,
    });

    expect(report.state).toBe('confirmation-required');
    expect(uninstallExitCode(report)).toBe(EXIT_CODES.confirmationRequired);
    expect(mocks.dropTrigger).not.toHaveBeenCalled();
    expect(mocks.dropGuard).not.toHaveBeenCalled();
    expect(api.patches()).toHaveLength(0);
  });

  it('dry-run performs zero PATCH and zero DDL', async () => {
    mocks.readStrict.mockResolvedValue(strictEnabled());
    const api = managementApiDouble([authConfigResponse(ours(true))]);
    const report = await runUninstall(
      {
        env: ENV,
        connect: async () => connection(),
        files: FILES,
        client: api.client,
      },
      { dryRun: true },
    );

    expect(report.state).toBe('dry-run');
    expect(api.patches()).toHaveLength(0);
    expect(mocks.dropTrigger).not.toHaveBeenCalled();
    expect(mocks.dropGuard).not.toHaveBeenCalled();
  });

  it('refuses full uninstall without Management API credentials before connecting', async () => {
    const connect = vi.fn();

    await expect(
      runUninstall({
        env: { SUPABASE_DB_URL: DB_URL },
        connect,
        files: FILES,
      }),
    ).rejects.toThrow(ConfigurationError);
    expect(connect).not.toHaveBeenCalled();
  });

  it('allows explicit database-only uninstall with unknown remote state and confirmation', async () => {
    queueHealthyCleanup();
    const report = await runUninstall(
      {
        env: { SUPABASE_DB_URL: DB_URL },
        connect: async () => connection(),
        files: FILES,
      },
      { databaseOnly: true, yes: true },
    );

    expect(report.state).toBe('complete');
    expect(report.assessment.remote.kind).toBe('not-checked');
    expect(mocks.dropGuard).toHaveBeenCalledOnce();
  });

  it('refuses a foreign remote hook before strict or database mutation', async () => {
    mocks.readStrict.mockResolvedValue(strictEnabled());
    const api = managementApiDouble([authConfigResponse(foreign(true))]);
    const report = await runUninstall(
      { env: ENV, connect: async () => connection(), files: FILES, client: api.client },
      { yes: true },
    );

    expect(report.state).toBe('conflict');
    expect(uninstallExitCode(report)).toBe(EXIT_CODES.uninstallConflict);
    expect(mocks.dropTrigger).not.toHaveBeenCalled();
    expect(mocks.dropGuard).not.toHaveBeenCalled();
    expect(api.patches()).toHaveLength(0);
  });

  it.each([
    ['foreign object', healthyLifecycle({ unexpectedObjects: ['view guard.foreign'] })],
    [
      'external dependency',
      healthyLifecycle({ externalDependencies: ['view public.depends_on_guard'] }),
    ],
  ])('refuses a %s before remote or database mutation', async (_label, lifecycle) => {
    mocks.inspectLifecycle.mockResolvedValue(lifecycle);
    const api = managementApiDouble([authConfigResponse(ours(false))]);
    const report = await runUninstall(
      { env: ENV, connect: async () => connection(), files: FILES, client: api.client },
      { yes: true },
    );

    expect(report.state).toBe('conflict');
    expect(api.patches()).toHaveLength(0);
    expect(mocks.dropGuard).not.toHaveBeenCalled();
  });

  it('refuses a foreign strict trigger before any mutation', async () => {
    mocks.readStrict.mockResolvedValue(
      strictDisabled({
        mode: 'conflict',
        trigger: {
          kind: 'conflict',
          reasons: ['it runs public.foreign()'],
          definition: 'CREATE TRIGGER foreign',
        },
      }),
    );
    const api = managementApiDouble([authConfigResponse(ours(false))]);
    const report = await runUninstall(
      { env: ENV, connect: async () => connection(), files: FILES, client: api.client },
      { yes: true },
    );

    expect(report.state).toBe('conflict');
    expect(mocks.dropTrigger).not.toHaveBeenCalled();
    expect(mocks.dropGuard).not.toHaveBeenCalled();
  });
});

describe('uninstall remote failures and resumability', () => {
  it.each([401, 403, 404, 429, 500])(
    'stops before every mutation when the initial remote check returns %i',
    async (status) => {
      mocks.readStrict.mockResolvedValue(strictEnabled());
      const api = managementApiDouble([errorResponse(status)]);

      await expect(
        runUninstall(
          { env: ENV, connect: async () => connection(), files: FILES, client: api.client },
          { yes: true },
        ),
      ).rejects.toThrow(SupabaseApiError);
      expect(mocks.dropTrigger).not.toHaveBeenCalled();
      expect(mocks.dropGuard).not.toHaveBeenCalled();
    },
  );

  it('leaves the guard schema intact when strict removal succeeds and remote PATCH fails', async () => {
    mocks.readStrict.mockResolvedValue(strictEnabled());
    mocks.readTrigger
      .mockResolvedValueOnce({ kind: 'ours', definition: 'CREATE TRIGGER expected' })
      .mockResolvedValueOnce({ kind: 'absent' });
    const api = managementApiDouble([
      authConfigResponse(ours(true)),
      authConfigResponse(ours(true)),
      errorResponse(500),
    ]);

    await expect(
      runUninstall(
        { env: ENV, connect: async () => connection(), files: FILES, client: api.client },
        { yes: true },
      ),
    ).rejects.toThrow(SupabaseApiError);

    expect(mocks.dropTrigger).toHaveBeenCalledOnce();
    expect(mocks.dropGuard).not.toHaveBeenCalled();
  });

  it('does not clean the database after a post-PATCH verification mismatch', async () => {
    const api = managementApiDouble([
      authConfigResponse(ours(true)),
      authConfigResponse(ours(true)),
      authConfigResponse(ours(false)),
      authConfigResponse(ours(true)),
    ]);

    await expect(
      runUninstall(
        { env: ENV, connect: async () => connection(), files: FILES, client: api.client },
        { yes: true },
      ),
    ).rejects.toThrow(AuthHookVerificationError);
    expect(mocks.dropGuard).not.toHaveBeenCalled();
  });

  it('resumes after remote disable succeeded but database cleanup failed', async () => {
    mocks.inspectLifecycle
      .mockResolvedValueOnce(healthyLifecycle())
      .mockResolvedValueOnce(healthyLifecycle());
    mocks.dropGuard.mockRejectedValueOnce(new Error('simulated database cleanup failure'));
    const firstApi = activeDisableApi();

    await expect(
      runUninstall(
        {
          env: ENV,
          connect: async () => connection(),
          files: FILES,
          client: firstApi.client,
        },
        { yes: true },
      ),
    ).rejects.toThrow('simulated database cleanup failure');
    expect(firstApi.patches()).toHaveLength(1);

    vi.clearAllMocks();
    mocks.inspectLifecycle
      .mockResolvedValueOnce(healthyLifecycle())
      .mockResolvedValueOnce(healthyLifecycle())
      .mockResolvedValueOnce(absentLifecycle());
    mocks.readSchema.mockResolvedValue(healthySchema());
    mocks.readStrict.mockResolvedValue(strictDisabled());
    mocks.readTrigger.mockResolvedValue({ kind: 'absent' });
    mocks.dropGuard.mockResolvedValue(undefined);
    const secondApi = managementApiDouble([
      authConfigResponse(ours(false)),
      authConfigResponse(ours(false)),
    ]);

    const resumed = await runUninstall(
      {
        env: ENV,
        connect: async () => connection(),
        files: FILES,
        client: secondApi.client,
      },
      { yes: true },
    );

    expect(resumed.state).toBe('complete');
    expect(resumed.remotePatched).toBe(false);
    expect(resumed.databaseRemoved).toBe(true);
    expect(secondApi.patches()).toHaveLength(0);
  });

  it('redacts the Management API token from uninstall errors', async () => {
    const api = managementApiDouble([
      errorResponse(500, `server accidentally echoed ${SENTINEL_TOKEN}`),
    ]);

    const error = await runUninstall(
      { env: ENV, connect: async () => connection(), files: FILES, client: api.client },
      { yes: true },
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(SupabaseApiError);
    expect(String(error)).not.toContain(SENTINEL_TOKEN);
  });

  it('is idempotent when the database layer is already absent and remote is disabled', async () => {
    mocks.inspectLifecycle.mockResolvedValue(absentLifecycle());
    mocks.readSchema.mockResolvedValue(
      healthySchema({
        schemaInstalled: false,
        health: 'not-installed',
        currentVersion: undefined,
        blockedDomainCount: undefined,
        allowedDomainCount: undefined,
      }),
    );
    const api = managementApiDouble([
      authConfigResponse(ours(false)),
      authConfigResponse(ours(false)),
    ]);

    const report = await runUninstall(
      { env: ENV, connect: async () => connection(), files: FILES, client: api.client },
      { yes: true },
    );

    expect(report.state).toBe('complete');
    expect(report.databaseRemoved).toBe(false);
    expect(report.remotePatched).toBe(false);
    expect(mocks.dropGuard).not.toHaveBeenCalled();
  });
});
