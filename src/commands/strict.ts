/**
 * `strict` — the opt-in database backstop.
 *
 * ```text
 *   signup with a disposable email
 *           |
 *   Before User Created Hook   -> rejected cleanly, with an HTTP policy response
 *           |                     (the trigger is never reached)
 *   auth.users INSERT / email UPDATE
 *           |
 *   strict trigger             -> guard.is_disposable_domain() -> allow / abort write
 * ```
 *
 * The hook remains the supported primary layer and the only one that produces a
 * client-friendly rejection. Strict mode exists for writes that never pass through it:
 * a direct INSERT, a seed script, and — structurally — an email CHANGE, which a
 * before-user-*created* hook cannot see at all.
 *
 * Four properties this command group exists to preserve, each of which is a decision
 * rather than an implementation detail:
 *
 *  - **Opt-in.** No migration creates the trigger. `install` never switches strict mode
 *    on, and running `install` on a database with strict mode enabled never switches it
 *    off. The two are independent.
 *  - **Reversible.** `strict disable` needs nothing from the guard schema, so the exit
 *    stays open even when the guard layer is the thing that is broken.
 *  - **Never destructive.** A trigger under our name that is not ours is a conflict, and
 *    a conflict is reported. There is no `DROP TRIGGER IF EXISTS`, no recreate-over-the-
 *    top, and no flag to force one.
 *  - **Honest.** Nothing is reported as done until it has been read back from the
 *    catalog.
 */

import type { Command } from 'commander';

import { loadConfig, requireDatabaseUrl } from '../config/env.js';
import { createPostgresConnection } from '../database/client.js';
import { readGuardSchemaStatus } from '../database/schema-status.js';
import type { GuardSchemaStatus } from '../database/schema-status.js';
import type { MigrationFile } from '../database/migration-types.js';
import {
  AUTH_USERS_EMAIL_COLUMN,
  AUTH_USERS_TABLE,
  createStrictTrigger,
  dropStrictTrigger,
  readStrictModeStatus,
  readStrictTriggerState,
  STRICT_TRIGGER_FUNCTION,
  STRICT_TRIGGER_NAME,
} from '../database/strict-trigger.js';
import type { StrictModeStatus, StrictTriggerState } from '../database/strict-trigger.js';
import type { DatabaseConnection, DatabaseConnectionConfig } from '../database/types.js';
import {
  EXIT_CODES,
  GuardHealthError,
  StrictTriggerConflictError,
  UnexpectedError,
} from '../lib/errors.js';
import type { ExitCode } from '../lib/errors.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { Logger } from '../lib/logger.js';
import { CLI_NAME, PRODUCT_NAME } from '../lib/package-info.js';

/** The policy entry point the trigger delegates to, written the way an operator reads it. */
const POLICY_CALL = `guard.is_disposable_domain(${AUTH_USERS_EMAIL_COLUMN})`;

/** How the trigger is described in output. Matches what `CREATE TRIGGER` actually says. */
const TRIGGER_SHAPE = [
  `BEFORE INSERT OR UPDATE OF ${AUTH_USERS_EMAIL_COLUMN}`,
  `ON ${AUTH_USERS_TABLE}`,
];

export interface StrictDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly connect: (config: DatabaseConnectionConfig) => Promise<DatabaseConnection>;
  /** Migrations to compare against. Defaults to the bundled `migrations/` directory. */
  readonly files?: MigrationFile[];
}

export type StrictIntent = 'enable' | 'disable';

export interface StrictCommandOptions {
  readonly dryRun?: boolean;
}

export interface StrictStatusReport {
  /** Redacted `host:port/database`, safe to print. */
  readonly target: string;
  readonly schema: GuardSchemaStatus;
  readonly strict: StrictModeStatus;
}

