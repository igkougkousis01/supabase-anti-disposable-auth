# Strict database enforcement (optional)

> **⚠️ Advanced, opt-in, and off by default.** Strict mode attaches one trigger to the
> Supabase-managed `auth.users` table. It **fails closed**: if the guard policy layer
> becomes unavailable, writes to `auth.users` — signups included — are rejected until the
> layer is repaired or strict mode is switched off. Read this whole page before enabling
> it.

Strict mode is a **backstop**, not a replacement for the
[Before User Created hook](auth-hook.md). Most projects should run the hook alone.

## What it is, and what it is not

The **Before User Created hook is the supported primary layer** and the only one that
produces a client-friendly rejection. Strict mode does not replace it, and enabling it is
not a substitute for `hook enable`.

```text
signup with a disposable email
        ↓
Before User Created Hook
        ↓
rejected cleanly, HTTP 403 + a message the client can render
                              (the trigger is never reached)
```

The trigger exists for the writes that never pass through that hook:

```text
auth.users INSERT  /  UPDATE OF email
        ↓
supabase_anti_disposable_auth_strict_email   (BEFORE, FOR EACH ROW)
        ↓
guard.enforce_auth_user_email()
        ↓
guard.is_disposable_domain()
        ↓
allow  /  abort the write
```

Three of those matter in practice:

- a **direct `INSERT`** by an operator, a seed script or a migration;
- an **email change**, which a before-user-_created_ hook structurally cannot see.
  Supabase Auth's `ConfirmEmailChange()` issues an `UPDATE` whose `SET` list contains
  `email`, and only the trigger is in that path;
- any other future or third-party path into the table that does not consult the hook.

Because it is a backstop rather than the user-facing rejection, it **prioritises
integrity over UX**. A rejection here is a raw PostgreSQL error, which Supabase Auth
surfaces to a client as a generic `Database error`. That is acceptable precisely because
it is not the normal path.

## Why it is disabled by default

`install` never switches it on, and `install` never switches it off. Migration `008`
installs `guard.enforce_auth_user_email()`; **no migration creates the trigger.**

```text
install   ≠   enable strict mode
```

The reasons are cumulative:

- **It touches a managed schema.** Supabase states that objects it manages
  "may change at any time", so anything attached to `auth.users` is a standing bet on a
  table this tool does not own.
- **It fails closed.** That is correct for an integrity control and wrong as a default:
  a damaged guard layer would stop signups rather than merely stop filtering them.
- **The supported layer already covers the common case.** With the hook active, a
  disposable signup is rejected before the insert is ever attempted.

A **healthy v1 deployment** is:

```text
guard layer healthy  +  Before User Created hook active  +  strict mode disabled
```

`status` prints strict mode as `○ Disabled (optional)` and exits `0`. Strict mode being
off is never a health failure. Strict mode being **on and broken** is.

## Commands

```bash
supabase-anti-disposable-auth strict status
supabase-anti-disposable-auth strict enable   [--dry-run]
supabase-anti-disposable-auth strict disable  [--dry-run]
```

All three need only `SUPABASE_DB_URL`. No Management API credentials are involved —
nothing about strict mode leaves your database.

`--dry-run` runs the **full** preflight and inspection, prints the plan, and executes
**zero DDL**:

```text
$ supabase-anti-disposable-auth strict enable --dry-run

Supabase Anti-Disposable Auth

Dry run

✓ Connected to PostgreSQL (db.abcdefgh.supabase.co:5432/postgres)
✓ Preflight passed: guard layer and auth.users ready

Strict mode
  Strict mode is currently disabled.

Would create:
  supabase_anti_disposable_auth_strict_email
  BEFORE INSERT OR UPDATE OF email
  ON auth.users

Policy:
  guard.is_disposable_domain(email)

No database changes made.
```

A dry run that would hit a conflict or a failed preflight **reports it and exits
non-zero**, exactly as the real run would. A preview whose verdict differs from the run
it previews is worse than no preview.

## What gets created

Exactly one object, with one fixed, compiled-in name:

```sql
create trigger supabase_anti_disposable_auth_strict_email
  before insert or update of email on auth.users
  for each row execute function guard.enforce_auth_user_email();
```

- The **function lives in `guard`** — never in `auth`, never in `public`.
- **No table, function or type is created in `auth`.** The trigger is the entire
  footprint.
- The name is never generated, suffixed or configurable. The only user-controlled input
  the `strict` commands accept is `--dry-run`; every identifier in the DDL is compiled in.

`UPDATE OF email` is load-bearing. PostgreSQL fires a column-specific trigger only when
the column is listed in the `UPDATE`'s `SET` list, so an update to `raw_user_meta_data`,
`last_sign_in_at` or anything else never reaches the policy engine.

## Behaviour

