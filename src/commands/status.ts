/**
 * `status` — reports what is actually installed, and what is actually switched on.
 *
 * Read-only: it creates and modifies nothing, so it is safe against any database and any
 * project.
 *
 * The report spans two systems that must never be conflated, because they fail
 * independently and are owned by different things:
 *
 * ```text
 *   PostgreSQL             the function exists, and supabase_auth_admin can run it
 *   Supabase Auth          the service is configured to call it
 * ```
 *
 * A function that exists is not a filter that runs. Until this branch, the second line
 * was always a hollow "not verified", because nothing in the database can observe the
 * Auth service's configuration. It now can be verified — but only when Management API
 * credentials are supplied, and only by asking the Management API. So the second line
 * has three honest answers, not two: verified on, verified off, and **not checked**.
 *
 * The rule that governs the whole file: a missing optional credential must never turn a
 * database-only status call into an error, and a supplied credential that fails must
 * never be quietly downgraded into "not checked".
 */

import type { Command } from 'commander';

import { loadConfig, requireDatabaseUrl } from '../config/env.js';
import { createPostgresConnection } from '../database/client.js';
import { AUTH_HOOK_ROLE, readGuardSchemaStatus } from '../database/schema-status.js';
import type { GuardSchemaStatus } from '../database/schema-status.js';
import type { MigrationFile } from '../database/migration-types.js';
import type { DatabaseConnection, DatabaseConnectionConfig } from '../database/types.js';
import { EXIT_CODES, toAppError } from '../lib/errors.js';
import type { AppError, ExitCode } from '../lib/errors.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { Logger } from '../lib/logger.js';
import { CLI_NAME, PRODUCT_NAME } from '../lib/package-info.js';
import { describeHookUri } from '../lib/redact.js';
import { getBeforeUserCreatedHookState } from '../supabase/auth-config.js';
import { BEFORE_USER_CREATED_HOOK_URI } from '../supabase/constants.js';
import { ManagementClient } from '../supabase/management-client.js';
import type { BeforeUserCreatedHookState } from '../supabase/types.js';

export interface StatusDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly connect: (config: DatabaseConnectionConfig) => Promise<DatabaseConnection>;
  /** Migrations to compare against. Defaults to the bundled `migrations/` directory. */
  readonly files?: MigrationFile[];
  /** Management API client. Injected by tests over a fake `fetch`. */
  readonly client?: ManagementClient;
}

/**
 * What `status` was able to establish about the Auth service.
 *
 * `not-checked` and `failed` are separate on purpose. Both mean "we do not know", but
 * one is a choice the operator made by not supplying credentials and the other is a
 * problem they need to hear about. Collapsing them would let a revoked token look
 * exactly like an ordinary database-only run.
 */
export type RemoteActivation =
  /** No Management API credentials were supplied. Not an error. */
  | { readonly kind: 'not-checked' }
  /** Verified: Supabase Auth calls our hook. */
  | { readonly kind: 'active'; readonly state: BeforeUserCreatedHookState }
  /** Verified: it does not. The slot is ours-but-off, or empty. */
  | { readonly kind: 'inactive'; readonly state: BeforeUserCreatedHookState }
  /** Verified: the slot belongs to another hook. */
  | { readonly kind: 'conflict'; readonly state: BeforeUserCreatedHookState }
  /** Credentials were supplied and the check could not be completed. */
  | { readonly kind: 'failed'; readonly error: AppError };

export interface StatusReport {
  /** Redacted `host:port/database`, safe to print. */
  readonly target: string;
  readonly schema: GuardSchemaStatus;
  readonly remote: RemoteActivation;
}

export async function runStatus(
  dependencies: Partial<StatusDependencies> = {},
): Promise<StatusReport> {
  const env = dependencies.env ?? process.env;
  const connect = dependencies.connect ?? createPostgresConnection;

  const config = loadConfig(env);
  const databaseUrl = requireDatabaseUrl(config, 'status');

  const connection = await connect({ connectionString: databaseUrl });

  let schema: GuardSchemaStatus;
  try {
    schema = await readGuardSchemaStatus(connection, {
      ...(dependencies.files === undefined ? {} : { files: dependencies.files }),
    });
  } finally {
    await connection.close().catch(() => undefined);
  }

  return {
    target: connection.target,
    schema,
    remote: await readRemoteActivation(dependencies, config.projectRef, config.accessToken),
  };
}

