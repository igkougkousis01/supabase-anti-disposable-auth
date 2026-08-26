/**
 * Blocklist synchronisation: the pipeline that ties every other module together.
 *
 *   Provider -> fetch -> raw validation -> parse -> normalise -> reject invalid
 *            -> deduplicate -> sort -> checksum -> safety checks
 *            -> staging -> atomic replacement -> metadata
 *
 * Two properties matter more than anything else here, and both are structural rather
 * than best-effort:
 *
 *  1. **A failed sync never destroys the installed blocklist.** Nothing writes to
 *     `guard.blocked_domains` until a candidate has passed every check, and the write
 *     itself is one transaction that either lands whole or not at all.
 *  2. **A dry run mutates nothing.** It shares this exact code path up to the point of
 *     replacement and then stops, so what it reports is what a real run would do --
 *     not a separate implementation that could drift.
 *
 * Sync is manual. Nothing schedules it: `pg_cron` and scheduled refresh are not
 * implemented, and neither is the Supabase auth hook, so the blocklist this command
 * maintains is still not consulted during signup.
 */

import { loadConfig } from '../config/env.js';
import { createPostgresConnection } from '../database/client.js';
import type { DatabaseConnection, DatabaseConnectionConfig } from '../database/types.js';
import { ConfigurationError, toAppError } from '../lib/errors.js';
import { CLI_NAME } from '../lib/package-info.js';
import { checksumDomains } from './checksum.js';
import { parseDomainList } from './parse.js';
import type { ParsedBlocklist } from './parse.js';
import { getProvider } from './provider.js';
import {
  acquireSyncLock,
  readInstalledBlocklist,
  readInstalledDomains,
  recordSyncFailure,
  recordSyncNoOp,
  releaseSyncLock,
  replaceBlocklist,
} from './repository.js';
import type { InstalledBlocklist } from './repository.js';
import { assertCandidateIsSafe, DEFAULT_SAFETY_THRESHOLDS } from './safety.js';
import type { SafetyThresholds, SafetyVerdict } from './safety.js';
import type { BlocklistProvider, RawBlocklist } from './types.js';

export interface SyncDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly connect: (config: DatabaseConnectionConfig) => Promise<DatabaseConnection>;
  /** Defaults to the only production provider. */
  readonly provider: BlocklistProvider;
  /** Injected by tests so no unit test ever touches the network. */
  readonly fetchImpl?: typeof fetch;
  readonly thresholds: SafetyThresholds;
  readonly signal?: AbortSignal;
  /** Test seam, forwarded to {@link replaceBlocklist}. */
  readonly afterStaging?: () => Promise<void>;
}

export interface SyncOptions {
  /** Fetch, validate and report, but change nothing. */
  readonly dryRun?: boolean;
}

/** Progress callbacks, so the CLI can narrate each stage as it completes. */
export interface SyncEvents {
  readonly onConnected?: (target: string) => void;
  readonly onProviderSelected?: (provider: BlocklistProvider) => void;
  readonly onDownloaded?: (raw: RawBlocklist) => void;
  readonly onParsed?: (parsed: ParsedBlocklist) => void;
  readonly onSafetyChecked?: (verdict: SafetyVerdict) => void;
}

export type SyncOutcome =
  /** The blocklist was replaced. */
  | 'updated'
  /** Upstream matched what is installed; no rows were written. */
  | 'unchanged'
  /** Nothing was written because this was a dry run. */
  | 'dry-run';

export interface SyncReport {
  /** Redacted `host:port/database`, safe to print. */
  readonly target: string;
  readonly provider: string;
  readonly source: string;
  readonly url: string;
  readonly outcome: SyncOutcome;
  readonly dryRun: boolean;

  readonly httpStatus: number;
  readonly bytes: number;
  readonly downloadMs: number;

  readonly totalLines: number;
  readonly consideredLines: number;
  readonly rejectedCount: number;
  readonly duplicateCount: number;
  readonly rejectedSamples: string[];

  readonly candidateCount: number;
  readonly currentCount: number;
  readonly added: number;
  readonly removed: number;

  readonly checksum: string;
  readonly installedChecksum: string | undefined;
  readonly firstSync: boolean;
  readonly durationMs: number;
}

const MISSING_URL_HINT = `Set SUPABASE_DB_URL (see .env.example) and run \`${CLI_NAME} sync\` again.`;

/**
 * Runs the pipeline end to end.
 *
 * Failures propagate as {@link AppError} subclasses for the CLI's top-level handler.
 * Before they do, a failure record is written to `guard.sync_metadata` outside the
 * rolled-back transaction, so an operator can see that an attempt happened and why —
 * without the last known-good checksum or count being overwritten.
 */
export async function runSync(
  dependencies: Partial<SyncDependencies> = {},
  options: SyncOptions = {},
  events: SyncEvents = {},
): Promise<SyncReport> {
  const startedAt = Date.now();

  const env = dependencies.env ?? process.env;
  const connect = dependencies.connect ?? createPostgresConnection;
  const provider = dependencies.provider ?? getProvider();
  const thresholds = dependencies.thresholds ?? DEFAULT_SAFETY_THRESHOLDS;
  const dryRun = options.dryRun === true;

  const databaseUrl = loadConfig(env).databaseUrl;
  if (databaseUrl === undefined) {
    throw new ConfigurationError('SUPABASE_DB_URL is missing', { hint: MISSING_URL_HINT });
  }

  const connection = await connect({ connectionString: databaseUrl });
  events.onConnected?.(connection.target);

  // A dry run takes no lock. It writes nothing, so it needs no mutual exclusion, and
  // holding the lock would let a read-only preview block a real sync.
  let locked = false;

  try {
    if (!dryRun) {
      await acquireSyncLock(connection);
      locked = true;
    }

    return await synchronise(connection, {
      provider,
      thresholds,
      dryRun,
      events,
      ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
      ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
      ...(dependencies.afterStaging === undefined
        ? {}
        : { afterStaging: dependencies.afterStaging }),
      startedAt,
    });
  } catch (error) {
    // Never on the dry-run path: a dry run must not modify any database state, and
    // that includes the metadata row.
    if (!dryRun) {
      await recordSyncFailure(connection, provider.source, toAppError(error).message);
    }
    throw error;
  } finally {
    if (locked) {
      await releaseSyncLock(connection);
    }
    await connection.close().catch(() => undefined);
  }
}

