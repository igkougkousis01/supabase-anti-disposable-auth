/**
 * `describeHookUri()` is the gate between a remote-supplied hook URI and a terminal.
 *
 * A conflict message has to name what is already configured or an operator cannot decide
 * anything -- but the value it names was written by a third party and, for an HTTP hook,
 * routinely carries a credential. These tests pin the per-scheme rule.
 */

import { describe, expect, it } from 'vitest';

import {
  describeConnectionTarget,
  describeHookUri,
  sanitizeForDisplay,
} from '../../src/lib/redact.js';
import { BEFORE_USER_CREATED_HOOK_URI } from '../../src/supabase/constants.js';

describe('describeHookUri', () => {
  it.each([undefined, '', '   '])('describes %j as "none"', (uri) => {
    expect(describeHookUri(uri)).toBe('none');
  });

  it('prints a pg-functions URI in full', () => {
    // It addresses a database function by name and structurally cannot carry a secret,
    // and an operator needs the exact value to compare against their own.
    expect(describeHookUri(BEFORE_USER_CREATED_HOOK_URI)).toBe(BEFORE_USER_CREATED_HOOK_URI);
  });

  it("prints another project's pg-functions URI in full too", () => {
    expect(describeHookUri('pg-functions://postgres/custom/existing_hook')).toBe(
      'pg-functions://postgres/custom/existing_hook',
    );
  });

  it('reduces an HTTPS hook to scheme and host', () => {
    expect(describeHookUri('https://hooks.example.test/before-user-created')).toBe(
      'https://hooks.example.test (path and query withheld)',
    );
  });

  it('drops a query string that may hold a signing token', () => {
    const described = describeHookUri('https://hooks.example.test/hook?signing_token=s3cr3t');

    expect(described).not.toContain('s3cr3t');
    expect(described).not.toContain('signing_token');
  });

  it('drops userinfo credentials', () => {
    const described = describeHookUri('https://admin:hunter2@hooks.example.test/hook');

    expect(described).not.toContain('hunter2');
    expect(described).not.toContain('admin');
    expect(described).toContain('hooks.example.test');
  });

  it('drops a fragment', () => {
    expect(describeHookUri('https://hooks.example.test/hook#secret-anchor')).not.toContain(
      'secret-anchor',
    );
  });

  it('handles a plain HTTP hook the same way', () => {
    expect(describeHookUri('http://hooks.example.test/hook?k=v')).toBe(
      'http://hooks.example.test (path and query withheld)',
    );
  });

  it('describes an unrecognised scheme without showing it', () => {
    expect(describeHookUri('weird-scheme://whatever/secret-path')).toBe('an unrecognised hook URI');
  });

  it('describes an unparseable value without showing it', () => {
    expect(describeHookUri('not a uri at all')).toBe('a malformed hook URI');
  });

  it('strips terminal escape sequences from a pg-functions URI', () => {
    const described = describeHookUri('pg-functions://postgres/guard/x\u001b[2Jy');

    expect(described).not.toContain('\u001b');
    expect(described).toContain('?');
  });

  it('caps a hostile length', () => {
    const described = describeHookUri(`pg-functions://postgres/guard/${'x'.repeat(5000)}`);

    expect(described.length).toBeLessThan(200);
  });
});

describe('sanitizeForDisplay', () => {
  it('replaces control characters', () => {
    expect(sanitizeForDisplay('a\u001bb\u0007c', 100)).toBe('a?b?c');
  });

  it('keeps ordinary text intact', () => {
    expect(sanitizeForDisplay('Auth Hooks require a Team plan.', 100)).toBe(
      'Auth Hooks require a Team plan.',
    );
  });

  it('truncates with an ellipsis', () => {
    expect(sanitizeForDisplay('abcdefghij', 4)).toBe('abcd...');
  });
});

describe('describeConnectionTarget', () => {
  it('still drops the password', () => {
    // Unchanged by this branch, asserted here so the two redaction helpers sit together.
    expect(
      describeConnectionTarget('postgresql://postgres:hunter2@db.example.test:5432/postgres'),
    ).toBe('db.example.test:5432/postgres');
  });
});
