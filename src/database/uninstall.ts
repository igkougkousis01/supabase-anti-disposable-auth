/** Explicit, dependency-safe guard cleanup. Broad CASCADE is intentionally absent. */

import { inTransaction } from './transaction.js';
import type { DatabaseConnection } from './types.js';

/**
 * Fixed removal order for every database object this project owns.
 *
 * `IF EXISTS` makes a previously interrupted or manually partial installation
 * resumable. It is safe here only because the lifecycle inspector has already proved
 * that every same-named object still present matches this tool's definition. No
 * statement uses CASCADE; an unobserved dependency therefore causes a rollback instead
 * of being destroyed.
 */
export const DROP_GUARD_OBJECTS_SQL = `
drop function if exists guard.before_user_created(jsonb);
drop function if exists guard.enforce_auth_user_email();
drop function if exists guard.is_disposable_domain(text);
drop function if exists guard.is_blocked_domain(text);
drop function if exists guard.is_allowed_domain(text);

drop table if exists guard.blocked_domains;
drop table if exists guard.allowed_domains;
drop table if exists guard.sync_metadata;

drop function if exists guard.normalize_domain(text);
drop table if exists guard.schema_migrations;
drop schema guard;
`;

export async function dropGuardObjects(connection: DatabaseConnection): Promise<void> {
  await inTransaction(connection, async () => {
    await connection.execute(DROP_GUARD_OBJECTS_SQL);
  });
}
