import { describe, expect, it } from 'vitest';

import { checksumDomains } from '../../src/blocklist/checksum.js';
import { runSync } from '../../src/blocklist/sync.js';
import type { SyncDependencies } from '../../src/blocklist/sync.js';
import type { BlocklistProvider, RawBlocklist } from '../../src/blocklist/types.js';
import {
  ConfigurationError,
  SuspiciousUpdateError,
  SyncError,
  BlocklistValidationError,
} from '../../src/lib/errors.js';
import { FakeBlocklistDatabase } from '../helpers/blocklist-database.js';
import type { SyncMetadataRow } from '../helpers/blocklist-database.js';
import { generateDomainList, readBlocklistFixture } from '../helpers/fixtures.js';

const SOURCE = 'test-provider';
const DATABASE_URL = 'postgresql://user:secret@db.example.test:5432/postgres';

/** A provider that returns a fixed payload. No unit test here touches the network. */
function fakeProvider(body: string): BlocklistProvider {
  return {
    name: SOURCE,
    source: SOURCE,
    url: 'https://example.test/domains.txt',
    upstream: 'https://example.test/upstream',
    fetch(): Promise<RawBlocklist> {
      return Promise.resolve({
        provider: SOURCE,
        source: SOURCE,
        url: 'https://example.test/domains.txt',
        body,
        bytes: Buffer.byteLength(body),
        status: 200,
        contentType: 'text/plain',
        durationMs: 5,
      });
    },
  };
}

function payload(domains: readonly string[]): string {
  return `${domains.join('\n')}\n`;
}

function dependencies(
  database: FakeBlocklistDatabase,
  provider: BlocklistProvider,
  overrides: Partial<SyncDependencies> = {},
): Partial<SyncDependencies> {
  return {
    env: { SUPABASE_DB_URL: DATABASE_URL },
    connect: () => Promise.resolve(database),
    provider,
    // Small enough that fixtures can be used without generating tens of thousands of
    // rows; the thresholds themselves are unit-tested in blocklist-safety.test.ts.
    thresholds: { minimumDomainCount: 3, minimumValidRatio: 0.8, maximumShrinkRatio: 0.3 },
    ...overrides,
  };
}

function successMetadata(overrides: Partial<SyncMetadataRow> = {}): SyncMetadataRow {
  return {
    source: SOURCE,
    status: 'success',
    lastAttemptAt: new Date('2026-01-01T00:00:00Z'),
    lastSuccessAt: new Date('2026-01-01T00:00:00Z'),
    domainCount: 0,
    checksum: 'unset',
    errorMessage: undefined,
    ...overrides,
  };
}

