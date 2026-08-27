/**
 * Read-only ownership and dependency inspection for repair and uninstall.
 *
 * A name is never enough evidence that an object belongs to this tool. This module
 * combines the append-only migration record with catalog identity, owner, function
 * body, table shape, constraints, unexpected-object inventory, and external dependency
 * checks. The destructive path consumes this report; it does not improvise its own
 * weaker checks.
 */

import { MigrationError } from '../lib/errors.js';
import {
  GUARD_SCHEMA,
  loadMigrationFiles,
  MIGRATIONS_TABLE,
  planMigrations,
  readAppliedMigrations,
} from './migrations.js';
import type { MigrationFile } from './migration-types.js';
import { STRICT_TRIGGER_NAME } from './strict-trigger.js';
import type { DatabaseConnection } from './types.js';

interface ExpectedColumn {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly default?: string;
}

interface ExpectedConstraint {
  readonly name: string;
  readonly type: 'p' | 'c';
  readonly columns?: string[];
  readonly fragments?: string[];
}

interface ExpectedTable {
  readonly version: string;
  readonly name: string;
  readonly columns: ExpectedColumn[];
  readonly constraints: ExpectedConstraint[];
}

interface ExpectedFunction {
  readonly version: string;
  readonly name: string;
  readonly arguments: string;
  readonly result: string;
  readonly language: 'sql' | 'plpgsql';
  readonly volatility: 'i' | 's' | 'v';
  readonly strict: boolean;
  readonly parallel: 's' | 'u';
}

const EXPECTED_TABLES: ExpectedTable[] = [
  {
    version: 'bootstrap',
    name: 'schema_migrations',
    columns: [
      { name: 'version', type: 'text', notNull: true },
      { name: 'name', type: 'text', notNull: true },
      { name: 'checksum', type: 'text', notNull: true },
      { name: 'applied_at', type: 'timestamp with time zone', notNull: true, default: 'now()' },
    ],
    constraints: [{ name: 'schema_migrations_pkey', type: 'p', columns: ['version'] }],
  },
  {
    version: '002',
    name: 'blocked_domains',
    columns: [
      { name: 'domain', type: 'text', notNull: true },
      { name: 'source', type: 'text', notNull: false },
      { name: 'created_at', type: 'timestamp with time zone', notNull: true, default: 'now()' },
    ],
    constraints: [
      { name: 'blocked_domains_pkey', type: 'p', columns: ['domain'] },
      {
        name: 'blocked_domains_domain_normalized',
        type: 'c',
        // PostgreSQL renders `IS NOT DISTINCT FROM` as `NOT (... IS DISTINCT FROM ...)`.
        fragments: ['not', 'domain is distinct from guard.normalize_domain(domain)'],
      },
    ],
  },
  {
    version: '002',
    name: 'allowed_domains',
    columns: [
      { name: 'domain', type: 'text', notNull: true },
      { name: 'reason', type: 'text', notNull: false },
      { name: 'created_at', type: 'timestamp with time zone', notNull: true, default: 'now()' },
    ],
    constraints: [
      { name: 'allowed_domains_pkey', type: 'p', columns: ['domain'] },
      {
        name: 'allowed_domains_domain_normalized',
        type: 'c',
        fragments: ['not', 'domain is distinct from guard.normalize_domain(domain)'],
      },
    ],
  },
  {
    version: '003',
    name: 'sync_metadata',
    columns: [
      { name: 'source', type: 'text', notNull: true },
      { name: 'status', type: 'text', notNull: true, default: "'pending'::text" },
      { name: 'last_attempt_at', type: 'timestamp with time zone', notNull: false },
      { name: 'last_success_at', type: 'timestamp with time zone', notNull: false },
      { name: 'domain_count', type: 'integer', notNull: false },
      { name: 'checksum', type: 'text', notNull: false },
      { name: 'error_message', type: 'text', notNull: false },
    ],
    constraints: [
      { name: 'sync_metadata_pkey', type: 'p', columns: ['source'] },
      {
        name: 'sync_metadata_status_known',
        type: 'c',
        fragments: ['status', "'pending'", "'success'", "'failed'"],
      },
      {
        name: 'sync_metadata_domain_count_non_negative',
        type: 'c',
        fragments: ['domain_count is null', 'domain_count >= 0'],
      },
    ],
  },
];

