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

/** Shown in place of a hook URI whose scheme we do not recognise. */
const UNKNOWN_HOOK_URI = 'an unrecognised hook URI';

/** Shown when the hook slot holds something that is not a URI at all. */
const UNPARSEABLE_HOOK_URI = 'a malformed hook URI';

const CHARACTER_SPACE = 0x20;
const CHARACTER_DELETE = 0x7f;

/**
 * Replaces anything that could move a terminal cursor or begin an escape sequence.
 *
 * Text that arrived over the network is never allowed to control a console it is
 * printed to. The blocklist parser applies the same rule to rejected upstream entries,
 * for the same reason: an operator reading a diagnostic must not be the delivery
 * mechanism for an ANSI injection.
 *
 * The result is truncated to `maxLength` characters, with an ellipsis when it was cut,
 * so a hostile endpoint cannot flood a terminal through an error message either.
 */
export function sanitizeForDisplay(value: string, maxLength: number): string {
  const printable = [...value.slice(0, maxLength)]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= CHARACTER_SPACE && code !== CHARACTER_DELETE ? character : '?';
    })
    .join('');

  return value.length > maxLength ? `${printable}...` : printable;
}

/**
 * Describes somebody else's hook URI safely enough to print.
 *
 * A conflict message has to name what is already configured, or the operator cannot
 * decide anything. But the value being named came from a remote API and was written by
 * a third party, and for an HTTP hook it can carry credentials: `https://user:pass@host`
 * is legal, and a signing token in a query string is an ordinary way to secure a
 * webhook. Printing that to a terminal writes it into scrollback, CI logs and
 * screenshots.
 *
 * So the rule is per scheme:
 *
 *  - `pg-functions://` — printed in full. It addresses a database function by name and
 *    structurally cannot carry a secret.
 *  - `http:` / `https:` — reduced to scheme and host. Userinfo, port, path, query and
 *    fragment are all dropped: any of them can hold a credential, and none of them is
 *    needed for an operator to recognise which endpoint is configured.
 *  - anything else — described, never shown.
 */
export function describeHookUri(uri: string | undefined): string {
  const value = uri?.trim() ?? '';
  if (value === '') {
    return 'none';
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return UNPARSEABLE_HOOK_URI;
  }

  if (url.protocol === 'pg-functions:') {
    return sanitizeForDisplay(value, MAX_HOOK_URI_LENGTH);
  }

  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return url.hostname === ''
      ? UNPARSEABLE_HOOK_URI
      : `${url.protocol}//${sanitizeForDisplay(url.hostname, MAX_HOOK_URI_LENGTH)} (path and query withheld)`;
  }

  return UNKNOWN_HOOK_URI;
}

/**
 * Generous enough for any real `pg-functions://` URI, short enough that a hostile value
 * cannot fill a screen.
 */
const MAX_HOOK_URI_LENGTH = 120;
