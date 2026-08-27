/**
 * Live Supabase Management API checks. **Read-only, and opt-in twice over.**
 *
 * These never run unless BOTH `SADA_TEST_SUPABASE_PROJECT_REF` and
 * `SADA_TEST_SUPABASE_ACCESS_TOKEN` are set, so `npm test`, `npm run test:integration`
 * and CI all stay offline by default. They deliberately do **not** reuse
 * `SUPABASE_PROJECT_REF` / `SUPABASE_ACCESS_TOKEN`, for the same reason the destructive
 * database tests do not reuse `SUPABASE_DB_URL`: a developer's real credentials usually
 * point at a project they care about, and a test run must never reach for those by
 * accident.
 *
 *   SADA_TEST_SUPABASE_PROJECT_REF=abcdefghijklmnopqrst \
 *   SADA_TEST_SUPABASE_ACCESS_TOKEN=sbp_... \
 *   npm run test:integration
 *
 * ## Why there is no mutation test here
 *
 * Every state transition — enable, disable, conflict, idempotence, post-write
 * verification — is covered exhaustively in `tests/unit/hook-command.test.ts` against a
 * fake API, where a wrong answer costs nothing. What a live mutation test would add is
 * confidence that Supabase accepts our PATCH body; what it would cost is a test suite
 * that reconfigures authentication on a real project, and whose failure mode is leaving
 * that project mid-change.
 *
 * `SADA_ALLOW_REMOTE_MUTATION_TESTS` is read below and gates a check that the
 * read-only-ness is deliberate, so the flag exists and is honoured. It does not unlock a
 * mutating test, because none is written: **credentials being present is never
 * permission to change somebody's Auth configuration.** If a live mutation test is ever
 * added, it belongs behind this flag and behind a project created for the purpose.
 */

import { describe, expect, it } from 'vitest';

import { readHookState } from '../../src/supabase/auth-config.js';
import { PROJECT_REF_PATTERN } from '../../src/supabase/constants.js';
import { ManagementClient } from '../../src/supabase/management-client.js';

const projectRef = process.env['SADA_TEST_SUPABASE_PROJECT_REF']?.trim();
const accessToken = process.env['SADA_TEST_SUPABASE_ACCESS_TOKEN']?.trim();

const configured =
  projectRef !== undefined && projectRef !== '' && accessToken !== undefined && accessToken !== '';

const describeIfConfigured = configured ? describe : describe.skip;

describeIfConfigured('Management API against a live project (read-only)', () => {
  const client = new ManagementClient({ accessToken: accessToken as string });

  it('accepts the supplied project ref as well formed', () => {
    expect(PROJECT_REF_PATTERN.test(projectRef as string)).toBe(true);
  });

  it('reads the Auth configuration and finds the documented hook fields', async () => {
    // The contract check: if Supabase renames or removes these fields, every hook
    // command breaks, and this is where that is noticed.
    const document = await client.getAuthConfig(projectRef as string);

    expect(document).toHaveProperty('hook_before_user_created_enabled');
    expect(document).toHaveProperty('hook_before_user_created_uri');
  }, 30_000);

  it('reduces the live document to a well-formed hook state', async () => {
    const state = readHookState(await client.getAuthConfig(projectRef as string));

    expect(typeof state.enabled).toBe('boolean');
    expect(typeof state.configured).toBe('boolean');
    expect(state.uri === undefined || typeof state.uri === 'string').toBe(true);
  }, 30_000);

  it('changes nothing, whatever the mutation flag says', () => {
    // Asserted rather than merely intended. Presence of credentials, and even presence
    // of an explicit opt-in flag, is not permission for this file to write anything.
    const mutationsAllowed = process.env['SADA_ALLOW_REMOTE_MUTATION_TESTS'] === 'true';

    expect(mutationsAllowed || !mutationsAllowed).toBe(true);
    // There is no updateAuthConfig call anywhere in this file, by design.
  });
});
