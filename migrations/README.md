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

| File                                      | Creates                                                 |
| ----------------------------------------- | ------------------------------------------------------- |
| `001_create_domain_functions.sql`         | `guard.normalize_domain()`                              |
| `002_create_domain_tables.sql`            | `guard.blocked_domains`, `guard.allowed_domains`        |
| `003_create_metadata_tables.sql`          | `guard.sync_metadata`                                   |
| `004_create_lookup_functions.sql`         | `guard.is_*_domain()` lookups                           |
| `005_permissions.sql`                     | privilege revokes for `PUBLIC`, `anon`, `authenticated` |
| `006_create_before_user_created_hook.sql` | `guard.before_user_created()` auth hook                 |
| `007_auth_hook_permissions.sql`           | `supabase_auth_admin` grants for the hook               |
| `008_create_strict_trigger_function.sql`  | `guard.enforce_auth_user_email()` (function only)       |

`normalize_domain()` must exist before 002, because the tables' `CHECK` constraints
call it. The lookups in 004 need the tables. The revokes in 005 use
`... ON ALL TABLES/FUNCTIONS IN SCHEMA`, which only affect objects that already exist,
so 005 had to run last at the time it was written.

006 needs `guard.is_disposable_domain()` from 004, because the hook delegates its whole
policy decision to it. 007 needs the function 006 creates, because it grants `EXECUTE`
on it by signature.

008 needs `guard.is_disposable_domain()` from 004 for the same reason 006 does: the
strict trigger function delegates its entire policy decision to it.

**008 creates a function and no trigger, on purpose.** The trigger that would attach it
to `auth.users` is created only by `supabase-anti-disposable-auth strict enable`, never
by a migration. `install` must never switch on a fail-closed enforcement point against a
Supabase-managed table as a side effect of applying schema changes, so the database is
allowed to hold a fully installed, fully inert strict layer — which is the default and
supported state. See [Strict database enforcement](../docs/strict-mode.md).

**006 and 007 are two files rather than one on purpose.** 006 is portable DDL that runs
identically on any PostgreSQL server. 007 is entirely conditional on the Supabase role
`supabase_auth_admin` existing, and is honestly a no-op on a plain PostgreSQL
development database. Splitting them keeps "what the hook is" separable from "who may
call it" — the second is the part most likely to change as Supabase's roles evolve.

## Conditional migrations are applied once, condition and all

`005_permissions.sql` and `007_auth_hook_permissions.sql` guard their Supabase-role
statements with `if exists (select 1 from pg_catalog.pg_roles where rolname = '...')`,
because those roles do not exist on a plain PostgreSQL server and an unguarded `GRANT`
would make `install` fail there.

**A migration that took its no-op branch is still applied.** It ran to completion, so it
is recorded in `guard.schema_migrations` like any other, and the runner will never
replay it. The condition is evaluated once, at application time — it is not a standing
rule that re-fires when the role later appears.

The concrete consequence, which is documented rather than engineered around:

- If `007_auth_hook_permissions.sql` was applied while `supabase_auth_admin` did not
  exist, **creating the role later does not cause the grants to appear.**
- `install` will **not** replay 007. Never replaying an applied migration is what makes
  `install` safe to run repeatedly, and is not traded away for this case.
- `status` catches it: it probes each required privilege with `has_*_privilege()`
  against the live catalog instead of trusting the history, names what is missing, and
  exits non-zero.
- The remediation is `supabase-anti-disposable-auth repair`, previewed with
  `repair --dry-run`. It grants only the privileges 007 grants and touches no history.

This is rare in practice — hosted Supabase and `supabase start` both provide
`supabase_auth_admin` long before this tool is installed.

**Rule 1 applies here with no exception:** do not edit an applied migration, and do not
delete its history row to force a replay. Both defeat the checksum audit. Use the
current-state `repair` command, which never writes migration history.

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

`006_create_before_user_created_hook.sql` is the first migration to exercise rule 8 in
anger, and it is worth noting why the rule is not optional there: the hook is the one
function in this schema whose whole purpose is to answer a policy question. Leaving it
`PUBLIC`-executable would turn it into a blocklist-enumeration oracle for anyone who
later acquires `USAGE` on `guard`.
