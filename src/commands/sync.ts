/**
 * `sync` — refreshes the disposable-domain blocklist from an upstream provider.
 *
 * Scope in this branch is the blocklist lifecycle and nothing else. It does NOT
 * register the Supabase auth hook, touch `auth.users`, enable `pg_cron` or schedule
 * anything: sync is a manual command, run by an operator, and the list it maintains is
 * still not consulted during signup.
 *
 * The command is safe to re-run. An unchanged upstream is recognised by checksum and
 * writes no blocklist rows, and any failure leaves the installed list exactly as it
 * was.
 */

import type { Command } from 'commander';

import { shortChecksum } from '../blocklist/checksum.js';
import { runSync } from '../blocklist/sync.js';
import type { SyncReport } from '../blocklist/sync.js';
import { logger as defaultLogger } from '../lib/logger.js';
import type { Logger } from '../lib/logger.js';
import { PRODUCT_NAME } from '../lib/package-info.js';

export interface SyncCommandOptions {
  readonly dryRun?: boolean;
}

/**
 * Streams progress as each stage completes, then prints the closing summary.
 *
 * Progress is narrated rather than batched because the download is the slow part and a
 * silent terminal during it reads as a hang.
 */
export function printSyncReport(report: SyncReport, logger: Logger = defaultLogger): void {
  if (report.outcome === 'unchanged') {
    logger.success('Blocklist already up to date');
    logger.success(`${count(report.candidateCount)} domains`);
    logger.blank();
    logger.plain(`Checksum: ${shortChecksum(report.checksum)}`);
    return;
  }

  if (report.dryRun) {
    printDryRunSummary(report, logger);
    return;
  }

  logger.success(
    `Blocklist updated atomically (+${count(report.added)} / -${count(report.removed)})`,
  );
  logger.success(`Checksum: ${shortChecksum(report.checksum)}`);
  logger.blank();
  logger.plain('Sync complete.');
}

function printDryRunSummary(report: SyncReport, logger: Logger): void {
  logger.blank();
  logger.plain(`Current domains:   ${count(report.currentCount)}`);
  logger.plain(`Candidate domains: ${count(report.candidateCount)}`);
  logger.plain(`Added:             ${count(report.added)}`);
  logger.plain(`Removed:           ${count(report.removed)}`);
  logger.blank();
  logger.success('Candidate passes safety checks');
  logger.plain(`Checksum: ${shortChecksum(report.checksum)}`);
  logger.plain('No database changes made.');
}

export function registerSyncCommand(program: Command, logger: Logger = defaultLogger): Command {
  return program
    .command('sync')
    .description('Refresh the disposable-domain blocklist stored in the database.')
    .option(
      '--dry-run',
      'Fetch and validate the upstream list, report what would change, and write nothing.',
      false,
    )
    .action(async (options: SyncCommandOptions) => {
      const dryRun = options.dryRun === true;

      logger.plain(PRODUCT_NAME);
      logger.blank();
      if (dryRun) {
        logger.plain('Dry run');
        logger.blank();
      }

      const report = await runSync(
        {},
        { dryRun },
        {
          onConnected: (target) => logger.success(`Connected to PostgreSQL (${target})`),
          onProviderSelected: (provider) => logger.success(`Provider: ${provider.name}`),
          onDownloaded: (raw) =>
            logger.success(
              `Downloaded blocklist (${bytes(raw.bytes)}, HTTP ${raw.status}, ${raw.durationMs} ms)`,
            ),
          onParsed: (parsed) => {
            logger.success(`Parsed ${count(parsed.totalLines)} lines`);
            logger.success(`Accepted ${count(parsed.domains.length)} domains`);
            if (parsed.rejectedCount > 0) {
              logger.success(`Rejected ${count(parsed.rejectedCount)} invalid entries`);
            }
            if (parsed.duplicateCount > 0) {
              logger.success(`Collapsed ${count(parsed.duplicateCount)} duplicates`);
            }
          },
          onSafetyChecked: (verdict) => {
            logger.success(
              verdict.firstSync
                ? 'Candidate passed safety checks (first sync: no list to compare against)'
                : 'Candidate passed safety checks',
            );
          },
        },
      );

      printSyncReport(report, logger);
    });
}

/** Thousands separators, pinned to en-US so output does not vary by machine locale. */
function count(value: number): string {
  return value.toLocaleString('en-US');
}

function bytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