const EXPECTED_FUNCTIONS: ExpectedFunction[] = [
  {
    version: '001',
    name: 'normalize_domain',
    arguments: 'text',
    result: 'text',
    language: 'sql',
    volatility: 'i',
    strict: true,
    parallel: 's',
  },
  {
    version: '004',
    name: 'is_allowed_domain',
    arguments: 'text',
    result: 'boolean',
    language: 'sql',
    volatility: 's',
    strict: false,
    parallel: 's',
  },
  {
    version: '004',
    name: 'is_blocked_domain',
    arguments: 'text',
    result: 'boolean',
    language: 'sql',
    volatility: 's',
    strict: false,
    parallel: 's',
  },
  {
    version: '004',
    name: 'is_disposable_domain',
    arguments: 'text',
    result: 'boolean',
    language: 'plpgsql',
    volatility: 's',
    strict: false,
    parallel: 's',
  },
  {
    version: '006',
    name: 'before_user_created',
    arguments: 'jsonb',
    result: 'jsonb',
    language: 'plpgsql',
    volatility: 's',
    strict: false,
    parallel: 'u',
  },
  {
    version: '008',
    name: 'enforce_auth_user_email',
    arguments: '',
    result: 'trigger',
    language: 'plpgsql',
    volatility: 's',
    strict: false,
    parallel: 'u',
  },
];

export const CORE_DATA_TABLES = [
  `${GUARD_SCHEMA}.blocked_domains`,
  `${GUARD_SCHEMA}.allowed_domains`,
  `${GUARD_SCHEMA}.sync_metadata`,
] as const;

export const REPAIRABLE_LEAF_FUNCTIONS = [
  `${GUARD_SCHEMA}.before_user_created(jsonb)`,
  `${GUARD_SCHEMA}.enforce_auth_user_email()`,
] as const;

export interface GuardLifecycleInspection {
  readonly schemaPresent: boolean;
  readonly schemaOwner: string | undefined;
  readonly currentRole: string;
  /** True only when the history table exists and every row matches bundled evidence. */
  readonly historyVerified: boolean;
  readonly appliedVersions: string[];
  readonly pendingVersions: string[];
  readonly missingTables: string[];
  readonly missingFunctions: string[];
  readonly modifiedObjects: string[];
  readonly unexpectedObjects: string[];
  readonly ownerMismatches: string[];
  readonly externalDependencies: string[];
}

export interface InspectGuardLifecycleOptions {
  readonly files?: MigrationFile[];
}

interface SchemaRow extends Record<string, unknown> {
  readonly owner: string;
  readonly current_role: string;
}

interface RelationRow extends Record<string, unknown> {
  readonly name: string;
  readonly kind: string;
  readonly owner: string;
}

interface ColumnRow extends Record<string, unknown> {
  readonly table_name: string;
  readonly column_name: string;
  readonly type_name: string;
  readonly not_null: boolean;
  readonly default_expression: string | null;
}

interface ConstraintRow extends Record<string, unknown> {
  readonly table_name: string;
  readonly name: string;
  readonly type: string;
  readonly columns: string[] | null;
  readonly definition: string;
}

interface FunctionRow extends Record<string, unknown> {
  readonly name: string;
  readonly arguments: string;
  readonly kind: string;
  readonly result: string;
  readonly language: string;
  readonly volatility: string;
  readonly is_strict: boolean;
  readonly security_definer: boolean;
  readonly parallel: string;
  readonly config: string;
  readonly source: string;
  readonly owner: string;
}

/**
 * Builds the complete read-only safety report used by both lifecycle commands.
 *
 * Migration checksum errors deliberately propagate. A caller must turn them into the
 * command-specific conflict error; accepting a history row that cannot be verified
 * would erase the strongest ownership evidence available.
 */
