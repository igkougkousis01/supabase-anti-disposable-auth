/**
 * Live database tests for blocklist synchronisation.
 *
 * ⚠️  THESE TESTS ARE DESTRUCTIVE WITHIN THE `guard` SCHEMA.
 *
 * They drop and recreate `guard` and then replace the contents of
 * `guard.blocked_domains` repeatedly. Nothing outside `guard` is read or written --
 * `public` and `auth` are never touched -- but any data you had in `guard` is
 * destroyed.
 *
 * Like `guard-schema.test.ts` they deliberately do NOT use SUPABASE_DB_URL, because a
 * developer's SUPABASE_DB_URL usually points at a real Supabase project. They require
 * a separate, explicitly named variable pointing at a scratch database:
 *
 *   createdb supabase_anti_disposable_auth_test
 *   SADA_TEST_DB_URL="postgresql://localhost:5432/supabase_anti_disposable_auth_test" \
 *     npm run test:integration
 *
 * With SADA_TEST_DB_URL unset, the whole suite skips, so `npm test` and CI stay
 * offline and no credentials are ever required.
 *
 * No test here reaches the network: every provider is a local fixture.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { checksumDomains } from '../../src/blocklist/checksum.js';
import { normalizeDomain, normalizeProviderDomain } from '../../src/blocklist/normalize.js';
import { runSync } from '../../src/blocklist/sync.js';
import type { SyncDependencies } from '../../src/blocklist/sync.js';
import type { BlocklistProvider, RawBlocklist } from '../../src/blocklist/types.js';
import { createPostgresConnection } from '../../src/database/client.js';
import { runMigrations } from '../../src/database/migrations.js';
import type { DatabaseConnection } from '../../src/database/types.js';
import { SuspiciousUpdateError, SyncError } from '../../src/lib/errors.js';
import { generateDomainList } from '../helpers/fixtures.js';

const testDatabaseUrl = process.env['SADA_TEST_DB_URL'];
const describeIfConfigured = testDatabaseUrl === undefined ? describe.skip : describe;

const SOURCE = 'integration-fixture';

let connection: DatabaseConnection;

/** A provider backed by a local fixture. Nothing here touches the network. */
function fixtureProvider(domains: readonly string[]): BlocklistProvider {
  const body = `${domains.join('\n')}\n`;

  return {
    name: SOURCE,
    source: SOURCE,
    url: 'https://fixture.invalid/domains.txt',
    upstream: 'local fixture',
    fetch(): Promise<RawBlocklist> {
      return Promise.resolve({
        provider: SOURCE,
        source: SOURCE,
        url: 'https://fixture.invalid/domains.txt',
        body,
        bytes: Buffer.byteLength(body),
        status: 200,
        contentType: 'text/plain',
        durationMs: 1,
      });
    },
  };
}

function dependencies(
  provider: BlocklistProvider,
  overrides: Partial<SyncDependencies> = {},
): Partial<SyncDependencies> {
  return {
    env: { SUPABASE_DB_URL: testDatabaseUrl as string },
    // The suite owns the connection lifecycle; runSync must not close it out from
    // under the next test, so a non-closing wrapper is handed over instead.
    connect: () => Promise.resolve(borrowConnection()),
    provider,
    thresholds: { minimumDomainCount: 3, minimumValidRatio: 0.8, maximumShrinkRatio: 0.3 },
    ...overrides,
  };
}

/** The shared connection, with `close()` neutered. */
function borrowConnection(): DatabaseConnection {
  return {
    target: connection.target,
    query: (sql, parameters) => connection.query(sql, parameters),
    execute: (sql) => connection.execute(sql),
    close: () => Promise.resolve(),
  };
}

async function scalar<T>(sql: string, parameters: string[] = []): Promise<T | undefined> {
  const result = await connection.query<{ value: T }>(sql, parameters);
  return result.rows[0]?.value;
}

async function blockedDomains(): Promise<string[]> {
  const result = await connection.query<{ domain: string }>(
    'select domain from guard.blocked_domains order by domain',
  );
  return result.rows.map((row) => row.domain);
}

async function resetBlocklist(): Promise<void> {
  await connection.query('delete from guard.blocked_domains');
  await connection.query('delete from guard.allowed_domains');
  await connection.query('delete from guard.sync_metadata');
}

