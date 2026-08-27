/**
 * Optional strict mode: the one trigger this tool is ever allowed to create on
 * `auth.users`, and everything needed to inspect it honestly.
 *
 * ```text
 *   Before User Created Hook   supported primary layer, client-friendly rejection
 *   strict trigger             optional database backstop, integrity over UX
 * ```
 *
 * Strict mode is opt-in, off by default, reversible, and independent of `install`.
 * Migration 008 installs `guard.enforce_auth_user_email()`; nothing creates the trigger
 * except `strict enable`. A database is expected to sit in the state "function present,
 * trigger absent" indefinitely, and that state is healthy.
 *
 * Two rules govern every line below:
 *
 *  - **Identifiers are compiled in.** No trigger, table, column or function name is
 *    ever taken from user input, a query result or a setting. The DDL constants are
 *    built from module constants at load time and are asserted by a unit test.
 *  - **State is read from the catalog, not from a string.** `pg_get_triggerdef()` is
 *    captured for the operator to read, never parsed to make a decision. Ownership is
 *    established by `pg_trigger.tgfoid`, `tgtype`, `tgattr` and `tgenabled`, because a
 *    trigger that merely shares our name is exactly the case that must not be
 *    overwritten.
 */

import { GUARD_SCHEMA } from './migrations.js';
import type { DatabaseConnection } from './types.js';

/**
 * The single, fixed identity of the strict trigger.
 *
 * Never generated, never suffixed, never configurable. One stable name is what makes
 * "is this ours?" answerable at all, and what makes `strict disable` able to remove
 * exactly what `strict enable` created and nothing else.
 *
 * The name is descriptive rather than positional. PostgreSQL fires same-kind triggers
 * in alphabetical order by name, so a leading `a_`/`zz_` would let this tool quietly
 * reorder somebody else's `BEFORE` triggers on `auth.users`. It does not attempt that.
 */
export const STRICT_TRIGGER_NAME = 'supabase_anti_disposable_auth_strict_email';

/** The Supabase-managed schema. This tool creates nothing inside it except the trigger. */
export const AUTH_SCHEMA = 'auth';
export const AUTH_USERS_RELATION = 'users';
export const AUTH_USERS_TABLE = `${AUTH_SCHEMA}.${AUTH_USERS_RELATION}`;
export const AUTH_USERS_EMAIL_COLUMN = 'email';

/** The trigger function, which lives in `guard` -- never in `auth`, never in `public`. */
export const STRICT_TRIGGER_FUNCTION_NAME = 'enforce_auth_user_email';
export const STRICT_TRIGGER_FUNCTION = `${GUARD_SCHEMA}.${STRICT_TRIGGER_FUNCTION_NAME}()`;

/**
 * `pg_trigger.tgtype` for `BEFORE INSERT OR UPDATE ... FOR EACH ROW`.
 *
 * ROW(1) | BEFORE(2) | INSERT(4) | UPDATE(16). DELETE(8), TRUNCATE(32) and
 * INSTEAD OF(64) are all absent, so an exact comparison rejects a trigger that fires on
 * more -- or fewer -- events than strict mode was designed for. Verified against a live
 * PostgreSQL catalog, not inferred.
 */
export const EXPECTED_TRIGGER_TYPE = 1 | 2 | 4 | 16;

/**
 * `pg_trigger.tgenabled` for a trigger that fires normally.
 *
 * `D` (disabled), `R` (replica) and `A` (always) are all deliberate operator decisions
 * that this tool did not make and will not silently undo.
 */
const ENABLED_ORIGIN = 'O';

/** Types whose values are text. `S` is PostgreSQL's own string category. */
const STRING_TYPE_CATEGORY = 'S';

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

/**
 * The exact statement `strict enable` runs, and the only `CREATE TRIGGER` in this tool.
 *
 * Every identifier in it is a module constant resolved at load time. There is no
 * parameter, no interpolated runtime value and no dynamic SQL, so there is nothing here
 * for a caller to influence -- the only user-controlled input the strict commands accept
 * is `--dry-run`.
 */
export const CREATE_STRICT_TRIGGER_SQL = `create trigger ${STRICT_TRIGGER_NAME}
  before insert or update of ${AUTH_USERS_EMAIL_COLUMN} on ${AUTH_USERS_TABLE}
  for each row execute function ${STRICT_TRIGGER_FUNCTION}`;

/**
 * The exact statement `strict disable` runs.
 *
 * Deliberately not `drop trigger if exists`, and deliberately never preceded by one.
 * A blind drop-and-recreate is how a trigger somebody else created under our name would
 * get destroyed; the caller establishes ownership from the catalog first, and only then
 * runs this.
 */