export async function inspectGuardLifecycle(
  connection: DatabaseConnection,
  options: InspectGuardLifecycleOptions = {},
): Promise<GuardLifecycleInspection> {
  const files = options.files ?? (await loadMigrationFiles());
  const schemaResult = await connection.query<SchemaRow>(
    `select pg_catalog.pg_get_userbyid(n.nspowner) as owner,
            current_user::text as current_role
       from pg_catalog.pg_namespace n
      where n.nspname = $1`,
    [GUARD_SCHEMA],
  );
  const schema = schemaResult.rows[0];

  if (schema === undefined) {
    const current = await connection.query<{ current_role: string }>(
      'select current_user::text as current_role',
    );
    return emptyInspection(current.rows[0]?.current_role ?? 'unknown');
  }

  const historyPresent = await connection.query<{ present: boolean }>(
    'select to_regclass($1) is not null as present',
    [MIGRATIONS_TABLE],
  );
  const historyVerified = historyPresent.rows[0]?.present === true;
  const applied = historyVerified ? await readAppliedMigrations(connection) : [];
  const plan = historyVerified ? planMigrations(files, applied) : undefined;
  const appliedVersions = applied.map((migration) => migration.version);
  const appliedSet = new Set(appliedVersions);
  const expectedTables = EXPECTED_TABLES.filter(
    (table) => table.version === 'bootstrap' || appliedSet.has(table.version),
  );
  const expectedFunctions = EXPECTED_FUNCTIONS.filter((fn) => appliedSet.has(fn.version));

  // A DatabaseConnection owns one pg client. Keep its queries sequential: node-postgres
  // currently queues concurrent calls, but that behaviour is deprecated for pg 9.
  const relations = await readRelations(connection);
  const columns = await readColumns(connection);
  const constraints = await readConstraints(connection);
  const functions = await readFunctions(connection);
  const unusual = await readUnusualObjects(connection);
  const dependencies = await readExternalDependencies(connection);

  const expectedRelationNames = new Set<string>();
  for (const table of expectedTables) {
    expectedRelationNames.add(table.name);
    for (const constraint of table.constraints) {
      if (constraint.type === 'p') {
        // PostgreSQL gives a PRIMARY KEY's supporting index the constraint name.
        expectedRelationNames.add(constraint.name);
      }
    }
  }

  const relationByName = new Map(relations.map((row) => [row.name, row]));
  const missingTables = expectedTables
    .filter((table) => relationByName.get(table.name)?.kind !== 'r')
    .map((table) => `${GUARD_SCHEMA}.${table.name}`);
  const unexpectedObjects = relations
    .filter((row) => !expectedRelationNames.has(row.name))
    .map((row) => `${relationKind(row.kind)} ${GUARD_SCHEMA}.${row.name}`);

  const modifiedObjects: string[] = [];
  for (const table of expectedTables) {
    if (relationByName.get(table.name)?.kind !== 'r') {
      continue;
    }
    if (!columnsMatch(table, columns)) {
      modifiedObjects.push(`table ${GUARD_SCHEMA}.${table.name} has an unexpected column shape`);
    }
    inspectConstraints(table, constraints, modifiedObjects, unexpectedObjects);
  }

  const functionByIdentity = new Map(
    functions.map((row) => [functionIdentity(row.name, row.arguments), row]),
  );
  const expectedFunctionKeys = new Set(
    expectedFunctions.map((fn) => functionIdentity(fn.name, fn.arguments)),
  );
  const missingFunctions: string[] = [];

  for (const expected of expectedFunctions) {
    const identity = functionIdentity(expected.name, expected.arguments);
    const actual = functionByIdentity.get(identity);
    if (actual === undefined) {
      missingFunctions.push(`${GUARD_SCHEMA}.${identity}`);
      continue;
    }

    const source = expectedFunctionSource(files, expected);
    if (!functionMatches(actual, expected, source)) {
      modifiedObjects.push(`function ${GUARD_SCHEMA}.${identity} has an unexpected definition`);
    }
  }

  for (const fn of functions) {
    const identity = functionIdentity(fn.name, fn.arguments);
    if (!expectedFunctionKeys.has(identity) || fn.kind !== 'f') {
      unexpectedObjects.push(`${routineKind(fn.kind)} ${GUARD_SCHEMA}.${identity}`);
    }
  }
  unexpectedObjects.push(...unusual);

  const ownerMismatches: string[] = [];
  if (schema.owner !== schema.current_role) {
    ownerMismatches.push(
      `schema ${GUARD_SCHEMA} is owned by ${schema.owner}, not current role ${schema.current_role}`,
    );
  }
  for (const relation of relations) {
    if (expectedRelationNames.has(relation.name) && relation.owner !== schema.owner) {
      ownerMismatches.push(
        `${relationKind(relation.kind)} ${GUARD_SCHEMA}.${relation.name} is owned by ${relation.owner}, not schema owner ${schema.owner}`,
      );
    }
  }
  for (const fn of functions) {
    const identity = functionIdentity(fn.name, fn.arguments);
    if (expectedFunctionKeys.has(identity) && fn.owner !== schema.owner) {
      ownerMismatches.push(
        `function ${GUARD_SCHEMA}.${identity} is owned by ${fn.owner}, not schema owner ${schema.owner}`,
      );
    }
  }

  return {
    schemaPresent: true,
    schemaOwner: schema.owner,
    currentRole: schema.current_role,
    historyVerified,
    appliedVersions,
    pendingVersions:
      plan?.pending.map((migration) => migration.version) ?? files.map((f) => f.version),
    missingTables: sortedUnique(missingTables),
    missingFunctions: sortedUnique(missingFunctions),
    modifiedObjects: sortedUnique(modifiedObjects),
    unexpectedObjects: sortedUnique(unexpectedObjects),
    ownerMismatches: sortedUnique(ownerMismatches),
    externalDependencies: sortedUnique(dependencies),
  };
}

