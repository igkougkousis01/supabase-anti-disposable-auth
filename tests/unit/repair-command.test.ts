import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as LifecycleModule from '../../src/database/lifecycle.js';
import type * as RepairModule from '../../src/database/repair.js';
import type * as SchemaStatusModule from '../../src/database/schema-status.js';
import type * as StrictTriggerModule from '../../src/database/strict-trigger.js';

const mocks = vi.hoisted(() => ({
  inspectLifecycle: vi.fn(),
  readSchema: vi.fn(),
  inspectGrants: vi.fn(),
  readStrict: vi.fn(),
  applyRepair: vi.fn(),
}));

vi.mock('../../src/database/lifecycle.js', async (importOriginal) => ({
  ...(await importOriginal<typeof LifecycleModule>()),
  inspectGuardLifecycle: mocks.inspectLifecycle,
}));
vi.mock('../../src/database/schema-status.js', async (importOriginal) => ({
  ...(await importOriginal<typeof SchemaStatusModule>()),
  readGuardSchemaStatus: mocks.readSchema,
  inspectAuthHookGrants: mocks.inspectGrants,
}));
vi.mock('../../src/database/strict-trigger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof StrictTriggerModule>()),
  readStrictModeStatus: mocks.readStrict,
}));
vi.mock('../../src/database/repair.js', async (importOriginal) => ({
  ...(await importOriginal<typeof RepairModule>()),
  applyDatabaseRepair: mocks.applyRepair,
}));

import { repairExitCode, runRepair } from '../../src/commands/repair.js';
import type { MigrationFile } from '../../src/database/migration-types.js';
import type { DatabaseConnection } from '../../src/database/types.js';
import { EXIT_CODES } from '../../src/lib/errors.js';
import {
  authConfigResponse,
  managementApiDouble,
  ours,
  SENTINEL_TOKEN,
  TEST_PROJECT_REF,
} from '../helpers/management-api.js';
import {
  completeGrants,
  healthyLifecycle,
  healthySchema,
  strictDisabled,
} from '../helpers/lifecycle.js';

const DB_URL = 'postgresql://postgres:password@db.example.test:5432/postgres';
const ENV = { SUPABASE_DB_URL: DB_URL };
const FILES: MigrationFile[] = [];