interface SynchroniseContext {
  readonly provider: BlocklistProvider;
  readonly thresholds: SafetyThresholds;
  readonly dryRun: boolean;
  readonly events: SyncEvents;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly afterStaging?: () => Promise<void>;
  readonly startedAt: number;
}

async function synchronise(
  connection: DatabaseConnection,
  context: SynchroniseContext,
): Promise<SyncReport> {
  const { provider, events } = context;
  events.onProviderSelected?.(provider);

  const raw = await provider.fetch({
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(context.fetchImpl === undefined ? {} : { fetchImpl: context.fetchImpl }),
  });
  events.onDownloaded?.(raw);

  const parsed = parseDomainList(raw.body);
  events.onParsed?.(parsed);

  const checksum = checksumDomains(parsed.domains);
  const installed = await readInstalledBlocklist(connection, provider.source);

  const base = {
    target: connection.target,
    provider: provider.name,
    source: provider.source,
    url: raw.url,
    dryRun: context.dryRun,
    httpStatus: raw.status,
    bytes: raw.bytes,
    downloadMs: raw.durationMs,
    totalLines: parsed.totalLines,
    consideredLines: parsed.consideredLines,
    rejectedCount: parsed.rejectedCount,
    duplicateCount: parsed.duplicateCount,
    rejectedSamples: parsed.rejectedSamples,
    candidateCount: parsed.domains.length,
    currentCount: installed.domainCount,
    checksum,
    installedChecksum: installed.metadata?.checksum,
  };

  // No-op detection runs BEFORE the safety checks, and the order is deliberate: if the
  // candidate is identical to what is already installed, no data changes, so there is
  // nothing to protect against. Refusing a dataset that is already in production
  // would be theatre, and it would leave the operator with a command that can never
  // succeed.
  if (isUnchanged(installed, checksum, parsed.domains.length)) {
    if (!context.dryRun) {
      await recordSyncNoOp(connection, provider.source);
    }

    return {
      ...base,
      outcome: context.dryRun ? 'dry-run' : 'unchanged',
      added: 0,
      removed: 0,
      firstSync: false,
      durationMs: Date.now() - context.startedAt,
    };
  }

  const verdict = assertCandidateIsSafe(
    {
      candidateCount: parsed.domains.length,
      consideredLines: parsed.consideredLines,
      acceptedLines: parsed.acceptedLines,
      currentCount: installed.domainCount,
    },
    context.thresholds,
  );
  events.onSafetyChecked?.(verdict);

  if (context.dryRun) {
    // The diff is computed in process from a plain SELECT. The real path uses the
    // staging table for this, but a dry run must not create even a temporary object,
    // so it reads the installed domains instead.
    const { added, removed } = diffAgainstInstalled(
      await readInstalledDomains(connection),
      parsed.domains,
    );

    return {
      ...base,
      outcome: 'dry-run',
      added,
      removed,
      firstSync: verdict.firstSync,
      durationMs: Date.now() - context.startedAt,
    };
  }

  const result = await replaceBlocklist(connection, {
    source: provider.source,
    domains: parsed.domains,
    checksum,
    ...(context.afterStaging === undefined ? {} : { afterStaging: context.afterStaging }),
  });

  return {
    ...base,
    outcome: 'updated',
    added: result.added,
    removed: result.removed,
    firstSync: verdict.firstSync,
    durationMs: Date.now() - context.startedAt,
  };
}

/**
 * True when the candidate is already installed.
 *
 * Both the checksum AND the live row count must agree with the recorded metadata. The
 * checksum alone is not enough: if someone emptied `guard.blocked_domains` by hand,
 * the metadata would still claim the last sync's fingerprint, and trusting it would
 * leave the database permanently unprotected while `sync` cheerfully reported "already
 * up to date". Requiring the count to match turns that into a normal replacement.
 */
function isUnchanged(
  installed: InstalledBlocklist,
  candidateChecksum: string,
  candidateCount: number,
): boolean {
  const metadata = installed.metadata;
  if (metadata === undefined || metadata.status !== 'success') {
    return false;
  }

  return (
    metadata.checksum === candidateChecksum &&
    installed.domainCount === candidateCount &&
    metadata.domainCount === candidateCount
  );
}

/** Set difference, for the dry run's added/removed report. */
function diffAgainstInstalled(
  installed: readonly string[],
  candidate: readonly string[],
): { added: number; removed: number } {
  const current = new Set(installed);
  const next = new Set(candidate);

  let added = 0;
  for (const domain of next) {
    if (!current.has(domain)) {
      added += 1;
    }
  }

  let removed = 0;
  for (const domain of current) {
    if (!next.has(domain)) {
      removed += 1;
    }
  }

  return { added, removed };
}
