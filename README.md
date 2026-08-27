# Supabase Anti-Disposable Auth

<<<<<<< HEAD
[![CI](https://github.com/igkougkousis01/supabase-anti-disposable-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/igkougkousis01/supabase-anti-disposable-auth/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](#requirements)
=======
A Node.js CLI that installs database-level disposable-email protection into Supabase
projects. Instead of validating throwaway addresses in your application code, the tool
will push enforcement down into PostgreSQL and Supabase Auth, so every signup path -
your app, another client, or the dashboard is covered by the same rule.
>>>>>>> origin/main

A Node.js CLI that installs **database-level disposable-email protection** into a
Supabase project. Instead of checking throwaway addresses in your application code, it
pushes enforcement down into PostgreSQL and Supabase Auth, so every signup path — your
app, another client, the dashboard — is covered by the same rule.

```bash
npx supabase-anti-disposable-auth install   # create the policy engine
npx supabase-anti-disposable-auth sync      # load ~75,000 disposable domains
npx supabase-anti-disposable-auth hook enable   # make Supabase Auth call it
```

## Why it exists

Application-level email validation is easy to write and easy to bypass. It lives in one
codebase, so a second client, an admin tool, a mobile app or a dashboard invite all
route around it. It also drifts: the list of throwaway providers changes weekly, and a
hardcoded array in a repository does not.

Moving the decision into the database fixes both problems. There is one policy engine,
one list, and one answer, and Supabase Auth consults it before a user row is ever
created. The blocklist is refreshed from a maintained upstream source by an explicit
command, with safety checks that refuse an update that looks wrong rather than trusting
whatever the network returned.

## Features

- **One policy engine in PostgreSQL.** `guard.is_disposable_domain()` is the single
  source of truth, with allowlist precedence and canonical domain normalisation.
- **Supabase Before User Created hook.** A `SECURITY INVOKER` function that Auth calls
  inside the signup transaction, and that **fails closed**.
- **Hosted activation.** `hook enable` configures Auth through the Supabase Management
  API, refuses to overwrite somebody else's hook, and proves every write by reading it
  back.
- **Safe blocklist sync.** HTTPS-only fetch with a timeout, a streamed byte ceiling and
  a content-type check; suspicious-update thresholds; atomic differential replacement.
  A failed sync never destroys the installed list.
- **Optional strict trigger mode.** An advanced, off-by-default backstop on
  `auth.users` that also covers email _changes_.
- **Reversible.** `repair` restores only what it can prove it owns; `uninstall` verifies
  ownership of every object before removing it, in an order that never leaves Auth
  calling a deleted function.
- **Least privilege by construction.** Nothing for `PUBLIC`, `anon` or `authenticated`.
  `supabase_auth_admin` gets exactly the read-only call chain the hook needs.
- **Dry runs everywhere.** `sync`, `hook`, `strict`, `repair` and `uninstall` all preview
  without changing anything.

## How it works

```text
Disposable-domain provider
          ↓
       CLI sync                       HTTPS fetch, validation, safety checks
          ↓
guard.blocked_domains / guard.allowed_domains
          ↓
guard.is_disposable_domain()          the one policy engine
          ↓
guard.before_user_created()           the hook function
          ↓
Supabase Auth                         allow {} / reject {"error": {...}}

Optional, opt-in:
auth.users strict trigger
          ↓
guard.is_disposable_domain()          the same policy engine
```

Activation is configuration, not execution:

```text
CLI  →  Supabase Management API  →  Auth Hook configuration
```

The Management API **configures** Auth. It does **not** execute the policy. Once the
hook is enabled, every signup decision is made by `guard.is_disposable_domain()` inside
your database, with no network call and no dependency on this CLI ever running again.

Everything the tool creates lives in one schema:

| Object                            | Purpose                                                       |
| --------------------------------- | ------------------------------------------------------------- |
| `guard.blocked_domains`           | Disposable domains, keyed by normalised domain.               |
| `guard.allowed_domains`           | Overrides for false positives. **Always wins.**               |
| `guard.sync_metadata`             | Per-source sync state, written by `sync`.                     |
| `guard.schema_migrations`         | Applied migrations and their checksums.                       |
| `guard.normalize_domain()`        | Domain extraction and canonicalisation.                       |
| `guard.is_disposable_domain()`    | The policy answer, with allowlist precedence.                 |
| `guard.before_user_created()`     | The Supabase auth hook. Delegates to the above.               |
| `guard.enforce_auth_user_email()` | Strict-mode trigger function. Inert unless strict mode is on. |

`public` is never used for application objects, and **nothing is ever created inside
`auth`** — with one opt-in exception: `strict enable` creates a single trigger on
`auth.users`, which `strict disable` removes.

Domains are stored in one canonical form, so case and address variants can never become
separate rows:

```text
'MAILINATOR.COM'      -> 'mailinator.com'
' mailinator.com '    -> 'mailinator.com'
'@mailinator.com'     -> 'mailinator.com'
'user@mailinator.com' -> 'mailinator.com'
```

Full design and threat model: [docs/architecture.md](docs/architecture.md).

## Requirements

- **Node.js 22 or newer**
- A Supabase project and its PostgreSQL connection string
- For hosted hook activation: a Supabase project ref and a Management API access token

## Quick start

```bash
npm install -g supabase-anti-disposable-auth

export SUPABASE_DB_URL='postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres?sslmode=require'

supabase-anti-disposable-auth doctor
supabase-anti-disposable-auth install
supabase-anti-disposable-auth sync
```

That creates the policy engine and loads the blocklist. **Signups are not filtered
yet** — Supabase Auth still has to be told to call the hook:

```bash
export SUPABASE_PROJECT_REF='your20characterrefxx'
export SUPABASE_ACCESS_TOKEN='...'          # prefer .env or a secret manager

supabase-anti-disposable-auth hook enable --dry-run
supabase-anti-disposable-auth hook enable
supabase-anti-disposable-auth status
```

`status` is the check that matters. It reports the guard layer and remote activation as
separate lines and never infers one from the other:

```text
Before User Created Hook
✓ Function installed: guard.before_user_created(jsonb)
✓ Grants: supabase_auth_admin can execute the hook
✓ Activated in Supabase Auth
✓ Auth hook URI: pg-functions://postgres/guard/before_user_created
```

> **Never paste `SUPABASE_ACCESS_TOKEN` into a shell command.** It lands in your shell
> history and in the process list. Put it in `.env` (gitignored) or export it from a
> secret manager. See [.env.example](.env.example).

## Install

Globally, for repeated use:

```bash
npm install -g supabase-anti-disposable-auth
supabase-anti-disposable-auth --help
```

Or without installing anything permanently:

```bash
npx supabase-anti-disposable-auth --help
```

Both work identically; the package ships its SQL migrations, so `install` needs nothing
else on disk. To run from a clone instead, see [docs/development.md](docs/development.md).

## Commands

| Command          | Purpose                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `doctor`         | Validate the local environment and database connectivity.          |
| `install`        | Create the guard schema, policy engine and hook function.          |
| `status`         | Report the guard layer, and remote activation when credentialled.  |
| `sync`           | Refresh the disposable-domain blocklist. Manual only.              |
| `hook status`    | Report what Supabase Auth is actually configured to call.          |
| `hook enable`    | Point Supabase Auth at the guard hook and switch it on.            |
| `hook disable`   | Switch the guard hook off, leaving its URI in place.               |
| `strict status`  | Report the optional trigger backstop on `auth.users`.              |
| `strict enable`  | **Advanced, opt-in.** Create the strict trigger on `auth.users`.   |
| `strict disable` | Remove the strict trigger. Leaves the function in place.           |
| `repair`         | Restore only known-safe drift; refuse data loss and conflicts.     |
| `uninstall`      | Disable integrations and remove only verified guard-owned objects. |

Global flags:

```bash
supabase-anti-disposable-auth --version
supabase-anti-disposable-auth --help
supabase-anti-disposable-auth --debug <command>   # diagnostics on failure, still redacted
```

Full reference with sample output for each command:
[docs/commands.md](docs/commands.md).

## Sync

```bash
supabase-anti-disposable-auth sync --dry-run   # download, validate, report, write nothing
supabase-anti-disposable-auth sync
```

`sync` downloads the [disposable-email-domains](https://github.com/disposable/disposable-email-domains)
list over HTTPS, normalises and validates every entry, checks the candidate against
safety thresholds, and replaces the installed set **differentially inside one
transaction**. Your allowlist is never touched.

If anything fails — the upstream is down, the payload is truncated, the candidate shrank
implausibly — the installed blocklist is left exactly as it was. Stale-but-known-good
beats fresh-but-wrong.

**Sync is manual.** There is no scheduler in 1.0; see [Limitations](#limitations).

## Enable the Auth Hook

`install` creates the hook function. It does **not** tell Supabase Auth to call it —
that lives in the Auth service's configuration, not in PostgreSQL:

```text
function installed   ≠   Auth Hook enabled
  (install)                (hook enable, or the dashboard, or config.toml)
```

On a **hosted project**:

```bash
supabase-anti-disposable-auth hook enable
```

Before it sends anything, `hook enable` proves the guard layer works — the hook fails
closed, so activating a broken one would reject every signup on the project. It refuses
to replace a Before User Created hook it did not install, and it verifies the change
with a fresh read afterwards rather than trusting HTTP 200.

**Locally**, with the Supabase CLI, add to `supabase/config.toml` and restart the stack:

```toml
[auth.hook.before_user_created]
enabled = true
uri = "pg-functions://postgres/guard/before_user_created"
```

This tool does not edit your `config.toml`, and `hook enable` targets hosted projects
only. Full detail — the hook contract, privileges, conflicts, verification,
troubleshooting and removal: [docs/auth-hook.md](docs/auth-hook.md).

## Strict mode

> **⚠️ Advanced, opt-in, off by default.** Most projects should run the hook alone.

Strict mode attaches one trigger to the Supabase-managed `auth.users` table, so the same
policy engine also covers email _changes_, which the Before User Created hook
structurally cannot see. It **fails closed**: if the guard layer becomes unavailable,
writes to `auth.users` are rejected until it is repaired or strict mode is switched off.

```bash
supabase-anti-disposable-auth strict status
supabase-anti-disposable-auth strict enable --dry-run
supabase-anti-disposable-auth strict enable
supabase-anti-disposable-auth strict disable
```

Read [docs/strict-mode.md](docs/strict-mode.md) in full before enabling it.

## Status

```bash
supabase-anti-disposable-auth status
```

Read-only, and deliberately conservative: anything not observed is reported as **not
checked**, never as a tick. Without Management API credentials it reports the database
layer only and says so. Exit code `0` means healthy, `5` means the guard layer is absent
or damaged. See [docs/commands.md](docs/commands.md#status).

## Repair

```bash
supabase-anti-disposable-auth repair --dry-run
supabase-anti-disposable-auth repair
```

`repair` restores **only** drift it can prove is safe to restore: missing leaf functions
and the fixed `supabase_auth_admin` grant set. It never replays a migration, never
rewrites migration history, never recreates a table that could have held your data, and
never turns enforcement on. Ambiguous ownership is a conflict (exit `11`), not a repair.

## Uninstall

```bash
supabase-anti-disposable-auth uninstall --dry-run
supabase-anti-disposable-auth uninstall --yes
```

The order is not optional: strict trigger, then hosted hook disabled **and verified
off**, then database cleanup. Dropping `guard` while Auth still points at it would break
every signup on the project.

Every destructive target is verified as guard-owned first — migration checksums, catalog
identity, owner, dependencies. There is no `CASCADE` and no force flag. `--yes` is
confirmation, not an override: it is evaluated after every safety check, and cannot
bypass a conflict. Without it, the command prints the full plan and exits `13`.

`--database-only` skips the hosted step for local or deliberately separated teardown. It
is dangerous by design and says so.

## Security model

This is a security tool, so it holds itself to the standard it enforces:

- **Credentials never leak.** Connection strings are never logged; databases are named
  as `host:port/database`. The Management API token leaves the process only as an
  `Authorization: Bearer` header to a compiled-in HTTPS origin — never in a URL, a log,
  an error, a file, or a process argument — and is redacted out of server messages and
  diagnostic causes, so even `--debug` cannot print it. Sentinel-token tests assert this
  across every path.
- **No injectable surface.** Values sent to PostgreSQL are bound as query parameters.
  Every identifier in DDL is compiled in. Migrations are static SQL shipped with the
  package. The blocklist body is data: never executed, evaluated, written to disk or
  passed to a shell.
- **Least privilege.** No privileges for `PUBLIC`, `anon` or `authenticated`. No
  `SECURITY DEFINER` anywhere. Every function pins `search_path`. `supabase_auth_admin`
  receives only the read-only call chain the hook needs — no write privilege on any
  policy table.
- **Fails closed.** If the policy engine cannot answer, the signup is rejected rather
  than approved, and the client is told nothing about why.
- **Nothing foreign is overwritten.** A Before User Created hook this tool did not
  install is a conflict, not a target. A trigger sharing the strict-mode name is a
  conflict. A `guard` object whose ownership cannot be proven is a conflict. There is no
  `DROP TRIGGER IF EXISTS` in the codebase and no `--force` anywhere.
- **Writes are verified, not assumed.** Every remote change is proven by a fresh read;
  a mismatch is a non-zero exit, never a success message.
- **Two fields, and only two.** Writes carry
  `hook_before_user_created_enabled` and `hook_before_user_created_uri` only — never a
  round-tripped copy of your Auth configuration. Your SMTP settings, OAuth secrets,
  CAPTCHA keys and other hooks are outside this tool's remit, are never modified, and
  are never printed.
- **History is evidence.** Applied migrations are checksum-verified, so an altered
  historical migration is detected rather than silently re-applied.

Per-concern threat models are in [docs/architecture.md](docs/architecture.md).
Vulnerability reports: [SECURITY.md](SECURITY.md).

### Residual risks, accepted deliberately

- **The two systems cannot share a transaction.** Supabase's Management API and
  PostgreSQL cannot be made atomic with each other. `uninstall` mitigates this with a
  verified, documented, resumable ordering rather than pretending otherwise.
- **`--skip-db-check` and `--database-only` exist.** Both are explicit, warned, opt-in
  escapes for operators who know their situation better than this tool does.
- **A rejection reveals one bit.** A blocked signup tells the submitter that their
  address was refused. That is unavoidable for any enforcement that rejects at all.
- **Upstream data quality is upstream's.** A domain wrongly on or off the provider's
  list is a data issue; the allowlist is the local override.

## Exit codes

| Code | Meaning                                                                     |
| ---- | --------------------------------------------------------------------------- |
| `0`  | Success                                                                     |
| `1`  | Unexpected error (a bug)                                                    |
| `2`  | Configuration error                                                         |
| `3`  | Database connection or query error                                          |
| `4`  | Reserved. Never emitted                                                     |
| `5`  | Guard layer is absent or damaged (`status`, or a failed preflight)          |
| `6`  | Blocklist sync failed (provider, payload or safety)                         |
| `7`  | Supabase Management API failure (auth, permission, ref, rate limit, outage) |
| `8`  | Before User Created is configured to a different hook                       |
| `9`  | A remote change was accepted but did not take effect                        |
| `10` | The strict trigger name on `auth.users` is taken by a different trigger     |
| `11` | Repair conflict: ownership or an owned-name definition is ambiguous         |
| `12` | Uninstall conflict: a destructive target or dependency is not verified      |
| `13` | Destructive uninstall confirmation is required (`--yes`)                    |

The distinctions are for automation, not decoration. `3` says "I could not reach the
database"; `5` says "I reached it and the guard layer is broken". `7` says the API
refused and **nothing changed**; `9` says a write was accepted and the state read back is
wrong, so **something may have changed** and rerunning blindly is the wrong instinct. `8`,
`10`, `11` and `12` all mean the command deliberately refused to overwrite something it
does not own — a CI job should route those to a person, not to a retry. Strict mode being
switched off is never an error; that is the default state and exits `0`.

`4` was used by unimplemented command stubs before 1.0. Every registered command is
implemented, so it is retired rather than reused.

`EXIT_CODES` in [src/lib/errors.ts](src/lib/errors.ts) is authoritative; a unit test
asserts this table matches it.

## Environment variables

**Runtime:**

| Variable                | Required by                                                                   | Description                                            |
| ----------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| `SUPABASE_DB_URL`       | `doctor`, `install`, `repair`, `status`, `sync`, `strict *`, full `uninstall` | PostgreSQL connection string for your Supabase project |
| `SUPABASE_PROJECT_REF`  | `hook *`, full `uninstall`; optional for `status` and `repair`                | The 20-character project ref from your dashboard URL   |
| `SUPABASE_ACCESS_TOKEN` | `hook *`, full `uninstall`; optional for `status` and `repair`                | Management API access token. **Highest-value secret.** |

**Test-only** — never read by the CLI, and deliberately named differently so a test run
can never reach for a real project's credentials:

| Variable                           | Used by                    | Effect                                                  |
| ---------------------------------- | -------------------------- | ------------------------------------------------------- |
| `SADA_TEST_DB_URL`                 | `npm run test:integration` | **Destructive within `guard`.** Point at a scratch DB.  |
| `SADA_TEST_SUPABASE_PROJECT_REF`   | live Management API tests  | Read-only. Both must be set or the suite skips.         |
| `SADA_TEST_SUPABASE_ACCESS_TOKEN`  | live Management API tests  | Read-only. Both must be set or the suite skips.         |
| `SADA_ALLOW_REMOTE_MUTATION_TESTS` | reserved gate              | No hosted mutation test ships. Never grants permission. |

Configuration is validated in one place and required **per command**: a missing
Management API credential never breaks a database-only command, and a missing
`SUPABASE_DB_URL` never breaks `hook disable` or `hook status`.

Copy [.env.example](.env.example) to `.env` and fill it in, or export the variables in
your shell. A `.env` in the working directory is loaded automatically; real environment
variables win. Keep `sslmode=require` in the connection string — the tool never weakens
TLS on your behalf.

## Limitations

Worth knowing before you deploy this:

- **Blocklist refresh is manual in 1.0.** No `pg_cron`, no scheduler, no background job.
  The list changes when you run `sync`. See [the roadmap](docs/roadmap.md#why-there-is-no-scheduler-in-10).
- **Installing is not enabling.** The hook function does nothing until Supabase Auth is
  configured to call it. `status` will keep telling you so.
- **Hosted activation needs Management API credentials**, which are account-wide and are
  the most sensitive value this tool handles.
- **Strict mode is advanced and optional**, touches the Supabase-managed `auth.users`
  table, and fails closed. It is off by default for good reason.
- **Signups without an email are never blocked.** Phone-only, anonymous and
  SSO-without-email flows are deliberately unaffected — this enforces disposable-_email_
  policy only where an email exists.
- **The local PostgreSQL test fixtures are not Supabase.** They validate real PostgreSQL
  semantics, not GoTrue's write paths against a managed `auth` schema.
- **Upstream availability affects refresh, not enforcement.** If the provider is
  unreachable, `sync` fails and the last known-good list keeps working.
- **Uninstall spans two systems that cannot share a transaction.** The ordering is
  verified and resumable; it is not atomic.

## Development

```bash
npm ci
npm run dev -- doctor      # run the CLI from source
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

Integration tests need a scratch PostgreSQL database and never use `SUPABASE_DB_URL`:

```bash
createdb supabase_anti_disposable_auth_test
SADA_TEST_DB_URL="postgresql://localhost:5432/supabase_anti_disposable_auth_test" \
  npm run test:integration
```

Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Full setup, testing and migration
rules: [docs/development.md](docs/development.md).

## Roadmap

1.0 is the first stable release. What shipped, what was deliberately left out and what
may come next: [docs/roadmap.md](docs/roadmap.md).

## Documentation

- [docs/commands.md](docs/commands.md) — full command reference
- [docs/auth-hook.md](docs/auth-hook.md) — the Before User Created hook and activation
- [docs/strict-mode.md](docs/strict-mode.md) — optional strict trigger enforcement
- [docs/architecture.md](docs/architecture.md) — architecture and threat models
- [docs/development.md](docs/development.md) — local setup and workflows
- [docs/releasing.md](docs/releasing.md) — maintainer release checklist
- [docs/roadmap.md](docs/roadmap.md) — what shipped and what is deferred
- [migrations/README.md](migrations/README.md) — migration rules
- [CHANGELOG.md](CHANGELOG.md) — release history

## License

[MIT](LICENSE)
