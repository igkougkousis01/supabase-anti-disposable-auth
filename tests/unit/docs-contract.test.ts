/**
 * The documentation contract.
 *
 * Two tables in the README describe things a user's scripts depend on: the exit codes
 * and the environment variables. Both are easy to change in code and forget in prose,
 * and a wrong exit-code table is worse than no table -- it is a promise a CI job will
 * act on.
 *
 * These tests parse the published tables and compare them against the code. They are the
 * reason the README can be trusted at 1.0 without a manual re-read before every release.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { KNOWN_ENVIRONMENT_VARIABLES } from '../../src/config/env.js';
import { EXIT_CODES } from '../../src/lib/errors.js';

const README = readFileSync('README.md', 'utf8');

/** Test-only variables. Never read by `src/`, deliberately named apart from the runtime set. */
const TEST_ONLY_VARIABLES = [
  'SADA_TEST_DB_URL',
  'SADA_TEST_SUPABASE_PROJECT_REF',
  'SADA_TEST_SUPABASE_ACCESS_TOKEN',
  'SADA_ALLOW_REMOTE_MUTATION_TESTS',
] as const;

function section(heading: string): string {
  const start = README.indexOf(`\n## ${heading}\n`);
  expect(start, `README is missing a "## ${heading}" section`).toBeGreaterThan(-1);

  const rest = README.slice(start + 1);
  const end = rest.indexOf('\n## ', 1);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Every `| \`x\` | ... |` row's first cell, in order. */
function firstColumnCodes(markdown: string): string[] {
  return [...markdown.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((match) => match[1] ?? '');
}

describe('the README exit-code table', () => {
  const documented = firstColumnCodes(section('Exit codes'));

  it('documents every code the CLI can produce, and no others', () => {
    // `reserved` is documented as reserved and never emitted; it still belongs in the
    // table, because leaving a gap invites the next command to reuse the number.
    const inCode = [...new Set(Object.values(EXIT_CODES))].sort((a, b) => a - b);

    expect(documented.map(Number).sort((a, b) => a - b)).toEqual(inCode);
  });

  it('lists the codes in ascending order, without duplicates', () => {
    const numbers = documented.map(Number);

    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('names 4 as reserved rather than describing behaviour it no longer has', () => {
    const row = /^\|\s*`4`\s*\|([^|]*)\|/m.exec(section('Exit codes'));

    expect(row?.[1]).toMatch(/reserved/i);
    expect(row?.[1]).not.toMatch(/not implemented/i);
  });
});

describe('the README environment-variable tables', () => {
  const documented = firstColumnCodes(section('Environment variables'));

  it('documents every variable the CLI reads', () => {
    for (const name of KNOWN_ENVIRONMENT_VARIABLES) {
      expect(documented).toContain(name);
    }
  });

  it('documents the test-only variables, and marks them as test-only', () => {
    const markdown = section('Environment variables');

    for (const name of TEST_ONLY_VARIABLES) {
      expect(documented).toContain(name);
    }
    expect(markdown).toMatch(/\*\*Test-only\*\*/);
  });

  it('documents nothing the code does not use', () => {
    const known: string[] = [...KNOWN_ENVIRONMENT_VARIABLES, ...TEST_ONLY_VARIABLES];

    for (const name of documented) {
      expect(known).toContain(name);
    }
  });

  it('keeps the runtime and test-only sets disjoint, so a test can never read a real credential', () => {
    for (const name of TEST_ONLY_VARIABLES) {
      expect(KNOWN_ENVIRONMENT_VARIABLES as readonly string[]).not.toContain(name);
    }
  });
});

describe('the README', () => {
  it('hardcodes no release version of its own', () => {
    // `--version` reads package.json at runtime, and there is exactly one place the
    // number lives. A `1.0.0` written into prose is a second place to get it wrong at
    // the next release. Two-part numbers ("Node.js 22", "1.0 ships no scheduler")
    // are fine -- they are the things they describe, not a package version.
    const semverInProse = README.match(/\bv?\d+\.\d+\.\d+\b/g) ?? [];

    expect(semverInProse).toEqual([]);
  });

  it('does not describe implemented features as unfinished', () => {
    expect(README).not.toMatch(/not implemented|coming soon|\bTODO\b|early development/i);
  });

  it('names the repository correctly wherever it links to it', () => {
    for (const [, owner] of README.matchAll(/github\.com\/([\w-]+\/[\w-]+)/g)) {
      expect([
        'igkougkousis01/supabase-anti-disposable-auth',
        'disposable/disposable-email-domains',
      ]).toContain(owner);
    }
  });
});