describe('runSync', () => {
  it('requires SUPABASE_DB_URL', async () => {
    await expect(
      runSync({ env: {}, provider: fakeProvider(payload(generateDomainList(10))) }),
    ).rejects.toThrow(ConfigurationError);
  });

  it('installs the candidate on a first sync', async () => {
    const database = new FakeBlocklistDatabase();
    const domains = generateDomainList(10);
    const provider = fakeProvider(payload(domains));

    const report = await runSync(dependencies(database, provider));

    expect(report.outcome).toBe('updated');
    expect(report.firstSync).toBe(true);
    expect(report.added).toBe(10);
    expect(report.removed).toBe(0);
    expect(database.blockedDomains).toEqual([...domains].sort());
    expect(database.commits).toBe(1);
    expect(database.rollbacks).toBe(0);
  });

  it('replaces the installed list entirely', async () => {
    const database = new FakeBlocklistDatabase({
      blocked: [
        { domain: 'old1.example', source: SOURCE },
        { domain: 'old2.example', source: SOURCE },
        { domain: 'old3.example', source: SOURCE },
      ],
    });
    const provider = fakeProvider(payload(['new1.example', 'new2.example', 'new3.example']));

    const report = await runSync(dependencies(database, provider));

    expect(database.blockedDomains).toEqual(['new1.example', 'new2.example', 'new3.example']);
    expect(report.added).toBe(3);
    expect(report.removed).toBe(3);
  });

  it('stamps the provider source onto every row, including pre-existing ones', async () => {
    const database = new FakeBlocklistDatabase({
      blocked: [{ domain: 'keep.example', source: 'manual' }],
    });
    const provider = fakeProvider(payload(['keep.example', 'a.example', 'b.example']));

    await runSync(dependencies(database, provider));

    expect(database.blockedRows.every((row) => row.source === SOURCE)).toBe(true);
  });

  it('never writes to the allowlist', async () => {
    const database = new FakeBlocklistDatabase({
      allowed: ['company.example', 'partner.example'],
      blocked: [{ domain: 'company.example', source: SOURCE }],
    });
    const provider = fakeProvider(payload(generateDomainList(10)));

    await runSync(dependencies(database, provider));

    expect(database.allowedDomains).toEqual(['company.example', 'partner.example']);
    expect(database.queried.some((sql) => sql.includes('allowed_domains'))).toBe(false);
  });

  it('records success metadata inside the replacement transaction', async () => {
    const database = new FakeBlocklistDatabase();
    const domains = generateDomainList(10);
    const provider = fakeProvider(payload(domains));

    const report = await runSync(dependencies(database, provider));

    const metadata = database.metadataFor(SOURCE);
    expect(metadata?.status).toBe('success');
    expect(metadata?.domainCount).toBe(10);
    expect(metadata?.checksum).toBe(report.checksum);
    expect(metadata?.errorMessage).toBeUndefined();
    expect(metadata?.lastSuccessAt).toBeInstanceOf(Date);
  });

  describe('no-op detection', () => {
    it('writes no blocklist rows when the checksum and count already match', async () => {
      const domains = generateDomainList(10);
      const checksum = checksumDomains(domains);
      const database = new FakeBlocklistDatabase({
        blocked: domains.map((domain) => ({ domain, source: SOURCE })),
        metadata: [successMetadata({ checksum, domainCount: domains.length })],
      });

      const report = await runSync(dependencies(database, fakeProvider(payload(domains))));

      expect(report.outcome).toBe('unchanged');
      expect(report.added).toBe(0);
      expect(report.removed).toBe(0);
      // No transaction is opened at all, so no row is rewritten.
      expect(database.commits).toBe(0);
      expect(database.queried.some((sql) => sql.startsWith('delete from'))).toBe(false);
      expect(database.queried.some((sql) => sql.includes('create temporary table'))).toBe(false);
    });

    it('advances last_success_at on a no-op, because the check did happen', async () => {
      const domains = generateDomainList(10);
      const checksum = checksumDomains(domains);
      const before = new Date('2020-01-01T00:00:00Z');
      const database = new FakeBlocklistDatabase({
        blocked: domains.map((domain) => ({ domain, source: SOURCE })),
        metadata: [
          successMetadata({ checksum, domainCount: domains.length, lastSuccessAt: before }),
        ],
      });

      await runSync(dependencies(database, fakeProvider(payload(domains))));

      expect(database.metadataFor(SOURCE)?.lastSuccessAt?.getTime()).toBeGreaterThan(
        before.getTime(),
      );
    });

    it('does not trust a matching checksum when the table was emptied by hand', async () => {
      const domains = generateDomainList(10);
      const checksum = checksumDomains(domains);
      const database = new FakeBlocklistDatabase({
        blocked: [],
        metadata: [successMetadata({ checksum, domainCount: domains.length })],
      });

      const report = await runSync(dependencies(database, fakeProvider(payload(domains))));

      // Otherwise the database would stay permanently empty while sync reported
      // "already up to date".
      expect(report.outcome).toBe('updated');
      expect(database.blockedDomains).toHaveLength(10);
    });

    it('does not treat a matching checksum from a failed attempt as a no-op', async () => {
      const domains = generateDomainList(10);
      const checksum = checksumDomains(domains);
      const database = new FakeBlocklistDatabase({
        blocked: domains.map((domain) => ({ domain, source: SOURCE })),
        metadata: [successMetadata({ checksum, domainCount: domains.length, status: 'failed' })],
      });

      const report = await runSync(dependencies(database, fakeProvider(payload(domains))));

      expect(report.outcome).toBe('updated');
    });
  });

  describe('safety', () => {
    it('rejects a catastrophic shrink and leaves the installed list untouched', async () => {
      const installed = generateDomainList(100);
      const database = new FakeBlocklistDatabase({
        blocked: installed.map((domain) => ({ domain, source: SOURCE })),
        metadata: [successMetadata({ checksum: 'old', domainCount: installed.length })],
      });
      const provider = fakeProvider(payload(generateDomainList(4, 'tiny')));

      await expect(runSync(dependencies(database, provider))).rejects.toThrow(
        SuspiciousUpdateError,
      );

      expect(database.blockedDomains).toEqual([...installed].sort());
      expect(database.commits).toBe(0);
    });

    it('rejects a payload that is mostly invalid', async () => {
      const database = new FakeBlocklistDatabase();
      const provider = fakeProvider(readBlocklistFixture('malformed.txt'));

      await expect(runSync(dependencies(database, provider))).rejects.toThrow(
        SuspiciousUpdateError,
      );
      expect(database.blockedDomains).toEqual([]);
    });

    it('rejects a payload with no valid domains', async () => {
      const database = new FakeBlocklistDatabase();
      const provider = fakeProvider(readBlocklistFixture('html-error-page.txt'));

      await expect(runSync(dependencies(database, provider))).rejects.toThrow(
        SuspiciousUpdateError,
      );
    });

    it('rejects binary content before any safety judgement is attempted', async () => {
      const database = new FakeBlocklistDatabase();
      const provider = fakeProvider(String.fromCharCode(0).repeat(200));

      await expect(runSync(dependencies(database, provider))).rejects.toThrow(
        BlocklistValidationError,
      );
    });

    it('records the failure without overwriting the last known-good result', async () => {
      const installed = generateDomainList(100);
      const database = new FakeBlocklistDatabase({
        blocked: installed.map((domain) => ({ domain, source: SOURCE })),
        metadata: [
          successMetadata({
            checksum: 'known-good',
            domainCount: installed.length,
            lastSuccessAt: new Date('2026-01-01T00:00:00Z'),
          }),
        ],
      });
      const provider = fakeProvider(payload(generateDomainList(4, 'tiny')));

      await expect(runSync(dependencies(database, provider))).rejects.toThrow();

      const metadata = database.metadataFor(SOURCE);
      expect(metadata?.status).toBe('failed');
      expect(metadata?.errorMessage).toContain('Suspicious blocklist update rejected');
      // The values describing what is actually installed are untouched.
      expect(metadata?.checksum).toBe('known-good');
      expect(metadata?.domainCount).toBe(installed.length);
      expect(metadata?.lastSuccessAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    });

    it('never stores a credential in the failure message', async () => {
      const database = new FakeBlocklistDatabase();
      const provider = fakeProvider(payload(['only.example']));

      await expect(runSync(dependencies(database, provider))).rejects.toThrow();

      expect(database.metadataFor(SOURCE)?.errorMessage).not.toContain('secret');
    });
  });

  describe('rollback safety', () => {
    it('leaves the previous blocklist intact when the transaction fails after staging', async () => {
      const installed = generateDomainList(10, 'old');
      const database = new FakeBlocklistDatabase({
        blocked: installed.map((domain) => ({ domain, source: SOURCE })),
        metadata: [successMetadata({ checksum: 'known-good', domainCount: installed.length })],
      });
      const provider = fakeProvider(payload(generateDomainList(10, 'new')));

      await expect(
        runSync(
          dependencies(database, provider, {
            afterStaging: () => Promise.reject(new Error('simulated failure mid-transaction')),
          }),
        ),
      ).rejects.toThrow();

      expect(database.blockedDomains).toEqual([...installed].sort());
      expect(database.rollbacks).toBe(1);
      expect(database.commits).toBe(0);
      expect(database.metadataFor(SOURCE)?.checksum).toBe('known-good');
    });
  });

  describe('concurrency', () => {
    it('fails cleanly when another sync holds the advisory lock', async () => {
      const database = new FakeBlocklistDatabase({ lockAvailable: false });
      const provider = fakeProvider(payload(generateDomainList(10)));

      await expect(runSync(dependencies(database, provider))).rejects.toThrow(SyncError);
      expect(database.commits).toBe(0);
    });

    it('releases the lock and closes the connection on the happy path', async () => {
      const database = new FakeBlocklistDatabase();
      const provider = fakeProvider(payload(generateDomainList(10)));

      await runSync(dependencies(database, provider));

      expect(database.lockHeld).toBe(false);
      expect(database.closed).toBe(true);
    });

    it('releases the lock when the sync fails', async () => {
      const database = new FakeBlocklistDatabase();
      const provider = fakeProvider(payload(['only.example']));

      await expect(runSync(dependencies(database, provider))).rejects.toThrow();

      expect(database.lockHeld).toBe(false);
      expect(database.closed).toBe(true);
    });
  });

  describe('dry run', () => {
    it('reports what would change without invoking a single mutation', async () => {
      const installed = generateDomainList(10, 'keep');
      const database = new FakeBlocklistDatabase({
        blocked: installed.map((domain) => ({ domain, source: SOURCE })),
        metadata: [successMetadata({ checksum: 'old', domainCount: installed.length })],
      });
      const candidate = [...installed.slice(0, 8), 'added1.example', 'added2.example'];

      const report = await runSync(dependencies(database, fakeProvider(payload(candidate))), {
        dryRun: true,
      });

      expect(report.outcome).toBe('dry-run');
      expect(report.currentCount).toBe(10);
      expect(report.candidateCount).toBe(10);
      expect(report.added).toBe(2);
      expect(report.removed).toBe(2);

      // Nothing was written, and no transaction was even opened.
      expect(database.blockedDomains).toEqual([...installed].sort());
      expect(database.executed).toEqual([]);
      expect(database.commits).toBe(0);
      for (const sql of database.queried) {
        expect(sql.trim().toLowerCase().startsWith('select')).toBe(true);
      }
    });

    it('takes no advisory lock, so it cannot block a real sync', async () => {
      const database = new FakeBlocklistDatabase({ lockAvailable: false });
      const provider = fakeProvider(payload(generateDomainList(10)));

      const report = await runSync(dependencies(database, provider), { dryRun: true });

      expect(report.outcome).toBe('dry-run');
      expect(database.queried.some((sql) => sql.includes('pg_try_advisory_lock'))).toBe(false);
    });

    it('still enforces the safety checks', async () => {
      const installed = generateDomainList(100);
      const database = new FakeBlocklistDatabase({
        blocked: installed.map((domain) => ({ domain, source: SOURCE })),
        metadata: [successMetadata({ checksum: 'old', domainCount: installed.length })],
      });
      const provider = fakeProvider(payload(generateDomainList(4, 'tiny')));

      await expect(runSync(dependencies(database, provider), { dryRun: true })).rejects.toThrow(
        SuspiciousUpdateError,
      );
    });

    it('writes no failure metadata when it rejects a candidate', async () => {
      const installed = generateDomainList(100);
      const database = new FakeBlocklistDatabase({
        blocked: installed.map((domain) => ({ domain, source: SOURCE })),
        metadata: [successMetadata({ checksum: 'old', domainCount: installed.length })],
      });
      const provider = fakeProvider(payload(generateDomainList(4, 'tiny')));

      await expect(runSync(dependencies(database, provider), { dryRun: true })).rejects.toThrow();

      expect(database.metadataFor(SOURCE)?.status).toBe('success');
    });

    it('does not touch metadata on an unchanged upstream', async () => {
      const domains = generateDomainList(10);
      const checksum = checksumDomains(domains);
      const before = new Date('2020-01-01T00:00:00Z');
      const database = new FakeBlocklistDatabase({
        blocked: domains.map((domain) => ({ domain, source: SOURCE })),
        metadata: [
          successMetadata({ checksum, domainCount: domains.length, lastSuccessAt: before }),
        ],
      });

      const report = await runSync(dependencies(database, fakeProvider(payload(domains))), {
        dryRun: true,
      });

      expect(report.outcome).toBe('dry-run');
      expect(database.metadataFor(SOURCE)?.lastSuccessAt?.getTime()).toBe(before.getTime());
    });
  });

  describe('provider trust boundary', () => {
    // End-to-end through runSync: an address in the payload must never reach
    // guard.blocked_domains. Asserting on the database state rather than on the
    // parser is the point -- this is the property that actually matters.

    it('never writes a domain extracted from an email address', async () => {
      const database = new FakeBlocklistDatabase();
      // Enough clean rows that the valid-line ratio stays above its threshold: this
      // test isolates the trust boundary, and the ratio check is exercised separately.
      const clean = generateDomainList(30);
      const provider = fakeProvider(
        payload([...clean, 'user@never-extracted.example', '@also-never.example']),
      );

      const report = await runSync(dependencies(database, provider));

      expect(report.outcome).toBe('updated');
      expect(database.blockedDomains).toEqual([...clean].sort());
      expect(database.blockedDomains).not.toContain('never-extracted.example');
      expect(database.blockedDomains).not.toContain('also-never.example');
      expect(report.rejectedCount).toBe(2);
    });

    it('never writes a domain extracted from a URL or a path', async () => {
      const database = new FakeBlocklistDatabase();
      const clean = generateDomainList(30);
      const provider = fakeProvider(
        payload([
          ...clean,
          'https://never-extracted.example',
          'http://never-extracted.example',
          'never-extracted.example/path',
        ]),
      );

      await runSync(dependencies(database, provider));

      expect(database.blockedDomains).toEqual([...clean].sort());
      expect(database.blockedDomains).not.toContain('never-extracted.example');
    });

    it('refuses the whole sync when the upstream switches to address format', async () => {
      const installed = generateDomainList(100);
      const database = new FakeBlocklistDatabase({
        blocked: installed.map((domain) => ({ domain, source: SOURCE })),
        metadata: [successMetadata({ checksum: 'known-good', domainCount: installed.length })],
      });
      const provider = fakeProvider(payload(installed.map((domain) => `user@${domain}`)));

      // Every row is rejected, so the candidate is empty and the safety checks refuse
      // it. The installed list survives, which is the whole point.
      await expect(runSync(dependencies(database, provider))).rejects.toThrow(
        SuspiciousUpdateError,
      );
      expect(database.blockedDomains).toEqual([...installed].sort());
    });
  });

  it('never puts the connection string in the report', async () => {
    const database = new FakeBlocklistDatabase();
    const provider = fakeProvider(payload(generateDomainList(10)));

    const report = await runSync(dependencies(database, provider));

    expect(JSON.stringify(report)).not.toContain('secret');
    expect(report.target).toBe('db.example.test:5432/postgres');
  });
});
