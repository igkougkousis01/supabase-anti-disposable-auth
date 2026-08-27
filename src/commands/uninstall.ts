/** `uninstall` — safely reverse remote and database installation state. */

import type { Command } from 'commander';

import { loadConfig, requireDatabaseUrl, requireManagementCredentials } from '../config/env.js';
import { createPostgresConnection } from '../database/client.js';
import { inspectGuardLifecycle } from '../database/lifecycle.js';
import type { GuardLifecycleInspection } from '../database/lifecycle.js';
import { loadMigrationFiles } from '../database/migrations.js';
import type { MigrationFile } from '../database/migration-types.js';
import { readGuardSchemaStatus } from '../database/schema-status.js';
import type { GuardSchemaStatus } from '../database/schema-status.js';
import {
  dropStrictTrigger,
  readStrictModeStatus,
  readStrictTriggerState,
} from '../database/strict-trigger.js';
import type { StrictModeStatus, StrictTriggerState } from '../database/strict-trigger.js';
import type { DatabaseConnection, DatabaseConnectionConfig } from '../database/types.js';
import { dropGuardObjects } from '../database/uninstall.js';
import {
  AuthHookConflictError,
  EXIT_CODES,
  MigrationError,
  UninstallConflictError,
  UnexpectedError,
} from '../lib/errors.js';
import type { ExitCode } from '../lib/errors.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { Logger } from '../lib/logger.js';
import { CLI_NAME, PRODUCT_NAME } from '../lib/package-info.js';
import { describeHookUri } from '../lib/redact.js';
import { getBeforeUserCreatedHookState } from '../supabase/auth-config.js';
import { ManagementClient } from '../supabase/management-client.js';
import type { BeforeUserCreatedHookState } from '../supabase/types.js';
import { runHookDisable } from './hook.js';

export interface UninstallDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly connect: (config: DatabaseConnectionConfig) => Promise<DatabaseConnection>;
  readonly files?: MigrationFile[];
  readonly client?: ManagementClient;
}

export interface UninstallOptions {
  readonly dryRun?: boolean;
  readonly yes?: boolean;
  readonly databaseOnly?: boolean;
}

export type UninstallRemoteState =
  | { readonly kind: 'not-checked' }
  | {
      readonly kind: 'active' | 'inactive' | 'conflict';
      readonly state: BeforeUserCreatedHookState;
    };

export interface UninstallAssessmentInput {
  readonly lifecycle: GuardLifecycleInspection;
  readonly schema: GuardSchemaStatus;
  readonly strict: StrictModeStatus;
  readonly remote: UninstallRemoteState;
  readonly databaseOnly: boolean;
}

export type UninstallAssessmentState = 'ready' | 'already-uninstalled' | 'conflict';

export interface UninstallAssessment extends UninstallAssessmentInput {
  readonly state: UninstallAssessmentState;
  readonly conflicts: string[];
  readonly steps: string[];
}

export type UninstallResultState =
  'complete' | 'dry-run' | 'confirmation-required' | 'already-uninstalled' | 'conflict';

export interface UninstallReport {
  readonly target: string;
  readonly dryRun: boolean;
  readonly confirmed: boolean;
  readonly assessment: UninstallAssessment;
  readonly state: UninstallResultState;
  readonly strictRemoved: boolean;
  readonly remotePatched: boolean;
  readonly databaseRemoved: boolean;
}

export interface UninstallEvents {
  /** Called after every safety check and before any possible mutation. */
  readonly onPlan?: (assessment: UninstallAssessment, target: string) => void;
  readonly onStrictRemoved?: () => void;
  readonly onRemoteDisabled?: () => void;
  readonly onRemoteVerified?: () => void;
  readonly onDatabaseRemoved?: () => void;
}

