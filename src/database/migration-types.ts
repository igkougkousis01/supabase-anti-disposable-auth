/** Types for the versioned SQL migration system. */

/** A migration file discovered on disk, with its content and fingerprint. */
export interface MigrationFile {
  /** Zero-padded numeric prefix, e.g. `001`. Unique and used for ordering. */
  readonly version: string;
  /** Descriptive part of the filename, e.g. `create_domain_tables`. */
  readonly name: string;
  /** Full filename, e.g. `001_create_domain_tables.sql`. */
  readonly fileName: string;
  /** Complete file content, executed as a single statement batch. */
  readonly sql: string;
  /** SHA-256 of the line-ending-normalised content, lowercase hex. */
  readonly checksum: string;
}

/** A row of `guard.schema_migrations`. */
export interface AppliedMigration {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: Date;
}

export type MigrationState = 'applied' | 'pending';

export interface MigrationPlanEntry {
  readonly migration: MigrationFile;
  readonly state: MigrationState;
}

/**
 * What a migration run would do, computed before anything is executed.
 *
 * Building the plan is where tampering is detected: a mismatch between a file's
 * checksum and the one recorded at apply time fails the whole run.
 */
export interface MigrationPlan {
  readonly entries: MigrationPlanEntry[];
  readonly applied: MigrationFile[];
  readonly pending: MigrationFile[];
  /** Highest applied version, or `undefined` when nothing is applied yet. */
  readonly currentVersion: string | undefined;
}

/** Outcome of a completed migration run. */
export interface MigrationRunResult {
  /** Migrations executed by this run, in execution order. */
  readonly applied: MigrationFile[];
  /** Migrations already present and unchanged, so skipped. */
  readonly skipped: MigrationFile[];
  /** Highest version present after the run. */
  readonly currentVersion: string | undefined;
}
