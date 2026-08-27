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

## v0.4 — Supabase Before User Created hook (database layer) — **Done**

- `guard.before_user_created(event jsonb) returns jsonb`, matching the current Supabase
  Auth hook contract (verified against `supabase/auth`, not against examples)
- Policy delegated entirely to `guard.is_disposable_domain()` — the hook holds no
  lookup logic of its own, asserted by a test comparing both verdicts
- Explicit missing-email behaviour: absent, `null`, `""` and whitespace emails all
  **allow**, so phone-only and anonymous signups are never collateral damage
- Explicit malformed-payload behaviour: a non-object event rejects as structural
  corruption, and a `user.email` that is present but not a JSON string rejects as a
  contract violation — both with the same generic 5xx response. A well-formed object
  that simply carries no email still allows
- **Fails closed** when the policy engine raises, with a generic client message and
  full `SQLSTATE` diagnostics kept in the PostgreSQL server log
- `SECURITY INVOKER` with a least-privilege grant set for `supabase_auth_admin` — read
  only, no writes, nothing for `PUBLIC` / `anon` / `authenticated`
- `status` reports the hook function and the grants, and reports activation as **not
  verified**; a missing function or grant is a health failure with exit code `5`
- Live-database tests covering policy, allowlist precedence, case normalisation,
  missing and malformed events, damaged-lookup fail-closed behaviour, privilege
  boundaries, side-effect freedom and execution under `SET ROLE supabase_auth_admin`

Deliberately deferred from this branch, and the reason:

- **Activation.** `install` creates the function; it does not tell Supabase Auth to
  call it. The database contract needed to be testable before the CLI is given control
  of a project's hosted Auth configuration.
- Editing a user's `supabase/config.toml` automatically — documented instead.
- `uninstall` support for the hook, beyond documenting the required removal order.
- **A privilege-repair subsystem.** `007_auth_hook_permissions.sql` grants
  conditionally on `supabase_auth_admin` existing, and applied migrations are never
  replayed, so a database that gained the role after installation keeps missing grants.
  `status` detects and names that, and the remediation is a documented idempotent
  snippet (README → _Repairing the auth hook grants_). A `repair` command is a separate
  design question — what it may change, what it must refuse to change, and how it
  proves it did no harm — and is not started in this branch.

## v0.4.1 — Hook activation — **Done**

- `supabase/management-client.ts`: a narrow, native-`fetch` Management API client with
  two operations (`getAuthConfig`, `updateAuthConfig`) against a compiled-in base URL —
  HTTPS only, request timeout, streamed byte ceiling, JSON content-type check, structured
  status handling, no redirect following, no automatic retries
- `SUPABASE_PROJECT_REF` and `SUPABASE_ACCESS_TOKEN`, validated in the existing central
  Zod config and required **per command**, so no database-only workflow breaks
- `hook enable` / `hook disable` / `hook status`, each with `--dry-run`
- A pure activation state machine covering every combination of `enabled` and `uri`,
  with **conflict** — never silent replacement — whenever the slot holds a URI that is
  not ours, enabled or not
- A **database preflight** before any remote write: guard layer complete, hook function
  installed, `supabase_auth_admin` grants held. Refused by default when
  `SUPABASE_DB_URL` is absent; `--skip-db-check` is the explicit, warned, opt-in escape
- **Minimal PATCH**: only `hook_before_user_created_enabled` and
  `hook_before_user_created_uri`, never a round-tripped copy of the GET response
- **Post-write verification**: a fresh GET after every PATCH, and a distinct exit code
  when the state read back is not the state requested
- `status` reports real remote activation when credentials are present, and
  `not checked` when they are not — never a tick either way
- Token handling: `Authorization` header only, redacted out of server messages and
  attached causes, with sentinel-based leak tests across logs, errors and `--debug`
- Exit codes `7` (remote API), `8` (hook conflict), `9` (verification failure)

Deliberately deferred from this branch, and the reason:

- **Interactive confirmation before mutating.** `hook enable` is already an explicitly
  named mutation command with a `--dry-run` preview; a prompt would buy little and would
  make the command awkward to run from CI.
- **Retries.** A GET could be retried safely and a PATCH could not, and a retry layer
  that distinguishes them is more machinery than a foreground command needs. Post-write
  verification, not a retry, is what protects against an ambiguous outcome.
- **Live mutation tests against a hosted project.** Every state transition is covered
  against a mocked API. A live read-only check exists behind
  `SADA_TEST_SUPABASE_*`; nothing in the test suite writes to a real Auth configuration.
- **Editing `supabase/config.toml`.** Still documented rather than automated: local
  activation is a user-owned file, and hosted activation is what this branch covers.
- **`uninstall`.** The correct removal order (disable remotely, then drop the database
  objects) is documented and `hook disable` now makes the first half a single command.

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
