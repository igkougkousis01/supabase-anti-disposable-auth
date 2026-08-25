-- 004_create_lookup_functions.sql
--
-- The read side of the policy engine.
--
-- These functions will eventually be called once per signup, so they are kept
-- cheap and predictable: normalise, then at most two primary-key lookups. They
-- read tables and therefore cannot be IMMUTABLE, but they are STABLE (constant
-- within a statement), PARALLEL SAFE and free of side effects.
--
-- They are SECURITY INVOKER. A caller needs USAGE on the guard schema, EXECUTE
-- on the function and SELECT on the underlying tables. That is intentional for
-- now: nothing outside the owner needs to call them in this branch, and a
-- SECURITY DEFINER wrapper would grant reach we do not yet need. See
-- 005_permissions.sql.
--
-- search_path is pinned to the empty string on every function so that no
-- session setting can redirect guard.* or the tables they read.

-- True when the domain is explicitly exempted.
create or replace function guard.is_allowed_domain(input text)
returns boolean
language sql
stable
parallel safe
security invoker
set search_path = ''
as $$
  -- guard.normalize_domain() yields NULL for unusable input; 'domain = NULL'
  -- is NULL, so EXISTS is false. No separate NULL branch is needed.
  select exists (
    select 1
    from guard.allowed_domains a
    where a.domain = guard.normalize_domain(input)
  );
$$;

comment on function guard.is_allowed_domain(text) is
  'True when the normalised domain is on the allowlist. False for unnormalisable input.';

-- True when the domain appears on the blocklist. Says nothing about the
-- allowlist -- use guard.is_disposable_domain() for the actual policy answer.
create or replace function guard.is_blocked_domain(input text)
returns boolean
language sql
stable
parallel safe
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from guard.blocked_domains b
    where b.domain = guard.normalize_domain(input)
  );
$$;

comment on function guard.is_blocked_domain(text) is
  'True when the normalised domain is on the blocklist, ignoring the allowlist.';

-- The policy decision: should this address be treated as disposable?
--
-- Accepts a bare domain or a full address, in any case, with surrounding
-- whitespace. Never raises for ordinary malformed user input -- it returns
-- false, because refusing to classify is not evidence of abuse. Failing open
-- here is the correct trade-off: a signup that cannot be parsed must not be
-- rejected by a rule that never matched.
--
--   blocked only    -> true
--   allowed only    -> false
--   both lists      -> false   (allowlist wins)
--   neither list    -> false
--   NULL / empty    -> false
--   unnormalisable  -> false
--
-- Written in PL/pgSQL rather than SQL so the input is normalised exactly once
-- and the precedence rule is a single, readable early return.
--
-- Deliberately NOT declared STRICT: a STRICT function returns NULL for NULL
-- input, and the contract above requires false.
create or replace function guard.is_disposable_domain(input text)
returns boolean
language plpgsql
stable
parallel safe
security invoker
set search_path = ''
as $$
declare
  candidate text := guard.normalize_domain(input);
begin
  if candidate is null then
    return false;
  end if;

  -- Allowlist precedence. Checked first and returns unconditionally, so a
  -- domain present in BOTH tables is allowed.
  if exists (select 1 from guard.allowed_domains a where a.domain = candidate) then
    return false;
  end if;

  return exists (select 1 from guard.blocked_domains b where b.domain = candidate);
end;
$$;

comment on function guard.is_disposable_domain(text) is
  'Policy decision for an address or domain. Allowlist takes precedence over blocklist. Returns false rather than raising for unusable input.';
