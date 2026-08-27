# Security Policy

## Project status

This project is in early development. The CLI, the `guard` database schema, manual
blocklist synchronisation and the **Before User Created hook function** exist.

**Installing the hook function does not switch protection on.** Supabase Auth must be
configured to call it, which this version does not automate and cannot observe. Until an
operator does that, no signup is filtered. There is no released version and no supported
production deployment.

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

Out of scope: vulnerabilities in Supabase, PostgreSQL, or third-party dependencies.
Report those to their respective maintainers.

The **content** of the upstream disposable-domain dataset is also out of scope — a
domain wrongly present on or absent from that list is an upstream data issue, not a
vulnerability here. A way to make this tool install a dataset that should have been
refused, or to make a failed sync destroy the installed blocklist, very much is in
scope.

## Handling secrets

If you are reporting an issue, **never include a real connection string, password,
service-role key, or JWT** in the report. Redact them.

The tool is designed so that this should not happen by accident:

- database credentials are never written to logs or to disk by the CLI,
- databases are identified in output as `host:port/database` only,
- secrets are never passed as command-line arguments to other processes,
- all values sent to PostgreSQL are bound as query parameters.

If you find a code path that breaks any of these, treat it as a vulnerability and report
it privately.
