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

  /**
   * Reference of the hosted Supabase project whose Auth configuration may be read or
   * changed, e.g. `abcdefghijklmnopqrst`.
   *
   * Not a secret — it appears in every Supabase URL an operator already sees — but it
   * is interpolated into an API path, so its shape is validated before use.
   *
   * Optional at load time. Only the `hook` commands require it, and `status` treats its
   * absence as "remote activation not checked" rather than as an error.
   */
  readonly projectRef: string | undefined;

  /**
   * Supabase Management API access token (a personal access token, or an OAuth token).
   *
   * **The highest-value secret this tool handles.** A personal access token carries the
   * privileges of the account that issued it across every project that account can
   * reach — far wider than `databaseUrl`, which is scoped to one database.
   *
   * It must only ever leave this process inside an `Authorization: Bearer` header. It is
   * never logged, never placed in a URL, never written to disk, never passed as a
   * process argument, and never included in an error message. `tests/unit/secrets.test.ts`
   * asserts this with a sentinel value.
   */
  readonly accessToken: string | undefined;
}

/**
 * Management API credentials, proven present.
 *
 * Commands that mutate or read hosted Auth configuration take this rather than
 * {@link AppConfig}, so "are the credentials there?" is answered once, by the type
 * system, instead of being re-checked at every call site.
 */
export interface ManagementCredentials {
  readonly projectRef: string;
  /** Secret. Only ever sent as an `Authorization: Bearer` header value. */
  readonly accessToken: string;
}

/** Semantic version parts of the minimum supported Node.js runtime. */
export interface NodeVersionRequirement {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}
