# Supabase Anti-Disposable Auth

A Node.js CLI that installs database-level disposable-email protection into Supabase
projects. Instead of validating throwaway addresses in your application code, the tool
will push enforcement down into PostgreSQL and Supabase Auth, so every signup path —
your app, another client, or the dashboard — is covered by the same rule.

## Project status: early development

The **database policy engine works**. The `guard` schema, its blocklist, allowlist and
lookup functions are installed by `install` and can be verified with `status`.

> **⚠️ Signups are not filtered yet.** The Supabase **Before User Created** auth hook is
> not implemented, so nothing calls the lookup function during authentication.
> Installing this tool today creates a correct policy engine that no signup path
> consults. Do not rely on it for protection yet.

```text
CLI
 │
 ▼
PostgreSQL
 │
 ▼
guard schema
 ├── blocked_domains
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
- Automatic blocklist refresh from an upstream list, optionally scheduled with `pg_cron`
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
| `sync`      | Not implemented yet | Refresh the disposable-domain blocklist.                     |
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
| `guard.sync_metadata`          | Per-source sync state. Empty until sync exists. |
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

Code `5` is deliberately distinct from `3`. A CI job needs to tell "I could not reach
the database" apart from "I reached it, and the guard layer is not installed" — so a
health verdict never borrows the database error code, and a database error never
reports as a health verdict.

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

A per-concern breakdown is in
[docs/architecture.md](docs/architecture.md#database-threat-model).

Vulnerability reports: see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
