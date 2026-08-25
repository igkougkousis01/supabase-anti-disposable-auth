/**
 * Live database checks.
 *
 * These never run unless SUPABASE_DB_URL is set, so `npm test` and CI stay offline.
 * Run them explicitly with:
 *
 *   SUPABASE_DB_URL="postgresql://..." npm run test:integration
 */

import { describe, expect, it } from 'vitest';

import { PostgresClient, readServerVersion } from '../../src/database/client.js';
import { loadConfig } from '../../src/config/env.js';

const databaseUrl = loadConfig().databaseUrl;
const describeIfConfigured = databaseUrl === undefined ? describe.skip : describe;

describeIfConfigured('PostgresClient against a live database', () => {
  it('connects, reports a server version and closes cleanly', async () => {
    const client = new PostgresClient({ connectionString: databaseUrl as string });

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
    const client = new PostgresClient({ connectionString: databaseUrl as string });
    expect(client.target).not.toContain('@');
  });
});
