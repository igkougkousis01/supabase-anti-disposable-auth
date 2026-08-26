import { describe, expect, it } from 'vitest';

import {
  normalizeDomain,
  normalizeProviderDomain,
  MAX_NORMALIZE_INPUT_LENGTH,
} from '../../src/blocklist/normalize.js';
import { isDomainShapedEntry } from '../../src/blocklist/validate.js';

describe('normalizeDomain', () => {
  it('lowercases', () => {
    expect(normalizeDomain('MAILINATOR.COM')).toBe('mailinator.com');
    expect(normalizeDomain('MaIlInAtOr.CoM')).toBe('mailinator.com');
  });

  it('trims surrounding ASCII whitespace', () => {
    expect(normalizeDomain('  mailinator.com  ')).toBe('mailinator.com');
    expect(normalizeDomain('\tmailinator.com\r\n')).toBe('mailinator.com');
  });

  it('takes the part after the last @', () => {
    expect(normalizeDomain('user@mailinator.com')).toBe('mailinator.com');
    expect(normalizeDomain('@mailinator.com')).toBe('mailinator.com');
    expect(normalizeDomain('a@b@mailinator.com')).toBe('mailinator.com');
  });

  it('strips trailing dots, matching rtrim in the PostgreSQL function', () => {
    expect(normalizeDomain('mailinator.com.')).toBe('mailinator.com');
    expect(normalizeDomain('mailinator.com...')).toBe('mailinator.com');
  });

  it('accepts punycode labels', () => {
    expect(normalizeDomain('xn--80ak6aa92e.com')).toBe('xn--80ak6aa92e.com');
  });

  it('rejects punycode TLDs, because the PostgreSQL pattern requires an alphabetic TLD', () => {
    // Deliberate: accepting what PostgreSQL rejects would violate the CHECK
    // constraint and abort an entire sync transaction.
    expect(normalizeDomain('example.xn--p1ai')).toBeUndefined();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['no domain part', 'user@'],
    ['a URL', 'http://example.com'],
    ['a URL with a scheme only', 'https://example.com'],
    ['an internal space', 'example com'],
    ['a leading dot', '.example.com'],
    ['a double leading dot', '..example.com'],
    ['an empty label', 'example..com'],
    ['a path', 'example.com/path'],
    ['a single label', 'localhost'],
    ['a leading hyphen', '-example.com'],
    ['a trailing hyphen', 'example-.com'],
    ['a numeric TLD', 'example.123'],
    ['an IPv4 address', '192.168.0.1'],
    ['a non-ASCII domain', 'ex\u00e4mple.com'],
  ])('rejects %s', (_label, input) => {
    expect(normalizeDomain(input)).toBeUndefined();
  });

  it('rejects a label longer than 63 characters', () => {
    expect(normalizeDomain(`${'a'.repeat(63)}.com`)).toBe(`${'a'.repeat(63)}.com`);
    expect(normalizeDomain(`${'a'.repeat(64)}.com`)).toBeUndefined();
  });

  it('rejects a domain longer than 253 characters', () => {
    const label = 'a'.repeat(63);
    const withinLimit = `${label}.${label}.${label}.${'a'.repeat(57)}.com`;
    expect(withinLimit.length).toBeLessThanOrEqual(253);
    expect(normalizeDomain(withinLimit)).toBe(withinLimit);

    const tooLong = `${label}.${label}.${label}.${label}.com`;
    expect(tooLong.length).toBeGreaterThan(253);
    expect(normalizeDomain(tooLong)).toBeUndefined();
  });

  it('rejects input longer than the pre-regex guard without running the pattern', () => {
    expect(normalizeDomain('a'.repeat(MAX_NORMALIZE_INPUT_LENGTH + 1))).toBeUndefined();
  });
});