/**
 * Checks the Auth service, but only when asked to, and never fatally.
 *
 * Failures are captured into the report rather than thrown, so a database report an
 * operator asked for still gets printed when the Management API is down. They are
 * captured, not swallowed: `failed` prints as an error line and changes the exit code.
 */
async function readRemoteActivation(
  dependencies: Partial<StatusDependencies>,
  projectRef: string | undefined,
  accessToken: string | undefined,
): Promise<RemoteActivation> {
  // A project ref is needed to name the project, and a token to be allowed to ask about
  // it. Absence of either is the documented, ordinary case -- `status` has always worked
  // with a database alone and must keep doing so.
  if (projectRef === undefined) {
    return { kind: 'not-checked' };
  }

  let client: ManagementClient;
  if (dependencies.client !== undefined) {
    client = dependencies.client;
  } else if (accessToken === undefined) {
    return { kind: 'not-checked' };
  } else {
    client = new ManagementClient({ accessToken });
  }

  try {
    const state = await getBeforeUserCreatedHookState(client, projectRef);

    if (state.configured && !state.isOurs) {
      return { kind: 'conflict', state };
    }
    return state.enabled && state.isOurs ? { kind: 'active', state } : { kind: 'inactive', state };
  } catch (error) {
    return { kind: 'failed', error: toAppError(error) };
  }
}

export function printStatusReport(report: StatusReport, logger: Logger = defaultLogger): void {
  const { schema } = report;

  logger.plain(PRODUCT_NAME);
  logger.blank();

  logger.plain('Database');
  logger.success(`Connected (${report.target})`);
  logger.blank();

  logger.plain('Guard schema');
  if (schema.health === 'not-installed') {
    logger.pending('Not installed');
    logger.blank();
    printHookAndSyncSections(logger, report);
    logger.blank();
    logger.plain(`Run \`${CLI_NAME} install\` to create the guard schema.`);
    return;
  }

  const incomplete = schema.health === 'incomplete';

  // The headline must not read "Installed" for a damaged schema: that is precisely
  // the false claim of health this branch exists to avoid.
  if (incomplete) {
    logger.error('Incomplete installation — guard layer requires repair');
  } else {
    logger.success('Installed');
  }

  reportLine(logger, incomplete, `Schema version: ${schema.currentVersion ?? 'none'}`);
  reportCount(logger, 'Blocked domains', schema.blockedDomainCount);
  reportCount(logger, 'Allowed domains', schema.allowedDomainCount);

  if (schema.lookupFunctionInstalled) {
    logger.success('Lookup function: guard.is_disposable_domain(text)');
  } else {
    logger.error('Lookup function: missing (guard.is_disposable_domain(text))');
  }

  if (schema.missingObjects.length > 0) {
    logger.error(`Missing objects: ${schema.missingObjects.join(', ')}`);
  }

  if (schema.pending.length > 0) {
    logger.warning(
      `${schema.pending.length} migration(s) pending: ${schema.pending
        .map((file) => file.fileName)
        .join(', ')}`,
    );
  }

  logger.blank();
  printHookAndSyncSections(logger, report);
  logger.blank();

  // The dangerous combination gets the last word, because it is the only state in which
  // an operator's project is actively broken right now rather than merely unprotected.
  if (isDangerouslyActive(report)) {
    printDangerNotice(logger);
    return;
  }

  if (!incomplete) {
    printHealthySummary(logger, report);
    return;
  }

  // Re-running install replays only the migrations the history says are missing. It
  // cannot recreate an object that was dropped by hand while its migration row
  // remains, so say that plainly instead of implying a one-command fix.
  if (schema.missingObjects.length > 0) {
    logger.plain(
      `Guard layer requires repair. Objects recorded as applied are missing, so \`${CLI_NAME} install\` will not recreate them.`,
    );
    logger.plain('Drop the guard schema and reinstall, or restore the missing objects by hand.');
    return;
  }

  // Same trap, different object: 007_auth_hook_permissions.sql is recorded as
  // applied, and applied migrations are never replayed, so `install` will not
  // re-issue the grants it contains. Pointing at `install` here would send the
  // operator down a path that cannot work.
  if (schema.authHookGrants === 'incomplete') {
    logger.plain(
      `Guard layer requires repair. ${AUTH_HOOK_ROLE} cannot execute the hook, so every signup would be rejected once the hook is activated in Supabase.`,
    );
    logger.plain(
      `\`${CLI_NAME} install\` will not fix this: migrations/007_auth_hook_permissions.sql is already recorded as applied, and applied migrations are never replayed.`,
    );
    logger.plain(
      'Apply the idempotent grant snippet from "Repairing the auth hook grants" in the README, or drop the guard schema and install again.',
    );
    return;
  }

  logger.plain(
    `Incomplete installation. Run \`${CLI_NAME} install\` to apply the pending migrations.`,
  );
}

