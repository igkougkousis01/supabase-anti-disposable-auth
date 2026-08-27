/**
 * `hook` — activates, deactivates and inspects the Before User Created hook in a
 * **hosted** Supabase project's Auth configuration.
 *
 * This is the command group that closes the gap the rest of the tool has been careful to
 * keep visible. `install` creates `guard.before_user_created()` in PostgreSQL; nothing in
 * the database can make Supabase Auth call it, because that setting lives in the Auth
 * service. `hook enable` is the arrow the architecture diagram could not draw:
 *
 * ```text
 * Database installation  ->  guard.before_user_created()  ->  Remote Auth config  ->  ACTIVE
 * ```
 *
 * Why this is a separate command group and not part of `install`:
 *
 *  - **Different blast radius.** `install` writes to a database the operator already
 *    handed us credentials for. `hook enable` reconfigures live authentication for an
 *    entire project. Those should not be one indistinguishable step.
 *  - **Different credentials.** Migrations need `SUPABASE_DB_URL`; activation needs a
 *    Management API token, which is a far more powerful secret.
 *  - **Different lifecycle.** Activation is toggled, inspected and reversed
 *    independently of schema version, which is what a subcommand group is for — and it
 *    leaves room for later hook operations without overloading a verb.
 *
 * The one invariant everything here serves:
 *
 * > **Supabase Auth must never be pointed at a database hook that is known to be
 * > broken.** The hook fails closed by design, so activating it against a damaged guard
 * > layer does not degrade protection — it rejects every signup on the project.
 */

import type { Command } from 'commander';

import { loadConfig, requireDatabaseUrl, requireManagementCredentials } from '../config/env.js';
import type { ManagementCredentials } from '../config/types.js';
import { createPostgresConnection } from '../database/client.js';
import { AUTH_HOOK_ROLE, readGuardSchemaStatus } from '../database/schema-status.js';
import type { GuardSchemaStatus } from '../database/schema-status.js';
import type { MigrationFile } from '../database/migration-types.js';
import type { DatabaseConnection, DatabaseConnectionConfig } from '../database/types.js';
import {
  AuthHookConflictError,
  AuthHookVerificationError,
  ConfigurationError,
  EXIT_CODES,
  GuardHealthError,
  UnexpectedError,
} from '../lib/errors.js';
import type { ExitCode } from '../lib/errors.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { Logger } from '../lib/logger.js';
import { CLI_NAME, PRODUCT_NAME } from '../lib/package-info.js';
import { describeHookUri } from '../lib/redact.js';
import {
  getBeforeUserCreatedHookState,
  planHookChange,
  verifyHookState,
} from '../supabase/auth-config.js';
import { BEFORE_USER_CREATED_HOOK_URI } from '../supabase/constants.js';
import { ManagementClient } from '../supabase/management-client.js';
import type { BeforeUserCreatedHookState, HookIntent, HookPlan } from '../supabase/types.js';

export interface HookDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly connect: (config: DatabaseConnectionConfig) => Promise<DatabaseConnection>;
  /** Migrations to compare against. Defaults to the bundled `migrations/` directory. */
  readonly files?: MigrationFile[];
  /**
   * Management API client.
   *
   * Injected by tests, which build a real {@link ManagementClient} over a fake `fetch`
   * so the client's own safety controls are exercised rather than mocked away.
   */
  readonly client?: ManagementClient;
}

export interface HookCommandOptions {
  readonly dryRun?: boolean;
  /**
   * Skip the database preflight. **Dangerous**, and only meaningful for `enable`.
   *
   * See {@link runDatabasePreflight} for why it is opt-in rather than implied by an
   * absent `SUPABASE_DB_URL`.
   */
  readonly skipDbCheck?: boolean;
}

/** What the database says about the guard layer, gathered before any remote write. */
export interface HookPreflightReport {
  /** Redacted `host:port/database`, safe to print. */
  readonly target: string;
  readonly schema: GuardSchemaStatus;
}

