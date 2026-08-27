/**
 * Live database checks for the connection layer.
 *
 * Read-only: connects, reads `server_version`, closes. Nothing is created, altered or
 * dropped.
 *
 * Even so, this suite gates on SADA_TEST_DB_URL and never on SUPABASE_DB_URL, for the
 * same reason every other suite in this directory does: a test run must never reach for
 * the credential the CLI uses against a real project. The rule is worth more than the
 * blast radius of any single test — an invariant with one exception is not an invariant,
 * and the next person to copy this file would inherit the exception.
 *
 *   SADA_TEST_DB_URL="postgresql://localhost:5432/supabase_anti_disposable_auth_test" \
 *     npm run test:integration
 */

import { describe, expect, it } from 'vitest';

import { PostgresClient, readServerVersion } from '../../src/database/client.js';

const testDatabaseUrl = process.env['SADA_TEST_DB_URL'];
const describeIfConfigured = testDatabaseUrl === undefined ? describe.skip : describe;

describeIfConfigured('PostgresClient against a live database', () => {
  it('connects, reports a server version and closes cleanly', async () => {
    const client = new PostgresClient({ connectionString: testDatabaseUrl as string });

    try {
      await client.connect();
      expect(client.isConnected).toBe(true);

      const version = await readServerVersion(client);
      expect(version.major).toBeGreaterThanOrEqual(13);
    } finally {
      await client.close();
    }

    expect(client.isConnected).toBe(false);
  }, 30_000);

  it('never exposes the connection string through its target description', () => {
    const client = new PostgresClient({ connectionString: testDatabaseUrl as string });
    expect(client.target).not.toContain('@');
  });
});
