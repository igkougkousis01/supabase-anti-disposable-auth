# Development

## Requirements

- **Node.js 22 or newer** (`node --version`)
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

### Management API credentials

The `hook` commands need two more variables:

```bash
SUPABASE_PROJECT_REF=abcdefghijklmnopqrst
SUPABASE_ACCESS_TOKEN=sbp_...
```

`SUPABASE_ACCESS_TOKEN` is the most sensitive value in the project. A personal access
token carries the privileges of your whole Supabase account across every project it can
reach — much wider than `SUPABASE_DB_URL`, which is scoped to one database.

**Do not put it on a command line**, even for a quick test:

```bash
# DON'T. This lands in ~/.zsh_history and in the process list.
SUPABASE_ACCESS_TOKEN=sbp_... npm run dev -- hook status
```

Put it in `.env`, or export it from a secret manager:

```bash
export SUPABASE_ACCESS_TOKEN="$(op read op://vault/supabase/token)"
npm run dev -- hook status
```

These variables are optional at load time. Configuration is validated centrally in
`src/config/env.ts` and required **per command** by `requireDatabaseUrl()` and
`requireManagementCredentials()`, so a database-only workflow never fails because a token
it does not use is unset — and `hook disable` never fails because a database it does not
need is unreachable.

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

There are seven. **No suite reads `SUPABASE_DB_URL`** -- that is the credential the CLI
uses against a real project, and a test run must never be able to name it. The
distinction between the variables matters:

| Variable                                                             | Used by                  | Effect                                                                                      |
| -------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------- |
| `SADA_TEST_DB_URL`                                                   | `database.test.ts`       | Read-only: connects and reads `server_version`.                                             |
| `SADA_TEST_DB_URL`                                                   | `guard-schema.test.ts`   | **Destructive**: drops and recreates `guard`.                                               |
| `SADA_TEST_DB_URL`                                                   | `blocklist-sync.test.ts` | **Destructive**: drops `guard`, then replaces `guard.blocked_domains` repeatedly.           |
| `SADA_TEST_DB_URL`                                                   | `auth-hook.test.ts`      | **Destructive**: drops and recreates `guard`; damages and rolls back inside it.             |
| `SADA_TEST_DB_URL`                                                   | `strict-trigger.test.ts` | **Destructive**: drops and recreates `guard` **and a synthetic `auth` schema it creates**.  |
| `SADA_TEST_DB_URL`                                                   | `lifecycle.test.ts`      | **Destructive**: repair/uninstall fixtures drop and recreate `guard`; hosted API is mocked. |
| `SADA_TEST_SUPABASE_PROJECT_REF` + `SADA_TEST_SUPABASE_ACCESS_TOKEN` | `management-api.test.ts` | **Read-only**: one `GET` of a hosted project's Auth configuration. Changes nothing.         |

> **⚠️ These five run `drop schema if exists guard cascade` in test setup/teardown.**
> They create the schema from scratch, exercise it, and drop it again. Any data you had in
> `guard` is destroyed.
>
> **⚠️ `strict-trigger.test.ts` additionally creates and drops an `auth` schema.**
> Strict mode is a trigger on `auth.users`, so testing it needs one. The suite builds a
> **minimal synthetic fixture** — `id`, `email varchar(255) null`, `phone`,
> `raw_user_meta_data`, `is_anonymous` — and drops it afterwards.
>
> It refuses to touch an `auth` schema it did not create: the fixture is stamped with a
> marker comment, and an unmarked `auth` schema **aborts the run with an explicit error**
> rather than being dropped. Failing loudly is deliberate — a developer who pointed this at
> a real project must not see a quiet skip and assume the tests passed.
>
> **This fixture is not Supabase.** It validates PostgreSQL trigger semantics — firing
> rules, the `UPDATE OF` column filter, fail-closed behaviour, catalog shape, privilege
> behaviour — against the real engine. It does not validate Supabase Auth, GoTrue's write
> paths, or the real managed `auth` schema, and nothing in it should be read as claiming
> otherwise.

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

#### Supabase-specific roles

The tests that matter most in `auth-hook.test.ts` and `strict-trigger.test.ts` — executing
the policy path as `supabase_auth_admin`, and proving fail-closed behaviour under a role
that is not the schema owner — need a role a plain PostgreSQL server does not have. They
**skip explicitly** when it is absent rather than running as the owner, whose implicit
privileges hide exactly the failures those tests exist to catch.

To run them, create the role once on your scratch server:

```bash
psql -d supabase_anti_disposable_auth_test -c "create role supabase_auth_admin nologin"
```

