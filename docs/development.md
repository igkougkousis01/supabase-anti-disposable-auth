# Development

## Requirements

- **Node.js 20.12 or newer** (`node --version`)
- **npm 10+**
- Optional, for integration tests: a PostgreSQL database — a Supabase project or a local
  PostgreSQL instance

## Installation

```bash
git clone https://github.com/igkougkousis01/supabase-anti-disposable-auth.git
cd supabase-anti-disposable-auth
npm install
```

## Environment setup

```bash
cp .env.example .env
```

Fill in `SUPABASE_DB_URL` with the connection string from
**Supabase Dashboard → Project Settings → Database → Connection string (URI)**:

```bash
SUPABASE_DB_URL=postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres?sslmode=require
```

Keep `sslmode=require`. Do not disable TLS to make local development easier.

`.env` is gitignored and must never be committed. The CLI loads it automatically from
the working directory using Node's built-in `.env` parser; variables already set in your
shell take precedence.

You can also skip the file entirely:

```bash
SUPABASE_DB_URL="postgresql://..." npm run dev -- doctor
```

## Local development

Run the CLI from source without building:

```bash
npm run dev -- --help
npm run dev -- doctor
```

The `--` separator passes arguments through to the CLI rather than to npm.

## Testing

```bash
npm test            # unit tests (no database required)
npm run test:watch  # unit tests in watch mode
```

Unit tests live in `tests/unit` and never touch a network or a database. The database
layer is injected as a dependency, so success and failure paths are tested with a fake
connection, and `fetch` is injected into the blocklist pipeline so **no unit test ever
makes a network request**. There are no opt-in "hit the real upstream" tests; the
providers are exercised entirely against fixtures.

Blocklist fixtures live in `tests/fixtures/blocklists/` and are deterministic local
files — see the README in that directory. Nothing in the core test suite depends on the
live upstream dataset.

### Integration tests

`tests/integration` contains tests that need a real database. They skip themselves
unless the relevant variable is set, which keeps `npm test` and CI offline by default.
CI never requires Supabase credentials.

There are four, and the distinction between the variables matters:

| Variable           | Used by                  | Effect on the database                                                            |
| ------------------ | ------------------------ | --------------------------------------------------------------------------------- |
| `SUPABASE_DB_URL`  | `database.test.ts`       | Read-only: connects and reads `server_version`.                                   |
| `SADA_TEST_DB_URL` | `guard-schema.test.ts`   | **Destructive**: drops and recreates `guard`.                                     |
| `SADA_TEST_DB_URL` | `blocklist-sync.test.ts` | **Destructive**: drops `guard`, then replaces `guard.blocked_domains` repeatedly. |
| `SADA_TEST_DB_URL` | `auth-hook.test.ts`      | **Destructive**: drops and recreates `guard`; damages and rolls back inside it.   |

> **⚠️ These three run `drop schema if exists guard cascade`.**
> They create the schema from scratch, exercise it, and drop it again. Nothing outside
> `guard` is read or written — `public` and `auth` are never touched — but any data you
> had in `guard` is destroyed.

That is exactly why they do **not** reuse `SUPABASE_DB_URL`: a developer's
`SUPABASE_DB_URL` usually points at a real Supabase project, and `npm run
test:integration` must never drop a schema there by accident. Use a dedicated local
database:

```bash
createdb supabase_anti_disposable_auth_test
```

```bash
SADA_TEST_DB_URL="postgresql://localhost:5432/supabase_anti_disposable_auth_test" npm run test:integration
```

Never point `SADA_TEST_DB_URL` at production, and never at a Supabase project you care
about.

Integration test files run **serially** (`--no-file-parallelism`), because they share
one database and one `guard` schema. Running them in parallel would have them drop the
schema out from under each other and contend on the migration advisory lock.

The sync integration tests use a local fixture provider, never the real upstream, so
`npm run test:integration` makes no network request either. The auth-hook tests contact
no Supabase project and start no Supabase stack — they exercise the database function
directly, exactly as Supabase Auth would.

#### Auth-hook tests and Supabase roles

`auth-hook.test.ts` includes the checks that matter most for the hook: executing it as
`supabase_auth_admin`, and asserting the privilege boundaries around it. Those need
Supabase's roles, which a plain PostgreSQL server does not have.

