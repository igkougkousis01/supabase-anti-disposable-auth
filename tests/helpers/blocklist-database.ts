/**
 * In-memory stand-in for the blocklist half of the `guard` schema.
 *
 * It models exactly the statements `src/blocklist/repository.ts` issues, plus real
 * transaction semantics: writes are staged and only merged into committed state on
 * `commit`, and discarded on `rollback`. That is what lets the rollback guarantee --
 * "a failed sync leaves the previously installed blocklist intact" -- be tested as
 * behaviour rather than asserted as intent, without needing a live server.
 *
 * `guard.allowed_domains` is modelled too, purely so a test can prove that nothing in
 * the sync path ever writes to it.
 */

import type { DatabaseConnection, QueryResult, SqlParameter } from '../../src/database/types.js';

export interface BlockedDomainRow {
  readonly domain: string;
  readonly source: string | null;
}

export interface SyncMetadataRow {
  source: string;
  status: string;
  lastAttemptAt: Date | undefined;
  lastSuccessAt: Date | undefined;
  domainCount: number | undefined;
  checksum: string | undefined;
  errorMessage: string | undefined;
}

export interface FakeBlocklistDatabaseOptions {
  /** When false, `pg_try_advisory_lock` reports the lock as already held. */
  readonly lockAvailable?: boolean;
  /** Domains already installed. */
  readonly blocked?: BlockedDomainRow[];
  /** Allowlist rows, which sync must never touch. */
  readonly allowed?: string[];
  readonly metadata?: SyncMetadataRow[];
}

interface State {
  blocked: Map<string, string | null>;
  allowed: Set<string>;
  metadata: Map<string, SyncMetadataRow>;
}

export class FakeBlocklistDatabase implements DatabaseConnection {
  readonly target = 'db.example.test:5432/postgres';

  /** Every statement passed to `query`, in order. */
  readonly queried: string[] = [];
  /** Every script passed to `execute`, in order, including transaction control. */
  readonly executed: string[] = [];

  closed = false;
  lockHeld = false;
  commits = 0;
  rollbacks = 0;

  private readonly options: FakeBlocklistDatabaseOptions;
  private committed: State;
  /** Non-undefined only inside a transaction. */
  private working: State | undefined;
  /** Session-local staging table, dropped when the transaction ends. */
  private staging: Set<string> | undefined;

  constructor(options: FakeBlocklistDatabaseOptions = {}) {
    this.options = options;
    this.committed = {
      blocked: new Map((options.blocked ?? []).map((row) => [row.domain, row.source])),
      allowed: new Set(options.allowed ?? []),
      metadata: new Map((options.metadata ?? []).map((row) => [row.source, { ...row }])),
    };
  }

  /** Committed blocklist, sorted, as a test would assert on it. */
  get blockedDomains(): string[] {
    return [...this.committed.blocked.keys()].sort();
  }

  get blockedRows(): BlockedDomainRow[] {
    return [...this.committed.blocked.entries()]
      .map(([domain, source]) => ({ domain, source }))
      .sort((a, b) => a.domain.localeCompare(b.domain));
  }

  get allowedDomains(): string[] {
    return [...this.committed.allowed].sort();
  }

  metadataFor(source: string): SyncMetadataRow | undefined {
    const row = this.committed.metadata.get(source);
    return row === undefined ? undefined : { ...row };
  }

  async execute(sql: string): Promise<void> {
    this.executed.push(sql);
    const statement = sql.trim().toLowerCase();

    if (statement === 'begin') {
      this.working = cloneState(this.committed);
      return;
    }

    if (statement === 'commit') {
      if (this.working !== undefined) {
        this.committed = this.working;
      }
      this.working = undefined;
      // `on commit drop`.
      this.staging = undefined;
      this.commits += 1;
      return;
    }

    if (statement === 'rollback') {
      // The whole point: every staged write vanishes with the transaction.
      this.working = undefined;
      this.staging = undefined;
      this.rollbacks += 1;
      return;
    }

    throw new Error(`unexpected execute: ${sql}`);
  }

