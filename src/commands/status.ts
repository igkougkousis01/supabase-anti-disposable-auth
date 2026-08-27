/**
 * `status` — reports what is actually installed in the target database.
 *
 * Read-only: it creates and modifies nothing, so it is safe against any database.
 *
 * The report covers the database layer only, because the database layer is all that
 * exists. Features that are not built yet are listed as "not configured" with a hollow
 * marker rather than omitted, so the output is an honest picture of the whole product
 * instead of an implied claim that signups are already protected.
 *
 * The auth-hook section is where that rule earns its keep. `status` can see that the
 * hook FUNCTION exists and that `supabase_auth_admin` can execute it; it cannot see
 * whether Supabase Auth has been configured to call it, because that configuration
 * lives in the Auth service, not in PostgreSQL. Those two facts are printed as two
 * separate lines and the second is never inferred from the first.
 */

import type { Command } from 'commander';

import { loadConfig } from '../config/env.js';
import { createPostgresConnection } from '../database/client.js';
import { AUTH_HOOK_ROLE, readGuardSchemaStatus } from '../database/schema-status.js';
import type { GuardSchemaStatus } from '../database/schema-status.js';
import type { MigrationFile } from '../database/migration-types.js';
import type { DatabaseConnection, DatabaseConnectionConfig } from '../database/types.js';
import { ConfigurationError, EXIT_CODES } from '../lib/errors.js';
import type { ExitCode } from '../lib/errors.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { Logger } from '../lib/logger.js';
import { CLI_NAME, PRODUCT_NAME } from '../lib/package-info.js';

export interface StatusDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly connect: (config: DatabaseConnectionConfig) => Promise<DatabaseConnection>;
  /** Migrations to compare against. Defaults to the bundled `migrations/` directory. */
  readonly files?: MigrationFile[];
}

export interface StatusReport {
  /** Redacted `host:port/database`, safe to print. */
  readonly target: string;
  readonly schema: GuardSchemaStatus;
}

const MISSING_URL_HINT = `Set SUPABASE_DB_URL (see .env.example) and run \`${CLI_NAME} status\` again.`;

export async function runStatus(
  dependencies: Partial<StatusDependencies> = {},
): Promise<StatusReport> {
  const env = dependencies.env ?? process.env;
  const connect = dependencies.connect ?? createPostgresConnection;

  const databaseUrl = loadConfig(env).databaseUrl;
  if (databaseUrl === undefined) {
    throw new ConfigurationError('SUPABASE_DB_URL is missing', { hint: MISSING_URL_HINT });
  }

  const connection = await connect({ connectionString: databaseUrl });

  try {
    return {
      target: connection.target,
      schema: await readGuardSchemaStatus(connection, {
        ...(dependencies.files === undefined ? {} : { files: dependencies.files }),
      }),
    };
  } finally {
    await connection.close().catch(() => undefined);
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
    printPlannedSections(logger);
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
  printPlannedSections(logger, schema);
  logger.blank();

  if (!incomplete) {
    logger.plain('Database guard layer is up to date.');
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
  //
  // The most likely way to arrive here is the one case the conditional migration
  // cannot cover: 007 ran on a database where `supabase_auth_admin` did not exist
  // yet, took its no-op branch, and was recorded as applied. Creating the role
  // afterwards does not retroactively produce the grants. See the README section
  // this points at.
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
 * `schema` is `undefined` when nothing is installed at all, in which case there is no
 * database state to describe and the whole section is reported as absent.
 */
function printPlannedSections(logger: Logger, schema?: GuardSchemaStatus): void {
  logger.plain('Before User Created Hook');
  printHookSection(logger, schema);
  logger.blank();
  logger.plain('Automatic sync');
  logger.pending('Not configured (not implemented yet)');
}

/**
 * Reports the two independent facts about the hook, and refuses to conflate them.
 *
 * Installing the function and activating the hook are different events with different
 * owners: `install` does the first, a human (or a later branch) does the second in
 * Supabase. Until activation is verifiable, the second line is always a hollow
 * "not verified" -- never a tick, and never omitted.
 */
function printHookSection(logger: Logger, schema?: GuardSchemaStatus): void {
  if (schema === undefined || !schema.hookFunctionInstalled) {
    logger.pending('Function not installed (guard.before_user_created(jsonb))');
  } else {
    logger.success('Function installed: guard.before_user_created(jsonb)');
  }

  if (schema !== undefined) {
    printHookGrants(logger, schema);
  }

  // Deliberately unconditional and deliberately hollow. Nothing in this branch can
  // observe the Supabase Auth configuration, so nothing here may imply it is on.
  logger.pending('Supabase activation not verified (configure the hook in Supabase)');
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
 * Only the guard layer's own health is expressed here. Configuration and database
 * failures never reach this function: they are thrown as {@link AppError} subclasses and
 * keep their own exit codes via the CLI's top-level handler, which is what lets a CI job
 * distinguish "cannot reach the database" from "reached it, guard layer is broken".
 */
export function statusExitCode(report: StatusReport): ExitCode {
  return report.schema.health === 'complete' ? EXIT_CODES.success : EXIT_CODES.guardHealth;
}

export function registerStatusCommand(
  program: Command,
  logger: Logger = defaultLogger,
  // Injected only by tests, so the exit-code wiring itself can be exercised.
  dependencies: Partial<StatusDependencies> = {},
): Command {
  return program
    .command('status')
    .description('Report the state of the guard schema in the target database.')
    .action(async () => {
      const report = await runStatus(dependencies);
      printStatusReport(report, logger);
      process.exitCode = statusExitCode(report);
    });
}
