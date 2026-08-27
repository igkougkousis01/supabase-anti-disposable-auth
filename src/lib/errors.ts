/**
 * Error architecture for the CLI.
 *
 * Every failure the user can reasonably cause is represented by an {@link AppError}
 * subclass carrying a friendly message, an optional hint and a stable exit code.
 * Anything else is a bug and is wrapped in {@link UnexpectedError}, which is the only
 * error kind allowed to print diagnostic details such as a stack trace.
 *
 * Error messages must never contain credentials. Use `describeConnectionTarget()`
 * from `lib/redact.ts` when referring to a database.
 */

import { inspect } from 'node:util';

export const EXIT_CODES = {
  success: 0,
  unexpected: 1,
  configuration: 2,
  database: 3,
  notImplemented: 4,
  /**
   * The database was reachable and answered, but the guard layer is absent or damaged.
   *
   * Kept distinct from `database` on purpose: a health verdict is not a failure to talk
   * to PostgreSQL, and a CI check needs to tell "I could not reach the database" apart
   * from "I reached it and the guard layer is not installed". Only `status` uses it.
   */
  guardHealth: 5,
  /**
   * Blocklist synchronisation failed.
   *
   * Distinct from `database` because the overwhelmingly likely cause is outside the
   * database entirely: an unreachable upstream, a truncated download, or a candidate
   * list that failed its safety checks. An operator seeing `3` should look at their
   * connection string; an operator seeing `6` should look at the provider. Conflating
   * them would send every sync failure to the wrong place.
   */
  sync: 6,
  /**
   * The Supabase Management API could not be used.
   *
   * Covers everything between "we asked" and "we have an answer we trust": a rejected
   * token, insufficient permissions, an unknown project ref, a rate limit, an outage, a
   * transport failure, or a response that does not match the documented contract.
   *
   * Distinct from `configuration` because the credentials were present and well formed
   * -- the remote end refused or could not answer -- and distinct from `database`
   * because PostgreSQL is not involved at all. An operator seeing `7` should look at
   * their token, their project ref, or Supabase's status page; never at their
   * connection string.
   */
  remote: 7,
  /**
   * Supabase Auth's Before User Created hook is configured, and points somewhere else.
   *
   * Not a failure of this tool and not a failure of the API: it is a decision only the
   * operator can make. Replacing an authentication policy that somebody deliberately
   * installed is exactly the kind of thing a CLI must never do on its own initiative,
   * so the command stops and hands the choice back.
   *
   * Its own code because the remediation is unique. Every other non-zero exit here
   * means "fix something and rerun"; this one means "decide whether the existing
   * configuration should survive", and a CI job should be able to route it to a human
   * rather than to a retry.
   */
  hookConflict: 8,
  /**
   * The remote configuration was written, and reading it back did not show the change.
   *
   * The single most dangerous state this tool can produce, and the reason it never
   * treats HTTP 200 as proof. Reaching it means a mutation was accepted and the
   * resulting configuration is not what was asked for, so nothing may be reported as
   * successful and the operator must inspect the project before trusting it.
   */
  hookVerification: 9,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export type ErrorKind = 'configuration' | 'database' | 'sync' | 'remote' | 'unexpected';

export interface AppErrorOptions {
  /** Original error, kept for diagnostics. Never rendered for expected failures. */
  cause?: unknown;
  /** Short, actionable next step shown to the user. */
  hint?: string;
}

export abstract class AppError extends Error {
  abstract readonly kind: ErrorKind;
  abstract readonly exitCode: ExitCode;
  readonly hint: string | undefined;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.hint = options.hint;
  }
}

/** The user's environment or configuration is wrong (missing/invalid variables). */
export class ConfigurationError extends AppError {
  readonly kind = 'configuration' as const;
  readonly exitCode = EXIT_CODES.configuration;
}

/** A database connection could not be established or could not be closed. */
export class DatabaseConnectionError extends AppError {
  readonly kind = 'database' as const;
  readonly exitCode = EXIT_CODES.database;
}

/** A statement failed against an otherwise healthy connection. */
export class DatabaseQueryError extends AppError {
  readonly kind = 'database' as const;
  readonly exitCode = EXIT_CODES.database;
}

/**
 * A migration could not be applied, or the migration set itself is inconsistent.
 *
 * Separate from {@link DatabaseQueryError} because the cause is usually the state of
 * the migration files rather than the statement that happened to fail: a renamed
 * file, an edited file that was already applied, or a partially applied run.
 */
export class MigrationError extends AppError {
  readonly kind = 'database' as const;
  readonly exitCode = EXIT_CODES.database;
}