/** Pure safety verdict used by dry-run and execution alike. */
export function planUninstall(input: UninstallAssessmentInput): UninstallAssessment {
  const { lifecycle, strict, remote, databaseOnly } = input;
  const conflicts: string[] = [];

  if (lifecycle.schemaPresent && !lifecycle.historyVerified) {
    conflicts.push(
      'guard.schema_migrations is missing, so ownership of the guard schema cannot be verified',
    );
  }
  conflicts.push(
    ...lifecycle.modifiedObjects,
    ...lifecycle.unexpectedObjects,
    ...lifecycle.ownerMismatches,
  );
  for (const dependency of lifecycle.externalDependencies) {
    conflicts.push(`external dependency: ${dependency}`);
  }
  if (strict.trigger.kind === 'conflict') {
    conflicts.push(`foreign strict trigger: ${strict.trigger.reasons.join('; ')}`);
  }
  if (remote.kind === 'conflict') {
    conflicts.push(
      `Before User Created points to another hook (${describeHookUri(remote.state.uri)})`,
    );
  }
  if (databaseOnly && remote.kind === 'active') {
    conflicts.push('database-only uninstall refused because the hosted hook is verified active');
  }

  if (conflicts.length > 0) {
    return { ...input, state: 'conflict', conflicts, steps: [] };
  }

  const steps: string[] = [];
  if (strict.trigger.kind === 'ours') {
    steps.push('disable the owned strict trigger on auth.users');
  }
  if (!databaseOnly) {
    steps.push('disable and verify the hosted Before User Created hook');
  }
  if (lifecycle.schemaPresent) {
    steps.push('remove verified guard functions, tables, data, metadata, and migration history');
    steps.push('drop the empty guard schema without CASCADE');
  }

  return {
    ...input,
    state: steps.length === 0 ? 'already-uninstalled' : 'ready',
    conflicts: [],
    steps,
  };
}

export async function runUninstall(
  dependencies: Partial<UninstallDependencies> = {},
  options: UninstallOptions = {},
  events: UninstallEvents = {},
): Promise<UninstallReport> {
  const env = dependencies.env ?? process.env;
  const connect = dependencies.connect ?? createPostgresConnection;
  const config = loadConfig(env);
  const databaseUrl = requireDatabaseUrl(config, 'uninstall');
  const databaseOnly = options.databaseOnly === true;
  const dryRun = options.dryRun === true;
  const confirmed = options.yes === true;
  const files = dependencies.files ?? (await loadMigrationFiles());

  // Full uninstall must be able to prove the remote slot before opening the path to
  // database deletion. Database-only is the explicit, separately documented escape.
  if (!databaseOnly) {
    requireManagementCredentials(config, 'uninstall');
  }

  const connection = await connect({ connectionString: databaseUrl });
  try {
    let input: UninstallAssessmentInput;
    try {
      input = await readUninstallInput(connection, files, dependencies, config, databaseOnly);
    } catch (error) {
      if (error instanceof MigrationError) {
        throw new UninstallConflictError(
          `Migration evidence could not be verified: ${error.message}`,
          {
            cause: error,
            hint: 'No strict, remote, or guard object was changed. Restore the original migration evidence before uninstalling.',
          },
        );
      }
      throw error;
    }

    const planned = planUninstall(input);
    events.onPlan?.(planned, connection.target);

    const base = {
      target: connection.target,
      dryRun,
      confirmed,
      assessment: planned,
      strictRemoved: false,
      remotePatched: false,
      databaseRemoved: false,
    };

    if (planned.state === 'conflict') {
      return { ...base, state: 'conflict' };
    }
    if (planned.state === 'already-uninstalled') {
      return { ...base, state: 'already-uninstalled' };
    }
    if (dryRun) {
      return { ...base, state: 'dry-run' };
    }
    if (!confirmed) {
      return { ...base, state: 'confirmation-required' };
    }

    let strictRemoved = false;
    const currentTrigger = await readStrictTriggerState(connection);
    assertStrictSafe(currentTrigger);
    if (currentTrigger.kind === 'ours') {
      await dropStrictTrigger(connection);
      const verified = await readStrictTriggerState(connection);
      if (verified.kind !== 'absent') {
        throw new UnexpectedError(
          'PostgreSQL accepted strict-trigger removal but the trigger is still present',
        );
      }
      strictRemoved = true;
      events.onStrictRemoved?.();
    }

    let remotePatched = false;
    if (!databaseOnly) {
      try {
        const remote = await runHookDisable(
          {
            env,
            connect,
            files,
            ...(dependencies.client === undefined ? {} : { client: dependencies.client }),
          },
          {},
        );
        remotePatched = remote.patched;
        if (remote.patched) {
          events.onRemoteDisabled?.();
        }
        events.onRemoteVerified?.();
      } catch (error) {
        if (error instanceof AuthHookConflictError) {
          throw new UninstallConflictError(error.message, {
            cause: error,
            hint: 'Strict mode may already be disabled, but the guard schema is intact. Resolve the remote hook conflict and rerun uninstall.',
          });
        }
        // Most importantly: database cleanup is below this point. A 401, timeout,
        // verification mismatch, or any other remote failure leaves guard intact.
        throw error;
      }
    }

    let databaseRemoved = false;
    const finalInspection = await inspectGuardLifecycle(connection, { files });
    assertCleanupOwnership(finalInspection);
    if (finalInspection.schemaPresent) {
      await dropGuardObjects(connection);
      const verified = await inspectGuardLifecycle(connection, { files });
      if (verified.schemaPresent) {
        throw new UnexpectedError(
          'Database cleanup completed but the guard schema is still present',
        );
      }
      databaseRemoved = true;
      events.onDatabaseRemoved?.();
    }

    return {
      ...base,
      state: 'complete',
      strictRemoved,
      remotePatched,
      databaseRemoved,
    };
  } finally {
    await connection.close().catch(() => undefined);
  }
}

