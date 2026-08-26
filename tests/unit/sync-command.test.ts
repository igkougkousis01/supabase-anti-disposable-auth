import { describe, expect, it } from 'vitest';

import { printSyncReport } from '../../src/commands/sync.js';
import type { SyncReport } from '../../src/blocklist/sync.js';
import { buildProgram } from '../../src/cli.js';
import { EXIT_CODES } from '../../src/lib/errors.js';
import { createRecordingLogger } from '../helpers/logger.js';

function report(overrides: Partial<SyncReport> = {}): SyncReport {
  return {
    target: 'db.example.test:5432/postgres',
    provider: 'disposable-email-domains',
    source: 'disposable-email-domains',
    url: 'https://example.test/domains.txt',
    outcome: 'updated',
    dryRun: false,
    httpStatus: 200,
    bytes: 1_150_000,
    downloadMs: 842,
    totalLines: 12_650,
    consideredLines: 12_650,
    rejectedCount: 167,
    duplicateCount: 0,
    rejectedSamples: [],
    candidateCount: 12_483,
    currentCount: 12_400,
    added: 143,
    removed: 60,
    checksum: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
    installedChecksum: 'f0e9d8c7b6a5',
    firstSync: false,
    durationMs: 1_400,
    ...overrides,
  };
}

describe('printSyncReport', () => {
  it('summarises a successful update with a short checksum', () => {
    const { logger, output } = createRecordingLogger();
    printSyncReport(report(), logger);

    const text = output();
    expect(text).toContain('Blocklist updated atomically (+143 / -60)');
    expect(text).toContain('Checksum: a1b2c3d4e5f6');
    // Never the whole digest in normal output.
    expect(text).not.toContain('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2');
    expect(text).toContain('Sync complete.');
  });

  it('reports an unchanged blocklist without a change summary', () => {
    const { logger, output } = createRecordingLogger();
    printSyncReport(report({ outcome: 'unchanged', added: 0, removed: 0 }), logger);

    const text = output();
    expect(text).toContain('Blocklist already up to date');
    expect(text).toContain('12,483 domains');
    expect(text).not.toContain('updated atomically');
  });

  it('reports a dry run and states that nothing was written', () => {
    const { logger, output } = createRecordingLogger();
    printSyncReport(report({ outcome: 'dry-run', dryRun: true }), logger);

    const text = output();
    expect(text).toContain('Current domains:   12,400');
    expect(text).toContain('Candidate domains: 12,483');
    expect(text).toContain('Added:             143');
    expect(text).toContain('Removed:           60');
    expect(text).toContain('Candidate passes safety checks');
    expect(text).toContain('No database changes made.');
    expect(text).not.toContain('Sync complete.');
  });

  it('never prints the connection string', () => {
    const { logger, output } = createRecordingLogger();
    printSyncReport(report(), logger);

    expect(output()).not.toContain('postgresql://');
  });
});

describe('sync command registration', () => {
  it('is no longer a placeholder', () => {
    const sync = buildProgram().commands.find((command) => command.name() === 'sync');

    expect(sync).toBeDefined();
    expect(sync?.description()).toContain('blocklist');
  });

  it('offers --dry-run', () => {
    const sync = buildProgram().commands.find((command) => command.name() === 'sync');

    expect(sync?.options.map((option) => option.long)).toContain('--dry-run');
  });

  it('does not offer a way to pass an arbitrary URL', () => {
    // Deliberate: accepting a caller-supplied URL would widen the SSRF surface.
    const sync = buildProgram().commands.find((command) => command.name() === 'sync');
    const longFlags = sync?.options.map((option) => option.long) ?? [];

    expect(longFlags).not.toContain('--url');
    expect(longFlags).not.toContain('--source-url');
  });
});

describe('sync exit code', () => {
  it('is distinct from the database and configuration codes', () => {
    expect(EXIT_CODES.sync).toBe(6);
    expect(EXIT_CODES.sync).not.toBe(EXIT_CODES.database);
    expect(EXIT_CODES.sync).not.toBe(EXIT_CODES.configuration);
  });
});
