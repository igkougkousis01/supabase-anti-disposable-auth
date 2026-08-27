-- 007_auth_hook_permissions.sql
--
-- The least-privilege grants that let Supabase Auth call the hook, and nothing else.
--
-- Split from 006 on purpose. 006 is portable DDL that runs identically on any
-- PostgreSQL server; this file is entirely conditional on a Supabase-specific role
-- existing. Keeping them apart means the hook function and the privilege model can
-- be reasoned about, reviewed and rolled forward independently, and a plain
-- PostgreSQL development database gets a file that is honestly a no-op rather than a
-- half-applied one.
--
-- SECURITY INVOKER vs SECURITY DEFINER
-- ------------------------------------
-- guard.before_user_created() is SECURITY INVOKER. That decision was made on its
-- merits, not by default, and it is the reason this file grants more than a single
-- EXECUTE.
--
-- Under SECURITY INVOKER the hook runs with exactly the privileges of
-- supabase_auth_admin, so that role needs everything the call chain touches:
--
--   guard.before_user_created(jsonb)
--     -> guard.is_disposable_domain(text)        EXECUTE
--          -> guard.normalize_domain(text)       EXECUTE
--          -> guard.allowed_domains              SELECT
--          -> guard.blocked_domains              SELECT
--
-- SECURITY DEFINER would reduce that to schema USAGE plus one EXECUTE. It was
-- considered and refused:
--
--   * The two SELECTs it would save are read-only access to a public disposable-domain
--     list and to an operator-maintained allowlist. Neither holds a secret. The
--     information a client must never obtain -- whether a specific domain is blocked
--     -- is already obtainable by anyone who can call the hook, whichever security
--     mode is used, so DEFINER would not actually close that channel.
--   * DEFINER would run this function as the guard owner (`postgres` on Supabase) on
--     a jsonb payload supplied by an external system, on the signup hot path. That is
--     a real privilege boundary, and it would be crossed to avoid two read grants on
--     non-secret tables. That trade is bad.
--   * "Make the permissions work" is not a justification for DEFINER, and it is the
--     only justification available here.
--
-- The whole schema therefore remains free of SECURITY DEFINER, which an integration
-- test asserts.
--
-- What is deliberately NOT granted
-- --------------------------------
--   * No INSERT, UPDATE, DELETE, TRUNCATE or REFERENCES anywhere. Supabase Auth
--     evaluates policy; it never edits it. A write grant here would let a compromised
--     auth service allowlist a domain and walk through its own filter.
--   * No CREATE on the schema.
--   * Nothing on guard.sync_metadata or guard.schema_migrations. The hook never reads
--     either, and operational state is not the auth service's business.
--   * No EXECUTE on guard.is_blocked_domain() or guard.is_allowed_domain(). The hook
--     calls neither. They exist for operators inspecting policy, and granting them
--     would hand the auth service two ways to ask a question it can already ask
--     correctly through one.
--   * Nothing to PUBLIC, anon or authenticated -- re-revoked below.
--
-- The one case this file cannot cover
-- -----------------------------------
-- The role guard below is evaluated ONCE, when this migration is applied. It is not a
-- standing rule that re-fires later.
--
-- So if this file is applied on a database where supabase_auth_admin does not exist,
-- it takes its no-op branch, completes successfully, and is recorded in
-- guard.schema_migrations -- correctly, because it did run. Creating the role
-- afterwards does NOT cause these grants to appear, and `install` will not replay this
-- file: never re-running an applied migration is what makes `install` safe to run
-- repeatedly, and that property is not traded away for this case.
--
-- Nothing here is broken by that; it is handled outside the migration:
--
--   * `status` probes every required privilege with has_*_privilege() against the live
--     catalog rather than trusting this file's history row, names what is missing, and
--     exits non-zero -- before the hook is activated in Supabase, which is the point at
--     which the gap would start rejecting every signup.
--   * The remediation is an idempotent, role-guarded snippet documented in the README
--     under "Repairing the auth hook grants". It grants exactly the six privileges
--     below and touches no migration history. Dropping the guard schema and running
--     `install` again is the supported alternative.
--
-- Do NOT repair this by editing guard.schema_migrations or by re-running this file by
-- hand. Both defeat the checksum audit the runner exists to provide.
--
-- In practice this is rare: hosted Supabase and `supabase start` both provision
-- supabase_auth_admin as part of the platform, long before this tool is installed.

do $$
begin
  -- supabase_auth_admin is the role Supabase Auth (GoTrue) connects as. It does not
  -- exist on a plain PostgreSQL instance, so every statement is guarded. All of them
  -- are compile-time constant strings: no identifier is interpolated from a query
  -- result, a setting, or any other runtime value.
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'supabase_auth_admin') then
    -- Reaching anything inside the schema requires USAGE. This is the gate that the
    -- rest of the grants sit behind; without it every EXECUTE below is inert.
    execute 'grant usage on schema guard to supabase_auth_admin';

    -- The hook itself.
    execute 'grant execute on function guard.before_user_created(jsonb) to supabase_auth_admin';

    -- The policy engine the hook delegates to, and the normaliser that engine calls.
    -- Both are needed because SECURITY INVOKER carries the caller's privileges all
    -- the way down the chain.
    execute 'grant execute on function guard.is_disposable_domain(text) to supabase_auth_admin';
    execute 'grant execute on function guard.normalize_domain(text) to supabase_auth_admin';

    -- Read-only, and only the two tables the lookup reads. Named individually rather
    -- than via `on all tables in schema guard`, which would also hand over
    -- sync_metadata and schema_migrations and would silently widen itself every time
    -- a future migration adds a table.
    execute 'grant select on guard.blocked_domains to supabase_auth_admin';
    execute 'grant select on guard.allowed_domains to supabase_auth_admin';
  end if;
end;
$$;

-- --------------------------------------------------------------------------
-- Re-assert the exclusions
-- --------------------------------------------------------------------------
-- 005_permissions.sql revoked these, but it could only act on objects that existed
-- when it ran, and 006 has since added a function. PostgreSQL grants EXECUTE to
-- PUBLIC on every new function, so this repeats the revoke for the whole schema
-- rather than trusting that 006's own revoke was the last word.
revoke all on schema guard from public;
revoke all on all tables in schema guard from public;
revoke all privileges on all functions in schema guard from public;

do $$
begin
  -- anon and authenticated are the roles PostgREST assumes for unauthenticated and
  -- signed-in API traffic. Neither may call the hook: it is an oracle for the
  -- blocklist, and it is not theirs to invoke. Supabase Auth calls it, nobody else.
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    execute 'revoke all on schema guard from anon';
    execute 'revoke all on all tables in schema guard from anon';
    execute 'revoke all privileges on all functions in schema guard from anon';
  end if;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema guard from authenticated';
    execute 'revoke all on all tables in schema guard from authenticated';
    execute 'revoke all privileges on all functions in schema guard from authenticated';
  end if;
end;
$$;
