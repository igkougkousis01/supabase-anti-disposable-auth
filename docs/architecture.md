# Architecture

> **Status:** the CLI foundation, the `guard` schema, the database policy engine, manual
> blocklist synchronisation, the **Before User Created hook function** and **hosted hook
> activation through the Supabase Management API** all exist today. What does **not**
> exist is strict trigger mode and `pg_cron` scheduling. Everything marked **Planned**
> below is not implemented.
>
> Installing the hook function is still not the same as switching protection on. The two
> now have two separate commands (`install` and `hook enable`) and two separate lines in
> `status`, and neither is ever inferred from the other.

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
 ├── is_disposable_domain()
 └── before_user_created()
```

Blocklist data reaches that schema through the synchronisation pipeline:

```text
Remote provider
      ↓
Fetch                     HTTPS only, timeout, byte ceiling, content-type check
      ↓
Validate / normalise      parse, normalise, reject invalid, deduplicate, sort, checksum
      ↓
Safety checks             minimum count, valid-line ratio, maximum shrink
      ↓
Atomic DB replacement     staging table, one transaction, differential swap
      ↓
guard.blocked_domains
      ↓
guard.is_disposable_domain()
```

And that data is consulted at signup time through the auth hook:

```text
Remote blocklist
      ↓
Safe manual sync
      ↓
guard.blocked_domains
      ↓
guard.is_disposable_domain()          the one policy engine
      ↑
      │  delegates to
      │
guard.before_user_created(event)      installed by `install`
      ↑
      │  ⚠️ ONLY ACTIVE while Supabase Auth is configured
      │     to call this function
      │
Supabase Auth                         allow {} / reject {"error": {...}}
      ↑
      │  configured by
      │
Supabase Management API               GET / PATCH /v1/projects/{ref}/config/auth
      ↑
      │
CLI: hook enable / disable / status
```

The bottom half of that diagram carries the distinction the whole design turns on:

```text
The Management API CONFIGURES Auth.
It does NOT execute the policy.
```

`hook enable` sets one boolean and one URI on a hosted project. It is not on the signup
path, it is not consulted at runtime, and once it has run the CLI can be uninstalled
entirely without affecting a single signup decision. Enforcement lives in PostgreSQL;
the Management API is a configuration channel and nothing more.

The arrow from **Supabase Auth** upward is still not an object in PostgreSQL, so the
database can neither create it nor see it. What changed in this branch is that a
_second, separate_ system — the Management API — can now both set it and read it back,
which is why `status` needs two sets of credentials to report the whole picture and says
so honestly when it only has one:

```text
function installed        ≠        Auth Hook enabled
   (install does this)              (hook enable, the dashboard,
                                     or config.toml does this)
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

| Path                                | Responsibility                                                       |
| ----------------------------------- | -------------------------------------------------------------------- |
| `src/cli.ts`                        | Entry point, command registration, top-level error handling.         |
| `src/commands/`                     | One module per command.                                              |
| `src/config/env.ts`                 | The only place `process.env` is read; validated with Zod.            |
| `src/database/client.ts`            | `pg`-based connection with an explicit lifecycle.                    |
| `src/database/migrations.ts`        | Migration discovery, checksums, planning and execution.              |
| `src/database/schema-status.ts`     | Read-only inspection of the installed schema.                        |
| `src/database/transaction.ts`       | The single `begin`/`commit`/`rollback` helper.                       |
| `src/blocklist/`                    | The synchronisation pipeline — see section 5.                        |
| `src/supabase/constants.ts`         | API origin, endpoint path, hook URI, ref pattern — all compiled in.  |
| `src/supabase/management-client.ts` | The only authenticated network client. Two operations.               |
| `src/supabase/auth-config.ts`       | The pure activation state machine and its verification rules.        |
| `src/lib/errors.ts`                 | Configuration / database / sync / remote error kinds and exit codes. |
| `src/lib/logger.ts`                 | Minimal stdout/stderr logger.                                        |
| `src/lib/redact.ts`                 | Printable, secret-free descriptions of a database and a hook URI.    |

### 2. Supabase / PostgreSQL (implemented: connectivity only)

The CLI connects directly to the project database over `SUPABASE_DB_URL` using `pg`.
There is no ORM: the tool manages database infrastructure, so plain, parameterised SQL
is the correct level of abstraction. TLS behaviour is taken from the connection string
and is never relaxed by the tool.

The database layer is used by `doctor` (connect and read `server_version`), `install`
(apply migrations), `status` (read-only inspection) and `sync` (replace the blocklist).

### 3. `guard` schema (implemented)

Every object the tool creates lives in one dedicated schema, so installation and
removal are contained and auditable. Nothing is added to `auth`, `public`, or any
application schema, and `auth.users` is never touched.

| Object                       | Purpose                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `schema_migrations`          | Applied migration versions, names and checksums. Bootstrap infrastructure — created by the runner, not by a numbered migration. |
| `blocked_domains`            | Disposable domains. Primary key is the normalised domain.                                                                       |
| `allowed_domains`            | Overrides for false positives.                                                                                                  |
| `sync_metadata`              | Per-source sync state, written by `sync`. One row per provider.                                                                 |
| `normalize_domain(text)`     | Domain extraction and canonicalisation.                                                                                         |
| `is_blocked_domain(text)`    | Blocklist membership.                                                                                                           |
| `is_allowed_domain(text)`    | Allowlist membership.                                                                                                           |
| `is_disposable_domain(text)` | The policy answer, with allowlist precedence.                                                                                   |
| `before_user_created(jsonb)` | The Supabase auth hook. Extracts an email and delegates; owns no policy of its own.                                             |

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
- `supabase_auth_admin` is granted exactly the `SECURITY INVOKER` call chain the hook
  needs, and nothing else:

  | Grant                                           | Why                               |
  | ----------------------------------------------- | --------------------------------- |
  | `USAGE` on schema `guard`                       | reach anything at all             |
  | `EXECUTE` on `guard.before_user_created(jsonb)` | the hook itself                   |
  | `EXECUTE` on `guard.is_disposable_domain(text)` | the policy engine it delegates to |
  | `EXECUTE` on `guard.normalize_domain(text)`     | called by that engine             |
  | `SELECT` on `guard.blocked_domains`             | the lookup                        |
  | `SELECT` on `guard.allowed_domains`             | the lookup                        |

  Deliberately **not** granted: `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE` or `REFERENCES`
  anywhere; `CREATE` on the schema; anything on `sync_metadata` or `schema_migrations`;
  and `EXECUTE` on `is_blocked_domain()` / `is_allowed_domain()`, which the hook never
  calls. A write grant here would let a compromised auth service allowlist a domain and
  walk straight through its own filter.

  The `SELECT` grants name the two tables individually rather than using
  `ON ALL TABLES IN SCHEMA guard`, which would also hand over `sync_metadata` and would
  silently widen itself every time a future migration adds a table.

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

### 4. Auth Hook (function implemented; activation manual)

Supabase's **Before User Created** hook lets a PostgreSQL function inspect a signup
before the user row is created. `guard.before_user_created(jsonb)` is that function.
This is the primary enforcement path: it covers every signup route into the project and
produces a clean error for the client.

#### Invocation contract

Verified against `supabase/auth` (`internal/hooks/hookspgfunc`, `internal/hooks/
hookserrors`, `internal/hooks/v0hooks`) and the Supabase CLI's own generated
`config.toml`, not against secondary examples:

```sql
guard.before_user_created(event jsonb) returns jsonb
```

Supabase Auth executes, literally:

```sql
set local statement_timeout to '2000';
select "guard"."before_user_created"($1);
```

