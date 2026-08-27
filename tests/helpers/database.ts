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
  /** Roles `pg_roles` should report as existing, e.g. `supabase_auth_admin`. */
  readonly roles?: string[];
  /**
   * Privileges a role holds, as `<role>` -> `["<PRIVILEGE> on <object>"]`.
   *
   * Anything not listed is reported as not granted, so a test that forgets to grant
   * something sees it reported as missing rather than silently passing.
   *
   * Two-argument `has_*_privilege(object, privilege)` calls, which PostgreSQL answers
   * for the session user, are looked up under the key `current_user`.
   */
  readonly privileges?: Record<string, string[]>;
  /**
   * The row `pg_trigger` should return for the strict trigger.
   *
   * Absent means no trigger of ours exists, which is the default and the state every
   * pre-strict test expects.
   */
  readonly strictTrigger?: Record<string, unknown>;
  /** The row the `auth.users.email` column probe should return. */
  readonly authUsersEmailColumn?: { type_name: string; category: string };
  /** Whether the `auth` schema exists. Defaults to whether `auth.users` is present. */
  readonly authSchemaPresent?: boolean;
}

/**
 * The catalog row a correctly created strict trigger produces.
 *
 * Mirrors the aliases `readStrictTriggerState()` selects, so a test that changes one
 * field is changing exactly the fact it means to change.
 */
export const OUR_STRICT_TRIGGER_ROW: Record<string, unknown> = {
  tgtype: 23,
  tgenabled: 'O',
  is_constraint: false,
  has_when: false,
  function_schema: 'guard',
  function_name: 'enforce_auth_user_email',
  columns: ['email'],
  definition:
    'CREATE TRIGGER supabase_anti_disposable_auth_strict_email BEFORE INSERT OR UPDATE OF email ON auth.users FOR EACH ROW EXECUTE FUNCTION guard.enforce_auth_user_email()',
};

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
  private readonly roles: Set<string>;
  /**
   * The strict trigger, as the catalog would report it.
   *
   * Mutable, and updated by `CREATE TRIGGER` / `DROP TRIGGER`, so the post-write
   * verification read in `strict enable` / `strict disable` sees what the statement
   * actually did instead of a frozen fixture that would make verification vacuous.
   */
  private strictTrigger: Record<string, unknown> | undefined;
  /** Rows written inside the current transaction, discarded on rollback. */
  private staged: AppliedMigration[] = [];
  /** Schema state as of the last commit, restored on rollback. */
  private committedSchemaPresent: boolean;

  constructor(options: FakeDatabaseOptions = {}) {
    this.options = options;
    this.schemaPresent = options.schemaPresent ?? false;
    this.committedSchemaPresent = this.schemaPresent;
    this.presentObjects = new Set(options.presentObjects ?? []);
    this.roles = new Set(options.roles ?? []);
    this.strictTrigger = options.strictTrigger;
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

    if (sql.startsWith('create trigger supabase_anti_disposable_auth_strict_email')) {
      this.strictTrigger = { ...OUR_STRICT_TRIGGER_ROW };
    }

    if (sql.startsWith('drop trigger supabase_anti_disposable_auth_strict_email')) {
      this.strictTrigger = undefined;
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

    // Checked before the generic pg_namespace branch below: the strict-trigger and
    // column probes join through pg_namespace and would otherwise be answered as if
    // they were schema-existence checks.
    if (sql.includes('pg_trigger')) {
      return this.strictTrigger === undefined ? [] : [this.strictTrigger];
    }

    if (sql.includes('pg_attribute')) {
      const column = this.options.authUsersEmailColumn;
      return column === undefined ? [] : [{ ...column }];
    }

    if (sql.includes('pg_namespace')) {
      const schema = String(parameters[0]);
      if (schema === 'auth') {
        return [
          { present: this.options.authSchemaPresent ?? this.presentObjects.has('auth.users') },
        ];
      }
      return [{ present: this.schemaPresent && schema === 'guard' }];
    }

    if (sql.includes('pg_roles')) {
      return [{ present: this.roles.has(String(parameters[0])) }];
    }

    // has_schema_privilege / has_function_privilege / has_table_privilege all take
    // (role, object, privilege) and are answered from the same grant table.
    if (sql.includes('_privilege(')) {
      const values = parameters.map(String);
      // PostgreSQL's two-argument form asks about the session user. Model it under a
      // fixed key rather than dropping the probe, so a test can grant it.
      const [role, object, privilege] =
        values.length >= 3 ? values : ['current_user', values[0], values[1]];
      const held = this.options.privileges?.[role ?? ''] ?? [];
      return [{ present: held.includes(`${privilege} on ${object}`) }];
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
