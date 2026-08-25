/** Shape of the validated configuration used by every command. */
export interface AppConfig {
  /**
   * PostgreSQL connection string for the target Supabase project.
   *
   * Optional at load time: only commands that talk to the database require it, and
   * `doctor` needs to report its absence as a friendly message rather than a crash.
   *
   * This value is a secret. Never log it — use `describeConnectionTarget()`.
   */
  readonly databaseUrl: string | undefined;
}

/** Semantic version parts of the minimum supported Node.js runtime. */
export interface NodeVersionRequirement {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}
