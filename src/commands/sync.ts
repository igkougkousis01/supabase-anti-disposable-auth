import type { Command } from 'commander';

import { registerPlaceholderCommand } from './placeholder.js';

export function registerSyncCommand(program: Command): Command {
  return registerPlaceholderCommand(program, {
    name: 'sync',
    description: 'Refresh the disposable-domain blocklist stored in the database.',
    planned:
      'download the upstream disposable-domain list and reconcile it with the blocklist table.',
  });
}
