# Supabase Anti-Disposable Auth

A Node.js CLI that installs database-level disposable-email protection into Supabase
projects. Instead of validating throwaway addresses in your application code, the tool
will push enforcement down into PostgreSQL and Supabase Auth, so every signup path —
your app, another client, or the dashboard — is covered by the same rule.

## Project status: early development

The **database policy engine works**, and `sync` keeps its blocklist current from an
upstream source. The `guard` schema, its blocklist, allowlist and lookup functions are
installed by `install`, refreshed by `sync`, and can be verified with `status`.

> **⚠️ Signups are not filtered yet.** The Supabase **Before User Created** auth hook is
> not implemented, so nothing calls the lookup function during authentication.
> Installing this tool today creates a correct, populated policy engine that no signup
> path consults. Do not rely on it for protection yet.
>
> **⚠️ Sync is manual.** `pg_cron` scheduling is not implemented. The blocklist refreshes
> when you run `sync`, and never otherwise.

```text
Remote provider                       CLI
      ↓                                │
Fetch (HTTPS, timeout, size cap)       │
      ↓                                ▼
Validate / normalise             PostgreSQL
      ↓                                │
Safety checks                          ▼
      ↓                          guard schema
Atomic DB replacement  ────────►  ├── blocked_domains
                                  ├── allowed_domains
                                  ├── sync_metadata
                                  └── is_disposable_domain()
```

Planned — how it gets wired into signups in a later branch:

```text
Supabase Auth
      ↓
Before User Created Hook        <- planned, not implemented
      ↓
guard.is_disposable_domain()    <- exists today
```

## Intended capabilities

Planned, not yet built (see [docs/roadmap.md](docs/roadmap.md)):

- Supabase **Before User Created** auth hook backed by a database function
- Optional strict PostgreSQL trigger enforcement
- **Scheduled** blocklist refresh with `pg_cron` (manual refresh works today)
- Safe uninstall flow with dry-run support

## Requirements

- Node.js **20.12 or newer**
- A Supabase project and its PostgreSQL connection string

## Install

Not published to npm yet. Once released:

```bash
npx supabase-anti-disposable-auth --help
```

To run it from a clone, see [docs/development.md](docs/development.md).

## Commands

| Command     | Status              | Purpose                                                      |
| ----------- | ------------------- | ------------------------------------------------------------ |
| `doctor`    | **Available**       | Validate the local environment and database connectivity.    |
| `install`   | **Available**       | Create the guard schema and policy engine. No auth hook yet. |
| `status`    | **Available**       | Report the state of the guard schema in the target database. |
| `sync`      | **Available**       | Refresh the disposable-domain blocklist. Manual only.        |
| `uninstall` | Not implemented yet | Remove everything the CLI installed.                         |

Global flags:

```bash
supabase-anti-disposable-auth --version
supabase-anti-disposable-auth --help
supabase-anti-disposable-auth --debug <command>   # include diagnostics on failure
```

### `doctor`

`doctor` only inspects your local environment. It never reads or writes application
data and never touches `auth.users`.

It checks that:

1. the running Node.js version is supported,
2. the environment variables parse and validate,
3. a PostgreSQL connection can be established (when `SUPABASE_DB_URL` is set),
4. the server version can be queried,
5. the connection is closed afterwards.

```text
$ supabase-anti-disposable-auth doctor

Supabase Anti-Disposable Auth

✓ Node.js v22.11.0 supported (requires >= 20.12.0)
✓ Configuration loaded
✓ PostgreSQL connection successful (db.abcdefgh.supabase.co:5432/postgres)
✓ PostgreSQL 17.4 detected

Environment looks healthy.
```

When configuration is missing it stops at the first failing check:

```text
$ supabase-anti-disposable-auth doctor

Supabase Anti-Disposable Auth

✓ Node.js v22.11.0 supported (requires >= 20.12.0)
✗ SUPABASE_DB_URL is missing

Set SUPABASE_DB_URL (see .env.example) and run `supabase-anti-disposable-auth doctor` again.
```

Normal configuration mistakes produce a message and a hint, never a stack trace. Add
`--debug` if you need the underlying diagnostics.

### `install`

Creates the database guard layer: the `guard` schema, its tables, the lookup functions
and their privileges. It is **idempotent** — run it again to apply new migrations.

In this version `install` does **not** configure Supabase Auth, register an auth hook,
modify `auth.users`, enable `pg_cron`, or download anything.

