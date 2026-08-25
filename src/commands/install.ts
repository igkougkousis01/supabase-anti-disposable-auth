import type { Command } from 'commander';

import { registerPlaceholderCommand } from './placeholder.js';

export function registerInstallCommand(program: Command): Command {
  return registerPlaceholderCommand(program, {
    name: 'install',
    description: 'Install disposable-email protection into the target Supabase project.',
    planned:
      'create the guard schema, blocklist tables and lookup function, then register the Before User Created auth hook.',
  });
}
