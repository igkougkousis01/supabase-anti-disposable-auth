/**
 * Public API.
 *
 * This package is a CLI. The programmatic surface is deliberately small: everything
 * exported here becomes a compatibility promise at 1.0, and a promise made over a
 * module that exists only because the CLI needed it somewhere is a promise that will be
 * broken. Internal modules stay internal, so they remain free to change.
 *
 * What is here, and why each earns its place:
 *
 *  - `run` / `buildProgram` — embedding the CLI in another Node process, or inspecting
 *    the command tree, without shelling out.
 *  - `EXIT_CODES` and the error classes — the CLI's actual contract with a caller.
 *    A wrapper that maps outcomes to its own behaviour needs the numbers by name
 *    rather than by literal, and needs to tell a conflict from a failure.
 *  - `getPackageVersion` / `CLI_NAME` / `PRODUCT_NAME` / `PRODUCT_DESCRIPTION` — so a
 *    caller can report which version it is driving.
 *
 * Everything else — the database layer, the blocklist pipeline, the Management API
 * client, the command implementations — is reachable from source for contributors and
 * is exercised directly by the test suite. It is not part of the published API, and
 * importing it through a deep path is not supported.
 *
 * Adding to this list is easy later. Removing from it is a breaking change, so the
 * 1.0 surface starts at the smallest set that is genuinely useful.
 */

export { buildProgram, run } from './cli.js';
export {
  AppError,
  AuthHookConflictError,
  AuthHookVerificationError,
  BlocklistFetchError,
  BlocklistValidationError,
  ConfigurationError,
  ConfirmationRequiredError,
  DatabaseConnectionError,
  DatabaseQueryError,
  EXIT_CODES,
  formatErrorForUser,
  GuardHealthError,
  isAppError,
  MigrationError,
  RepairConflictError,
  StrictTriggerConflictError,
  SupabaseApiError,
  SuspiciousUpdateError,
  SyncError,
  toAppError,
  UnexpectedError,
  UninstallConflictError,
  type ErrorKind,
  type ExitCode,
} from './lib/errors.js';
export { createLogger, type Logger, type LogLevel } from './lib/logger.js';
export {
  CLI_NAME,
  getPackageVersion,
  PRODUCT_DESCRIPTION,
  PRODUCT_NAME,
} from './lib/package-info.js';