/**
 * The state that must never be printed calmly.
 *
 * Supabase Auth is calling a hook whose database layer is damaged. Because the hook
 * fails closed, this is not "protection is degraded" — it is "every signup on this
 * project is being rejected right now", and it is the only status combination where the
 * fix is measured in minutes.
 */
function isDangerouslyActive(report: StatusReport): boolean {
  return report.remote.kind === 'active' && report.schema.health !== 'complete';
}

function printDangerNotice(logger: Logger): void {
  logger.error('DANGER: the hook is ACTIVE in Supabase Auth and the database layer is broken.');
  logger.plain('The hook fails closed, so signups on this project are being rejected now.');
  logger.plain(`Either repair the guard layer, or run \`${CLI_NAME} hook disable\` to stop the`);
  logger.plain('rejections while you do — disabling first is the safe order.');
}

/**
 * The closing verdict, which is the line an operator actually reads.
 *
 * Only the `active` branch is allowed to describe the project as protected, and only
 * because that branch was proven by a live read of the Auth configuration. Every other
 * branch says, in one form or another, that signups are not being filtered — the phrasing
 * is deliberately chosen so that no line short of `active` can be misread as an
 * activation claim, even out of context in a scrollback or a screenshot.
 */
function printHealthySummary(logger: Logger, report: StatusReport): void {
  switch (report.remote.kind) {
    case 'active':
      logger.plain('Active protection: the guard layer is healthy and Supabase Auth calls it.');
      logger.plain('Signups are filtered.');
      return;
    case 'conflict':
      logger.plain('Database guard layer is up to date, but Supabase Auth points its Before User');
      logger.plain('Created slot at a different hook. Signups are NOT filtered by this tool.');
      return;
    case 'inactive':
      logger.plain('Database guard layer is up to date. Supabase Auth is NOT calling the guard');
      logger.plain(
        `hook, so nothing checks a signup. Run \`${CLI_NAME} hook enable\` to switch it on.`,
      );
      return;
    case 'failed':
      logger.plain('Database guard layer is up to date. Whether Supabase Auth calls the guard');
      logger.plain('hook could not be determined — see the error above. Assume it does not.');
      return;
    case 'not-checked':
      logger.plain('Database guard layer is up to date. Whether Supabase Auth calls the guard');
      logger.plain('hook was not checked, so nothing here confirms any signup reaches it.');
      return;
  }
}

/** Success marker only when the installation is whole; neutral otherwise. */
function reportLine(logger: Logger, incomplete: boolean, message: string): void {
  if (incomplete) {
    logger.plain(`  ${message}`);
    return;
  }

  logger.success(message);
}

function reportCount(logger: Logger, label: string, count: number | undefined): void {
  if (count === undefined) {
    logger.error(`${label}: table missing`);
    return;
  }

  logger.success(`${label}: ${count}`);
}

/**
 * The Before User Created hook section, plus what is still unbuilt.
 *
 * The schema is `undefined` when nothing is installed at all, in which case there is no
 * database state to describe and the database half is reported as absent. The remote
 * half is still reported, because "nothing installed, hook enabled" is a real and
 * alarming state that must not be hidden behind a missing schema.
 */
function printHookAndSyncSections(logger: Logger, report: StatusReport): void {
  logger.plain('Before User Created Hook');
  printHookSection(logger, report);
  logger.blank();
  logger.plain('Automatic sync');
  logger.pending('Not configured (not implemented yet)');
}

/**
 * Reports the three independent facts about the hook, and refuses to conflate them.
 *
 * The function existing, the grants being held, and Supabase Auth being configured to
 * call it are separate conditions with separate owners and separate failure modes. Each
 * gets its own line, and no line is ever inferred from another.
 */
