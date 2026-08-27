import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildProgram } from '../../src/cli.js';
import { getPackageVersion } from '../../src/lib/package-info.js';

const EXPECTED_COMMANDS = [
  'doctor',
  'hook',
  'install',
  'repair',
  'status',
  'strict',
  'sync',
  'uninstall',
];

/** Subcommands of `hook`. Registered as a group so later hook operations have a home. */
const EXPECTED_HOOK_SUBCOMMANDS = ['status', 'enable', 'disable'];

/**
 * Subcommands of `strict`.
 *
 * A group rather than a bare `trigger` verb: the name has to say that this is an
 * advanced enforcement mode, not just a database object being toggled.
 */
const EXPECTED_STRICT_SUBCOMMANDS = ['status', 'enable', 'disable'];

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

  it('registers the strict subcommands', () => {
    const strict = buildProgram().commands.find((command) => command.name() === 'strict');

    expect(strict).toBeDefined();
    expect(strict?.commands.map((command) => command.name()).sort()).toEqual(
      [...EXPECTED_STRICT_SUBCOMMANDS].sort(),
    );
  });

  it('gives every strict subcommand a description', () => {
    const strict = buildProgram().commands.find((command) => command.name() === 'strict');

    for (const command of strict?.commands ?? []) {
      expect(command.description()).not.toBe('');
    }
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

  it('shows the first-run workflow, and that installing is not enabling', () => {
    // `helpInformation()` does not render `addHelpText`, so capture what a user sees.
    let rendered = '';
    const program = buildProgram();
    program.configureOutput({
      writeOut: (text) => {
        rendered += text;
      },
    });
    program.outputHelp();

    expect(rendered).toMatch(/doctor/);
    expect(rendered).toMatch(/hook enable/);
    // The whole point of the footer: the ordering, and that `install` alone filters
    // nothing.
    expect(rendered).toMatch(/signups are filtered from here/i);
    expect(rendered).toMatch(/--dry-run/);
  });

  it('warns in `strict enable`s own help, not only in the docs', () => {
    const strict = buildProgram().commands.find((command) => command.name() === 'strict');
    const enable = strict?.commands.find((command) => command.name() === 'enable');

    // Someone about to switch on a fail-closed trigger over auth.users should not have
    // to open a document to find that out.
    expect(enable?.description()).toMatch(/ADVANCED/);
    expect(enable?.description()).toMatch(/fails closed/i);
    expect(enable?.description()).toMatch(/auth\.users/);
  });

  it('marks the dangerous escapes as dangerous where they are typed', () => {
    const program = buildProgram();
    const hookEnable = program.commands
      .find((command) => command.name() === 'hook')
      ?.commands.find((command) => command.name() === 'enable');
    const uninstall = program.commands.find((command) => command.name() === 'uninstall');

    expect(hookEnable?.helpInformation()).toMatch(/--skip-db-check[\s\S]*DANGEROUS/);
    expect(uninstall?.helpInformation()).toMatch(/--database-only[\s\S]*DANGEROUS/);
  });

  it('registers lifecycle safety flags explicitly', () => {
    const program = buildProgram();
    const repair = program.commands.find((command) => command.name() === 'repair');
    const uninstall = program.commands.find((command) => command.name() === 'uninstall');

    expect(repair?.helpInformation()).toContain('--dry-run');
    expect(uninstall?.helpInformation()).toContain('--dry-run');
    expect(uninstall?.helpInformation()).toContain('--yes');
    expect(uninstall?.helpInformation()).toContain('--database-only');
  });
});
