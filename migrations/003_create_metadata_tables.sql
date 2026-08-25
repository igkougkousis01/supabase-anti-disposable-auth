-- 003_create_metadata_tables.sql
--
-- Synchronisation bookkeeping.
--
-- Remote blocklist synchronisation is NOT implemented yet. This table is
-- created now so that the schema does not have to change when it is, and it is
-- intentionally left EMPTY: an invented row would be a lie about state that
-- never happened. `status` reports absence of sync as absence, not as failure.
create table if not exists guard.sync_metadata (
  -- Identifier of the upstream list, one row per source.
  source text not null,
  status text not null default 'pending',
  -- Set on every attempt; last_success_at only advances when one succeeds, so
  -- a stale list is visible as a gap between the two.
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  -- Number of domains the last successful sync produced.
  domain_count integer,
  -- Fingerprint of the last successfully applied payload, so an unchanged
  -- upstream list can be recognised without reprocessing it.
  checksum text,
  -- Populated only when status = 'failed'. Must never contain a credential.
  error_message text,

  constraint sync_metadata_pkey primary key (source),

  constraint sync_metadata_status_known
    check (status in ('pending', 'success', 'failed')),

  constraint sync_metadata_domain_count_non_negative
    check (domain_count is null or domain_count >= 0)
);

comment on table guard.sync_metadata is
  'Per-source blocklist synchronisation state. Empty until sync is implemented.';
comment on column guard.sync_metadata.error_message is
  'Last failure reason. Never store connection strings or other credentials here.';
