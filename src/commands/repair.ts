/** `repair` — restore known-safe database drift without changing operator intent. */

import type { Command } from 'commander';

import { loadConfig, requireDatabaseUrl } from '../config/env.js';
import { createPostgresConnection } from '../database/client.js';
import {
  CORE_DATA_TABLES,
  inspectGuardLifecycle,
  REPAIRABLE_LEAF_FUNCTIONS,
} from '../database/lifecycle.js';
import type { GuardLifecycleInspection } from '../database/lifecycle.js';
import { loadMigrationFiles } from '../database/migrations.js';
import type { MigrationFile } from '../database/migration-types.js';
import { applyDatabaseRepair } from '../database/repair.js';
import type { DatabaseRepairChange } from '../database/repair.js';
import { inspectAuthHookGrants, readGuardSchemaStatus } from '../database/schema-status.js';
import type { AuthHookGrantInspection, GuardSchemaStatus } from '../database/schema-status.js';
import { readStrictModeStatus } from '../database/strict-trigger.js';
import type { StrictModeStatus } from '../database/strict-trigger.js';
import type { DatabaseConnection, DatabaseConnectionConfig } from '../database/types.js';
import {
  EXIT_CODES,
  MigrationError,
  RepairConflictError,
  toAppError,
  UnexpectedError,
} from '../lib/errors.js';
import type { AppError, ExitCode } from '../lib/errors.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { Logger } from '../lib/logger.js';
import { CLI_NAME, PRODUCT_NAME } from '../lib/package-info.js';
import { describeHookUri } from '../lib/redact.js';
import { getBeforeUserCreatedHookState } from '../supabase/auth-config.js';
import { ManagementClient } from '../supabase/management-client.js';
import type { BeforeUserCreatedHookState } from '../supabase/types.js';

export type RepairState =
  'healthy' | 'repairable' | 'manual-action-required' | 'conflict' | 'not-installed';

export type RepairRemoteState =
  | { readonly kind: 'not-checked' }
  | {
      readonly kind: 'active' | 'inactive' | 'conflict';
      readonly state: BeforeUserCreatedHookState;
    }
  | { readonly kind: 'failed'; readonly error: AppError };

export interface RepairDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly connect: (config: DatabaseConnectionConfig) => Promise<DatabaseConnection>;
  readonly files?: MigrationFile[];
  readonly client?: ManagementClient;
}

export interface RepairOptions {
  readonly dryRun?: boolean;
}

export interface RepairAssessmentInput {
  readonly lifecycle: GuardLifecycleInspection;
  readonly schema: GuardSchemaStatus;
  readonly grants: AuthHookGrantInspection;
  readonly strict: StrictModeStatus;
  readonly remote: RepairRemoteState;
}

export interface RepairAssessment {
  readonly state: RepairState;
  readonly changes: DatabaseRepairChange[];
  readonly reasons: string[];
}

export interface RepairReport extends RepairAssessmentInput {
  readonly target: string;
  readonly dryRun: boolean;
  readonly assessment: RepairAssessment;
  readonly changed: boolean;
  readonly finalState: RepairState;
}

/** Pure state machine: every mutation admitted here is fixed and independently tested. */
export function planRepair(input: RepairAssessmentInput): RepairAssessment {
  const { lifecycle, schema, grants, strict, remote } = input;

  if (!lifecycle.schemaPresent || schema.health === 'not-installed') {
    return assessment('not-installed', [], ['The guard schema is not installed.']);
  }

  const conflicts: string[] = [];
  if (!lifecycle.historyVerified) {
    conflicts.push('guard.schema_migrations is missing, so ownership cannot be verified');
  }
  conflicts.push(
    ...lifecycle.modifiedObjects,
    ...lifecycle.unexpectedObjects,
    ...lifecycle.ownerMismatches,
  );
  if (strict.trigger.kind === 'conflict') {
    conflicts.push(
      `the fixed strict trigger name is conflicting: ${strict.trigger.reasons.join('; ')}`,
    );
  }
  if (remote.kind === 'conflict') {
    conflicts.push(
      `Before User Created points to another hook (${describeHookUri(remote.state.uri)})`,
    );
  }
  if (conflicts.length > 0) {
    return assessment('conflict', [], conflicts);
  }

  const manual: string[] = [];
  const missingCore = lifecycle.missingTables.filter((table) =>
    CORE_DATA_TABLES.includes(table as (typeof CORE_DATA_TABLES)[number]),
  );
  if (missingCore.length > 0) {
    manual.push(
      `Core guard data objects are missing: ${missingCore.join(', ')}. Data loss may have occurred.`,
    );
  }
  const otherMissingTables = lifecycle.missingTables.filter(
    (table) => !missingCore.includes(table),
  );
  if (otherMissingTables.length > 0) {
    manual.push(`Required tables are missing: ${otherMissingTables.join(', ')}`);
  }
  if (lifecycle.pendingVersions.length > 0) {
    manual.push(
      `Migrations are pending (${lifecycle.pendingVersions.join(', ')}); use the ${CLI_NAME} install command to apply them.`,
    );
  }
  const nonRepairableFunctions = lifecycle.missingFunctions.filter(
    (fn) => !REPAIRABLE_LEAF_FUNCTIONS.includes(fn as (typeof REPAIRABLE_LEAF_FUNCTIONS)[number]),
  );
  if (nonRepairableFunctions.length > 0) {
    manual.push(`Core policy functions are missing: ${nonRepairableFunctions.join(', ')}`);
  }
  if (!grants.rolePresent) {
    manual.push(
      'supabase_auth_admin does not exist; the Auth Hook grant set cannot be verified or restored',
    );
  }
  if (remote.kind === 'failed') {
    manual.push(`Remote hook inspection failed: ${remote.error.message}`);
  }
  if (manual.length > 0) {
    return assessment('manual-action-required', [], manual);
  }

  const changes: DatabaseRepairChange[] = [];
  if (lifecycle.missingFunctions.includes('guard.before_user_created(jsonb)')) {
    changes.push({
      kind: 'restore-before-user-created-function',
      description: 'recreate guard.before_user_created(jsonb) from its verified definition',
    });
  }
  if (lifecycle.missingFunctions.includes('guard.enforce_auth_user_email()')) {
    changes.push({
      kind: 'restore-strict-trigger-function',
      description: 'recreate guard.enforce_auth_user_email() from its verified definition',
    });
  }
  if (grants.missing.length > 0) {
    changes.push({
      kind: 'restore-auth-hook-grants',
      description: `restore least-privilege grants: ${grants.missing.join(', ')}`,
    });
  }

  return changes.length === 0
    ? assessment('healthy', [], [])
    : assessment('repairable', changes, []);
}

