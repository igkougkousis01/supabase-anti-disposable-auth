/**
 * Types describing the slice of Supabase Auth configuration this tool manages.
 *
 * Deliberately narrow. The Auth configuration document has some two hundred fields
 * covering SMTP credentials, OAuth secrets, CAPTCHA keys and SMS provider tokens. This
 * tool has no business modelling any of them: it reads two, writes two, and treats the
 * rest as none of its concern. A type that mirrored the whole document would be an
 * invitation to send the whole document back.
 */

/**
 * The Before User Created hook slot, as the remote project currently reports it.
 *
 * Both fields are nullable in the published API schema, and a project that has never
 * configured the hook may report either `null` or an empty string. Callers must not
 * distinguish those: use {@link BeforeUserCreatedHookState.configured}.
 */
export interface BeforeUserCreatedHookState {
  /** Whether Supabase Auth is currently calling the configured hook. */
  readonly enabled: boolean;
  /** The configured URI, or `undefined` when the slot is empty. */
  readonly uri: string | undefined;
  /** True when a URI is present, whether or not the hook is enabled. */
  readonly configured: boolean;
  /** True when the configured URI is exactly the one this tool installs. */
  readonly isOurs: boolean;
}

/** The two fields this tool ever sends in a PATCH body. */
export interface BeforeUserCreatedHookPatch {
  readonly hook_before_user_created_enabled: boolean;
  readonly hook_before_user_created_uri?: string;
}

/** What a hook command intends to do. */
export type HookIntent = 'enable' | 'disable';

/**
 * The verdict of the activation state machine.
 *
 *  - `no-op`    — the remote state already matches the intent. Success, no PATCH.
 *  - `change`   — a PATCH is required, and the patch body says exactly what it is.
 *  - `conflict` — the slot belongs to somebody else. Refuse, and change nothing.
 */
export type HookPlanAction = 'no-op' | 'change' | 'conflict';

export interface HookPlan {
  readonly action: HookPlanAction;
  readonly intent: HookIntent;
  /** State observed remotely, before anything was changed. */
  readonly current: BeforeUserCreatedHookState;
  /** Present only when `action` is `change`. Exactly the fields to send. */
  readonly patch?: BeforeUserCreatedHookPatch;
  /** A short, printable explanation of why this verdict was reached. */
  readonly reason: string;
}