export const DROP_STRICT_TRIGGER_SQL = `drop trigger ${STRICT_TRIGGER_NAME} on ${AUTH_USERS_TABLE}`;

// ---------------------------------------------------------------------------
// Trigger state
// ---------------------------------------------------------------------------

export type StrictTriggerState =
  /** No trigger with our name exists on `auth.users`. Strict mode is off. */
  | { readonly kind: 'absent' }
  /** A trigger with our name exists and matches our expected definition exactly. */
  | { readonly kind: 'ours'; readonly definition: string }
  /**
   * A trigger with our name exists and is not the one we create.
   *
   * Never repaired, never replaced, never dropped automatically. `reasons` names each
   * mismatch so an operator can decide what to do about it.
   */
  | { readonly kind: 'conflict'; readonly reasons: string[]; readonly definition: string };

interface TriggerRow extends Record<string, unknown> {
  readonly tgtype: number;
  readonly tgenabled: string;
  readonly is_constraint: boolean;
  readonly has_when: boolean;
  readonly function_schema: string | null;
  readonly function_name: string | null;
  readonly columns: string[] | null;
  readonly definition: string;
}

/**
 * Looks up the trigger by name, from the catalog.
 *
 * Joined through `pg_class`/`pg_namespace` by NAME rather than cast through
 * `'auth.users'::regclass`, because the cast raises when the table does not exist and
 * this must answer "absent" on a plain PostgreSQL database instead of failing.
 *
 * `tgisinternal` triggers -- the ones PostgreSQL creates for foreign keys and deferred
 * constraints -- are excluded: they are not user triggers and can never be ours.
 */
export async function readStrictTriggerState(
  connection: DatabaseConnection,
): Promise<StrictTriggerState> {
  const result = await connection.query<TriggerRow>(
    `select
       t.tgtype::int as tgtype,
       t.tgenabled::text as tgenabled,
       t.tgconstraint <> 0 as is_constraint,
       t.tgqual is not null as has_when,
       pn.nspname as function_schema,
       p.proname as function_name,
       -- attname has the NAME type, and node-postgres has no parser for name[], so
       -- an uncast array arrives as the raw string {email}. Casting to text[] gives
       -- the driver a type it does parse into a JavaScript array.
       (select array_agg(a.attname::text order by a.attnum)
          from pg_catalog.pg_attribute a
         where a.attrelid = t.tgrelid
           and a.attnum = any (t.tgattr::int2[])) as columns,
       pg_catalog.pg_get_triggerdef(t.oid) as definition
     from pg_catalog.pg_trigger t
     join pg_catalog.pg_class c on c.oid = t.tgrelid
     join pg_catalog.pg_namespace cn on cn.oid = c.relnamespace
     left join pg_catalog.pg_proc p on p.oid = t.tgfoid
     left join pg_catalog.pg_namespace pn on pn.oid = p.pronamespace
     where cn.nspname = $1
       and c.relname = $2
       and t.tgname = $3
       and not t.tgisinternal`,
    [AUTH_SCHEMA, AUTH_USERS_RELATION, STRICT_TRIGGER_NAME],
  );

  const row = result.rows[0];
  if (row === undefined) {
    return { kind: 'absent' };
  }

  const reasons = describeMismatches(row);
  const definition = row.definition;

  return reasons.length === 0
    ? { kind: 'ours', definition }
    : { kind: 'conflict', reasons, definition };
}

/**
 * Every way a trigger under our name can fail to be the trigger we create.
 *
 * All of them are catalog facts. `pg_get_triggerdef()` is never consulted for a
 * decision: string matching on a definition is how a tool ends up fooled by whitespace,
 * by a quoted identifier, or by a future PostgreSQL that renders the same trigger
 * differently.
 */
function describeMismatches(row: TriggerRow): string[] {
  const reasons: string[] = [];

  const actualFunction =
    row.function_schema === null || row.function_name === null
      ? 'an unknown function'
      : `${row.function_schema}.${row.function_name}()`;

  if (row.function_schema !== GUARD_SCHEMA || row.function_name !== STRICT_TRIGGER_FUNCTION_NAME) {
    reasons.push(`it runs ${actualFunction} instead of ${STRICT_TRIGGER_FUNCTION}`);
  }

  if (row.tgtype !== EXPECTED_TRIGGER_TYPE) {
    reasons.push(
      `its timing or events differ from BEFORE INSERT OR UPDATE ... FOR EACH ROW (pg_trigger.tgtype is ${String(row.tgtype)}, expected ${String(EXPECTED_TRIGGER_TYPE)})`,
    );
  }

  const columns = row.columns ?? [];
  if (columns.length !== 1 || columns[0] !== AUTH_USERS_EMAIL_COLUMN) {
    reasons.push(
      columns.length === 0
        ? `it has no UPDATE OF column filter, so it fires on every column update instead of only ${AUTH_USERS_EMAIL_COLUMN}`
        : `its UPDATE OF column filter is (${columns.join(', ')}) instead of (${AUTH_USERS_EMAIL_COLUMN})`,
    );
  }

  if (row.tgenabled !== ENABLED_ORIGIN) {
    // A trigger switched off with ALTER TABLE ... DISABLE TRIGGER enforces nothing.
    // Reporting it as enabled would be a lie, and re-enabling it would overwrite a
    // decision somebody made on purpose.
    reasons.push(
      `it is not enabled for origin writes (pg_trigger.tgenabled is '${row.tgenabled}')`,
    );
  }

  if (row.is_constraint) {
    reasons.push('it is a constraint trigger, which this tool never creates');
  }

  if (row.has_when) {
    reasons.push('it carries a WHEN clause, which this tool never creates');
  }

  return reasons;
}