| Write                                          | Result                   |
| ---------------------------------------------- | ------------------------ |
| `INSERT` with an ordinary address              | allowed                  |
| `INSERT` with a blocklisted domain             | **rejected**             |
| `INSERT` with a blocklisted domain, any casing | **rejected**             |
| domain on the blocklist **and** the allowlist  | allowed (allowlist wins) |
| `email IS NULL`                                | allowed                  |
| `email` empty or whitespace                    | allowed                  |
| address the policy engine cannot parse         | allowed                  |
| `UPDATE ... SET email = <blocklisted>`         | **rejected**             |
| `UPDATE` that does not list `email`            | trigger does not fire    |

**No-email accounts keep working.** `auth.users.email` is nullable in Supabase's own
schema (`email varchar(255) NULL`), and Supabase Auth stores an absent address as SQL
`NULL`, so phone-only, anonymous and SSO-without-email accounts pass straight through.
Blocking them would mean a disposable-_email_ filter silently disabling phone and
anonymous auth — a far worse failure than the one it prevents.

**The policy is not duplicated.** The trigger holds no blocklist lookup, no allowlist
lookup and no normalisation of its own. It delegates every decision to
`guard.is_disposable_domain()`, which stays the single source of truth.

**It only ever evaluates.** It writes nothing, calls nothing over the network, touches no
Management API, and returns `NEW` unchanged. There is no recursion and no side effect.

## Fail-closed, and the availability trade-off

> **⚠️ Read this before enabling strict mode in production.**

If the policy engine cannot answer — a dropped table, a dropped function, a revoked
privilege, a half-removed installation — the error propagates and **the write is
aborted**. There is no `exception when others then return new`, and there never will be:
a policy engine that cannot answer has not said "allow", it has said nothing, and
treating silence as approval would let one revoked grant disable the entire filter while
every signup kept succeeding.

The consequence is honest and unavoidable: **a broken guard layer with strict mode on
stops writes to `auth.users`.** That is the trade this mode makes, and it is why it is
optional.

The rollback path is deliberately kept open at exactly that moment:

```bash
supabase-anti-disposable-auth strict disable
```

`strict disable` performs **no guard-health preflight**. It reads one catalog row and
issues one `DROP TRIGGER`, so it works even when the guard schema is the thing that is
broken — or gone entirely.

`status` refuses to report that state calmly:

```text
Strict database enforcement
✗ Strict mode is ENABLED and the policy layer it calls is damaged.
  The trigger fails closed, so writes to auth.users are failing now.
  Either repair the guard layer, or run `supabase-anti-disposable-auth strict disable` to stop the
  rejections while you do — disabling first is the safe order.
```

## Existing triggers on `auth.users`

Supabase itself documents adding triggers to `auth.users` — the `on_auth_user_created`
pattern that populates a `public.profiles` row is the canonical example. Those are **none
of this tool's business** and are never read, altered, reordered or removed. `strict
enable` and `strict disable` operate on one trigger, identified by one fixed name.

If a trigger already exists under **our** name and is not the one we create, that is a
**conflict**, and both commands refuse:

```text
✗ A trigger named supabase_anti_disposable_auth_strict_email already exists on auth.users
  and is not the one this tool creates: it runs public.noop() instead of
  guard.enforce_auth_user_email(); its timing or events differ from BEFORE INSERT OR
  UPDATE ... FOR EACH ROW (pg_trigger.tgtype is 7, expected 23); it has no UPDATE OF
  column filter, so it fires on every column update instead of only email
