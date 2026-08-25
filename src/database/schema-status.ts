/**
 * Read-only inspection of the installed `guard` schema.
 *
 * Every query here is a plain SELECT: `status` must be safe to run against any
 * database, including one where nothing has been installed, without creating or
 * modifying a single object. Object existence is probed with `to_regclass` /
 * `to_regprocedure`, which return NULL instead of raising when the object is absent.
 */

import {
  GUARD_SCHEMA,
  loadMigrationFiles,
  planMigrations,
  readAppliedMigrations,
} from './migrations.js';
import type { AppliedMigration, MigrationFile } from './migration-types.js';
import type { DatabaseConnection } from './types.js';

/** Signature of the lookup function that the future auth hook will call. */
const LOOKUP_FUNCTION = `${GUARD_SCHEMA}.is_disposable_domain(text)`;

const BLOCKED_DOMAINS_TABLE = `${GUARD_SCHEMA}.blocked_domains`;
const ALLOWED_DOMAINS_TABLE = `${GUARD_SCHEMA}.allowed_domains`;

/**
 * Every table a fully migrated `guard` schema must contain.
 *
 * Checked individually rather than inferred from the migration history, because the
 * two can disagree: a table dropped by hand leaves its migration row in place, and
 * trusting the history alone would report that damaged database as healthy.
 */
const EXPECTED_TABLES = [
  `${GUARD_SCHEMA}.schema_migrations`,
  BLOCKED_DOMAINS_TABLE,
  ALLOWED_DOMAINS_TABLE,
  `${GUARD_SCHEMA}.sync_metadata`,
];

/** Every function a fully migrated `guard` schema must expose. */
const EXPECTED_FUNCTIONS = [
  `${GUARD_SCHEMA}.normalize_domain(text)`,
  `${GUARD_SCHEMA}.is_blocked_domain(text)`,
  `${GUARD_SCHEMA}.is_allowed_domain(text)`,
  LOOKUP_FUNCTION,
];

/**
 * Overall state of the installation.
 *
 * `incomplete` deliberately covers both "half migrated" and "objects missing": from
 * the operator's point of view both mean the same thing -- do not rely on this
 * database -- and collapsing them keeps `status` from implying a partial install is
 * usable.
 */
export type GuardSchemaHealth = 'not-installed' | 'incomplete' | 'complete';

export interface GuardSchemaStatus {
  /** Whether the `guard` schema exists at all. */
  readonly schemaInstalled: boolean;
  /** Migrations recorded in `guard.schema_migrations`, oldest first. */
  readonly applied: AppliedMigration[];
  /** Highest applied version, or `undefined` when nothing is applied. */
  readonly currentVersion: string | undefined;
  /** Bundled migrations not yet applied to this database. */
  readonly pending: MigrationFile[];
  /** `undefined` when the table does not exist yet. */
  readonly blockedDomainCount: number | undefined;
  /** `undefined` when the table does not exist yet. */
  readonly allowedDomainCount: number | undefined;
  /** Whether `guard.is_disposable_domain(text)` is callable. */
  readonly lookupFunctionInstalled: boolean;
  /** Overall verdict. Never `complete` while anything expected is absent. */
  readonly health: GuardSchemaHealth;
  /**
   * Expected tables and functions that are absent, in a stable order.
   *
   * Empty when the schema itself does not exist -- an uninstalled database is not a
   * damaged one, and listing every object as "missing" would obscure that.
   */
  readonly missingObjects: string[];
}

export interface ReadGuardSchemaStatusOptions {
  /** Migrations to compare against. Defaults to the bundled `migrations/` directory. */
  readonly files?: MigrationFile[];
}

/** Gathers everything `status` reports about the database layer. */
export async function readGuardSchemaStatus(
  connection: DatabaseConnection,
  options: ReadGuardSchemaStatusOptions = {},
): Promise<GuardSchemaStatus> {
  const files = options.files ?? (await loadMigrationFiles());

  const schemaInstalled = await schemaExists(connection, GUARD_SCHEMA);
  const applied = await readAppliedMigrations(connection);
  const plan = planMigrations(files, applied);

  const missingObjects = schemaInstalled ? await findMissingObjects(connection) : [];

  return {
    schemaInstalled,
    applied,
    currentVersion: plan.currentVersion,
    pending: plan.pending,
    // Both counts stay `undefined` when their table is missing. Every read below is
    // guarded by an existence probe, so a half-installed schema is reported rather
    // than raising an "undefined table" error.
    blockedDomainCount: await countRowsIfPresent(connection, BLOCKED_DOMAINS_TABLE),
    allowedDomainCount: await countRowsIfPresent(connection, ALLOWED_DOMAINS_TABLE),
    lookupFunctionInstalled: await functionExists(connection, LOOKUP_FUNCTION),
    health: assessHealth(schemaInstalled, missingObjects, plan.pending.length),
    missingObjects,
  };
}

function assessHealth(
  schemaInstalled: boolean,
  missingObjects: string[],
  pendingCount: number,
): GuardSchemaHealth {
  if (!schemaInstalled) {
    return 'not-installed';
  }

  // A missing object or an unapplied migration both mean the policy engine cannot be
  // trusted. Neither may ever be reported as healthy.
  if (missingObjects.length > 0 || pendingCount > 0) {
    return 'incomplete';
  }

  return 'complete';
}

/** Probes every expected object and returns the ones that are absent. */
async function findMissingObjects(connection: DatabaseConnection): Promise<string[]> {
  const missing: string[] = [];

  for (const table of EXPECTED_TABLES) {
    if (!(await relationExists(connection, table))) {
      missing.push(table);
    }
  }

  for (const signature of EXPECTED_FUNCTIONS) {
    if (!(await functionExists(connection, signature))) {
      missing.push(signature);
    }
  }

  return missing;
}

async function schemaExists(connection: DatabaseConnection, schema: string): Promise<boolean> {
  const result = await connection.query<{ present: boolean }>(
    'select exists (select 1 from pg_catalog.pg_namespace where nspname = $1) as present',
    [schema],
  );

  return result.rows[0]?.present === true;
}

async function functionExists(connection: DatabaseConnection, signature: string): Promise<boolean> {
  // to_regprocedure() returns NULL rather than raising for an unknown signature.
  const result = await connection.query<{ present: boolean }>(
    'select to_regprocedure($1) is not null as present',
    [signature],
  );

  return result.rows[0]?.present === true;
}

async function relationExists(connection: DatabaseConnection, table: string): Promise<boolean> {
  // to_regclass() returns NULL rather than raising for an unknown relation, which is
  // what makes this safe against a partially installed schema.
  const result = await connection.query<{ present: boolean }>(
    'select to_regclass($1) is not null as present',
    [table],
  );

  return result.rows[0]?.present === true;
}

/**
 * Counts rows in a table, or returns `undefined` when the table is absent.
 *
 * `table` is a module-level constant, never user input, so embedding it is safe --
 * an identifier cannot be a bind parameter. The existence probe above it does use a
 * parameter, because there the table name is a *value*.
 */
async function countRowsIfPresent(
  connection: DatabaseConnection,
  table: string,
): Promise<number | undefined> {
  const present = await connection.query<{ present: boolean }>(
    'select to_regclass($1) is not null as present',
    [table],
  );

  if (present.rows[0]?.present !== true) {
    return undefined;
  }

  // count(*) is bigint, which `pg` returns as a string; cast so the driver yields a number.
  const result = await connection.query<{ count: number }>(
    `select count(*)::int as count from ${table}`,
  );

  return result.rows[0]?.count;
}
