/**
 * Versioned SQL migrations.
 *
 * Files in `migrations/` are the single source of truth for everything this tool
 * creates in the database. The runner is deliberately small and direct -- no ORM, no
 * migration framework -- and follows a few rules that exist to make a failed or
 * tampered-with run impossible to miss:
 *
 *  - Order is the numeric filename prefix, never directory listing order.
 *  - Each file is executed as one statement batch through the simple query protocol.
 *    Splitting on `;` would corrupt any function body, so it is never done.
 *  - Each file runs inside its own transaction, together with the history row that
 *    records it. Either both land or neither does, so a partial application cannot be
 *    silently recorded as complete.
 *  - A file that has already been applied is re-checksummed. If it changed, the run
 *    fails; the altered file is never re-executed and never quietly accepted.
 *  - A session advisory lock serialises concurrent runs against the same database.
 *
 * The `guard` schema and `guard.schema_migrations` are the one exception to "all SQL
 * lives in a file": they must exist before any migration can be tracked, so the runner
 * creates them itself, idempotently, from the constant below.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { MigrationError } from '../lib/errors.js';
import { getPackageRoot } from '../lib/package-info.js';
import type {
  AppliedMigration,
  MigrationFile,
  MigrationPlan,
  MigrationPlanEntry,
  MigrationRunResult,
} from './migration-types.js';
import { inTransaction } from './transaction.js';
import type { DatabaseConnection } from './types.js';

/** Schema every object this tool creates lives in. Never `public`, never `auth`. */
export const GUARD_SCHEMA = 'guard';

/** Fully-qualified migration history table. */
export const MIGRATIONS_TABLE = `${GUARD_SCHEMA}.schema_migrations`;

/** Directory holding the `.sql` files, relative to the package root. */
export const MIGRATIONS_DIRECTORY_NAME = 'migrations';

/**
 * `<3-digit version>_<lowercase_snake_case name>.sql`.
 *
 * Strict on purpose: the version drives execution order and the whole filename is
 * recorded as an audit trail, so an ambiguous or unsortable name is rejected rather
 * than guessed at.
 */
const MIGRATION_FILE_PATTERN = /^(\d{3})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

/**
 * Key for the session advisory lock held during a run.
 *
 * An arbitrary but fixed constant. Two CLI processes migrating the same database will
 * contend on this, so the second fails fast instead of interleaving DDL.
 */
const MIGRATION_LOCK_KEY = 7_233_492_004;

/**
 * Bootstrap DDL. A constant -- nothing is interpolated into it.
 *
 * `if not exists` on both statements makes re-running a no-op, which is what allows
 * `install` to be safely repeatable.
 */
const BOOTSTRAP_SQL = `
create schema if not exists guard;

create table if not exists guard.schema_migrations (
  version text not null,
  name text not null,
  checksum text not null,
  applied_at timestamptz not null default now(),

  constraint schema_migrations_pkey primary key (version)
);

comment on table guard.schema_migrations is
  'Applied migrations. Managed by the supabase-anti-disposable-auth CLI; do not edit by hand.';
`;

/** Splits a migration filename into its version and name, or `undefined` if invalid. */
export function parseMigrationFileName(
  fileName: string,
): { version: string; name: string } | undefined {
  const match = MIGRATION_FILE_PATTERN.exec(fileName);
  if (match === null) {
    return undefined;
  }

  const [, version, name] = match;
  if (version === undefined || name === undefined) {
    return undefined;
  }

  return { version, name };
}

/**
 * SHA-256 of the migration content, lowercase hex.
 *
 * CRLF is normalised to LF first so that checking the repository out on Windows, or
 * with a line-ending-rewriting Git config, does not read as tampering.
 */
export function calculateChecksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** Absolute path of the bundled `migrations/` directory. */
export function resolveMigrationsDirectory(): string {
  const root = getPackageRoot();
  if (root === undefined) {
    throw new MigrationError('Could not locate the installed package root', {
      hint: 'Reinstall the CLI; its migrations directory could not be found.',
    });
  }

  return join(root, MIGRATIONS_DIRECTORY_NAME);
}