// ---------------------------------------------------------------------------
// auth.users compatibility
// ---------------------------------------------------------------------------

export interface AuthUsersCompatibility {
  readonly tablePresent: boolean;
  /** `undefined` when the table or the column is absent. */
  readonly emailColumnType: string | undefined;
  /** True only when an `email` column exists and holds text. */
  readonly emailColumnCompatible: boolean;
  /** `undefined` when the table is absent, because the probe would raise. */
  readonly canCreateTrigger: boolean | undefined;
  /** `undefined` when the `auth` schema is absent. */
  readonly authSchemaUsage: boolean | undefined;
}

/**
 * Establishes whether this database is one where strict mode can exist at all.
 *
 * Every probe is a plain SELECT and none of them raise on a database that has no `auth`
 * schema, which is the normal case for a local development server. `strict status` must
 * be safe to run anywhere.
 *
 * The `auth.users` shape is checked rather than assumed. Supabase states that objects it
 * manages "may change at any time", so the column this trigger depends on is verified to
 * exist and to hold text before any DDL is contemplated.
 */
export async function readAuthUsersCompatibility(
  connection: DatabaseConnection,
): Promise<AuthUsersCompatibility> {
  const table = await connection.query<{ present: boolean }>(
    'select to_regclass($1) is not null as present',
    [AUTH_USERS_TABLE],
  );

  if (table.rows[0]?.present !== true) {
    return {
      tablePresent: false,
      emailColumnType: undefined,
      emailColumnCompatible: false,
      canCreateTrigger: undefined,
      authSchemaUsage: await readSchemaUsage(connection),
    };
  }

  const column = await connection.query<{ type_name: string; category: string }>(
    `select pg_catalog.format_type(a.atttypid, a.atttypmod) as type_name,
            t.typcategory::text as category
       from pg_catalog.pg_attribute a
       join pg_catalog.pg_class c on c.oid = a.attrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       join pg_catalog.pg_type t on t.oid = a.atttypid
      where n.nspname = $1
        and c.relname = $2
        and a.attname = $3
        and a.attnum > 0
        and not a.attisdropped`,
    [AUTH_SCHEMA, AUTH_USERS_RELATION, AUTH_USERS_EMAIL_COLUMN],
  );

  const found = column.rows[0];
  const privilege = await connection.query<{ present: boolean }>(
    'select has_table_privilege($1, $2) as present',
    [AUTH_USERS_TABLE, 'TRIGGER'],
  );

  return {
    tablePresent: true,
    emailColumnType: found?.type_name,
    emailColumnCompatible: found !== undefined && found.category === STRING_TYPE_CATEGORY,
    canCreateTrigger: privilege.rows[0]?.present === true,
    authSchemaUsage: await readSchemaUsage(connection),
  };
}

async function readSchemaUsage(connection: DatabaseConnection): Promise<boolean | undefined> {
  const present = await connection.query<{ present: boolean }>(
    'select exists (select 1 from pg_catalog.pg_namespace where nspname = $1) as present',
    [AUTH_SCHEMA],
  );

  if (present.rows[0]?.present !== true) {
    return undefined;
  }

  const result = await connection.query<{ present: boolean }>(
    'select has_schema_privilege($1, $2) as present',
    [AUTH_SCHEMA, 'USAGE'],
  );

  return result.rows[0]?.present === true;
}

// ---------------------------------------------------------------------------
// Overall verdict
// ---------------------------------------------------------------------------

/**
 * The headline answer for one database.
 *
 * `disabled` is a healthy, supported, expected state and must never be reported as a
 * problem: strict mode is optional, and a v1 deployment with a healthy guard layer, an
 * active Before User Created hook and strict mode off is fully protected.
 *
 * `broken` is the state that is not optional to care about -- the trigger is attached
 * and the layer it delegates to is damaged, so writes to `auth.users` are failing closed
 * right now.
 */
