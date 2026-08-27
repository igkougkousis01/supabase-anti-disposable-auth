-- 008_create_strict_trigger_function.sql
--
-- The trigger FUNCTION for optional strict mode. Not the trigger.
--
-- Read that line again, because it is the whole design of this file. Migration 008
-- installs a function into `guard` and creates nothing on `auth.users`. Strict mode
-- stays OFF until an operator runs `supabase-anti-disposable-auth strict enable`,
-- which is the only thing in this tool that creates a trigger.
--
-- Why the split
-- -------------
--   install          !=          enable strict mode
--
-- `install` runs migrations. If the trigger were created here, installing the tool
-- would silently attach a fail-closed enforcement point to a Supabase-managed table --
-- the exact opposite of "opt-in, reversible, advanced". Keeping the function in a
-- migration and the trigger in a command means the database can hold a fully installed,
-- fully inert strict layer, which is the default state.
--
-- What strict mode is for
-- -----------------------
-- The supported primary layer is the Supabase Before User Created hook
-- (006/007). It rejects a disposable signup cleanly, with an HTTP status and a message
-- the client can render, before anything reaches `auth.users`.
--
-- This function is the backstop for writes that never pass through that hook:
--
--   * a direct INSERT into auth.users by an operator, a migration or a seed script;
--   * an email CHANGE, which the Before User Created hook structurally cannot see --
--     it runs at creation only, while GoTrue's ConfirmEmailChange() issues an
--     UPDATE whose SET list contains `email`;
--   * any future or third-party path into the table that does not consult the hook.
--
-- It therefore prioritises integrity over friendly UX. A rejection here is a raw
-- PostgreSQL error, which Supabase Auth surfaces to a client as a generic "Database
-- error". That is acceptable precisely because it is not the normal rejection path: if
-- both layers are on, the hook answers first and the trigger is never reached.
--
-- Volatility: STABLE. It reads two tables through guard.is_disposable_domain() and has
-- no side effects. Deliberately NOT marked PARALLEL SAFE: it only ever runs from a
-- data-modifying statement, which is never parallelised, so the marking would be an
-- unverifiable promise bought for nothing.
--
-- SECURITY INVOKER, deliberately. See the block above the RAISE below.
--
-- search_path is pinned to the empty string and every guard object is fully qualified.
-- pg_catalog stays implicitly searchable, which is what resolves btrim() and text.

