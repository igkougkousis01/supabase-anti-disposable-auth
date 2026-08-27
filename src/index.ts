/**
 * Public API.
 *
 * The package is primarily a CLI; these exports exist so the pieces can be reused
 * (and tested) programmatically as the tool grows.
 */

export { buildProgram, run } from './cli.js';
export {
  canonicalizeDomains,
  canonicalRepresentation,
  checksumDomains,
  shortChecksum,
} from './blocklist/checksum.js';
export {
  fetchText,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  type FetchTextOptions,
  type FetchTextResult,
} from './blocklist/fetch.js';
export {
  normalizeDomain,
  normalizeProviderDomain,
  MAX_NORMALIZE_INPUT_LENGTH,
} from './blocklist/normalize.js';
export { parseDomainList, type ParsedBlocklist } from './blocklist/parse.js';
export { getProvider, DEFAULT_PROVIDER_NAME, PROVIDERS } from './blocklist/provider.js';
export {
  disposableEmailDomainsProvider,
  DISPOSABLE_EMAIL_DOMAINS_SOURCE,
} from './blocklist/providers/disposable-email-domains.js';
export {
  acquireSyncLock,
  readInstalledBlocklist,
  readInstalledDomains,
  recordSyncFailure,
  recordSyncNoOp,
  recordSyncSuccess,
  releaseSyncLock,
  replaceBlocklist,
  type InstalledBlocklist,
  type ReplaceBlocklistOptions,
  type ReplaceBlocklistResult,
  type SyncMetadataRecord,
} from './blocklist/repository.js';
export {
  assertCandidateIsSafe,
  evaluateCandidateSafety,
  DEFAULT_SAFETY_THRESHOLDS,
  type SafetyInput,
  type SafetyThresholds,
  type SafetyVerdict,
} from './blocklist/safety.js';
export {
  runSync,
  type SyncDependencies,
  type SyncEvents,
  type SyncOptions,
  type SyncOutcome,
  type SyncReport,
} from './blocklist/sync.js';
export type { BlocklistProvider, ProviderFetchOptions, RawBlocklist } from './blocklist/types.js';
export {
  isDomainShapedEntry,
  isValidDomain,
  MAX_DOMAIN_LENGTH,
  MAX_LABEL_LENGTH,
} from './blocklist/validate.js';
export { printSyncReport } from './commands/sync.js';
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
  hookStatusExitCode,
  printHookMutationReport,
  printHookStatusReport,
  runDatabasePreflight,
  runHookDisable,
  runHookEnable,
  runHookStatus,
  type HookCommandOptions,
  type HookDependencies,
  type HookEvents,
  type HookMutationReport,
  type HookPreflightReport,
  type HookStatusReport,
} from './commands/hook.js';
export {
  printStatusReport,
  runStatus,
  statusExitCode,
  type RemoteActivation,
  type StatusDependencies,
  type StatusReport,
} from './commands/status.js';
export {
  isSupportedNodeVersion,
  loadConfig,
  loadEnvFileIfPresent,
  requireDatabaseUrl,
  requireManagementCredentials,
  KNOWN_ENVIRONMENT_VARIABLES,
  MINIMUM_NODE_VERSION,
  MINIMUM_NODE_VERSION_LABEL,
} from './config/env.js';
export type { AppConfig, ManagementCredentials, NodeVersionRequirement } from './config/types.js';
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
export { inTransaction } from './database/transaction.js';
export type {
  DatabaseConnection,
  DatabaseConnectionConfig,
  QueryResult,
  ServerVersion,
  SqlParameter,
} from './database/types.js';
export {
  AppError,
  AuthHookConflictError,
  AuthHookVerificationError,
  BlocklistFetchError,
  BlocklistValidationError,
  ConfigurationError,
  DatabaseConnectionError,
  DatabaseQueryError,
  EXIT_CODES,
  formatErrorForUser,
  GuardHealthError,
  isAppError,
  MigrationError,
  SupabaseApiError,
  SuspiciousUpdateError,
  SyncError,
  toAppError,
  UnexpectedError,
  type ErrorKind,
  type ExitCode,
} from './lib/errors.js';
export { createLogger, logger, type Logger, type LogLevel } from './lib/logger.js';
export { describeConnectionTarget, describeHookUri, sanitizeForDisplay } from './lib/redact.js';
export {
  getBeforeUserCreatedHookState,
  planHookChange,
  readHookState,
  verifyHookState,
} from './supabase/auth-config.js';
export {
  ACCEPTED_CONTENT_TYPES,
  AUTH_CONFIG_PATH_SEGMENTS,
  BEFORE_USER_CREATED_HOOK_URI,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MANAGEMENT_API_BASE_URL,
  MAX_SERVER_MESSAGE_LENGTH,
  PROJECT_REF_LENGTH,
  PROJECT_REF_PATTERN,
} from './supabase/constants.js';
export {
  ManagementClient,
  type AuthConfigDocument,
  type ManagementClientOptions,
} from './supabase/management-client.js';
export type {
  BeforeUserCreatedHookPatch,
  BeforeUserCreatedHookState,
  HookIntent,
  HookPlan,
  HookPlanAction,
} from './supabase/types.js';
export {
  CLI_NAME,
  getPackageVersion,
  PRODUCT_DESCRIPTION,
  PRODUCT_NAME,
} from './lib/package-info.js';
