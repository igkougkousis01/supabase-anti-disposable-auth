/**
 * The migration freeze.
 *
 * Every migration below has been applied to real databases and its checksum recorded in
 * `guard.schema_migrations`. Changing one byte of an applied file makes the runner
 * report tamper detection on every installation that already has it -- correctly, and
 * unhelpfully, because the operator did nothing wrong.
 *
 * So these files are frozen. A fix to installed SQL is a NEW migration (`009_...`),
 * never an edit to a historical one, and this test is what makes an accidental edit
 * fail in CI rather than in somebody's production database.
 *
 * If a checksum here needs to change, that is a deliberate breaking decision and the
 * reasoning belongs in the pull request, not in a one-line hash update.
 *
 * Checksums are computed exactly as `calculateChecksum` computes them, including the
 * CRLF normalisation, so a Windows checkout produces the same values.
 */

import { describe, expect, it } from 'vitest';

import { calculateChecksum, loadMigrationFiles } from '../../src/database/migrations.js';

/** version_name -> sha256, as recorded in `guard.schema_migrations`. */
const FROZEN_CHECKSUMS: ReadonlyMap<string, string> = new Map([
  [
    '001_create_domain_functions',
    '1fa3281e9df7520eebe989835139d6fd4604833aa2a3f5fb3f09d00e3afd7463',
  ],
  ['002_create_domain_tables', 'b81b9fb5e73f2d660d077c739a67fa36973629198b37746df3070a29c0a06fde'],
  [
    '003_create_metadata_tables',
    '346d364021a3aa6d672661787c6026dfa65690c80d10d2619f41c7d58ff504e1',
  ],
  [
    '004_create_lookup_functions',
    '6df1088d10c4fdbf482b5afe8116a83b2395944ac8d6e9b306a34cb6f042ced3',
  ],
  ['005_permissions', 'fdf56664a20e2ebcdff3c88d7b04dbceb1f31032a54a4e463ed40d8d152133a1'],
  [
    '006_create_before_user_created_hook',
    '6e183d800fc4a3e80c4911128313a1220c72bfe6e2b575947c9cd2e162720966',
  ],
  ['007_auth_hook_permissions', '2a49b85361364283c900117aa7c4b34c8e4bb3a0499602ccf60dbcc2c8d81916'],
  [
    '008_create_strict_trigger_function',
    'b8d04f5e9acdd8bc00f0f022757bfcf755631ecdae46eab1360df4fab4545799',
  ],
]);

describe('the shipped migrations', () => {
  it('are byte-for-byte the files released installations already applied', async () => {
    const files = await loadMigrationFiles();
    const actual = new Map(files.map((file) => [`${file.version}_${file.name}`, file.checksum]));

    expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(FROZEN_CHECKSUMS));
  });

  it('gains new migrations by addition only, never by renaming a frozen one', async () => {
    const files = await loadMigrationFiles();

    // A migration may be added after 008; none of 001-008 may disappear or be renamed.
    for (const key of FROZEN_CHECKSUMS.keys()) {
      expect(files.some((file) => `${file.version}_${file.name}` === key)).toBe(true);
    }
  });

  it('checksums the way the runner records them, CRLF included', async () => {
    const [first] = await loadMigrationFiles();

    expect(first).toBeDefined();
    expect(calculateChecksum(first?.sql ?? '')).toBe(first?.checksum);
    expect(calculateChecksum('select 1;\r\n')).toBe(calculateChecksum('select 1;\n'));
  });
});
