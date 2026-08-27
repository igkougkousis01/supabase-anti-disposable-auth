/**
 * The activation state machine, exhaustively.
 *
 * Every combination of `enabled` and `uri` has a defined verdict for both intents, and
 * every one of them is asserted here. This is the part of the branch that decides
 * whether somebody's authentication configuration gets overwritten, and it is a pure
 * function precisely so that decision can be pinned down without a network in the way.
 */

import { describe, expect, it } from 'vitest';

import { planHookChange, readHookState, verifyHookState } from '../../src/supabase/auth-config.js';
import { BEFORE_USER_CREATED_HOOK_URI } from '../../src/supabase/constants.js';
import type { BeforeUserCreatedHookState } from '../../src/supabase/types.js';

const FOREIGN_URI = 'pg-functions://postgres/custom/existing_hook';

function state(enabled: boolean, uri: string | undefined): BeforeUserCreatedHookState {
  return readHookState({
    hook_before_user_created_enabled: enabled,
    hook_before_user_created_uri: uri ?? null,
  });
}

describe('readHookState', () => {
  it.each([undefined, null, '', '   '])('treats %j as "no URI configured"', (uri) => {
    const result = readHookState({
      hook_before_user_created_enabled: false,
      hook_before_user_created_uri: uri,
    });

    expect(result.configured).toBe(false);
    expect(result.uri).toBeUndefined();
    expect(result.isOurs).toBe(false);
  });

  it.each([undefined, null, false])('treats %j as not enabled', (enabled) => {
    expect(
      readHookState({
        hook_before_user_created_enabled: enabled,
        hook_before_user_created_uri: BEFORE_USER_CREATED_HOOK_URI,
      }).enabled,
    ).toBe(false);
  });

  it('recognises our own URI', () => {
    expect(state(true, BEFORE_USER_CREATED_HOOK_URI).isOurs).toBe(true);
  });

  it('recognises our own URI with surrounding whitespace', () => {
    expect(state(true, `  ${BEFORE_USER_CREATED_HOOK_URI}  `).isOurs).toBe(true);
  });

  it('does not mistake a different function in the guard schema for ours', () => {
    expect(state(true, 'pg-functions://postgres/guard/something_else').isOurs).toBe(false);
  });

  it('does not mistake an HTTP hook for ours', () => {
    expect(state(true, 'https://example.test/hooks/before-user-created').isOurs).toBe(false);
  });
});

describe('planHookChange — enable', () => {
  it('disabled with no URI: patches both fields', () => {
    const plan = planHookChange(state(false, undefined), 'enable');

    expect(plan.action).toBe('change');
    expect(plan.patch).toEqual({
      hook_before_user_created_enabled: true,
      hook_before_user_created_uri: BEFORE_USER_CREATED_HOOK_URI,
    });
  });

  it('disabled with our URI: patches both fields', () => {
    const plan = planHookChange(state(false, BEFORE_USER_CREATED_HOOK_URI), 'enable');

    expect(plan.action).toBe('change');
    expect(plan.patch?.hook_before_user_created_enabled).toBe(true);
  });

  it('enabled with our URI: no-op, and no patch to send', () => {
    const plan = planHookChange(state(true, BEFORE_USER_CREATED_HOOK_URI), 'enable');

    expect(plan.action).toBe('no-op');
    expect(plan.patch).toBeUndefined();
  });

  it('enabled with a different URI: conflict', () => {
    const plan = planHookChange(state(true, FOREIGN_URI), 'enable');

    expect(plan.action).toBe('conflict');
    expect(plan.patch).toBeUndefined();
  });

  it('DISABLED with a different URI: still a conflict', () => {
    // The conservative row. A disabled foreign hook is somebody's configuration in a
    // paused state, not a free slot -- taking it destroys their ability to resume it.
    const plan = planHookChange(state(false, FOREIGN_URI), 'enable');

    expect(plan.action).toBe('conflict');
    expect(plan.patch).toBeUndefined();
  });

  it('enabled with no URI at all: repairs it rather than conflicting', () => {
    // Auth says "on" with nothing to call. That is broken, not competing.
    const plan = planHookChange(state(true, undefined), 'enable');

    expect(plan.action).toBe('change');
    expect(plan.patch?.hook_before_user_created_uri).toBe(BEFORE_USER_CREATED_HOOK_URI);
  });

  it('always sends the URI, never just the flag', () => {
    // `enabled = true` against a slot whose URI we did not assert would be trusting a
    // value read milliseconds ago. Sending both makes the request state-setting.
    for (const current of [state(false, undefined), state(false, BEFORE_USER_CREATED_HOOK_URI)]) {
      expect(planHookChange(current, 'enable').patch?.hook_before_user_created_uri).toBe(
        BEFORE_USER_CREATED_HOOK_URI,
      );
    }
  });
});