export interface HookMutationReport {
  readonly intent: HookIntent;
  readonly dryRun: boolean;
  readonly projectRef: string;
  /** `undefined` when the preflight was explicitly skipped. */
  readonly preflight: HookPreflightReport | undefined;
  readonly plan: HookPlan;
  /** True only when a PATCH was actually sent. */
  readonly patched: boolean;
  /** The state proven by a fresh read, or the pre-change state when nothing was sent. */
  readonly finalState: BeforeUserCreatedHookState;
}

export interface HookStatusReport {
  readonly projectRef: string;
  readonly state: BeforeUserCreatedHookState;
}

/** Progress callbacks, so a slow round trip does not look like a hang. */
export interface HookEvents {
  readonly onPreflightPassed?: (report: HookPreflightReport) => void;
  readonly onPreflightSkipped?: () => void;
  readonly onRemoteRead?: (state: BeforeUserCreatedHookState) => void;
  readonly onPatchSent?: () => void;
  readonly onVerified?: (state: BeforeUserCreatedHookState) => void;
}

/** The database object the hook URI addresses, written the way PostgreSQL names it. */
const HOOK_FUNCTION_SIGNATURE = 'guard.before_user_created(jsonb)';

const SKIP_HINT = `Set SUPABASE_DB_URL so the database hook can be verified first, or pass --skip-db-check to activate without that verification (dangerous — see \`${CLI_NAME} hook enable --help\`).`;

// ---------------------------------------------------------------------------
// Database preflight
// ---------------------------------------------------------------------------

/**
 * Proves the database hook layer is healthy before Supabase Auth is pointed at it.
 *
 * This is the single most important check in the branch, and the reason is worth
 * stating plainly: `guard.before_user_created()` **fails closed**. If the policy engine
 * cannot answer, the hook rejects the signup. That is the right behaviour for a security
 * control and it is exactly what makes premature activation dangerous — enabling the
 * hook against a missing function or a missing grant does not weaken the filter, it
 * turns every signup on the project into a 5xx.
 *
 * Three things are required, and each corresponds to a way the project would break:
 *
 *  - a **complete** guard layer — a missing table or an unapplied migration means the
 *    engine may raise, and a raised engine means a rejected signup;
 *  - the **hook function installed** — Auth would call a function that does not exist,
 *    and every signup would fail with a raw PostgreSQL error;
 *  - **grants held by `supabase_auth_admin`** — Auth connects as that role, so a missing
 *    `EXECUTE` or `SELECT` has the same effect as a missing function.
 *
 * `role-absent` is treated as a failure here, unlike in `status`. `status` runs anywhere
 * and must not fail a plain PostgreSQL server for lacking a Supabase role. But a project
 * being activated on `api.supabase.com` has `supabase_auth_admin`; not finding it means
 * `SUPABASE_DB_URL` points at a different database than the one this project ref names,
 * and activating on the strength of a health check performed against the wrong database
 * is exactly the mistake this function exists to prevent.
 */
export async function runDatabasePreflight(
  dependencies: Partial<HookDependencies>,
  command: string,
): Promise<HookPreflightReport> {
  const env = dependencies.env ?? process.env;
  const connect = dependencies.connect ?? createPostgresConnection;

  const config = loadConfig(env);
  if (config.databaseUrl === undefined) {
    // Deliberately not silently skipped. An absent connection string is a missing
    // capability, not a decision, and inferring "activate without checking" from it
    // would make the dangerous path the default for anyone who has not set the variable.
    throw new ConfigurationError(
      'SUPABASE_DB_URL is missing, so the database hook cannot be verified before activation',
      { hint: SKIP_HINT },
    );
  }
  const databaseUrl = requireDatabaseUrl(config, command);

  const connection = await connect({ connectionString: databaseUrl });

  let schema: GuardSchemaStatus;
  try {
    schema = await readGuardSchemaStatus(connection, {
      ...(dependencies.files === undefined ? {} : { files: dependencies.files }),
    });
  } finally {
    await connection.close().catch(() => undefined);
  }

  const report: HookPreflightReport = { target: connection.target, schema };
  assertPreflightPassed(report);
  return report;
}

