# Supabase Anti-Disposable Auth

A Node.js CLI that installs database-level disposable-email protection into Supabase
projects. Instead of validating throwaway addresses in your application code, the tool
will push enforcement down into PostgreSQL and Supabase Auth, so every signup path —
your app, another client, or the dashboard — is covered by the same rule.

## Project status: early development

The **database policy engine works**, `sync` keeps its blocklist current from an upstream
source, `install` creates the **Before User Created auth hook function**, and
`hook enable` **activates it** in a hosted project's Supabase Auth configuration.

> **⚠️ Installing the hook function is still not the same as turning protection on.**
> `install` creates `guard.before_user_created()` and grants `supabase_auth_admin`
> permission to run it. It does **not** tell Supabase Auth to call it — that lives in
> the Auth service's configuration, not in PostgreSQL. Activation is a **separate,
> explicitly named command**, so reconfiguring a project's live authentication can never
> happen as a side effect of running a migration.
>
> ```text
> function installed   ≠   Auth Hook enabled
>   (install)                (hook enable, or the dashboard, or config.toml)
> ```
>
> `status` reports these as separate lines and never infers one from the other. When
> Management API credentials are absent it says **not checked** — never a tick.
>
> **⚠️ Sync is manual.** `pg_cron` scheduling is not implemented. The blocklist refreshes
> when you run `sync`, and never otherwise.

```text
Remote blocklist
      ↓
Safe manual sync                  (HTTPS fetch, validation, safety checks)
      ↓
guard.blocked_domains
      ↓
guard.is_disposable_domain()      the one policy engine
      ↑
      │  delegates to
      │
guard.before_user_created(event)  the hook function — installed by `install`
      ↑
      │  ⚠️ only while Supabase Auth is configured to call it
      │
Supabase Auth                     allow {} / reject {"error": {...}}
      ↑
      │  configured by
      │
Supabase Management API           GET/PATCH /v1/projects/{ref}/config/auth
      ↑
      │
CLI: hook enable / disable / status
```

Read the bottom half carefully, because it is the distinction the whole design turns on:

```text
The Management API CONFIGURES Auth.
It does NOT execute the policy.
```

`hook enable` flips one boolean and sets one URI in a hosted project. Every signup
decision is still made by `guard.is_disposable_domain()` inside your database, with no
network call and no dependency on this CLI ever running again.

## Intended capabilities

Planned, not yet built (see [docs/roadmap.md](docs/roadmap.md)):

- Optional strict PostgreSQL trigger enforcement
- **Scheduled** blocklist refresh with `pg_cron` (manual refresh works today)
- Safe uninstall flow with dry-run support

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

| Command        | Status              | Purpose                                                            |
| -------------- | ------------------- | ------------------------------------------------------------------ |
| `doctor`       | **Available**       | Validate the local environment and database connectivity.          |
| `install`      | **Available**       | Create the guard schema, policy engine and hook function.          |
| `status`       | **Available**       | Report the guard schema, and remote activation when credentialled. |
| `sync`         | **Available**       | Refresh the disposable-domain blocklist. Manual only.              |
| `hook status`  | **Available**       | Report what Supabase Auth is actually configured to call.          |
| `hook enable`  | **Available**       | Point Supabase Auth at the guard hook and switch it on.            |
| `hook disable` | **Available**       | Switch the guard hook off, leaving its URI in place.               |
| `uninstall`    | Not implemented yet | Remove everything the CLI installed.                               |

`doctor`, `install`, `status` and `sync` need only `SUPABASE_DB_URL`. The `hook`
commands need Management API credentials — and `hook enable` needs both. A missing
Management API credential never breaks a database-only command.

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

### `install`

Creates the database guard layer: the `guard` schema, its tables, the lookup functions,
the Before User Created hook function, and their privileges. It is **idempotent** — run
it again to apply new migrations.

