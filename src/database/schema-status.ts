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

/** Signature of the lookup function the auth hook delegates its policy decision to. */
const LOOKUP_FUNCTION = `${GUARD_SCHEMA}.is_disposable_domain(text)`;

/** Signature of the Supabase Before User Created hook function. */
const HOOK_FUNCTION = `${GUARD_SCHEMA}.before_user_created(jsonb)`;

/** Signature of the strict-mode trigger function. Installed by migration 008. */
const STRICT_TRIGGER_FUNCTION = `${GUARD_SCHEMA}.enforce_auth_user_email()`;

const NORMALIZE_FUNCTION = `${GUARD_SCHEMA}.normalize_domain(text)`;
const BLOCKED_DOMAINS_TABLE = `${GUARD_SCHEMA}.blocked_domains`;
const ALLOWED_DOMAINS_TABLE = `${GUARD_SCHEMA}.allowed_domains`;

/**
 * The role Supabase Auth (GoTrue) connects as, and therefore the role that executes
 * the hook. It does not exist on a plain PostgreSQL server.
 */
export const AUTH_HOOK_ROLE = 'supabase_auth_admin';

/** A single `has_*_privilege()` probe. */
export interface PrivilegeProbe {
  /** Which `has_*_privilege` family answers this. */
  readonly kind: 'schema' | 'function' | 'table';
  readonly object: string;
  readonly privilege: string;
}

/**
 * Every privilege `supabase_auth_admin` needs to execute the hook end to end.
 *
 * This list is the SECURITY INVOKER call chain written out: the hook runs with the
 * caller's privileges, so the caller needs everything the chain touches, not just
 * EXECUTE on the entry point. It mirrors 007_auth_hook_permissions.sql exactly, and
 * an integration test asserts the two agree.
 */
export const REQUIRED_AUTH_HOOK_GRANTS: readonly PrivilegeProbe[] = [
  { kind: 'schema', object: GUARD_SCHEMA, privilege: 'USAGE' },
  { kind: 'function', object: HOOK_FUNCTION, privilege: 'EXECUTE' },
  { kind: 'function', object: LOOKUP_FUNCTION, privilege: 'EXECUTE' },
  { kind: 'function', object: NORMALIZE_FUNCTION, privilege: 'EXECUTE' },
  { kind: 'table', object: BLOCKED_DOMAINS_TABLE, privilege: 'SELECT' },
  { kind: 'table', object: ALLOWED_DOMAINS_TABLE, privilege: 'SELECT' },
];

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
  NORMALIZE_FUNCTION,
  `${GUARD_SCHEMA}.is_blocked_domain(text)`,
  `${GUARD_SCHEMA}.is_allowed_domain(text)`,
  LOOKUP_FUNCTION,
  // The hook ships in migration 006, so from that version on its absence is damage,
  // not an unbuilt feature. A guard layer whose hook function is gone must never
  // report as healthy: Supabase Auth would be calling a function that is not there.
  HOOK_FUNCTION,
  // The strict trigger FUNCTION ships in migration 008 and is expected on every
  // installation, whether or not strict mode is switched on. The optional part of
  // strict mode is the TRIGGER on auth.users, which no migration creates and which is
  // deliberately absent from this list -- see src/database/strict-trigger.ts.
  STRICT_TRIGGER_FUNCTION,
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

/**
 * Whether `supabase_auth_admin` can actually execute the hook.
 *
 * `role-absent` exists so that a plain PostgreSQL database -- a developer's local
 * scratch server, or CI -- is reported as unverifiable rather than as either healthy
 * or broken. Claiming the grants are fine on a server where the role does not exist
 * would be a vacuous pass, and treating it as damage would fail every local install.
 *
 * `unknown` is the same honesty applied to a damaged schema: `has_*_privilege()`
 * raises for an object that does not exist, so grants cannot be probed while any
 * required object is missing. That case is already `incomplete` on its own merits.
 */
export type AuthHookGrantState = 'role-absent' | 'unknown' | 'granted' | 'incomplete';

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
  /** Whether `guard.before_user_created(jsonb)` exists in the database. */
  readonly hookFunctionInstalled: boolean;
  /**
   * Whether `supabase_auth_admin` holds every privilege the hook needs.
   *
   * This says nothing about whether Supabase Auth has been *configured* to call the
   * hook. The database cannot observe that, and `status` must never imply it.
   */
  readonly authHookGrants: AuthHookGrantState;
  /**
   * Required grants that `supabase_auth_admin` is missing, in a stable order.
   *
   * Always empty unless `authHookGrants` is `incomplete`.
   */
  readonly missingAuthHookGrants: string[];
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

  // Probed only when every required object exists: has_*_privilege() raises for an
  // unknown object, and a schema that is missing one is already `incomplete` without
  // needing a grant verdict to say so.
  const grants =
    schemaInstalled && missingObjects.length === 0
      ? await readAuthHookGrants(connection)
      : { state: 'unknown' as const, missing: [] };

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
    hookFunctionInstalled: await functionExists(connection, HOOK_FUNCTION),
    authHookGrants: grants.state,
    missingAuthHookGrants: grants.missing,
    health: assessHealth(schemaInstalled, missingObjects, plan.pending.length, grants.state),
    missingObjects,
  };
}

