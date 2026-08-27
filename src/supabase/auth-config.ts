/**
 * The Before User Created hook, expressed as state rather than as a sequence of calls.
 *
 * The decision "should we write to this project's Auth configuration, and what exactly
 * should we write?" is a pure function of the state observed remotely and the operator's
 * intent. It is implemented that way — {@link planHookChange} touches no network, no
 * clock and no database — because it is the part that must be exhaustively testable.
 * Every combination of `enabled` and `uri` has a defined verdict, and each one is
 * covered by a test.
 *
 * The governing rule, and the reason the table below is as conservative as it is:
 *
 * > **The hook slot holds exactly one URI.** Writing ours into an occupied slot does not
 * > add a policy, it silently replaces one — and the policy being replaced could be the
 * > only thing standing between that project and whatever it was written to stop.
 *
 * So a URI that is not ours is never overwritten, never cleared, and never disabled,
 * whether or not it is currently enabled. A disabled foreign hook is somebody's
 * deliberate configuration in a paused state, not an empty slot.
 */

import { describeHookUri } from '../lib/redact.js';
import { BEFORE_USER_CREATED_HOOK_URI } from './constants.js';
import type { AuthConfigDocument, ManagementClient } from './management-client.js';
import type {
  BeforeUserCreatedHookPatch,
  BeforeUserCreatedHookState,
  HookIntent,
  HookPlan,
} from './types.js';

/**
 * Reduces the raw document to the hook slot.
 *
 * `null`, `undefined` and `""` all mean "no URI configured": the API schema marks both
 * fields nullable, and a project that has never touched the hook may report any of the
 * three. Collapsing them here means no caller has to remember which one this particular
 * project happens to send.
 */
export function readHookState(document: AuthConfigDocument): BeforeUserCreatedHookState {
  const rawUri = document.hook_before_user_created_uri ?? undefined;
  const uri = rawUri === undefined || rawUri.trim() === '' ? undefined : rawUri.trim();

  return {
    enabled: document.hook_before_user_created_enabled === true,
    uri,
    configured: uri !== undefined,
    isOurs: uri === BEFORE_USER_CREATED_HOOK_URI,
  };
}

/** Fetches the project's Auth configuration and reduces it to the hook slot. */
export async function getBeforeUserCreatedHookState(
  client: ManagementClient,
  projectRef: string,
): Promise<BeforeUserCreatedHookState> {
  return readHookState(await client.getAuthConfig(projectRef));
}

/**
 * Decides what, if anything, to write. Pure.
 *
 * The complete state table, for both intents:
 *
 * | enabled | uri           | `enable`   | `disable`  |
 * | ------- | ------------- | ---------- | ---------- |
 * | false   | none          | change     | no-op      |
 * | false   | ours          | change     | no-op      |
 * | false   | someone_else  | **conflict** | **conflict** |
 * | true    | ours          | no-op      | change     |
 * | true    | someone_else  | **conflict** | **conflict** |
 * | true    | none          | change     | no-op      |
 *
 * Two rows deserve a note.
 *
 * `false + someone_else` → conflict rather than "the slot is free". A disabled foreign
 * hook is configuration somebody wrote down; taking the slot because it happens to be
 * switched off destroys their ability to switch it back on, and they would find out at
 * the worst possible moment.
 *
 * `true + none` → change, for `enable`. Auth reports the hook as on with nothing to
 * call, which is a broken configuration rather than a competing one; pointing it at our
 * function is the repair. For `disable` it is a no-op, because there is nothing of ours
 * to turn off and the empty slot is not ours to tidy.
 */
export function planHookChange(current: BeforeUserCreatedHookState, intent: HookIntent): HookPlan {
  if (current.configured && !current.isOurs) {
    return {
      action: 'conflict',
      intent,
      current,
      reason: `Before User Created is configured to a different hook (${describeHookUri(current.uri)}).`,
    };
  }

  if (intent === 'enable') {
    if (current.enabled && current.isOurs) {
      return {
        action: 'no-op',
        intent,
        current,
        reason: 'Before User Created is already enabled and points at the guard hook.',
      };
    }

    return {
      action: 'change',
      intent,
      current,
      patch: ENABLE_PATCH,
      reason: current.isOurs
        ? 'The guard hook is configured but disabled.'
        : 'Before User Created is not pointing at the guard hook.',
    };
  }

  if (!current.isOurs) {
    return {
      action: 'no-op',
      intent,
      current,
      reason: 'Before User Created is not configured to the guard hook; nothing to disable.',
    };
  }

  if (!current.enabled) {
    return {
      action: 'no-op',
      intent,
      current,
      reason: 'The guard hook is already disabled.',
    };
  }

  return {
    action: 'change',
    intent,
    current,
    patch: DISABLE_PATCH,
    reason: 'The guard hook is enabled and will be switched off.',
  };
}

/**
 * Enabling sends both fields.
 *
 * The URI is included even when it already matches, because `enabled = true` against a
 * slot whose URI we did not just assert would be trusting a value read some milliseconds
 * ago. Sending both makes the request state-setting rather than state-dependent.
 */
const ENABLE_PATCH: BeforeUserCreatedHookPatch = {
  hook_before_user_created_enabled: true,
  hook_before_user_created_uri: BEFORE_USER_CREATED_HOOK_URI,
};

/**
 * Disabling sends only the flag, and deliberately leaves the URI in place.
 *
 * The published `UpdateAuthConfigBody` schema makes every field optional, so omitting
 * the URI is supported and leaves it untouched — the least destructive change that
 * achieves the goal. It also keeps the configuration explicit: the project still records
 * which function the hook points at, `hook enable` can switch it back on without
 * re-deriving anything, and an operator reading the dashboard can see what was disabled
 * rather than an empty field that says nothing.
 *
 * Clearing the URI as well was considered and rejected: it discards information the
 * operator may want, and "turn it off" does not imply "forget what it was".
 */
const DISABLE_PATCH: BeforeUserCreatedHookPatch = {
  hook_before_user_created_enabled: false,
};

/**
 * Confirms the state read back after a write is the state that was requested.
 *
 * HTTP 200 means the request was accepted, not that the configuration now says what we
 * asked for. A partially applied update, a server-side normalisation, a competing change
 * from the dashboard, or a plan-tier rule that silently declines part of a patch would
 * all produce a successful response and a wrong project. The only proof is a fresh read.
 *
 * For `enable` the requirement is exact: enabled, pointing at our URI.
 *
 * For `disable` the requirement is that the hook is off, and that the slot has not
 * become somebody else's. The URI is allowed to be either ours (expected — we did not
 * ask for it to change) or empty (acceptable — the server chose to clear it), because
 * both mean the same thing operationally and hard-coding one would make this tool
 * brittle against a server-side behaviour it does not control.
 */
export function verifyHookState(state: BeforeUserCreatedHookState, intent: HookIntent): boolean {
  if (intent === 'enable') {
    return state.enabled && state.isOurs;
  }

  return !state.enabled && (state.isOurs || !state.configured);
}

export { BEFORE_USER_CREATED_HOOK_URI };
