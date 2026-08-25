/** Types shared by the database layer. Kept free of `pg` specifics on purpose. */

/** Values that may be bound to a parameterised statement. */
export type SqlParameter = string | number | boolean | Date | null;

export interface QueryResult<Row> {
  readonly rows: Row[];
  readonly rowCount: number;
}

/**
 * Minimal connection contract.
 *
 * Commands depend on this interface rather than on `pg` directly, which keeps the
 * database implementation swappable and lets tests run without a live server.
 */
export interface DatabaseConnection {
  /** Redacted `host:port/database` description, safe to print. */
  readonly target: string;
  query<Row extends Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameter[],
  ): Promise<QueryResult<Row>>;
  /**
   * Runs a SQL script that may contain several statements.
   *
   * Uses the simple query protocol, which is the only way to send a multi-statement
   * batch: `pg` switches to the extended protocol as soon as a parameter array is
   * present, and that protocol permits exactly one statement per message. Splitting a
   * file on `;` instead is not an option -- function bodies contain semicolons.
   *
   * SECURITY: `sql` is sent verbatim and nothing in it can be bound as a parameter, so
   * it must only ever be trusted SQL shipped with this package. Never pass user input
   * and never build the string by interpolation -- use {@link DatabaseConnection.query}
   * with bound parameters for anything value-shaped.
   */
  execute(sql: string): Promise<void>;
  close(): Promise<void>;
}

export interface DatabaseConnectionConfig {
  /** Secret. Never logged. */
  readonly connectionString: string;
  /** How long to wait for the TCP/TLS handshake before giving up. */
  readonly connectionTimeoutMillis?: number;
  /** Server-side cap for a single statement. */
  readonly statementTimeoutMillis?: number;
  /** Shows up in `pg_stat_activity`, which helps operators. */
  readonly applicationName?: string;
}

export interface ServerVersion {
  /** Numeric version reported by PostgreSQL, e.g. `17.4`, with any vendor suffix removed. */
  readonly full: string;
  readonly major: number;
}