function assertPreflightPassed(report: HookPreflightReport): void {
  const { schema } = report;

  if (schema.health === 'not-installed') {
    throw new GuardHealthError('The guard schema is not installed in the target database', {
      hint: `Run \`${CLI_NAME} install\` first. Activating the hook now would reject every signup on the project.`,
    });
  }

  if (!schema.hookFunctionInstalled) {
    throw new GuardHealthError(`The hook function ${HOOK_FUNCTION_SIGNATURE} is not installed`, {
      hint: `Run \`${CLI_NAME} install\`. Supabase Auth would call a function that does not exist and every signup would fail.`,
    });
  }

  if (schema.health === 'incomplete' && schema.missingObjects.length > 0) {
    throw new GuardHealthError(
      `The guard layer is incomplete: missing ${schema.missingObjects.join(', ')}`,
      {
        hint: `Repair the guard layer and run \`${CLI_NAME} status\` until it exits 0. The hook fails closed, so activating it now would reject every signup.`,
      },
    );
  }

  if (schema.pending.length > 0) {
    throw new GuardHealthError(
      `${String(schema.pending.length)} migration(s) are pending in the target database`,
      { hint: `Run \`${CLI_NAME} install\` to apply them, then try again.` },
    );
  }

  switch (schema.authHookGrants) {
    case 'granted':
      break;
    case 'incomplete':
      throw new GuardHealthError(
        `${AUTH_HOOK_ROLE} cannot execute the hook: missing ${schema.missingAuthHookGrants.join(', ')}`,
        {
          hint: 'Every signup would be rejected. Apply the grant snippet from "Repairing the auth hook grants" in the README, then try again.',
        },
      );
    case 'role-absent':
      throw new GuardHealthError(
        `${AUTH_HOOK_ROLE} does not exist in the database SUPABASE_DB_URL points at`,
        {
          hint: 'A hosted Supabase project always has that role, so this is almost certainly the wrong database. Check that SUPABASE_DB_URL and SUPABASE_PROJECT_REF name the same project.',
        },
      );
    case 'unknown':
      throw new GuardHealthError('The hook grants could not be verified', {
        hint: `Run \`${CLI_NAME} status\` to see what is missing from the guard layer.`,
      });
  }

  if (schema.health !== 'complete') {
    throw new GuardHealthError('The guard layer is not healthy', {
      hint: `Run \`${CLI_NAME} status\` for the detail, then try again.`,
    });
  }
}

// ---------------------------------------------------------------------------
// Shared flow
// ---------------------------------------------------------------------------

function buildClient(
  dependencies: Partial<HookDependencies>,
  credentials: ManagementCredentials,
): ManagementClient {
  return dependencies.client ?? new ManagementClient({ accessToken: credentials.accessToken });
}

/**
 * Reads remote state, decides, optionally writes, and then proves the result.
 *
 * The order is the point:
 *
 * ```text
 *   DB preflight  ->  remote GET  ->  plan  ->  [PATCH]  ->  remote GET  ->  verify
 * ```
 *
 * Nothing is written until the current state has been read and judged, so an unexpected
 * configuration stops the command instead of being overwritten by it. And nothing is
 * reported as done until it has been read back, because an accepted request is not a
 * confirmed state.
 */
