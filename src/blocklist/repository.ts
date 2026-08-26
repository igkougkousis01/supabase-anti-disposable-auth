/**
 * Every database operation the blocklist pipeline performs.
 *
 * The one invariant this file exists to guarantee:
 *
 *   A FAILED SYNCHRONISATION LEAVES THE PREVIOUSLY INSTALLED BLOCKLIST INTACT.
 *
 * How that is achieved:
 *
 *  - The candidate is loaded into a **transaction-scoped temporary staging table**
 *    first. Nothing touches `guard.blocked_domains` until the full candidate is
 *    present and counted server-side, so a connection that dies mid-transfer cannot
 *    leave a half-list installed.
 *  - Staging, replacement and the metadata row share **one transaction**. Readers keep
 *    seeing the old list until it commits, and any failure rolls the whole thing back.
 *  - The replacement is **differential** -- delete what left, insert what arrived --
 *    rather than truncate-and-reload. `guard.blocked_domains` is never dropped or
 *    recreated, so its grants, constraints, primary key and object identity survive
 *    untouched, and `created_at` on an unchanged row keeps meaning what it says.
 *  - `guard.allowed_domains` is **never written to**. The upstream list controls the
 *    blocklist and nothing else. A domain on both lists stays on both; allowlist
 *    precedence is resolved at lookup time by `guard.is_disposable_domain()`, which
 *    keeps "what upstream says" and "what this operator has decided" as two separate
 *    facts instead of destructively merging them.
 */

import { DatabaseQueryError, SyncError } from '../lib/errors.js';
import { inTransaction } from '../database/transaction.js';
import type { DatabaseConnection } from '../database/types.js';

/**
 * Domains per `unnest($1::text[])` round trip.
 *
 * One statement per domain would be ~150,000 round trips; one statement for all of
 * them would put the entire list in a single protocol message. 5,000 keeps the whole
 * upstream list to about thirty statements while bounding per-message memory, and it
 * is small enough that a stalled transfer fails quickly rather than after megabytes.
 */
const INSERT_BATCH_SIZE = 5_000;

/**
 * Key for the session advisory lock held during a replacement.
 *
 * A fixed constant, distinct from the migration runner's, so `install` and `sync` do
 * not contend with each other -- they touch different objects and there is no reason
 * one should block the other.
 */
const SYNC_LOCK_KEY = 7_233_492_005;

/** Staging table name. Created in `pg_temp`, so it is invisible to other sessions. */
const STAGING_TABLE = 'blocklist_sync_staging';

/** Longest failure message stored in `guard.sync_metadata.error_message`. */
const MAX_ERROR_MESSAGE_LENGTH = 500;

export interface SyncMetadataRecord {
  readonly status: string;
  readonly checksum: string | undefined;
  readonly domainCount: number | undefined;
  readonly lastAttemptAt: Date | undefined;
  readonly lastSuccessAt: Date | undefined;
}

export interface InstalledBlocklist {
  /** Rows currently in `guard.blocked_domains`, across every source. */
  readonly domainCount: number;
  /** Recorded state for this source, or `undefined` if it has never synced. */
  readonly metadata: SyncMetadataRecord | undefined;
}

export interface ReplaceBlocklistOptions {
  readonly source: string;
  /** Normalised, deduplicated, sorted. */
  readonly domains: readonly string[];
  readonly checksum: string;
  /**
   * Test seam: runs inside the transaction, after staging is populated and validated
   * but before `guard.blocked_domains` is touched.
   *
   * It exists so the rollback guarantee can be tested rather than asserted. A failure
   * injected here is the exact shape of the failure this design defends against.
   */
  readonly afterStaging?: () => Promise<void>;
}

export interface ReplaceBlocklistResult {
  readonly added: number;
  readonly removed: number;
  readonly total: number;
}

/**
 * Reads the installed state for one source in a single statement.
 *
 * One statement, so the row count and the metadata come from the same snapshot. Read
 * separately they could disagree with each other under a concurrent sync, and the
 * no-op check compares exactly those two values.
 */
export async function readInstalledBlocklist(
  connection: DatabaseConnection,
  source: string,
): Promise<InstalledBlocklist> {
  const result = await connection.query<{
    domain_count: number;
    status: string | null;
    checksum: string | null;
    recorded_count: number | null;
    last_attempt_at: Date | null;
    last_success_at: Date | null;
  }>(
    `select
       (select count(*)::int from guard.blocked_domains) as domain_count,
       m.status,
       m.checksum,
       m.domain_count as recorded_count,
       m.last_attempt_at,
       m.last_success_at
     from (select 1) as anchor
     left join guard.sync_metadata m on m.source = $1`,
    [source],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new DatabaseQueryError('Could not read the installed blocklist state');
  }

  return {
    domainCount: row.domain_count,
    metadata:
      row.status === null
        ? undefined
        : {
            status: row.status,
            checksum: row.checksum ?? undefined,
            domainCount: row.recorded_count ?? undefined,
            lastAttemptAt: row.last_attempt_at ?? undefined,
            lastSuccessAt: row.last_success_at ?? undefined,
          },
  };
}

