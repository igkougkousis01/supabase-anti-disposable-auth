-- 001_create_domain_functions.sql
--
-- Domain normalisation primitive.
--
-- This must be the first migration: the domain tables created in 002 use
-- guard.normalize_domain() in a CHECK constraint, and PostgreSQL requires the
-- function to exist (and to be IMMUTABLE) at constraint-creation time.

-- Normalises an email address or bare domain to a canonical, lowercase domain.
--
--   'MAILINATOR.COM'      -> 'mailinator.com'
--   ' mailinator.com '    -> 'mailinator.com'
--   '@mailinator.com'     -> 'mailinator.com'
--   'user@mailinator.com' -> 'mailinator.com'
--
-- Returns NULL for anything it cannot confidently normalise: NULL, an empty or
-- whitespace-only string, a missing domain part, or a value that is not a
-- plausible hostname. Callers treat NULL as "unknown", never as a match.
--
-- This is deliberately NOT an RFC 5322 validator. It is a conservative
-- extraction primitive: it is allowed to reject input that some other parser
-- would accept, because the only consequence is that the address is not
-- classified as disposable.
--
-- Volatility: IMMUTABLE. Every operation used here (lower, regexp_replace,
-- rtrim, length) is itself immutable and the result depends only on the
-- argument -- no tables, no settings, no clock. IMMUTABLE is also a hard
-- requirement for the CHECK constraints in migration 002.
--
-- STRICT: NULL in, NULL out, without executing the body.
--
-- search_path is pinned to the empty string so the meaning of this function
-- cannot be changed by a caller's session settings. pg_catalog remains
-- implicitly searchable, which is what resolves the operators and built-ins
-- below; anything in guard is fully qualified.
create or replace function guard.normalize_domain(input text)
returns text
language sql
immutable
strict
parallel safe
security invoker
set search_path = ''
as $$
  with bounded as (
    -- Guard against pathological input before any regular expression runs.
    -- The longest legal email address is 254 characters; 1024 is generous.
    select case when length(input) <= 1024 then input end as value
  ),
  trimmed as (
    select lower(regexp_replace(value, '^[[:space:]]+|[[:space:]]+$', '', 'g')) as value
    from bounded
  ),
  extracted as (
    -- Greedy '^.*@' drops the local part, so 'a@b@example.com' resolves using
    -- the LAST '@' and a bare '@example.com' prefix is handled by the same rule.
    -- A single trailing dot (the DNS root label) is discarded.
    select rtrim(regexp_replace(value, '^.*@', ''), '.') as value
    from trimmed
  )
  select case
    when value is null then null
    -- 253 is the maximum length of a DNS name in presentation format.
    when length(value) > 253 then null
    -- Labels are 1-63 characters, alphanumeric with internal hyphens only, and
    -- the last label must be alphabetic -- which also rejects bare IP addresses.
    when value ~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' then value
    else null
  end
  from extracted;
$$;

comment on function guard.normalize_domain(text) is
  'Extracts and lowercases the domain from an email address or bare domain. Returns NULL when the input cannot be normalised.';