/**
 * Reads and validates every migration file, sorted by version.
 *
 * @throws MigrationError when the directory is unreadable, a filename is invalid, or
 * two files claim the same version.
 */
export async function loadMigrationFiles(
  directory: string = resolveMigrationsDirectory(),
): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (cause) {
    throw new MigrationError(`Could not read the migrations directory`, {
      cause,
      hint: `Expected SQL migrations in ${directory}.`,
    });
  }

  const sqlFiles = entries.filter((entry) => entry.endsWith('.sql')).sort();

  const migrations: MigrationFile[] = [];
  const seenVersions = new Map<string, string>();

  for (const fileName of sqlFiles) {
    const parsed = parseMigrationFileName(fileName);
    if (parsed === undefined) {
      throw new MigrationError(`Invalid migration filename: ${fileName}`, {
        hint: 'Migrations must be named <three digits>_<lower_snake_case>.sql, e.g. 006_add_domain_notes.sql.',
      });
    }

    const previous = seenVersions.get(parsed.version);
    if (previous !== undefined) {
      throw new MigrationError(
        `Duplicate migration version ${parsed.version}: ${previous} and ${fileName}`,
        { hint: 'Every migration needs a unique version prefix. Renumber one of them.' },
      );
    }
    seenVersions.set(parsed.version, fileName);

    const sql = await readFile(join(directory, fileName), 'utf8');

    migrations.push({
      version: parsed.version,
      name: parsed.name,
      fileName,
      sql,
      checksum: calculateChecksum(sql),
    });
  }

  // Versions are fixed-width, so lexicographic order is numeric order.
  return migrations.sort((a, b) => a.version.localeCompare(b.version));
}

/**
 * Works out which migrations still need to run, without touching the database.
 *
 * Pure, so every failure mode below is unit-testable: this is where tampering,
 * disappearing files and out-of-order additions are caught, before anything executes.
 *
 * @throws MigrationError if an applied migration's file is missing, was renamed, or
 * its content changed since it was applied, or if a pending migration would run out of
 * order.
 */
export function planMigrations(files: MigrationFile[], applied: AppliedMigration[]): MigrationPlan {
  const byVersion = new Map(files.map((file) => [file.version, file]));
  const appliedByVersion = new Map(applied.map((record) => [record.version, record]));

  for (const record of applied) {
    const file = byVersion.get(record.version);

    if (file === undefined) {
      throw new MigrationError(
        `Migration ${record.version}_${record.name} is recorded as applied but its file is missing`,
        {
          hint: 'Restore the migration file or reinstall the CLI at the version that created it. Applied migrations must never be deleted.',
        },
      );
    }

    if (file.name !== record.name) {
      throw new MigrationError(
        `Migration ${record.version} was applied as "${record.name}" but the file is now "${file.name}"`,
        {
          hint: 'Renaming an applied migration breaks the audit trail. Restore the original name.',
        },
      );
    }

    if (file.checksum !== record.checksum) {
      throw new MigrationError(`Migration ${file.fileName} changed after it was applied`, {
        hint: 'An already-applied migration must never be edited, because the database still reflects the original. Revert the file and add a new migration instead.',
      });
    }
  }

  const entries: MigrationPlanEntry[] = files.map((migration) => ({
    migration,
    state: appliedByVersion.has(migration.version) ? ('applied' as const) : ('pending' as const),
  }));

  const appliedFiles = entries.filter((e) => e.state === 'applied').map((e) => e.migration);
  const pending = entries.filter((e) => e.state === 'pending').map((e) => e.migration);
  const currentVersion = appliedFiles.at(-1)?.version;

  // A new file numbered below an already-applied one would run after migrations that
  // were written assuming it did not exist. Refuse rather than guess.
  if (currentVersion !== undefined) {
    const outOfOrder = pending.find((migration) => migration.version < currentVersion);
    if (outOfOrder !== undefined) {
      throw new MigrationError(
        `Migration ${outOfOrder.fileName} is numbered below the applied version ${currentVersion}`,
        {
          hint: 'Renumber it above the highest applied migration so ordering stays deterministic.',
        },
      );
    }
  }

  return { entries, applied: appliedFiles, pending, currentVersion };
}

