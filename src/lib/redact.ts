/**
 * Helpers that keep credentials out of logs and error messages.
 *
 * Connection strings contain a password. They must never be printed, written to a
 * file, or passed as a command-line argument to another process.
 */

const GENERIC_TARGET = 'the configured database';

/**
 * Describes a connection target as `host:port/database`, dropping user and password.
 *
 * Returns a generic placeholder when the string cannot be parsed, so a malformed
 * connection string can never leak through an error path.
 */
export function describeConnectionTarget(connectionString: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return GENERIC_TARGET;
  }

  const host = url.hostname;
  if (host === '') {
    return GENERIC_TARGET;
  }

  const port = url.port === '' ? '5432' : url.port;
  const database = url.pathname.replace(/^\//, '');

  return database === '' ? `${host}:${port}` : `${host}:${port}/${database}`;
}