Refusing to create it. Inspect it with `select pg_get_triggerdef(oid) from pg_trigger
where tgname = 'supabase_anti_disposable_auth_strict_email'`, decide whether it should
survive, and remove it by hand if it should not.
```

Exit code `10`. There is no `--force`, and there is no `DROP TRIGGER IF EXISTS` followed
by a recreate — that pattern is exactly how somebody else's trigger gets destroyed
without anybody being asked.

Ownership is established from the catalog (`pg_trigger.tgfoid`, `tgtype`, `tgattr`,
`tgenabled`, `tgconstraint`, `tgqual`), never by string-matching
`pg_get_triggerdef()`. A trigger switched off by hand with
`ALTER TABLE ... DISABLE TRIGGER` is reported as a conflict too: it enforces nothing, so
calling it "enabled" would be a lie, and re-enabling it would overwrite a decision
somebody made on purpose.

## Trigger firing order

PostgreSQL fires triggers of the same kind **in alphabetical order by name**. This tool
does not attempt to control that, does not reorder your triggers, and deliberately does
not pick a name like `a_` or `zz_` to force itself first or last. If ordering matters in
your project, it is yours to manage.

## State machines

`strict enable`:

| Current state                                    | Outcome                          |
| ------------------------------------------------ | -------------------------------- |
| no trigger, everything ready                     | creates the trigger, verifies it |
| our trigger already present and correct          | **no-op success** — no duplicate |
| our name, different function / events / column   | **conflict**, exit `10`          |
| our name, disabled by hand                       | **conflict**, exit `10`          |
| `auth.users` missing                             | preflight failure, exit `5`      |
| `email` column missing or not a text type        | preflight failure, exit `5`      |
| `guard.enforce_auth_user_email()` not installed  | preflight failure, exit `5`      |
| guard policy layer unhealthy                     | preflight failure, exit `5`      |
| no `USAGE` on `auth` / no `TRIGGER` on the table | preflight failure, exit `5`      |

`strict disable`:

| Current state             | Outcome                                   |
| ------------------------- | ----------------------------------------- |
| our trigger present       | drops it, verifies its absence            |
| no trigger                | **already disabled** — success, exit `0`  |
| our name, not our trigger | **conflict**, exit `10` — nothing dropped |

Both commands prove the result by **reading the catalog back** after the DDL. A statement
that did not raise is not a state that exists.

## Privileges

Creating and dropping the trigger is an **operator action**, performed by the role behind
`SUPABASE_DB_URL` (`postgres` on Supabase). The preflight checks `USAGE` on `auth` and
`TRIGGER` on `auth.users` before attempting any DDL, and refuses clearly rather than
letting PostgreSQL raise.

**No new grant is issued to anybody, and none is needed.** The trigger function is
`SECURITY INVOKER`, so it runs with the privileges of whoever is writing to `auth.users`
— which for Supabase Auth is `supabase_auth_admin`, and which migration `007` already
gave exactly:

```text
USAGE  on schema guard
EXECUTE on guard.is_disposable_domain(text)
EXECUTE on guard.normalize_domain(text)
SELECT  on guard.blocked_domains
SELECT  on guard.allowed_domains
```

PostgreSQL checks `EXECUTE` on a trigger function when the **trigger is created**, not
when it fires, so `supabase_auth_admin` needs no `EXECUTE` on
`guard.enforce_auth_user_email()` — and is deliberately not given one. Nothing is granted
to `PUBLIC`, `anon` or `authenticated`.

`SECURITY INVOKER` was chosen on its merits, not by default. Supabase's general advice
for `auth.users` triggers is `SECURITY DEFINER`, because the problem it addresses is that
`supabase_auth_admin` has no privileges outside `auth`. That problem does not exist here,
and `DEFINER` would make things worse in two ways: it would run the function as the guard
owner on every write to `auth.users`, and it would **weaken the fail-closed guarantee** —
a writer that cannot reach the policy engine would sail through on the owner's privileges
instead of being stopped. The `guard` schema remains free of `SECURITY DEFINER`, which an
integration test asserts.

## Managed-schema risk

`auth` belongs to Supabase, and Supabase says its managed objects
"may change at any time". Strict mode's exposure is deliberately as small as it can be:

- **one** trigger on `auth.users`, and nothing else in `auth`;
- the function lives in `guard`, so an `auth` schema change cannot take it with it;
- the `email` column's existence and type are **verified** before the trigger is created,
  rather than assumed;
- the supported hook remains the primary layer, so strict mode can be switched off at any
  time without losing protection.

That exposure is real but bounded, and it is the reason this mode is advanced and
optional rather than on by default.

## Performance

The trigger runs in the write path. Its hot path is:

```text
NEW.email  →  guard.is_disposable_domain()  →  at most two primary-key lookups
```

No HTTP, no provider fetch, no sequential scan, no logging table, no new index.

Measured on PostgreSQL 14 with a **120,000-domain blocklist** (the order of magnitude of
the real upstream list), on a local server:

| Path                       | Cost             |
| -------------------------- | ---------------- |
| insert with the trigger    | ~28 µs / row     |
| insert without the trigger | ~2 µs / row      |
| **added by strict mode**   | **~26 µs / row** |
| rejected write             | ~65 µs / row     |

`EXPLAIN` confirms an **Index Only Scan** on `blocked_domains_pkey`, ~6 shared buffer
hits per evaluation. No additional index is justified: every lookup is an exact equality
match on the normalised primary key, which the implicit unique btree already serves
optimally.

Against network round-trips and password hashing in a real signup, ~26 µs is not
measurable. These numbers are from a local scratch database and are indicative, not a
guarantee for your hardware.

## Safe removal order

If strict mode and the Auth hook are both on, `uninstall` applies this order:

```bash
supabase-anti-disposable-auth uninstall --dry-run
supabase-anti-disposable-auth uninstall --yes
```

Steps 1 and 2 are interchangeable in principle — neither depends on the other — but
strict mode first is the safer habit: it is the layer that blocks writes rather than
merely filtering them.

Database cleanup last is **not** optional. Dropping `guard` while the hosted hook is
still switched on leaves Auth calling an absent function and every signup fails. The
command never uses `CASCADE`; it verifies and explicitly removes its trigger and guard
objects, and refuses foreign dependencies.