/** Reads every installed domain. Used only by the dry run, which must not stage. */
export async function readInstalledDomains(connection: DatabaseConnection): Promise<string[]> {
  const result = await connection.query<{ domain: string }>(
    'select domain from guard.blocked_domains',
  );
  return result.rows.map((row) => row.domain);
}

/**
 * Session advisory lock, so two syncs cannot replace the blocklist concurrently.
 *
 * `pg_try_advisory_lock` rather than the blocking form, matching the migration
 * runner's philosophy: a bounded wait would still be a wait, and telling an operator
 * "another sync is running" immediately is more useful than a terminal that appears to
 * hang. Sync is idempotent, so re-running after the other one finishes costs nothing.
 *
 * The lock is session-scoped, which means closing the connection releases it even if
 * the process is killed -- there is no stale lock to clean up by hand.
 */
export async function acquireSyncLock(connection: DatabaseConnection): Promise<void> {
  const result = await connection.query<{ locked: boolean }>(
    'select pg_try_advisory_lock($1) as locked',
    [SYNC_LOCK_KEY],
  );

  if (result.rows[0]?.locked !== true) {
    throw new SyncError('Another blocklist sync is already in progress', {
      hint: 'Wait for it to finish, then run sync again.',
    });
  }
}

export async function releaseSyncLock(connection: DatabaseConnection): Promise<void> {
  try {
    await connection.query('select pg_advisory_unlock($1)', [SYNC_LOCK_KEY]);
  } catch {
    // Session-scoped, so closing the connection releases it anyway. A failure here
    // must not mask the error that is already propagating.
  }
}

/**
 * Stages the candidate and swaps it into `guard.blocked_domains` atomically.
 *
 * Returns what changed. On any failure the transaction is rolled back and the
 * installed blocklist is byte-for-byte what it was before the call.
 */
export async function replaceBlocklist(
  connection: DatabaseConnection,
  options: ReplaceBlocklistOptions,
): Promise<ReplaceBlocklistResult> {
  return inTransaction(connection, async () => {
    await createStagingTable(connection);
    await populateStagingTable(connection, options.domains);
    await assertStagingMatchesCandidate(connection, options.domains.length);

    await options.afterStaging?.();

    const { added, removed } = await countDifference(connection);

    // Order matters only for clarity; both statements are inside one transaction and
    // no reader observes the intermediate state.
    await connection.query(
      `delete from guard.blocked_domains b
       where not exists (select 1 from ${STAGING_TABLE} s where s.domain = b.domain)`,
    );

    await connection.query(
      `insert into guard.blocked_domains (domain, source)
       select s.domain, $1 from ${STAGING_TABLE} s
       on conflict (domain) do nothing`,
      [options.source],
    );

    // Every surviving row is now part of this source's list, so its provenance should
    // say so -- otherwise a domain first added by hand would keep claiming to be
    // manual long after upstream took ownership of it.
    await connection.query(
      'update guard.blocked_domains set source = $1 where source is distinct from $1',
      [options.source],
    );

    await recordSyncSuccess(connection, options.source, {
      domainCount: options.domains.length,
      checksum: options.checksum,
    });

    return { added, removed, total: options.domains.length };
  });
}

/**
 * Records a successful sync.
 *
 * Called inside the replacement transaction, which is the point: the metadata and the
 * data it describes commit together, so metadata can never claim a sync that did not
 * land.
 */
export async function recordSyncSuccess(
  connection: DatabaseConnection,
  source: string,
  values: { domainCount: number; checksum: string },
): Promise<void> {
  await connection.query(
    `insert into guard.sync_metadata
       (source, status, last_attempt_at, last_success_at, domain_count, checksum, error_message)
     values ($1, 'success', now(), now(), $2, $3, null)
     on conflict (source) do update set
       status = 'success',
       last_attempt_at = now(),
       last_success_at = now(),
       domain_count = excluded.domain_count,
       checksum = excluded.checksum,
       error_message = null`,
    [source, values.domainCount, values.checksum],
  );
}

/**
 * Records a failed attempt, without disturbing the last known-good result.
 *
 * Transaction boundary, stated explicitly because it is the subtle part: this runs
 * AFTER the replacement transaction has rolled back, in its own statement. Writing it
 * inside that transaction would roll the failure record back along with everything
 * else, and the operator would be left with no trace of what happened.
 *
 * `last_success_at`, `domain_count` and `checksum` are deliberately left alone. They
 * describe the data that is actually installed, which a failed attempt did not change.
 * Overwriting them with candidate values would make the metadata describe a list that
 * was never applied -- and would break no-op detection on the next run.
 *
 * Best-effort by design: if the failure was the database itself, this write fails too,
 * and the original error is the one worth reporting.
 */
