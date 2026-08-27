# Security Policy

## Project status

This project is in early development. The CLI, the `guard` database schema, manual
blocklist synchronisation, the **Before User Created hook function**, **hosted hook
activation through the Supabase Management API** and an **optional strict trigger mode**
exist. Strict mode is off by default and is not a substitute for the hook.

**Installing the hook function still does not switch protection on.** Supabase Auth must
be configured to call it — by `hook enable`, the dashboard, or `config.toml`. Until that
happens, no signup is filtered. There is no released version and no supported production
deployment.

| Version | Supported                |
| ------- | ------------------------ |
| `0.1.x` | Pre-release, best effort |

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private vulnerability reporting on this repository:
**Security → Report a vulnerability**. If that option is not visible, open a regular
issue that contains no exploit details and simply asks a maintainer to open a private
channel.

There is no dedicated security contact address for this project yet. When one exists it
will be listed here.

Please include, as far as you can:

- what the issue is and where in the code it lives,
- steps or a minimal reproduction,
- the impact you believe it has.

Expect an acknowledgement as soon as a maintainer sees the report. This is a
volunteer-maintained project, so there is no guaranteed response time.

## Scope

In scope: anything in this repository — the CLI, the database access layer, and the SQL
objects it installs into your project, including the auth hook.

Security properties of the hook that are explicitly in scope, and worth reporting if you
can break any of them:

- **It fails closed.** A way to make the hook return allow when the policy engine cannot
  answer — a dropped object, a revoked privilege, any error — is a vulnerability.
- **It cannot be made to allow a blocked domain.** Any input that reaches allow while
  `guard.is_disposable_domain()` would say true is a vulnerability. Note that the
  allowlist deliberately wins over the blocklist; that is the intended rule, not a bypass.
- **It leaks nothing to the signup client.** Any path by which a table name, function
  name, provider, `SQLSTATE`, or the blocklist's contents reach a client is a
  vulnerability. So is any way to use signup responses to enumerate the blocklist beyond
  the single bit that a rejection unavoidably reveals about the address just submitted.
- **It grants no more than it needs.** A way for `supabase_auth_admin` to write to the
  policy tables, or for `PUBLIC` / `anon` / `authenticated` to execute the hook or read
  the lists, is a vulnerability.
- **It cannot be turned into an escalation primitive.** The hook is `SECURITY INVOKER`
  with a pinned `search_path`; a way to make it execute with the owner's privileges, or
  to redirect what its identifiers resolve to, is a vulnerability.
- **It has no side effects.** A way to make invoking the hook write data, take a lock, or
  reach the network is a vulnerability.
- **It refuses payloads that violate its contract.** The hook allows only what Supabase
  Auth can actually send: a `user.email` that is absent, `null` or a string. A payload
  that gets a non-string `user.email` — or a non-object `event` — past the gates and
  into an allow is a vulnerability, because the address was never checked.

Out of scope for the hook: that a **phone-only or anonymous signup is not blocked**. The
hook allows every signup that carries no email, deliberately — this tool enforces
disposable-_email_ policy only where an email exists, and blocking email-less flows
would silently disable phone and anonymous auth. Likewise, that installing the tool
without activating the hook filters nothing is documented behaviour, not a flaw.

Security properties of **hook activation** that are in scope:

- **The Management API token never leaves an `Authorization` header.** Any path that puts
  it in a URL, a log line, an error message, a file, a process argument, or a request to
  any host other than `api.supabase.com` is a vulnerability. So is any input — flag,
  environment variable, config file, redirect — that can redirect an authenticated
  request somewhere else. So is any way to get it into `--debug` output, including
  through a server-supplied message or an attached diagnostic `cause`.
- **It never overwrites a hook it did not install.** Any input or remote state that makes
  `hook enable` or `hook disable` change a Before User Created URI that is not
  `pg-functions://postgres/guard/before_user_created` is a vulnerability — including when
  that hook is currently disabled.
- **It never modifies an Auth setting outside its two fields.** Any path that writes
  more than `hook_before_user_created_enabled` and `hook_before_user_created_uri` is a
  vulnerability, because it would rewrite unrelated settings — and other people's secrets
  — with stale values.
- **It never prints the Auth configuration.** That document contains SMTP passwords,
  OAuth client secrets, SMS provider tokens and hook signing secrets. Any way to get any
  of them onto a terminal, including through a validation or parse error, is a
  vulnerability. So is any way to get a foreign HTTP hook's path, query string or
  userinfo printed in a conflict message.
- **It never claims success it did not verify.** Any path where a command reports the
  hook enabled or disabled without a fresh read confirming the exact state, or where a
  failed verification exits zero, is a vulnerability.
