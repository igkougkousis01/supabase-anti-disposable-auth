# Roadmap

Delivery order. Each item is one branch. Nothing below is implemented unless marked
**Done**.

## v0.1 — CLI foundation — **Done**

- TypeScript project, build, lint, format, tests, CI
- Commander CLI with `doctor`, `install`, `status`, `sync`, `uninstall` registered
- Zod-validated configuration loaded from a single place
- `pg` connection layer with an explicit lifecycle
- Error hierarchy, exit codes and a minimal logger
- `doctor`: Node.js version, configuration, connectivity and server-version checks

## v0.2 — Database guard layer — **Done**

- `guard` schema with blocklist, allowlist, metadata and migration-history tables
- Versioned SQL migrations with checksum verification, applied by `install`
- `guard.normalize_domain()` and `guard.is_disposable_domain()` with allowlist precedence
- Conservative privileges: nothing granted to `PUBLIC`, `anon` or `authenticated`
- `status` reporting schema version, row counts and what is still not configured
- Unit tests for the runner, plus live-database tests behind `SADA_TEST_DB_URL`

Deliberately deferred from this branch: a dry-run flag that prints SQL without
executing it, and `uninstall` support for the new objects.

## v0.3 — Blocklist synchronisation — **Done**

- `sync` downloads an upstream disposable-domain list with native `fetch`
- One provider: `disposable/disposable-email-domains`, via its plain-text raw endpoint
- HTTPS-only fetch with a request timeout, a streamed byte ceiling, manual redirect
  handling and a content-type allowlist
- Domain normalisation and validation before insertion, kept in lockstep with
  `guard.normalize_domain()` and asserted by an integration test
- Deterministic SHA-256 checksum over the sorted, deduplicated domain set
- Suspicious-update protection: minimum count, valid-line ratio, maximum shrink
- Differential reconciliation (add, remove, keep) inside one transaction, via a
  transaction-scoped staging table — never truncate-and-reload
- Session advisory lock so two syncs cannot replace the list concurrently
- `sync --dry-run`, which mutates nothing
- Sync metadata recorded in `guard.sync_metadata`, including failure attempts

Deliberately deferred from this branch: retries, scheduled sync, custom blocklist URLs,
a `--provider` flag (there is one provider), and `status` reporting sync freshness.

## v0.4 — Supabase Before User Created hook

**Not implemented.** Nothing calls `guard.is_disposable_domain()` during signup yet, so
a synchronised blocklist still filters nothing.

- Hook function in the `guard` schema
- Registration and unregistration through `install` / `uninstall`
- Clear rejection message returned to the client

## v0.5 — Strict trigger mode (opt-in)

- Optional trigger-level enforcement for defence in depth
- Off by default; enabled explicitly with a flag
- Documented trade-offs and rollback path

## v0.6 — `pg_cron` synchronisation (opt-in)

**Not implemented.** Synchronisation is manual only: it happens when an operator runs
`sync`, and never otherwise.

- Detect whether `pg_cron` is available in the project
- Schedule blocklist refresh inside the database
- Remove the schedule cleanly on uninstall

## v0.7 — Allowlist management

- Commands to add, remove and list allowlisted domains
- Allowlist preserved across upgrades and blocklist refreshes

## v0.8 — Uninstall and rollback safety

- Complete removal of everything the tool installed
- Preview of exactly what will be dropped before it happens
- Safe behaviour on partial or interrupted installs

## v1.0 — npm release

- Published to npm and runnable via `npx`
- Documented upgrade path and versioning policy
- Integration tests against a real PostgreSQL instance in CI
