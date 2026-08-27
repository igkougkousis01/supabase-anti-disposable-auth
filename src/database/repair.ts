/** Fixed, surgical database repairs. No function in this file touches migration history. */

import { UnexpectedError } from '../lib/errors.js';
import { inTransaction } from './transaction.js';
import { extractCreateFunctionSql } from './lifecycle.js';
import type { MigrationFile } from './migration-types.js';
import { AUTH_HOOK_ROLE } from './schema-status.js';
import type { DatabaseConnection } from './types.js';

export type DatabaseRepairKind =
  | 'restore-before-user-created-function'
  | 'restore-strict-trigger-function'
  | 'restore-auth-hook-grants';

export interface DatabaseRepairChange {
  readonly kind: DatabaseRepairKind;
  readonly description: string;
}

const HOOK_FUNCTION_COMMENT =
  'Supabase Before User Created auth hook. Returns {} to allow, {"error": {...}} to reject. Delegates policy to guard.is_disposable_domain(); allows when the event carries no email; rejects a non-string user.email as a malformed payload; fails closed when the policy engine raises.';

const STRICT_FUNCTION_COMMENT =
  'BEFORE INSERT OR UPDATE OF email trigger function for optional strict mode. Allows a NULL or blank email; otherwise delegates to guard.is_disposable_domain() and raises 23514 when the address is disposable. Fails closed: a policy-engine error aborts the write. Installed by migration 008; the trigger itself is created only by `strict enable`.';

const REVOKE_HOOK_FUNCTION_SQL = `
comment on function guard.before_user_created(jsonb) is '${HOOK_FUNCTION_COMMENT.replaceAll("'", "''")}';
revoke all privileges on function guard.before_user_created(jsonb) from public;
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    revoke all privileges on function guard.before_user_created(jsonb) from anon;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    revoke all privileges on function guard.before_user_created(jsonb) from authenticated;
  end if;
end;
$$;
`;

const REVOKE_STRICT_FUNCTION_SQL = `
comment on function guard.enforce_auth_user_email() is '${STRICT_FUNCTION_COMMENT.replaceAll("'", "''")}';
revoke all privileges on function guard.enforce_auth_user_email() from public;
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    revoke all privileges on function guard.enforce_auth_user_email() from anon;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    revoke all privileges on function guard.enforce_auth_user_email() from authenticated;
  end if;
end;
$$;
`;

/** The complete and only grant set repair is allowed to add. */
export const RESTORE_AUTH_HOOK_GRANTS_SQL = `
grant usage on schema guard to ${AUTH_HOOK_ROLE};
grant execute on function guard.before_user_created(jsonb) to ${AUTH_HOOK_ROLE};
grant execute on function guard.is_disposable_domain(text) to ${AUTH_HOOK_ROLE};
grant execute on function guard.normalize_domain(text) to ${AUTH_HOOK_ROLE};
grant select on table guard.blocked_domains to ${AUTH_HOOK_ROLE};
grant select on table guard.allowed_domains to ${AUTH_HOOK_ROLE};
`;

/**
 * Applies only the changes previously admitted by the repair planner.
 *
 * A leaf function is recreated from the exact checksummed migration file that proves
 * what this installation originally received, but only its one CREATE FUNCTION
 * statement is extracted and executed. The historical migration batch is never rerun,
 * and no row in guard.schema_migrations is inserted, updated, or deleted.
 */
export async function applyDatabaseRepair(
  connection: DatabaseConnection,
  files: MigrationFile[],
  changes: readonly DatabaseRepairChange[],
): Promise<void> {
  const kinds = new Set(changes.map((change) => change.kind));

  await inTransaction(connection, async () => {
    if (kinds.has('restore-before-user-created-function')) {
      const migration = requireMigration(files, '006');
      await connection.execute(extractCreateFunctionSql(migration.sql, 'before_user_created'));
      await connection.execute(REVOKE_HOOK_FUNCTION_SQL);
    }

    if (kinds.has('restore-strict-trigger-function')) {
      const migration = requireMigration(files, '008');
      await connection.execute(extractCreateFunctionSql(migration.sql, 'enforce_auth_user_email'));
      await connection.execute(REVOKE_STRICT_FUNCTION_SQL);
    }

    if (
      kinds.has('restore-auth-hook-grants') ||
      kinds.has('restore-before-user-created-function')
    ) {
      await connection.execute(RESTORE_AUTH_HOOK_GRANTS_SQL);
    }
  });
}

function requireMigration(files: MigrationFile[], version: string): MigrationFile {
  const migration = files.find((candidate) => candidate.version === version);
  if (migration === undefined) {
    throw new UnexpectedError(`Repair routine requires bundled migration ${version}`);
  }
  return migration;
}