```text
$ supabase-anti-disposable-auth install

Supabase Anti-Disposable Auth

✓ Connected to PostgreSQL (db.abcdefgh.supabase.co:5432/postgres)
✓ Migration 001_create_domain_functions applied
✓ Migration 002_create_domain_tables applied
✓ Migration 003_create_metadata_tables applied
✓ Migration 004_create_lookup_functions applied
✓ Migration 005_permissions applied

Database guard layer installed.
```

When everything is already applied:

```text
✓ Database guard layer already up to date.
```

### `sync`

Downloads the upstream disposable-domain list and replaces `guard.blocked_domains` with
it, atomically. Safe to re-run: an unchanged upstream writes no rows, and **any failure
leaves the previously installed blocklist exactly as it was**.

```text
$ supabase-anti-disposable-auth sync

Supabase Anti-Disposable Auth

✓ Connected to PostgreSQL (db.abcdefgh.supabase.co:5432/postgres)
✓ Provider: disposable-email-domains
✓ Downloaded blocklist (1.1 MB, HTTP 200, 503 ms)
✓ Parsed 74,825 lines
✓ Accepted 74,825 domains
✓ Candidate passed safety checks
✓ Blocklist updated atomically (+143 / -60)
✓ Checksum: 1955f407ea92

Sync complete.
```

When upstream has not changed, nothing is rewritten:

```text
✓ Blocklist already up to date
✓ 74,825 domains

Checksum: 1955f407ea92
```

> **Sync is manual.** It runs when you run it. `pg_cron` scheduling is **not
> implemented**, and the Supabase auth hook is **not implemented** — so a fully
> synchronised blocklist still filters no signups yet.

#### Provider

