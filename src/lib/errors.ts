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
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export type ErrorKind = 'configuration' | 'database' | 'unexpected';

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
