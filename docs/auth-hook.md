# The Before User Created hook

How Supabase Auth is made to call the guard policy engine, what the hook function
guarantees, how activation works, and how to take it back out.

> Installing the hook function is **not** the same as switching protection on. `install`
> creates `guard.before_user_created()`; Supabase Auth still has to be told to call it.
> That is `hook enable`, the dashboard, or `config.toml` — never a side effect of a
> migration.

## The hook function

Supabase's **Before User Created** hook lets a PostgreSQL function inspect a signup
before the user row is created, and reject it. `install` creates that function:

```sql
guard.before_user_created(event jsonb) returns jsonb
```

Supabase Auth invokes it as `select "guard"."before_user_created"($1)` inside the same
transaction that would create the user, under a 2-second `statement_timeout`.

### Input

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

### Output

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

### Behaviour

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

### Phone-only and anonymous signups are not blocked

Supabase serialises a user's email as an empty string when there is none, so a
phone-only or anonymous signup arrives as `"email": ""`. **Those are allowed.**

This is a deliberate **fail-open for the absence of an email**. It is not a fail-open
for the policy engine — that is the opposite decision, below. "There is nothing to
check" and "the check did not work" are different events and are answered differently.

This tool enforces disposable-**email** policy only when an email exists. Phone-only and
anonymous flows are outside its scope and must not become collateral damage from a
disposable-email filter.

### A non-string email is rejected, not treated as "no email"

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

### Infrastructure failure fails closed

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

### Privileges

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

### The hook is side-effect free

Invoking it modifies no blocked domain, no allowed domain, no sync metadata, no
`auth.users` row; it creates nothing and calls no remote service. It evaluates and
returns a decision. Asserted by an integration test that snapshots every table across
all six branches of the function.

## Activating the hook

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

### Locally, with the Supabase CLI

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

### On a hosted project

Either through the dashboard — **Authentication → Hooks → Before User Created**, select
the Postgres function `guard.before_user_created`, enable it — or with one command:

```bash
supabase-anti-disposable-auth hook enable
```

## The `hook` commands

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

### Management API credentials

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
never appears in the output. See [SECURITY.md](../SECURITY.md).

### `hook enable`

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

#### The database preflight

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

#### `--skip-db-check`

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

#### Idempotence

A project that is already correct is a success with no PATCH at all:

```text
✓ Before User Created hook already enabled
✓ URI matches expected database function
  pg-functions://postgres/guard/before_user_created

No remote changes were needed.
```

#### Configuration conflict

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

#### Post-write verification

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

#### What it sends

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

### `hook disable`

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

### `hook status`

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

### Dry run

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

### Is there a confirmation prompt?

No, and that is deliberate. `hook enable` is already an explicitly named mutation
command, `--dry-run` gives you a preview whenever you want one, and a prompt would make
the command awkward to run from CI for no real safety gain. The protections that matter
here are structural — the preflight, the conflict refusal, and the post-write
verification — not a keystroke.

## Troubleshooting

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

## Removing the hook

For a full removal, use the ownership-checked workflow rather than manual DDL:

```bash
supabase-anti-disposable-auth uninstall --dry-run
supabase-anti-disposable-auth uninstall --yes
```

The command enforces the full ordering described under [`uninstall`](commands.md#uninstall):
strict trigger first, hosted hook disable and verification second, explicit database
cleanup last.

On a local stack, step 1 is removing the `[auth.hook.before_user_created]` block from
`config.toml` and restarting.

Doing it the other way round leaves Supabase Auth calling a function that no longer
exists, and **every signup fails** until the configuration catches up. This is why
`hook disable` needs no database access at all: the step that stops the bleeding must
work even when the database does not.

Manual `hook disable` remains useful when enforcement must be paused without deleting
data. It intentionally leaves all database objects in place.

## Repairing the auth hook grants

There is one situation where `status` correctly reports missing grants and `install`
correctly refuses to fix them. It is worth understanding before reaching for the
snippet below.

### How a database ends up here

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
   safe to run repeatedly. See [migrations/README.md](../migrations/README.md).

So the database is left in a state where the hook function exists, the role exists, and
the role cannot execute it.

**`status` reports this.** It probes every required privilege with
`has_*_privilege()` rather than trusting the migration history, names each missing
grant, marks the installation `incomplete`, and exits non-zero. The gap is visible
before the hook is activated, which is the point at which it would start rejecting
every signup.

### How likely is this in practice?

**Uncommon.** Both hosted Supabase projects and `supabase start` provision
`supabase_auth_admin` as part of the platform, long before this tool is installed, so a
normal installation grants correctly on the first run. The realistic ways to land here
are a plain PostgreSQL database that later had Supabase roles added, a restore into a
cluster whose roles were not restored with it, or a scratch database used for
development.

### The remediation

Preview and apply the fixed least-privilege repair:

```bash
supabase-anti-disposable-auth repair --dry-run
supabase-anti-disposable-auth repair
```

Repair grants exactly `USAGE` on `guard`, `EXECUTE` on the hook and its two called
functions, and `SELECT` on the blocklist and allowlist. It grants no write privilege,
no `CREATE`, and no access to `sync_metadata` or `schema_migrations`. If the role is
absent, it reports `manual-action-required` and changes nothing.

> **Do not edit `guard.schema_migrations`, and do not re-run a recorded migration file
> by hand.** Deleting a history row to make `install` replay a migration defeats the
> checksum audit the runner exists to provide, and re-running historical DDL by hand
> can apply it in the wrong order relative to migrations written after it. `repair`
> changes current catalog state only and leaves the append-only evidence untouched.
