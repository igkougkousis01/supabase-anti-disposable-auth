## What this changes

<!-- One or two sentences. What behaviour is different after this than before it? -->

## Why

<!-- The reasoning, not just the change. If you rejected a safer-looking alternative,
say which and why — that is the part reviewers cannot reconstruct later. -->

## How it was verified

<!-- Which tests you added or changed, and anything you ran by hand. -->

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run format:check`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run test:integration` against a scratch database (`SADA_TEST_DB_URL`), if this
      touches SQL, the database layer or the lifecycle commands

## Checklist

- [ ] Behaviour changes have tests that fail without this change
- [ ] Documentation updated in this pull request, including the README's exit-code and
      environment-variable tables if either changed
- [ ] `CHANGELOG.md` updated under `## [Unreleased]`, unless this is docs-only
- [ ] No applied migration (`001`–`008`) was edited; any SQL fix is a new migration
- [ ] No new grant to `PUBLIC`, `anon` or `authenticated`; no `SECURITY DEFINER`; no
      `CASCADE` in a production path
- [ ] No credential, connection string or foreign hook URI can reach the output — including
      under `--debug`
- [ ] No test path can read `SUPABASE_DB_URL`

## Related issues

<!-- Closes #123 -->
