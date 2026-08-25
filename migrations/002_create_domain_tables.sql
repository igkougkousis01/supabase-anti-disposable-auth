-- 002_create_domain_tables.sql
--
-- The two lists the policy engine consults. Both are keyed by an already
-- normalised domain, so an exact equality lookup is always correct.

-- Disposable / throwaway email domains.
--
-- There is deliberately no updated_at column: rows here are inserted and
-- deleted by list reconciliation, never edited in place, so a mutation
-- timestamp would only ever repeat created_at. Per-source sync state lives in
-- guard.sync_metadata instead.
create table if not exists guard.blocked_domains (
  domain text not null,
  -- Where the row came from, e.g. an upstream list name or 'manual'. NULL
  -- means unrecorded; no remote source exists yet.
  source text,
  created_at timestamptz not null default now(),

  constraint blocked_domains_pkey primary key (domain),

  -- Stores only canonical values, so 'Mailinator.com', 'MAILINATOR.COM' and
  -- 'mailinator.com' cannot coexist as separate rows.
  --
  -- IS NOT DISTINCT FROM rather than '=' on purpose: guard.normalize_domain()
  -- returns NULL for input it cannot normalise, and a CHECK constraint that
  -- evaluates to NULL PASSES. Plain equality would therefore admit exactly the
  -- malformed values this constraint exists to reject.
  constraint blocked_domains_domain_normalized
    check (domain is not distinct from guard.normalize_domain(domain))
);

comment on table guard.blocked_domains is
  'Disposable email domains. Keys are normalised by guard.normalize_domain().';
comment on column guard.blocked_domains.source is
  'Origin of the entry, e.g. an upstream list identifier. NULL when unrecorded.';

-- Domains that must always be accepted, whatever the blocklist says.
--
-- This table exists to correct false positives. guard.is_disposable_domain()
-- checks it FIRST: allowlist beats blocklist, unconditionally.
create table if not exists guard.allowed_domains (
  domain text not null,
  -- Why the exception was granted. Free text, for the operator's benefit.
  reason text,
  created_at timestamptz not null default now(),

  constraint allowed_domains_pkey primary key (domain),

  constraint allowed_domains_domain_normalized
    check (domain is not distinct from guard.normalize_domain(domain))
);

comment on table guard.allowed_domains is
  'Domains that override the blocklist. Allowlist takes precedence over blocklist.';
comment on column guard.allowed_domains.reason is
  'Operator note explaining why this domain is exempt.';

-- Indexing note: no secondary indexes are created here, and that is deliberate.
-- Every lookup this schema performs is an exact equality match on the
-- normalised primary key, which the implicit unique btree behind each PRIMARY
-- KEY already serves optimally. A second index on the same column would cost
-- write throughput during list reconciliation and buy nothing. Add one only
-- when a query shape appears that the primary key genuinely cannot answer.
