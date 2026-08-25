# Architecture

> **Status:** this document describes the _planned_ architecture. Only the CLI
> foundation and the `doctor` command exist today. Everything marked **Planned** is not
> implemented.

## Overview

```text
CLI
 ↓
Supabase / PostgreSQL
 ↓
guard schema
 ↓
Auth Hook
 ↓
blocklist lookup
```

The design principle is that enforcement lives in the database, not in the CLI. The CLI
is an installer and an operator tool: it creates objects, inspects them, and removes
them. Once installed, protection works whether or not the CLI is ever run again.

## Layers

### 1. CLI (implemented)

A Commander-based Node.js program. Responsibilities:

- parse commands and flags,
- load and validate configuration once, in `src/config/env.ts`,
- open a PostgreSQL connection when a command needs one,
- render results and errors through a single logger and error hierarchy.

The CLI holds no state and stores nothing on disk.

Current modules:

| Path                     | Responsibility                                                    |
| ------------------------ | ----------------------------------------------------------------- |
| `src/cli.ts`             | Entry point, command registration, top-level error handling.      |
| `src/commands/`          | One module per command.                                           |
| `src/config/env.ts`      | The only place `process.env` is read; validated with Zod.         |
| `src/database/client.ts` | `pg`-based connection with an explicit lifecycle.                 |
| `src/lib/errors.ts`      | Configuration / database / unexpected error kinds and exit codes. |
| `src/lib/logger.ts`      | Minimal stdout/stderr logger.                                     |
| `src/lib/redact.ts`      | Turns a connection string into a printable `host:port/database`.  |

### 2. Supabase / PostgreSQL (implemented: connectivity only)

The CLI connects directly to the project database over `SUPABASE_DB_URL` using `pg`.
There is no ORM: the tool manages database infrastructure, so plain, parameterised SQL
is the correct level of abstraction. TLS behaviour is taken from the connection string
and is never relaxed by the tool.

Today the database layer is used only by `doctor`, which connects and reads
`server_version`.

### 3. `guard` schema (**Planned**)

All objects the tool creates will live in a dedicated schema (working name: `guard`) so
that installation and removal are contained and auditable. Nothing will be added to
`auth`, `public`, or any application schema.

Expected contents:

- a blocklist table of disposable domains,
- an allowlist table of always-accepted domains,
- metadata: installed version, last blocklist refresh, row counts,
- a lookup function that answers "is this address disposable?".

### 4. Auth Hook (**Planned**)

Supabase's **Before User Created** hook lets a PostgreSQL function inspect a signup
before the user row is created. The tool will register a function in the `guard` schema
as that hook and return a rejection for disposable domains.

This is the primary enforcement path because it covers every signup route into the
project and produces a clean error for the client.

### 5. Blocklist lookup (**Planned**)

The hook normalises the email address, extracts the domain, and checks the allowlist
before the blocklist. Lookups will be indexed exact matches on a normalised domain
column, so the added latency per signup stays negligible.

## Planned optional features

These are opt-in and explicitly **not** part of the default install:

- **Strict trigger mode.** A PostgreSQL trigger enforcing the same rule at the table
  level, for defence in depth when a signup path bypasses the hook. Stricter, but harder
  to reason about and riskier to install; therefore optional.
- **`pg_cron` synchronisation.** Scheduling blocklist refreshes inside the database, so
  the list stays current without the CLI running. Requires the extension to be available
  and enabled in the project.
- **Remote blocklist sync.** Fetching an upstream disposable-domain list with the native
  `fetch` API and reconciling it into the blocklist table.

## Safety principles

1. **Reversible.** Everything the tool creates lives in one schema and is removable by
   `uninstall`.
2. **Explicit.** Destructive or state-changing commands will support a dry run that
   prints the exact SQL first.
3. **Non-invasive.** `auth.users` is never modified, and application schemas are never
   touched.
4. **Secret-safe.** Connection strings are never logged, written to disk, or passed as
   process arguments; all values in SQL are bound parameters.