and drop it when you are done. Roles are cluster-wide, which is why this is a documented
manual step and not something the suite does to you.

The strict-mode fixture grants that role ordinary `INSERT`/`UPDATE`/`SELECT` on the
synthetic `auth.users`. On hosted Supabase the role **owns** the table instead. That
difference is a known limitation of the fixture, documented rather than papered over by
weakening the role.

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

#### Management API tests

**No unit test touches the network.** `fetch` is injected into `ManagementClient`, and
`tests/helpers/management-api.ts` builds a **real** client over a fake `fetch` rather than
mocking the client itself — so the HTTPS check, the timeout, the byte ceiling, the
content-type check and the `Authorization` header are all exercised rather than stubbed
away.

Every state transition — enable, disable, conflict, idempotence, preflight refusal,
dry run, post-write verification — is covered there, in `tests/unit/hook-command.test.ts`
and `tests/unit/hook-plan.test.ts`.

Uninstall adds 401/403/404/429/5xx refusal, foreign state, post-PATCH mismatch, token
redaction, zero-write dry-run, strict-then-remote failure, remote-then-database failure,
and retry/resume coverage in `uninstall-command.test.ts`. The real PostgreSQL half runs
in `lifecycle.test.ts` against `SADA_TEST_DB_URL`; its Management client still uses fake
`fetch`, so no hosted configuration is mutated.

`tests/integration/management-api.test.ts` is the only test that can reach Supabase. It
is **read-only**, skips itself unless both `SADA_TEST_SUPABASE_PROJECT_REF` and
`SADA_TEST_SUPABASE_ACCESS_TOKEN` are set, and deliberately does not read the CLI's own
`SUPABASE_*` variables — the same rule that keeps `SADA_TEST_DB_URL` separate from
`SUPABASE_DB_URL`. It exists to notice if Supabase renames or removes the two hook fields.

**There is no live mutation test, and adding one needs more than a flag.**
`SADA_ALLOW_REMOTE_MUTATION_TESTS` is reserved for that decision. Credentials being
present is never permission to change somebody's Auth configuration, and a suite whose
failure mode is leaving a real project mid-change is not worth the confidence it buys.

#### Testing that secrets do not leak

`tests/unit/secrets.test.ts` drives every plausible output path with a sentinel token and
asserts it never appears: request URLs, PATCH bodies, normal logs, dry-run output, thrown
`AppError` messages and hints, and the full `--debug` rendering including attached causes.

Two real leaks were found by these tests rather than by reading the code — a server that
echoes the token back into its own error message, and a transport error whose `cause`
carried it into `--debug` output. **Add a case here whenever you add a path that prints
anything**, and treat a failure as a security bug rather than a test to adjust.

The same file asserts the Auth configuration document is never dumped, using a fixture
padded with fake SMTP and OAuth secrets.

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

**Source maps are shipped deliberately.** They carry relative source paths and embedded
sources — no local absolute path leaks into the package — and they make a `--debug`
stack trace from a bug report actionable when the reporter runs with
`NODE_OPTIONS=--enable-source-maps`. The project is MIT and its source is public, so
there is nothing in them that is not already on GitHub.

**`src/index.ts` is the entire public API**, and it is deliberately small: the CLI
entry points, the error types, `EXIT_CODES`, the logger factory and the package
identity. Everything else is internal and free to change. Adding an export is a decision
to support it forever — think before widening it, because removing one later is a
breaking change.

The `overrides` block in `package.json` pins `esbuild` to `^0.28.2` across the tree.
`tsup` declares `^0.27.0`; the override keeps the whole dependency graph on one recent
esbuild rather than whatever range resolution happens to pick, and the build is verified
against it in CI on every push.

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

CI runs three jobs on every push and pull request:

| Job           | What it does                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `verify`      | Type check, lint, format check, unit tests and build, on Node 22 and 24.                                   |
| `integration` | The database suites against a `postgres:17` service container, with the Supabase roles created explicitly. |
| `package`     | `npm pack`, then installs the tarball in a clean project and runs the CLI from it.                         |

Locally, that is:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

plus, against a scratch database:

```bash
SADA_TEST_DB_URL="postgresql://localhost:5432/supabase_anti_disposable_auth_test" npm run test:integration
```

CI needs **no Supabase credentials of any kind** — no project database URL and no
Management API token. The integration job uses a disposable service container named by
`SADA_TEST_DB_URL`; the live hosted suite has no credentials in CI and skips itself.

The `package` job exists because packaging mistakes are invisible to the test suite and
fatal to a user's first command: a missing `migrations/` directory, an import that only
resolves inside the repository, a `bin` that is not executable. It asserts the packed
artifact reports the right version, ships all eight migrations, and contains no `.env`.

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

