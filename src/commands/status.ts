import type { Command } from 'commander';

import { registerPlaceholderCommand } from './placeholder.js';

export function registerStatusCommand(program: Command): Command {
  return registerPlaceholderCommand(program, {
    name: 'status',
    description: 'Report what is currently installed in the target Supabase project.',
    planned:
      'report the installed version, blocklist size, last refresh time and whether strict enforcement is active.',
  });
}