function emptyInspection(currentRole: string): GuardLifecycleInspection {
  return {
    schemaPresent: false,
    schemaOwner: undefined,
    currentRole,
    historyVerified: false,
    appliedVersions: [],
    pendingVersions: [],
    missingTables: [],
    missingFunctions: [],
    modifiedObjects: [],
    unexpectedObjects: [],
    ownerMismatches: [],
    externalDependencies: [],
  };
}

async function readRelations(connection: DatabaseConnection): Promise<RelationRow[]> {
  const result = await connection.query<RelationRow>(
    `select c.relname::text as name,
            c.relkind::text as kind,
            pg_catalog.pg_get_userbyid(c.relowner) as owner
       from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1
      order by c.relname`,
    [GUARD_SCHEMA],
  );
  return result.rows;
}

async function readColumns(connection: DatabaseConnection): Promise<ColumnRow[]> {
  const result = await connection.query<ColumnRow>(
    `select c.relname::text as table_name,
            a.attname::text as column_name,
            pg_catalog.format_type(a.atttypid, a.atttypmod) as type_name,
            a.attnotnull as not_null,
            pg_catalog.pg_get_expr(d.adbin, d.adrelid) as default_expression
       from pg_catalog.pg_attribute a
       join pg_catalog.pg_class c on c.oid = a.attrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where n.nspname = $1
        and c.relkind in ('r', 'p')
        and a.attnum > 0
        and not a.attisdropped
      order by c.relname, a.attnum`,
    [GUARD_SCHEMA],
  );
  return result.rows;
}

async function readConstraints(connection: DatabaseConnection): Promise<ConstraintRow[]> {
  const result = await connection.query<ConstraintRow>(
    `select c.relname::text as table_name,
            con.conname::text as name,
            con.contype::text as type,
            (select array_agg(a.attname::text order by key.ordinality)
               from unnest(con.conkey) with ordinality as key(attnum, ordinality)
               join pg_catalog.pg_attribute a
                 on a.attrelid = con.conrelid and a.attnum = key.attnum) as columns,
            pg_catalog.pg_get_constraintdef(con.oid) as definition
       from pg_catalog.pg_constraint con
       join pg_catalog.pg_class c on c.oid = con.conrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1
      order by c.relname, con.conname`,
    [GUARD_SCHEMA],
  );
  return result.rows;
}