## Working on hook activation

The code lives in `src/supabase/` and `src/commands/hook.ts`, split so that the decision
logic has no I/O in it:

| Module                 | Knows about                                       | Does not know about |
| ---------------------- | ------------------------------------------------- | ------------------- |
| `constants.ts`         | the origin, the path, the hook URI, the ref shape | anything else       |
| `management-client.ts` | HTTP, TLS, timeouts, statuses, schemas            | hooks               |
| `auth-config.ts`       | hook state, what to write, what proves it         | the network         |
| `commands/hook.ts`     | orchestration, preflight, output, exit codes      | HTTP details        |

Keep `auth-config.ts` pure. It is the module that decides whether somebody's
authentication configuration gets overwritten, and it is testable exhaustively — every
combination of `enabled` and `uri`, for both intents — precisely because it touches
nothing. If you find yourself wanting a network call or a clock in there, the logic
belongs in `commands/hook.ts` instead.

Three rules that are easy to break and expensive to get wrong:

- **A URI that is not ours is never written over.** Enabled or disabled, `pg-functions:`
  or HTTP, the answer is conflict. `tests/unit/hook-plan.test.ts` asserts this across the
  whole state space; if you add a state, add it there first.
- **The preflight runs before any network request.** Not before the PATCH — before the
  GET. A refusal must not have sent a token anywhere, and the tests assert
  `api.requests` is empty rather than merely that no PATCH was sent.
- **`hook disable` must never require a database.** It is the command an operator reaches
  for when the fail-closed hook is rejecting every signup, which is often exactly when
  their database is the problem.

Try the whole flow against a scratch database and a fake API without touching a real
project: inject a `ManagementClient` built over your own `fetch` double, exactly as
`tests/unit/hook-command.test.ts` does.

## Working on strict trigger mode

The code lives in `src/database/strict-trigger.ts` and `src/commands/strict.ts`, split the
same way the hook code is: catalog facts in one module, orchestration in the other.

| Module                       | Knows about                                            | Does not know about          |
| ---------------------------- | ------------------------------------------------------ | ---------------------------- |
| `database/strict-trigger.ts` | the fixed identity, the DDL, the catalog, the verdicts | commands, output, exit codes |
| `commands/strict.ts`         | orchestration, preflight, output, exit codes           | catalog details              |

Five rules that are easy to break and expensive to get wrong:

- **No migration may ever create the trigger.** `install` ≠ `strict enable`, and that
  separation is the whole opt-in property. Migration `008` installs a function; the
  trigger comes from a command an operator ran on purpose.
- **Never `DROP TRIGGER IF EXISTS`, and never drop-then-recreate.** Ownership is
  established from the catalog first. A trigger under our name that is not ours is a
  conflict, and a conflict is reported — never resolved by destroying it. There is no
  `--force` and there should not be one.
- **Never decide from `pg_get_triggerdef()`.** It is captured as diagnostic output for the
  operator to read. Decisions come from `tgfoid`, `tgtype`, `tgattr`, `tgenabled`,
  `tgconstraint` and `tgqual`, because string matching is how a tool gets fooled by
  whitespace, a quoted identifier, or a future PostgreSQL that renders the same trigger
  differently.
- **Never add an exception handler to `guard.enforce_auth_user_email()`.** The fail-closed
  guarantee is achieved by _not_ catching, and `when others then return new` would convert
  a broken policy engine into a silent bypass. Four integration tests damage the layer in
  four different ways and assert the write fails every time; if you add a handler, they
  will tell you.
- **`strict disable` must never require a healthy guard schema.** It is the command an
  operator reaches for when the fail-closed trigger is rejecting every write, which is
  precisely when their guard layer is the problem.

Identifiers in the DDL are compiled-in constants and a unit test asserts the exact
`CREATE`/`DROP` statements. The only user-controlled input either command accepts is
`--dry-run`, and `--dry-run` must execute zero DDL — asserted in both the unit and the
integration suites.

## Working on repair and uninstall

The lifecycle boundary is split deliberately:

| Module                  | Responsibility                                                            |
| ----------------------- | ------------------------------------------------------------------------- |
| `database/lifecycle.ts` | read-only migration, catalog, owner, object and dependency evidence       |
| `database/repair.ts`    | the two leaf-function repairs and fixed least-privilege grant SQL         |
| `database/uninstall.ts` | explicit dependency-safe drop batch; no decisions and no `CASCADE`        |
| `commands/repair.ts`    | five-state planner, optional remote read, output and verification         |
| `commands/uninstall.ts` | cross-system ordering, confirmation, remote verification and resumability |