function assessment(
  state: RepairState,
  changes: DatabaseRepairChange[],
  reasons: string[],
): RepairAssessment {
  return { state, changes, reasons };
}

export async function runRepair(
  dependencies: Partial<RepairDependencies> = {},
  options: RepairOptions = {},
): Promise<RepairReport> {
  const env = dependencies.env ?? process.env;
  const connect = dependencies.connect ?? createPostgresConnection;
  const config = loadConfig(env);
  const databaseUrl = requireDatabaseUrl(config, 'repair');
  const files = dependencies.files ?? (await loadMigrationFiles());
  const connection = await connect({ connectionString: databaseUrl });
  const dryRun = options.dryRun === true;

  try {
    let input: RepairAssessmentInput;
    try {
      input = await readAssessmentInput(
        connection,
        files,
        dependencies,
        config.projectRef,
        config.accessToken,
      );
    } catch (error) {
      if (error instanceof MigrationError) {
        throw new RepairConflictError(
          `Migration evidence could not be verified: ${error.message}`,
          {
            cause: error,
            hint: 'Repair will not change the database while its append-only migration record is inconsistent.',
          },
        );
      }
      throw error;
    }

    const planned = planRepair(input);
    if (planned.state !== 'repairable' || dryRun) {
      return {
        ...input,
        target: connection.target,
        dryRun,
        assessment: planned,
        changed: false,
        finalState: planned.state,
      };
    }

    await applyDatabaseRepair(connection, files, planned.changes);
    const verifiedInput = await readAssessmentInput(
      connection,
      files,
      dependencies,
      config.projectRef,
      config.accessToken,
      // Repair never writes remote state. Reuse the proven result instead of adding a
      // second network failure after the database transaction has committed.
      input.remote,
    );
    const verified = planRepair(verifiedInput);
    if (verified.state !== 'healthy') {
      throw new UnexpectedError(
        `Repair DDL completed but verification returned ${verified.state}`,
        {
          hint: 'Do not assume the guard layer is healthy. Run `supabase-anti-disposable-auth repair --dry-run` and inspect the remaining state.',
        },
      );
    }

    return {
      ...verifiedInput,
      target: connection.target,
      dryRun,
      assessment: planned,
      changed: true,
      finalState: verified.state,
    };
  } finally {
    await connection.close().catch(() => undefined);
  }
}

async function readAssessmentInput(
  connection: DatabaseConnection,
  files: MigrationFile[],
  dependencies: Partial<RepairDependencies>,
  projectRef: string | undefined,
  accessToken: string | undefined,
  knownRemote?: RepairRemoteState,
): Promise<RepairAssessmentInput> {
  const lifecycle = await inspectGuardLifecycle(connection, { files });
  const schema = await readGuardSchemaStatus(connection, { files });
  const grants = await inspectAuthHookGrants(connection);
  const strict = await readStrictModeStatus(connection, {
    guardHealthy: schema.health === 'complete',
  });
  const remote = knownRemote ?? (await readRepairRemote(dependencies, projectRef, accessToken));
  return { lifecycle, schema, grants, strict, remote };
}

