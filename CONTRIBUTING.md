# Contributing

Thanks for your interest. This is a security tool that installs objects into other
people's production databases, so the bar for changes is deliberately high — but the
setup is simple and the test suite is fast.

## Requirements

- **Node.js 22 or newer.** Node 20 is end-of-life and is not supported.
- **PostgreSQL 13 or newer**, locally, if you want to run the integration tests.
- No global tooling beyond that.

## Setup

```bash
git clone https://github.com/igkougkousis01/supabase-anti-disposable-auth.git
cd supabase-anti-disposable-auth
npm ci
npm run dev -- --help          # run the CLI from source
```

## Quality gates

Run all of these before opening a pull request. CI runs the same ones on Node 22 and 24:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

`npm run format` rewrites files; `npm run lint:fix` fixes what ESLint can.

## Tests

Unit tests live in `tests/unit` and never touch the network or a database — `fetch` and
the database connection are both injected. Run them with `npm test`.

### Integration tests and database safety

Integration tests need a real PostgreSQL database, and several of them are
**destructive within the `guard` schema**: they run `drop schema if exists guard cascade`
in setup and teardown.

For that reason they read **`SADA_TEST_DB_URL`**, never `SUPABASE_DB_URL`:

```bash
createdb supabase_anti_disposable_auth_test
SADA_TEST_DB_URL="postgresql://localhost:5432/supabase_anti_disposable_auth_test" \
  npm run test:integration
```

**This is not a style preference.** A developer's `SUPABASE_DB_URL` usually points at a
real Supabase project, and a test run must never be able to drop a schema there because
someone had the wrong variable exported. Any change that lets a test path reach
`SUPABASE_DB_URL` will be rejected.

With `SADA_TEST_DB_URL` unset, the whole directory skips itself, which is why `npm test`
and CI need no credentials at all.

To exercise the privilege-boundary tests rather than have them skip, create the Supabase
roles in your scratch database once:

```bash
psql -d supabase_anti_disposable_auth_test -c \
  "create role supabase_auth_admin nologin; create role anon nologin; create role authenticated nologin"
```

The strict-mode suite creates and drops a **synthetic** `auth` schema. It refuses to
touch an `auth` schema it did not create, and aborts loudly rather than skipping if it
finds one.

## Migrations are frozen

`migrations/001` through `008` have been applied to real databases and their checksums
recorded in `guard.schema_migrations`. **Editing an applied migration is a breaking
change**: every existing installation would report tamper detection.

Fixes to installed SQL go in a **new** migration (`009_...`). `tests/unit/migration-freeze.test.ts`
enforces this, and the rules are in [migrations/README.md](migrations/README.md).

## Pull requests

- **One concern per pull request.** Small and reviewable beats complete and unreadable.
- **Branch from `main`**, named for what it does: `feat/...`, `fix/...`, `docs/...`,
  `chore/...`.
- **Conventional commit subjects** (`feat:`, `fix:`, `docs:`, `chore:`, `test:`).
- **Tests are not optional** for behaviour changes. Security-relevant behaviour needs a
  test that fails without the change.
- **Update the docs in the same pull request.** The README's exit-code and
  environment-variable tables are covered by a test that will fail if they drift from the
  code.
- **Explain the reasoning, not just the change.** This codebase documents _why_ a
  decision was made, especially where a safer-looking alternative was rejected. Match
  that.

New features are worth opening an issue for first — 1.0 deliberately left several things
out, and [the roadmap](docs/roadmap.md) explains which and why.

## Things that will be pushed back on

Not to be discouraging; these are settled decisions with reasons written down:

- A configurable blocklist source URL, or a configurable Management API base URL.
- A `--force` flag for any conflict — hook, trigger or ownership.
- `DROP ... CASCADE` in any production path.
- `SECURITY DEFINER`, or a function without a pinned `search_path`.
- Any grant to `PUBLIC`, `anon` or `authenticated`.
- Anything that prints a connection string, a token, or a foreign hook's path or query.
- Editing an applied migration.

## Security issues

**Do not open a public issue for a vulnerability.** Follow [SECURITY.md](SECURITY.md),
which uses GitHub's private vulnerability reporting. Never include a real connection
string, token or key in any report or issue.

## Code of conduct

Participation is covered by the [Code of Conduct](CODE_OF_CONDUCT.md).