Rules for changes here:

- Migration history is evidence. Repair must never update/delete rows, mark a migration
  applied, or rerun a historical batch. A new repair target needs a deliberate current-
  state routine and tests proving its boundary.
- `repair` never enables remote or strict enforcement. A new repair that changes intent
  is a feature and does not belong in this command.
- A same-name database object is not automatically ours. Keep migration checksums,
  owner, catalog shape, function body, unexpected-object and dependency checks aligned
  whenever an owned object is added.
- `--yes` confirms a plan; it is not a force flag. Conflict checks run before it and
  cannot be bypassed.
- Full uninstall must freshly disable and verify the hosted hook before database cleanup.
  No refactor may move guard deletion above that point.
- Never introduce `DROP SCHEMA guard CASCADE` into production code. Setup/teardown in a
  dedicated scratch test database is the only allowed use. Production cleanup names
  fixed objects explicitly and finishes with plain `DROP SCHEMA guard`.
- Cross-system partial failure is expected. Keep steps idempotent and preserve the safe
  intermediate states exercised by failure-injection tests.

To run the destructive lifecycle fixtures, use only a dedicated database:

```bash
createdb supabase_anti_disposable_auth_test
SADA_TEST_DB_URL=postgresql://localhost:5432/supabase_anti_disposable_auth_test \
  npm run test:integration
```

The missing-grant and missing-hook repair cases require `supabase_auth_admin`. On a plain
scratch cluster those cases skip explicitly unless you created that synthetic role. Do
not create cluster-wide roles automatically from the test suite.

## Releasing

The maintainer release procedure — quality gate, package inspection, tarball smoke test,
tag, publish, GitHub Release — is in [releasing.md](releasing.md). Publishing is manual
and deliberately not automated; the reasoning is on that page.

## Conventions

- `process.env` is read **only** in `src/config/env.ts`. Everything else receives a
  validated `AppConfig`.
- No `console.*` in `src/` — ESLint enforces it. Use the logger from `src/lib/logger.ts`.
- **Streams.** Reports and help go to stdout so they can be piped; alerts (`warning`,
  `error`) and the continuation lines of a failure (`detail`) go to stderr. A fatal
  error and its hint always arrive on stderr **together** — a hint stranded on the other
  stream by a redirection is a hint nobody reads. There is no colour and no spinner
  anywhere, which is why the output needs no `NO_COLOR` handling and stays readable in a
  CI log.
- User-facing failures throw a subclass of `AppError`; anything else is treated as a bug
  and may print diagnostics.
- Never log, persist, or pass a connection string as a process argument. Use
  `describeConnectionTarget()` when you need to name a database in output.
- All values sent to PostgreSQL are bound query parameters. The one exception is
  `DatabaseConnection.execute()`, which sends a multi-statement script verbatim and is
  reserved for fixed migration, repair, strict-trigger, and uninstall SQL that ships
  with this package — never for user input or a runtime-derived identifier.
- No ORM and no migration framework. Plain SQL through `pg`.
- Transactions go through `inTransaction()` in `src/database/transaction.ts`. There is
  one implementation of `begin`/`commit`/`rollback` on purpose: two would be two chances
  to drift, and a subtly different rollback path leaves a half-applied change nothing
  detects.
- The network is reached from exactly two places: `src/blocklist/fetch.ts` (public,
  unauthenticated) and `src/supabase/management-client.ts` (authenticated). Anything
  downloaded is data: never executed, never evaluated, never written to disk, never
  passed to a shell.
- **The Management API origin is a compiled-in constant.** Never add a flag, environment
  variable or config file that sets it. A settable API origin turns a CLI holding a
  Management API token into a credential-exfiltration primitive. `ManagementClientOptions.baseUrl`
  exists for dependency injection in tests and must stay unreachable from user input.
- **`SUPABASE_ACCESS_TOKEN` goes in an `Authorization` header and nowhere else.** Not a
  URL, not a log, not an error message, not a file, not a process argument. Sanitise any
  server-supplied text and any attached `cause` before it can reach a terminal, and add a
  case to `tests/unit/secrets.test.ts` for every new output path.
- **Never PATCH the whole Auth configuration.** Send only the fields this feature owns.
  Round-tripping a GET response would rewrite unrelated settings — including other
  people's secrets — with stale values.
- **Never claim a remote change succeeded without reading it back.** HTTP 200 means
  accepted, not applied.
- No `axios` and no HTTP client dependency. Native `fetch` only.
- Application objects live only in the `guard` schema. Never `public`, never `auth`, and
  `auth.users` is never modified.
