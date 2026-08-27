/**
 * Catalog inspection and DDL identity for optional strict mode.
 *
 * The tests that matter most here are the ones about NOT acting: a trigger that merely
 * shares our name must be recognised as somebody else's, and the two DDL statements must
 * be exactly what this tool claims they are.
 */

import { describe, expect, it } from 'vitest';

import {
  createStrictTrigger,
  dropStrictTrigger,
  readAuthUsersCompatibility,
  readStrictModeStatus,
  readStrictTriggerState,
  AUTH_USERS_TABLE,
  CREATE_STRICT_TRIGGER_SQL,
  DROP_STRICT_TRIGGER_SQL,
  EXPECTED_TRIGGER_TYPE,
  STRICT_TRIGGER_FUNCTION,
  STRICT_TRIGGER_NAME,
} from '../../src/database/strict-trigger.js';
import { FakeDatabase, OUR_STRICT_TRIGGER_ROW } from '../helpers/database.js';

/** Everything a Supabase-shaped database needs for strict mode to be available. */
const SUPABASE_SHAPED = {
  presentObjects: ['auth.users', STRICT_TRIGGER_FUNCTION],
  authUsersEmailColumn: { type_name: 'character varying(255)', category: 'S' },
  privileges: { current_user: ['USAGE on auth', 'TRIGGER on auth.users'] },
};

function database(overrides: Record<string, unknown> = {}): FakeDatabase {
  return new FakeDatabase({ ...SUPABASE_SHAPED, ...overrides });
}

/** A catalog row that differs from ours in exactly one field. */
function triggerRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...OUR_STRICT_TRIGGER_ROW, ...overrides };
}

describe('the fixed trigger identity', () => {
  it('uses one stable, compiled-in name', () => {
    expect(STRICT_TRIGGER_NAME).toBe('supabase_anti_disposable_auth_strict_email');
  });

  it('creates exactly the documented trigger, and nothing configurable', () => {
    expect(CREATE_STRICT_TRIGGER_SQL).toBe(
      `create trigger supabase_anti_disposable_auth_strict_email
  before insert or update of email on auth.users
  for each row execute function guard.enforce_auth_user_email()`,
    );
  });

  it('drops by fixed name and never with IF EXISTS', () => {
    // `drop trigger if exists` followed by a recreate is precisely how a trigger
    // somebody else created under this name would be destroyed without being asked.
    expect(DROP_STRICT_TRIGGER_SQL).toBe(
      'drop trigger supabase_anti_disposable_auth_strict_email on auth.users',
    );
    expect(DROP_STRICT_TRIGGER_SQL).not.toContain('if exists');
  });

  it('puts the trigger function in guard, never in auth or public', () => {
    expect(STRICT_TRIGGER_FUNCTION).toBe('guard.enforce_auth_user_email()');
  });

  it('expects BEFORE INSERT OR UPDATE ... FOR EACH ROW and nothing else', () => {
    // ROW(1) | BEFORE(2) | INSERT(4) | UPDATE(16). DELETE(8), TRUNCATE(32) and
    // INSTEAD OF(64) must all be absent.
    expect(EXPECTED_TRIGGER_TYPE).toBe(23);
  });

  it('executes the create statement verbatim', async () => {
    const db = database();

    await createStrictTrigger(db);

    expect(db.executed).toEqual([CREATE_STRICT_TRIGGER_SQL]);
  });

  it('executes the drop statement verbatim', async () => {
    const db = database({ strictTrigger: OUR_STRICT_TRIGGER_ROW });

    await dropStrictTrigger(db);

    expect(db.executed).toEqual([DROP_STRICT_TRIGGER_SQL]);
  });
});