export type StrictMode = 'enabled' | 'disabled' | 'conflict' | 'broken' | 'unavailable';

export interface StrictModeStatus {
  readonly mode: StrictMode;
  /** Whether migration 008 has installed `guard.enforce_auth_user_email()`. */
  readonly functionInstalled: boolean;
  readonly authUsers: AuthUsersCompatibility;
  readonly trigger: StrictTriggerState;
  /**
   * Everything standing between this database and a successful `strict enable`, in a
   * stable order. Empty when the command would succeed.
   */
  readonly blockers: string[];
}

export interface ReadStrictModeStatusOptions {
  /**
   * Whether the guard layer as a whole is healthy.
   *
   * Passed in rather than re-derived so `status` reads the schema once, and so this
   * module keeps exactly one responsibility: the trigger.
   */
  readonly guardHealthy: boolean;
}

export async function readStrictModeStatus(
  connection: DatabaseConnection,
  options: ReadStrictModeStatusOptions,
): Promise<StrictModeStatus> {
  const functionPresent = await connection.query<{ present: boolean }>(
    'select to_regprocedure($1) is not null as present',
    [STRICT_TRIGGER_FUNCTION],
  );
  const functionInstalled = functionPresent.rows[0]?.present === true;

  const authUsers = await readAuthUsersCompatibility(connection);
  const trigger = await readStrictTriggerState(connection);

  return {
    mode: assessMode(trigger, authUsers, functionInstalled, options.guardHealthy),
    functionInstalled,
    authUsers,
    trigger,
    blockers: describeBlockers(authUsers, functionInstalled, options.guardHealthy),
  };
}

function assessMode(
  trigger: StrictTriggerState,
  authUsers: AuthUsersCompatibility,
  functionInstalled: boolean,
  guardHealthy: boolean,
): StrictMode {
  // A name collision outranks everything: until it is resolved, nothing else about
  // strict mode on this database can be stated truthfully.
  if (trigger.kind === 'conflict') {
    return 'conflict';
  }

  if (trigger.kind === 'ours') {
    // Attached to a damaged policy layer. The trigger has no exception handler, so this
    // is not "degraded protection" -- writes to auth.users are being rejected.
    return functionInstalled && guardHealthy ? 'enabled' : 'broken';
  }

  if (!authUsers.tablePresent || !authUsers.emailColumnCompatible || !functionInstalled) {
    return 'unavailable';
  }

  return 'disabled';
}

function describeBlockers(
  authUsers: AuthUsersCompatibility,
  functionInstalled: boolean,
  guardHealthy: boolean,
): string[] {
  const blockers: string[] = [];

  if (!authUsers.tablePresent) {
    blockers.push(`${AUTH_USERS_TABLE} does not exist in this database`);
    // Everything below needs the table, so stop naming consequences of its absence.
    return blockers;
  }

  if (authUsers.emailColumnType === undefined) {
    blockers.push(`${AUTH_USERS_TABLE} has no ${AUTH_USERS_EMAIL_COLUMN} column`);
  } else if (!authUsers.emailColumnCompatible) {
    blockers.push(
      `${AUTH_USERS_TABLE}.${AUTH_USERS_EMAIL_COLUMN} is ${authUsers.emailColumnType}, which is not a text type`,
    );
  }

  if (!functionInstalled) {
    blockers.push(`${STRICT_TRIGGER_FUNCTION} is not installed`);
  }

  if (!guardHealthy) {
    blockers.push('the guard policy layer is not healthy');
  }

  if (authUsers.authSchemaUsage === false) {
    blockers.push(`the connected role has no USAGE on the ${AUTH_SCHEMA} schema`);
  }

  if (authUsers.canCreateTrigger === false) {
    blockers.push(`the connected role has no TRIGGER privilege on ${AUTH_USERS_TABLE}`);
  }

  return blockers;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Creates the strict trigger.
 *
 * Callers must have established, from the catalog, that no trigger under our name
 * exists. This function does not check, does not use `IF NOT EXISTS`, and does not drop
 * anything first -- so a collision surfaces as a PostgreSQL error rather than as a
 * silent replacement of somebody else's trigger.
 */
export async function createStrictTrigger(connection: DatabaseConnection): Promise<void> {
  await connection.execute(CREATE_STRICT_TRIGGER_SQL);
}

/**
 * Drops the strict trigger.
 *
 * Callers must have established, from the catalog, that the trigger under our name is
 * ours. Nothing else in `auth` is touched, and no other trigger on the table is read,
 * altered or reordered.
 */
export async function dropStrictTrigger(connection: DatabaseConnection): Promise<void> {
  await connection.execute(DROP_STRICT_TRIGGER_SQL);
}
