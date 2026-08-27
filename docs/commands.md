# Command reference

Full behaviour, sample output and failure modes for every command. The
[README](../README.md) has the short version; this page has the detail.

| Command                   | Needs                                       | Changes                           |
| ------------------------- | ------------------------------------------- | --------------------------------- |
| [`doctor`](#doctor)       | nothing (uses `SUPABASE_DB_URL` if set)     | nothing                           |
| [`install`](#install)     | `SUPABASE_DB_URL`                           | database only                     |
| [`status`](#status)       | `SUPABASE_DB_URL` (Management API optional) | nothing                           |
| [`sync`](#sync)           | `SUPABASE_DB_URL` + network                 | database only                     |
| [`repair`](#repair)       | `SUPABASE_DB_URL` (Management API optional) | database only, conservatively     |
| [`uninstall`](#uninstall) | `SUPABASE_DB_URL` + Management API          | Auth configuration, then database |

The `hook` and `strict` command groups have their own pages:
[the Before User Created hook](auth-hook.md) and
[strict database enforcement](strict-mode.md).

## `doctor`

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

✓ Node.js v22.11.0 supported (requires >= 22.0.0)
✓ Configuration loaded
✓ PostgreSQL connection successful (db.abcdefgh.supabase.co:5432/postgres)
✓ PostgreSQL 17.4 detected

Environment looks healthy.
```

When configuration is missing it stops at the first failing check:

```text
$ supabase-anti-disposable-auth doctor

Supabase Anti-Disposable Auth

✓ Node.js v22.11.0 supported (requires >= 22.0.0)
✗ SUPABASE_DB_URL is missing

Set SUPABASE_DB_URL (see .env.example) and run `supabase-anti-disposable-auth doctor` again.
```

Normal configuration mistakes produce a message and a hint, never a stack trace. Add
`--debug` if you need the underlying diagnostics.

## `install`

Creates the database guard layer: the `guard` schema, its tables, the lookup functions,
the Before User Created hook function, and their privileges. It is **idempotent** — run
it again to apply new migrations.

`install` does **not** configure Supabase Auth, modify `auth.users`, enable `pg_cron`,
or download anything. It creates the function the hook will call; switching the hook on
is a separate, explicitly named command — see [Activating the hook](auth-hook.md#activating-the-hook).

```text
$ supabase-anti-disposable-auth install

Supabase Anti-Disposable Auth

✓ Connected to PostgreSQL (db.abcdefgh.supabase.co:5432/postgres)
✓ Migration 001_create_domain_functions applied
✓ Migration 002_create_domain_tables applied
✓ Migration 003_create_metadata_tables applied
✓ Migration 004_create_lookup_functions applied
✓ Migration 005_permissions applied
✓ Migration 006_create_before_user_created_hook applied
✓ Migration 007_auth_hook_permissions applied

Database guard layer installed.

Supabase Auth activation is still required — signups are not filtered yet.
Enable the Before User Created hook pointing at:
  pg-functions://postgres/guard/before_user_created
On a hosted project: `supabase-anti-disposable-auth hook enable` (needs Management API credentials).
Locally: add the [auth.hook.before_user_created] block to supabase/config.toml.
```

When everything is already applied:

```text
✓ Database guard layer already up to date.

Supabase Auth activation is still required — signups are not filtered yet.
...
```

The activation notice is printed on **every** successful run, including a no-op one. An
operator who runs `install` twice and only sees the caveat the first time would
reasonably read the second run as confirmation that they are covered.

## `status`

Read-only. Reports the database layer, and — when Management API credentials are present
— whether Supabase Auth is actually calling the hook. Everything that is not built is
reported as not configured rather than hidden.

With credentials, on a fully protected project:

```text
$ supabase-anti-disposable-auth status

Supabase Anti-Disposable Auth

Database
✓ Connected (db.abcdefgh.supabase.co:5432/postgres)

Guard schema
✓ Installed
✓ Schema version: 008
✓ Blocked domains: 74,825
✓ Allowed domains: 0
✓ Lookup function: guard.is_disposable_domain(text)

Before User Created Hook
✓ Function installed: guard.before_user_created(jsonb)
✓ Grants: supabase_auth_admin can execute the hook
✓ Activated in Supabase Auth
✓ Auth hook URI: pg-functions://postgres/guard/before_user_created

Strict database enforcement
○ Disabled (optional)

Automatic sync
○ Not configured (not implemented yet)

Active protection: the guard layer is healthy and Supabase Auth calls it.
Signups are filtered.
```

That `○ Disabled (optional)` line is a **healthy** deployment, not a gap. A hollow marker
means "deliberately not switched on", never "broken" — see
[Strict database enforcement](strict-mode.md).

Without them, the remote line is hollow — never a tick, and never inferred from the
database lines above it:

```text
Before User Created Hook
✓ Function installed: guard.before_user_created(jsonb)
✓ Grants: supabase_auth_admin can execute the hook
○ Remote activation not checked (set SUPABASE_PROJECT_REF and SUPABASE_ACCESS_TOKEN)

...
Database guard layer is up to date. Whether Supabase Auth calls the guard
hook was not checked, so nothing here confirms any signup reaches it.
```

A missing Management API credential **never** turns a database-only `status` into an
error. But if you supply credentials and the check fails, that is reported honestly
rather than downgraded to "not checked":

```text
✗ Remote activation check failed: Supabase rejected the Management API access token
  The token is missing, expired or revoked. Create a new one at
  https://supabase.com/dashboard/account/tokens and set SUPABASE_ACCESS_TOKEN.
```

The three hook lines are independent facts. The function and the grants live in
PostgreSQL; activation lives in the Auth service. `status` reads each from the system
that owns it, and never infers one from another.

### What counts as protected

| Database   | Supabase Auth        | Verdict                                                | Exit |
| ---------- | -------------------- | ------------------------------------------------------ | ---- |
| healthy    | hook active          | **Active protection.** Signups are filtered.           | `0`  |
| healthy    | hook disabled        | Installed, **not protecting**. Nothing checks signups. | `0`  |
| healthy    | another hook         | **Conflict.** Not filtered by this tool.               | `8`  |
| healthy    | not checked          | Unknown. Nothing claims protection.                    | `0`  |
| healthy    | check failed         | Unknown, and you were told why.                        | `7`  |
| **broken** | **hook active**      | **DANGEROUS — signups are being rejected now.**        | `5`  |
| broken     | disabled/not checked | Broken, but signups still work.                        | `5`  |

That second-to-last row is the one that matters most, and `status` shouts about it:

```text
✗ DANGER: the hook is ACTIVE in Supabase Auth and the database layer is broken.
The hook fails closed, so signups on this project are being rejected now.
Either repair the guard layer, or run `supabase-anti-disposable-auth hook disable` to stop the
rejections while you do — disabling first is the safe order.
```

A healthy database whose hook is simply switched off exits `0`, not because it is
protected, but because it is a documented, deliberate state rather than a fault — and
the report says so in plain words on the last line.

On a plain PostgreSQL database the grant line reads:

```text
○ Grants: not checked (supabase_auth_admin does not exist on this server)
```

which is the honest answer rather than a vacuous pass.

When `supabase_auth_admin` exists but cannot run the hook, that is a **health failure**,
because every signup would be rejected the moment the hook is activated:

```text
✗ Grants: supabase_auth_admin is missing SELECT on guard.blocked_domains
...
Guard layer requires repair. supabase_auth_admin cannot execute the hook, so every
signup would be rejected once the hook is activated in Supabase.
`supabase-anti-disposable-auth install` will not fix this: migrations/007_auth_hook_permissions.sql
is already recorded as applied, and applied migrations are never replayed.
Apply the idempotent grant snippet from "Repairing the auth hook grants" in the README,
or drop the guard schema and install again.
```

`status` probes every expected table and function individually rather than trusting the
migration history, because the two can disagree — an object dropped by hand leaves its
migration row behind. A partial or damaged install is never reported as healthy:

```text
Guard schema
✗ Incomplete installation — guard layer requires repair
  Schema version: 005
✓ Blocked domains: 0
✗ Allowed domains: table missing
✓ Lookup function: guard.is_disposable_domain(text)
✗ Missing objects: guard.allowed_domains
...
Guard layer requires repair. Objects recorded as applied are missing, so
`supabase-anti-disposable-auth install` will not recreate them.
Drop the guard schema and reinstall, or restore the missing objects by hand.
```

It handles a `guard` schema that exists but is empty, a complete migration history with
a missing function, and a partly applied migration set — without crashing in any of
them.

### `status` as a health check

`status` exits non-zero when the guard layer is not healthy, so it can be used directly
in CI or a deployment gate:

| Situation                                    | Exit code                      |
| -------------------------------------------- | ------------------------------ |
| Complete installation                        | `0`                            |
| Complete installation, hook not activated    | `0`                            |
| Not installed                                | `5` (guard health)             |
| Incomplete or damaged installation           | `5` (guard health)             |
| Complete installation, strict mode off       | `0`                            |
| Another Before User Created hook configured  | `8` (hook conflict)            |
| Strict trigger name taken by another trigger | `10` (strict conflict)         |
| Strict mode on, guard layer damaged          | `5` (guard health)             |
| Remote check supplied but failed             | `7` (remote API)               |
| `SUPABASE_DB_URL` missing or invalid         | `2` (configuration, unchanged) |
| Database unreachable or query failed         | `3` (database, unchanged)      |

Precedence, most-certain verdict first: a definite database failure (`5`) outranks a
definite remote finding (`8`), which outranks a strict-trigger conflict (`10`), which
outranks "we were asked to check and could not" (`7`). The hook conflict is ranked above
the strict conflict deliberately: the hook decides whether signups are filtered at all,
so it is the one an operator should be sent to first.

```bash
supabase-anti-disposable-auth status || echo "guard layer needs attention"
```

The human-readable report is printed in full either way — the exit code is additional
signal, not a replacement for it.

## `sync`

Downloads the upstream disposable-domain list and replaces `guard.blocked_domains` with
it, atomically. Safe to re-run: an unchanged upstream writes no rows, and **any failure
leaves the previously installed blocklist exactly as it was**.

```text
$ supabase-anti-disposable-auth sync

Supabase Anti-Disposable Auth

✓ Connected to PostgreSQL (db.abcdefgh.supabase.co:5432/postgres)
✓ Provider: disposable-email-domains
✓ Downloaded blocklist (1.1 MB, HTTP 200, 503 ms)
✓ Parsed 74,825 lines
✓ Accepted 74,825 domains
✓ Candidate passed safety checks
✓ Blocklist updated atomically (+143 / -60)
✓ Checksum: 1955f407ea92

Sync complete.
```

When upstream has not changed, nothing is rewritten:

```text
✓ Blocklist already up to date
✓ 74,825 domains

Checksum: 1955f407ea92
```

> **Sync is manual.** It runs when you run it. `pg_cron` scheduling is **not
> implemented**. And unless you have [activated the hook](auth-hook.md#activating-the-hook), a fully
> synchronised blocklist still filters no signups.

### Provider

One provider, the maintained open-source
[`disposable/disposable-email-domains`](https://github.com/disposable/disposable-email-domains)
dataset, read from its plain-text raw endpoint:

```text
https://raw.githubusercontent.com/disposable/disposable-email-domains/master/domains.txt
```

No GitHub token is required and no HTML is ever parsed. There is deliberately **no way
to point `sync` at an arbitrary URL** — that would turn this CLI into an SSRF primitive
running with your database credentials in its environment.

### What it does to your data

- Replaces **`guard.blocked_domains`** in full, inside one transaction.
- **Never touches `guard.allowed_domains`.** A domain on both lists stays on both; the
  allowlist still wins at lookup time.
- Never drops or recreates a table, so grants, constraints and object identity survive.
- Manual blocklist rows that upstream does not carry **are removed**. Use the allowlist
  for durable operator policy.

### Safety checks

A remote list is not trusted blindly. A candidate is refused unless it has:

| Check                | Threshold                 |
| -------------------- | ------------------------- |
| Minimum domain count | 1,000                     |
| Minimum valid lines  | 80% of non-blank lines    |
| Maximum shrink       | 30% of the installed list |

```text
✗ Suspicious blocklist update rejected: the candidate contains 40 domains, below the
  minimum of 1,000; the candidate would remove 99.6% of the installed list (10,000 to
  40 domains), more than the 30.0% limit
Current domains: 10,000. Candidate domains: 40. The installed blocklist was left
unchanged. Inspect the upstream source before syncing again.
```

There is **no override flag**, by design.

On a **first sync** there is no installed list to compare against, so the shrink check
is skipped and only the absolute minimum and the validity ratio apply. The CLI says so:

```text
✓ Candidate passed safety checks (first sync: no list to compare against)
```

### Dry run

```bash
supabase-anti-disposable-auth sync --dry-run
```

```text
Supabase Anti-Disposable Auth

Dry run

✓ Connected to PostgreSQL (db.abcdefgh.supabase.co:5432/postgres)
✓ Provider: disposable-email-domains
✓ Downloaded blocklist (1.1 MB, HTTP 200, 421 ms)
✓ Parsed 74,825 lines
✓ Accepted 74,825 domains
✓ Candidate passed safety checks

Current domains:   74,682
Candidate domains: 74,825
Added:             143
Removed:           0

✓ Candidate passes safety checks
Checksum: 1955f407ea92
No database changes made.
```

A dry run writes **nothing** — not a blocklist row, not a metadata row, not a temporary
table — and takes no advisory lock, so it cannot block a real sync.

### Sync metadata

`guard.sync_metadata` holds one row per source:

| Outcome | `status`  | `last_attempt_at` | `last_success_at` | `domain_count` / `checksum` |
| ------- | --------- | ----------------- | ----------------- | --------------------------- |
| Success | `success` | now               | now               | candidate values            |
| No-op   | `success` | now               | now               | unchanged                   |
| Failure | `failed`  | now               | **unchanged**     | **unchanged**               |
| Dry run | —         | —                 | —                 | —                           |

A failure records what went wrong without disturbing the values that describe the data
actually installed, so the gap between `last_attempt_at` and `last_success_at` is a
direct measure of how long sync has been broken.

A no-op advances `last_success_at` deliberately: it answers "when did we last confirm we
match upstream?", which is what staleness monitoring asks. Whether the data changed is
what `checksum` is for.

### Concurrency

A PostgreSQL session advisory lock serialises syncs. A second `sync` against the same
database fails immediately rather than waiting:

```text
✗ Another blocklist sync is already in progress
Wait for it to finish, then run sync again.
```

The key is distinct from the migration runner's, so `install` and `sync` never block
each other.

## `repair`

`repair` keeps the tool installed and restores only drift whose target and intended
definition can be proved. Preview first when investigating a damaged project:

```bash
supabase-anti-disposable-auth repair --dry-run
supabase-anti-disposable-auth repair
```

Its assessment has five stable states:

| State                    | Meaning                                                       |
| ------------------------ | ------------------------------------------------------------- |
| `healthy`                | No change is needed.                                          |
| `repairable`             | Only an admitted fixed repair is required.                    |
| `manual-action-required` | Data loss or a non-leaf policy object may be involved.        |
| `conflict`               | Ownership, definition, trigger, or remote evidence disagrees. |
| `not-installed`          | No `guard` schema exists; use `install`, not `repair`.        |

Automatic repair is deliberately narrow:

- restore missing privileges from the existing six-item, read-only
  `supabase_auth_admin` grant set;
- recreate `guard.before_user_created(jsonb)` when migration 006 is verified but that
  leaf function is gone;
- recreate the inert `guard.enforce_auth_user_email()` function when migration 008 is
  verified but that leaf function is gone.

The function repair extracts exactly one `CREATE FUNCTION` statement from the bundled,
checksummed definition and applies it as surgical DDL. It does **not** rerun the
historical migration batch and does not write migration history.

Repair refuses missing blocklist, allowlist, sync, or migration-history tables; missing
core policy functions; altered same-name objects; foreign objects in `guard`; owner
mismatches; migration checksum/history disagreement; a foreign strict trigger; and a
foreign hosted hook. Missing core data is reported as possible data loss, never replaced
with an empty table and called healthy.

When Management API credentials are available, repair reads hosted hook state. It never
sends a PATCH. A disabled hosted hook stays disabled, and an absent strict trigger stays
absent: repair restores installed database health, not enforcement intent.

`--dry-run` performs the same ownership, catalog, grant, strict, and optional remote
checks and prints the exact admitted changes, but executes no DDL and no remote write.

## `uninstall`

`uninstall` is full, permanent removal. Preview is non-mutating and needs no
confirmation:

```bash
supabase-anti-disposable-auth uninstall --dry-run
```

Execution requires explicit destructive intent:

```bash
supabase-anti-disposable-auth uninstall --yes
```

Without `--yes`, the command prints the same plan and exits without changing anything.
`--yes` confirms destruction; it never bypasses a conflict, ownership check, remote
verification, or dependency refusal.

The plan prints current blocklist and allowlist row counts. A full uninstall permanently
removes the reproducible blocklist, operator-managed allowlist decisions, sync metadata,
append-only migration history, all verified guard functions, and the schema. There is no
`--preserve-data`: disabling enforcement while retaining data is already expressed
clearly by `hook disable` and `strict disable`.

The execution order is fixed:

```text
1. verify all database, strict-trigger, dependency, and remote ownership evidence
2. remove our strict trigger, if present
3. read hosted state again; disable our Before User Created hook; verify it is off
4. recheck database ownership after the cross-system operation
5. explicitly drop owned functions and tables in one PostgreSQL transaction
6. drop the now-empty guard schema
```

The remote hook is disabled and verified before its database function can be removed.
If the slot points to another hook, uninstall stops before any mutation. Full uninstall
also refuses when Management API credentials are absent, because it cannot prove that
Supabase Auth will not call the function after deletion.

For local PostgreSQL or a deliberately separate database teardown, an explicit escape
hatch exists:

```bash
supabase-anti-disposable-auth uninstall --database-only --dry-run
supabase-anti-disposable-auth uninstall --database-only --yes
```

`--database-only` never reads or writes hosted state unless Management credentials are
already available. If the hosted hook is proven active, it refuses. If remote state is
unknown, the warning is intentionally severe: the operator is choosing to remove the
database function without proving that hosted Auth is no longer calling it.

Before database removal, the CLI verifies migration checksums, expected object names and
kinds, owners, table/constraint shape, function bodies and security properties. It
refuses unexpected relations, routines, constraints, triggers, policies, rules, types,
operators, collations, or conversions inside `guard`. PostgreSQL dependency catalogs are
also checked for views, triggers, functions, policies, or other objects outside `guard`
that depend on it.

Cleanup uses fixed identifiers and explicit `DROP FUNCTION` / `DROP TABLE` statements.
It never runs `DROP SCHEMA guard CASCADE`, `DROP OWNED`, or any other broad deletion.
The final plain `DROP SCHEMA guard` is an additional safety assertion that the schema is
empty. A dependency missed by preflight makes PostgreSQL reject and roll back cleanup;
it is never silently cascaded through.

The Management API and PostgreSQL cannot share a transaction. Uninstall therefore
prioritises a safe resumable state: if remote disable succeeds and database cleanup
fails, Auth is safely off and the schema remains; rerunning continues. If strict removal
succeeds and the remote API then fails, the guard schema remains intact. Every step is
idempotent, so already-disabled, already-absent, and partially completed states are safe
to rerun.
