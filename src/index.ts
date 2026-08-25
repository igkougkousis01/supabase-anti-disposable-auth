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
  isSupportedNodeVersion,
  loadConfig,
  loadEnvFileIfPresent,
  KNOWN_ENVIRONMENT_VARIABLES,
  MINIMUM_NODE_VERSION,
  MINIMUM_NODE_VERSION_LABEL,
} from './config/env.js';
export type { AppConfig, NodeVersionRequirement } from './config/types.js';
export { createPostgresConnection, PostgresClient, readServerVersion } from './database/client.js';
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
