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
import { registerHookCommand } from './commands/hook.js';
import { registerInstallCommand } from './commands/install.js';
import { registerRepairCommand } from './commands/repair.js';
import { registerStatusCommand } from './commands/status.js';
import { registerStrictCommand } from './commands/strict.js';
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
    .showHelpAfterError('(run with --help to see available commands)')
    // The two things a first-time reader needs and the command list cannot tell them:
    // the order the commands go in, and that installing is not the same as enabling.
    .addHelpText(
      'after',
      `
Typical first run:
  $ ${CLI_NAME} doctor        # check the environment and the connection
  $ ${CLI_NAME} install       # create the guard schema and the hook function
  $ ${CLI_NAME} sync          # load the disposable-domain blocklist
  $ ${CLI_NAME} hook enable   # tell Supabase Auth to call it  <- signups are filtered from here
  $ ${CLI_NAME} status        # confirm what is actually enabled

Every command that changes something takes --dry-run. Environment variables are
documented in .env.example. Run \`${CLI_NAME} help <command>\` for detail.`,
    );

  registerDoctorCommand(program, logger);
  registerHookCommand(program, logger);
  registerInstallCommand(program, logger);
  registerRepairCommand(program, logger);
  registerStatusCommand(program, logger);
  registerStrictCommand(program, logger);
  registerSyncCommand(program, logger);
  registerUninstallCommand(program, logger);

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
    // stderr, like the message it belongs to: a hint separated from its error by a
    // redirection is a hint nobody reads.
    logger.detail(detail);
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
