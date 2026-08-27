-- 006_create_before_user_created_hook.sql
--
-- The Supabase "Before User Created" auth hook.
--
-- Supabase Auth (GoTrue) invokes a configured Postgres hook as, literally:
--
--   set local statement_timeout to '2000';
--   select "guard"."before_user_created"($1);
--
-- inside the same transaction that would create the user. Two consequences follow
-- from that, and both are load-bearing below:
--
--   1. Anything this function raises aborts the signup transaction, so the user is
--      not created. Raising is therefore already "fail closed" -- but it hands the
--      client a raw database error, which is why the policy call is wrapped.
--   2. GoTrue's 2-second statement_timeout raises query_canceled (57014), and
--      PL/pgSQL's `when others` deliberately does NOT catch query_canceled. A hook
--      that runs long is cancelled, the transaction aborts, and the signup fails
--      closed without this function needing to implement a timeout of its own.
--
-- Contract (verified against supabase/auth internal/hooks/hookserrors/hookserrors.go
-- and internal/hooks/v0hooks/v0hooks.go, not against blog examples):
--
--   allow   -> {}
--   reject  -> {"error": {"http_code": <int>, "message": "<non-empty>"}}
--
-- `http_code` is passed through to the client verbatim; when it is absent or 0 the
-- client receives HTTP 500. `message` is returned to the signup client as-is and
-- MUST be non-empty: hookserrors.check() treats an error object with an empty
-- message as "no error" and ALLOWS the signup. Every rejection path below therefore
-- returns a compile-time string literal -- never a computed or interpolated value,
-- which also makes it impossible for this function to leak internals to a client.