/**
 * The upstream blocklist could not be downloaded.
 *
 * Covers everything between "we asked" and "we have bytes": DNS, TLS, timeouts, a
 * non-2xx status, an insecure redirect, an oversized body, or a wrong content type.
 * The upstream URL is public and safe to name; no credential is ever involved.
 */
export class BlocklistFetchError extends AppError {
  readonly kind = 'sync' as const;
  readonly exitCode = EXIT_CODES.sync;
}

/**
 * The payload arrived but is not a usable domain list.
 *
 * Binary-looking content, or a body that parses to nothing useful. Kept apart from
 * {@link SuspiciousUpdateError}: this one says "that is not a blocklist", the other
 * says "that is a blocklist, and I do not believe it".
 */
export class BlocklistValidationError extends AppError {
  readonly kind = 'sync' as const;
  readonly exitCode = EXIT_CODES.sync;
}

/**
 * A well-formed candidate list that failed a safety threshold.
 *
 * The installed blocklist is left exactly as it was. This is the error that stands
 * between a compromised or truncated upstream and production data.
 */
export class SuspiciousUpdateError extends AppError {
  readonly kind = 'sync' as const;
  readonly exitCode = EXIT_CODES.sync;
}

/** Synchronisation could not run or could not complete for any other reason. */
export class SyncError extends AppError {
  readonly kind = 'sync' as const;
  readonly exitCode = EXIT_CODES.sync;
}

/**
 * The database guard layer is absent or damaged, blocking an operation that needs it.
 *
 * Shares `status`'s health exit code because it is the same verdict reached the same
 * way, just acted on instead of merely reported. The `hook enable` preflight is its only
 * thrower: activating a fail-closed hook against a broken guard layer would reject every
 * signup on the project, so "the database says no" has to stop the command before a
 * single byte reaches the Management API.
 */
export class GuardHealthError extends AppError {
  readonly kind = 'database' as const;
  readonly exitCode = EXIT_CODES.guardHealth;
}

/**
 * The Supabase Management API refused, failed, or answered in a way we cannot trust.
 *
 * Messages built here are subject to one hard rule: **the access token never appears**.
 * It is not in the URL, so it cannot arrive through a URL echoed into a message; it is
 * not interpolated anywhere; and any server-supplied text is sanitised before it is
 * shown. See `sanitizeServerMessage()` in `src/supabase/management-client.ts`.
 */
export class SupabaseApiError extends AppError {
  readonly kind = 'remote' as const;
  readonly exitCode = EXIT_CODES.remote;
}

/**
 * The Before User Created hook is already configured, and not by us.
 *
 * Thrown instead of overwriting. The hook slot holds exactly one URI, so enabling ours
 * over somebody else's silently disables their policy -- which could be the only thing
 * standing between a project and whatever it was written to stop.
 */
export class AuthHookConflictError extends AppError {
  readonly kind = 'remote' as const;
  readonly exitCode = EXIT_CODES.hookConflict;
}

/**
 * A write was accepted but the state read back afterwards is not the state requested.
 *
 * Kept apart from {@link SupabaseApiError} because the two demand opposite responses. An
 * API error means nothing changed and the command can simply be rerun. This means
 * something may well have changed, into a state nobody chose, and rerunning blindly is
 * the wrong instinct -- the project's Auth configuration needs to be looked at.
 */
export class AuthHookVerificationError extends AppError {
  readonly kind = 'remote' as const;
  readonly exitCode = EXIT_CODES.hookVerification;
}

/** A bug, or an error we did not anticipate. Diagnostics are allowed here. */
export class UnexpectedError extends AppError {
  readonly kind = 'unexpected' as const;
  readonly exitCode = EXIT_CODES.unexpected;
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Normalises anything thrown into an {@link AppError} without losing the original. */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new UnexpectedError(`Unexpected error: ${message}`, { cause: error });
}

/**
 * Renders an error for the terminal.
 *
 * Expected failures get a message plus a hint. Diagnostic details are included only
 * for unexpected errors or when the user explicitly asked for them via `--debug`.
 */
export function formatErrorForUser(error: unknown, options: { debug?: boolean } = {}): string[] {
  const appError = toAppError(error);
  const lines = [appError.message];

  if (appError.hint) {
    lines.push(appError.hint);
  }

  if (options.debug === true || appError.kind === 'unexpected') {
    lines.push(...describeDiagnostics(appError));
  }

  return lines;
}

function describeDiagnostics(error: AppError): string[] {
  const lines: string[] = [];

  if (error.stack) {
    lines.push(error.stack);
  }

  const cause: unknown = error.cause;
  if (cause instanceof Error) {
    lines.push(`Caused by: ${cause.stack ?? `${cause.name}: ${cause.message}`}`);
  } else if (cause !== undefined) {
    lines.push(`Caused by: ${inspect(cause, { depth: 1 })}`);
  }

  return lines;
}