describe('readStrictTriggerState', () => {
  it('reports absent when no trigger of ours exists', async () => {
    expect(await readStrictTriggerState(database())).toEqual({ kind: 'absent' });
  });

  it('recognises the trigger it creates', async () => {
    const state = await readStrictTriggerState(database({ strictTrigger: OUR_STRICT_TRIGGER_ROW }));

    expect(state.kind).toBe('ours');
  });

  it('does not raise on a database with no auth schema at all', async () => {
    // A local development server. `strict status` must be runnable anywhere, so the
    // lookup joins through pg_class by name rather than casting to regclass.
    expect(await readStrictTriggerState(new FakeDatabase())).toEqual({ kind: 'absent' });
  });

  it.each([
    [
      'a different function',
      { function_schema: 'public', function_name: 'something_else' },
      'public.something_else()',
    ],
    [
      'a function in auth',
      { function_schema: 'auth', function_name: 'whatever' },
      'auth.whatever()',
    ],
  ])('reports a conflict when the trigger runs %s', async (_label, overrides, expected) => {
    const state = await readStrictTriggerState(database({ strictTrigger: triggerRow(overrides) }));

    expect(state.kind).toBe('conflict');
    expect(state.kind === 'conflict' && state.reasons.join(' ')).toContain(expected);
  });

  it('reports a conflict when the timing or events differ', async () => {
    // 7 = ROW | BEFORE | INSERT: no UPDATE, so an email change would not be checked.
    const state = await readStrictTriggerState(
      database({ strictTrigger: triggerRow({ tgtype: 7 }) }),
    );

    expect(state.kind).toBe('conflict');
    expect(state.kind === 'conflict' && state.reasons.join(' ')).toContain('timing or events');
  });

  it('reports a conflict when the column filter is wrong', async () => {
    const state = await readStrictTriggerState(
      database({ strictTrigger: triggerRow({ columns: ['email', 'phone'] }) }),
    );

    expect(state.kind).toBe('conflict');
    expect(state.kind === 'conflict' && state.reasons.join(' ')).toContain('(email, phone)');
  });

  it('reports a conflict when there is no column filter at all', async () => {
    const state = await readStrictTriggerState(
      database({ strictTrigger: triggerRow({ columns: null }) }),
    );

    expect(state.kind).toBe('conflict');
    expect(state.kind === 'conflict' && state.reasons.join(' ')).toContain('no UPDATE OF column');
  });

  it('treats a trigger disabled by hand as a conflict, not as enabled', async () => {
    // ALTER TABLE ... DISABLE TRIGGER is a decision somebody made. Reporting it as
    // enabled would be a lie; re-enabling it would overwrite them.
    const state = await readStrictTriggerState(
      database({ strictTrigger: triggerRow({ tgenabled: 'D' }) }),
    );

    expect(state.kind).toBe('conflict');
    expect(state.kind === 'conflict' && state.reasons.join(' ')).toContain('tgenabled');
  });

  it('reports a conflict for a constraint trigger', async () => {
    const state = await readStrictTriggerState(
      database({ strictTrigger: triggerRow({ is_constraint: true }) }),
    );

    expect(state.kind).toBe('conflict');
  });

  it('reports a conflict for a trigger carrying a WHEN clause', async () => {
    const state = await readStrictTriggerState(
      database({ strictTrigger: triggerRow({ has_when: true }) }),
    );

    expect(state.kind).toBe('conflict');
  });

  it('names every mismatch at once rather than only the first', async () => {
    const state = await readStrictTriggerState(
      database({
        strictTrigger: triggerRow({ function_name: 'other', tgtype: 7, tgenabled: 'D' }),
      }),
    );

    expect(state.kind === 'conflict' && state.reasons).toHaveLength(3);
  });
});