**They skip explicitly when a role is absent** rather than looping zero times and
reporting a pass. A vacuous assertion is worse than a skip: it claims coverage the run
did not have.

To make them run locally, create the role once on your scratch server:

```bash
psql -d supabase_anti_disposable_auth_test -c "create role supabase_auth_admin nologin"
```

Then re-run the suite; the eleven role-dependent tests change from `↓` to `✓`.

Note that **roles are cluster-wide, not database-scoped**. This is the one piece of
setup that reaches outside the scratch database, which is why it is a documented manual
step and not something the suite does to you. `nologin` and no grants of its own make it
inert. To remove it afterwards:

```bash
psql -d supabase_anti_disposable_auth_test -c "drop schema if exists guard cascade" \
  -c "drop owned by supabase_auth_admin" -c "drop role supabase_auth_admin"
```

`anon` and `authenticated` work the same way: create them to exercise the client-role
boundary tests, or let those tests skip.

CI does not create these roles, so CI runs the portable subset. Verify the role-based
tests locally before landing a change to the hook or its permissions.

#### Damaging the schema on purpose

The fail-closed tests need a genuinely broken policy layer — a dropped lookup function,
a dropped table, a revoked privilege. Every one of them does its damage inside a
transaction that is rolled back in a `finally`, so the damage is real while the
assertion runs and gone the moment it ends.

Do not weaken the schema permanently to make one of these easier to write. If a test
needs a broken database, it should break it and put it back.

Fixture data is small, deterministic and inserted inside transactions that are rolled
back, so the tests leave no rows behind:

```text
mailinator.com
10minutemail.com
trashmail.example
```

No blocklist ships with the package, and no fixture is ever inserted into a real user
database.

## Build

```bash
npm run build
```

`tsup` bundles `src/cli.ts` and `src/index.ts` into `dist/` as ESM with type
declarations and source maps. Runtime dependencies (`commander`, `pg`, `zod`) stay
external.

Verify the built binary:

```bash
node dist/cli.js --help
node dist/cli.js --version
```

To test the published binary name locally:

```bash
npm link
supabase-anti-disposable-auth doctor
npm unlink -g supabase-anti-disposable-auth
```

## Quality gates

The same commands run in CI, on Node 20 and 22:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

Formatting:

```bash
npm run format        # rewrite files
npm run format:check  # verify only (this is what CI runs)
```

## Working on migrations

SQL migrations live in `migrations/` and are the source of truth for everything created
in the database. The full rules are in [migrations/README.md](../migrations/README.md);
the two that bite hardest:

- **Never edit a migration that has shipped.** Checksums are recorded at apply time and
  re-verified on every run, so an edit fails the run rather than being re-applied. Add a
  new numbered file instead.
- **Never write `begin` / `commit` in a migration.** The runner owns transactions and
  wraps each file together with its history row.
- **A migration that creates a function must re-revoke `PUBLIC` execute.** PostgreSQL
  grants `EXECUTE` to `PUBLIC` on every new function, and `ALTER DEFAULT PRIVILEGES`
  cannot prevent that at schema scope, so end such a migration with
  `revoke all privileges on all functions in schema guard from public;`. An integration
  test fails the build if you forget. `006_create_before_user_created_hook.sql` is the
  live example.
- **A migration that grants to a Supabase role must guard the grant.**
  `supabase_auth_admin`, `anon` and `authenticated` do not exist on a plain PostgreSQL
  server, so wrap the statements in
  `if exists (select 1 from pg_catalog.pg_roles where rolname = '...')`, as 005 and 007
  do. The `EXECUTE` strings inside such a block must stay compile-time constants — never
  interpolate an identifier from a query result.

  Know what that guard costs you: it is evaluated **once**, when the migration is
  applied, and a migration that took the no-op branch is still recorded as applied and
  is never replayed. If the role appears later, the grants do not. Cover the gap in
  `status` — probe the live catalog, never the migration history — and document an
  idempotent remediation rather than teaching anyone to replay the file. See
  [migrations/README.md](../migrations/README.md) →
  _Conditional migrations are applied once, condition and all_.

### Bootstrap infrastructure