async function runHookMutation(
  intent: HookIntent,
  dependencies: Partial<HookDependencies>,
  options: HookCommandOptions,
  events: HookEvents,
): Promise<HookMutationReport> {
  const env = dependencies.env ?? process.env;
  const command = `hook ${intent}`;
  const credentials = requireManagementCredentials(loadConfig(env), command);

  const dryRun = options.dryRun === true;

  // `disable` has no preflight at all, and that is deliberate rather than an omission:
  // switching our own hook off cannot point Auth at anything broken. Requiring database
  // credentials to turn a hook OFF would mean an operator whose database is unreachable
  // -- precisely when the fail-closed hook is rejecting every signup -- could not reach
  // for the one command that stops the bleeding.
  let preflight: HookPreflightReport | undefined;
  if (intent === 'enable') {
    if (options.skipDbCheck === true) {
      events.onPreflightSkipped?.();
    } else {
      preflight = await runDatabasePreflight(dependencies, command);
      events.onPreflightPassed?.(preflight);
    }
  }

  const client = buildClient(dependencies, credentials);
  const current = await getBeforeUserCreatedHookState(client, credentials.projectRef);
  events.onRemoteRead?.(current);

  const plan = planHookChange(current, intent);

  // Checked before the dry-run exit, so `--dry-run` surfaces a conflict rather than
  // reporting a change it would never have been allowed to make.
  if (plan.action === 'conflict') {
    throw conflictError(plan, intent);
  }

  if (plan.action === 'no-op' || dryRun) {
    return {
      intent,
      dryRun,
      projectRef: credentials.projectRef,
      preflight,
      plan,
      patched: false,
      finalState: current,
    };
  }

  // `action === 'change'` always carries a patch, but the write is the one operation
  // that must never proceed on an assumption. A reconstructed fallback here would be a
  // guess at what to send to somebody's live Auth configuration, so an impossible state
  // is reported as the bug it is instead.
  if (plan.patch === undefined) {
    throw new UnexpectedError('A hook change was planned without a patch to apply');
  }

  // Only the fields this feature owns. Never a round-tripped copy of the GET response:
  // that would rewrite every unrelated Auth setting -- SMTP, OAuth, CAPTCHA, rate limits
  // -- with values already stale by the time they were written back.
  await client.updateAuthConfig(credentials.projectRef, plan.patch);
  events.onPatchSent?.();

  const finalState = await getBeforeUserCreatedHookState(client, credentials.projectRef);
  if (!verifyHookState(finalState, intent)) {
    throw verificationError(finalState, intent);
  }
  events.onVerified?.(finalState);

  return {
    intent,
    dryRun,
    projectRef: credentials.projectRef,
    preflight,
    plan,
    patched: true,
    finalState,
  };
}

function conflictError(plan: HookPlan, intent: HookIntent): AuthHookConflictError {
  const current = describeHookUri(plan.current.uri);
  const state = plan.current.enabled ? 'enabled' : 'disabled';

  if (intent === 'enable') {
    return new AuthHookConflictError(
      `Before User Created is already configured to a different hook (currently ${state}): ${current}`,
      {
        hint: `Refusing to replace it. The hook slot holds one URI, so enabling ${BEFORE_USER_CREATED_HOOK_URI} would silently disable that policy. Decide explicitly: remove the existing hook in the Supabase dashboard, then run \`${CLI_NAME} hook enable\` again.`,
      },
    );
  }

  return new AuthHookConflictError(
    `Before User Created is configured to a different hook (currently ${state}): ${current}`,
    {
      hint: 'Refusing to touch it. This tool only disables the hook it installed; that configuration belongs to something else.',
    },
  );
}