async function readUninstallInput(
  connection: DatabaseConnection,
  files: MigrationFile[],
  dependencies: Partial<UninstallDependencies>,
  config: ReturnType<typeof loadConfig>,
  databaseOnly: boolean,
): Promise<UninstallAssessmentInput> {
  const lifecycle = await inspectGuardLifecycle(connection, { files });
  const schema = await readGuardSchemaStatus(connection, { files });
  const strict = await readStrictModeStatus(connection, {
    guardHealthy: schema.health === 'complete',
  });
  const remote = await readUninstallRemote(dependencies, config, databaseOnly);
  return { lifecycle, schema, strict, remote, databaseOnly };
}

async function readUninstallRemote(
  dependencies: Partial<UninstallDependencies>,
  config: ReturnType<typeof loadConfig>,
  databaseOnly: boolean,
): Promise<UninstallRemoteState> {
  const hasCredentials = config.projectRef !== undefined && config.accessToken !== undefined;
  if (databaseOnly && !hasCredentials && dependencies.client === undefined) {
    return { kind: 'not-checked' };
  }

  const credentials = requireManagementCredentials(config, 'uninstall');
  const client =
    dependencies.client ?? new ManagementClient({ accessToken: credentials.accessToken });
  const state = await getBeforeUserCreatedHookState(client, credentials.projectRef);
  if (state.configured && !state.isOurs) {
    return { kind: 'conflict', state };
  }
  return { kind: state.enabled && state.isOurs ? 'active' : 'inactive', state };
}

function assertStrictSafe(trigger: StrictTriggerState): void {
  if (trigger.kind !== 'conflict') {
    return;
  }
  throw new UninstallConflictError(
    `The strict trigger changed after preflight and is no longer owned: ${trigger.reasons.join('; ')}`,
    { hint: 'No remote or guard database object was changed.' },
  );
}

function assertCleanupOwnership(inspection: GuardLifecycleInspection): void {
  if (!inspection.schemaPresent) {
    return;
  }
  const conflicts: string[] = [];
  if (!inspection.historyVerified) {
    conflicts.push('migration history is missing');
  }
  conflicts.push(
    ...inspection.modifiedObjects,
    ...inspection.unexpectedObjects,
    ...inspection.ownerMismatches,
    ...inspection.externalDependencies.map((dependency) => `external dependency: ${dependency}`),
  );
  if (conflicts.length > 0) {
    throw new UninstallConflictError(
      `Guard ownership changed after preflight: ${conflicts.join('; ')}`,
      {
        hint: 'The remote hook may already be disabled, but no guard object was removed. Resolve the conflict and rerun uninstall.',
      },
    );
  }
}