async function readFunctions(connection: DatabaseConnection): Promise<FunctionRow[]> {
  const result = await connection.query<FunctionRow>(
    `select p.proname::text as name,
            pg_catalog.oidvectortypes(p.proargtypes) as arguments,
            p.prokind::text as kind,
            pg_catalog.pg_get_function_result(p.oid) as result,
            l.lanname::text as language,
            p.provolatile::text as volatility,
            p.proisstrict as is_strict,
            p.prosecdef as security_definer,
            p.proparallel::text as parallel,
            coalesce(array_to_string(p.proconfig, ','), '') as config,
            p.prosrc as source,
            pg_catalog.pg_get_userbyid(p.proowner) as owner
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       join pg_catalog.pg_language l on l.oid = p.prolang
      where n.nspname = $1
      order by p.proname, pg_catalog.oidvectortypes(p.proargtypes)`,
    [GUARD_SCHEMA],
  );
  return result.rows;
}

/** Object families not represented by pg_class, pg_proc, or pg_constraint above. */
async function readUnusualObjects(connection: DatabaseConnection): Promise<string[]> {
  const result = await connection.query<{ identity: string }>(
    `select identity
       from (
         select 'type ' || pg_catalog.format_type(t.oid, null) as identity
           from pg_catalog.pg_type t
           join pg_catalog.pg_namespace n on n.oid = t.typnamespace
          where n.nspname = $1 and t.typrelid = 0 and t.typelem = 0
         union all
         select 'operator ' || n.nspname || '.' || o.oprname
           from pg_catalog.pg_operator o
           join pg_catalog.pg_namespace n on n.oid = o.oprnamespace
          where n.nspname = $1
         union all
         select 'collation ' || n.nspname || '.' || c.collname
           from pg_catalog.pg_collation c
           join pg_catalog.pg_namespace n on n.oid = c.collnamespace
          where n.nspname = $1
         union all
         select 'conversion ' || n.nspname || '.' || c.conname
           from pg_catalog.pg_conversion c
           join pg_catalog.pg_namespace n on n.oid = c.connamespace
          where n.nspname = $1
         union all
         select 'operator class ' || n.nspname || '.' || o.opcname
           from pg_catalog.pg_opclass o
           join pg_catalog.pg_namespace n on n.oid = o.opcnamespace
          where n.nspname = $1
         union all
         select 'operator family ' || n.nspname || '.' || o.opfname
           from pg_catalog.pg_opfamily o
           join pg_catalog.pg_namespace n on n.oid = o.opfnamespace
          where n.nspname = $1
         union all
         select 'text search configuration ' || n.nspname || '.' || c.cfgname
           from pg_catalog.pg_ts_config c
           join pg_catalog.pg_namespace n on n.oid = c.cfgnamespace
          where n.nspname = $1
         union all
         select 'text search dictionary ' || n.nspname || '.' || d.dictname
           from pg_catalog.pg_ts_dict d
           join pg_catalog.pg_namespace n on n.oid = d.dictnamespace
          where n.nspname = $1
         union all
         select 'text search parser ' || n.nspname || '.' || p.prsname
           from pg_catalog.pg_ts_parser p
           join pg_catalog.pg_namespace n on n.oid = p.prsnamespace
          where n.nspname = $1
         union all
         select 'text search template ' || n.nspname || '.' || t.tmplname
           from pg_catalog.pg_ts_template t
           join pg_catalog.pg_namespace n on n.oid = t.tmplnamespace
          where n.nspname = $1
         union all
         select 'extended statistics ' || n.nspname || '.' || s.stxname
           from pg_catalog.pg_statistic_ext s
           join pg_catalog.pg_namespace n on n.oid = s.stxnamespace
          where n.nspname = $1
         union all
         select 'trigger ' || t.tgname || ' on ' || n.nspname || '.' || c.relname
           from pg_catalog.pg_trigger t
           join pg_catalog.pg_class c on c.oid = t.tgrelid
           join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          where n.nspname = $1 and not t.tgisinternal
         union all
         select 'policy ' || p.polname || ' on ' || n.nspname || '.' || c.relname
           from pg_catalog.pg_policy p
           join pg_catalog.pg_class c on c.oid = p.polrelid
           join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          where n.nspname = $1
         union all
         select 'rule ' || r.rulename || ' on ' || n.nspname || '.' || c.relname
           from pg_catalog.pg_rewrite r
           join pg_catalog.pg_class c on c.oid = r.ev_class
           join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          where n.nspname = $1 and r.rulename <> '_RETURN'
       ) objects
      order by identity`,
    [GUARD_SCHEMA],
  );
  return result.rows.map((row) => row.identity);
}