  async query<Row extends Record<string, unknown>>(
    sql: string,
    parameters: SqlParameter[] = [],
  ): Promise<QueryResult<Row>> {
    this.queried.push(sql);
    const rows = this.respond(sql, parameters) as Row[];
    return { rows, rowCount: rows.length };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** State the statement should read and write: the transaction's, or the committed one. */
  private get state(): State {
    return this.working ?? this.committed;
  }

  private respond(sql: string, parameters: SqlParameter[]): Record<string, unknown>[] {
    const normalized = sql.trim().toLowerCase();

    if (normalized.includes('pg_try_advisory_lock')) {
      const locked = this.options.lockAvailable ?? true;
      this.lockHeld = locked;
      return [{ locked }];
    }

    if (normalized.includes('pg_advisory_unlock')) {
      this.lockHeld = false;
      return [{ pg_advisory_unlock: true }];
    }

    if (normalized.startsWith('create temporary table')) {
      this.staging = new Set();
      return [];
    }

    if (normalized.includes('insert into blocklist_sync_staging')) {
      const batch = parameters[0];
      if (!Array.isArray(batch)) {
        throw new Error('staging insert expects a text[] parameter');
      }
      for (const domain of batch as string[]) {
        this.requireStaging().add(domain);
      }
      return [];
    }

    if (normalized.includes('as added') && normalized.includes('as removed')) {
      const staging = this.requireStaging();
      const blocked = this.state.blocked;
      let added = 0;
      for (const domain of staging) {
        if (!blocked.has(domain)) {
          added += 1;
        }
      }
      let removed = 0;
      for (const domain of blocked.keys()) {
        if (!staging.has(domain)) {
          removed += 1;
        }
      }
      return [{ added, removed }];
    }

    if (normalized.includes('from blocklist_sync_staging') && normalized.includes('count(*)')) {
      return [{ count: this.requireStaging().size }];
    }

    if (normalized.startsWith('delete from guard.blocked_domains')) {
      const staging = this.requireStaging();
      for (const domain of [...this.state.blocked.keys()]) {
        if (!staging.has(domain)) {
          this.state.blocked.delete(domain);
        }
      }
      return [];
    }

    if (normalized.startsWith('insert into guard.blocked_domains')) {
      const source = String(parameters[0]);
      for (const domain of this.requireStaging()) {
        if (!this.state.blocked.has(domain)) {
          this.state.blocked.set(domain, source);
        }
      }
      return [];
    }

    if (normalized.startsWith('update guard.blocked_domains')) {
      const source = String(parameters[0]);
      for (const domain of [...this.state.blocked.keys()]) {
        this.state.blocked.set(domain, source);
      }
      return [];
    }

    if (normalized.startsWith('select domain from guard.blocked_domains')) {
      return [...this.state.blocked.keys()].map((domain) => ({ domain }));
    }

    if (normalized.includes('left join guard.sync_metadata')) {
      const record = this.state.metadata.get(String(parameters[0]));
      return [
        {
          domain_count: this.state.blocked.size,
          status: record?.status ?? null,
          checksum: record?.checksum ?? null,
          recorded_count: record?.domainCount ?? null,
          last_attempt_at: record?.lastAttemptAt ?? null,
          last_success_at: record?.lastSuccessAt ?? null,
        },
      ];
    }

    if (normalized.includes("values ($1, 'success'")) {
      const source = String(parameters[0]);
      this.state.metadata.set(source, {
        source,
        status: 'success',
        lastAttemptAt: new Date(),
        lastSuccessAt: new Date(),
        domainCount: Number(parameters[1]),
        checksum: String(parameters[2]),
        errorMessage: undefined,
      });
      return [];
    }

    if (normalized.includes("values ($1, 'failed'")) {
      const source = String(parameters[0]);
      const existing = this.state.metadata.get(source);
      this.state.metadata.set(source, {
        source,
        status: 'failed',
        lastAttemptAt: new Date(),
        // Deliberately preserved: a failed attempt did not change installed data.
        lastSuccessAt: existing?.lastSuccessAt,
        domainCount: existing?.domainCount,
        checksum: existing?.checksum,
        errorMessage: String(parameters[1]),
      });
      return [];
    }

    if (normalized.startsWith('update guard.sync_metadata')) {
      const source = String(parameters[0]);
      const existing = this.state.metadata.get(source);
      if (existing !== undefined) {
        existing.status = 'success';
        existing.lastAttemptAt = new Date();
        existing.lastSuccessAt = new Date();
        existing.errorMessage = undefined;
      }
      return [];
    }

    throw new Error(`unexpected query: ${sql}`);
  }

  private requireStaging(): Set<string> {
    if (this.staging === undefined) {
      throw new Error('staging table does not exist');
    }
    return this.staging;
  }
}

function cloneState(state: State): State {
  return {
    blocked: new Map(state.blocked),
    allowed: new Set(state.allowed),
    metadata: new Map([...state.metadata].map(([key, row]) => [key, { ...row }])),
  };
}
