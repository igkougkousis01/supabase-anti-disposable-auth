# Architecture

> **Status:** the CLI foundation, the `guard` schema and the database policy engine
> exist today. The Supabase Auth Hook does **not**. Everything marked **Planned** below
> is not implemented, and no signup is filtered yet.

## Overview

What exists today:

```text
CLI
 │
 ▼
PostgreSQL
 │
 ▼
guard schema
 ├── schema_migrations
 ├── blocked_domains
 ├── allowed_domains
 ├── sync_metadata
 ├── normalize_domain()
 └── is_disposable_domain()
```

The policy engine is complete and correct in isolation, but nothing calls it yet. It is
a library inside the database, not an active filter.

**Planned** — how it will be wired into signups in a later branch:

```text
Supabase Auth
      ↓
Before User Created Hook        <- planned, not implemented
      ↓
guard.is_disposable_domain()    <- exists today
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

| Path                            | Responsibility                                                    |
| ------------------------------- | ----------------------------------------------------------------- |
| `src/cli.ts`                    | Entry point, command registration, top-level error handling.      |
| `src/commands/`                 | One module per command.                                           |
| `src/config/env.ts`             | The only place `process.env` is read; validated with Zod.         |
| `src/database/client.ts`        | `pg`-based connection with an explicit lifecycle.                 |
| `src/database/migrations.ts`    | Migration discovery, checksums, planning and execution.           |
| `src/database/schema-status.ts` | Read-only inspection of the installed schema.                     |
| `src/lib/errors.ts`             | Configuration / database / unexpected error kinds and exit codes. |
| `src/lib/logger.ts`             | Minimal stdout/stderr logger.                                     |
| `src/lib/redact.ts`             | Turns a connection string into a printable `host:port/database`.  |

### 2. Supabase / PostgreSQL (implemented: connectivity only)

The CLI connects directly to the project database over `SUPABASE_DB_URL` using `pg`.
There is no ORM: the tool manages database infrastructure, so plain, parameterised SQL
is the correct level of abstraction. TLS behaviour is taken from the connection string
and is never relaxed by the tool.

Today the database layer is used only by `doctor`, which connects and reads
`server_version`.

### 3. `guard` schema (implemented)

Every object the tool creates lives in one dedicated schema, so installation and
removal are contained and auditable. Nothing is added to `auth`, `public`, or any
application schema, and `auth.users` is never touched.

| Object                       | Purpose                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `schema_migrations`          | Applied migration versions, names and checksums. Bootstrap infrastructure — created by the runner, not by a numbered migration. |
| `blocked_domains`            | Disposable domains. Primary key is the normalised domain.                                                                       |
| `allowed_domains`            | Overrides for false positives.                                                                                                  |
| `sync_metadata`              | Per-source sync state. Empty until sync exists.                                                                                 |
| `normalize_domain(text)`     | Domain extraction and canonicalisation.                                                                                         |
| `is_blocked_domain(text)`    | Blocklist membership.                                                                                                           |
| `is_allowed_domain(text)`    | Allowlist membership.                                                                                                           |
| `is_disposable_domain(text)` | The policy answer, with allowlist precedence.                                                                                   |

#### Migration system

Migrations are plain `.sql` files in `migrations/`, applied by a small runner in
`src/database/migrations.ts`. There is no ORM and no migration framework.

- Order is the three-digit filename prefix, never directory listing order.
- Each file is sent as **one statement batch** over the simple query protocol. Files are
  never split on `;` — function bodies contain semicolons, so splitting would corrupt
  them.
- Each file runs in its own transaction together with the row that records it, so a
  partial application can never be recorded as complete.
- Every file is checksummed (SHA-256, CRLF-normalised). An already-applied file whose
  content changed fails the run instead of being silently re-applied or ignored.
- A session advisory lock serialises concurrent runs against the same database.
- `guard` and `guard.schema_migrations` are **bootstrap infrastructure**, created by the
  runner itself rather than by a numbered migration. See below.

See [migrations/README.md](../migrations/README.md) for the rules on adding one.

##### Bootstrap infrastructure: why there is no `001_create_guard_schema.sql`

`guard` and `guard.schema_migrations` are created by the migration runner
(`src/database/migrations.ts`) **before any numbered migration executes**, from a
constant `create schema if not exists` / `create table if not exists` pair run in a
single transaction. They are intentionally _not_ represented by a `001_...` file.

The reason is a genuine ordering constraint, not a style preference:

- Applying a migration means executing it **and** recording it, atomically, in
  `guard.schema_migrations`.
- So the history table must already exist before the _first_ numbered migration can be
  recorded.
- A `001_create_guard_schema.sql` could not record itself: at the moment it ran, the
  table it creates would not yet exist to write its own row into. The runner would have
  to special-case migration `001` and apply it differently from every other migration —
  exactly the kind of exception that makes a migration system untrustworthy.

Keeping the bootstrap outside the numbered set means **every** numbered migration is
handled by the same code path, with the same transaction and the same checksum
verification. The bootstrap statements are idempotent and carry no version of their own,
so re-running `install` against an existing database is a no-op.

Consequently the numbered migrations start at `001_create_domain_functions.sql`, and
`guard.schema_migrations` has no row describing its own creation. That absence is
expected, not a gap in the history.

#### Domain normalisation

`guard.normalize_domain(input text)` lowercases, trims, and takes the part after the
last `@`:

```text
'MAILINATOR.COM'      -> 'mailinator.com'
' mailinator.com '    -> 'mailinator.com'
'@mailinator.com'     -> 'mailinator.com'
'user@mailinator.com' -> 'mailinator.com'
```

It returns `NULL` for anything it cannot confidently normalise — `NULL`, empty or
whitespace-only input, a missing domain part, or a value that is not a plausible
hostname. It is **not** an RFC 5322 validator, deliberately: it may reject input another
parser would accept, because the only consequence is that the address is not classified
as disposable.

Volatility is `IMMUTABLE` (and `STRICT`), which is semantically correct — the result
depends only on the argument — and is a hard requirement for using it in a `CHECK`
constraint.

Normalisation is enforced by the database, not just by application code. Both tables
carry:

```sql
check (domain is not distinct from guard.normalize_domain(domain))
```

`IS NOT DISTINCT FROM` rather than `=` matters: a `CHECK` that evaluates to `NULL`
**passes**, so plain equality would admit exactly the malformed values the constraint
exists to reject. Together with the primary key this makes `Mailinator.com`,
`MAILINATOR.COM` and `mailinator.com` impossible to store as separate rows.

#### Allowlist precedence

`guard.is_disposable_domain()` checks the allowlist **first** and returns
unconditionally, so a domain present in both tables is allowed:

| Situation      | Result  |
| -------------- | ------- |
| blocked only   | `true`  |
| allowed only   | `false` |
| both lists     | `false` |
| neither list   | `false` |
| `NULL` / empty | `false` |
| unnormalisable | `false` |

It never raises for ordinary malformed input. Failing open is the correct trade-off: an
address that cannot be parsed must not be rejected by a rule that never matched.

Volatility is `STABLE` — it reads tables, so it cannot be `IMMUTABLE` — and it is
deliberately **not** `STRICT`, because a `STRICT` function returns `NULL` for `NULL`
input where the contract requires `false`.

#### Indexing

No secondary indexes exist, deliberately. Every lookup is an exact equality match on the
normalised primary key, which the implicit unique btree behind each `PRIMARY KEY`
already serves — verified as an `Index Only Scan`. A second index on the same column
would cost write throughput during list reconciliation and buy nothing.

#### Privileges

- `PUBLIC`, `anon` and `authenticated` have no privileges on the schema, the tables or
  the functions. Read access would leak the blocklist; write access would let a client
  allowlist its own disposable domain and walk straight through the check.
- PostgreSQL grants `EXECUTE` to `PUBLIC` on every new function by default, so
  `005_permissions.sql` revokes it explicitly for the functions that exist at that
  point. See the note below on why `ALTER DEFAULT PRIVILEGES` does **not** extend this
  to future functions.
- No function is `SECURITY DEFINER`. Nothing needs to borrow the owner's privileges yet,
  and adding it would widen the blast radius for no gain.
- Every function pins `search_path = ''` and fully qualifies `guard` objects, so no
  session setting can change what they resolve to.
- Nothing is granted to `supabase_auth_admin`. The auth hook does not exist, so the role
  that would eventually call the lookup has no reason to reach the schema yet. Those
  grants arrive with the hook.

**Ownership:** every object is owned by the role behind `SUPABASE_DB_URL` — normally
`postgres` on Supabase. That owner and superusers retain full access implicitly.
Ownership is never granted away.

#### `ALTER DEFAULT PRIVILEGES` and why it is not used here

It is tempting to write
`ALTER DEFAULT PRIVILEGES IN SCHEMA guard REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` and
treat future functions as protected. That would be wrong twice over, and this project
deliberately does not do it:

1. **The schema-scoped form is a silent no-op.** PostgreSQL's built-in "grant `EXECUTE`
   to `PUBLIC`" default for functions is not represented in `pg_default_acl`, so with no
   pre-existing entry there is nothing for the `REVOKE` to remove. The statement
   succeeds, writes no row, and changes nothing — a function created afterwards still
   gets `PUBLIC EXECUTE`. Verified by integration test.
2. **`ALTER DEFAULT PRIVILEGES` is role-scoped, not schema-scoped.** It applies only to
   objects created _by the role whose defaults were altered_. It is not a property of
   the schema and offers no guarantee for objects created by any other future owner —
   another admin, a different migration role, or a superuser doing manual repair. The
   role-global form (the same statement without `IN SCHEMA`) does work, but it would
   change the defaults for every function that role creates in **every** schema,
   including `public` and the user's own application schemas. This tool must not reach
   outside `guard`, so that trade is refused.

What actually contains these functions is the **schema `USAGE` revoke**. Calling a
function requires `USAGE` on its schema, so without it a role cannot invoke anything in
`guard` regardless of the `EXECUTE` grants on the function itself. Function-level
revokes are defence in depth on top of that gate, not the primary control.

The practical consequence, enforced by an integration test rather than by convention:
**every future migration that creates a function must repeat**
`revoke all privileges on all functions in schema guard from public;`. A test asserts
that no function in `guard` is executable by `PUBLIC`, so a migration that forgets fails
the build.

### 4. Auth Hook (**Planned**)

Supabase's **Before User Created** hook lets a PostgreSQL function inspect a signup
before the user row is created. The tool will register a function in the `guard` schema
as that hook and return a rejection for disposable domains.

This is the primary enforcement path because it covers every signup route into the
project and produces a clean error for the client.

### 5. Blocklist lookup (implemented, not yet wired to signups)

The lookup function is complete and tested. What is missing is only the caller: nothing
invokes it during authentication yet, so installing this tool does not currently reject
any signup.

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
5. **Honest.** `status` reports unbuilt features as not configured rather than omitting
   them, so the output can never imply protection that does not exist.

## Database threat model

Concerns specific to the database layer, and what answers each one.

| Concern                                               | Mitigation                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malicious domain strings                              | Input reaches SQL only as a bound parameter, and `normalize_domain()` uses no dynamic SQL. A value like `x'); drop table ...--@evil.com` normalises to `evil.com` — inert text. Length is capped before any regex runs.                                                                                       |
| Case-variant duplicate domains                        | Normalising `CHECK` constraint plus the primary key. Case variants cannot coexist as rows.                                                                                                                                                                                                                    |
| Altered historical migration files                    | SHA-256 recorded at apply time and re-checked on every run. A mismatch fails the run; the altered file is never re-executed and never silently accepted.                                                                                                                                                      |
| Deleted or renamed applied migrations                 | Both rejected during planning, before anything executes.                                                                                                                                                                                                                                                      |
| Out-of-order migrations                               | A new file numbered below an applied one is rejected rather than run out of sequence.                                                                                                                                                                                                                         |
| Accidental public write grants                        | Explicit revokes for `PUBLIC`, `anon` and `authenticated`, with the schema `USAGE` revoke as the containing gate. Asserted by integration tests using `has_schema_privilege()` / `has_table_privilege()` / `has_function_privilege()`, which resolve inherited privileges that ACL string parsing would miss. |
| A future migration adding a world-executable function | `ALTER DEFAULT PRIVILEGES` cannot prevent this (see above), so an integration test asserts no function in `guard` is `PUBLIC`-executable. A migration that omits the revoke fails the build.                                                                                                                  |
| Falsely reporting a damaged install as healthy        | `status` probes every expected table and function individually instead of trusting the migration history, and reports `Incomplete installation` when any is absent.                                                                                                                                           |
| The tool altering privileges outside `guard`          | No role-global `ALTER DEFAULT PRIVILEGES` is issued. An integration test asserts `pg_default_acl` holds no role-global row.                                                                                                                                                                                   |
| Broken allowlist precedence                           | Precedence is a single unconditional early return, covered by unit and live-database tests including the both-lists case.                                                                                                                                                                                     |
| Migration partial failure                             | Each migration and its history row share one transaction. A failed migration leaves no row, so a re-run resumes from the last success.                                                                                                                                                                        |
| Concurrent installs                                   | Session advisory lock; the second run fails fast instead of interleaving DDL.                                                                                                                                                                                                                                 |
| Credential leakage in logs                            | Connection strings never printed — only `host:port/database` via `describeConnectionTarget()`. Asserted in tests for both `install` and `status`.                                                                                                                                                             |
| Elevated function privileges                          | No `SECURITY DEFINER`; every function pins `search_path = ''`.                                                                                                                                                                                                                                                |