-- Rejects a write to auth.users whose email is on the disposable-domain policy.
--
-- Behaviour, in evaluation order:
--
--   new.email is NULL              -> allow    (nothing to judge)
--   new.email is blank/whitespace  -> allow    (nothing to judge)
--   guard.is_disposable_domain()   -> reject / allow, per the policy engine
--   the policy engine raises       -> the raise propagates, the write ABORTS
--
-- Why a missing email allows
-- --------------------------
-- auth.users.email is nullable. GoTrue's own schema declares it
-- `email varchar(255) NULL`, and its Go NullString maps an empty string to SQL NULL,
-- so phone-only, anonymous and SSO-without-email accounts are stored with a NULL
-- email. Rejecting those would mean a disposable-EMAIL filter quietly disabling phone
-- and anonymous auth -- a far worse failure than the one it protects against.
--
-- The empty-string branch is defence for a value GoTrue does not write but a hand-run
-- INSERT easily could. guard.is_disposable_domain('') already returns false, so this
-- is an early return for clarity and cost, not a behaviour change.
--
-- This is a deliberate fail-open for the ABSENCE OF AN EMAIL, and it is the same
-- distinction guard.before_user_created() draws: "there is nothing to check" and "the
-- check did not work" are different events, and the second one is answered below by
-- doing nothing at all.
--
-- Why there is no exception handler
-- ---------------------------------
-- There is deliberately no `exception when others then return new`, and no variant of
-- it. Strict mode is a database integrity control. If the policy engine cannot answer
-- -- dropped table, dropped function, revoked privilege, half-removed installation --
-- then it has not said "allow", it has said nothing, and the write must not proceed.
--
-- With no handler, any error raised inside guard.is_disposable_domain() propagates and
-- aborts the statement. That is the fail-closed behaviour, and it is achieved by
-- writing less code rather than more.
--
-- The availability trade-off is real and is documented rather than engineered away: a
-- damaged guard layer with strict mode enabled stops writes to auth.users, including
-- signups. `strict disable` removes the trigger in one statement and needs nothing
-- from the guard schema, so the rollback path stays open even then.
--
-- Why SECURITY INVOKER, not SECURITY DEFINER
-- ------------------------------------------
-- Supabase's general advice for auth.users triggers is SECURITY DEFINER, because the
-- documented problem is that supabase_auth_admin has no privileges outside `auth`.
-- That problem does not exist here: 007_auth_hook_permissions.sql already grants
-- supabase_auth_admin exactly USAGE on guard, EXECUTE on is_disposable_domain() and
-- normalize_domain(), and SELECT on the two policy tables -- the entire call chain
-- below. So DEFINER would buy nothing, and it would cost two things:
--
--   * It would run this function as the guard owner (`postgres` on Supabase) on every
--     write to auth.users. Crossing a privilege boundary on the signup hot path to
--     avoid permission work that is already done is a bad trade, and "make the
--     permissions work" is the only argument available for it.
--   * It would WEAKEN the fail-closed guarantee. Under INVOKER, a writer that cannot
--     reach the policy engine gets a permission error and its write aborts. Under
--     DEFINER, that same writer would sail through with the owner's privileges, and a
--     revoked grant would stop being visible at all.
--
-- The whole guard schema is therefore still free of SECURITY DEFINER, which an
-- integration test asserts.
--
-- No grant is issued for this function, to any role, and that is not an omission.
-- PostgreSQL checks EXECUTE on a trigger function when the TRIGGER is created, not
-- when it fires; verified empirically against PostgreSQL 14, where a role holding no
-- EXECUTE privilege on the trigger function still had it fire on its INSERT. The
-- runtime role needs only the grants 007 already gives it, and handing out an EXECUTE
-- nothing consumes would widen the surface for no reason.
create or replace function guard.enforce_auth_user_email()
returns trigger
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  -- No usable email. Not a policy decision, and not a policy failure.
  if new.email is null or btrim(new.email) = '' then
    return new;
  end if;

  -- The policy answer is NOT computed here. Normalisation, allowlist precedence and
  -- blocklist lookup all live in guard.is_disposable_domain(); there is one policy
  -- engine and this is not it.
  --
  -- The cast is explicit because auth.users.email is varchar(255) on Supabase, not
  -- text. The implicit varchar -> text coercion would resolve today; writing it down
  -- means the call cannot become ambiguous if a future overload is ever added.
  if guard.is_disposable_domain(new.email::text) then
    -- 23514 (check_violation), chosen deliberately over the default P0001 that a bare
    -- RAISE would produce. This IS an integrity-constraint violation -- class 23 --
    -- and a stable, correctly classified SQLSTATE is something an operator's tooling
    -- can match on, while P0001 means only "some PL/pgSQL raised something".
    --
    -- The message is a compile-time literal and names nothing: no domain, no address,
    -- no table, no list, no provider, no checksum. It is not the client-facing
    -- rejection -- guard.before_user_created() owns that, with a proper HTTP status --
    -- and Supabase Auth converts anything raised here into a generic database error
    -- anyway. Nothing downstream should depend on this exact wording.
    raise exception 'Email address rejected by database policy'
      using errcode = '23514';
  end if;

  -- Evaluation only. This function never writes: not to auth.users, not to the
  -- blocklist, not to the allowlist, not to sync metadata, and it makes no network
  -- call of any kind. Returning NEW unchanged is the only mutation it is permitted.
  return new;
end;
$$;

comment on function guard.enforce_auth_user_email() is
  'BEFORE INSERT OR UPDATE OF email trigger function for optional strict mode. Allows a NULL or blank email; otherwise delegates to guard.is_disposable_domain() and raises 23514 when the address is disposable. Fails closed: a policy-engine error aborts the write. Installed by migration 008; the trigger itself is created only by `strict enable`.';

-- Required by migrations/README.md rule 8. PostgreSQL grants EXECUTE to PUBLIC on
-- every newly created function, and 005_permissions.sql could only revoke it from
-- functions that existed when it ran. An integration test asserts that no function in
-- guard is PUBLIC-executable, so a migration that forgets this fails the build.
revoke all privileges on all functions in schema guard from public;