/**
 * Finds objects outside guard that PostgreSQL says depend on a guard relation,
 * function, or standalone type. Internal dependents inside guard are expected and are
 * filtered; the one expected external dependent is our verified-by-name strict trigger,
 * which has its own stronger catalog inspection before it is excluded here.
 */
async function readExternalDependencies(connection: DatabaseConnection): Promise<string[]> {
  const result = await connection.query<{ identity: string }>(
    `with guard_objects(classid, objid) as (
       select 'pg_catalog.pg_class'::regclass::oid, c.oid
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1
       union all
       select 'pg_catalog.pg_proc'::regclass::oid, p.oid
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = $1
       union all
       select 'pg_catalog.pg_type'::regclass::oid, t.oid
         from pg_catalog.pg_type t
         join pg_catalog.pg_namespace n on n.oid = t.typnamespace
        where n.nspname = $1
     ), dependency_rows as (
       select distinct d.classid, d.objid, d.objsubid
         from pg_catalog.pg_depend d
         join guard_objects g on g.classid = d.refclassid and g.objid = d.refobjid
        where d.deptype <> 'i'
     )
     select pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid) as identity
       from dependency_rows d
      where not (
        (d.classid = 'pg_catalog.pg_class'::regclass::oid and exists (
          select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           where c.oid = d.objid and n.nspname = $1
        ))
        or (d.classid = 'pg_catalog.pg_proc'::regclass::oid and exists (
          select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
           where p.oid = d.objid and n.nspname = $1
        ))
        or (d.classid = 'pg_catalog.pg_type'::regclass::oid and exists (
          select 1 from pg_catalog.pg_type t join pg_catalog.pg_namespace n on n.oid = t.typnamespace
           where t.oid = d.objid and n.nspname = $1
        ))
        or (d.classid = 'pg_catalog.pg_constraint'::regclass::oid and exists (
          select 1 from pg_catalog.pg_constraint c join pg_catalog.pg_namespace n on n.oid = c.connamespace
           where c.oid = d.objid and n.nspname = $1
        ))
        or (d.classid = 'pg_catalog.pg_attrdef'::regclass::oid and exists (
          select 1 from pg_catalog.pg_attrdef a
          join pg_catalog.pg_class c on c.oid = a.adrelid
          join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           where a.oid = d.objid and n.nspname = $1
        ))
        or (d.classid = 'pg_catalog.pg_rewrite'::regclass::oid and exists (
          select 1 from pg_catalog.pg_rewrite r
          join pg_catalog.pg_class c on c.oid = r.ev_class
          join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           where r.oid = d.objid and n.nspname = $1
        ))
        or (d.classid = 'pg_catalog.pg_trigger'::regclass::oid and exists (
          select 1 from pg_catalog.pg_trigger t
          join pg_catalog.pg_class c on c.oid = t.tgrelid
          join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           where t.oid = d.objid
             and (n.nspname = $1 or (n.nspname = 'auth' and c.relname = 'users' and t.tgname = $2))
        ))
        or (d.classid = 'pg_catalog.pg_policy'::regclass::oid and exists (
          select 1 from pg_catalog.pg_policy p
          join pg_catalog.pg_class c on c.oid = p.polrelid
          join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           where p.oid = d.objid and n.nspname = $1
        ))
      )
      order by identity`,
    [GUARD_SCHEMA, STRICT_TRIGGER_NAME],
  );
  return result.rows.map((row) => row.identity);
}

function columnsMatch(table: ExpectedTable, rows: ColumnRow[]): boolean {
  const actual = rows.filter((row) => row.table_name === table.name);
  if (actual.length !== table.columns.length) {
    return false;
  }

  return table.columns.every((expected, index) => {
    const row = actual[index];
    return (
      row?.column_name === expected.name &&
      row.type_name === expected.type &&
      row.not_null === expected.notNull &&
      normalizeDefault(row.default_expression) === normalizeDefault(expected.default)
    );
  });
}

