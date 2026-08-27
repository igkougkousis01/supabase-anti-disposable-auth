# Releasing

The manual release procedure. There is deliberately **no workflow that publishes to npm
automatically** — see [Why publishing is manual](#why-publishing-is-manual).

Every step below is run by a maintainer, from a clean checkout, in order.

## Before you start

- You are on `main`, up to date, with a clean working tree.
- `CHANGELOG.md` has an entry for the version you are about to release, and its heading
  carries the real date.
- You have npm publish rights for the package and 2FA configured.

## 1. Clean install

```bash
git switch main
git pull
git status --porcelain        # must print nothing
rm -rf node_modules
npm ci
```

## 2. Full quality gate

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

All five must pass. Then the database suite, against a scratch database — never a real
project:

```bash
createdb supabase_anti_disposable_auth_test
psql -d supabase_anti_disposable_auth_test -c \
  "create role supabase_auth_admin nologin; create role anon nologin; create role authenticated nologin"

SADA_TEST_DB_URL="postgresql://localhost:5432/supabase_anti_disposable_auth_test" \
  npm run test:integration
```

The roles matter: without them the privilege-boundary tests skip themselves and the run
is green for the wrong reason.

## 3. Dependency audit

```bash
npm audit
npm outdated
```

Resolve anything security-relevant. Do **not** take major upgrades as part of a release;
they belong in their own reviewed pull request.

## 4. Verify the package contents

```bash
npm pack --dry-run
```

Check the file list. It must contain `dist/`, `migrations/` (all eight `.sql` files plus
their README), `README.md`, `CHANGELOG.md`, `SECURITY.md`, `LICENSE` and
`package.json` — and nothing else. No `.env`, no coverage, no test fixtures, no tarballs.

## 5. Smoke-test the packed artifact

Never publish something you have only run from the source tree.

```bash
npm pack                                   # produces supabase-anti-disposable-auth-<version>.tgz
TARBALL="$PWD/$(ls supabase-anti-disposable-auth-*.tgz)"

mkdir -p /tmp/sada-smoke && cd /tmp/sada-smoke
npm init -y >/dev/null
npm install "$TARBALL"

npx supabase-anti-disposable-auth --version   # must print the version you are releasing
npx supabase-anti-disposable-auth --help
npx supabase-anti-disposable-auth doctor      # exits 2 without SUPABASE_DB_URL: correct

# Against the scratch database, prove the migrations shipped:
SUPABASE_DB_URL="postgresql://localhost:5432/supabase_anti_disposable_auth_test" \
  npx supabase-anti-disposable-auth install
```

Then clean up:

```bash
cd - && rm -rf /tmp/sada-smoke && rm -f supabase-anti-disposable-auth-*.tgz
```

## 6. Verify the version

```bash
node -p "require('./package.json').version"
node dist/cli.js --version
```

Both must agree. The CLI reads the version from `package.json` at runtime, so there is
only ever one place to change it.

## 7. Commit the release

```bash
git switch -c release/vX.Y.Z
# bump "version" in package.json and package-lock.json, date the CHANGELOG heading
npm install --package-lock-only          # keeps the lockfile version in step
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: release vX.Y.Z"
git push -u origin release/vX.Y.Z
```

Open a pull request, let CI pass, and merge it.

## 8. Tag

```bash
git switch main && git pull
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

Tag only a commit that is already on `main` and already green in CI.

## 9. Publish to npm

```bash
npm publish --access public --provenance
```

`--provenance` requires publishing from a workflow with an OIDC identity. Publishing
from a laptop, omit it:

```bash
npm publish --access public
```

`prepublishOnly` runs the build, so `dist/` is always rebuilt from the tagged source.

## 10. Create the GitHub Release

Use the draft in [`docs/releases/`](releases/) as the body:

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file docs/releases/vX.Y.Z.md
```

## 11. Verify from the registry

The last step, and not an optional one:

```bash
mkdir -p /tmp/sada-verify && cd /tmp/sada-verify
npm init -y >/dev/null
npm install supabase-anti-disposable-auth
npx supabase-anti-disposable-auth --version
cd - && rm -rf /tmp/sada-verify
```

Also check the published file list:

```bash
npm view supabase-anti-disposable-auth dist.tarball version
```

## Why publishing is manual

For a first release, a human running `npm publish` after a verified local pack is the
lower-risk option:

- **No long-lived npm token is stored anywhere.** A repository secret holding a
  publish-capable token is a standing credential with a wide blast radius, and this is a
  security tool.
- **No workflow can publish on a push.** There is nothing to misconfigure into
  publishing `main` by accident.
- **The artifact that gets published is the artifact that was tested**, in the same
  shell, minutes earlier.

If publishing is later automated, the shape to use is npm **trusted publishing**: a
`workflow_dispatch`-gated (or tag-triggered) workflow with `id-token: write`, publishing
with `--provenance` and no stored token. Do not configure it before the OIDC trust
relationship actually exists on the npm side — a workflow holding credentials that do
not work is worse than no workflow.

## Release checklist

- [ ] Clean `main`, clean tree
- [ ] `npm ci`
- [ ] `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build`
- [ ] `npm run test:integration` against a scratch database with the Supabase roles present
- [ ] `npm audit`
- [ ] `npm pack --dry-run` — contents reviewed
- [ ] Tarball installed and executed in a clean temporary project
- [ ] `--version` matches `package.json`
- [ ] Version and CHANGELOG committed, PR merged
- [ ] `git tag -a vX.Y.Z && git push origin vX.Y.Z`
- [ ] `npm publish --access public`
- [ ] GitHub Release created from the notes in `docs/releases/`
- [ ] Installed from the registry and verified