- **It never activates a database hook known to be broken.** Any way to reach a PATCH
  without either a passing database preflight or an explicit `--skip-db-check` is a
  vulnerability. The hook fails closed, so this would reject every signup on the project.
- **`status` never overstates.** Any output that reads as an activation or protection
  claim without that state having been observed — including inferring activation from the
  function existing, or downgrading a failed remote check to "not checked" — is a
  vulnerability.

Out of scope for activation: that a **conflict refuses rather than replacing** an
existing hook is deliberate, not a denial of service — replacing an authentication policy
somebody installed is an operator decision. That `--skip-db-check` allows an operator to
activate an unverified hook is likewise documented behaviour with a warning, not a flaw.

Security properties of **strict trigger mode** that are in scope:

- **It stays opt-in.** Any path by which `install`, a migration, or any command other than
  `strict enable` creates a trigger on `auth.users` is a vulnerability. The database is
  meant to sit indefinitely with the function installed and the trigger absent.
- **It fails closed.** A way to make a write to `auth.users` succeed while the policy
  engine could not answer — a dropped table or function, a revoked privilege, a
  half-removed installation — is a vulnerability. This is the property with no exception
  handler behind it, deliberately.
- **It cannot be made to allow a blocked domain.** Any `INSERT` or `UPDATE OF email` that
  lands a row whose domain `guard.is_disposable_domain()` would call disposable is a
  vulnerability. The allowlist beating the blocklist is the intended rule, not a bypass.
- **It never destroys a trigger it did not create.** Any input, flag or remote state that
  makes `strict enable` or `strict disable` drop, replace or alter a trigger that is not
  the one this tool creates — including one that merely shares its name — is a
  vulnerability. So is any way to make it read, reorder or modify an unrelated trigger on
  `auth.users`.
- **It accepts no identifier from the user.** Trigger, table, column and function names
  are compiled in. Any way to influence the DDL — through a flag, an environment variable,
  a config file, or a value read back out of the database — is a vulnerability.
- **It cannot be turned into an escalation primitive.** The trigger function is
  `SECURITY INVOKER` with a pinned `search_path` and no dynamic SQL. A way to make it run
  with the owner's privileges, or to redirect what its identifiers resolve to, is a
  vulnerability. So is any grant on it reaching `PUBLIC`, `anon` or `authenticated`.
- **It has no side effects.** A way to make the trigger write to any table, take a lock,
  reach the network, or recurse is a vulnerability.
- **It leaks nothing.** The rejection message is a fixed literal. Any path that puts a
  domain, an address, a table name, a provider or a checksum into it is a vulnerability.
- **`status` never overstates.** Reporting strict mode as enabled when the trigger is
  absent, disabled by hand, or pointing at another function is a vulnerability.

Out of scope for strict mode: that **enabling it against a damaged guard layer stops
writes to `auth.users`** is the documented, intended fail-closed behaviour and not a
denial of service — `strict enable` refuses on a failed preflight, `status` reports the
state loudly, and `strict disable` needs no guard-schema access to reverse it. That a
**name conflict refuses rather than overwriting** is likewise deliberate. And, as with the
hook, that a **phone-only or anonymous account with no email is not blocked** is intended:
`auth.users.email` is nullable and this tool enforces disposable-_email_ policy only where
an email exists.

Out of scope: vulnerabilities in Supabase, PostgreSQL, or third-party dependencies.
Report those to their respective maintainers.

The **content** of the upstream disposable-domain dataset is also out of scope — a
domain wrongly present on or absent from that list is an upstream data issue, not a
vulnerability here. A way to make this tool install a dataset that should have been
refused, or to make a failed sync destroy the installed blocklist, very much is in
scope.

## Handling secrets

If you are reporting an issue, **never include a real connection string, password,
service-role key, JWT, or Management API access token** in the report. Redact them.

The tool is designed so that this should not happen by accident:

- database credentials are never written to logs or to disk by the CLI,
- databases are identified in output as `host:port/database` only,
- the Management API access token is sent only as an `Authorization: Bearer` header to a
  compiled-in HTTPS origin, and is redacted out of server messages and diagnostic causes
  so that even `--debug` cannot print it,
- secrets are never passed as command-line arguments to other processes,
- all values sent to PostgreSQL are bound as query parameters.

`SUPABASE_ACCESS_TOKEN` deserves particular care on your side too. A personal access
token carries the privileges of your entire Supabase account across every project it can
reach. Keep it in `.env` (gitignored) or a secret manager, never on a command line where
your shell history will retain it, and revoke it at
<https://supabase.com/dashboard/account/tokens> if you suspect exposure.

If you find a code path that breaks any of these, treat it as a vulnerability and report
it privately.