function connection(): DatabaseConnection & { closed: boolean } {
  let closed = false;
  return {
    target: 'db.example.test:5432/postgres',
    get closed() {
      return closed;
    },
    execute: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    close: vi.fn(async () => {
      closed = true;
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inspectLifecycle.mockResolvedValue(healthyLifecycle());
  mocks.readSchema.mockResolvedValue(healthySchema());
  mocks.inspectGrants.mockResolvedValue(completeGrants());
  mocks.readStrict.mockResolvedValue(strictDisabled());
  mocks.applyRepair.mockResolvedValue(undefined);
});

describe('runRepair', () => {
  it('is a no-op success for a healthy installation', async () => {
    const database = connection();
    const report = await runRepair({
      env: ENV,
      connect: async () => database,
      files: FILES,
    });

    expect(report.assessment.state).toBe('healthy');
    expect(report.changed).toBe(false);
    expect(repairExitCode(report)).toBe(EXIT_CODES.success);
    expect(mocks.applyRepair).not.toHaveBeenCalled();
    expect(database.closed).toBe(true);
  });

  it('dry-runs missing grants with zero mutation', async () => {
    mocks.readSchema.mockResolvedValue(
      healthySchema({
        health: 'incomplete',
        authHookGrants: 'incomplete',
        missingAuthHookGrants: ['USAGE on guard'],
      }),
    );
    mocks.inspectGrants.mockResolvedValue(
      completeGrants({ missing: ['USAGE on guard', 'SELECT on guard.blocked_domains'] }),
    );
    const report = await runRepair(
      { env: ENV, connect: async () => connection(), files: FILES },
      { dryRun: true },
    );

    expect(report.assessment.state).toBe('repairable');
    expect(report.assessment.changes[0]?.description).toContain('USAGE on guard');
    expect(report.changed).toBe(false);
    expect(mocks.applyRepair).not.toHaveBeenCalled();
  });

  it('restores missing grants and verifies the resulting state', async () => {
    mocks.readSchema
      .mockResolvedValueOnce(
        healthySchema({
          health: 'incomplete',
          authHookGrants: 'incomplete',
          missingAuthHookGrants: ['USAGE on guard'],
        }),
      )
      .mockResolvedValueOnce(healthySchema());
    mocks.inspectGrants
      .mockResolvedValueOnce(completeGrants({ missing: ['USAGE on guard'] }))
      .mockResolvedValueOnce(completeGrants());

    const report = await runRepair({
      env: ENV,
      connect: async () => connection(),
      files: FILES,
    });

    expect(mocks.applyRepair).toHaveBeenCalledTimes(1);
    expect(mocks.applyRepair.mock.calls[0]?.[2]).toEqual([
      expect.objectContaining({ kind: 'restore-auth-hook-grants' }),
    ]);
    expect(report.changed).toBe(true);
    expect(report.finalState).toBe('healthy');
  });

  it('recreates a missing hook function without touching migration history through the command', async () => {
    mocks.inspectLifecycle
      .mockResolvedValueOnce(
        healthyLifecycle({ missingFunctions: ['guard.before_user_created(jsonb)'] }),
      )
      .mockResolvedValueOnce(healthyLifecycle());
    mocks.readSchema
      .mockResolvedValueOnce(
        healthySchema({
          health: 'incomplete',
          hookFunctionInstalled: false,
          missingObjects: ['guard.before_user_created(jsonb)'],
        }),
      )
      .mockResolvedValueOnce(healthySchema());
    mocks.inspectGrants
      .mockResolvedValueOnce(
        completeGrants({ missing: ['EXECUTE on guard.before_user_created(jsonb)'] }),
      )
      .mockResolvedValueOnce(completeGrants());

    const report = await runRepair({
      env: ENV,
      connect: async () => connection(),
      files: FILES,
    });

    expect(report.finalState).toBe('healthy');
    expect(mocks.applyRepair.mock.calls[0]?.[2]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'restore-before-user-created-function' }),
      ]),
    );
  });

  it('refuses core-table damage and executes no repair routine', async () => {
    mocks.inspectLifecycle.mockResolvedValue(
      healthyLifecycle({ missingTables: ['guard.blocked_domains'] }),
    );
    mocks.readSchema.mockResolvedValue(
      healthySchema({
        health: 'incomplete',
        missingObjects: ['guard.blocked_domains'],
        blockedDomainCount: undefined,
      }),
    );

    const report = await runRepair({
      env: ENV,
      connect: async () => connection(),
      files: FILES,
    });

    expect(report.assessment.state).toBe('manual-action-required');
    expect(repairExitCode(report)).toBe(EXIT_CODES.guardHealth);
    expect(mocks.applyRepair).not.toHaveBeenCalled();
  });

  it('inspects but never enables a disabled remote hook', async () => {
    mocks.readSchema
      .mockResolvedValueOnce(
        healthySchema({
          health: 'incomplete',
          authHookGrants: 'incomplete',
          missingAuthHookGrants: ['USAGE on guard'],
        }),
      )
      .mockResolvedValueOnce(healthySchema());
    mocks.inspectGrants
      .mockResolvedValueOnce(completeGrants({ missing: ['USAGE on guard'] }))
      .mockResolvedValueOnce(completeGrants());
    const api = managementApiDouble([authConfigResponse(ours(false))]);

    const report = await runRepair({
      env: {
        SUPABASE_DB_URL: DB_URL,
        SUPABASE_PROJECT_REF: TEST_PROJECT_REF,
        SUPABASE_ACCESS_TOKEN: SENTINEL_TOKEN,
      },
      connect: async () => connection(),
      files: FILES,
      client: api.client,
    });

    expect(report.remote.kind).toBe('inactive');
    expect(api.patches()).toHaveLength(0);
    expect(api.requests).toHaveLength(1);
  });

  it('reports a missing role and does not fabricate a repaired result', async () => {
    mocks.inspectGrants.mockResolvedValue({ rolePresent: false, missing: [] });

    const report = await runRepair({
      env: ENV,
      connect: async () => connection(),
      files: FILES,
    });

    expect(report.assessment.state).toBe('manual-action-required');
    expect(report.finalState).toBe('manual-action-required');
    expect(mocks.applyRepair).not.toHaveBeenCalled();
  });
});