function verificationError(
  state: BeforeUserCreatedHookState,
  intent: HookIntent,
): AuthHookVerificationError {
  return new AuthHookVerificationError(
    `Supabase accepted the change but the Auth configuration does not show it: Before User Created is ${state.enabled ? 'enabled' : 'disabled'} with URI ${describeHookUri(state.uri)}`,
    {
      hint: `The project may be in an unintended state — do not assume the ${intent} succeeded. Check Authentication -> Hooks in the Supabase dashboard before relying on it.`,
    },
  );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function runHookEnable(
  dependencies: Partial<HookDependencies> = {},
  options: HookCommandOptions = {},
  events: HookEvents = {},
): Promise<HookMutationReport> {
  return runHookMutation('enable', dependencies, options, events);
}

export async function runHookDisable(
  dependencies: Partial<HookDependencies> = {},
  options: HookCommandOptions = {},
  events: HookEvents = {},
): Promise<HookMutationReport> {
  return runHookMutation('disable', dependencies, options, events);
}

/** Read-only. Reports what Supabase Auth is actually configured to do. */
export async function runHookStatus(
  dependencies: Partial<HookDependencies> = {},
): Promise<HookStatusReport> {
  const env = dependencies.env ?? process.env;
  const credentials = requireManagementCredentials(loadConfig(env), 'hook status');
  const client = buildClient(dependencies, credentials);

  return {
    projectRef: credentials.projectRef,
    state: await getBeforeUserCreatedHookState(client, credentials.projectRef),
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export function printHookStatusReport(
  report: HookStatusReport,
  logger: Logger = defaultLogger,
): void {
  logger.plain(PRODUCT_NAME);
  logger.blank();

  logger.plain('Project');
  logger.success(`Connected to the Supabase Management API (project ${report.projectRef})`);
  logger.blank();

  logger.plain('Before User Created');
  printHookState(report.state, logger);
}

/**
 * The three states, distinguished rather than collapsed.
 *
 * "Enabled" alone would be a lie when the slot points somewhere else, and "disabled"
 * alone would hide a conflict an operator needs to know about before they run `enable`.
 * Note that the whole Auth configuration is never dumped: this section prints one flag
 * and one redacted URI, because the document it came from is full of secrets.
 */
function printHookState(state: BeforeUserCreatedHookState, logger: Logger): void {
  if (state.configured && !state.isOurs) {
    logger.error('Conflict');
    logger.plain(`  Another Before User Created hook is configured: ${describeHookUri(state.uri)}`);
    logger.plain(`  It is currently ${state.enabled ? 'enabled' : 'disabled'}.`);
    logger.plain(`  This tool will not change it. Expected: ${BEFORE_USER_CREATED_HOOK_URI}`);
    return;
  }

  if (state.enabled && state.isOurs) {
    logger.success('Enabled');
    logger.success(`URI: ${BEFORE_USER_CREATED_HOOK_URI}`);
    return;
  }

  if (state.isOurs) {
    logger.pending('Disabled');
    logger.plain(`  Configured URI: ${BEFORE_USER_CREATED_HOOK_URI}`);
    logger.plain(`  Run \`${CLI_NAME} hook enable\` to switch it on.`);
    return;
  }

  logger.pending('Not configured');
  logger.plain(`  Run \`${CLI_NAME} hook enable\` to point Supabase Auth at the guard hook.`);
}

export function printHookMutationReport(
  report: HookMutationReport,
  logger: Logger = defaultLogger,
): void {
  if (report.dryRun) {
    printDryRun(report, logger);
    return;
  }

  if (!report.patched) {
    printAlreadyCorrect(report, logger);
    return;
  }

  logger.blank();
  if (report.intent === 'enable') {
    logger.success('Before User Created hook enabled');
    logger.success(`URI verified: ${BEFORE_USER_CREATED_HOOK_URI}`);
    logger.blank();
    logger.plain('Signups are now filtered by the guard hook.');
    return;
  }

  logger.success('Before User Created hook disabled');
  logger.success(`URI left in place: ${BEFORE_USER_CREATED_HOOK_URI}`);
  logger.blank();
  logger.plain('Signups are no longer filtered. The database objects are untouched —');
  logger.plain('it is now safe to remove them if that is what you intended.');
}

function printAlreadyCorrect(report: HookMutationReport, logger: Logger): void {
  logger.blank();
  if (report.intent === 'enable') {
    logger.success('Before User Created hook already enabled');
    logger.success('URI matches expected database function');
    logger.plain(`  ${BEFORE_USER_CREATED_HOOK_URI}`);
    logger.blank();
    logger.plain('No remote changes were needed.');
    return;
  }

  logger.success('Before User Created hook already disabled');
  logger.blank();
  logger.plain('No remote changes were needed.');
}

function printDryRun(report: HookMutationReport, logger: Logger): void {
  const { current } = report.plan;

  logger.blank();
  logger.plain('Current:');
  logger.plain(
    `  Before User Created: ${current.enabled ? 'enabled' : 'disabled'}${current.configured ? '' : ' (no URI configured)'}`,
  );
  if (current.configured) {
    logger.plain(`  URI: ${describeHookUri(current.uri)}`);
  }
  logger.blank();

  if (report.plan.action === 'no-op') {
    logger.plain('Would change: nothing.');
    logger.plain(`  ${report.plan.reason}`);
    logger.blank();
    logger.plain('No remote changes made.');
    return;
  }

  logger.plain('Would set:');
  for (const [field, value] of Object.entries(report.plan.patch ?? {})) {
    logger.plain(`  ${field}: ${String(value)}`);
  }
  logger.blank();
  logger.plain('No remote changes made.');
}

/**
 * Exit code for a `hook status` report.
 *
 * A disabled hook exits `0`: it is a fact about the project, not a failure of the
 * command, and `hook status` is how an operator asks that question. A conflict exits
 * `8`, because it is the one state that needs a human decision.
 */
export function hookStatusExitCode(report: HookStatusReport): ExitCode {
  return report.state.configured && !report.state.isOurs
    ? EXIT_CODES.hookConflict
    : EXIT_CODES.success;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const SKIP_DB_CHECK_DESCRIPTION =
  'DANGEROUS: activate without verifying the database hook first. If the guard layer is broken, every signup on the project will be rejected.';

export function registerHookCommand(
  program: Command,
  logger: Logger = defaultLogger,
  // Injected only by tests, so the exit-code and output wiring is exercised too.
  dependencies: Partial<HookDependencies> = {},
): Command {
  const hook = program
    .command('hook')
    .description('Inspect and control the Before User Created hook in Supabase Auth.');

  hook
    .command('status')
    .description('Report whether Supabase Auth is calling the guard hook.')
    .action(async () => {
      const report = await runHookStatus(dependencies);
      printHookStatusReport(report, logger);
      process.exitCode = hookStatusExitCode(report);
    });

  hook
    .command('enable')
    .description('Point Supabase Auth at guard.before_user_created and switch it on.')
    .option('--dry-run', 'Report what would change and send no PATCH.', false)
    .option('--skip-db-check', SKIP_DB_CHECK_DESCRIPTION, false)
    .action(async (options: HookCommandOptions) => {
      await runMutation('enable', options, logger, dependencies);
    });

  hook
    .command('disable')
    .description('Switch off the guard hook in Supabase Auth, leaving its URI in place.')
    .option('--dry-run', 'Report what would change and send no PATCH.', false)
    .action(async (options: HookCommandOptions) => {
      await runMutation('disable', options, logger, dependencies);
    });

  return hook;
}

async function runMutation(
  intent: HookIntent,
  options: HookCommandOptions,
  logger: Logger,
  dependencies: Partial<HookDependencies>,
): Promise<void> {
  const dryRun = options.dryRun === true;

  logger.plain(PRODUCT_NAME);
  logger.blank();
  if (dryRun) {
    logger.plain('Dry run');
    logger.blank();
  }

  const run = intent === 'enable' ? runHookEnable : runHookDisable;

  await run(dependencies, options, {
    onPreflightPassed: (report) => {
      logger.success(`Database hook layer healthy (${report.target})`);
    },
    // Printed for a dry run too. A preview whose warnings differ from the real run is
    // worse than no preview: it teaches an operator that the dangerous flag is quiet.
    onPreflightSkipped: () => {
      logger.warning('Skipping the database check — the hook layer has NOT been verified.');
      logger.warning(
        'If guard.before_user_created is missing or supabase_auth_admin cannot execute it,',
      );
      logger.warning('every signup on this project will be rejected once the hook is enabled.');
    },
    onRemoteRead: (state) => {
      logger.success(
        `Read Supabase Auth configuration (Before User Created: ${state.enabled ? 'enabled' : 'disabled'})`,
      );
    },
    onPatchSent: () => logger.success('Auth configuration updated'),
    onVerified: () => logger.success('Verified by reading the configuration back'),
  }).then((report) => {
    printHookMutationReport(report, logger);
  });
}
