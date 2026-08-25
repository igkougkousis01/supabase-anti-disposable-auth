/**
 * Registration helper for commands that are planned but not implemented yet.
 *
 * These commands print what they will eventually do and exit with
 * `EXIT_CODES.notImplemented` so scripts cannot mistake them for a successful run.
 */

import type { Command } from 'commander';

import { EXIT_CODES } from '../lib/errors.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { Logger } from '../lib/logger.js';
import { CLI_NAME } from '../lib/package-info.js';

export interface PlaceholderCommandOptions {
  readonly name: string;
  readonly description: string;
  /** One line describing what the command will do once implemented. */
  readonly planned: string;
}

export function registerPlaceholderCommand(
  program: Command,
  options: PlaceholderCommandOptions,
  logger: Logger = defaultLogger,
): Command {
  return program
    .command(options.name)
    .description(options.description)
    .action(() => {
      logger.warning(`Not implemented yet: \`${CLI_NAME} ${options.name}\`.`);
      logger.plain(`Planned behaviour: ${options.planned}`);
      logger.plain('See docs/roadmap.md for the delivery order.');
      process.exitCode = EXIT_CODES.notImplemented;
    });
}