function inspectConstraints(
  table: ExpectedTable,
  rows: ConstraintRow[],
  modified: string[],
  unexpected: string[],
): void {
  const actual = rows.filter((row) => row.table_name === table.name);
  const expectedByName = new Map(
    table.constraints.map((constraint) => [constraint.name, constraint]),
  );

  for (const expected of table.constraints) {
    const row = actual.find((candidate) => candidate.name === expected.name);
    if (row === undefined) {
      modified.push(`table ${GUARD_SCHEMA}.${table.name} is missing constraint ${expected.name}`);
      continue;
    }

    const columnsMatchExpected =
      expected.columns === undefined || arraysEqual(row.columns ?? [], expected.columns);
    const definition = normalizeDefinition(row.definition);
    const fragmentsMatch =
      expected.fragments === undefined ||
      expected.fragments.every((fragment) => definition.includes(normalizeDefinition(fragment)));
    if (row.type !== expected.type || !columnsMatchExpected || !fragmentsMatch) {
      modified.push(
        `constraint ${expected.name} on ${GUARD_SCHEMA}.${table.name} differs from the installed definition`,
      );
    }
  }

  for (const row of actual) {
    if (!expectedByName.has(row.name)) {
      unexpected.push(`constraint ${row.name} on ${GUARD_SCHEMA}.${table.name}`);
    }
  }
}

function functionMatches(actual: FunctionRow, expected: ExpectedFunction, source: string): boolean {
  return (
    actual.kind === 'f' &&
    actual.result === expected.result &&
    actual.language === expected.language &&
    actual.volatility === expected.volatility &&
    actual.is_strict === expected.strict &&
    actual.security_definer === false &&
    actual.parallel === expected.parallel &&
    actual.config === 'search_path=""' &&
    normalizeSource(actual.source) === normalizeSource(source)
  );
}

function expectedFunctionSource(files: MigrationFile[], expected: ExpectedFunction): string {
  const file = files.find((candidate) => candidate.version === expected.version);
  if (file === undefined) {
    throw new MigrationError(
      `Cannot verify guard.${expected.name}: migration ${expected.version} is missing`,
    );
  }
  return extractFunctionSource(file.sql, expected.name);
}

/** Extracts the body used for an exact current-definition comparison. */
export function extractFunctionSource(sql: string, functionName: string): string {
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+guard\\.${escaped}\\s*\\([^)]*\\)[\\s\\S]*?\\bas\\s+\\$\\$([\\s\\S]*?)\\$\\$;`,
    'i',
  );
  const match = expression.exec(sql);
  const source = match?.[1];
  if (source === undefined) {
    throw new MigrationError(`Could not extract the expected definition of guard.${functionName}`);
  }
  return source;
}

/** Extracts one CREATE FUNCTION statement for a deliberate leaf-object repair. */
export function extractCreateFunctionSql(sql: string, functionName: string): string {
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+guard\\.${escaped}\\s*\\([^)]*\\)[\\s\\S]*?\\bas\\s+\\$\\$[\\s\\S]*?\\$\\$;`,
    'i',
  );
  const statement = expression.exec(sql)?.[0];
  if (statement === undefined) {
    throw new MigrationError(`Could not build the repair routine for guard.${functionName}`);
  }
  return statement;
}

function normalizeDefault(value: string | undefined | null): string {
  return value?.trim().toLowerCase().replace(/\s+/g, ' ') ?? '';
}

function normalizeDefinition(value: string): string {
  return value
    .toLowerCase()
    .replace(/::[a-z ]+/g, '')
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSource(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

function functionIdentity(name: string, args: string): string {
  return `${name}(${args})`;
}

function relationKind(kind: string): string {
  return (
    {
      r: 'table',
      p: 'partitioned table',
      v: 'view',
      m: 'materialized view',
      S: 'sequence',
      f: 'foreign table',
      i: 'index',
      I: 'partitioned index',
    }[kind] ?? `relation (${kind})`
  );
}

function routineKind(kind: string): string {
  return (
    {
      f: 'function',
      p: 'procedure',
      a: 'aggregate',
      w: 'window function',
    }[kind] ?? `routine (${kind})`
  );
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
