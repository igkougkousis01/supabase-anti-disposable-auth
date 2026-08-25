# Supabase Anti-Disposable Auth

A Node.js CLI that installs database-level disposable-email protection into Supabase
projects. Instead of validating throwaway addresses in your application code, the tool
will push enforcement down into PostgreSQL and Supabase Auth, so every signup path —
your app, another client, or the dashboard — is covered by the same rule.

## Project status: early development

This repository currently contains the **CLI foundation only**. The `doctor` command is
implemented and useful. Everything else is scaffolding with an explicit
`Not implemented yet.` response — no functionality is faked.

## Intended capabilities

Planned, not yet built (see [docs/roadmap.md](docs/roadmap.md)):

- Supabase **Before User Created** auth hook backed by a database function
- Optional strict PostgreSQL trigger enforcement
- A database-backed disposable-domain blocklist
- Allowlist overrides for domains you always want to accept
- Automatic blocklist refresh, optionally scheduled with `pg_cron`
- Safe install / uninstall flows with dry-run support
- Diagnostics and health checks

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

| Command     | Status              | Purpose                                                   |
| ----------- | ------------------- | --------------------------------------------------------- |
| `doctor`    | **Available**       | Validate the local environment and database connectivity. |
| `install`   | Not implemented yet | Install the guard schema and auth hook.                   |
| `status`    | Not implemented yet | Report what is installed in the target project.           |
| `sync`      | Not implemented yet | Refresh the disposable-domain blocklist.                  |
| `uninstall` | Not implemented yet | Remove everything the CLI installed.                      |

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

### Exit codes

| Code | Meaning                            |
| ---- | ---------------------------------- |
| `0`  | Success                            |
| `1`  | Unexpected error (a bug)           |
| `2`  | Configuration error                |
| `3`  | Database connection or query error |
| `4`  | Command is not implemented yet     |

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
- Secrets are never passed as command-line arguments to other processes.

Vulnerability reports: see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