async function readRepairRemote(
  dependencies: Partial<RepairDependencies>,
  projectRef: string | undefined,
  accessToken: string | undefined,
): Promise<RepairRemoteState> {
  if (
    projectRef === undefined ||
    (accessToken === undefined && dependencies.client === undefined)
  ) {
    return { kind: 'not-checked' };
  }
  const client = dependencies.client ?? new ManagementClient({ accessToken: accessToken ?? '' });
  try {
    const state = await getBeforeUserCreatedHookState(client, projectRef);
    if (state.configured && !state.isOurs) {
      return { kind: 'conflict', state };
    }
    return { kind: state.enabled && state.isOurs ? 'active' : 'inactive', state };
  } catch (error) {
    return { kind: 'failed', error: toAppError(error) };
  }
}

export function printRepairReport(report: RepairReport, logger: Logger = defaultLogger): void {
  logger.plain(PRODUCT_NAME);
  logger.blank();
  if (report.dryRun) {
    logger.plain('Dry run');
    logger.blank();
  }
  logger.plain('Repair assessment');
  if (!report.lifecycle.schemaPresent) {
    logger.error(`Guard schema not found (${report.target})`);
    logger.blank();
    logger.error('Automatic repair cannot run:');
    for (const reason of report.assessment.reasons) {
      logger.plain(`- ${reason}`);
    }
    logger.plain('No database or remote changes made.');
    return;
  }

  logger.success(`Guard schema found (${report.target})`);

  if (report.lifecycle.missingTables.length === 0) {
    logger.success('Core tables intact');
  } else {
    logger.error(`Missing tables: ${report.lifecycle.missingTables.join(', ')}`);
  }
  if (report.lifecycle.missingFunctions.length === 0) {
    logger.success('Guard functions intact');
  } else {
    logger.error(`Missing functions: ${report.lifecycle.missingFunctions.join(', ')}`);
  }

  if (report.grants.rolePresent) {
    if (report.grants.missing.length === 0) {
      logger.success('supabase_auth_admin grants complete');
    } else {
      logger.error(`supabase_auth_admin grants incomplete: ${report.grants.missing.join(', ')}`);
    }
  } else {
    logger.error('supabase_auth_admin role absent');
  }

  printRepairIntentState(report, logger);
  logger.blank();

  if (report.assessment.state === 'repairable') {
    logger.plain('Repairable changes:');
    for (const change of report.assessment.changes) {
      logger.plain(`- ${change.description}`);
    }
    logger.blank();
    if (report.dryRun) {
      logger.plain('No database or remote changes made.');
    } else if (report.changed && report.finalState === 'healthy') {
      logger.success('Hook database layer healthy');
      logger.blank();
      logger.plain('Repair complete.');
    }
    return;
  }

  if (report.assessment.state === 'healthy') {
    logger.success('Installation is healthy; no repair needed.');
    return;
  }

  const heading =
    report.assessment.state === 'conflict'
      ? 'Automatic repair refused because conflicts were found:'
      : report.assessment.state === 'not-installed'
        ? 'Automatic repair cannot run:'
        : 'Manual action required:';
  logger.error(heading);
  for (const reason of report.assessment.reasons) {
    logger.plain(`- ${reason}`);
  }
  logger.plain('No database or remote changes made.');
}

function printRepairIntentState(report: RepairReport, logger: Logger): void {
  switch (report.remote.kind) {
    case 'active':
      logger.success('Remote hook active (left active)');
      break;
    case 'inactive':
      logger.pending('Remote hook disabled (left disabled)');
      break;
    case 'conflict':
      logger.error(`Remote hook conflict: ${describeHookUri(report.remote.state.uri)}`);
      break;
    case 'failed':
      logger.error(`Remote hook check failed: ${report.remote.error.message}`);
      break;
    case 'not-checked':
      logger.pending('Remote hook not checked (credentials unavailable)');
      break;
  }

  if (report.strict.trigger.kind === 'absent') {
    logger.pending(
      `Strict mode disabled (left disabled; use ${CLI_NAME} strict enable if desired)`,
    );
  } else if (report.strict.trigger.kind === 'ours') {
    logger.success('Strict trigger present (intent preserved)');
  } else {
    logger.error('Strict trigger conflict');
  }
}

export function repairExitCode(report: RepairReport): ExitCode {
  switch (report.finalState) {
    case 'healthy':
    case 'repairable':
      return EXIT_CODES.success;
    case 'conflict':
      return EXIT_CODES.repairConflict;
    case 'manual-action-required':
    case 'not-installed':
      return EXIT_CODES.guardHealth;
  }
}

export function registerRepairCommand(
  program: Command,
  logger: Logger = defaultLogger,
  dependencies: Partial<RepairDependencies> = {},
): Command {
  return program
    .command('repair')
    .description('Inspect and restore only known-safe drift in an installed guard layer.')
    .option('--dry-run', 'Show the exact repair plan and make no changes.', false)
    .action(async (options: RepairOptions) => {
      const report = await runRepair(dependencies, options);
      printRepairReport(report, logger);
      process.exitCode = repairExitCode(report);
    });
}