describe('readAuthUsersCompatibility', () => {
  it('reports a plain PostgreSQL database as having no auth.users', async () => {
    const probe = await readAuthUsersCompatibility(new FakeDatabase());

    expect(probe.tablePresent).toBe(false);
    expect(probe.emailColumnCompatible).toBe(false);
    // Not probed, because has_table_privilege() raises for an unknown table.
    expect(probe.canCreateTrigger).toBeUndefined();
  });

  it('accepts the varchar(255) column Supabase actually ships', async () => {
    const probe = await readAuthUsersCompatibility(database());

    expect(probe.tablePresent).toBe(true);
    expect(probe.emailColumnType).toBe('character varying(255)');
    expect(probe.emailColumnCompatible).toBe(true);
    expect(probe.canCreateTrigger).toBe(true);
  });

  it('rejects an email column that does not hold text', async () => {
    const probe = await readAuthUsersCompatibility(
      database({ authUsersEmailColumn: { type_name: 'integer', category: 'N' } }),
    );

    expect(probe.emailColumnCompatible).toBe(false);
  });

  it('reports a missing TRIGGER privilege rather than assuming it', async () => {
    const probe = await readAuthUsersCompatibility(database({ privileges: {} }));

    expect(probe.canCreateTrigger).toBe(false);
  });
});

describe('readStrictModeStatus', () => {
  it('reports disabled on a ready database with no trigger', async () => {
    const status = await readStrictModeStatus(database(), { guardHealthy: true });

    expect(status.mode).toBe('disabled');
    expect(status.blockers).toEqual([]);
  });

  it('reports enabled when our trigger is attached to a healthy guard layer', async () => {
    const status = await readStrictModeStatus(database({ strictTrigger: OUR_STRICT_TRIGGER_ROW }), {
      guardHealthy: true,
    });

    expect(status.mode).toBe('enabled');
  });

  it('reports broken when our trigger is attached to a damaged guard layer', async () => {
    // The trigger has no exception handler, so this is not degraded protection --
    // writes to auth.users are being rejected right now.
    const status = await readStrictModeStatus(database({ strictTrigger: OUR_STRICT_TRIGGER_ROW }), {
      guardHealthy: false,
    });

    expect(status.mode).toBe('broken');
  });

  it('reports broken when the trigger function has been dropped underneath the trigger', async () => {
    const status = await readStrictModeStatus(
      database({ presentObjects: ['auth.users'], strictTrigger: OUR_STRICT_TRIGGER_ROW }),
      { guardHealthy: true },
    );

    expect(status.mode).toBe('broken');
    expect(status.functionInstalled).toBe(false);
  });

  it('reports unavailable, not broken, where there is no auth.users', async () => {
    const status = await readStrictModeStatus(new FakeDatabase(), { guardHealthy: true });

    expect(status.mode).toBe('unavailable');
    expect(status.blockers[0]).toContain(`${AUTH_USERS_TABLE} does not exist`);
  });

  it('says nothing further once auth.users is missing', async () => {
    // Listing the consequences of an absent table as separate blockers would bury the
    // one fact that explains all of them.
    const status = await readStrictModeStatus(new FakeDatabase(), { guardHealthy: false });

    expect(status.blockers).toHaveLength(1);
  });

  it('reports unavailable when migration 008 has not been applied', async () => {
    const status = await readStrictModeStatus(database({ presentObjects: ['auth.users'] }), {
      guardHealthy: true,
    });

    expect(status.mode).toBe('unavailable');
    expect(status.blockers).toContain(`${STRICT_TRIGGER_FUNCTION} is not installed`);
  });

  it('lets a conflict outrank every other verdict', async () => {
    const status = await readStrictModeStatus(
      database({ strictTrigger: triggerRow({ function_name: 'other' }) }),
      { guardHealthy: false },
    );

    expect(status.mode).toBe('conflict');
  });

  it('names an unhealthy guard layer and a missing privilege as blockers', async () => {
    const status = await readStrictModeStatus(database({ privileges: {} }), {
      guardHealthy: false,
    });

    expect(status.blockers).toEqual([
      'the guard policy layer is not healthy',
      'the connected role has no USAGE on the auth schema',
      `the connected role has no TRIGGER privilege on ${AUTH_USERS_TABLE}`,
    ]);
  });

  it('never writes anything while reading', async () => {
    const db = database({ strictTrigger: OUR_STRICT_TRIGGER_ROW });

    await readStrictModeStatus(db, { guardHealthy: true });

    expect(db.executed).toEqual([]);
  });
});