function assessHealth(
  schemaInstalled: boolean,
  missingObjects: string[],
  pendingCount: number,
  grants: AuthHookGrantState,
): GuardSchemaHealth {
  if (!schemaInstalled) {
    return 'not-installed';
  }

  // A missing object or an unapplied migration both mean the policy engine cannot be
  // trusted. Neither may ever be reported as healthy.
  if (missingObjects.length > 0 || pendingCount > 0) {
    return 'incomplete';
  }

  // A hook Supabase Auth cannot execute is a broken guard layer, not a cosmetic gap:
  // once the hook is activated, every signup fails closed. Only a definite verdict
  // counts -- `role-absent` and `unknown` are "not verifiable here", not "broken".
  if (grants === 'incomplete') {
    return 'incomplete';
  }

  return 'complete';
}

/**
 * Checks every privilege `supabase_auth_admin` needs, using `has_*_privilege()`.
 *
 * Those functions resolve the effective privilege, including any arriving through
 * role membership, which parsing ACL strings out of the catalog would miss.
 *
 * All callers must ensure the probed objects exist first; these functions raise
 * rather than return false for an unknown object or role.
 */
async function readAuthHookGrants(
  connection: DatabaseConnection,
): Promise<{ state: AuthHookGrantState; missing: string[] }> {
  if (!(await roleExists(connection, AUTH_HOOK_ROLE))) {
    // Not a Supabase database. Report that plainly rather than inventing a verdict.
    return { state: 'role-absent', missing: [] };
  }

  const missing: string[] = [];

  for (const probe of REQUIRED_AUTH_HOOK_GRANTS) {
    if (!(await hasPrivilege(connection, AUTH_HOOK_ROLE, probe))) {
      missing.push(`${probe.privilege} on ${probe.object}`);
    }
  }

  return { state: missing.length > 0 ? 'incomplete' : 'granted', missing };
}

export interface AuthHookGrantInspection {
  readonly rolePresent: boolean;
  readonly missing: string[];
}

/**
 * Probes the least-privilege hook grant set even when one of its objects is missing.
 *
 * The ordinary status path deliberately reports grants as `unknown` when an object is
 * absent. Repair needs a more granular answer so its dry-run can name the exact grants
 * that would change. Passing object OIDs obtained through `to_reg*` makes a missing
 * object a false result rather than an exception; no catalog state is modified.
 */
export async function inspectAuthHookGrants(
  connection: DatabaseConnection,
): Promise<AuthHookGrantInspection> {
  if (!(await roleExists(connection, AUTH_HOOK_ROLE))) {
    return { rolePresent: false, missing: [] };
  }

  const missing: string[] = [];
  for (const probe of REQUIRED_AUTH_HOOK_GRANTS) {
    if (!(await hasPrivilegeSafely(connection, AUTH_HOOK_ROLE, probe))) {
      missing.push(`${probe.privilege} on ${probe.object}`);
    }
  }

  return { rolePresent: true, missing };
}

async function roleExists(connection: DatabaseConnection, role: string): Promise<boolean> {
  const result = await connection.query<{ present: boolean }>(
    'select exists (select 1 from pg_catalog.pg_roles where rolname = $1) as present',
    [role],
  );

  return result.rows[0]?.present === true;
}

/** Dispatches to the `has_*_privilege()` variant that matches the object kind. */
async function hasPrivilege(
  connection: DatabaseConnection,
  role: string,
  probe: PrivilegeProbe,
): Promise<boolean> {
  // The function name is chosen from a closed set keyed by `probe.kind`, never
  // built from a runtime value. Role, object and privilege are all bound parameters.
  const sql = {
    schema: 'select has_schema_privilege($1, $2, $3) as present',
    function: 'select has_function_privilege($1, $2, $3) as present',
    table: 'select has_table_privilege($1, $2, $3) as present',
  }[probe.kind];

  const result = await connection.query<{ present: boolean }>(sql, [
    role,
    probe.object,
    probe.privilege,
  ]);

  return result.rows[0]?.present === true;
}

async function hasPrivilegeSafely(
  connection: DatabaseConnection,
  role: string,
  probe: PrivilegeProbe,
): Promise<boolean> {
  const sql = {
    schema: 'select coalesce(has_schema_privilege($1, $2, $3), false) as present',
    function:
      'select coalesce(has_function_privilege($1, to_regprocedure($2), $3), false) as present',
    table: 'select coalesce(has_table_privilege($1, to_regclass($2), $3), false) as present',
  }[probe.kind];

  const result = await connection.query<{ present: boolean }>(sql, [
    role,
    probe.object,
    probe.privilege,
  ]);
  return result.rows[0]?.present === true;
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
