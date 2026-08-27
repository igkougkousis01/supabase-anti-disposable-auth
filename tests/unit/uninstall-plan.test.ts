import { describe, expect, it } from 'vitest';

import { planUninstall, printUninstallPlan } from '../../src/commands/uninstall.js';
import type { UninstallAssessmentInput } from '../../src/commands/uninstall.js';
import { DROP_GUARD_OBJECTS_SQL } from '../../src/database/uninstall.js';
import { readHookState } from '../../src/supabase/auth-config.js';
import { BEFORE_USER_CREATED_HOOK_URI } from '../../src/supabase/constants.js';
import {
  absentLifecycle,
  healthyLifecycle,
  healthySchema,
  strictDisabled,
  strictEnabled,
} from '../helpers/lifecycle.js';
import { createRecordingLogger } from '../helpers/logger.js';

const ACTIVE_OURS = readHookState({
  hook_before_user_created_enabled: true,
  hook_before_user_created_uri: BEFORE_USER_CREATED_HOOK_URI,
});
const INACTIVE_OURS = readHookState({
  hook_before_user_created_enabled: false,
  hook_before_user_created_uri: BEFORE_USER_CREATED_HOOK_URI,
});

function input(overrides: Partial<UninstallAssessmentInput> = {}): UninstallAssessmentInput {
  return {
    lifecycle: healthyLifecycle(),
    schema: healthySchema(),
    strict: strictDisabled(),
    remote: { kind: 'inactive', state: INACTIVE_OURS },
    databaseOnly: false,
    ...overrides,
  };
}

describe('uninstall safety plan', () => {
  it('orders strict cleanup before remote disable and database removal', () => {
    const plan = planUninstall(
      input({ strict: strictEnabled(), remote: { kind: 'active', state: ACTIVE_OURS } }),
    );

    expect(plan.state).toBe('ready');
    expect(plan.steps).toEqual([
      'disable the owned strict trigger on auth.users',
      'disable and verify the hosted Before User Created hook',
      'remove verified guard functions, tables, data, metadata, and migration history',
      'drop the empty guard schema without CASCADE',
    ]);
  });

  it('continues safely when strict and the remote hook are already disabled', () => {
    const plan = planUninstall(input());

    expect(plan.state).toBe('ready');
    expect(plan.steps[0]).toContain('hosted Before User Created');
    expect(plan.steps).not.toContain('disable the owned strict trigger on auth.users');
  });

  it('allows a verified partial installation to be resumed', () => {
    const plan = planUninstall(
      input({
        lifecycle: healthyLifecycle({
          missingTables: ['guard.sync_metadata'],
          missingFunctions: ['guard.before_user_created(jsonb)'],
        }),
      }),
    );

    expect(plan.state).toBe('ready');
    expect(plan.conflicts).toEqual([]);
  });

  it.each([
    [
      'foreign remote hook',
      input({
        remote: {
          kind: 'conflict',
          state: readHookState({
            hook_before_user_created_enabled: true,
            hook_before_user_created_uri: 'pg-functions://postgres/custom/foreign_hook',
          }),
        },
      }),
    ],
    [
      'foreign strict trigger',
      input({
        strict: strictDisabled({
          mode: 'conflict',
          trigger: {
            kind: 'conflict',
            reasons: ['it runs public.foreign()'],
            definition: 'CREATE TRIGGER foreign',
          },
        }),
      }),
    ],
    [
      'foreign guard object',
      input({ lifecycle: healthyLifecycle({ unexpectedObjects: ['view guard.operator_view'] }) }),
    ],
    [
      'external dependency',
      input({
        lifecycle: healthyLifecycle({
          externalDependencies: ['view public.operator_report'],
        }),
      }),
    ],
    [
      'modified owned-name object',
      input({
        lifecycle: healthyLifecycle({
          modifiedObjects: [
            'function guard.before_user_created(jsonb) has an unexpected definition',
          ],
        }),
      }),
    ],
    ['unverified ownership', input({ lifecycle: healthyLifecycle({ historyVerified: false }) })],
  ])('refuses %s before producing destructive steps', (_label, state) => {
    const plan = planUninstall(state);

    expect(plan.state).toBe('conflict');
    expect(plan.steps).toEqual([]);
    expect(plan.conflicts.length).toBeGreaterThan(0);
  });

  it('treats a fully absent database layer as already uninstalled', () => {
    const plan = planUninstall(
      input({
        lifecycle: absentLifecycle(),
        schema: healthySchema({
          schemaInstalled: false,
          health: 'not-installed',
          currentVersion: undefined,
          blockedDomainCount: undefined,
          allowedDomainCount: undefined,
        }),
      }),
    );

    expect(plan.state).toBe('ready');
    // Full mode still performs a fresh remote verification immediately before declaring
    // the cross-system uninstall complete.
    expect(plan.steps).toEqual(['disable and verify the hosted Before User Created hook']);
  });

  it('allows an explicit database-only plan when remote state is unknown', () => {
    const plan = planUninstall(input({ databaseOnly: true, remote: { kind: 'not-checked' } }));

    expect(plan.state).toBe('ready');
    expect(plan.steps.join('\n')).not.toContain('hosted Before User Created');
  });

  it('refuses database-only removal when our remote hook is proven active', () => {
    const plan = planUninstall(
      input({
        databaseOnly: true,
        remote: { kind: 'active', state: ACTIVE_OURS },
      }),
    );

    expect(plan.state).toBe('conflict');
    expect(plan.conflicts.join('\n')).toContain('verified active');
  });

  it('prints operator-managed allowlist destruction and redacts a foreign HTTP URI', () => {
    const foreign = readHookState({
      hook_before_user_created_enabled: true,
      hook_before_user_created_uri: 'https://hooks.example.test/private?secret=sentinel',
    });
    const plan = planUninstall(input({ remote: { kind: 'conflict', state: foreign } }));
    const { logger, output } = createRecordingLogger();

    printUninstallPlan(plan, 'db.example.test:5432/postgres', { dryRun: true }, logger);

    expect(output()).toContain('hooks.example.test');
    expect(output()).not.toContain('private');
    expect(output()).not.toContain('sentinel');
  });

  it('prints exact data counts for an admitted destructive plan', () => {
    const plan = planUninstall(input());
    const { logger, output } = createRecordingLogger();

    printUninstallPlan(plan, 'db.example.test:5432/postgres', { dryRun: true }, logger);

    expect(output()).toContain('74,825 blocked-domain entries');
    expect(output()).toContain('3 allowlist entries');
    expect(output()).toContain('append-only migration history');
  });
});

describe('database cleanup SQL', () => {
  it('never uses CASCADE or DROP OWNED', () => {
    expect(DROP_GUARD_OBJECTS_SQL).not.toMatch(/\bcascade\b/i);
    expect(DROP_GUARD_OBJECTS_SQL).not.toMatch(/\bdrop\s+owned\b/i);
  });

  it('drops the hook entry point before tables and the schema last', () => {
    const hook = DROP_GUARD_OBJECTS_SQL.indexOf(
      'drop function if exists guard.before_user_created',
    );
    const tables = DROP_GUARD_OBJECTS_SQL.indexOf('drop table if exists guard.blocked_domains');
    const history = DROP_GUARD_OBJECTS_SQL.indexOf('drop table if exists guard.schema_migrations');
    const schema = DROP_GUARD_OBJECTS_SQL.indexOf('drop schema guard');

    expect(hook).toBeLessThan(tables);
    expect(tables).toBeLessThan(history);
    expect(history).toBeLessThan(schema);
  });
});
