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
layer is injected into `doctor` as a dependency, so its success and failure paths are
tested with a fake connection.

### Integration tests

`tests/integration` contains tests that need a real database. They skip themselves
unless `SUPABASE_DB_URL` is set, which keeps `npm test` and CI offline by default.

```bash
SUPABASE_DB_URL="postgresql://..." npm run test:integration
```

Point these at a scratch project, not production.

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

The same four commands run in CI, on Node 20 and 22:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Formatting:

```bash
npm run format        # rewrite files
npm run format:check  # verify only (this is what CI runs)
```

## Conventions

- `process.env` is read **only** in `src/config/env.ts`. Everything else receives a
  validated `AppConfig`.
- No `console.*` in `src/` — ESLint enforces it. Use the logger from `src/lib/logger.ts`.
- User-facing failures throw a subclass of `AppError`; anything else is treated as a bug
  and may print diagnostics.
- Never log, persist, or pass a connection string as a process argument. Use
  `describeConnectionTarget()` when you need to name a database in output.
- All values sent to PostgreSQL are bound query parameters.
- No ORM. Plain SQL through `pg`.
