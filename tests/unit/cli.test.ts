import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildProgram } from '../../src/cli.js';
import { getPackageVersion } from '../../src/lib/package-info.js';

const EXPECTED_COMMANDS = ['doctor', 'install', 'status', 'sync', 'uninstall'];

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

  it('lists all commands in --help output', () => {
    const help = buildProgram().helpInformation();

    for (const command of EXPECTED_COMMANDS) {
      expect(help).toContain(command);
    }
    expect(help).toContain('--version');
  });
});
