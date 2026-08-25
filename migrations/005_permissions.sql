-- 005_permissions.sql
--
-- Least-privilege hardening. Runs last, because REVOKE ... ON ALL ... IN SCHEMA
-- only affects objects that already exist.
--
-- Ownership model
-- ---------------
-- Every object in guard is owned by the role that ran the migrations -- the
-- role behind SUPABASE_DB_URL, normally `postgres` on Supabase. That owner (and
-- superusers) retain full access implicitly; ownership is never granted away
-- and no object here is SECURITY DEFINER, so no privilege is ever borrowed.
--
-- What is deliberately NOT granted
-- --------------------------------
-- Nothing is granted to supabase_auth_admin. The Before User Created auth hook
-- does not exist yet, so the role that would eventually call
-- guard.is_disposable_domain() has no reason to reach the schema today.
-- Granting now would widen the blast radius for a feature that is not built.
-- The hook branch adds those grants together with the hook itself.

-- --------------------------------------------------------------------------
-- PUBLIC
-- --------------------------------------------------------------------------
-- A newly created schema does not grant USAGE to PUBLIC, so these are
-- belt-and-braces: they make the intent explicit and repair a schema that an
-- operator previously opened up by hand.
revoke all on schema guard from public;
revoke all on all tables in schema guard from public;

-- This one is NOT redundant. PostgreSQL grants EXECUTE to PUBLIC on every newly
-- created function by default, so without this revoke the lookup functions
-- would be world-executable to anyone who obtains USAGE on the schema.
--
-- Note that it only affects functions that exist RIGHT NOW. A function added by
-- a later migration is created with the built-in PUBLIC EXECUTE grant again, so
-- every future migration that creates a function must repeat this revoke. See
-- migrations/README.md; an integration test asserts the invariant holds.
revoke all privileges on all functions in schema guard from public;

-- Why there is no `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM
-- PUBLIC` here, despite it looking like the obvious fix:
--
--   * The schema-scoped form is a silent no-op. With no pre-existing entry in
--     pg_default_acl, `ALTER DEFAULT PRIVILEGES IN SCHEMA guard REVOKE ... FROM
--     PUBLIC` records nothing and changes nothing -- PostgreSQL's built-in
--     PUBLIC EXECUTE default is not represented there and cannot be revoked at
--     schema scope. Verified empirically; see the integration tests.
--   * The role-global form (the same statement without `IN SCHEMA`) does work,
--     but it is role-scoped, not schema-scoped: it would change the default
--     privileges of EVERY function that role creates in EVERY schema, including
--     `public` and the user's own application schemas. This tool must not reach
--     outside the guard schema, so that trade is refused.
--
-- The control that actually contains these functions is the schema USAGE revoke
-- above: without USAGE on `guard`, a role cannot invoke anything inside it no
-- matter what EXECUTE grants sit on the function itself.

-- --------------------------------------------------------------------------
-- Supabase client roles
-- --------------------------------------------------------------------------
-- anon and authenticated are the roles PostgREST assumes for unauthenticated
-- and signed-in API traffic. They must never read or write the policy lists:
-- read access leaks the blocklist, write access lets a client allowlist its own
-- disposable domain and walk straight through the check.
--
-- These roles do not exist on a plain PostgreSQL instance, so each revoke is
-- guarded. The EXECUTE strings are compile-time constants -- no identifier is
-- interpolated from a query result, a setting, or any other runtime value.
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    execute 'revoke all on schema guard from anon';
    execute 'revoke all on all tables in schema guard from anon';
    execute 'revoke all privileges on all functions in schema guard from anon';
    -- Unlike the PUBLIC case above, this one is meaningful: it removes a default
    -- grant an operator may have added by hand. It cannot (and does not need to)
    -- remove a built-in default, because PostgreSQL grants anon nothing by default.
    execute 'alter default privileges in schema guard revoke execute on functions from anon';
  end if;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema guard from authenticated';
    execute 'revoke all on all tables in schema guard from authenticated';
    execute 'revoke all privileges on all functions in schema guard from authenticated';
    execute 'alter default privileges in schema guard revoke execute on functions from authenticated';
  end if;
end;
$$;

comment on schema guard is
  'Anti-disposable-email policy engine. Managed by the supabase-anti-disposable-auth CLI; do not edit by hand.';
