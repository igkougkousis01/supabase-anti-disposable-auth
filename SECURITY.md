# Security Policy

## Project status

This project is in early development. The CLI, the `guard` database schema and manual
blocklist synchronisation exist; the Supabase auth hook does not, so no signup is
filtered yet. There is no released version and no supported production deployment.

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

In scope: anything in this repository — the CLI, the database access layer, and (once
they exist) the SQL objects it installs into your project.

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