export async function recordSyncFailure(
  connection: DatabaseConnection,
  source: string,
  message: string,
): Promise<boolean> {
  try {
    await connection.query(
      `insert into guard.sync_metadata (source, status, last_attempt_at, error_message)
       values ($1, 'failed', now(), $2)
       on conflict (source) do update set
         status = 'failed',
         last_attempt_at = now(),
         error_message = excluded.error_message`,
      [source, redactForStorage(message)],
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Records that an unchanged upstream was verified against the installed list.
 *
 * `last_success_at` advances, and that is a deliberate decision rather than an
 * oversight. It answers "when did we last confirm the installed blocklist matches
 * upstream?", which is the question staleness monitoring actually asks. If it only
 * moved when the content changed, a list that upstream legitimately had not touched
 * for two months would look two months stale and every alert would be a false one.
 * Whether the DATA changed is what `checksum` is for; `last_success_at` is about
 * whether the CHECK happened.
 *
 * No blocklist rows are written. This is a single-row update, not a reload.
 */
export async function recordSyncNoOp(
  connection: DatabaseConnection,
  source: string,
): Promise<void> {
  await connection.query(
    `update guard.sync_metadata
     set status = 'success', last_attempt_at = now(), last_success_at = now(), error_message = null
     where source = $1`,
    [source],
  );
}

/**
 * Creates the staging table.
 *
 * Temporary and `on commit drop`: it lives in the session's own `pg_temp` schema, is
 * invisible to every other connection, and disappears when the transaction ends
 * however it ends. Nothing is left behind to clean up, and no permanent object is
 * added to `guard` for a transient purpose.
 *
 * The primary key does real work -- it deduplicates server-side, so a candidate that
 * slipped a duplicate past the in-process canonicalisation still cannot produce two
 * rows.
 */
async function createStagingTable(connection: DatabaseConnection): Promise<void> {
  await connection.query(
    `create temporary table ${STAGING_TABLE} (domain text primary key) on commit drop`,
  );
}

/** Bulk-loads the candidate in batches, expanding each batch server-side. */
async function populateStagingTable(
  connection: DatabaseConnection,
  domains: readonly string[],
): Promise<void> {
  for (let index = 0; index < domains.length; index += INSERT_BATCH_SIZE) {
    const batch = domains.slice(index, index + INSERT_BATCH_SIZE);
    await connection.query(
      `insert into ${STAGING_TABLE} (domain)
       select distinct unnest($1::text[])
       on conflict (domain) do nothing`,
      [batch],
    );
  }
}

/**
 * Confirms the server received exactly what was sent.
 *
 * The candidate was already deduplicated in process, so the staged count must equal
 * the candidate length. A mismatch means a batch was lost in transit or something
 * else is writing to this session's temp schema -- neither is a condition under which
 * production data should be replaced.
 */
async function assertStagingMatchesCandidate(
  connection: DatabaseConnection,
  expected: number,
): Promise<void> {
  const result = await connection.query<{ count: number }>(
    `select count(*)::int as count from ${STAGING_TABLE}`,
  );
  const staged = result.rows[0]?.count;

  if (staged !== expected) {
    throw new SyncError(
      `Staged ${String(staged ?? 'no')} domains but expected ${expected}; sync aborted`,
      { hint: 'The installed blocklist was left unchanged. Run sync again.' },
    );
  }
}

/** Counts what the swap will add and remove, before either statement runs. */
async function countDifference(
  connection: DatabaseConnection,
): Promise<{ added: number; removed: number }> {
  const result = await connection.query<{ added: number; removed: number }>(
    `select
       (select count(*)::int from ${STAGING_TABLE} s
        where not exists (select 1 from guard.blocked_domains b where b.domain = s.domain)) as added,
       (select count(*)::int from guard.blocked_domains b
        where not exists (select 1 from ${STAGING_TABLE} s where s.domain = b.domain)) as removed`,
  );

  return { added: result.rows[0]?.added ?? 0, removed: result.rows[0]?.removed ?? 0 };
}

/**
 * Bounds what is written to `error_message`.
 *
 * Only an `AppError` message ever reaches here, and those are written not to contain
 * credentials -- databases are named with `describeConnectionTarget()`, and no cause or
 * stack is included. Truncating is belt-and-braces against a long upstream-influenced
 * string ending up in a column an operator will read.
 */
function redactForStorage(message: string): string {
  const collapsed = message.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${collapsed.slice(0, MAX_ERROR_MESSAGE_LENGTH - 3)}...`
    : collapsed;
}