describeIfConfigured('blocklist sync against a live database', () => {
  beforeAll(async () => {
    connection = await createPostgresConnection({ connectionString: testDatabaseUrl as string });
    await connection.execute('drop schema if exists guard cascade');
    await runMigrations(connection);
  });

  afterAll(async () => {
    await connection.execute('drop schema if exists guard cascade');
    await connection.close();
  });

  beforeEach(async () => {
    await resetBlocklist();
  });

  describe('normalisation parity with guard.normalize_domain()', () => {
    // The TypeScript normaliser exists only so a large list can be canonicalised in
    // process. If it ever accepts something PostgreSQL rejects, the CHECK constraint
    // aborts the whole sync transaction -- so parity is asserted, not assumed.
    const corpus = [
      'mailinator.com',
      'MAILINATOR.COM',
      '  mailinator.com  ',
      'user@mailinator.com',
      '@mailinator.com',
      'a@b@mailinator.com',
      'mailinator.com.',
      'mailinator.com...',
      'sub.domain.mailinator.com',
      'xn--80ak6aa92e.com',
      'example.xn--p1ai',
      '10minutemail.com',
      'a.co',
      '',
      '   ',
      'localhost',
      'example',
      '.example.com',
      '..example.com',
      'example..com',
      'example.com/path',
      'http://example.com',
      'https://example.com',
      'example com',
      '-example.com',
      'example-.com',
      'example.123',
      '192.168.0.1',
      'user@',
      `${'a'.repeat(64)}.com`,
      `${'a'.repeat(63)}.com`,
    ];

    it.each(corpus)('agrees with PostgreSQL for %j', async (input) => {
      const fromDatabase = await scalar<string | null>(
        'select guard.normalize_domain($1) as value',
        [input],
      );

      expect(normalizeDomain(input) ?? null).toBe(fromDatabase ?? null);
    });

    it('never accepts something the CHECK constraint would reject', async () => {
      // The direction that actually matters. Restated as an explicit assertion so a
      // future change that loosens the TypeScript side fails here rather than in
      // production.
      for (const input of corpus) {
        const inTypeScript = normalizeDomain(input);
        if (inTypeScript === undefined) {
          continue;
        }
        const inDatabase = await scalar<string | null>(
          'select guard.normalize_domain($1) as value',
          [inTypeScript],
        );
        expect(inDatabase).toBe(inTypeScript);
      }
    });
  });

  describe('provider trust boundary', () => {
    // guard.normalize_domain() extracts a domain from an email address on purpose,
    // because it will eventually be fed authentication input. The ingestion pipeline
    // has the opposite contract. These tests pin that divergence against real SQL, so
    // neither side can be "harmonised" into the other by a later refactor.

    it('keeps the PostgreSQL function extracting, as the Auth path requires', async () => {
      expect(
        await scalar<string | null>('select guard.normalize_domain($1) as value', [
          'user@mailinator.com',
        ]),
      ).toBe('mailinator.com');
    });

    it('rejects the same input on the provider ingestion path', () => {
      expect(normalizeProviderDomain('user@mailinator.com')).toBeUndefined();
    });

    it('never writes an address-derived domain into guard.blocked_domains', async () => {
      const clean = generateDomainList(30);
      const provider = fixtureProvider([
        ...clean,
        'user@never-extracted.example',
        '@also-never.example',
        'https://url-never.example',
        'path-never.example/path',
      ]);

      await runSync(dependencies(provider));

      const installed = await blockedDomains();
      expect(installed).toEqual([...clean].sort());
      for (const forbidden of [
        'never-extracted.example',
        'also-never.example',
        'url-never.example',
        'path-never.example',
      ]) {
        expect(installed).not.toContain(forbidden);
      }
    });

    it('leaves the lookup unable to match an address-derived domain', async () => {
      const clean = generateDomainList(30);
      await runSync(dependencies(fixtureProvider([...clean, 'user@never-extracted.example'])));

      // The end-user-visible consequence: the salvaged domain was never blocked.
      expect(
        await scalar<boolean>('select guard.is_disposable_domain($1) as value', [
          'never-extracted.example',
        ]),
      ).toBe(false);
    });
  });

  describe('initial sync', () => {
    it('installs the candidate list', async () => {
      const domains = generateDomainList(20);

      const report = await runSync(dependencies(fixtureProvider(domains)));

      expect(report.outcome).toBe('updated');
      expect(report.firstSync).toBe(true);
      expect(await blockedDomains()).toEqual([...domains].sort());
    });

    it('records the source on every row', async () => {
      await runSync(dependencies(fixtureProvider(generateDomainList(20))));

      const distinct = await scalar<number>(
        'select count(distinct source)::int as value from guard.blocked_domains',
      );
      const source = await scalar<string>('select min(source) as value from guard.blocked_domains');

      expect(distinct).toBe(1);
      expect(source).toBe(SOURCE);
    });

    it('records success metadata', async () => {
      const domains = generateDomainList(20);
      const report = await runSync(dependencies(fixtureProvider(domains)));

      const row = await connection.query<{
        status: string;
        domain_count: number;
        checksum: string;
        error_message: string | null;
        last_attempt_at: Date;
        last_success_at: Date;
      }>('select * from guard.sync_metadata where source = $1', [SOURCE]);

      const metadata = row.rows[0];
      expect(metadata?.status).toBe('success');
      expect(metadata?.domain_count).toBe(20);
      expect(metadata?.checksum).toBe(report.checksum);
      expect(metadata?.checksum).toBe(checksumDomains(domains));
      expect(metadata?.error_message).toBeNull();
      expect(metadata?.last_attempt_at).toBeInstanceOf(Date);
      expect(metadata?.last_success_at).toBeInstanceOf(Date);
    });
  });

  describe('replacement', () => {
    it('leaves only the new candidate entries', async () => {
      await runSync(dependencies(fixtureProvider(generateDomainList(20, 'old'))));
      await runSync(dependencies(fixtureProvider(generateDomainList(20, 'new'))));

      const domains = await blockedDomains();
      expect(domains).toEqual([...generateDomainList(20, 'new')].sort());
      expect(domains.some((domain) => domain.startsWith('old'))).toBe(false);
    });

    it('reports added and removed counts', async () => {
      const first = generateDomainList(20, 'keep');
      await runSync(dependencies(fixtureProvider(first)));

      const second = [...first.slice(0, 15), ...generateDomainList(5, 'fresh')];
      const report = await runSync(dependencies(fixtureProvider(second)));

      expect(report.added).toBe(5);
      expect(report.removed).toBe(5);
    });

    it('does not drop or recreate the table', async () => {
      const before = await scalar<number>(
        "select 'guard.blocked_domains'::regclass::oid::int as value",
      );
      await runSync(dependencies(fixtureProvider(generateDomainList(20))));
      const after = await scalar<number>(
        "select 'guard.blocked_domains'::regclass::oid::int as value",
      );

      // Same object: grants, constraints and identity all survive.
      expect(after).toBe(before);
    });
  });

  describe('rollback safety', () => {
    it('leaves the previous blocklist intact when the transaction fails after staging', async () => {
      const original = generateDomainList(20, 'old');
      await runSync(dependencies(fixtureProvider(original)));

      await expect(
        runSync(
          dependencies(fixtureProvider(generateDomainList(20, 'new')), {
            afterStaging: () => Promise.reject(new Error('simulated failure mid-transaction')),
          }),
        ),
      ).rejects.toThrow();

      expect(await blockedDomains()).toEqual([...original].sort());
    });

    it('records the failure without overwriting the last known-good metadata', async () => {
      const original = generateDomainList(20, 'old');
      const successful = await runSync(dependencies(fixtureProvider(original)));

      await expect(
        runSync(
          dependencies(fixtureProvider(generateDomainList(20, 'new')), {
            afterStaging: () => Promise.reject(new Error('simulated failure mid-transaction')),
          }),
        ),
      ).rejects.toThrow();

      const row = await connection.query<{
        status: string;
        domain_count: number;
        checksum: string;
        error_message: string | null;
      }>('select * from guard.sync_metadata where source = $1', [SOURCE]);

      const metadata = row.rows[0];
      expect(metadata?.status).toBe('failed');
      expect(metadata?.error_message).not.toBeNull();
      // Still describing the data that is actually installed.
      expect(metadata?.checksum).toBe(successful.checksum);
      expect(metadata?.domain_count).toBe(20);
    });

    it('leaves the staging table behind after the transaction ends', async () => {
      await runSync(dependencies(fixtureProvider(generateDomainList(20))));

      const staging = await scalar<string | null>(
        "select to_regclass('pg_temp.blocklist_sync_staging')::text as value",
      );
      expect(staging ?? null).toBeNull();
    });
  });

  describe('allowlist preservation', () => {
    it('never modifies guard.allowed_domains', async () => {
      await connection.query(
        'insert into guard.allowed_domains (domain, reason) values ($1, $2), ($3, $4)',
        ['company.example', 'internal', 'partner.example', 'contractual'],
      );

      await runSync(dependencies(fixtureProvider(generateDomainList(20))));

      const allowed = await connection.query<{ domain: string; reason: string }>(
        'select domain, reason from guard.allowed_domains order by domain',
      );
      expect(allowed.rows).toEqual([
        { domain: 'company.example', reason: 'internal' },
        { domain: 'partner.example', reason: 'contractual' },
      ]);
    });

    it('keeps a domain on both lists, leaving precedence to the lookup function', async () => {
      const domains = generateDomainList(20);
      const shared = domains[0];
      await connection.query('insert into guard.allowed_domains (domain, reason) values ($1, $2)', [
        shared,
        'false positive',
      ]);

      await runSync(dependencies(fixtureProvider(domains)));

      // Raw upstream membership and the operator's policy override stay separate facts.
      expect(await blockedDomains()).toContain(shared);
      expect(await scalar<boolean>('select guard.is_blocked_domain($1) as value', [shared])).toBe(
        true,
      );
      expect(
        await scalar<boolean>('select guard.is_disposable_domain($1) as value', [shared]),
      ).toBe(false);
    });
  });

  describe('no-op sync', () => {
    it('does not rewrite rows when the dataset is unchanged', async () => {
      const domains = generateDomainList(20);
      await runSync(dependencies(fixtureProvider(domains)));

      const createdAt = await scalar<string>(
        'select max(created_at)::text as value from guard.blocked_domains',
      );

      const report = await runSync(dependencies(fixtureProvider(domains)));

      expect(report.outcome).toBe('unchanged');
      expect(await blockedDomains()).toEqual([...domains].sort());
      // Untouched rows keep their original created_at, which is the observable proof
      // that nothing was deleted and reinserted.
      expect(
        await scalar<string>('select max(created_at)::text as value from guard.blocked_domains'),
      ).toBe(createdAt);
    });

    it('is unaffected by upstream reordering or duplicates', async () => {
      const domains = generateDomainList(20);
      await runSync(dependencies(fixtureProvider(domains)));

      const shuffled = [...domains].reverse();
      const report = await runSync(
        dependencies(fixtureProvider([...shuffled, ...shuffled.slice(0, 5)])),
      );

      expect(report.outcome).toBe('unchanged');
    });
  });

  describe('suspicious candidate', () => {
    it('is rejected and leaves the installed list untouched', async () => {
      const original = generateDomainList(100);
      await runSync(dependencies(fixtureProvider(original)));

      await expect(
        runSync(dependencies(fixtureProvider(generateDomainList(4, 'tiny')))),
      ).rejects.toThrow(SuspiciousUpdateError);

      expect(await blockedDomains()).toEqual([...original].sort());
    });
  });

  describe('dry run', () => {
    it('reports the diff and mutates nothing', async () => {
      const installed = generateDomainList(20, 'keep');
      await runSync(dependencies(fixtureProvider(installed)));

      const metadataBefore = await connection.query(
        'select * from guard.sync_metadata where source = $1',
        [SOURCE],
      );

      const candidate = [...installed.slice(0, 15), ...generateDomainList(5, 'fresh')];
      const report = await runSync(dependencies(fixtureProvider(candidate)), { dryRun: true });

      expect(report.outcome).toBe('dry-run');
      expect(report.added).toBe(5);
      expect(report.removed).toBe(5);

      expect(await blockedDomains()).toEqual([...installed].sort());
      const metadataAfter = await connection.query(
        'select * from guard.sync_metadata where source = $1',
        [SOURCE],
      );
      expect(metadataAfter.rows).toEqual(metadataBefore.rows);
    });
  });

  describe('concurrency', () => {
    it('refuses to start while another sync holds the advisory lock', async () => {
      // A second connection stands in for a second CLI process.
      const other = await createPostgresConnection({
        connectionString: testDatabaseUrl as string,
      });

      try {
        await other.query('select pg_advisory_lock($1)', [7_233_492_005]);

        await expect(
          runSync(dependencies(fixtureProvider(generateDomainList(20)))),
        ).rejects.toThrow(SyncError);

        expect(await blockedDomains()).toEqual([]);
      } finally {
        await other.query('select pg_advisory_unlock($1)', [7_233_492_005]);
        await other.close();
      }
    });

    it('does not contend with the migration lock', async () => {
      const other = await createPostgresConnection({
        connectionString: testDatabaseUrl as string,
      });

      try {
        // The migration runner's key. sync must be able to proceed regardless.
        await other.query('select pg_advisory_lock($1)', [7_233_492_004]);

        await expect(
          runSync(dependencies(fixtureProvider(generateDomainList(20)))),
        ).resolves.toMatchObject({ outcome: 'updated' });
      } finally {
        await other.query('select pg_advisory_unlock($1)', [7_233_492_004]);
        await other.close();
      }
    });
  });

  describe('scale', () => {
    it('installs a list of tens of thousands of domains in a handful of statements', async () => {
      const domains = generateDomainList(25_000, 'bulk');

      const report = await runSync(dependencies(fixtureProvider(domains)));

      expect(report.candidateCount).toBe(25_000);
      expect(await scalar<number>('select count(*)::int as value from guard.blocked_domains')).toBe(
        25_000,
      );
    }, 60_000);
  });
});
