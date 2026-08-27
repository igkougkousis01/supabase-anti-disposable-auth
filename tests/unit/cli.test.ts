import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildProgram } from '../../src/cli.js';
import { getPackageVersion } from '../../src/lib/package-info.js';

const EXPECTED_COMMANDS = ['doctor', 'hook', 'install', 'status', 'sync', 'uninstall'];

/** Subcommands of `hook`. Registered as a group so later hook operations have a home. */
const EXPECTED_HOOK_SUBCOMMANDS = ['status', 'enable', 'disable'];

describe('buildProgram', () => {
  it('registers every planned command exactly once', () => {
    const names = buildProgram().commands.map((command) => command.name());
    expect(names.sort()).toEqual([...EXPECTED_COMMANDS].sort());
  });

  it('gives every command a description', () => {
    for (const command of buildProgram().commands) {
      expect(command.description()).not.toBe('');
    }
  });

  it('is named so it can be invoked as the published binary', () => {
    expect(buildProgram().name()).toBe('supabase-anti-disposable-auth');
  });

  it('reports the version from package.json', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

    expect(getPackageVersion()).toBe(packageJson.version);
    expect(buildProgram().version()).toBe(packageJson.version);
  });

  it('registers the hook subcommands', () => {
    const hook = buildProgram().commands.find((command) => command.name() === 'hook');

    expect(hook).toBeDefined();
    expect(hook?.commands.map((command) => command.name()).sort()).toEqual(
      [...EXPECTED_HOOK_SUBCOMMANDS].sort(),
    );
  });

  it('gives every hook subcommand a description', () => {
    const hook = buildProgram().commands.find((command) => command.name() === 'hook');

    for (const command of hook?.commands ?? []) {
      expect(command.description()).not.toBe('');
    }
  });

  it('lists all commands in --help output', () => {
    const help = buildProgram().helpInformation();

    for (const command of EXPECTED_COMMANDS) {
      expect(help).toContain(command);
    }
    expect(help).toContain('--version');
  });
});
