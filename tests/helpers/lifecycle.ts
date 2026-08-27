import type { GuardLifecycleInspection } from '../../src/database/lifecycle.js';
import type {
  AuthHookGrantInspection,
  GuardSchemaStatus,
} from '../../src/database/schema-status.js';
import type { StrictModeStatus } from '../../src/database/strict-trigger.js';

export function healthyLifecycle(
  overrides: Partial<GuardLifecycleInspection> = {},
): GuardLifecycleInspection {
  return {
    schemaPresent: true,
    schemaOwner: 'postgres',
    currentRole: 'postgres',
    historyVerified: true,
    appliedVersions: ['001', '002', '003', '004', '005', '006', '007', '008'],
    pendingVersions: [],
    missingTables: [],
    missingFunctions: [],
    modifiedObjects: [],
    unexpectedObjects: [],
    ownerMismatches: [],
    externalDependencies: [],
    ...overrides,
  };
}

export function absentLifecycle(): GuardLifecycleInspection {
  return healthyLifecycle({
    schemaPresent: false,
    schemaOwner: undefined,
    historyVerified: false,
    appliedVersions: [],
  });
}

export function healthySchema(overrides: Partial<GuardSchemaStatus> = {}): GuardSchemaStatus {
  return {
    schemaInstalled: true,
    applied: [],
    currentVersion: '008',
    pending: [],
    blockedDomainCount: 74_825,
    allowedDomainCount: 3,
    lookupFunctionInstalled: true,
    hookFunctionInstalled: true,
    authHookGrants: 'granted',
    missingAuthHookGrants: [],
    health: 'complete',
    missingObjects: [],
    ...overrides,
  };
}

export function completeGrants(
  overrides: Partial<AuthHookGrantInspection> = {},
): AuthHookGrantInspection {
  return { rolePresent: true, missing: [], ...overrides };
}

export function strictDisabled(overrides: Partial<StrictModeStatus> = {}): StrictModeStatus {
  return {
    mode: 'disabled',
    functionInstalled: true,
    authUsers: {
      tablePresent: true,
      emailColumnType: 'text',
      emailColumnCompatible: true,
      canCreateTrigger: true,
      authSchemaUsage: true,
    },
    trigger: { kind: 'absent' },
    blockers: [],
    ...overrides,
  };
}

export function strictEnabled(): StrictModeStatus {
  return strictDisabled({
    mode: 'enabled',
    trigger: { kind: 'ours', definition: 'CREATE TRIGGER expected' },
  });
}
