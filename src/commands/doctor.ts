/**
 * `doctor` — validates the local environment.
 *
 * Scope in this branch is deliberately narrow: it checks the runtime, the
 * configuration and, when a connection string is supplied, that PostgreSQL is
 * reachable. It never inspects or modifies any schema.
 *
 * Checks run in order and stop at the first failure, so the output reads as a
 * checklist rather than a wall of cascading errors.
 */

import type { Command } from 'commander';

import { isSupportedNodeVersion, loadConfig, MINIMUM_NODE_VERSION_LABEL } from '../config/env.js';
import { createPostgresConnection, readServerVersion } from '../database/client.js';
import type { DatabaseConnection, DatabaseConnectionConfig } from '../database/types.js';
import { AppError, ConfigurationError, formatErrorForUser } from '../lib/errors.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { Logger } from '../lib/logger.js';
import { CLI_NAME, PRODUCT_NAME } from '../lib/package-info.js';

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  readonly status: DoctorCheckStatus;
  readonly message: string;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly checks: DoctorCheck[];
  /** Present when a check failed. Carries the exit code and the user-facing hint. */
  readonly failure?: AppError;
}

export interface DoctorDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly nodeVersion: string;
  readonly connect: (config: DatabaseConnectionConfig) => Promise<DatabaseConnection>;
}

const MISSING_URL_HINT = `Set SUPABASE_DB_URL (see .env.example) and run \`${CLI_NAME} doctor\` again.`;

export async function runDoctor(
  dependencies: Partial<DoctorDependencies> = {},
): Promise<DoctorReport> {
  const env = dependencies.env ?? process.env;
  const nodeVersion = dependencies.nodeVersion ?? process.versions.node;
  const connect = dependencies.connect ?? createPostgresConnection;

  const checks: DoctorCheck[] = [];

  if (!isSupportedNodeVersion(nodeVersion)) {
    return failed(
      checks,
      new ConfigurationError(`Node.js v${nodeVersion} is not supported`, {
        hint: `Install Node.js ${MINIMUM_NODE_VERSION_LABEL} or newer and try again.`,
      }),
    );
  }
  checks.push({
    status: 'pass',
    message: `Node.js v${nodeVersion} supported (requires >= ${MINIMUM_NODE_VERSION_LABEL})`,
  });

  let databaseUrl: string | undefined;
  try {
    databaseUrl = loadConfig(env).databaseUrl;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return failed(checks, error);
    }
    throw error;
  }

  if (databaseUrl === undefined) {
    return failed(
      checks,
      new ConfigurationError('SUPABASE_DB_URL is missing', { hint: MISSING_URL_HINT }),
    );
  }
  checks.push({ status: 'pass', message: 'Configuration loaded' });

  let connection: DatabaseConnection;
  try {
    connection = await connect({ connectionString: databaseUrl });
  } catch (error) {
    if (error instanceof AppError) {
      return failed(checks, error);
    }
    throw error;
  }
  checks.push({
    status: 'pass',
    message: `PostgreSQL connection successful (${connection.target})`,
  });

  try {
    const version = await readServerVersion(connection);
    checks.push({ status: 'pass', message: `PostgreSQL ${version.full} detected` });
  } catch (error) {
    if (error instanceof AppError) {
      return failed(checks, error);
    }
    throw error;
  } finally {
    // The connection must always be released, but a failure to close is not itself a
    // reason to fail the health check.
    try {
      await connection.close();
    } catch (error) {
      checks.push({
        status: 'warn',
        message: error instanceof AppError ? error.message : 'Failed to close the connection',
      });
    }
  }

  return { ok: true, checks };
}

export interface PrintDoctorReportOptions {
  /** Append diagnostics for the failing check. Never includes credentials. */
  readonly debug?: boolean;
}

export function printDoctorReport(
  report: DoctorReport,
  logger: Logger = defaultLogger,
  options: PrintDoctorReportOptions = {},
): void {
  logger.plain(PRODUCT_NAME);
  logger.blank();

  for (const check of report.checks) {
    switch (check.status) {
      case 'pass':
        logger.success(check.message);
        break;
      case 'warn':
        logger.warning(check.message);
        break;
      case 'fail':
        logger.error(check.message);
        break;
    }
  }

  logger.blank();

  if (report.ok) {
    logger.plain('Environment looks healthy.');
    return;
  }

  logger.plain(report.failure?.hint ?? 'Fix the issue above and try again.');

  if (options.debug === true && report.failure) {
    // formatErrorForUser() leads with the message and, when present, the hint. Both
    // have already been printed above, so only the diagnostics tail is new here.
    const alreadyPrinted = report.failure.hint === undefined ? 1 : 2;
    for (const line of formatErrorForUser(report.failure, { debug: true }).slice(alreadyPrinted)) {
      logger.plain(line);
    }
  }
}

export function registerDoctorCommand(program: Command, logger: Logger = defaultLogger): Command {
  return program
    .command('doctor')
    .description('Check that the local environment and database connection are usable.')
    .action(async (_options: unknown, command: Command) => {
      const debug = command.parent?.opts<{ debug?: boolean }>().debug === true;

      const report = await runDoctor();
      printDoctorReport(report, logger, { debug });

      if (!report.ok && report.failure) {
        process.exitCode = report.failure.exitCode;
      }
    });
}

function failed(checks: DoctorCheck[], failure: AppError): DoctorReport {
  checks.push({ status: 'fail', message: failure.message });
  return { ok: false, checks, failure };
}