inside **the same transaction that would create the user**. Three consequences follow,
and the implementation depends on all three:

1. Anything the function raises aborts the signup transaction, so the user is not
   created. Raising is therefore already fail-closed — but it hands the client a raw
   database error, which is why the policy call is wrapped instead.
2. The 2-second `statement_timeout` raises `query_canceled` (57014), which PL/pgSQL's
   `when others` deliberately does **not** catch. A slow hook is cancelled and the
   signup fails closed, with no timeout logic in this codebase.
3. A caught exception must roll back cleanly or it poisons the outer transaction. The
   handler sits in a nested block, so PL/pgSQL wraps it in a subtransaction and the
   clean error response still reaches the client.

#### Response contract

| Decision | Response                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------- |
| Allow    | `{}`                                                                                                 |
| Reject   | `{"error": {"http_code": 403, "message": "Disposable email addresses are not allowed."}}`            |
| Failure  | `{"error": {"http_code": 503, "message": "Signup could not be validated. Please try again later."}}` |

Two details of the GoTrue contract are load-bearing:

- **`message` must be non-empty.** `hookserrors.check()` returns `nil` — meaning "no
  error", meaning **allow** — when the message is blank. An error object with an empty
  message would silently disable the entire filter. Both rejection responses are
  compile-time string literals, so this cannot happen by construction, and an
  integration test asserts it.
- **`http_code` is passed through verbatim**, defaulting to 500 when absent. The code is
  this tool's choice, not a fixed enum.

**Why 403 and not 400.** Supabase Auth already returns 400 for its own validation
failures — malformed address, weak password, user already registered. Reusing it would
make a policy rejection indistinguishable from a malformed request for any client trying
to render a useful message. 403 says the request was understood and refused, which is
what happened. Supabase's own documentation example uses 400; this is a deliberate,
compatible divergence, since the field is free-form.

**Why 503 for engine failure.** A policy rejection and an unavailable policy engine are
different events. A client, a log line and an alert should all be able to tell them
apart, and 500 is what GoTrue itself returns for its own internal errors.

#### Decision table

| Input                                     | Result       | Reason                              |
| ----------------------------------------- | ------------ | ----------------------------------- |
| Non-disposable email                      | allow        | policy                              |
| Disposable email                          | reject 403   | policy                              |
| Disposable **and** allowlisted            | allow        | allowlist precedence, in the engine |
| Unknown domain                            | allow        | policy                              |
| Absent / `null` / `""` / whitespace email | allow        | nothing to judge                    |
| Non-string email (`123`, `true`, `[]`)    | reject 503   | malformed hook payload              |
| `event` not a JSON object, or SQL `NULL`  | reject 503   | structural corruption               |
| Policy engine raises                      | reject 503   | fail closed                         |
| Hook exceeds 2 s                          | signup fails | GoTrue cancels the statement        |

#### One policy engine

The hook contains **no lookup logic**. It extracts an address and calls
`guard.is_disposable_domain()`, which owns normalisation and allowlist precedence. If
the hook duplicated either, the two could drift and the allowlist could stop working on
the one path that matters. An integration test compares the hook's verdict against the
engine's across a corpus of inputs, so a divergence fails the build.

#### Missing email: a deliberate fail-open

Supabase serialises a user's email as a Go `NullString`, so a phone-only or anonymous
signup arrives as `"email": ""` — not as an absent key, and not as JSON `null`. Those
signups are **allowed**.

This is a fail-open for the **absence of an email**, and it is the opposite of the
decision taken for engine failure a few lines down. The two cases are distinguished
carefully throughout the implementation:

```text
"there is no email to check"   ->  allow    (a supported signup flow)
"the check did not work"       ->  reject   (a security control that failed)
```

Blocking email-less signups would mean a disposable-**email** filter silently disabling
phone and anonymous auth — a far worse failure than the one it prevents. This tool
enforces policy only where an email exists; phone-only and anonymous flows are outside
its scope.

#### Malformed events

The line between "corrupt" and "no email" is drawn at the **outermost structure only**:

- `NULL`, a JSON scalar, or a JSON array → **reject**. GoTrue always sends an object, so
  anything else means the function is not being called under the contract it was written
  for — a hook wired to the wrong extensibility point, or a caller that is not Supabase
  Auth. A hook that cannot confirm who is asking must not hand out approvals.
- `{}`, `{"user": null}`, `{"user": {}}`, `{"user": {"email": null}}` → **allow**. These
  are well-formed objects that simply carry no email.

No unchecked casts: `->` and `->>` return `NULL` rather than raising for a missing key
or a non-object parent, and the email's JSON type is resolved with `jsonb_typeof()`
before `->>` is used. Without that check, `"email": 12345` would be coerced to the text
`'12345'` and fed to the policy engine as though it were an address.

#### Malformed email type: a separate verdict from "no email"

The type gate is not the structural gate, and its answer is not the absent-email
answer. `user.email` is judged on its JSON type:

| `jsonb_typeof(event -> 'user' -> 'email')`        | Verdict        |
| ------------------------------------------------- | -------------- |
| `NULL` (key absent, or no object parent)          | allow          |
| `'null'`                                          | allow          |
| `'string'`                                        | policy decides |
| `'number'` / `'boolean'` / `'array'` / `'object'` | reject 503     |

**Why absent, `null` and `""` allow but a non-string does not.** Supabase legitimately
represents non-email flows with an empty or `null` email: GoTrue serialises the
candidate address from a Go `NullString`, so a phone-only or anonymous signup arrives
with the field present and empty. That payload is under the contract and carries nothing
to judge.

A non-string value is not under the contract. `user.email` is a Go string field, and no
GoTrue release serialises it as a number, boolean, array or object. Receiving one means
the payload did not come from the hook contract this function implements — the same
class of event as a non-object `event`, and answered the same way. The hook cannot know
what it is being asked, so it does not approve.

Reading a non-string as "no usable email, therefore allow" is the failure this rule
exists to prevent: `{"user": {"email": ["person@mailinator.com"]}}` would pass a
disposable-email filter that never looked at an address, silently.

**One response for every unavailable-validation case.** Malformed payload, structural
corruption and engine failure all return the identical 503 literal. It names no field,
no type and no value, so a client cannot distinguish them or probe the payload contract
through signup. The offending JSON **type** — never the value — is written to the
PostgreSQL server log with `RAISE LOG`, which the client never receives.

#### Fail closed on infrastructure failure

If `guard.is_disposable_domain()` raises — dropped table, revoked privilege,
half-removed installation — the hook **rejects** with the 503 response.

A policy engine that cannot answer has not said "allow"; it has said nothing. Treating
silence as approval would mean one revoked privilege quietly disabling the whole filter
while every signup keeps succeeding — the failure nobody notices until the disposable
accounts arrive.

The handler is scoped to the single policy statement rather than wrapped around the
whole body, for two reasons:

- **Intent.** It exists for policy-_engine_ failure, not as a catch-all that would hide
  bugs in the extraction above it.
- **Cost.** A block with an exception handler establishes a subtransaction each time it
  is entered. Scoping it here means email-less signups, which return earlier, never pay
  for one — measurably ~30× cheaper on that path.

Diagnostics are preserved without leaking: `RAISE LOG` writes the real `SQLSTATE` and
message to the **PostgreSQL server log**, and `LOG` sits above the default
`client_min_messages`, so the caller never receives it. The candidate address is
deliberately not logged — it is unverified user input, and this is not an audit trail.

#### SECURITY INVOKER, and why not DEFINER