/**
 * Creates the `guard` schema and the migration history table if they are absent.
 *
 * Safe to run against an already-installed database.
 */
export async function ensureMigrationInfrastructure(connection: DatabaseConnection): Promise<void> {
  await inTransaction(connection, async () => {
    await connection.execute(BOOTSTRAP_SQL);
  });
}

/**
 * Reads the migration history.
 *
 * Returns an empty list when the table does not exist yet, so callers can inspect a
 * database that has never been installed without creating anything in it.
 */
export async function readAppliedMigrations(
  connection: DatabaseConnection,
): Promise<AppliedMigration[]> {
  const present = await connection.query<{ present: boolean }>(
    'select to_regclass($1) is not null as present',
    [MIGRATIONS_TABLE],
  );

  if (present.rows[0]?.present !== true) {
    return [];
  }

  const result = await connection.query<{
    version: string;
    name: string;
    checksum: string;
    applied_at: Date;
  }>(
    `select version, name, checksum, applied_at
     from ${MIGRATIONS_TABLE}
     order by version`,
  );

  return result.rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}

export interface RunMigrationsOptions {
  /** Migrations to consider. Defaults to the bundled `migrations/` directory. */
  readonly files?: MigrationFile[];
  /** Called after each migration is committed, for progress output. */
  readonly onApplied?: (migration: MigrationFile) => void;
}

/**
 * Applies every pending migration, in order, and records each one.
 *
 * Stops at the first failure: later migrations assume earlier ones succeeded, so
 * continuing would compound the damage. Whatever committed before the failure stays
 * recorded, so a re-run resumes from exactly that point.
 */
export async function runMigrations(
  connection: DatabaseConnection,
  options: RunMigrationsOptions = {},
): Promise<MigrationRunResult> {
  const files = options.files ?? (await loadMigrationFiles());

  await acquireMigrationLock(connection);

  try {
    await ensureMigrationInfrastructure(connection);

    const plan = planMigrations(files, await readAppliedMigrations(connection));

    for (const migration of plan.pending) {
      await applyMigration(connection, migration);
      options.onApplied?.(migration);
    }

    return {
      applied: plan.pending,
      skipped: plan.applied,
      currentVersion: files.at(-1)?.version ?? plan.currentVersion,
    };
  } finally {
    await releaseMigrationLock(connection);
  }
}

/** Runs one migration and its history row in a single transaction. */
async function applyMigration(
  connection: DatabaseConnection,
  migration: MigrationFile,
): Promise<void> {
  try {
    await inTransaction(connection, async () => {
      await connection.execute(migration.sql);

      // Parameterised: the values are file-derived, but binding them keeps the one
      // rule that has no exceptions -- values never reach SQL by interpolation.
      await connection.query(
        `insert into ${MIGRATIONS_TABLE} (version, name, checksum) values ($1, $2, $3)`,
        [migration.version, migration.name, migration.checksum],
      );
    });
  } catch (cause) {
    throw new MigrationError(`Migration ${migration.fileName} failed`, {
      cause,
      hint: 'The migration was rolled back and not recorded. Fix the cause and run install again.',
    });
  }
}

/**
 * Session-level advisory lock, so two concurrent installs cannot interleave.
 *
 * `pg_try_advisory_lock` rather than the blocking variant: waiting behind another
 * process for an unbounded time is worse UX than a clear "already running".
 */
async function acquireMigrationLock(connection: DatabaseConnection): Promise<void> {
  const result = await connection.query<{ locked: boolean }>(
    'select pg_try_advisory_lock($1) as locked',
    [MIGRATION_LOCK_KEY],
  );

  if (result.rows[0]?.locked !== true) {
    throw new MigrationError('Another migration run is already in progress', {
      hint: 'Wait for the other install to finish, then try again.',
    });
  }
}

async function releaseMigrationLock(connection: DatabaseConnection): Promise<void> {
  try {
    await connection.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
  } catch {
    // The lock is session-scoped, so closing the connection releases it anyway. A
    // failure here must not mask the error that is already propagating.
  }
}
