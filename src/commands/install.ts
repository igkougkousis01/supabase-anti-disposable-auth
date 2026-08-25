/**
 * `install` — creates the database guard layer.
 *
 * Scope in this branch is strictly the database policy engine: connect, run the
 * bundled migrations, report what changed, disconnect. It does NOT configure Supabase
 * Auth, register the Before User Created hook, touch `auth.users`, enable `pg_cron`, or
 * download anything. Those arrive in later branches and are listed in docs/roadmap.md.
 *
 * Running it twice is safe and is the expected way to upgrade: already-applied
 * migrations are skipped, and only genuinely new ones execute.
 */

import type { Command } from 'commander';

import { loadConfig } from '../config/env.js';
import { createPostgresConnection } from '../database/client.js';
import { runMigrations } from '../database/migrations.js';
import type { MigrationFile } from '../database/migration-types.js';
import type { DatabaseConnection, DatabaseConnectionConfig } from '../database/types.js';
import { ConfigurationError } from '../lib/errors.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { Logger } from '../lib/logger.js';
import { CLI_NAME, PRODUCT_NAME } from '../lib/package-info.js';

export interface InstallDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly connect: (config: DatabaseConnectionConfig) => Promise<DatabaseConnection>;
  /** Migrations to apply. Defaults to the bundled `migrations/` directory. */
  readonly files?: MigrationFile[];
}

/** Progress callbacks, so the CLI can report each step as it happens. */
export interface InstallEvents {
  readonly onConnected?: (target: string) => void;
  readonly onMigrationApplied?: (migration: MigrationFile) => void;
}

export interface InstallReport {
  /** Redacted `host:port/database`, safe to print. */
  readonly target: string;
  readonly applied: MigrationFile[];
  readonly skipped: MigrationFile[];
  readonly currentVersion: string | undefined;
}

const MISSING_URL_HINT = `Set SUPABASE_DB_URL (see .env.example) and run \`${CLI_NAME} install\` again.`;

/**
 * Connects, migrates and disconnects.
 *
 * Failures propagate as {@link AppError} subclasses for the CLI's top-level handler to
 * render; the connection is closed either way.
 */
export async function runInstall(
  dependencies: Partial<InstallDependencies> = {},
  events: InstallEvents = {},
): Promise<InstallReport> {
  const env = dependencies.env ?? process.env;
  const connect = dependencies.connect ?? createPostgresConnection;

  const databaseUrl = loadConfig(env).databaseUrl;
  if (databaseUrl === undefined) {
    throw new ConfigurationError('SUPABASE_DB_URL is missing', { hint: MISSING_URL_HINT });
  }

  const connection = await connect({ connectionString: databaseUrl });
  events.onConnected?.(connection.target);

  try {
    const result = await runMigrations(connection, {
      ...(dependencies.files === undefined ? {} : { files: dependencies.files }),
      onApplied: (migration) => events.onMigrationApplied?.(migration),
    });

    return {
      target: connection.target,
      applied: result.applied,
      skipped: result.skipped,
      currentVersion: result.currentVersion,
    };
  } finally {
    // The connection must be released whether or not the migrations succeeded. A
    // close failure here would mask the real error, so it is swallowed deliberately;
    // the process is about to exit and release it anyway.
    await connection.close().catch(() => undefined);
  }
}

/** Prints the closing summary. Per-migration progress is streamed during the run. */
export function printInstallSummary(report: InstallReport, logger: Logger = defaultLogger): void {
  // Nothing to do is a success, not an empty result: say so on one line rather than
  // printing a summary under an empty list of changes.
  if (report.applied.length === 0) {
    logger.success('Database guard layer already up to date.');
    return;
  }

  logger.blank();
  logger.plain('Database guard layer installed.');
}

export function registerInstallCommand(program: Command, logger: Logger = defaultLogger): Command {
  return program
    .command('install')
    .description('Create the guard schema and disposable-domain policy engine in PostgreSQL.')
    .action(async () => {
      logger.plain(PRODUCT_NAME);
      logger.blank();

      const report = await runInstall(
        {},
        {
          onConnected: (target) => logger.success(`Connected to PostgreSQL (${target})`),
          onMigrationApplied: (migration) =>
            logger.success(`Migration ${migration.version}_${migration.name} applied`),
        },
      );

      printInstallSummary(report, logger);
    });
}