export interface StrictMutationReport {
  readonly intent: StrictIntent;
  readonly dryRun: boolean;
  readonly target: string;
  /** State observed before anything was decided. */
  readonly before: StrictModeStatus | undefined;
  /** State of the trigger before anything was decided. Always present. */
  readonly beforeTrigger: StrictTriggerState;
  readonly action: 'create' | 'drop' | 'no-op';
  /** One line explaining the action, shown verbatim. */
  readonly reason: string;
  /** True only when DDL actually ran. */
  readonly changed: boolean;
  /** Proven by a fresh catalog read after the DDL. `undefined` when nothing ran. */
  readonly verified: StrictTriggerState | undefined;
}

/** Progress callbacks, so a multi-step command does not look like a hang. */
export interface StrictEvents {
  readonly onConnected?: (target: string) => void;
  readonly onPreflightPassed?: () => void;
  readonly onTriggerCreated?: () => void;
  readonly onTriggerDropped?: () => void;
  readonly onVerified?: () => void;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export async function runStrictStatus(
  dependencies: Partial<StrictDependencies> = {},
): Promise<StrictStatusReport> {
  const env = dependencies.env ?? process.env;
  const connect = dependencies.connect ?? createPostgresConnection;

  const databaseUrl = requireDatabaseUrl(loadConfig(env), 'strict status');
  const connection = await connect({ connectionString: databaseUrl });

  try {
    const schema = await readGuardSchemaStatus(connection, {
      ...(dependencies.files === undefined ? {} : { files: dependencies.files }),
    });
    const strict = await readStrictModeStatus(connection, {
      guardHealthy: schema.health === 'complete',
    });

    return { target: connection.target, schema, strict };
  } finally {
    await connection.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Enable
// ---------------------------------------------------------------------------

/**
 * Creates the trigger, or explains precisely why it will not.
 *
 * Order is the point, and it is the same order `hook enable` uses:
 *
 * ```text
 *   preflight  ->  read catalog state  ->  decide  ->  [DDL]  ->  read back  ->  verify
 * ```
 *
 * Preflight runs before the conflict check on purpose. A database whose guard layer is
 * damaged cannot enforce anything, whatever its trigger looks like, and sending an
 * operator to resolve a trigger collision first would have them fix the second problem
 * before the first.
 */
export async function runStrictEnable(
  dependencies: Partial<StrictDependencies> = {},
  options: StrictCommandOptions = {},
  events: StrictEvents = {},
): Promise<StrictMutationReport> {
  const env = dependencies.env ?? process.env;
  const connect = dependencies.connect ?? createPostgresConnection;
  const dryRun = options.dryRun === true;

  const databaseUrl = requireDatabaseUrl(loadConfig(env), 'strict enable');
  const connection = await connect({ connectionString: databaseUrl });
  events.onConnected?.(connection.target);

  try {
    const schema = await readGuardSchemaStatus(connection, {
      ...(dependencies.files === undefined ? {} : { files: dependencies.files }),
    });
    const strict = await readStrictModeStatus(connection, {
      guardHealthy: schema.health === 'complete',
    });

    assertEnablePreflightPassed(strict);
    events.onPreflightPassed?.();

    // Checked after the preflight and before the dry-run exit, so `--dry-run` surfaces a
    // collision rather than previewing a change it would never be allowed to make.
    if (strict.trigger.kind === 'conflict') {
      throw conflictError(strict.trigger.reasons, 'enable');
    }

    const base = {
      intent: 'enable' as const,
      dryRun,
      target: connection.target,
      before: strict,
      beforeTrigger: strict.trigger,
    };

    if (strict.trigger.kind === 'ours') {
      // Running `strict enable` twice must not create a second trigger, and must not
      // drop and recreate the one that is already correct.
      return {
        ...base,
        action: 'no-op',
        reason: 'Strict mode is already enabled and the trigger matches the expected definition.',
        changed: false,
        verified: undefined,
      };
    }

    if (dryRun) {
      return {
        ...base,
        action: 'create',
        reason: 'Strict mode is currently disabled.',
        changed: false,
        verified: undefined,
      };
    }

    await createStrictTrigger(connection);
    events.onTriggerCreated?.();

    const verified = await readStrictTriggerState(connection);
    assertVerified(verified, 'enable');
    events.onVerified?.();

    return {
      ...base,
      action: 'create',
      reason: 'Strict mode is currently disabled.',
      changed: true,
      verified,
    };
  } finally {
    await connection.close().catch(() => undefined);
  }
}

/**
 * Refuses to attach a fail-closed trigger to a layer that cannot answer.
 *
 * The trigger has no exception handler by design, so creating it against a damaged guard
 * schema does not weaken the filter — it stops every write to `auth.users`, signups
 * included. Every blocker named here is one that would produce exactly that.
 */
function assertEnablePreflightPassed(strict: StrictModeStatus): void {
  if (strict.blockers.length === 0) {
    return;
  }

  const [first, ...rest] = strict.blockers;

  throw new GuardHealthError(`Strict mode cannot be enabled: ${first ?? 'preflight failed'}`, {
    hint:
      rest.length > 0
        ? `Also blocking: ${rest.join('; ')}. ${enableRemediation(strict)}`
        : enableRemediation(strict),
  });
}

function enableRemediation(strict: StrictModeStatus): string {
  if (!strict.authUsers.tablePresent) {
    return `Strict mode is a Supabase-specific backstop and needs ${AUTH_USERS_TABLE}. Point SUPABASE_DB_URL at the Supabase project database, or leave strict mode off — it is optional.`;
  }

  if (!strict.functionInstalled) {
    return `Run \`${CLI_NAME} install\` to apply migration 008, then try again.`;
  }

  return `Run \`${CLI_NAME} status\` for the detail and repair the guard layer first. The trigger fails closed, so enabling it now would reject writes to ${AUTH_USERS_TABLE}.`;
}

// ---------------------------------------------------------------------------
// Disable
// ---------------------------------------------------------------------------

/**
 * Removes our trigger, and only our trigger.
 *
 * There is deliberately no guard-health preflight here, for the same reason
 * `hook disable` has none: the moment an operator most needs this command is the moment
 * the guard layer is broken and the trigger is rejecting writes. Requiring a healthy
 * guard schema in order to switch off the thing that is failing closed would close the
 * only exit.
 *
 * Nothing else on `auth.users` is read, altered or reordered. Unrelated triggers — the
 * `on_auth_user_created` pattern Supabase itself documents, for instance — are none of
 * this tool's business and are left exactly as they are.
 */
export async function runStrictDisable(
  dependencies: Partial<StrictDependencies> = {},
  options: StrictCommandOptions = {},
  events: StrictEvents = {},
): Promise<StrictMutationReport> {
  const env = dependencies.env ?? process.env;
  const connect = dependencies.connect ?? createPostgresConnection;
  const dryRun = options.dryRun === true;

  const databaseUrl = requireDatabaseUrl(loadConfig(env), 'strict disable');
  const connection = await connect({ connectionString: databaseUrl });
  events.onConnected?.(connection.target);

  try {
    const trigger = await readStrictTriggerState(connection);

    const base = {
      intent: 'disable' as const,
      dryRun,
      target: connection.target,
      before: undefined,
      beforeTrigger: trigger,
    };

    if (trigger.kind === 'conflict') {
      throw conflictError(trigger.reasons, 'disable');
    }

    if (trigger.kind === 'absent') {
      return {
        ...base,
        action: 'no-op',
        reason: 'Strict mode is already disabled — no trigger of ours exists.',
        changed: false,
        verified: undefined,
      };
    }

    if (dryRun) {
      return {
        ...base,
        action: 'drop',
        reason: 'Strict mode is currently enabled.',
        changed: false,
        verified: undefined,
      };
    }

    await dropStrictTrigger(connection);
    events.onTriggerDropped?.();

    const verified = await readStrictTriggerState(connection);
    assertVerified(verified, 'disable');
    events.onVerified?.();

    return {
      ...base,
      action: 'drop',
      reason: 'Strict mode is currently enabled.',
      changed: true,
      verified,
    };
  } finally {
    await connection.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Shared failures
// ---------------------------------------------------------------------------

function conflictError(reasons: string[], intent: StrictIntent): StrictTriggerConflictError {
  const verb = intent === 'enable' ? 'create' : 'drop';

  return new StrictTriggerConflictError(
    `A trigger named ${STRICT_TRIGGER_NAME} already exists on ${AUTH_USERS_TABLE} and is not the one this tool creates: ${reasons.join('; ')}`,
    {
      hint: `Refusing to ${verb} it. Inspect it with \`select pg_get_triggerdef(oid) from pg_trigger where tgname = '${STRICT_TRIGGER_NAME}'\`, decide whether it should survive, and remove it by hand if it should not.`,
    },
  );
}

/**
 * Proves the change happened, by reading the catalog again.
 *
 * A statement that did not raise is not a state that exists — the same rule the hook
 * commands apply to an HTTP 200. Reaching this with the wrong state means something
 * changed the trigger between the DDL and the read, which is a state nobody chose.
 */
function assertVerified(state: StrictTriggerState, intent: StrictIntent): void {
  const expected = intent === 'enable' ? 'ours' : 'absent';
  if (state.kind === expected) {
    return;
  }

  throw new UnexpectedError(
    `PostgreSQL accepted the ${intent === 'enable' ? 'CREATE' : 'DROP'} TRIGGER but the catalog does not show it: ${STRICT_TRIGGER_NAME} on ${AUTH_USERS_TABLE} is now "${state.kind}"`,
    {
      hint: `Do not assume the ${intent} succeeded. Inspect the triggers on ${AUTH_USERS_TABLE} before relying on this database.`,
    },
  );
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** Section heading, shared by `strict status` and the main `status` report. */
export const STRICT_SECTION_TITLE = 'Strict database enforcement';

/**
 * The strict section of a status report.
 *
 * `detailed` adds the supporting facts an operator needs while troubleshooting. The
 * headline line is identical either way, so the two commands can never disagree about
 * what state the database is in.
 */
export function printStrictSection(
  strict: StrictModeStatus,
  logger: Logger = defaultLogger,
  options: { detailed?: boolean } = {},
): void {
  const detailed = options.detailed === true;

  logger.plain(STRICT_SECTION_TITLE);

  if (detailed) {
    printStrictDetail(strict, logger);
  }

  switch (strict.mode) {
    case 'enabled':
      logger.success('Strict mode enabled');
      if (detailed) {
        logger.plain(`  ${STRICT_TRIGGER_NAME}`);
        for (const line of TRIGGER_SHAPE) {
          logger.plain(`  ${line}`);
        }
        logger.plain(`  Policy: ${POLICY_CALL}`);
      }
      return;
    case 'disabled':
      // A hollow marker, never an error. Strict mode is optional, and a deployment with
      // a healthy guard layer and an active hook is fully protected without it.
      logger.pending(detailed ? 'Disabled' : 'Disabled (optional)');
      if (detailed) {
        logger.plain(`  Run \`${CLI_NAME} strict enable\` to switch it on.`);
      }
      return;
    case 'unavailable':
      logger.pending(
        `Unavailable (optional): ${strict.blockers[0] ?? 'prerequisites are missing'}`,
      );
      return;
    case 'conflict':
      logger.error('Trigger configuration conflict');
      logger.plain(
        `  ${STRICT_TRIGGER_NAME} on ${AUTH_USERS_TABLE} is not the trigger this tool creates.`,
      );
      if (strict.trigger.kind === 'conflict') {
        for (const reason of strict.trigger.reasons) {
          logger.plain(`  - ${reason}`);
        }
      }
      logger.plain('  This tool will not change it.');
      return;
    case 'broken':
      logger.error('Strict mode is ENABLED and the policy layer it calls is damaged.');
      logger.plain(`  The trigger fails closed, so writes to ${AUTH_USERS_TABLE} are failing now.`);
      logger.plain(
        `  Either repair the guard layer, or run \`${CLI_NAME} strict disable\` to stop the`,
      );
      logger.plain('  rejections while you do — disabling first is the safe order.');
      return;
  }
}

function printStrictDetail(strict: StrictModeStatus, logger: Logger): void {
  if (strict.functionInstalled) {
    logger.success(`Trigger function installed: ${STRICT_TRIGGER_FUNCTION}`);
  } else {
    logger.pending(`Trigger function not installed (${STRICT_TRIGGER_FUNCTION})`);
  }

  const { authUsers } = strict;
  if (!authUsers.tablePresent) {
    logger.pending(`${AUTH_USERS_TABLE} not found on this server`);
    return;
  }

  if (authUsers.emailColumnCompatible) {
    logger.success(
      `${AUTH_USERS_TABLE} compatible (${AUTH_USERS_EMAIL_COLUMN} ${authUsers.emailColumnType ?? 'text'})`,
    );
  } else {
    logger.error(
      authUsers.emailColumnType === undefined
        ? `${AUTH_USERS_TABLE} has no ${AUTH_USERS_EMAIL_COLUMN} column`
        : `${AUTH_USERS_TABLE}.${AUTH_USERS_EMAIL_COLUMN} is ${authUsers.emailColumnType}, which is not a text type`,
    );
  }

  if (authUsers.canCreateTrigger === false) {
    logger.warning(`The connected role has no TRIGGER privilege on ${AUTH_USERS_TABLE}.`);
  }
}

export function printStrictStatusReport(
  report: StrictStatusReport,
  logger: Logger = defaultLogger,
): void {
  logger.plain(PRODUCT_NAME);
  logger.blank();

  logger.plain('Database');
  logger.success(`Connected (${report.target})`);
  logger.blank();

  printStrictSection(report.strict, logger, { detailed: true });
  logger.blank();

  logger.plain('Strict mode is an optional backstop. The supported primary layer is the');
  logger.plain('Supabase Before User Created hook, which rejects a disposable signup with a');
  logger.plain('proper HTTP response before it ever reaches the database.');
}

export function printStrictMutationReport(
  report: StrictMutationReport,
  logger: Logger = defaultLogger,
): void {
  if (report.dryRun) {
    printStrictDryRun(report, logger);
    return;
  }

  logger.blank();

  if (report.action === 'no-op') {
    logger.success(
      report.intent === 'enable' ? 'Strict mode already enabled' : 'Strict mode already disabled',
    );
    logger.blank();
    logger.plain('No database changes were needed.');
    return;
  }

  if (report.intent === 'enable') {
    logger.success('Strict mode enabled');
    logger.success(`Trigger verified: ${STRICT_TRIGGER_NAME} on ${AUTH_USERS_TABLE}`);
    logger.blank();
    logger.plain(`Writes to ${AUTH_USERS_TABLE} are now checked against ${POLICY_CALL}.`);
    logger.plain('This is a backstop. The Before User Created hook remains the layer that');
    logger.plain('rejects a disposable signup cleanly, and it should still be enabled.');
    return;
  }

  logger.success('Strict mode disabled');
  logger.success(`Trigger removed: ${STRICT_TRIGGER_NAME} on ${AUTH_USERS_TABLE}`);
  logger.blank();
  logger.plain(`${STRICT_TRIGGER_FUNCTION} is left in place — it is inert without the`);
  logger.plain('trigger, and keeping it means `strict enable` needs no migration to run again.');
  logger.plain('Unrelated triggers on the table were not touched.');
}

/**
 * The preview. Executes zero DDL, and says so.
 *
 * It reports the same preflight outcome and the same conflict as a real run, because a
 * preview whose verdict differs from the run it previews is worse than no preview.
 */
function printStrictDryRun(report: StrictMutationReport, logger: Logger): void {
  logger.blank();
  logger.plain('Strict mode');
  logger.plain(`  ${report.reason}`);
  logger.blank();

  if (report.action === 'no-op') {
    logger.plain('Would change: nothing.');
    logger.blank();
    logger.plain('No database changes made.');
    return;
  }

  if (report.action === 'create') {
    logger.plain('Would create:');
    logger.plain(`  ${STRICT_TRIGGER_NAME}`);
    for (const line of TRIGGER_SHAPE) {
      logger.plain(`  ${line}`);
    }
    logger.blank();
    logger.plain('Policy:');
    logger.plain(`  ${POLICY_CALL}`);
  } else {
    logger.plain('Would drop:');
    logger.plain(`  ${STRICT_TRIGGER_NAME} on ${AUTH_USERS_TABLE}`);
    logger.blank();
    logger.plain(`${STRICT_TRIGGER_FUNCTION} would be left in place.`);
  }

  logger.blank();
  logger.plain('No database changes made.');
}

/**
 * Exit code for a `strict status` report.
 *
 * `disabled` and `unavailable` both exit `0`. Strict mode is optional, so its absence is
 * a fact about the database and not a failure of the command — making it non-zero would
 * turn every healthy default deployment into a red CI check.
 */
export function strictStatusExitCode(report: StrictStatusReport): ExitCode {
  return strictModeExitCode(report.strict.mode);
}

/** Shared with the main `status` command, so the two can never disagree. */
export function strictModeExitCode(mode: StrictModeStatus['mode']): ExitCode {
  switch (mode) {
    case 'broken':
      return EXIT_CODES.guardHealth;
    case 'conflict':
      return EXIT_CODES.strictConflict;
    case 'enabled':
    case 'disabled':
    case 'unavailable':
      return EXIT_CODES.success;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Leads with the action, then the warning.
 *
 * The parallel with `strict disable` ("Remove the strict trigger...") matters in the
 * command list, where a reader is scanning verbs. The warning still has to be here and
 * not only in the docs -- `--help` is the last thing many people read before running a
 * command that can stop every write to `auth.users`.
 */
const ADVANCED_NOTICE =
  'Create the strict trigger on auth.users. ADVANCED: a BEFORE INSERT OR UPDATE OF email trigger on the Supabase-managed table, which fails closed — if the guard layer breaks, writes to auth.users are rejected.';

export function registerStrictCommand(
  program: Command,
  logger: Logger = defaultLogger,
  // Injected only by tests, so the exit-code and output wiring is exercised too.
  dependencies: Partial<StrictDependencies> = {},
): Command {
  const strict = program
    .command('strict')
    .description('ADVANCED, optional: control the database-level trigger backstop on auth.users.');

  strict
    .command('status')
    .description('Report whether the strict trigger is installed on auth.users.')
    .action(async () => {
      const report = await runStrictStatus(dependencies);
      printStrictStatusReport(report, logger);
      process.exitCode = strictStatusExitCode(report);
    });

  strict
    .command('enable')
    .description(ADVANCED_NOTICE)
    .option('--dry-run', 'Report what would change and execute no DDL.', false)
    .action(async (options: StrictCommandOptions) => {
      await runStrictMutation('enable', options, logger, dependencies);
    });

  strict
    .command('disable')
    .description('Remove the strict trigger from auth.users. Leaves the trigger function.')
    .option('--dry-run', 'Report what would change and execute no DDL.', false)
    .action(async (options: StrictCommandOptions) => {
      await runStrictMutation('disable', options, logger, dependencies);
    });

  return strict;
}

async function runStrictMutation(
  intent: StrictIntent,
  options: StrictCommandOptions,
  logger: Logger,
  dependencies: Partial<StrictDependencies>,
): Promise<void> {
  logger.plain(PRODUCT_NAME);
  logger.blank();
  if (options.dryRun === true) {
    logger.plain('Dry run');
    logger.blank();
  }

  const run = intent === 'enable' ? runStrictEnable : runStrictDisable;

  const report = await run(dependencies, options, {
    onConnected: (target) => logger.success(`Connected to PostgreSQL (${target})`),
    onPreflightPassed: () => logger.success('Preflight passed: guard layer and auth.users ready'),
    onTriggerCreated: () => logger.success('Trigger created'),
    onTriggerDropped: () => logger.success('Trigger dropped'),
    onVerified: () => logger.success('Verified by reading the catalog back'),
  });

  printStrictMutationReport(report, logger);
}
