import { describe, expect, it } from 'vitest';

import { planRepair } from '../../src/commands/repair.js';
import type { RepairAssessmentInput } from '../../src/commands/repair.js';
import { readHookState } from '../../src/supabase/auth-config.js';
import { BEFORE_USER_CREATED_HOOK_URI } from '../../src/supabase/constants.js';
import {
  absentLifecycle,
  completeGrants,
  healthyLifecycle,
  healthySchema,
  strictDisabled,
} from '../helpers/lifecycle.js';

function input(overrides: Partial<RepairAssessmentInput> = {}): RepairAssessmentInput {
  return {
    lifecycle: healthyLifecycle(),
    schema: healthySchema(),
    grants: completeGrants(),
    strict: strictDisabled(),
    remote: { kind: 'not-checked' },
    ...overrides,
  };
}

describe('repair state model', () => {
  it('classifies an absent guard schema as not installed', () => {
    const plan = planRepair(
      input({
        lifecycle: absentLifecycle(),
        schema: healthySchema({
          schemaInstalled: false,
          currentVersion: undefined,
          health: 'not-installed',
        }),
      }),
    );

    expect(plan).toEqual({
      state: 'not-installed',
      changes: [],
      reasons: ['The guard schema is not installed.'],
    });
  });

  it('classifies a healthy installation as a no-op', () => {
    expect(planRepair(input())).toEqual({ state: 'healthy', changes: [], reasons: [] });
  });

  it('repairs only the fixed least-privilege grants that are missing', () => {
    const plan = planRepair(
      input({
        grants: completeGrants({
          missing: [
            'USAGE on guard',
            'EXECUTE on guard.before_user_created(jsonb)',
            'SELECT on guard.blocked_domains',
          ],
        }),
      }),
    );

    expect(plan.state).toBe('repairable');
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]?.kind).toBe('restore-auth-hook-grants');
    expect(plan.changes[0]?.description).toContain('USAGE on guard');
  });

  it('recreates a missing hook function with a deliberate leaf repair', () => {
    const plan = planRepair(
      input({
        lifecycle: healthyLifecycle({
          missingFunctions: ['guard.before_user_created(jsonb)'],
        }),
        schema: healthySchema({
          health: 'incomplete',
          hookFunctionInstalled: false,
          missingObjects: ['guard.before_user_created(jsonb)'],
        }),
        grants: completeGrants({
          missing: ['EXECUTE on guard.before_user_created(jsonb)'],
        }),
      }),
    );

    expect(plan.state).toBe('repairable');
    expect(plan.changes.map((change) => change.kind)).toEqual([
      'restore-before-user-created-function',
      'restore-auth-hook-grants',
    ]);
  });

  it('can restore the inert strict trigger function without enabling strict mode', () => {
    const plan = planRepair(
      input({
        lifecycle: healthyLifecycle({
          missingFunctions: ['guard.enforce_auth_user_email()'],
        }),
        strict: strictDisabled({ functionInstalled: false, mode: 'unavailable' }),
      }),
    );

    expect(plan.state).toBe('repairable');
    expect(plan.changes.map((change) => change.kind)).toEqual(['restore-strict-trigger-function']);
    expect(
      plan.changes.some((change) => change.description.includes('trigger on auth.users')),
    ).toBe(false);
  });

  it.each(['guard.blocked_domains', 'guard.allowed_domains', 'guard.sync_metadata'])(
    'refuses to recreate missing core data table %s',
    (table) => {
      const plan = planRepair(
        input({
          lifecycle: healthyLifecycle({ missingTables: [table] }),
          schema: healthySchema({ health: 'incomplete', missingObjects: [table] }),
        }),
      );

      expect(plan.state).toBe('manual-action-required');
      expect(plan.changes).toEqual([]);
      expect(plan.reasons.join('\n')).toContain('Data loss may have occurred');
    },
  );

  it('refuses to rebuild a missing core policy function', () => {
    const plan = planRepair(
      input({
        lifecycle: healthyLifecycle({
          missingFunctions: ['guard.is_disposable_domain(text)'],
        }),
      }),
    );

    expect(plan.state).toBe('manual-action-required');
    expect(plan.changes).toEqual([]);
  });

  it('reports an absent Supabase Auth role and does not fabricate success', () => {
    const plan = planRepair(input({ grants: { rolePresent: false, missing: [] } }));

    expect(plan.state).toBe('manual-action-required');
    expect(plan.reasons.join('\n')).toContain('supabase_auth_admin does not exist');
  });

  it.each([
    ['foreign object', healthyLifecycle({ unexpectedObjects: ['view guard.operator_view'] })],
    [
      'modified owned object',
      healthyLifecycle({ modifiedObjects: ['function guard.before_user_created(jsonb) differs'] }),
    ],
    [
      'owner mismatch',
      healthyLifecycle({ ownerMismatches: ['table guard.blocked_domains has another owner'] }),
    ],
    ['missing history', healthyLifecycle({ historyVerified: false })],
  ])('classifies %s as conflict', (_label, lifecycle) => {
    const plan = planRepair(input({ lifecycle }));

    expect(plan.state).toBe('conflict');
    expect(plan.changes).toEqual([]);
  });

  it('does not enable a remote hook that is disabled', () => {
    const remote = readHookState({
      hook_before_user_created_enabled: false,
      hook_before_user_created_uri: BEFORE_USER_CREATED_HOOK_URI,
    });
    const plan = planRepair(input({ remote: { kind: 'inactive', state: remote } }));

    expect(plan.state).toBe('healthy');
    expect(plan.changes).toEqual([]);
  });

  it('does not enable strict mode when the trigger is absent', () => {
    const plan = planRepair(input({ strict: strictDisabled() }));

    expect(plan.state).toBe('healthy');
    expect(plan.changes).toEqual([]);
  });

  it('refuses a foreign remote hook without exposing an HTTP path or query', () => {
    const foreign = readHookState({
      hook_before_user_created_enabled: true,
      hook_before_user_created_uri: 'https://hooks.example.test/private?token=sentinel',
    });
    const plan = planRepair(input({ remote: { kind: 'conflict', state: foreign } }));
    const output = plan.reasons.join('\n');

    expect(plan.state).toBe('conflict');
    expect(output).toContain('hooks.example.test');
    expect(output).not.toContain('private');
    expect(output).not.toContain('sentinel');
  });

  it('refuses a conflicting strict trigger', () => {
    const plan = planRepair(
      input({
        strict: strictDisabled({
          mode: 'conflict',
          trigger: {
            kind: 'conflict',
            reasons: ['it runs public.foreign()'],
            definition: 'secret definition',
          },
        }),
      }),
    );

    expect(plan.state).toBe('conflict');
    expect(plan.changes).toEqual([]);
  });
});