The hook is `SECURITY INVOKER`. It runs with exactly the privileges of
`supabase_auth_admin` and borrows nothing, which is why that role needs the whole call
chain rather than one `EXECUTE` — see [Privileges](#privileges).

`SECURITY DEFINER` would reduce the grants to schema `USAGE` plus one `EXECUTE`. It was
considered and refused:

- The two `SELECT`s it saves are read-only access to a public disposable-domain list and
  an operator allowlist. Neither holds a secret.
- The one thing a client must not learn — whether a given domain is blocked — is
  obtainable by anyone who can call the hook in **either** mode, so DEFINER would not
  actually close that channel.
- In exchange, it would execute as the schema owner (`postgres` on Supabase) on a
  payload supplied by an external system, on the signup hot path. That is a real
  privilege boundary being crossed to avoid two read grants on non-secret tables.

"Make the permissions work" is not a justification for `SECURITY DEFINER`, and it is the
only one available here. The `guard` schema therefore remains entirely free of
`SECURITY DEFINER`, which an integration test asserts.

#### Side-effect free

Invoking the hook modifies no blocked domain, no allowed domain, no sync metadata and no
`auth.users` row; it creates nothing, takes no lock and calls no remote service. An
integration test snapshots every table and re-checks it after exercising every branch —
allow, reject, allowlist override, no email, absent user, structural corruption and
malformed email type — including outside a transaction where a write could not be
hidden by a rollback.

#### Performance

The hot path is: extract → normalise → allowlist primary-key lookup → blocklist
primary-key lookup → return. No HTTP, no DNS, no table scan, no logging table, no
additional index.

Measured locally on PostgreSQL 14 with 75,001 blocked domains, executing as
`supabase_auth_admin`:

| Path                    | Per call |
| ----------------------- | -------- |
| Allow (non-disposable)  | ~40 µs   |
| Reject (disposable)     | ~41 µs   |
| No email (early return) | ~1.3 µs  |

`EXPLAIN` confirms an `Index Only Scan using blocked_domains_pkey` (4 buffer hits) on
the same dataset. Against Supabase's 2-second budget this is roughly 0.002%. No new
index was added: the primary key already serves every lookup optimally.

#### Conditional grants and the role that arrives late

`007_auth_hook_permissions.sql` wraps every `GRANT` in
`if exists (select 1 from pg_catalog.pg_roles where rolname = 'supabase_auth_admin')`.
The guard is not optional: the role does not exist on a plain PostgreSQL server, and an
unguarded `GRANT` would make `install` fail there. Combined with the runner's rule that
**applied migrations are never replayed**, that produces one edge case, and it is
documented here rather than engineered around.

**The case.** 007 runs on a database without `supabase_auth_admin`. It takes its no-op
branch, completes successfully, and is recorded in `guard.schema_migrations` —
correctly, because it did run. The role is created afterwards. **The grants do not
appear.** Nothing re-evaluates that `if exists`: a `GRANT` writes an ACL entry, it does
not install a rule that fires when a matching role shows up later. And `install` will
not re-run 007, because re-running recorded migrations is precisely the property that
makes `install` safe to run repeatedly.

The result is a database where the hook function exists, the role exists, and the role
cannot execute the hook.

**Why not detect and re-run 007.** Replaying a recorded migration on a role-existence
condition would mean the runner deciding, per migration, whether a previous application
"counted". That is a different execution model from the one the checksum audit is built
on — every file applied exactly once, verifiable afterwards — and adopting it for one
conditional file would weaken the guarantee for all of them. A general privilege-repair
subsystem is a real design question (what it may change, what it must refuse to change,
how it proves it did no harm) and is deliberately out of scope for this branch.

**What happens instead, in three parts:**

1. **`status` reports it.** Grants are probed with `has_*_privilege()` against the live
   catalog, never inferred from the migration history, so the gap is visible even though
   the history says 007 applied. Each missing privilege is named, the installation is
   `incomplete`, and the process exits non-zero — before activation, which is the point
   at which the gap would start rejecting every signup.
2. **`status` says `install` will not fix it,** and points at the documented
   remediation rather than at a command that would report "up to date" and change
   nothing.
3. **The remediation is one idempotent, role-guarded snippet** in the README
   ([Repairing the auth hook grants](../README.md#repairing-the-auth-hook-grants)). It
   grants exactly the six privileges 007 grants — the `SECURITY INVOKER` call chain and
   nothing wider — is safe to run repeatedly and on a server without the role, and
   touches no migration history. Dropping the `guard` schema and reinstalling is the
   supported alternative.

**Editing `guard.schema_migrations` or re-running a historical migration file by hand is
not a supported remediation and is documented as such.** Deleting a history row to force
a replay defeats the checksum audit the runner exists to provide, and applying old DDL
by hand can land it out of order relative to migrations written after it.

**How likely this is.** Uncommon. Both hosted Supabase projects and `supabase start`
provision `supabase_auth_admin` as part of the platform, well before this tool is
installed, so a normal installation grants on its first run. The realistic paths in are
a plain PostgreSQL database that later gained Supabase roles, a restore into a cluster
whose roles were not restored with it, and development scratch databases.

#### Activation is separate from installation

`install` creates the function and the grants. It does **not** register the hook with
Supabase Auth, and it does not edit a user's `config.toml`. Activation is its own
command group (`hook enable` / `hook disable` / `hook status`, section 7), and the
separation is deliberate rather than incidental:

- **Different blast radius.** `install` writes to a database the operator already handed
  us credentials for. `hook enable` reconfigures live authentication for a whole project.
- **Different credentials.** Migrations need `SUPABASE_DB_URL`; activation needs a
  Management API token, which is a far more powerful secret.
- **Different lifecycle.** Activation is toggled, inspected and reversed independently
  of schema version.

Because activation lives in the Auth service rather than in PostgreSQL, `status` cannot
observe it from the database. It now observes it from the Management API instead, when
credentials are available — and reports **not checked** when they are not. It is never
inferred from the presence of the function.

#### Removal ordering

Removing the hook has a required order:

1. **Disable the Auth Hook first** — `hook disable`, or the dashboard, or removing the
   `config.toml` block on a local stack.
2. **Then** drop the function and revoke the grants.

Reversed, Supabase Auth keeps calling a function that no longer exists and **every
signup fails** until the configuration catches up.

This ordering is why `hook disable` performs no database preflight and requires no
database credentials at all. The step that stops the bleeding must work when the database
does not — an operator whose database is unreachable is in exactly the situation where
the fail-closed hook is rejecting every signup, and needing a working database connection
to switch it off would be a trap.

### 5. Blocklist lookup (implemented)

`guard.is_disposable_domain()` is the single policy engine. It is called by the auth
hook, and can be called directly by an operator inspecting policy. Its behaviour is
unchanged by this branch — the hook was built around it rather than the other way
round.

### 6. Blocklist synchronisation (implemented, manual only)

`sync` refreshes `guard.blocked_domains` from an upstream provider. It runs **only when
an operator runs it**. There is no scheduler, no `pg_cron` job, and no background
process — see [Manual only](#manual-only) below.

#### Pipeline

```text
Provider
   ↓
HTTP fetch          HTTPS only, timeout, byte ceiling, content-type allowlist
   ↓
Raw validation      binary/mis-encoded payloads refused
   ↓
Parse domains       one domain per line, line endings normalised
   ↓
Normalise           same contract as guard.normalize_domain()
   ↓
Reject invalid      counted, not fatal — the ratio is what judges the payload
   ↓
Deduplicate
   ↓
Sort deterministically
   ↓
Checksum            SHA-256 over the canonical representation
   ↓
Sanity checks       minimum count, valid-line ratio, maximum shrink
   ↓
Database staging    transaction-scoped temporary table
   ↓
Atomic replacement  differential delete/insert inside one transaction
   ↓
Metadata update     guard.sync_metadata
```

| Module                                                | Responsibility                                        |
| ----------------------------------------------------- | ----------------------------------------------------- |
| `src/blocklist/types.ts`                              | `BlocklistProvider` and `RawBlocklist` contracts.     |
| `src/blocklist/provider.ts`                           | Provider registry and default selection.              |
| `src/blocklist/providers/disposable-email-domains.ts` | The one production provider.                          |
| `src/blocklist/fetch.ts`                              | The only network access in the project.               |
| `src/blocklist/parse.ts`                              | Payload to canonical domain set.                      |
| `src/blocklist/normalize.ts`                          | TypeScript mirror of `guard.normalize_domain()`.      |
| `src/blocklist/validate.ts`                           | Domain-shape gate and offline domain validation.      |
| `src/blocklist/checksum.ts`                           | Canonicalisation and SHA-256 fingerprint.             |
| `src/blocklist/safety.ts`                             | Suspicious-update thresholds.                         |
| `src/blocklist/repository.ts`                         | Staging, atomic replacement, metadata, advisory lock. |
| `src/blocklist/sync.ts`                               | Orchestration, no-op detection, dry run.              |

#### Provider

One provider exists: **`disposable/disposable-email-domains`**
(<https://github.com/disposable/disposable-email-domains>), read from its plain-text raw
endpoint:

```text
https://raw.githubusercontent.com/disposable/disposable-email-domains/master/domains.txt
```

It is a stable data URL, not a rendered page, so nothing here parses HTML and a redesign
of GitHub's UI cannot break or poison this tool. It needs no authentication, so the CLI
requires no GitHub token and there is no credential to leak. It serves `text/plain`,
which is what lets the fetch layer reject an HTML error page outright.

Pinning to `master` rather than a commit is deliberate: the point of sync is to track
upstream. The risk that creates — a compromised or truncated upstream — is answered by
the safety thresholds, not by pinning.

A registry exists so a second provider is a new file plus one line. There is
deliberately **no way to supply an arbitrary URL**: a caller-supplied URL would make
this CLI an SSRF primitive running with database credentials in its environment.

#### Network safety

| Control      | Value              | Why                                                                                             |
| ------------ | ------------------ | ----------------------------------------------------------------------------------------------- |
| Scheme       | HTTPS only         | A plaintext hop would let anyone on the path replace the blocklist wholesale.                   |
| Redirects    | manual, max 3 hops | Each target is re-checked for HTTPS. `redirect: 'follow'` would delegate that decision away.    |
| Timeout      | 15 s               | Covers the body, not just the headers. A ~1 MB file completes in well under a second.           |
| Maximum size | 8 MiB, streamed    | Upstream is ~1.1 MB, so ~7x headroom. `Content-Length` is a claim, so the cap is on real bytes. |
| Content type | `text/plain` only  | Turns "HTTP 200 with an HTML error page" into a clean failure instead of a corrupted blocklist. |
| Retries      | none               | One failed fetch does not trigger a retry loop; the operator reruns the command.                |

The response body is data. It is never executed, never evaluated, never written to disk,
and never passed to a shell.

#### Normalisation and validation

The ingestion order is a trust boundary, not an implementation detail:

```text
provider row -> validate domain-shaped -> normalise -> validate domain
```

**The shape gate runs first and is not recoverable from.** `guard.normalize_domain()`
deliberately extracts a domain from an email address — `user@mailinator.com` becomes
`mailinator.com` — which is correct for the authentication input it will eventually
see. A provider payload has the opposite contract: it is a list of **domain rows**. An
address, a URL, a path or a `mailto:` URI appearing there is evidence that the feed is
not what we think it is, and salvaging a domain out of it would convert a corrupted or
substituted payload into blocklist entries that look perfectly legitimate.

So `normalizeProviderDomain()` — the only normalisation entry point the pipeline may
use — rejects anything that is not already a bare domain before normalisation runs:

```text
'mailinator.com'          -> 'mailinator.com'
'MAILINATOR.COM'          -> 'mailinator.com'
'mailinator.com.'         -> 'mailinator.com'   (trailing dots stripped)
'user@mailinator.com'     -> rejected
'@mailinator.com'         -> rejected
'https://mailinator.com'  -> rejected
'mailinator.com/path'     -> rejected
```

The gate is a character **allowlist** (`A-Za-z0-9.-`), so `@`, `/`, `:`, `?`, `#`,
whitespace, control characters and non-ASCII are all refused by one rule, and a
character nobody anticipated is rejected by default rather than admitted by default.

Rejected rows are counted, and the valid-line ratio decides what that means. An upstream
that started emitting addresses would therefore **fail the sync** rather than have its
new format silently absorbed — which is the intended outcome: a format change is
something an operator must see.

`src/blocklist/normalize.ts` also exports `normalizeDomain()`, a **performance mirror**
of `guard.normalize_domain()` that keeps the address-extraction behaviour. It exists so
a 75,000-entry list can be canonicalised in process instead of with one round trip per
domain, and it is what the parity test compares against PostgreSQL. It is never called
directly by the pipeline.

The asymmetry that governs its design: accepting something PostgreSQL would reject
violates the `CHECK` constraint and **aborts the whole sync transaction**; rejecting
something PostgreSQL would accept merely drops one domain. Where a judgement call
exists, the TypeScript side errs towards rejecting — which is why it trims only ASCII
whitespace rather than using `String.trim()`, whose Unicode behaviour may be wider than
PostgreSQL's locale-dependent `[[:space:]]`.

An integration test asserts both implementations agree over a corpus, so they cannot
drift apart silently, and a second pair of tests pins the deliberate divergence: the
PostgreSQL function must keep extracting `mailinator.com` from `user@mailinator.com`,
while the provider path must keep rejecting it. Neither can be "harmonised" into the
other by a later refactor without failing the build.

A punycode **label** (`xn--80ak6aa92e.com`) is accepted; a punycode **TLD**
(`example.xn--p1ai`) is not, because the PostgreSQL pattern requires an alphabetic
final label. That is a real limitation, and matching PostgreSQL exactly matters more
than accepting a few more domains.

No DNS query is made and no per-domain I/O happens. Validation is local and cheap.

#### Checksum

SHA-256 over a canonical representation: the sorted, deduplicated domains joined with
`\n`, with a trailing newline. Sorting uses explicit code-unit comparison, never
`localeCompare`, so the fingerprint cannot depend on the machine's locale.

The checksum therefore depends on the **set** of domains and nothing else. The same
logical dataset in a different upstream line order, or with duplicates, produces the
same checksum — which is exactly what makes no-op detection trustworthy.

#### Suspicious-update protection

A remote source is not trusted blindly. Before anything is replaced, the candidate must
pass three thresholds:

| Threshold            | Default | Why this value                                                                                                                                          |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Minimum domain count | 1,000   | Upstream carries ~75,000 entries. 1,000 is orders of magnitude below any plausible real list, and far above what a truncated download or stub produces. |
| Minimum valid ratio  | 0.8     | A real domain list scores ~1.0; HTML, JSON or a README scores near zero. A wide gutter, not a tuned value.                                              |
| Maximum shrink       | 0.3     | Upstream lists churn by low single-digit percentages. A third vanishing at once is damage, not curation.                                                |

Example rejection:

```text
Suspicious blocklist update rejected: the candidate contains 40 domains, below the
minimum of 1,000; the candidate would remove 99.6% of the installed list (10,000 to 40
domains), more than the 30.0% limit
Current domains: 10,000. Candidate domains: 40. The installed blocklist was left
unchanged.
```

**There is deliberately no override flag.** A `--force` would be reached for precisely
when it is most dangerous — during an incident, under time pressure, by someone who
wants the command to stop complaining.

##### First sync

The percentage-drop check has no denominator when `guard.blocked_domains` is empty, so
it is **skipped** on a first sync; the absolute minimum and the validity ratio carry the
weight alone. This is a genuine reduction in protection and is stated as such: the first
sync is the one moment the tool cannot tell a good list from a plausible bad one by
comparison. Every subsequent sync can. The CLI says so in its output.

#### Atomic replacement

```text
BEGIN
  create temporary table blocklist_sync_staging (...) on commit drop
  populate it in batches with unnest($1::text[])
  validate the staged count against the candidate
  delete rows not in staging
  insert rows not already present
  stamp the provider source on every row
  write guard.sync_metadata
COMMIT
```

- `guard.blocked_domains` is **never dropped or recreated**, so grants, constraints, the
  primary key and object identity survive untouched. An integration test asserts the
  table's OID is unchanged across a sync.
- The swap is **differential**, so an unchanged row keeps its original `created_at`.
- Everything shares **one transaction**. Readers see the old list until it commits, and
  any failure rolls the whole thing back.
- `guard.allowed_domains` is **never written to**. See [Allowlist
  semantics](#allowlist-semantics).
- Insertion is bulk: 5,000 domains per `unnest($1::text[])` round trip, so a 75,000-entry
  list is about fifteen statements rather than 75,000. Nothing is ever built by string
  concatenation — the array is a bound parameter.

#### Allowlist semantics

Synchronisation never modifies `guard.allowed_domains`. The upstream list controls
`guard.blocked_domains` and nothing else.

A domain present on both lists **stays on both**. Sync does not resolve the conflict by
deleting allowlisted entries from the blocklist, because raw upstream membership and an
operator's policy override are two separate facts and collapsing them loses information:
if the operator later removes the allowlist entry, the blocklist entry should still be
there. Precedence is resolved at lookup time by `guard.is_disposable_domain()`, which
checks the allowlist first.

Manual blocklist entries are **not** preserved: sync replaces the blocklist in full, so
a hand-inserted row that upstream does not carry is removed. The allowlist is the
supported mechanism for durable operator policy.

#### `guard.sync_metadata`

One row per source, written by `sync` and by nothing else.

| Outcome | `status`  | `last_attempt_at` | `last_success_at` | `domain_count` / `checksum` | `error_message` |
| ------- | --------- | ----------------- | ----------------- | --------------------------- | --------------- |
| Success | `success` | now               | now               | candidate values            | `NULL`          |
| No-op   | `success` | now               | now               | unchanged                   | `NULL`          |
| Failure | `failed`  | now               | **unchanged**     | **unchanged**               | the reason      |
| Dry run | —         | —                 | —                 | —                           | —               |

Three decisions worth stating explicitly:

**A failure never overwrites the last known-good values.** `last_success_at`,
`domain_count` and `checksum` describe the data that is actually installed, which a
failed attempt did not change. Overwriting them with candidate values would make the
metadata describe a list that was never applied, and would break no-op detection on the
next run.

**The failure record is written outside the failed transaction.** It runs after the
replacement transaction has rolled back. Writing it inside would roll the failure record
back along with everything else, leaving no trace of what happened. It is best-effort: if
the failure was the database itself, this write fails too, and the original error is the
one reported.

**A no-op advances `last_success_at`.** That answers "when did we last confirm the
installed blocklist matches upstream?", which is the question staleness monitoring
actually asks. If it only moved when content changed, a list upstream had not touched
for two months would look two months stale and every alert would be false. Whether the
_data_ changed is what `checksum` is for; `last_success_at` is about whether the _check_
happened.

#### No-op sync

If the candidate checksum matches the recorded checksum **and** the live row count
matches the recorded count, the run is a no-op: no blocklist row is written, no
transaction is opened, and only the metadata timestamps move.

Both conditions are required. The checksum alone is not enough — if someone emptied
`guard.blocked_domains` by hand, the metadata would still hold the last sync's
fingerprint, and trusting it would leave the database permanently unprotected while
`sync` cheerfully reported "already up to date".

#### Concurrent sync

A session-level `pg_try_advisory_lock` (key `7233492005`, distinct from the migration
runner's `7233492004`, so `install` and `sync` never block each other). The second sync
**fails fast** rather than waiting: a bounded wait is still a wait, and sync is
idempotent, so re-running after the other finishes costs nothing. The lock is
session-scoped, so closing the connection releases it even if the process is killed —
there is no stale lock to clean up.

A dry run takes **no** lock, because it writes nothing and holding the lock would let a
read-only preview block a real sync.

#### Dry run

`sync --dry-run` fetches, parses, normalises, validates, deduplicates, checksums and
runs the safety checks against live database state, then reports what would change. It
shares the same code path up to the point of replacement, so what it reports is what a
real run would do rather than a separate implementation that could drift.

It **mutates nothing** — no blocklist rows, no metadata, not even a temporary table. It
computes the added/removed diff in process from a plain `SELECT` instead of staging.

#### Manual only

**`pg_cron` scheduling is NOT implemented.** **The Supabase Auth Hook is NOT
implemented.** Sync happens when an operator runs the command, and the blocklist it
maintains is still not consulted during signup.

### 7. Hook activation (implemented, hosted projects)

The `hook` command group configures a **hosted** project's Supabase Auth so that it calls
`guard.before_user_created()`. It is the only part of this tool that makes an
authenticated network request, and the only part that can change anything outside the
operator's database.

#### Scope

Exactly two fields of the Auth configuration document:

```text
hook_before_user_created_enabled
hook_before_user_created_uri
```

Verified against the published OpenAPI document at `https://api.supabase.com/api/v1-json`:
both are declared on `AuthConfigResponse` **and** on `UpdateAuthConfigBody`, both are
`nullable`, and every field of the update body is optional — which is what makes a
two-field PATCH a supported operation rather than a hopeful one.

`GET /v1/projects/{ref}/config/auth` requires Auth-configuration read access
(`auth:read` / `auth_config_read`); `PATCH` requires write access (`auth:write` /
`auth_config_write`, plus `project_admin_write`). Authentication is HTTP bearer.

A third field, `hook_before_user_created_secrets`, exists for HTTP-backed hooks. This
tool never reads it, never sends it, and never prints it: it may hold a webhook signing
secret, and a Postgres hook has no use for one.

**Nothing else in the Auth configuration is owned, managed, read out or reported on.**

#### Layering

```text
src/config/env.ts            SUPABASE_PROJECT_REF, SUPABASE_ACCESS_TOKEN
        ↓                    validated centrally, required per command
src/supabase/constants.ts    origin, path, hook URI, ref pattern — compiled in
        ↓
management-client.ts         transport: HTTPS, timeout, byte ceiling, status mapping
        ↓
auth-config.ts               pure state machine: what to write, and what proves it
        ↓
commands/hook.ts             orchestration, preflight, output, exit codes
```

The middle two layers are the interesting ones. `management-client.ts` knows about HTTP
and knows nothing about hooks; `auth-config.ts` knows about hooks and touches no network,
no clock and no database. That split is what makes the decision logic exhaustively
testable — every combination of `enabled` and `uri` is a pure function call.

#### The compiled-in destination

The API origin is a constant, not a setting. There is no flag, environment variable or
config file that redirects it, and there should never be one: a settable API origin turns
a CLI holding a Management API token into a credential-exfiltration primitive. This is
the same reasoning that keeps the blocklist provider list compiled in — see
[SSRF via a caller-supplied URL](#synchronisation-threat-model) — except that here the
request carries a credential, so the stakes are higher rather than lower.

Tests inject a base URL through `ManagementClientOptions`, which is dependency injection
and not a user-facing option. It is still required to be HTTPS, so no test can normalise
a plaintext habit into the suite.

#### Transport safety

The same controls as `blocklist/fetch.ts`, plus one:

| Control               | Why                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTPS only            | Enforced on the base URL before a token is ever attached to it.                                                                                                                 |
| **No redirects**      | `redirect: 'manual'`, and a 3xx is an error. Following one would carry the `Authorization` header to whatever host `Location` names.                                            |
| Request timeout       | 15 s. A foreground command must not hang, least of all after a PATCH has been sent.                                                                                             |
| Streamed byte ceiling | 2 MiB, applied to bytes received. `content-length` is a claim, not a fact.                                                                                                      |
| JSON content-type     | Catches a proxy or captive portal answering instead of Supabase.                                                                                                                |
| Tolerant schema       | Only the two fields are validated; unknown keys pass through. Supabase adds Auth settings regularly, and a strict schema would break every `hook` command the next time it did. |
| **No retries**        | A GET could be retried and a PATCH could not. Post-write verification, not a retry, is what protects against an ambiguous outcome.                                              |

#### The activation state machine

Pure, in `auth-config.ts`. The governing rule:

> **The hook slot holds exactly one URI.** Writing ours into an occupied slot does not add
> a policy, it silently replaces one — and the policy being replaced could be the only
> thing standing between that project and whatever it was written to stop.

| `enabled` | `uri`            | `enable`     | `disable`    |
| --------- | ---------------- | ------------ | ------------ |
| `false`   | none             | change       | no-op        |
| `false`   | ours             | change       | no-op        |
| `false`   | **another hook** | **conflict** | **conflict** |
| `true`    | ours             | no-op        | change       |
| `true`    | **another hook** | **conflict** | **conflict** |
| `true`    | none             | change       | no-op        |

Two rows deserve their own note.

**`false` + another hook → conflict.** A disabled foreign hook is configuration somebody
wrote down, in a paused state. Taking the slot because it happens to be switched off
destroys their ability to switch it back on, and they would find out at the worst possible
moment. There is no override flag.

**`true` + none → change, for `enable`.** Auth reports the hook as on with nothing to
call, which is a broken configuration rather than a competing one; pointing it at our
function is the repair.

#### Minimal PATCH

Enabling sends both fields. Disabling sends only `hook_before_user_created_enabled: false`
and **leaves the URI in place** — the least destructive change that achieves the goal,
supported because every field of the update body is optional. It also keeps the
configuration explicit: the project still records which function the hook points at,
re-enabling needs to re-derive nothing, and the dashboard shows what was disabled rather
than an empty field. "Turn it off" does not imply "forget what it was".

What is never done: read the whole document and write it back. That would rewrite every
unrelated Auth setting with values already stale by the time they were sent, including
secrets the API may return redacted — which would then be written back redacted. The type
of the patch parameter makes that mistake impossible to express.

#### Post-write verification

Every mutation is followed by a fresh GET, and success is claimed only when the state read
back is the state requested. HTTP 200 means the request was accepted, not that the
configuration says what was asked for; a partially applied update, a server-side
normalisation, a competing dashboard change, or a plan-tier rule that declines part of a
patch would all produce a 200 and a wrong project.

`enable` requires exactly: enabled, pointing at our URI. `disable` requires: not enabled,
and the slot still ours or empty — a slot that has become somebody else's between the two
calls is a verification failure, not a clean success.

#### Database preflight

`hook enable` proves the database can serve the hook **before a single byte reaches the
Management API**. It requires a complete guard layer, the hook function installed, and
every `supabase_auth_admin` grant held.

The reason is the hook's own design. `guard.before_user_created()` fails closed: if the
policy engine cannot answer, the signup is rejected. That is correct for a security
control, and it is exactly what makes premature activation dangerous — enabling the hook
against a broken guard layer does not weaken the filter, it rejects **every signup on the
project**.

`role-absent` is a preflight failure here, unlike in `status`. `status` runs anywhere and
must not fail a plain PostgreSQL server for lacking a Supabase role. But a project being
activated on `api.supabase.com` has `supabase_auth_admin`; not finding it means
`SUPABASE_DB_URL` points at a different database than `SUPABASE_PROJECT_REF` names, and
activating on the strength of a health check performed against the wrong database is
precisely the mistake the preflight exists to prevent.

An absent `SUPABASE_DB_URL` **refuses** rather than skipping the check. Inferring
"activate unverified" from an unset variable would make the dangerous path the default for
anyone who has not configured a database.

`--skip-db-check` is the explicit escape: opt-in, warned before mutation, warned
identically during a dry run, and documented as dangerous. It is not a `--force`; it does
not bypass the conflict refusal or the post-write verification, and tests assert both.

#### Health semantics

`status` combines both systems, and the combination has more states than either alone:

| Database   | Auth         | Verdict                                        | Exit |
| ---------- | ------------ | ---------------------------------------------- | ---- |
| healthy    | active       | active protection                              | `0`  |
| healthy    | disabled     | installed, protection inactive                 | `0`  |
| healthy    | another hook | conflict; not filtered by this tool            | `8`  |
| healthy    | not checked  | unknown; nothing claims protection             | `0`  |
| healthy    | check failed | unknown, reported honestly                     | `7`  |
| **broken** | **active**   | **dangerous — signups are being rejected now** | `5`  |
| broken     | not active   | broken, but signups still work                 | `5`  |

The sixth row is the one that earns the combination. A broken guard layer alone means
unprotected; a broken guard layer **while the hook is enabled** means the project is
rejecting every signup right now, and it is the only status combination whose fix is
measured in minutes. `status` prints an explicit DANGER notice for it and points at
`hook disable` as the fast mitigation.

## Planned optional features

These are opt-in and explicitly **not** part of the default install:

- **Strict trigger mode.** A PostgreSQL trigger enforcing the same rule at the table
  level, for defence in depth when a signup path bypasses the hook. Stricter, but harder
  to reason about and riskier to install; therefore optional.
- **`pg_cron` synchronisation.** Scheduling blocklist refreshes inside the database, so
  the list stays current without the CLI running. Requires the extension to be available
  and enabled in the project. Sync itself exists today, but only as a manual command.

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
   them, so the output can never imply protection that does not exist. The strongest
   form of this rule is the auth hook, and it survived the arrival of a way to check:
   when Management API credentials are present the activation line reports what was
   actually observed, and when they are absent it reports **not checked** — never a tick
   inferred from the function existing. A supplied credential whose check fails is
   reported as a failure rather than quietly downgraded to "not checked", because those
   two states look identical to a reader and mean opposite things.
6. **Never silently authoritative over somebody else's configuration.** The tool changes
   the two Auth fields it owns, refuses to touch a hook it did not install, and claims no
   ownership of any other Supabase Auth setting.
7. **Fail closed where silence is dangerous.** Absence of an email is answered with
   allow; a policy engine that cannot answer is answered with reject. The distinction is
   deliberate, and neither case is allowed to borrow the other's default.
8. **Fail-safe.** A failed update must never destroy the last known-good blocklist.
   Stale-but-known-good beats fresh-but-wrong: a week-old blocklist still blocks what it
   knew about, whereas a blocklist replaced by forty entries protects nothing and nobody
   finds out until the disposable signups arrive.

## Synchronisation threat model

Sync is the one place this tool ingests data it did not author, from a party it does not
control. The governing rule:

> **A failed update must never destroy the last known-good blocklist.**

| Concern                                        | Mitigation                                                                                                                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compromised upstream provider                  | Safety thresholds judge plausibility, not just validity: a maliciously emptied or truncated list fails the minimum-count and maximum-shrink checks and is refused. There is no override flag.      |
| Upstream returning HTML/an error page with 200 | Content-type allowlist rejects anything that is not `text/plain`. If it slipped through, the valid-line ratio would reject it — HTML scores near zero.                                             |
| Truncated response                             | A partial file loses domains, which trips the maximum-shrink check. The staged count is also compared against the candidate length server-side before anything is replaced.                        |
| Malicious oversized response                   | 8 MiB ceiling enforced on bytes actually received, with the stream cancelled the moment it is crossed. `Content-Length` is treated as a claim, not a fact.                                         |
| Insecure redirect                              | Redirects are followed manually, capped at 3 hops, and each target must be HTTPS. A redirect away from HTTPS is never followed and the target is never requested.                                  |
| Malformed domain entries                       | Every entry is normalised and validated locally before insertion. Invalid entries are counted, and the ratio decides whether the payload as a whole is credible.                                   |
| Domain accepted here but rejected by the CHECK | The TypeScript normaliser is a deliberate transcription of `guard.normalize_domain()` and errs towards rejecting. An integration test asserts agreement over a corpus.                             |
| Binary or mis-encoded payload                  | Refused before parsing, by a control-character and U+FFFD ratio heuristic.                                                                                                                         |
| Catastrophic list shrink                       | Rejected above 30% loss, with both counts named in the error.                                                                                                                                      |
| Malicious ordering or duplicate manipulation   | The checksum is taken over the sorted, deduplicated set, so reordering or padding with duplicates cannot make an unchanged list look changed, or a changed one look unchanged.                     |
| Concurrent sync                                | Session advisory lock, distinct from the migration lock. The second run fails fast rather than interleaving replacements.                                                                          |
| Partial database failure                       | Staging, replacement and metadata share one transaction. Any failure rolls all of it back, and the old blocklist is byte-for-byte what it was. Asserted by an integration test that fails mid-run. |
| A failure erasing the known-good record        | Failure metadata is written outside the rolled-back transaction and never touches `last_success_at`, `domain_count` or `checksum`.                                                                 |
| Stale-but-known-good data                      | Preferred, explicitly, over fresh-but-wrong. `sync_metadata` exposes the gap between `last_attempt_at` and `last_success_at` so staleness is visible rather than silent.                           |
| A dry run changing state                       | The dry-run path opens no transaction, takes no lock, creates no temporary table and writes no metadata. Asserted by unit and integration tests.                                                   |
| Terminal injection via upstream data           | Rejected entries are sanitised before being printed: non-printable characters are replaced and the sample is truncated, so an upstream cannot write ANSI escapes to an operator's console.         |
| Credential leakage through sync                | The upstream request carries no credential at all — no token, no cookie, no `Authorization`. Failure messages stored in `error_message` are `AppError` messages only, never a cause or a stack.    |
| SSRF via a caller-supplied URL                 | Not possible: there is no flag, environment variable or config file that sets a blocklist URL. Providers are compiled in.                                                                          |

## Auth hook threat model

The hook is the first component that runs inside somebody else's authentication flow,
on input this tool did not author, on the signup hot path. That combination earns its
own table.

| Concern                                                                           | Mitigation                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hook unavailable** — broken function, permission mismatch, half-removed install | Fails **closed**: the signup is rejected, never approved. `status` health-checks both the function's existence and every required `supabase_auth_admin` grant, and exits non-zero, so the breakage is visible before activation. Integration tests exercise every damage mode (dropped function, dropped table, revoked `SELECT`, revoked `EXECUTE`) **under the real role**. |
| **Malformed hook event**                                                          | Safe JSON extraction only: `->`/`->>` return `NULL` rather than raising, the email's type is checked with `jsonb_typeof()` before use, and there are no unchecked casts. Missing-email behaviour is explicit and tested against `{}`, `{"user": null}`, `{"user": {}}`, `{"user": {"email": null}}`, `""` and non-string values.                                              |
| **Privilege escalation through the hook**                                         | `SECURITY INVOKER`, so nothing is borrowed from the owner. `search_path` pinned to `''` with every object fully qualified. No write privilege of any kind for `supabase_auth_admin`. No `EXECUTE` for `PUBLIC`, `anon` or `authenticated` — asserted with `has_function_privilege()`, which resolves inherited privileges.                                                    |
| **Policy bypass**                                                                 | The hook delegates exclusively to `guard.is_disposable_domain()` and holds no lookup logic that could drift from it. Allowlist precedence and case normalisation are tested through the hook, and an integration test asserts the hook's verdict matches the engine's for every input.                                                                                        |
| **Blocklist enumeration via signup**                                              | The client-facing message is a constant that names no domain, list, provider or mechanism, and the same message is returned for every policy rejection. The hook is not executable by `PUBLIC`, `anon` or `authenticated`, so it cannot be called directly as an oracle.                                                                                                      |
| **Internal details leaking to the signup client**                                 | Both rejection responses are compile-time string literals — nothing computed, nothing interpolated, so there is no path by which a `SQLSTATE`, table name or provider could reach a client. Real diagnostics go to the PostgreSQL server log via `RAISE LOG`, which is not sent to the client.                                                                                |
| **An empty message silently allowing the signup**                                 | GoTrue treats an error object whose `message` is empty as "no error" and **allows** the signup. Both messages are non-empty literals, and an integration test asserts every rejection carries a non-empty message and a 4xx/5xx code.                                                                                                                                         |
| **Phone-only or anonymous signups blocked as collateral**                         | Absence of an email is an explicit allow, decided before the policy engine is ever consulted — so an unreachable blocklist cannot block an email-less signup either. Tested on the real Supabase payload shape (`"email": ""`), including with the policy engine deliberately broken.                                                                                         |
| **A slow hook stalling or timing out signups**                                    | Hot path is two primary-key lookups; measured at ~40 µs against a 75,000-domain list, ~0.002% of Supabase's 2-second budget. If it ever did overrun, `query_canceled` is deliberately not caught by `when others`, so the transaction aborts and the signup fails closed.                                                                                                     |
| **A caught error poisoning the signup transaction**                               | The handler sits in a nested block, so PL/pgSQL rolls back only its subtransaction. Asserted by a test that runs a query after a caught failure and requires it to succeed.                                                                                                                                                                                                   |
| **The hook mutating policy or auth data**                                         | No `INSERT`/`UPDATE`/`DELETE` grant exists for the role, and the function contains no write statement. A test snapshots every table across all six branches, including outside a transaction where a write could not be hidden by a rollback.                                                                                                                                 |
| **The hook reaching the network**                                                 | No HTTP, DNS, `dblink`, FDW or extension call — asserted against the function's own definition. There is no code path from a signup to an outbound request.                                                                                                                                                                                                                   |
| **Believing you are protected when you are not**                                  | `install` prints the activation requirement on **every** successful run, including no-ops. `status` prints "function installed" and "activation not verified" as two independent lines and never infers the second from the first. Unit tests assert no output ever reads as an activation or protection claim.                                                               |
| **Removing the function while the hook is still enabled**                         | Documented ordering: disable the Auth Hook in Supabase **first**, then remove the database objects. Reversed, Auth calls a missing function and every signup fails.                                                                                                                                                                                                           |
| **A vacuous privilege test passing on plain PostgreSQL**                          | Role-dependent tests skip explicitly when `supabase_auth_admin` is absent rather than looping zero times, and `status` reports grants as "not checked" rather than "granted" on a server without the role.                                                                                                                                                                    |

## Hook activation threat model

Activation is the first thing this tool does that reaches outside the operator's own
database, carrying a credential that can reconfigure an entire Supabase account. That
combination earns its own table.

| Concern                                                         | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Stolen Management API token**                                 | Environment-only: never written to disk, never a process argument, never a CLI flag. Sent only as an `Authorization: Bearer` header to a **compiled-in** HTTPS origin, so no input can redirect an authenticated request to an attacker-chosen host. Never placed in a URL, a path segment or a query string. Redacted out of any message Supabase itself returns, and out of any diagnostic `cause` before it is attached — so `--debug` cannot print it either. `tests/unit/secrets.test.ts` drives every log, error, dry-run and `--debug` path with a sentinel token and asserts it never appears. Documentation steers operators to `.env` or a secret manager and explicitly warns against shell history. Fine-grained / OAuth tokens scoped to Auth configuration are recommended over full-privilege personal access tokens. |
| **Token echoed back by the server**                             | An authentication error, proxy or WAF can quote the credential it rejected. Server messages are useful, so they are shown — but the token is stripped from them first, by substring replacement using the value this client holds. Found by a test, not by inspection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Redirect used to exfiltrate the token**                       | `redirect: 'manual'`; any 3xx is an error. The `Authorization` header is never carried to a host named by a `Location` response header.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Wrong project ref**                                           | The ref is validated against a conservative pattern (20 chars, lowercase alphanumeric) in configuration **and** again at the point the URL is built — the last thing standing between a value and an authenticated path. Segments are appended through `URL`, never concatenated, and the resulting origin is re-checked before the request is sent, so `../` or `/` cannot walk to another endpoint. Beyond shape: the remote GET before any PATCH, `--dry-run`, and post-write verification all give an operator a chance to notice they are looking at the wrong project. A ref that is well formed but wrong yields a clean 404.                                                                                                                                                                                                 |
| **Wrong database checked, right project activated**             | The preflight treats `supabase_auth_admin` being absent as a failure, not as "not applicable". A hosted project always has that role, so its absence means `SUPABASE_DB_URL` and `SUPABASE_PROJECT_REF` name different systems — and a health check performed against the wrong database is worse than none, because it produces confidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **An existing hook silently overwritten**                       | The slot holds one URI, so writing ours replaces whatever policy was there. A URI that is not ours is a **conflict** — never overwritten, never cleared, never disabled — whether it is currently enabled or not. There is no override flag: replacing an authentication policy is an operator decision made deliberately, elsewhere. Its own exit code (`8`) so CI can route it to a person rather than a retry.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **A foreign hook's secrets leaking through a conflict message** | The message must name what is configured or the operator cannot decide anything, but an HTTP hook URL routinely carries a signing token in its query string or userinfo. `describeHookUri()` prints `pg-functions://` URIs in full (they address a function by name and cannot carry a secret) and reduces `http(s):` URIs to scheme and host, dropping userinfo, port, path, query and fragment. Unrecognised schemes are described, not shown. Control characters are replaced, so a hostile value cannot write ANSI escapes to a console.                                                                                                                                                                                                                                                                                         |
| **Activating a broken database hook**                           | The database preflight runs **before any network request**, and requires a complete guard layer, the hook function, and every `supabase_auth_admin` grant. This is the most important control in the branch: the hook fails closed, so activating it against a damaged guard layer rejects every signup on the project rather than merely weakening a filter. An absent `SUPABASE_DB_URL` refuses rather than skipping. `--skip-db-check` is opt-in, warned before mutation, warned identically in a dry run, and does not bypass conflict detection or verification.                                                                                                                                                                                                                                                                |
| **Partial or ambiguous remote update**                          | HTTP 200 is never treated as proof. Every PATCH is followed by a fresh GET and an exact state assertion, with its own exit code (`9`) whose message explicitly tells the operator not to assume the change succeeded. A partially applied update, a server-side normalisation, a concurrent dashboard change, or a plan-tier rule declining part of a patch all produce a 200 — and are all caught here.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Unrelated Auth settings clobbered**                           | Only this feature's two fields are ever sent. The whole document is never round-tripped, which would rewrite SMTP, OAuth, CAPTCHA, rate-limit and session settings with values already stale by the time they were written — including secrets the API may return redacted. The patch parameter's type makes a whole-document write impossible to express.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Auth configuration secrets printed**                          | The GET response holds SMTP passwords, OAuth client secrets, SMS provider tokens and `hook_before_user_created_secrets`. No success path prints the document, and no failure path does either: a schema-validation error names offending **field paths only**, never values, and a malformed-body error prints neither the text nor the parse. Asserted with a fixture deliberately padded with fake secrets.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Hostile or oversized API response**                           | HTTPS only, 15 s timeout, 2 MiB ceiling applied to bytes actually received (`content-length` is treated as a claim), JSON content-type required, and a schema that validates the two fields used. Unknown fields pass through, so a future Supabase setting cannot break the command.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Terminal injection through a server message**                 | Server text is sanitised — non-printable characters replaced, length capped — before it reaches a hint. Same rule as rejected blocklist entries: text that arrived over the network never drives a console.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Rate limiting or an outage causing a retry storm**            | No automatic retries at all. A 429 or 5xx is reported with an actionable message and the operator reruns. A blind PATCH retry against an operation whose outcome is unknown is exactly what post-write verification exists to avoid.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **A test mutating a real project**                              | Every state transition is covered against a mocked `fetch`; no unit test touches the network. The live Management API test is read-only, opt-in, and reads `SADA_TEST_SUPABASE_*` rather than the CLI's own variables — so a test run can never reach for an operator's real credentials by accident. No live mutation test ships: credentials being present is never permission to change an Auth configuration.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Uninstalling while the hook is still active**                 | Documented ordering: disable remotely first, then remove the database objects. `hook disable` deliberately requires no database access, so the step that stops the bleeding works even when the database that broke is unreachable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Believing you are protected when you are not**                | `status` reports activation as **not checked** without credentials — never a tick inferred from the function existing — and reports a failed check as a failure rather than downgrading it. The only output that claims protection is the one branch where an active hook and a healthy guard layer were both actually observed. Unit tests assert no other output reads as an activation claim.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Believing you are fine while signups are failing**            | The combination of an active hook and a broken guard layer is a distinct, loudly-reported state with an explicit DANGER notice and a pointer to `hook disable`, rather than two separate lines an operator has to combine themselves.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

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
| Broken allowlist precedence                           | Precedence is a single unconditional early return, covered by unit and live-database tests including the both-lists case, and re-tested through the auth hook.                                                                                                                                                |
| A migration widening `supabase_auth_admin`'s reach    | Grants name each object individually rather than using `ON ALL TABLES IN SCHEMA`, so a future table is not handed over by accident. Integration tests assert the role has no write privilege on any policy table and no access to `sync_metadata` or `schema_migrations`.                                     |
| `status` reporting a hook the auth role cannot run    | Grants are probed with `has_*_privilege()` and a missing one makes the installation `incomplete` with exit code `5`, so the breakage is caught before an operator activates the hook.                                                                                                                         |
| Migration partial failure                             | Each migration and its history row share one transaction. A failed migration leaves no row, so a re-run resumes from the last success.                                                                                                                                                                        |
| Concurrent installs                                   | Session advisory lock; the second run fails fast instead of interleaving DDL.                                                                                                                                                                                                                                 |
| Credential leakage in logs                            | Connection strings never printed — only `host:port/database` via `describeConnectionTarget()`. Asserted in tests for both `install` and `status`.                                                                                                                                                             |
| Elevated function privileges                          | No `SECURITY DEFINER`; every function pins `search_path = ''`.                                                                                                                                                                                                                                                |
