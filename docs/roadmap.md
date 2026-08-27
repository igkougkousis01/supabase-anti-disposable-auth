# Roadmap

Where the project is, what was deliberately left out of 1.0, and what might come after.

## Shipped in 1.0

Everything below is implemented, tested and documented.

| Area                      | What shipped                                                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI foundation            | TypeScript build, Zod-validated configuration in one place, `pg` lifecycle, error hierarchy, stable exit codes, dependency-injected logger                                          |
| Database policy engine    | `guard` schema, versioned checksum-verified migrations, `normalize_domain()`, `is_disposable_domain()` with allowlist precedence                                                    |
| Blocklist synchronisation | HTTPS-only fetch with timeout, streamed byte ceiling, redirect and content-type controls; suspicious-update thresholds; atomic differential replacement; advisory lock; `--dry-run` |
| Before User Created hook  | `guard.before_user_created(jsonb)`, `SECURITY INVOKER`, fails closed, leaks nothing to the client, least-privilege grants                                                           |
| Hosted activation         | Narrow Management API client, conflict refusal, database preflight, minimal PATCH, post-write verification, `--dry-run` on every mutation                                           |
| Strict trigger mode       | Opt-in `auth.users` backstop covering `UPDATE OF email`, catalog-verified ownership, never overwrites a foreign trigger, off by default                                             |
| Lifecycle safety          | Five-state `repair`, ownership-verified `uninstall` with cross-system ordering, `--database-only`, confirmation gating, no `CASCADE`, no force                                      |
| Verification              | 700+ unit tests and 250+ PostgreSQL integration tests, plus sentinel-token leak tests, a migration freeze test and documentation-contract tests                                     |

The per-branch delivery history is in the Git log; each feature landed as one reviewed
pull request (`#1`–`#6`).

## Deliberately not in 1.0

These are decisions, not gaps.

### Why there is no scheduler in 1.0

Blocklist refresh is manual: it happens when an operator runs `sync`, and never
otherwise.

The Node sync pipeline includes network safety controls — HTTPS enforcement on every
redirect hop, a request timeout, a streamed byte ceiling, a content-type allowlist,
parse validation and suspicious-update thresholds — that `pg_cron` cannot invoke
directly. Reimplementing them in SQL would duplicate security-critical logic in a second
language, where it would drift from the original. Adding an HTTP bridge so the database
could call out instead would create a new execution surface inside the project's
database, which is precisely the kind of thing this tool exists to avoid adding.

Scheduled refresh is therefore deferred until it can be done without either compromise.
In the meantime, `sync` runs cleanly from any scheduler you already trust — cron, a CI
job, a deploy step — and a failed refresh never destroys the installed list.

### Other deferrals, and the reason for each

- **Allowlist management commands.** Adding and removing allowlisted domains is two
  `INSERT`/`DELETE` statements against a documented table. A command surface for it
  would be new API to support for a job SQL already does well.
- **Additional blocklist providers.** One well-maintained upstream, compiled in, is a
  smaller attack surface than a provider registry. A configurable source URL would turn
  the tool into a fetch-and-execute primitive pointed wherever an attacker likes.
- **Retries.** A `GET` can be retried safely and a `PATCH` cannot. Post-write
  verification, not a retry layer, is what protects against an ambiguous outcome.
- **Interactive confirmation prompts** on mutating commands. They are already explicitly
  named, already have `--dry-run`, and prompts make CI use awkward. `uninstall` is the
  exception and uses an explicit `--yes` flag rather than a prompt.
- **Editing `supabase/config.toml`.** Local activation is a user-owned file. There is no
  safe, explicit mechanism for rewriting one, and inventing one to save a four-line paste
  would be the wrong trade.
- **Live hosted mutation tests.** Every state transition is covered against a mocked
  Management API. Nothing in the test suite writes to a real Auth configuration.
- **A `--force` escape** for trigger, hook or ownership conflicts. There is no safe
  default for "destroy the thing somebody else created", and offering one would put the
  dangerous path a flag away.

## After 1.0

Candidates, in rough order of usefulness. None is committed.

1. **Scheduled refresh**, if it can be built without duplicating the safety controls or
   adding an execution surface to the database. The most likely shape is documentation
   and a supported container/CI recipe rather than `pg_cron`.
2. **Stronger hosted end-to-end coverage** — a disposable-signup test against a real
   throwaway Supabase project, gated and never run in normal CI.
3. **Freshness reporting in `status`** — how old the installed blocklist is, read from
   `guard.sync_metadata`, so a stale list is visible without querying by hand.
4. **Usability polish** — machine-readable output for `status`, if a concrete consumer
   asks for it.

Feature requests belong in
[GitHub issues](https://github.com/igkougkousis01/supabase-anti-disposable-auth/issues).