function printHookSection(logger: Logger, report: StatusReport): void {
  const schema = report.schema.schemaInstalled ? report.schema : undefined;

  if (schema === undefined || !schema.hookFunctionInstalled) {
    logger.pending('Function not installed (guard.before_user_created(jsonb))');
  } else {
    logger.success('Function installed: guard.before_user_created(jsonb)');
  }

  if (schema !== undefined) {
    printHookGrants(logger, schema);
  }

  printRemoteActivation(logger, report.remote);
}

function printRemoteActivation(logger: Logger, remote: RemoteActivation): void {
  switch (remote.kind) {
    case 'not-checked':
      // Hollow, never a tick. Nothing was observed, so nothing may be claimed.
      logger.pending(
        'Remote activation not checked (set SUPABASE_PROJECT_REF and SUPABASE_ACCESS_TOKEN)',
      );
      return;
    case 'active':
      logger.success('Activated in Supabase Auth');
      logger.success(`Auth hook URI: ${BEFORE_USER_CREATED_HOOK_URI}`);
      return;
    case 'inactive':
      logger.pending(
        remote.state.configured
          ? 'Not activated in Supabase Auth (URI configured, hook disabled)'
          : 'Not activated in Supabase Auth (no hook configured)',
      );
      return;
    case 'conflict':
      logger.error(
        `Conflict: another Before User Created hook is configured (${describeHookUri(remote.state.uri)})`,
      );
      return;
    case 'failed':
      // Honest failure, never downgraded to "not checked". Credentials were supplied,
      // so the operator asked the question and deserves the real answer.
      logger.error(`Remote activation check failed: ${remote.error.message}`);
      if (remote.error.hint !== undefined) {
        logger.plain(`  ${remote.error.hint}`);
      }
      return;
  }
}

function printHookGrants(logger: Logger, schema: GuardSchemaStatus): void {
  switch (schema.authHookGrants) {
    case 'granted':
      logger.success(`Grants: ${AUTH_HOOK_ROLE} can execute the hook`);
      return;
    case 'incomplete':
      logger.error(
        `Grants: ${AUTH_HOOK_ROLE} is missing ${schema.missingAuthHookGrants.join(', ')}`,
      );
      return;
    case 'role-absent':
      // Saying "verified" here would be a vacuous pass on a database that has no
      // Supabase Auth to verify against.
      logger.pending(`Grants: not checked (${AUTH_HOOK_ROLE} does not exist on this server)`);
      return;
    case 'unknown':
      logger.pending('Grants: not checked (guard objects are missing)');
      return;
  }
}

/**
 * Process exit code for a status report, so `status` doubles as a health check.
 *
 * Precedence, most-certain verdict first:
 *
 *  1. **`5` guard health** — the database is definitely damaged. A definite failure
 *     outranks everything else, and it is what the remote states are dangerous
 *     *because* of.
 *  2. **`8` hook conflict** — a definite remote finding that needs a human decision.
 *  3. **`7` remote failure** — we were asked to check and could not. Least certain, so
 *     last.
 *  4. **`0`** — including a healthy database whose hook is simply not activated. That is
 *     a documented, deliberate state, not a failure, and making it non-zero would break
 *     every existing database-only health check.
 *
 * Configuration and database-connection failures never reach this function: they are
 * thrown and keep their own codes via the CLI's top-level handler.
 */
export function statusExitCode(report: StatusReport): ExitCode {
  if (report.schema.health !== 'complete') {
    return EXIT_CODES.guardHealth;
  }
  if (report.remote.kind === 'conflict') {
    return EXIT_CODES.hookConflict;
  }
  if (report.remote.kind === 'failed') {
    return EXIT_CODES.remote;
  }
  return EXIT_CODES.success;
}

export function registerStatusCommand(
  program: Command,
  logger: Logger = defaultLogger,
  // Injected only by tests, so the exit-code wiring itself can be exercised.
  dependencies: Partial<StatusDependencies> = {},
): Command {
  return program
    .command('status')
    .description('Report the guard schema, and whether the hook is active in Supabase Auth.')
    .action(async () => {
      const report = await runStatus(dependencies);
      printStatusReport(report, logger);
      process.exitCode = statusExitCode(report);
    });
}