`install` does **not** configure Supabase Auth, modify `auth.users`, enable `pg_cron`,
or download anything. It creates the function the hook will call; switching the hook on
is a separate, explicitly named command — see [Activating the hook](#activating-the-hook).

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

### `sync`

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
> implemented**. And unless you have [activated the hook](#activating-the-hook), a fully
> synchronised blocklist still filters no signups.

#### Provider

One provider, the maintained open-source
[`disposable/disposable-email-domains`](https://github.com/disposable/disposable-email-domains)
dataset, read from its plain-text raw endpoint:

```text
https://raw.githubusercontent.com/disposable/disposable-email-domains/master/domains.txt
```

No GitHub token is required and no HTML is ever parsed. There is deliberately **no way
to point `sync` at an arbitrary URL** — that would turn this CLI into an SSRF primitive
running with your database credentials in its environment.

#### What it does to your data

- Replaces **`guard.blocked_domains`** in full, inside one transaction.
- **Never touches `guard.allowed_domains`.** A domain on both lists stays on both; the
  allowlist still wins at lookup time.
- Never drops or recreates a table, so grants, constraints and object identity survive.
- Manual blocklist rows that upstream does not carry **are removed**. Use the allowlist
  for durable operator policy.

#### Safety checks

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

#### Dry run

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

#### Sync metadata

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

#### Concurrency

A PostgreSQL session advisory lock serialises syncs. A second `sync` against the same
database fails immediately rather than waiting:

```text
✗ Another blocklist sync is already in progress
Wait for it to finish, then run sync again.
```

The key is distinct from the migration runner's, so `install` and `sync` never block
each other.

### The Before User Created hook

Supabase's **Before User Created** hook lets a PostgreSQL function inspect a signup
before the user row is created, and reject it. `install` creates that function:

```sql
guard.before_user_created(event jsonb) returns jsonb
```

Supabase Auth invokes it as `select "guard"."before_user_created"($1)` inside the same
transaction that would create the user, under a 2-second `statement_timeout`.

#### Input

The `event` payload carries the candidate user. Only one field is read:

```json
{
  "metadata": { "name": "before-user-created", "ip_address": "127.0.0.1" },
  "user": {
    "email": "person@mailinator.com",
    "phone": "",
    "is_anonymous": false
  }
}
```

#### Output

| Decision | Response                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------- |
| Allow    | `{}`                                                                                                 |
| Reject   | `{"error": {"http_code": 403, "message": "Disposable email addresses are not allowed."}}`            |
| Failure  | `{"error": {"http_code": 503, "message": "Signup could not be validated. Please try again later."}}` |

**403, not 400.** Supabase Auth already returns `400` for its own validation failures —
malformed address, weak password, user already registered — so reusing it would make a
policy rejection indistinguishable from a malformed request for any client trying to
show a useful message. `403` says the request was understood and refused.

**503 for engine failure, never for a policy rejection.** The two are different events
and a client, a log and an alert should all be able to tell them apart.

The messages are compile-time string literals. They name no provider, table, function,
schema, `SQLSTATE`, checksum or list, so a client cannot tell "this domain is on the
blocklist" from any other reason the address was refused, and cannot use signup as a
blocklist-enumeration oracle. Real diagnostics go to the **PostgreSQL server log** via
`RAISE LOG`, which is never sent to the client.

#### Behaviour

| Input                                        | Result                          |
| -------------------------------------------- | ------------------------------- |
| Normal, non-disposable email                 | **allow**                       |
| Disposable email                             | **reject**                      |
| Disposable email that is also allowlisted    | **allow**                       |
| Unknown domain                               | **allow**                       |
| Uppercase / padded / `@`-prefixed email      | normalised first, then as above |
| No email, `null`, `""`, whitespace           | **allow**                       |
| Non-string email (`123`, `true`, `[]`, `{}`) | **reject** (503)                |
| `event` is not a JSON object, or is `NULL`   | **reject** (503)                |
| Policy engine raises                         | **reject** (503)                |

The hook contains **no lookup logic of its own**. It extracts an address and calls
`guard.is_disposable_domain()`, which owns normalisation and allowlist precedence. One
policy engine, one source of truth — asserted by an integration test that compares the
hook's verdict against the engine's for every input.

#### Phone-only and anonymous signups are not blocked

Supabase serialises a user's email as an empty string when there is none, so a
phone-only or anonymous signup arrives as `"email": ""`. **Those are allowed.**

This is a deliberate **fail-open for the absence of an email**. It is not a fail-open
for the policy engine — that is the opposite decision, below. "There is nothing to
check" and "the check did not work" are different events and are answered differently.

This tool enforces disposable-**email** policy only when an email exists. Phone-only and
anonymous flows are outside its scope and must not become collateral damage from a
disposable-email filter.

#### A non-string email is rejected, not treated as "no email"

`"email": ""` and `"email": 12345` look like the same problem and are not.

| `user.email`                | Verdict        | Why                                   |
| --------------------------- | -------------- | ------------------------------------- |
| absent                      | **allow**      | Supabase sends this; nothing to judge |
| `null`                      | **allow**      | Supabase sends this; nothing to judge |
| `""` or whitespace          | **allow**      | Supabase sends this; nothing to judge |
| a string                    | policy decides | the case the tool exists for          |
| `12345`, `true`, `[]`, `{}` | **reject 503** | Supabase cannot send this             |

**Supabase legitimately represents non-email flows with an empty or `null` email.**
GoTrue serialises the candidate address from a Go `NullString`, so a phone-only or
anonymous signup arrives with the field present and empty. That is a supported flow,
sent under the contract, carrying nothing to judge — so it is allowed.

**A non-string value violates the expected hook contract.** `user.email` is a Go string
field; no GoTrue release serialises it as a number, boolean, array or object. Receiving
one means the payload did not come from the contract this function implements — a hook
wired to the wrong extensibility point, a caller that is not Supabase Auth, or a GoTrue
whose payload shape changed underneath the installation. The hook cannot know what it is
being asked, so it does not hand out an approval.

The alternative reading — "no usable email, therefore allow" — fails in exactly the way
that matters: `{"user": {"email": ["person@mailinator.com"]}}` would pass a
disposable-email filter that never looked at an address, and nothing would say so.

The response is the **same generic 503** used for structural corruption and engine
failure: a compile-time literal naming no field, no type and no value. A client learns
only that validation could not be completed, and cannot tell a malformed payload from a
dropped table. The offending JSON **type** — never the value — goes to the PostgreSQL
server log via `RAISE LOG`, where the operator can see it and the client cannot.

#### Infrastructure failure fails closed

If `guard.is_disposable_domain()` raises — a dropped table, a revoked privilege, a
half-removed installation — the hook **rejects the signup** with the 503 response above.

A policy engine that cannot answer has not said "allow"; it has said nothing. Treating
silence as approval would mean one revoked privilege quietly disables the entire filter
while every signup keeps succeeding — exactly the failure nobody notices until the
disposable accounts arrive.

Two related behaviours fall out of this and are worth knowing:

- **A malformed event rejects.** Supabase Auth always sends a JSON object. A `NULL` or
  a JSON scalar means the hook is not being called under the contract it was written
  for, and a hook that cannot confirm who is asking must not hand out approvals. A
  well-formed object that merely carries no email is _not_ corruption and is allowed;
  a well-formed object whose `user.email` is present but not a string _is_, and is
  rejected with the same 503 — see [above](#a-non-string-email-is-rejected-not-treated-as-no-email).
- **A timeout rejects, without any code here.** Supabase's 2-second `statement_timeout`
  raises `query_canceled`, which PL/pgSQL's `when others` deliberately does not catch.
  The transaction aborts and the signup fails closed.

#### Privileges

The hook is **`SECURITY INVOKER`**, so it runs with exactly the privileges of
`supabase_auth_admin` and borrows nothing. That role is granted only:

| Grant                                           | Why                               |
| ----------------------------------------------- | --------------------------------- |
| `USAGE` on schema `guard`                       | reach anything at all             |
| `EXECUTE` on `guard.before_user_created(jsonb)` | the hook itself                   |
| `EXECUTE` on `guard.is_disposable_domain(text)` | the policy engine it delegates to |
| `EXECUTE` on `guard.normalize_domain(text)`     | called by the engine              |
| `SELECT` on `guard.blocked_domains`             | the lookup                        |
| `SELECT` on `guard.allowed_domains`             | the lookup                        |

Deliberately **not** granted: any `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE` or
`REFERENCES` anywhere; `CREATE` on the schema; anything on `guard.sync_metadata` or
`guard.schema_migrations`; and `EXECUTE` on `guard.is_blocked_domain()` /
`guard.is_allowed_domain()`, which the hook never calls. `PUBLIC`, `anon` and
`authenticated` get nothing at all — they cannot execute the hook and gain no new access
to the policy lists.

`SECURITY DEFINER` was considered and **refused**. It would reduce the grant list to a
schema `USAGE` plus one `EXECUTE`, but the two `SELECT`s it saves are read-only access
to a public disposable-domain list and an operator allowlist — neither holds a secret,
and the one thing a client must not learn is obtainable through the hook either way. In
exchange it would run a function as the schema owner, on a payload supplied by an
external system, on the signup hot path. That trade is bad, and "make the permissions
work" is not a justification. No function in `guard` is `SECURITY DEFINER`.

Every function pins `search_path = ''` and fully qualifies its objects.

#### The hook is side-effect free

Invoking it modifies no blocked domain, no allowed domain, no sync metadata, no
`auth.users` row; it creates nothing and calls no remote service. It evaluates and
returns a decision. Asserted by an integration test that snapshots every table across
all six branches of the function.

### Activating the hook

Activation is what makes the difference between a function sitting in your database and
a filter running on every signup. There are two paths, and they are **not**
interchangeable — one configures a local stack, the other configures a hosted project.

The hook URI is always the same on both:

```text
pg-functions://postgres/guard/before_user_created
```

| Where                    | How                                       | This CLI         |
| ------------------------ | ----------------------------------------- | ---------------- |
| Local (`supabase start`) | `supabase/config.toml`                    | **documents it** |
| Hosted project           | Supabase Management API, or the dashboard | **automates it** |

#### Locally, with the Supabase CLI

Add to your project's `supabase/config.toml`:

```toml
[auth.hook.before_user_created]
enabled = true
uri = "pg-functions://postgres/guard/before_user_created"
```

Then restart the stack so Auth picks up the change:

```bash
supabase stop && supabase start
```

Run `supabase-anti-disposable-auth install` against the local database **before**
starting Auth with the hook enabled — Auth will call a function that must already exist.

This tool does **not** edit your `config.toml` for you, and `hook enable` does not touch
it either. It has no safe, explicit mechanism for modifying user-owned configuration
files, and inventing one to save a four-line paste would be the wrong trade. `hook
enable` targets the **hosted** Auth configuration only; running it will not change what
your local stack does.

#### On a hosted project

Either through the dashboard — **Authentication → Hooks → Before User Created**, select
the Postgres function `guard.before_user_created`, enable it — or with one command:

```bash
supabase-anti-disposable-auth hook enable
```

### The `hook` commands

These are the only commands that talk to Supabase's servers, and the only ones that can
change anything outside your database. They need
[Management API credentials](#management-api-credentials).

```bash
supabase-anti-disposable-auth hook status
supabase-anti-disposable-auth hook enable
supabase-anti-disposable-auth hook disable
```

They configure exactly two fields of your project's Auth configuration:

```json
{
  "hook_before_user_created_enabled": true,
  "hook_before_user_created_uri": "pg-functions://postgres/guard/before_user_created"
}
```

and **nothing else**. This tool does not own, manage, read out or report on any other
Supabase Auth setting. Your SMTP configuration, OAuth providers, CAPTCHA keys, rate
limits, session settings and every other hook are untouched by every command here.

#### Management API credentials

| Variable                | What it is                                                              |
| ----------------------- | ----------------------------------------------------------------------- |
| `SUPABASE_PROJECT_REF`  | The 20-character id in `https://supabase.com/dashboard/project/<ref>`   |
| `SUPABASE_ACCESS_TOKEN` | A Management API access token. **Treat as your most sensitive secret.** |

Create a token at **[supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens)**.
Prefer a fine-grained or OAuth token scoped to Auth configuration where your plan offers
one — `GET` needs Auth-configuration read access and `PATCH` needs write access, and
nothing here needs more than that.

> **⚠️ A personal access token carries the privileges of your whole account**, across
> every project that account can reach. That is far wider than `SUPABASE_DB_URL`, which
> is scoped to a single database. Someone who obtains it can read and rewrite your
> projects' configuration.

**Do not put it in a shell command.**

```bash
# DON'T. This lands in ~/.zsh_history in plaintext, and in the process list
# where any other user on the machine can read it.
SUPABASE_ACCESS_TOKEN=sbp_... supabase-anti-disposable-auth hook enable
```

Put it in `.env` (which is gitignored), or export it from a secret manager:

```bash
export SUPABASE_ACCESS_TOKEN="$(op read op://vault/supabase/token)"
```

In CI, use the platform's masked-secret store. Never `echo` it.

**What this CLI does with it**, and what it will never do:

- sent **only** as `Authorization: Bearer <token>` to `https://api.supabase.com`;
- **never** in a URL, a query string, or a path segment;
- **never** written to a log, an error message, a file, or a process argument;
- **never** sent to a host you can configure — the API origin is compiled in, and there
  is no flag or variable that redirects it;
- **redacted** out of any message Supabase itself returns, and out of any error attached
  as a diagnostic `cause`, so even `--debug` cannot print it.

Those are enforced by tests that drive every path with a sentinel token and assert it
never appears in the output. See [SECURITY.md](SECURITY.md).

#### `hook enable`

Points Supabase Auth at `guard.before_user_created` and switches it on. Idempotent, and
safe to re-run.

```text
$ supabase-anti-disposable-auth hook enable

Supabase Anti-Disposable Auth

✓ Database hook layer healthy (db.abcdefgh.supabase.co:5432/postgres)
✓ Read Supabase Auth configuration (Before User Created: disabled)
✓ Auth configuration updated
✓ Verified by reading the configuration back

✓ Before User Created hook enabled
✓ URI verified: pg-functions://postgres/guard/before_user_created

Signups are now filtered by the guard hook.
```

The order of those lines is the design:

```text
DB preflight
   ↓
Remote GET
   ↓
already correct?
   ├── yes → no-op success, no PATCH
   └── no
        ↓
      conflict? ──→ refuse, no PATCH
        ↓
      PATCH  (two fields only)
        ↓
      Remote GET
        ↓
      verify exact state
```

##### The database preflight

**Before a single byte reaches the Management API**, `hook enable` connects to your
database and proves the hook layer works:

- the guard layer is complete and fully migrated,
- `guard.before_user_created(jsonb)` exists,
- `supabase_auth_admin` holds every privilege the hook needs.

This is the most important check in the command, and the reason is the hook's own
design. `guard.before_user_created()` **fails closed** — if the policy engine cannot
answer, it rejects the signup. That is correct for a security control, and it is exactly
what makes premature activation dangerous:

> Enabling the hook against a broken guard layer does not weaken your filter. It rejects
> **every signup on the project**.

So a failed preflight stops the command with exit code `5`, and nothing is sent:

```text
✗ supabase_auth_admin cannot execute the hook: missing SELECT on guard.blocked_domains
Every signup would be rejected. Apply the grant snippet from "Repairing the auth hook
grants" in the README, then try again.
```

If `SUPABASE_DB_URL` is not set, `hook enable` **refuses** rather than skipping the
check:

```text
✗ SUPABASE_DB_URL is missing, so the database hook cannot be verified before activation
Set SUPABASE_DB_URL so the database hook can be verified first, or pass --skip-db-check
to activate without that verification (dangerous — see `hook enable --help`).
```

Silently skipping would make the dangerous path the default for anyone who has not
configured a database, which is precisely backwards.

##### `--skip-db-check`

> **⚠️ Dangerous. Opt-in only.**
>
> ```bash
> supabase-anti-disposable-auth hook enable --skip-db-check
> ```
>
> This activates the hook **without verifying that the database can serve it**. If
> `guard.before_user_created` is missing, or `supabase_auth_admin` cannot execute it,
> every signup on the project will be rejected the moment the hook goes live.

It prints a warning before it mutates anything, and prints the same warning during a
`--dry-run` — a preview whose warnings differ from the real run would teach you that the
dangerous flag is quiet.

Use it only when you genuinely cannot reach the database from where you are running the
command and you have verified the guard layer another way.

**It is not a `--force`.** It buys out of the _database_ check and nothing else. It does
not overwrite another hook, does not ignore an API error, and does not skip post-write
verification.

##### Idempotence

A project that is already correct is a success with no PATCH at all:

```text
✓ Before User Created hook already enabled
✓ URI matches expected database function
  pg-functions://postgres/guard/before_user_created

No remote changes were needed.
```

##### Configuration conflict

If the Before User Created slot already points at a **different** hook, `hook enable`
refuses and changes nothing:

```text
✗ Before User Created is already configured to a different hook (currently enabled):
  pg-functions://postgres/custom/existing_hook

Refusing to replace it. The hook slot holds one URI, so enabling
pg-functions://postgres/guard/before_user_created would silently disable that policy.
Decide explicitly: remove the existing hook in the Supabase dashboard, then run
`supabase-anti-disposable-auth hook enable` again.
```

Exit code `8`. **There is no override flag**, by design — replacing an authentication
policy somebody deliberately installed is a decision only you can make, and it is made
in the dashboard, not by a CLI flag.

This applies **even when the other hook is disabled**. A disabled foreign hook is
somebody's configuration in a paused state, not an empty slot; taking it would destroy
their ability to switch it back on.

Every combination is defined:

| `enabled` | `uri`            | `hook enable` | `hook disable` |
| --------- | ---------------- | ------------- | -------------- |
| `false`   | none             | enable it     | no-op          |
| `false`   | ours             | enable it     | no-op          |
| `false`   | **another hook** | **conflict**  | **conflict**   |
| `true`    | ours             | no-op         | disable it     |
| `true`    | **another hook** | **conflict**  | **conflict**   |
| `true`    | none             | repair it     | no-op          |

If the existing hook is an HTTP endpoint, its **path and query are withheld** from the
message — a webhook URL routinely carries a signing token, and a conflict report is not
worth writing one into your terminal scrollback:

```text
✗ Before User Created is already configured to a different hook (currently enabled):
  https://hooks.example.test (path and query withheld)
```

##### Post-write verification

`hook enable` never treats HTTP 200 as proof. After the PATCH it reads the configuration
back and asserts the exact expected state. If the state does not match:

```text
✗ Supabase accepted the change but the Auth configuration does not show it:
  Before User Created is disabled with URI pg-functions://postgres/guard/before_user_created
The project may be in an unintended state — do not assume the enable succeeded.
Check Authentication -> Hooks in the Supabase dashboard before relying on it.
```

Exit code `9`, and nothing is reported as successful. A partially applied update, a
server-side normalisation, a competing change from the dashboard, or a plan-tier rule
that declines part of a patch would all look like success without this read-back.

##### What it sends

Exactly two fields:

```json
{
  "hook_before_user_created_enabled": true,
  "hook_before_user_created_uri": "pg-functions://postgres/guard/before_user_created"
}
```

It deliberately does **not** GET the whole Auth configuration and PATCH it back. Doing
so would rewrite every unrelated setting with values that were already stale by the time
they were sent — including secrets the API may return in redacted form, which would then
be written back redacted.

#### `hook disable`

Switches the guard hook off. It **only ever touches the hook it installed**.

```text
$ supabase-anti-disposable-auth hook disable

Supabase Anti-Disposable Auth

✓ Read Supabase Auth configuration (Before User Created: enabled)
✓ Auth configuration updated
✓ Verified by reading the configuration back

✓ Before User Created hook disabled
✓ URI left in place: pg-functions://postgres/guard/before_user_created

Signups are no longer filtered. The database objects are untouched —
it is now safe to remove them if that is what you intended.
```

**The URI is deliberately left in place.** The Management API's update body makes every
field optional, so `disable` sends only:

```json
{ "hook_before_user_created_enabled": false }
```

That is the least destructive change that achieves the goal. It also keeps the
configuration explicit: your project still records which function the hook points at,
`hook enable` can switch it back on without re-deriving anything, and the dashboard
shows what was disabled rather than an empty field that says nothing. "Turn it off" does
not imply "forget what it was".

**`hook disable` performs no database preflight**, and has no `--skip-db-check`. That is
deliberate: turning our own hook off cannot point Auth at anything broken, and requiring
database credentials to switch a hook **off** would strand you exactly when you need it
most — when the fail-closed hook is rejecting every signup and your database is
unreachable.

If the slot belongs to another hook, it refuses:

```text
✗ Before User Created is configured to a different hook (currently enabled):
  pg-functions://postgres/custom/existing_hook
Refusing to touch it. This tool only disables the hook it installed; that
configuration belongs to something else.
```

#### `hook status`

Read-only. Reports what Supabase Auth is actually configured to do.

```text
$ supabase-anti-disposable-auth hook status

Supabase Anti-Disposable Auth

Project
✓ Connected to the Supabase Management API (project abcdefghijklmnopqrst)

Before User Created
✓ Enabled
✓ URI: pg-functions://postgres/guard/before_user_created
```

Or:

```text
Before User Created
○ Disabled
  Configured URI: pg-functions://postgres/guard/before_user_created
  Run `supabase-anti-disposable-auth hook enable` to switch it on.
```

Or:

```text
Before User Created
✗ Conflict
  Another Before User Created hook is configured: pg-functions://postgres/custom/existing_hook
  It is currently enabled.
  This tool will not change it. Expected: pg-functions://postgres/guard/before_user_created
```

A disabled hook exits `0` — it is a fact about your project, not a failure of the
command. A conflict exits `8`.

The report prints one flag and one URI. It never dumps the Auth configuration document,
because that document contains SMTP passwords, OAuth client secrets and SMS provider
tokens that this tool has no reason to read and every reason not to print.

#### Dry run

Both mutating commands support `--dry-run`:

```bash
supabase-anti-disposable-auth hook enable --dry-run
supabase-anti-disposable-auth hook disable --dry-run
```

A dry run validates configuration, performs the database preflight (unless explicitly
skipped), reads the remote configuration, works out what it would do, and **sends zero
PATCH requests**.

```text
$ supabase-anti-disposable-auth hook enable --dry-run

Supabase Anti-Disposable Auth

Dry run

✓ Database hook layer healthy (db.abcdefgh.supabase.co:5432/postgres)
✓ Read Supabase Auth configuration (Before User Created: disabled)

Current:
  Before User Created: disabled (no URI configured)

Would set:
  hook_before_user_created_enabled: true
  hook_before_user_created_uri: pg-functions://postgres/guard/before_user_created

No remote changes made.
```

A dry run fails in exactly the same places a real run would — a broken guard layer and a
configuration conflict both stop it — so a dry run that succeeds is a genuine prediction
rather than an optimistic one.

#### Is there a confirmation prompt?

No, and that is deliberate. `hook enable` is already an explicitly named mutation
command, `--dry-run` gives you a preview whenever you want one, and a prompt would make
the command awkward to run from CI for no real safety gain. The protections that matter
here are structural — the preflight, the conflict refusal, and the post-write
verification — not a keystroke.

### Troubleshooting

| Symptom                                                               | Cause                                                                                                                                 | Fix                                                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Every signup fails with 503                                           | `supabase_auth_admin` is missing a grant, or a guard object was dropped                                                               | `status` names the exact missing privilege or object                                    |
| `status` reports missing grants, `install` says "up to date"          | 007 ran before `supabase_auth_admin` existed and is recorded as applied, so it is never replayed                                      | See [Repairing the auth hook grants](#repairing-the-auth-hook-grants)                   |
| Every signup fails with 503 and the logs say "malformed hook payload" | Something is sending a non-string `user.email` — a hook wired to the wrong extensibility point, or a caller that is not Supabase Auth | Check which hook the Auth config points at; the server log names the JSON type received |
| Disposable signups still succeed                                      | The hook is installed but **not activated**                                                                                           | `hook status` says so in one line; `hook enable` fixes it                               |
| `hook enable` refuses with a conflict                                 | Another Before User Created hook is already configured                                                                                | Remove it in the dashboard first — this tool will not replace a policy you installed    |
| `hook enable` refuses with exit `5`                                   | The database preflight failed: broken guard layer, or missing `supabase_auth_admin` grants                                            | Fix the database first. The message names the exact object or privilege                 |
| `hook enable` exits `9` after a PATCH                                 | Supabase accepted the change but reading it back showed a different state                                                             | Check Authentication → Hooks in the dashboard; do not assume the change applied         |
| `hook` commands exit `7` with a 403                                   | Token lacks Auth-configuration write access, or the project's plan declines the change                                                | The hint carries Supabase's own message                                                 |
| Signup fails with a raw `function ... does not exist`                 | Auth is configured for a hook the database does not have                                                                              | Run `install`, or correct the URI                                                       |
| Signup fails with a 500 and no message                                | The hook exceeded Supabase's 2-second timeout                                                                                         | Check for lock contention on `guard.blocked_domains` during a `sync`                    |
| Phone or anonymous signups are blocked                                | Not caused by this tool — it allows every email-less signup by design                                                                 | Check other hooks and your own validation                                               |

The real error, with its `SQLSTATE`, is always in the **PostgreSQL logs** — the client
message is generic on purpose.

### Removing the hook

Order matters, and getting it wrong breaks signups:

```bash
# 1. Stop Supabase Auth calling the function.
supabase-anti-disposable-auth hook disable

# 2. Only then remove the database objects.
```

On a local stack, step 1 is removing the `[auth.hook.before_user_created]` block from
`config.toml` and restarting.

Doing it the other way round leaves Supabase Auth calling a function that no longer
exists, and **every signup fails** until the configuration catches up. This is why
`hook disable` needs no database access at all: the step that stops the bleeding must
work even when the database does not.

Full `uninstall` is not implemented yet — see [docs/roadmap.md](docs/roadmap.md).

### `status`

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
✓ Schema version: 007
✓ Blocked domains: 74,825
✓ Allowed domains: 0
✓ Lookup function: guard.is_disposable_domain(text)

Before User Created Hook
✓ Function installed: guard.before_user_created(jsonb)
✓ Grants: supabase_auth_admin can execute the hook
✓ Activated in Supabase Auth
✓ Auth hook URI: pg-functions://postgres/guard/before_user_created

Automatic sync
○ Not configured (not implemented yet)

Active protection: the guard layer is healthy and Supabase Auth calls it.
Signups are filtered.
```

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

#### What counts as protected

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

#### `status` as a health check

`status` exits non-zero when the guard layer is not healthy, so it can be used directly
in CI or a deployment gate:

| Situation                                   | Exit code                      |
| ------------------------------------------- | ------------------------------ |
| Complete installation                       | `0`                            |
| Complete installation, hook not activated   | `0`                            |
| Not installed                               | `5` (guard health)             |
| Incomplete or damaged installation          | `5` (guard health)             |
| Another Before User Created hook configured | `8` (hook conflict)            |
| Remote check supplied but failed            | `7` (remote API)               |
| `SUPABASE_DB_URL` missing or invalid        | `2` (configuration, unchanged) |
| Database unreachable or query failed        | `3` (database, unchanged)      |

Precedence, most-certain verdict first: a definite database failure (`5`) outranks a
definite remote finding (`8`), which outranks "we were asked to check and could not"
(`7`).

```bash
supabase-anti-disposable-auth status || echo "guard layer needs attention"
```

The human-readable report is printed in full either way — the exit code is additional
signal, not a replacement for it.

### Repairing the auth hook grants

There is one situation where `status` correctly reports missing grants and `install`
correctly refuses to fix them. It is worth understanding before reaching for the
snippet below.

#### How a database ends up here

`migrations/007_auth_hook_permissions.sql` grants the hook's call chain to
`supabase_auth_admin`, and every statement in it is wrapped in
`if exists (select 1 from pg_catalog.pg_roles where rolname = 'supabase_auth_admin')`.
That guard is required: the role does not exist on a plain PostgreSQL server, and an
unguarded `GRANT` would make `install` fail there.

The consequence is an edge case with three parts:

1. **If 007 ran while `supabase_auth_admin` did not exist, it took its no-op branch**
   and was still recorded in `guard.schema_migrations` as applied — correctly, because
   it did run to completion.
2. **Creating the role later does not make the grants appear.** Nothing re-evaluates
   that `if exists`. A `GRANT` is a row in an ACL, not a rule that fires when a role
   shows up; the migration is a one-time event that has already happened.
3. **`install` will not replay 007.** Applied migrations are never re-run — that is a
   deliberate property of the runner, not an oversight, and it is what makes `install`
   safe to run repeatedly. See [migrations/README.md](migrations/README.md).

So the database is left in a state where the hook function exists, the role exists, and
the role cannot execute it.

**`status` reports this.** It probes every required privilege with
`has_*_privilege()` rather than trusting the migration history, names each missing
grant, marks the installation `incomplete`, and exits non-zero. The gap is visible
before the hook is activated, which is the point at which it would start rejecting
every signup.

#### How likely is this in practice?

**Uncommon.** Both hosted Supabase projects and `supabase start` provision
`supabase_auth_admin` as part of the platform, long before this tool is installed, so a
normal installation grants correctly on the first run. The realistic ways to land here
are a plain PostgreSQL database that later had Supabase roles added, a restore into a
cluster whose roles were not restored with it, or a scratch database used for
development.

#### The remediation

Idempotent, role-guarded, and grants **exactly** the privileges
`007_auth_hook_permissions.sql` grants — nothing wider. Run it against the same
database as `SUPABASE_DB_URL`, as a role that owns the `guard` schema (normally
`postgres`):

```sql
-- Repairs guard's auth-hook grants. Safe to run any number of times, on any database,
-- including one where supabase_auth_admin does not exist or the grants are already
-- correct. Grants only the SECURITY INVOKER call chain guard.before_user_created()
-- needs: no writes, no CREATE, nothing on sync_metadata or schema_migrations.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'supabase_auth_admin') then
    raise notice 'supabase_auth_admin does not exist here; nothing to grant.';
    return;
  end if;

  execute 'grant usage on schema guard to supabase_auth_admin';
  execute 'grant execute on function guard.before_user_created(jsonb) to supabase_auth_admin';
  execute 'grant execute on function guard.is_disposable_domain(text) to supabase_auth_admin';
  execute 'grant execute on function guard.normalize_domain(text) to supabase_auth_admin';
  execute 'grant select on guard.blocked_domains to supabase_auth_admin';
  execute 'grant select on guard.allowed_domains to supabase_auth_admin';
end;
$$;
```

Then confirm it worked:

```bash
supabase-anti-disposable-auth status
```

The grant line must read `✓ Grants: supabase_auth_admin can execute the hook` and the
command must exit `0`.

**The supported alternative** is to drop the `guard` schema and run
`supabase-anti-disposable-auth install` again. That replays the whole migration set
against a database where the role now exists, so 007 takes its granting branch. It
costs the blocked-domain list, which `sync` rebuilds.

> **Do not edit `guard.schema_migrations`, and do not re-run a recorded migration file
> by hand.** Deleting a history row to make `install` replay a migration defeats the
> checksum audit the runner exists to provide, and re-running historical DDL by hand
> can apply it in the wrong order relative to migrations written after it. The snippet
> above changes privileges only and touches no history.

This branch deliberately ships no `repair` command. A general privilege-repair
subsystem is a larger design question — what it may change, what it must refuse to
change, and how it proves it did no harm — and is tracked in
[docs/roadmap.md](docs/roadmap.md).

## The `guard` schema

Everything this tool creates lives in one schema. `public` is never used for
application objects, the `auth` schema is never modified, and `auth.users` is never
touched.

| Object                         | Purpose                                         |
| ------------------------------ | ----------------------------------------------- |
| `guard.blocked_domains`        | Disposable domains, keyed by normalised domain. |
| `guard.allowed_domains`        | Overrides for false positives.                  |
| `guard.sync_metadata`          | Per-source sync state, written by `sync`.       |
| `guard.schema_migrations`      | Applied migrations and their checksums.         |
| `guard.normalize_domain()`     | Domain extraction and canonicalisation.         |
| `guard.is_disposable_domain()` | The policy answer, with allowlist precedence.   |
| `guard.before_user_created()`  | The Supabase auth hook. Delegates to the above. |

### Domain normalisation

Domains are stored in one canonical, lowercase form, so case variants can never become
separate rows:

```text
'MAILINATOR.COM'      -> 'mailinator.com'
' mailinator.com '    -> 'mailinator.com'
'@mailinator.com'     -> 'mailinator.com'
'user@mailinator.com' -> 'mailinator.com'
```

Input that cannot be normalised — `NULL`, empty, whitespace, or an implausible hostname
— yields `NULL`, and the lookup treats that as "not disposable". This is enforced by a
`CHECK` constraint on both tables, not just by application code.

### Allowlist precedence

**The allowlist always wins.** A domain in both tables is allowed:

```sql
insert into guard.blocked_domains (domain) values ('mailinator.com');
select guard.is_disposable_domain('mailinator.com');       -- true
select guard.is_disposable_domain('user@MAILINATOR.com');  -- true
select guard.is_disposable_domain('gmail.com');            -- false

insert into guard.allowed_domains (domain) values ('mailinator.com');
select guard.is_disposable_domain('mailinator.com');       -- false
```

The function never raises for malformed input — it returns `false`. An address that
cannot be parsed must not be rejected by a rule that never matched.

### Migrations

Schema changes are versioned `.sql` files in `migrations/`, applied in order, each in
its own transaction alongside the row that records it. Every file is checksummed: if an
already-applied migration is edited, the next run **fails loudly** instead of
re-applying it or ignoring the change. See
[migrations/README.md](migrations/README.md).

`guard` and `guard.schema_migrations` are bootstrap infrastructure: the runner creates
them before any numbered migration executes, because a migration is only recorded once
its row lands in `guard.schema_migrations`. They are intentionally not represented by a
`001_...` file — such a migration could not record its own application — so the numbered
set starts at `001_create_domain_functions.sql`.

### Privileges

`PUBLIC`, `anon` and `authenticated` get no access to the schema, the tables or the
functions — verified with PostgreSQL's `has_schema_privilege()`,
`has_table_privilege()` and `has_function_privilege()`, which resolve inherited
privileges that reading ACL strings would miss. `supabase_auth_admin` is granted exactly
the read-only chain the hook needs and nothing more; see
[Privileges](#privileges) under the hook section. No function is `SECURITY DEFINER`, and
every function pins `search_path`.

The control that contains the functions is the schema `USAGE` revoke: calling a function
requires `USAGE` on its schema, so without it nothing in `guard` is reachable. The tool
does **not** use `ALTER DEFAULT PRIVILEGES` — the schema-scoped form is a silent no-op
in PostgreSQL, and the role-global form would change privileges outside `guard`. See
[docs/architecture.md](docs/architecture.md) for the detail and
[migrations/README.md](migrations/README.md) for the rule this places on future
migrations.

### Exit codes

| Code | Meaning                                                                     |
| ---- | --------------------------------------------------------------------------- |
| `0`  | Success                                                                     |
| `1`  | Unexpected error (a bug)                                                    |
| `2`  | Configuration error                                                         |
| `3`  | Database connection or query error                                          |
| `4`  | Command is not implemented yet                                              |
| `5`  | Guard layer is absent or damaged (`status`, or a failed preflight)          |
| `6`  | Blocklist sync failed (provider, payload or safety)                         |
| `7`  | Supabase Management API failure (auth, permission, ref, rate limit, outage) |
| `8`  | Before User Created is configured to a different hook                       |
| `9`  | A remote change was accepted but did not take effect                        |

Code `5` is deliberately distinct from `3`. A CI job needs to tell "I could not reach
the database" apart from "I reached it, and the guard layer is not installed" — so a
health verdict never borrows the database error code, and a database error never
reports as a health verdict.

Code `6` is distinct for the same reason. The overwhelmingly likely cause of a sync
failure is outside the database entirely — an unreachable upstream, a truncated
download, or a candidate that failed its safety checks. An operator seeing `3` should
look at their connection string; an operator seeing `6` should look at the provider.

Codes `7`, `8` and `9` cover the three genuinely different ways a remote operation ends
badly, and they are separated because the response to each is different:

- **`7`** — the API refused or could not answer. **Nothing changed.** Fix the token, the
  project ref, or wait for Supabase, then rerun.
- **`8`** — someone else's hook is in the slot. **Nothing changed, and nothing should
  change** until a human decides whether that policy is safe to remove. A CI job should
  route this to a person, not to a retry.
- **`9`** — a change was accepted and the state read back is wrong. **Something may well
  have changed**, into a state nobody chose. Rerunning blindly is the wrong instinct;
  look at the project.

Missing credentials remain `2`, a database health problem remains `5`. Those five
outcomes are never conflated.

## Environment variables

| Variable                | Required by                                          | Description                                            |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| `SUPABASE_DB_URL`       | `doctor`, `install`, `status`, `sync`, `hook enable` | PostgreSQL connection string for your Supabase project |
| `SUPABASE_PROJECT_REF`  | `hook *`; optional for `status`                      | The 20-character project ref from your dashboard URL   |
| `SUPABASE_ACCESS_TOKEN` | `hook *`; optional for `status`                      | Management API access token. **Highest-value secret.** |

Configuration is validated in one place and required **per command**. A missing
Management API credential never breaks a database-only command, and a missing
`SUPABASE_DB_URL` never breaks `hook disable` or `hook status`.

Copy [.env.example](.env.example) to `.env` and fill it in, or export the variables in
your shell. A `.env` file in the working directory is loaded automatically; real
environment variables take precedence.

Keep `sslmode=require` in the connection string. The tool never weakens TLS settings on
your behalf.

`SUPABASE_ACCESS_TOKEN` is the most sensitive value this tool handles — read
[Management API credentials](#management-api-credentials) before you set it, and do not
put it in a shell command where your history file will keep it.

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

- [docs/architecture.md](docs/architecture.md) — architecture and threat model
- [docs/roadmap.md](docs/roadmap.md) — delivery order
- [docs/development.md](docs/development.md) — local setup and workflows

## Security

This is a security tool, so it holds itself to the same standard it enforces:

- **Never commit `.env` or any real credential.** `.env` is gitignored; only
  `.env.example` belongs in version control.
- Connection strings are never logged. Databases are referred to by
  `host:port/database` only.
- **The Management API token leaves the process only as an `Authorization: Bearer`
  header, to a compiled-in HTTPS origin.** Never in a URL, never in a log, never in an
  error, never on disk, never as a process argument, and never to a host you can
  configure. It is redacted out of messages Supabase itself returns and out of any
  diagnostic `cause`, so even `--debug` cannot print it — asserted by tests that drive
  every path with a sentinel token.
- Values sent to PostgreSQL are bound as query parameters, never string-concatenated.
  Migration files are static SQL that ships with the package; no user input is ever
  interpolated into them.
- Secrets are never passed as command-line arguments to other processes.
- Database objects are locked down by default: no privileges for `PUBLIC`, `anon` or
  `authenticated`, no `SECURITY DEFINER`, and a pinned `search_path` on every function.
  `supabase_auth_admin` receives only the read-only call chain the auth hook needs — no
  write privilege on any policy table.
- The auth hook **fails closed**. If the policy engine cannot answer, the signup is
  rejected rather than approved, and the client is told nothing about why.
- Applied migrations are checksum-verified, so an altered historical migration is
  detected rather than silently re-applied.
- Downloaded blocklists are fetched over HTTPS only, with a timeout, a streamed byte
  ceiling and a content-type check, and are never executed, evaluated, written to disk
  or passed to a shell.
- A failed sync never destroys the last known-good blocklist. Stale-but-known-good beats
  fresh-but-wrong.
- **Remote Auth configuration is never overwritten blindly.** A Before User Created hook
  that is not ours is reported as a conflict and left alone, enabled or not. Writes carry
  only this feature's two fields, never a round-tripped copy of your whole Auth
  configuration. Every write is proven by reading the state back, and a mismatch is a
  non-zero exit rather than a success message.
- **Supabase Auth is never pointed at a database hook known to be broken.** `hook enable`
  proves the guard layer works before it sends anything, because the hook fails closed
  and premature activation would reject every signup on the project.

This tool claims **no ownership of any other Supabase Auth setting**. It reads two
fields and writes two fields. Your SMTP configuration, OAuth providers, CAPTCHA keys,
rate limits, session settings and every other hook are outside its remit and are never
modified, and never printed.

Per-concern breakdowns are in
[docs/architecture.md](docs/architecture.md#database-threat-model),
[docs/architecture.md](docs/architecture.md#synchronisation-threat-model) and
[docs/architecture.md](docs/architecture.md#hook-activation-threat-model).

Vulnerability reports: see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
