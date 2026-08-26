# Architecture

> **Status:** the CLI foundation, the `guard` schema, the database policy engine and
> manual blocklist synchronisation exist today. The Supabase Auth Hook does **not**, and
> neither does `pg_cron` scheduling. Everything marked **Planned** below is not
> implemented, and no signup is filtered yet.

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
| `src/database/transaction.ts`   | The single `begin`/`commit`/`rollback` helper.                    |
| `src/blocklist/`                | The synchronisation pipeline — see section 5.                     |
| `src/lib/errors.ts`             | Configuration / database / unexpected error kinds and exit codes. |
| `src/lib/logger.ts`             | Minimal stdout/stderr logger.                                     |
| `src/lib/redact.ts`             | Turns a connection string into a printable `host:port/database`.  |

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
   them, so the output can never imply protection that does not exist.
6. **Fail-safe.** A failed update must never destroy the last known-good blocklist.
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
