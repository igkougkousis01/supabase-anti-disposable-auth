#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * Building the program is separated from running it so tests can inspect the
 * registered commands without executing anything.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { Command } from 'commander';

import { registerDoctorCommand } from './commands/doctor.js';
import { registerInstallCommand } from './commands/install.js';
import { registerStatusCommand } from './commands/status.js';
import { registerSyncCommand } from './commands/sync.js';
import { registerUninstallCommand } from './commands/uninstall.js';
import { loadEnvFileIfPresent } from './config/env.js';
import { EXIT_CODES, formatErrorForUser, toAppError } from './lib/errors.js';
import { logger as defaultLogger } from './lib/logger.js';
import type { Logger } from './lib/logger.js';
import { CLI_NAME, getPackageVersion, PRODUCT_DESCRIPTION } from './lib/package-info.js';

export function buildProgram(logger: Logger = defaultLogger): Command {
  const program = new Command();

  program
    .name(CLI_NAME)
    .description(PRODUCT_DESCRIPTION)
    .version(getPackageVersion(), '-v, --version', 'Print the CLI version.')
    .option('--debug', 'Include diagnostic details when something goes wrong.', false)
    .showHelpAfterError('(run with --help to see available commands)');

  registerDoctorCommand(program, logger);
  registerInstallCommand(program);
  registerStatusCommand(program);
  registerSyncCommand(program);
  registerUninstallCommand(program);

  return program;
}

export async function run(
  argv: string[] = process.argv,
  logger: Logger = defaultLogger,
): Promise<void> {
  const program = buildProgram(logger);

  if (argv.length <= 2) {
    program.outputHelp();
    return;
  }

  try {
    loadEnvFileIfPresent();
    await program.parseAsync(argv);
  } catch (error) {
    reportFatalError(error, program.opts<{ debug?: boolean }>().debug === true, logger);
  }
}

function reportFatalError(error: unknown, debug: boolean, logger: Logger): void {
  const appError = toAppError(error);
  const [message, ...details] = formatErrorForUser(appError, { debug });

  logger.error(message ?? 'Unexpected error');
  for (const detail of details) {
    logger.plain(detail);
  }

  process.exitCode = appError.exitCode ?? EXIT_CODES.unexpected;
}

/**
 * True when this file is the process entry point rather than an imported module.
 *
 * `argv[1]` is resolved through `realpath` because npm installs the `bin` as a
 * symlink, while Node reports the resolved path in `import.meta.url`.
 */
function isProcessEntryPoint(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }

  try {
    return pathToFileURL(realpathSync(entry)).href === moduleUrl;
  } catch {
    return false;
  }
}

if (isProcessEntryPoint(import.meta.url)) {
  await run();
}