-- Decides whether Supabase Auth may create the user described by `event`.
--
-- The policy answer is NOT computed here. This function extracts an email address
-- and delegates to guard.is_disposable_domain(), which owns allowlist precedence and
-- domain normalisation. There is one policy engine, and this is not it.
--
-- Behaviour, in evaluation order:
--
--   event is NULL / not a JSON object   -> reject   (structural corruption)
--   user.email absent or null           -> allow    (no email to judge)
--   user.email empty or whitespace      -> allow    (no email to judge)
--   user.email not a JSON string        -> reject   (malformed hook payload)
--   guard.is_disposable_domain() true   -> reject   (policy)
--   guard.is_disposable_domain() false  -> allow    (policy)
--   guard.is_disposable_domain() raises -> reject   (infrastructure)
--
-- Why "no email" allows
-- ---------------------
-- Supabase serialises the candidate user's email as a Go NullString, so a phone-only
-- or anonymous signup arrives as `"email": ""` rather than as an absent key. Those
-- are supported account-creation flows that this tool has no opinion about. Blocking
-- them would mean a disposable-EMAIL filter silently disabling phone and anonymous
-- auth -- a failure mode far worse than the one it protects against.
--
-- This is a deliberate fail-open for the ABSENCE OF AN EMAIL. It is not a fail-open
-- for the policy engine, which is the opposite decision, taken a few lines further
-- down. "There is nothing to check" and "the check did not work" are different
-- events and are answered differently on purpose.
--
-- Why a NON-STRING email rejects, when an absent one allows
-- --------------------------------------------------------
-- These look similar and are not the same event.
--
-- An absent, null or empty email is something Supabase legitimately sends. GoTrue
-- serialises the candidate address as a Go NullString, so a phone-only or anonymous
-- signup arrives as `"email": ""` -- a supported flow, under the contract, carrying
-- nothing to judge. Allow.
--
-- A number, boolean, array or object in that field is not something Supabase can
-- send. `user.email` is a Go string field; no GoTrue release serialises it as any
-- other JSON type. Receiving one means the payload did not come from the contract
-- this function implements -- a hook wired to the wrong extensibility point, a
-- caller that is not Supabase Auth, or a GoTrue whose payload shape has changed
-- underneath us. In every one of those cases this function cannot know what it is
-- being asked, and a hook that cannot confirm what it is being asked must not hand
-- out an approval.
--
-- The alternative -- treating it as "no email" and allowing -- is worse in exactly
-- the way that matters: `"email": 12345` would sail past a disposable-email filter
-- without the filter ever looking at an address, and nothing would say so.
--
-- The rejection reuses the generic 503 response used for structural corruption and
-- engine failure. It is a compile-time literal that names no field, no type and no
-- value, so a caller learns only that validation could not be completed. The JSON
-- type that caused it goes to the server log, where the operator can see it and the
-- client cannot.
--
-- Why a non-object event rejects
-- ------------------------------
-- GoTrue always sends a JSON object. A SQL NULL or a JSON scalar/array means this
-- function is not being called under the contract it was written for -- a hook wired
-- to the wrong extensibility point, or a caller that is not Supabase Auth. A hook
-- that cannot confirm who is asking must not hand out approvals.
--
-- The line is drawn at the OUTERMOST structure only. `{}`, `{"user": null}`,
-- `{"user": {}}` and `{"user": {"email": null}}` are all well-formed objects that
-- simply carry no email, and are allowed by the rule above rather than treated as
-- corruption. A present-but-wrongly-typed `user.email` is judged separately, by the
-- type gate described above -- absence is allowed, a violated field type is not.
--
-- Volatility: STABLE. It reads two tables and has no side effects.
--
-- NOT declared PARALLEL SAFE, unlike the lookups it calls: the nested block below
-- has an exception handler, which PL/pgSQL implements as a subtransaction, and
-- establishing a subtransaction is not permitted in a parallel worker. Marking it
-- otherwise would be a false promise. Nothing is lost -- GoTrue calls this once per
-- signup via `select f($1)`, which is never parallelised.
--
-- SECURITY INVOKER, not DEFINER. See 007_auth_hook_permissions.sql for the grants
-- that make that work and the reasoning behind refusing DEFINER.
--
-- search_path is pinned to the empty string and every guard object is fully
-- qualified. pg_catalog stays implicitly searchable, which is what resolves jsonb,
-- jsonb_typeof() and btrim() below.
create or replace function guard.before_user_created(event jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  candidate_email text;
  email_type text;
  is_disposable boolean;
begin
  -- ------------------------------------------------------------------------
  -- 1. Structural gate.
  -- ------------------------------------------------------------------------
  -- jsonb_typeof() returns NULL for a SQL NULL argument, so `is distinct from`
  -- covers both the NULL and the wrong-type case in one comparison.
  if jsonb_typeof(event) is distinct from 'object' then
    return '{"error": {"http_code": 503, "message": "Signup could not be validated. Please try again later."}}'::jsonb;
  end if;

  -- ------------------------------------------------------------------------
  -- 2. Email type gate.
  -- ------------------------------------------------------------------------
  -- `->` returns NULL rather than raising for a missing key, a JSON null, or a
  -- parent that is not an object, so no key needs to be probed first and no cast
  -- can fail. jsonb_typeof() then answers the only question that matters here:
  --
  --   NULL       key absent, or `user` carries no such member  -> nothing to judge
  --   'null'     JSON null                                     -> nothing to judge
  --   'string'   an address                                    -> policy decides
  --   otherwise  number, boolean, array, object                -> contract violated
  --
  -- The type is resolved once and reused. Calling jsonb_typeof() twice would let the
  -- gate below and the extraction beneath it disagree if either expression were ever
  -- edited without the other.
  email_type := jsonb_typeof(event -> 'user' -> 'email');

  -- A wrongly-typed email is a MALFORMED PAYLOAD, not an email-less signup, and the
  -- two are answered differently on purpose. See the header for the full reasoning;
  -- the short version is that GoTrue serialises user.email from a Go string and can
  -- never send a number, boolean, array or object there, so receiving one means this
  -- function does not know what it is being asked -- and the alternative reading
  -- ("no usable email, therefore allow") would let `"email": 12345` walk straight
  -- through a disposable-email filter that never looked at an address.
  --
  -- `not in` is written against a NULL-safe guard rather than relied upon directly:
  -- `null not in (...)` is NULL, not true, so the absent case must be excluded first.
  if email_type is not null and email_type not in ('null', 'string') then
    -- Server log only, never the client. jsonb_typeof() returns one of a fixed set
    -- of type names, so this records WHAT arrived without recording any part of the
    -- payload itself -- the operator gets a diagnosis, and no unverified user input
    -- reaches the log.
    raise log 'guard.before_user_created: malformed hook payload (user.email has JSON type %)',
      email_type;

    -- The same generic response used for structural corruption and engine failure.
    -- A caller learns that validation could not be completed and nothing else: no
    -- field name, no type, no value, no hint that the payload shape was the problem.
    return '{"error": {"http_code": 503, "message": "Signup could not be validated. Please try again later."}}'::jsonb;
  end if;

  -- Reached only for 'string', NULL and 'null'. `->>` cannot misbehave here: the one
  -- type it would silently coerce has already been rejected above.
  if email_type = 'string' then
    candidate_email := event -> 'user' ->> 'email';
  end if;

  -- Absence of an email is not a policy failure. Allow, and say so loudly in the
  -- comment above rather than leaving it to be inferred from a bare `return`.
  if candidate_email is null or btrim(candidate_email) = '' then
    return '{}'::jsonb;
  end if;

  -- ------------------------------------------------------------------------
  -- 3. Policy decision, delegated.
  -- ------------------------------------------------------------------------
  -- The exception handler is scoped to this one statement, not wrapped around the
  -- whole function body. Two reasons:
  --
  --   * Intent. This handler exists for policy-ENGINE failure -- a dropped table, a
  --     revoked privilege, a half-removed installation. It is not a catch-all for
  --     bugs in the extraction above, which would be hidden rather than fixed.
  --   * Cost. A block with an exception handler establishes a subtransaction every
  --     time it is entered. Scoping it here means phone-only and anonymous signups,
  --     which returned above, never pay for one.
  --
  -- `when others` does not catch query_canceled, so GoTrue's statement_timeout still
  -- aborts the transaction rather than being converted into a response. That is the
  -- correct outcome and is left alone.
  begin
    is_disposable := guard.is_disposable_domain(candidate_email);
  exception
    when others then
      -- Fail CLOSED. A policy engine that cannot answer has not said "allow"; it has
      -- said nothing, and this is a security control. Treating silence as approval
      -- would mean a single revoked privilege quietly disables the entire filter
      -- while every signup keeps succeeding -- exactly the failure nobody notices.
      --
      -- RAISE LOG writes to the PostgreSQL server log and is NOT sent to the client
      -- (LOG sits above the default client_min_messages), so the operator keeps full
      -- diagnostics while the signup client learns nothing. The candidate address is
      -- deliberately not logged: it is unverified user input and this is not an
      -- audit trail.
      raise log 'guard.before_user_created: policy lookup failed (SQLSTATE %): %',
        sqlstate, sqlerrm;

      return '{"error": {"http_code": 503, "message": "Signup could not be validated. Please try again later."}}'::jsonb;
  end;

  if is_disposable then
    -- 403, not 400. GoTrue already returns 400 for its own validation failures
    -- (malformed address, weak password, user already registered), so reusing it
    -- would make a policy rejection indistinguishable from a malformed request for
    -- any client trying to show a useful message. 403 says the request was
    -- understood and refused, which is exactly what happened.
    --
    -- The message names no provider, table, list or mechanism. A client must not be
    -- able to tell "this domain is on the blocklist" apart from any other reason
    -- this tool might refuse an address, or use the endpoint to enumerate the list.
    return '{"error": {"http_code": 403, "message": "Disposable email addresses are not allowed."}}'::jsonb;
  end if;

  return '{}'::jsonb;
end;
$$;

comment on function guard.before_user_created(jsonb) is
  'Supabase Before User Created auth hook. Returns {} to allow, {"error": {...}} to reject. Delegates policy to guard.is_disposable_domain(); allows when the event carries no email; rejects a non-string user.email as a malformed payload; fails closed when the policy engine raises.';

-- Required by migrations/README.md rule 8. PostgreSQL grants EXECUTE to PUBLIC on
-- every newly created function, and 005_permissions.sql could only revoke it from
-- functions that existed when it ran. Without this line the hook would be
-- world-executable, and an integration test asserting no guard function is
-- PUBLIC-executable would fail the build.
revoke all privileges on all functions in schema guard from public;
