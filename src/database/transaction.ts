/**
 * The one place transaction boundaries are written.
 *
 * Both the migration runner and the blocklist sync depend on "either all of this
 * landed or none of it did". Two hand-rolled copies of begin/commit/rollback would be
 * two chances to drift, and the failure mode of a subtly different rollback path is a
 * half-applied change that nothing detects -- so there is exactly one implementation.
 */

import type { DatabaseConnection } from './types.js';

/**
 * Runs `work` inside a transaction, committing on success and rolling back on any
 * throw.
 *
 * The rollback failure is swallowed on purpose: by then the connection is either
 * already aborted or gone, and the error that is propagating is the one that explains
 * what actually happened.
 */
export async function inTransaction<T>(
  connection: DatabaseConnection,
  work: () => Promise<T>,
): Promise<T> {
  await connection.execute('begin');

  let result: T;
  try {
    result = await work();
  } catch (error) {
    try {
      await connection.execute('rollback');
    } catch {
      // Already aborted, or the connection is gone.
    }
    throw error;
  }

  await connection.execute('commit');
  return result;
}