export function printUninstallPlan(
  assessment: UninstallAssessment,
  target: string,
  options: { dryRun: boolean },
  logger: Logger = defaultLogger,
): void {
  logger.plain(PRODUCT_NAME);
  logger.blank();
  if (options.dryRun) {
    logger.plain('Dry run');
    logger.blank();
  }

  if (assessment.state === 'conflict') {
    logger.error('Uninstall refused because conflicts were found:');
    for (const conflict of assessment.conflicts) {
      logger.plain(`- ${conflict}`);
    }
    logger.blank();
    logger.plain('No strict, remote, or guard database changes made.');
    return;
  }

  if (assessment.state === 'already-uninstalled') {
    logger.success(`Guard database objects already absent (${target})`);
    if (!assessment.databaseOnly) {
      logger.success('Hosted Before User Created hook verified inactive');
    }
    return;
  }

  logger.error('WARNING: destructive operation');
  if (assessment.databaseOnly) {
    logger.warning('DATABASE ONLY: hosted Supabase Auth configuration will not be changed.');
    if (assessment.remote.kind === 'not-checked') {
      logger.warning(
        'Remote hook state is unknown. Deleting the function may break hosted signups.',
      );
    }
  }
  logger.blank();
  logger.plain('This will:');
  for (const step of assessment.steps) {
    logger.plain(`- ${step}`);
  }
  if (assessment.lifecycle.schemaPresent) {
    logger.blank();
    logger.plain('This will permanently remove:');
    logger.plain(`- ${formatCount(assessment.schema.blockedDomainCount)} blocked-domain entries`);
    logger.plain(`- ${formatCount(assessment.schema.allowedDomainCount)} allowlist entries`);
    logger.plain('- sync metadata');
    logger.plain('- append-only migration history');
    logger.plain('- owned guard functions and schema');
  }
}

export function printUninstallResult(
  report: UninstallReport,
  logger: Logger = defaultLogger,
): void {
  if (report.assessment.state === 'conflict' || report.assessment.state === 'already-uninstalled') {
    return;
  }
  logger.blank();
  switch (report.state) {
    case 'dry-run':
      logger.plain('No remote PATCH or database DDL executed.');
      return;
    case 'confirmation-required':
      logger.error('Destructive confirmation required.');
      logger.plain(`Run \`${CLI_NAME} uninstall --yes\` to execute this plan.`);
      return;
    case 'complete':
      if (report.strictRemoved) {
        logger.success('Strict trigger removed');
      } else {
        logger.success('Strict trigger already absent');
      }
      if (!report.assessment.databaseOnly) {
        logger.success(
          report.remotePatched
            ? 'Hosted Before User Created hook disabled and verified'
            : 'Hosted Before User Created hook already disabled and verified',
        );
      }
      logger.success(
        report.databaseRemoved
          ? 'Guard database objects removed'
          : 'Guard database objects already absent',
      );
      logger.blank();
      logger.plain('Uninstall complete.');
      return;
    case 'conflict':
    case 'already-uninstalled':
      return;
  }
}

function formatCount(value: number | undefined): string {
  return value === undefined ? 'unknown number of' : value.toLocaleString('en-US');
}

export function uninstallExitCode(report: UninstallReport): ExitCode {
  switch (report.state) {
    case 'conflict':
      return EXIT_CODES.uninstallConflict;
    case 'confirmation-required':
      return EXIT_CODES.confirmationRequired;
    case 'complete':
    case 'dry-run':
    case 'already-uninstalled':
      return EXIT_CODES.success;
  }
}

export function registerUninstallCommand(
  program: Command,
  logger: Logger = defaultLogger,
  dependencies: Partial<UninstallDependencies> = {},
): Command {
  return program
    .command('uninstall')
    .description('Safely disable integrations and remove verified guard-owned database objects.')
    .option('--dry-run', 'Show the complete ordered plan; send no PATCH and execute no DDL.', false)
    .option('--yes', 'Confirm permanent removal. Does not bypass any safety check.', false)
    .option(
      '--database-only',
      'DANGEROUS: remove database objects without changing hosted Supabase Auth configuration.',
      false,
    )
    .action(async (options: UninstallOptions) => {
      let planPrinted = false;
      const report = await runUninstall(dependencies, options, {
        onPlan: (assessment, target) => {
          printUninstallPlan(assessment, target, { dryRun: options.dryRun === true }, logger);
          planPrinted = true;
        },
      });
      if (!planPrinted) {
        printUninstallPlan(report.assessment, report.target, { dryRun: report.dryRun }, logger);
      }
      printUninstallResult(report, logger);
      process.exitCode = uninstallExitCode(report);
    });
}
