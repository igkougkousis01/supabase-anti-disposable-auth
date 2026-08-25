/**
 * Public API.
 *
 * The package is primarily a CLI; these exports exist so the pieces can be reused
 * (and tested) programmatically as the tool grows.
 */

export { buildProgram, run } from './cli.js';
export {
  printDoctorReport,
  runDoctor,
  type DoctorCheck,
  type DoctorCheckStatus,
  type DoctorDependencies,
  type DoctorReport,
} from './commands/doctor.js';
export {
  printInstallSummary,
  runInstall,
  type InstallDependencies,
  type InstallEvents,
  type InstallReport,
} from './commands/install.js';
export {
  printStatusReport,
  runStatus,
  statusExitCode,
  type StatusDependencies,
  type StatusReport,
} from './commands/status.js';
export {
  isSupportedNodeVersion,
  loadConfig,
  loadEnvFileIfPresent,
  KNOWN_ENVIRONMENT_VARIABLES,
  MINIMUM_NODE_VERSION,
  MINIMUM_NODE_VERSION_LABEL,
} from './config/env.js';
export type { AppConfig, NodeVersionRequirement } from './config/types.js';
export { createPostgresConnection, PostgresClient, readServerVersion } from './database/client.js';
export {
  calculateChecksum,
  ensureMigrationInfrastructure,
  loadMigrationFiles,
  parseMigrationFileName,
  planMigrations,
  readAppliedMigrations,
  resolveMigrationsDirectory,
  runMigrations,
  GUARD_SCHEMA,
  MIGRATIONS_DIRECTORY_NAME,
  MIGRATIONS_TABLE,
  type RunMigrationsOptions,
} from './database/migrations.js';
export type {
  AppliedMigration,
  MigrationFile,
  MigrationPlan,
  MigrationPlanEntry,
  MigrationRunResult,
  MigrationState,
} from './database/migration-types.js';
export { readGuardSchemaStatus, type GuardSchemaStatus } from './database/schema-status.js';
export type {
  DatabaseConnection,
  DatabaseConnectionConfig,
  QueryResult,
  ServerVersion,
  SqlParameter,
} from './database/types.js';
export {
  AppError,
  ConfigurationError,
  DatabaseConnectionError,
  DatabaseQueryError,
  EXIT_CODES,
  formatErrorForUser,
  isAppError,
  MigrationError,
  toAppError,
  UnexpectedError,
  type ErrorKind,
  type ExitCode,
} from './lib/errors.js';
export { createLogger, logger, type Logger, type LogLevel } from './lib/logger.js';
export { describeConnectionTarget } from './lib/redact.js';
export {
  CLI_NAME,
  getPackageVersion,
  PRODUCT_DESCRIPTION,
  PRODUCT_NAME,
} from './lib/package-info.js';
