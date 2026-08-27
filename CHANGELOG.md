# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Versioning policy.** The public interface covered by SemVer is the **CLI**: command
names, flags, output contracts and [exit codes](README.md#exit-codes). The small
programmatic API exported from the package entry point is covered too. Deep imports into
`dist/` internals are not, and neither is the exact prose of human-readable output.

**Release process.** `## [Unreleased]` accumulates changes as they land on `main`. At
release time its contents move under a new version heading dated with the day the tag is
actually pushed — dates are never written ahead of time.

## [Unreleased]

Nothing yet.

## [1.0.0] — unreleased

First stable release. Nothing to upgrade from: earlier `0.x` builds were never published
to npm, so there is no migration path to document.

### Added

- **Database policy engine.** A dedicated `guard` schema holding the blocklist,
  allowlist, sync metadata and migration history, plus `guard.normalize_domain()` and
  `guard.is_disposable_domain()` — one canonical domain form, and allowlist precedence
  over the blocklist. Applied through versioned SQL migrations whose checksums are
  verified on every run, so an edited historical migration fails loudly instead of being
  silently re-applied.
- **Safe manual blocklist sync.** `sync` downloads the upstream disposable-domain list
  over HTTPS only, with a request timeout, manual redirect handling, a streamed byte
  ceiling and a content-type allowlist; validates and normalises every entry; refuses
  candidates that fail suspicious-update thresholds; and replaces the installed set
  differentially inside a single transaction under an advisory lock. A failed sync never
  destroys the last known-good list. `--dry-run` reports the exact delta and writes
  nothing.
- **Before User Created auth hook.** `guard.before_user_created(jsonb)` implements
  Supabase's hook contract, delegates every policy decision to
  `guard.is_disposable_domain()`, allows signups that carry no email (phone-only,
  anonymous, SSO-without-email), rejects payloads that violate the contract, and **fails
  closed** — an unavailable policy layer rejects rather than admits, with nothing
  disclosed to the client.
- **Hosted hook activation.** `hook enable`, `hook disable` and `hook status` configure
  Supabase Auth through the Management API. Activation refuses to overwrite a hook it
  did not install, runs a database preflight before any write, sends only its own two
  fields, and proves every change with a fresh read rather than trusting HTTP 200.
- **Optional strict database enforcement.** `strict enable` / `disable` / `status`
  manage a single opt-in trigger on `auth.users` that also covers email changes. Off by
  default, never created by `install` or by a migration, catalog-verified before any
  DDL, and never applied over a trigger this tool did not create.
- **Repair and safe uninstall.** `repair` restores only provable drift — missing leaf
  functions and the fixed grant set — and never replays a migration, rewrites history,
  recreates a data table or turns enforcement on. `uninstall` removes strict mode, then
  disables and verifies the hosted hook, then cleans up the database, verifying
  ownership of every object first. No `CASCADE`, no force flag, and `--yes` is
  confirmation evaluated after every safety check rather than an override.
- **Security hardening throughout.** Parameterised SQL and compiled-in identifiers
  everywhere; no `SECURITY DEFINER` and a pinned `search_path` on every function; no
  privileges for `PUBLIC`, `anon` or `authenticated`; least-privilege grants for
  `supabase_auth_admin`; the Management API token confined to an `Authorization` header
  bound to a compiled-in origin and redacted out of every message, including `--debug`.
- **Dry runs and stable exit codes** across every command that can change something, so
  the tool is safe to drive from CI.

[unreleased]: https://github.com/igkougkousis01/supabase-anti-disposable-auth/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/igkougkousis01/supabase-anti-disposable-auth/releases/tag/v1.0.0