describe('isDomainShapedEntry', () => {
  it.each(['mailinator.com', 'MAILINATOR.COM', 'mailinator.com.', 'a-b.example', '1.example'])(
    'accepts the domain-shaped entry %j',
    (entry) => {
      expect(isDomainShapedEntry(entry)).toBe(true);
    },
  );

  it.each([
    ['an address', 'user@mailinator.com'],
    ['a bare at-prefix', '@mailinator.com'],
    ['an https URL', 'https://mailinator.com'],
    ['an http URL', 'http://mailinator.com'],
    ['a path', 'mailinator.com/path'],
    ['a query', 'mailinator.com?a=b'],
    ['a fragment', 'mailinator.com#frag'],
    ['a port', 'mailinator.com:443'],
    ['an internal space', 'mailinator com'],
    ['an underscore', 'mail_inator.com'],
    ['a non-ASCII character', 'ex\u00e4mple.com'],
    ['empty', ''],
  ])('rejects %s', (_label, entry) => {
    expect(isDomainShapedEntry(entry)).toBe(false);
  });
});

describe('normalizeProviderDomain', () => {
  // The trust boundary between "authentication input" and "provider rows".
  //
  // guard.normalize_domain() extracts a domain from an email address on purpose, and
  // normalizeDomain() mirrors that faithfully. A provider payload is contractually a
  // list of DOMAINS, so the same salvage would turn a corrupted or substituted feed
  // into blocklist entries that look legitimate. These tests pin the divergence.

  it('accepts a bare domain', () => {
    expect(normalizeProviderDomain('mailinator.com')).toBe('mailinator.com');
  });

  it('accepts and normalises case', () => {
    expect(normalizeProviderDomain('MAILINATOR.COM')).toBe('mailinator.com');
  });

  it('accepts a trailing dot and strips it, per the documented policy', () => {
    // Documented policy: trailing dots are accepted and stripped, matching rtrim() in
    // guard.normalize_domain(). A trailing dot is still domain-shaped.
    expect(normalizeProviderDomain('mailinator.com.')).toBe('mailinator.com');
    expect(normalizeProviderDomain('mailinator.com...')).toBe('mailinator.com');
  });

  it('accepts surrounding whitespace', () => {
    expect(normalizeProviderDomain('  mailinator.com  ')).toBe('mailinator.com');
  });

  it.each([
    ['an email address', 'user@mailinator.com'],
    ['a bare at-prefix', '@mailinator.com'],
    ['an https URL', 'https://mailinator.com'],
    ['an http URL', 'http://mailinator.com'],
    ['a path', 'mailinator.com/path'],
    ['an address with a path', 'user@mailinator.com/path'],
    ['a double-at address', 'a@b@mailinator.com'],
    ['a mailto URI', 'mailto:user@mailinator.com'],
  ])('rejects %s outright rather than salvaging a domain from it', (_label, entry) => {
    expect(normalizeProviderDomain(entry)).toBeUndefined();
  });

  it('diverges from normalizeDomain exactly where the contract differs', () => {
    // normalizeDomain is the PostgreSQL mirror and MUST keep extracting; the provider
    // entry point MUST NOT. Asserting both halves together is what stops a future
    // refactor from "simplifying" one into the other.
    expect(normalizeDomain('user@mailinator.com')).toBe('mailinator.com');
    expect(normalizeProviderDomain('user@mailinator.com')).toBeUndefined();
  });

  it('agrees with normalizeDomain for input that is already domain-shaped', () => {
    for (const entry of ['mailinator.com', 'MAILINATOR.COM', 'mailinator.com.', 'a.co']) {
      expect(normalizeProviderDomain(entry)).toBe(normalizeDomain(entry));
    }
  });

  it('still rejects structurally invalid domains', () => {
    for (const entry of ['..example.com', '.example.com', 'example..com', 'localhost']) {
      expect(normalizeProviderDomain(entry)).toBeUndefined();
    }
  });

  it('rejects null, undefined and over-long input', () => {
    expect(normalizeProviderDomain(null)).toBeUndefined();
    expect(normalizeProviderDomain(undefined)).toBeUndefined();
    expect(normalizeProviderDomain('a'.repeat(MAX_NORMALIZE_INPUT_LENGTH + 1))).toBeUndefined();
  });
});
