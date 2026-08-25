/**
 * In-memory stand-ins for a PostgreSQL connection.
 *
 * `FakeDatabase` models just enough of the server for the migration runner to be
 * exercised end to end without a live database: the migration history table, statement
 * batching, transaction commit/rollback semantics and the advisory lock. That is what
 * makes it possible to unit-test rollback behaviour -- a real failure mid-run is
 * awkward to provoke against a real server, but trivial here.
 */

import type { AppliedMigration } from '../../src/database/migration-types.js';
import type { DatabaseConnection, QueryResult, SqlParameter } from '../../src/database/types.js';

export interface FakeDatabaseOptions {
  /** When false, `pg_try_advisory_lock` reports the lock as already held. */
  readonly lockAvailable?: boolean;
  /** Throws while executing any migration whose SQL contains this marker. */
  readonly failOnSqlContaining?: string;
  /** Objects that `to_regclass` / `to_regprocedure` should report as present. */
  readonly presentObjects?: string[];
  /** Row counts returned by `select count(*) from <table>`. */
  readonly rowCounts?: Record<string, number>;
  /** Whether the `guard` schema already exists. */
  readonly schemaPresent?: boolean;
}

export class FakeDatabase implements DatabaseConnection {
  readonly target = 'db.example.test:5432/postgres';

  /** Every script passed to `execute`, in order. */
  readonly executed: string[] = [];
  /** Every statement passed to `query`, in order. */
  readonly queried: string[] = [];

  /** Committed rows of `guard.schema_migrations`. */
  readonly history: AppliedMigration[] = [];

  closed = false;
  lockHeld = false;
  schemaPresent: boolean;

  private readonly options: FakeDatabaseOptions;
  private readonly presentObjects: Set<string>;
  /** Rows written inside the current transaction, discarded on rollback. */
  private staged: AppliedMigration[] = [];
  /** Schema state as of the last commit, restored on rollback. */
  private committedSchemaPresent: boolean;

  constructor(options: FakeDatabaseOptions = {}) {
    this.options = options;
    this.schemaPresent = options.schemaPresent ?? false;
    this.committedSchemaPresent = this.schemaPresent;
    this.presentObjects = new Set(options.presentObjects ?? []);
  }

  /** Seeds history as if these migrations had already been applied. */
  seedHistory(records: Omit<AppliedMigration, 'appliedAt'>[]): this {
    this.schemaPresent = true;
    this.presentObjects.add('guard.schema_migrations');
    for (const record of records) {
      this.history.push({ ...record, appliedAt: new Date('2026-01-01T00:00:00Z') });
    }
    return this;
  }

  async execute(sql: string): Promise<void> {
    const statement = sql.trim().toLowerCase();

    if (statement === 'begin') {
      this.staged = [];
      return;
    }

    if (statement === 'commit') {
      this.history.push(...this.staged);
      this.staged = [];
      this.committedSchemaPresent = this.schemaPresent;
      return;
    }

    if (statement === 'rollback') {
      // The whole point: staged history rows vanish with the transaction, so a
      // migration that failed can never be recorded as applied.
      this.staged = [];
      this.schemaPresent = this.committedSchemaPresent;
      return;
    }

    this.executed.push(sql);

    if (
      this.options.failOnSqlContaining !== undefined &&
      sql.includes(this.options.failOnSqlContaining)
    ) {
      throw new Error('simulated migration failure');
    }

    if (sql.includes('create schema if not exists guard')) {
      this.schemaPresent = true;
      this.presentObjects.add('guard.schema_migrations');
    }
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

  private respond(sql: string, parameters: SqlParameter[]): Record<string, unknown>[] {
    if (sql.includes('pg_try_advisory_lock')) {
      const locked = this.options.lockAvailable ?? true;
      this.lockHeld = locked;
      return [{ locked }];
    }

    if (sql.includes('pg_advisory_unlock')) {
      this.lockHeld = false;
      return [{ pg_advisory_unlock: true }];
    }

    if (sql.includes('pg_namespace')) {
      return [{ present: this.schemaPresent && parameters[0] === 'guard' }];
    }

    if (sql.includes('to_regclass') || sql.includes('to_regprocedure')) {
      const name = String(parameters[0]);
      return [{ present: this.presentObjects.has(name) }];
    }

    if (sql.includes('from guard.schema_migrations')) {
      // Mirrors the real row shape: snake_case columns, as `pg` returns them.
      return [...this.history]
        .sort((a, b) => a.version.localeCompare(b.version))
        .map((record) => ({
          version: record.version,
          name: record.name,
          checksum: record.checksum,
          applied_at: record.appliedAt,
        }));
    }

    if (sql.includes('insert into guard.schema_migrations')) {
      const [version, name, checksum] = parameters.map(String);
      this.staged.push({
        version: version ?? '',
        name: name ?? '',
        checksum: checksum ?? '',
        appliedAt: new Date('2026-01-01T00:00:00Z'),
      });
      return [];
    }

    if (sql.includes('count(*)')) {
      const table = /from ([a-z_.]+)/.exec(sql)?.[1] ?? '';
      return [{ count: this.options.rowCounts?.[table] ?? 0 }];
    }

    return [];
  }
}
