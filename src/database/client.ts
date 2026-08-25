/**
 * Thin PostgreSQL access layer built directly on `pg`.
 *
 * There is no ORM by design: this tool manages database infrastructure (schemas,
 * functions, hooks), so plain SQL is the right level of abstraction. Later branches
 * that install migrations reuse {@link PostgresClient} unchanged.
 *
 * Rules enforced here:
 *  - connection strings are never logged, only `describeConnectionTarget()` output;
 *  - TLS settings come from the connection string and are never weakened by us;
 *  - every value passed into SQL is bound as a parameter.
 */

import pg from 'pg';

import { DatabaseConnectionError, DatabaseQueryError } from '../lib/errors.js';
import { describeConnectionTarget } from '../lib/redact.js';
import type {
  DatabaseConnection,
  DatabaseConnectionConfig,
  QueryResult,
  ServerVersion,
  SqlParameter,
} from './types.js';

const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_APPLICATION_NAME = 'supabase-anti-disposable-auth';

const CONNECTION_HINT =
  'Check SUPABASE_DB_URL, that the database accepts connections from this network, and that sslmode is set.';

/**
 * A single, explicitly managed PostgreSQL connection.
 *
 * Lifecycle is deliberate rather than pooled: the CLI performs short, sequential
 * units of work and must be able to guarantee the connection is closed afterwards.
 */
export class PostgresClient implements DatabaseConnection {
  readonly target: string;

  private readonly config: DatabaseConnectionConfig;
  private client: pg.Client | undefined;

  constructor(config: DatabaseConnectionConfig) {
    this.config = config;
    this.target = describeConnectionTarget(config.connectionString);
  }

  get isConnected(): boolean {
    return this.client !== undefined;
  }

  /**
   * Opens the connection and applies a statement timeout.
   *
   * @throws DatabaseConnectionError with the original error attached as `cause`.
   */
  async connect(): Promise<void> {
    if (this.client !== undefined) {
      return;
    }

    const client = new pg.Client({
      connectionString: this.config.connectionString,
      connectionTimeoutMillis: this.config.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS,
      application_name: this.config.applicationName ?? DEFAULT_APPLICATION_NAME,
    });

    try {
      await client.connect();
    } catch (cause) {
      await endQuietly(client);
      throw new DatabaseConnectionError(`Could not connect to ${this.target}`, {
        cause,
        hint: CONNECTION_HINT,
      });
    }

    this.client = client;

    const statementTimeout = this.config.statementTimeoutMillis ?? DEFAULT_STATEMENT_TIMEOUT_MS;
    // `SET` cannot take a bind parameter, but `set_config` can.
    await this.query('select set_config($1, $2, false)', [
      'statement_timeout',
      `${statementTimeout}ms`,
    ]);
  }

  async query<Row extends Record<string, unknown>>(
    sql: string,
    parameters: SqlParameter[] = [],
  ): Promise<QueryResult<Row>> {
    const client = this.client;
    if (client === undefined) {
      throw new DatabaseConnectionError(`Not connected to ${this.target}`, {
        hint: 'Call connect() before running a query.',
      });
    }

    try {
      const result = await client.query<Row>(sql, parameters);
      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
    } catch (cause) {
      throw new DatabaseQueryError(`Query failed against ${this.target}`, { cause });
    }
  }

  /**
   * Runs a multi-statement SQL script through the simple query protocol.
   *
   * See {@link DatabaseConnection.execute} for the security contract: the script is
   * never parameterised, so only trusted SQL that ships with this package may be
   * passed here.
   *
   * @throws DatabaseQueryError with the original error attached as `cause`.
   */
  async execute(sql: string): Promise<void> {
    const client = this.client;
    if (client === undefined) {
      throw new DatabaseConnectionError(`Not connected to ${this.target}`, {
        hint: 'Call connect() before running a script.',
      });
    }

    try {
      // No values array: passing one would select the extended protocol, which
      // rejects multi-statement batches.
      await client.query(sql);
    } catch (cause) {
      throw new DatabaseQueryError(`Script failed against ${this.target}`, { cause });
    }
  }

  /**
   * Closes the connection. Safe to call more than once.
   *
   * @throws DatabaseConnectionError if the server rejects the shutdown; the client is
   * still discarded so a retry cannot reuse a half-open connection.
   */
  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;

    if (client === undefined) {
      return;
    }

    try {
      await client.end();
    } catch (cause) {
      throw new DatabaseConnectionError(`Failed to close the connection to ${this.target}`, {
        cause,
      });
    }
  }
}

/** Creates a {@link PostgresClient} and connects it. */
export async function createPostgresConnection(
  config: DatabaseConnectionConfig,
): Promise<DatabaseConnection> {
  const client = new PostgresClient(config);
  await client.connect();
  return client;
}

/** Reads the PostgreSQL server version through an open connection. */
export async function readServerVersion(connection: DatabaseConnection): Promise<ServerVersion> {
  const result = await connection.query<{ server_version: string }>(
    'select current_setting($1) as server_version',
    ['server_version'],
  );

  const raw = result.rows[0]?.server_version;
  if (typeof raw !== 'string' || raw === '') {
    throw new DatabaseQueryError(`${connection.target} did not report a server version`);
  }

  // Builds append a vendor suffix, e.g. "18.3 (Homebrew)". Keep only the version.
  const full = /^\d+(?:\.\d+)*/.exec(raw.trim())?.[0] ?? raw.trim();
  const major = Number.parseInt(full, 10);

  return { full, major: Number.isNaN(major) ? 0 : major };
}

async function endQuietly(client: pg.Client): Promise<void> {
  try {
    await client.end();
  } catch {
    // The connection never opened; there is nothing meaningful to report here and
    // the original failure is the one the user needs to see.
  }
}