describe('planHookChange — disable', () => {
  it('enabled with our URI: patches the flag only', () => {
    const plan = planHookChange(state(true, BEFORE_USER_CREATED_HOOK_URI), 'disable');

    expect(plan.action).toBe('change');
    // The URI is deliberately absent: the least destructive change that turns the hook
    // off, and it keeps the configuration explicit for a later re-enable.
    expect(plan.patch).toEqual({ hook_before_user_created_enabled: false });
    expect(plan.patch).not.toHaveProperty('hook_before_user_created_uri');
  });

  it('disabled with our URI: no-op', () => {
    const plan = planHookChange(state(false, BEFORE_USER_CREATED_HOOK_URI), 'disable');

    expect(plan.action).toBe('no-op');
    expect(plan.patch).toBeUndefined();
  });

  it('nothing configured: no-op', () => {
    const plan = planHookChange(state(false, undefined), 'disable');

    expect(plan.action).toBe('no-op');
    expect(plan.patch).toBeUndefined();
  });

  it('enabled with a different URI: conflict, and nothing is sent', () => {
    const plan = planHookChange(state(true, FOREIGN_URI), 'disable');

    expect(plan.action).toBe('conflict');
    expect(plan.patch).toBeUndefined();
  });

  it('disabled with a different URI: conflict', () => {
    const plan = planHookChange(state(false, FOREIGN_URI), 'disable');

    expect(plan.action).toBe('conflict');
  });

  it('never disables an HTTP hook belonging to somebody else', () => {
    const plan = planHookChange(state(true, 'https://example.test/hook'), 'disable');

    expect(plan.action).toBe('conflict');
  });
});

describe('planHookChange — coverage of the whole state space', () => {
  const uris = [undefined, BEFORE_USER_CREATED_HOOK_URI, FOREIGN_URI];

  it('produces a defined verdict for every state and intent', () => {
    for (const enabled of [true, false]) {
      for (const uri of uris) {
        for (const intent of ['enable', 'disable'] as const) {
          const plan = planHookChange(state(enabled, uri), intent);

          expect(['no-op', 'change', 'conflict']).toContain(plan.action);
          expect(plan.reason).not.toBe('');
          // A patch exists if and only if a change was planned.
          expect(plan.patch !== undefined).toBe(plan.action === 'change');
        }
      }
    }
  });

  it('never plans a change against a URI that is not ours', () => {
    // The single most important property in this file: whatever else the machine
    // decides, it never writes over somebody else's hook.
    for (const enabled of [true, false]) {
      for (const intent of ['enable', 'disable'] as const) {
        expect(planHookChange(state(enabled, FOREIGN_URI), intent).action).toBe('conflict');
      }
    }
  });

  it('never sends a URI field when disabling', () => {
    for (const enabled of [true, false]) {
      for (const uri of [undefined, BEFORE_USER_CREATED_HOOK_URI]) {
        const plan = planHookChange(state(enabled, uri), 'disable');
        expect(plan.patch?.hook_before_user_created_uri).toBeUndefined();
      }
    }
  });
});

describe('verifyHookState', () => {
  it('accepts enable only when the hook is on AND points at us', () => {
    expect(verifyHookState(state(true, BEFORE_USER_CREATED_HOOK_URI), 'enable')).toBe(true);
    expect(verifyHookState(state(false, BEFORE_USER_CREATED_HOOK_URI), 'enable')).toBe(false);
    expect(verifyHookState(state(true, FOREIGN_URI), 'enable')).toBe(false);
    expect(verifyHookState(state(true, undefined), 'enable')).toBe(false);
  });

  it('accepts disable when the hook is off and the slot is ours or empty', () => {
    expect(verifyHookState(state(false, BEFORE_USER_CREATED_HOOK_URI), 'disable')).toBe(true);
    expect(verifyHookState(state(false, undefined), 'disable')).toBe(true);
  });

  it('rejects disable when the hook is still on', () => {
    expect(verifyHookState(state(true, BEFORE_USER_CREATED_HOOK_URI), 'disable')).toBe(false);
  });

  it("rejects disable when the slot became somebody else's", () => {
    // "Off" is not enough. If a concurrent change repointed the slot, the command must
    // not report a clean success over the top of it.
    expect(verifyHookState(state(false, FOREIGN_URI), 'disable')).toBe(false);
  });
});