One provider, the maintained open-source
[`disposable/disposable-email-domains`](https://github.com/disposable/disposable-email-domains)
dataset, read from its plain-text raw endpoint:

```text
https://raw.githubusercontent.com/disposable/disposable-email-domains/master/domains.txt
```

No GitHub token is required and no HTML is ever parsed. There is deliberately **no way
to point `sync` at an arbitrary URL** — that would turn this CLI into an SSRF primitive
running with your database credentials in its environment.

#### What it does to your data

- Replaces **`guard.blocked_domains`** in full, inside one transaction.
- **Never touches `guard.allowed_domains`.** A domain on both lists stays on both; the
  allowlist still wins at lookup time.
- Never drops or recreates a table, so grants, constraints and object identity survive.
- Manual blocklist rows that upstream does not carry **are removed**. Use the allowlist
  for durable operator policy.

#### Safety checks

A remote list is not trusted blindly. A candidate is refused unless it has:

| Check                | Threshold                 |
| -------------------- | ------------------------- |
| Minimum domain count | 1,000                     |
| Minimum valid lines  | 80% of non-blank lines    |
| Maximum shrink       | 30% of the installed list |

```text
✗ Suspicious blocklist update rejected: the candidate contains 40 domains, below the
  minimum of 1,000; the candidate would remove 99.6% of the installed list (10,000 to
  40 domains), more than the 30.0% limit
Current domains: 10,000. Candidate domains: 40. The installed blocklist was left
unchanged. Inspect the upstream source before syncing again.
```

There is **no override flag**, by design.

On a **first sync** there is no installed list to compare against, so the shrink check
is skipped and only the absolute minimum and the validity ratio apply. The CLI says so:

```text
✓ Candidate passed safety checks (first sync: no list to compare against)
```

#### Dry run

```bash
supabase-anti-disposable-auth sync --dry-run
```

```text
Supabase Anti-Disposable Auth

Dry run

✓ Connected to PostgreSQL (db.abcdefgh.supabase.co:5432/postgres)
✓ Provider: disposable-email-domains
✓ Downloaded blocklist (1.1 MB, HTTP 200, 421 ms)
✓ Parsed 74,825 lines
✓ Accepted 74,825 domains
✓ Candidate passed safety checks

Current domains:   74,682
Candidate domains: 74,825
Added:             143
Removed:           0

✓ Candidate passes safety checks
Checksum: 1955f407ea92
No database changes made.
```

A dry run writes **nothing** — not a blocklist row, not a metadata row, not a temporary
table — and takes no advisory lock, so it cannot block a real sync.

#### Sync metadata

`guard.sync_metadata` holds one row per source:

| Outcome | `status`  | `last_attempt_at` | `last_success_at` | `domain_count` / `checksum` |
| ------- | --------- | ----------------- | ----------------- | --------------------------- |
| Success | `success` | now               | now               | candidate values            |
| No-op   | `success` | now               | now               | unchanged                   |
| Failure | `failed`  | now               | **unchanged**     | **unchanged**               |
| Dry run | —         | —                 | —                 | —                           |

A failure records what went wrong without disturbing the values that describe the data
actually installed, so the gap between `last_attempt_at` and `last_success_at` is a
direct measure of how long sync has been broken.

A no-op advances `last_success_at` deliberately: it answers "when did we last confirm we
match upstream?", which is what staleness monitoring asks. Whether the data changed is
what `checksum` is for.

#### Concurrency

A PostgreSQL session advisory lock serialises syncs. A second `sync` against the same
database fails immediately rather than waiting:

```text
✗ Another blocklist sync is already in progress
Wait for it to finish, then run sync again.
```

The key is distinct from the migration runner's, so `install` and `sync` never block
each other.

### `status`

Read-only. Reports the database layer, and reports everything that is not built as not
configured rather than hiding it.

```text
$ supabase-anti-disposable-auth status

Supabase Anti-Disposable Auth

Database
✓ Connected (db.abcdefgh.supabase.co:5432/postgres)

Guard schema
✓ Installed
✓ Schema version: 005
✓ Blocked domains: 0
✓ Allowed domains: 0
✓ Lookup function: guard.is_disposable_domain(text)

Auth Hook
○ Not configured (not implemented yet)

Automatic sync
○ Not configured (not implemented yet)

Database guard layer is up to date.
```

`status` probes every expected table and function individually rather than trusting the
migration history, because the two can disagree — an object dropped by hand leaves its
migration row behind. A partial or damaged install is never reported as healthy:

```text
Guard schema
✗ Incomplete installation — guard layer requires repair
  Schema version: 005
✓ Blocked domains: 0
✗ Allowed domains: table missing
✓ Lookup function: guard.is_disposable_domain(text)
✗ Missing objects: guard.allowed_domains
...
Guard layer requires repair. Objects recorded as applied are missing, so
`supabase-anti-disposable-auth install` will not recreate them.
Drop the guard schema and reinstall, or restore the missing objects by hand.
```

It handles a `guard` schema that exists but is empty, a complete migration history with
a missing function, and a partly applied migration set — without crashing in any of
them.

#### `status` as a health check

`status` exits non-zero when the guard layer is not healthy, so it can be used directly
in CI or a deployment gate:

| Situation                            | Exit code                      |
| ------------------------------------ | ------------------------------ |
| Complete installation                | `0`                            |
| Not installed                        | `5` (guard health)             |
| Incomplete or damaged installation   | `5` (guard health)             |
| `SUPABASE_DB_URL` missing or invalid | `2` (configuration, unchanged) |
| Database unreachable or query failed | `3` (database, unchanged)      |

```bash
supabase-anti-disposable-auth status || echo "guard layer needs attention"
```

The human-readable report is printed in full either way — the exit code is additional
signal, not a replacement for it.

## The `guard` schema

Everything this tool creates lives in one schema. `public` is never used for
application objects, the `auth` schema is never modified, and `auth.users` is never
touched.

| Object                         | Purpose                                         |
| ------------------------------ | ----------------------------------------------- |
| `guard.blocked_domains`        | Disposable domains, keyed by normalised domain. |
| `guard.allowed_domains`        | Overrides for false positives.                  |
| `guard.sync_metadata`          | Per-source sync state, written by `sync`.       |
| `guard.schema_migrations`      | Applied migrations and their checksums.         |
| `guard.normalize_domain()`     | Domain extraction and canonicalisation.         |
| `guard.is_disposable_domain()` | The policy answer, with allowlist precedence.   |

### Domain normalisation

Domains are stored in one canonical, lowercase form, so case variants can never become
separate rows:

```text
'MAILINATOR.COM'      -> 'mailinator.com'
' mailinator.com '    -> 'mailinator.com'
'@mailinator.com'     -> 'mailinator.com'
'user@mailinator.com' -> 'mailinator.com'
```

Input that cannot be normalised — `NULL`, empty, whitespace, or an implausible hostname
— yields `NULL`, and the lookup treats that as "not disposable". This is enforced by a
`CHECK` constraint on both tables, not just by application code.

### Allowlist precedence

**The allowlist always wins.** A domain in both tables is allowed:

```sql
insert into guard.blocked_domains (domain) values ('mailinator.com');
select guard.is_disposable_domain('mailinator.com');       -- true
select guard.is_disposable_domain('user@MAILINATOR.com');  -- true
select guard.is_disposable_domain('gmail.com');            -- false

insert into guard.allowed_domains (domain) values ('mailinator.com');
select guard.is_disposable_domain('mailinator.com');       -- false
```

The function never raises for malformed input — it returns `false`. An address that
cannot be parsed must not be rejected by a rule that never matched.

### Migrations

Schema changes are versioned `.sql` files in `migrations/`, applied in order, each in
its own transaction alongside the row that records it. Every file is checksummed: if an
already-applied migration is edited, the next run **fails loudly** instead of
re-applying it or ignoring the change. See
[migrations/README.md](migrations/README.md).

`guard` and `guard.schema_migrations` are bootstrap infrastructure: the runner creates
them before any numbered migration executes, because a migration is only recorded once
its row lands in `guard.schema_migrations`. They are intentionally not represented by a
`001_...` file — such a migration could not record its own application — so the numbered
set starts at `001_create_domain_functions.sql`.

### Privileges

`PUBLIC`, `anon` and `authenticated` get no access to the schema, the tables or the
functions — verified with PostgreSQL's `has_schema_privilege()`,
`has_table_privilege()` and `has_function_privilege()`, which resolve inherited
privileges that reading ACL strings would miss. Nothing is granted to
`supabase_auth_admin` yet — that arrives with the auth hook that needs it. No function
is `SECURITY DEFINER`, and every function pins `search_path`.

The control that contains the functions is the schema `USAGE` revoke: calling a function
requires `USAGE` on its schema, so without it nothing in `guard` is reachable. The tool
does **not** use `ALTER DEFAULT PRIVILEGES` — the schema-scoped form is a silent no-op
in PostgreSQL, and the role-global form would change privileges outside `guard`. See
[docs/architecture.md](docs/architecture.md) for the detail and
[migrations/README.md](migrations/README.md) for the rule this places on future
migrations.

### Exit codes

| Code | Meaning                                                  |
| ---- | -------------------------------------------------------- |
| `0`  | Success                                                  |
| `1`  | Unexpected error (a bug)                                 |
| `2`  | Configuration error                                      |
| `3`  | Database connection or query error                       |
| `4`  | Command is not implemented yet                           |
| `5`  | Guard layer is absent or damaged (`status` health check) |
| `6`  | Blocklist sync failed (provider, payload or safety)      |

Code `5` is deliberately distinct from `3`. A CI job needs to tell "I could not reach
the database" apart from "I reached it, and the guard layer is not installed" — so a
health verdict never borrows the database error code, and a database error never
reports as a health verdict.

Code `6` is distinct for the same reason. The overwhelmingly likely cause of a sync
failure is outside the database entirely — an unreachable upstream, a truncated
download, or a candidate that failed its safety checks. An operator seeing `3` should
look at their connection string; an operator seeing `6` should look at the provider.

## Environment variables

| Variable          | Required            | Description                                            |
| ----------------- | ------------------- | ------------------------------------------------------ |
| `SUPABASE_DB_URL` | For database access | PostgreSQL connection string for your Supabase project |

Copy [.env.example](.env.example) to `.env` and fill it in, or export the variable in
your shell. A `.env` file in the working directory is loaded automatically; real
environment variables take precedence.

Keep `sslmode=require` in the connection string. The tool never weakens TLS settings on
your behalf.

No Supabase Management API token is required at this stage.

## Development

```bash
npm install
npm run dev -- doctor      # run the CLI from source
npm run typecheck
npm run lint
npm test
npm run build
```

Full details in [docs/development.md](docs/development.md).

## Documentation

- [docs/architecture.md](docs/architecture.md) — planned architecture
- [docs/roadmap.md](docs/roadmap.md) — delivery order
- [docs/development.md](docs/development.md) — local setup and workflows

## Security

This is a security tool, so it holds itself to the same standard it enforces:

- **Never commit `.env` or any real credential.** `.env` is gitignored; only
  `.env.example` belongs in version control.
- Connection strings are never logged. Databases are referred to by
  `host:port/database` only.
- Values sent to PostgreSQL are bound as query parameters, never string-concatenated.
  Migration files are static SQL that ships with the package; no user input is ever
  interpolated into them.
- Secrets are never passed as command-line arguments to other processes.
- Database objects are locked down by default: no privileges for `PUBLIC`, `anon` or
  `authenticated`, no `SECURITY DEFINER`, and a pinned `search_path` on every function.
- Applied migrations are checksum-verified, so an altered historical migration is
  detected rather than silently re-applied.
- Downloaded blocklists are fetched over HTTPS only, with a timeout, a streamed byte
  ceiling and a content-type check, and are never executed, evaluated, written to disk
  or passed to a shell.
- A failed sync never destroys the last known-good blocklist. Stale-but-known-good beats
  fresh-but-wrong.

Per-concern breakdowns are in
[docs/architecture.md](docs/architecture.md#database-threat-model) and
[docs/architecture.md](docs/architecture.md#synchronisation-threat-model).

Vulnerability reports: see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
