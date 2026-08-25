import type { Command } from 'commander';

import { registerPlaceholderCommand } from './placeholder.js';

export function registerUninstallCommand(program: Command): Command {
  return registerPlaceholderCommand(program, {
    name: 'uninstall',
    description: 'Remove the disposable-email protection this CLI installed.',
    planned:
      'unregister the auth hook and drop the guard schema, after showing exactly what will be removed.',
  });
}
