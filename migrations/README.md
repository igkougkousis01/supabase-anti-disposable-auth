# Migrations

Versioned SQL applied by `supabase-anti-disposable-auth install`. These files are the
single source of truth for everything this tool creates in PostgreSQL.

## Rules

1. **Never edit a file that has shipped.** The runner records a SHA-256 of each applied
   migration in `guard.schema_migrations` and re-checks it on every run. An edited file
   fails the run rather than being re-applied, because the database still reflects the
   original. Add a new migration instead.
2. **Never delete or rename an applied migration.** Both break the audit trail and are
   rejected.
3. **Filenames are `NNN_lower_snake_case.sql`** — exactly three digits, then a
   lowercase name. The number sets execution order and must be unique.
4. **New migrations get the next free number**, above the highest that has shipped. A
   file numbered below an already-applied migration is rejected, because it would run
   after migrations written on the assumption it did not exist.
5. **No `begin` / `commit` / `rollback`.** The runner wraps each file in its own
   transaction together with its history row, so either both land or neither does.
6. **Write idempotent DDL where PostgreSQL offers it** (`create table if not exists`,
   `create or replace function`). Migrations are not re-run once recorded, but idempotent
   statements make recovery from a half-finished manual intervention far easier.
7. **Never interpolate a value into a statement.** These files are static; anything
   value-shaped belongs in a parameterised query in TypeScript.
8. **If a migration creates a function, it must end with**
   `revoke all privileges on all functions in schema guard from public;`.
   PostgreSQL grants `EXECUTE` to `PUBLIC` on every new function, and
   `005_permissions.sql` cannot revoke it in advance — see
   [Why there is no default-privilege rule](#why-there-is-no-default-privilege-rule). An
   integration test asserts no function in `guard` is `PUBLIC`-executable, so a migration
   that forgets this fails the build.

## Ordering

The order below is forced by real dependencies, not preference:

| File                              | Creates                                                 |
| --------------------------------- | ------------------------------------------------------- |
| `001_create_domain_functions.sql` | `guard.normalize_domain()`                              |
| `002_create_domain_tables.sql`    | `guard.blocked_domains`, `guard.allowed_domains`        |
| `003_create_metadata_tables.sql`  | `guard.sync_metadata`                                   |
| `004_create_lookup_functions.sql` | `guard.is_*_domain()` lookups                           |
| `005_permissions.sql`             | privilege revokes for `PUBLIC`, `anon`, `authenticated` |

`normalize_domain()` must exist before 002, because the tables' `CHECK` constraints
call it. The lookups in 004 need the tables. The revokes in 005 use
`... ON ALL TABLES/FUNCTIONS IN SCHEMA`, which only affect objects that already exist,
so 005 must run last.

## Bootstrap infrastructure: `guard` and `guard.schema_migrations`

These two objects are created by the migration runner (`src/database/migrations.ts`)
**before any numbered migration executes**, from a constant
`create schema if not exists` / `create table if not exists` pair inside one
transaction. They are deliberately **not** represented by a `001_...` file, and
`guard.schema_migrations` contains no row describing its own creation. That absence is
expected.

Why it has to work this way:

- Applying a migration means executing it **and** recording it in
  `guard.schema_migrations` — atomically, in one transaction.
- Therefore the history table must already exist before the **first** numbered migration
  can be recorded.
- A hypothetical `001_create_guard_schema.sql` could not record itself: at the instant it
  ran, the table it creates would not yet exist to hold its own row. The runner would
  need to special-case migration `001` and apply it differently from every other
  migration.

Keeping the bootstrap outside the numbered set means **every** numbered migration goes
through one code path, with the same transaction handling and the same checksum
verification — no exceptions, and nothing that has to be trusted rather than checked.

The bootstrap statements are idempotent and carry no version, so running `install`
against an already-installed database is a no-op.

## Why there is no default-privilege rule

`005_permissions.sql` revokes `EXECUTE` from `PUBLIC` on the functions that exist when
it runs, but it does **not** try to protect future ones with
`ALTER DEFAULT PRIVILEGES`. Two reasons, both verified by integration tests:

1. **The schema-scoped form does nothing.**
   `ALTER DEFAULT PRIVILEGES IN SCHEMA guard REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`
   writes no row to `pg_default_acl` and changes no behaviour, because PostgreSQL's
   built-in `PUBLIC EXECUTE` default for functions is not represented there. The
   statement succeeds and is a silent no-op.
2. **`ALTER DEFAULT PRIVILEGES` is role-scoped, not schema-scoped.** It only affects
   objects created by the role whose defaults were altered — it is no guarantee for
   objects created by any other future owner. The role-global form does work, but it
   would change the defaults for every function that role creates in every schema,
   including `public`. This tool does not reach outside `guard`.

The real containment is the schema `USAGE` revoke: without `USAGE` on `guard`, a role
cannot call anything inside it whatever `EXECUTE` grants exist. Rule 8 above is the
required follow-up for any migration that adds a function.
