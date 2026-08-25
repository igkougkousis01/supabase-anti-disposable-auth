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

## v0.2 — Database schema

- `guard` schema with blocklist, allowlist and metadata tables
- Versioned, idempotent SQL applied by `install`
- Dry-run flag that prints the SQL without executing it
- `status` reporting installed version and table state

## v0.3 — Blocklist synchronisation

- `sync` downloads an upstream disposable-domain list with native `fetch`
- Domain normalisation and validation before insertion
- Reconciliation (add, remove, keep) rather than truncate-and-reload
- Refresh metadata recorded in the database

## v0.4 — Disposable-domain lookup function

- SQL function that answers whether an address belongs to a disposable domain
- Allowlist checked before the blocklist
- Indexed lookups with a measured cost per signup

## v0.5 — Supabase Before User Created hook

- Hook function in the `guard` schema
- Registration and unregistration through `install` / `uninstall`
- Clear rejection message returned to the client

## v0.6 — Strict trigger mode (opt-in)

- Optional trigger-level enforcement for defence in depth
- Off by default; enabled explicitly with a flag
- Documented trade-offs and rollback path

## v0.7 — `pg_cron` synchronisation (opt-in)

- Detect whether `pg_cron` is available in the project
- Schedule blocklist refresh inside the database
- Remove the schedule cleanly on uninstall

## v0.8 — Allowlist management

- Commands to add, remove and list allowlisted domains
- Allowlist preserved across upgrades and blocklist refreshes

## v0.9 — Uninstall and rollback safety

- Complete removal of everything the tool installed
- Preview of exactly what will be dropped before it happens
- Safe behaviour on partial or interrupted installs

## v1.0 — npm release

- Published to npm and runnable via `npx`
- Documented upgrade path and versioning policy
- Integration tests against a real PostgreSQL instance in CI