The numbered migrations start at `001_create_domain_functions.sql`. There is no
`001_create_guard_schema.sql`, and that is deliberate.

`guard` and `guard.schema_migrations` are created by the migration runner before any
numbered migration executes, because a migration counts as applied only once its row is
written to `guard.schema_migrations` — so that table has to exist first. A migration
that created the history table could not record itself, and the runner would have to
special-case it. Keeping the bootstrap out of the numbered set means every numbered
migration is applied by exactly the same code path, transaction and checksum check.

Both bootstrap statements are `if not exists`, so they are a no-op on an existing
install, and `guard.schema_migrations` holds no row for its own creation.

Apply them from source against a scratch database:

```bash
SUPABASE_DB_URL="postgresql://localhost:5432/scratch" npm run dev -- install
```

```bash
SUPABASE_DB_URL="postgresql://localhost:5432/scratch" npm run dev -- status
```

`install` is idempotent — running it again applies nothing and reports the layer as
already up to date.

`status` is a health check as well as a report: it exits `0` only when the guard layer
is complete, and `5` when it is absent, incomplete or damaged. Configuration (`2`),
database (`3`) and sync (`6`) failures keep their own codes, so a broken connection is
never reported as a health verdict.

## Working on blocklist sync

The pipeline lives in `src/blocklist/`. Two rules matter more than the rest:

- **`normalizeDomain()` is a mirror of `guard.normalize_domain()`, not a second
  opinion.** If it accepts something PostgreSQL rejects, the `CHECK` constraint on
  `guard.blocked_domains` aborts the entire sync transaction. Where a judgement call
  exists, err towards rejecting — dropping one domain is survivable, breaking every sync
  is not. `blocklist-sync.test.ts` asserts the two agree over a corpus, so a divergence
  fails the build.
- **The pipeline must never call `normalizeDomain()` directly — use
  `normalizeProviderDomain()`.** The PostgreSQL function extracts a domain from an email
  address on purpose, because it will eventually see authentication input. A provider
  payload is contractually a list of domain rows, so the same extraction would salvage
  `evil.example` out of `user@evil.example` and turn a corrupted feed into legitimate-
  looking blocklist entries. `normalizeProviderDomain()` validates that a row is already
  domain-shaped **before** normalising it, and that gate is not recoverable from.
- **A failed sync must never destroy the installed blocklist.** Staging, replacement and
  metadata share one transaction; failure metadata is written afterwards, outside it. If
  you change `src/blocklist/repository.ts`, the rollback-safety tests in both
  `tests/unit/sync.test.ts` and `tests/integration/blocklist-sync.test.ts` are the ones
  to watch.

Try it against a scratch database with the real provider:

```bash
SUPABASE_DB_URL="postgresql://localhost:5432/scratch" npm run dev -- sync --dry-run
```

```bash
SUPABASE_DB_URL="postgresql://localhost:5432/scratch" npm run dev -- sync
```

The dry run makes no database changes at all, so it is always safe to run first.

## Conventions

- `process.env` is read **only** in `src/config/env.ts`. Everything else receives a
  validated `AppConfig`.
- No `console.*` in `src/` — ESLint enforces it. Use the logger from `src/lib/logger.ts`.
- User-facing failures throw a subclass of `AppError`; anything else is treated as a bug
  and may print diagnostics.
- Never log, persist, or pass a connection string as a process argument. Use
  `describeConnectionTarget()` when you need to name a database in output.
- All values sent to PostgreSQL are bound query parameters. The one exception is
  `DatabaseConnection.execute()`, which sends a multi-statement script verbatim and is
  reserved for migration files that ship with this package — never for user input.
- No ORM and no migration framework. Plain SQL through `pg`.
- Transactions go through `inTransaction()` in `src/database/transaction.ts`. There is
  one implementation of `begin`/`commit`/`rollback` on purpose: two would be two chances
  to drift, and a subtly different rollback path leaves a half-applied change nothing
  detects.
- The network is reached only from `src/blocklist/fetch.ts`. Anything downloaded is
  data: never executed, never evaluated, never written to disk, never passed to a shell.
- No `axios` and no HTTP client dependency. Native `fetch` only.
- Application objects live only in the `guard` schema. Never `public`, never `auth`, and
  `auth.users` is never modified.
