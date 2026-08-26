import { describe, expect, it } from 'vitest';

import { parseDomainList } from '../../src/blocklist/parse.js';
import { BlocklistValidationError } from '../../src/lib/errors.js';
import { FIXTURE_DOMAINS, readBlocklistFixture } from '../helpers/fixtures.js';

/** Built rather than written literally, so this file stays free of control characters. */
const NUL = String.fromCharCode(0);
const ESCAPE = String.fromCharCode(27);
const REPLACEMENT = String.fromCharCode(0xfffd);

describe('parseDomainList', () => {
  it('parses a clean LF list', () => {
    const parsed = parseDomainList(readBlocklistFixture('valid-small.txt'));

    expect(parsed.domains).toEqual(FIXTURE_DOMAINS);
    expect(parsed.totalLines).toBe(5);
    expect(parsed.consideredLines).toBe(5);
    expect(parsed.rejectedCount).toBe(0);
    expect(parsed.duplicateCount).toBe(0);
  });

  it('parses CRLF endings, blank lines and padded entries identically', () => {
    const lf = parseDomainList(readBlocklistFixture('valid-small.txt'));
    const crlf = parseDomainList(readBlocklistFixture('crlf.txt'));

    expect(crlf.domains).toEqual(lf.domains);
    // Blank lines are skipped rather than rejected: they are not invalid entries and
    // must not drag the valid-line ratio down.
    expect(crlf.consideredLines).toBe(5);
    expect(crlf.rejectedCount).toBe(0);
  });

  it('handles lone CR endings', () => {
    const parsed = parseDomainList('mailinator.com\ryopmail.com\r');
    expect(parsed.domains).toEqual(['mailinator.com', 'yopmail.com']);
  });

  it('deduplicates case variants, padding and trailing dots', () => {
    const parsed = parseDomainList(readBlocklistFixture('duplicates.txt'));

    expect(parsed.domains).toEqual(FIXTURE_DOMAINS);
    expect(parsed.duplicateCount).toBe(3);
    expect(parsed.rejectedCount).toBe(0);
  });

  it('sorts deterministically regardless of upstream order', () => {
    const ordered = parseDomainList(readBlocklistFixture('valid-small.txt'));
    const shuffled = parseDomainList(readBlocklistFixture('unordered.txt'));

    expect(shuffled.domains).toEqual(ordered.domains);
  });

  it('counts malformed entries instead of throwing', () => {
    const parsed = parseDomainList(readBlocklistFixture('malformed.txt'));

    // `user@example.com` is rejected, not salvaged into `example.com`. A provider
    // payload is contractually a list of domains, so an address in it is evidence the
    // feed is wrong -- not raw material to extract a blocklist entry from.
    expect(parsed.domains).toEqual(['mailinator.com']);
    expect(parsed.consideredLines).toBe(11);
    expect(parsed.rejectedCount).toBe(10);
    expect(parsed.rejectedSamples.length).toBeGreaterThan(0);
  });

  it('parses an HTML error page into almost nothing, leaving the ratio to reject it', () => {
    const parsed = parseDomainList(readBlocklistFixture('html-error-page.txt'));

    // The point: HTML is text, so it parses. What makes it unusable is the valid-line
    // ratio, not a parse failure.
    expect(parsed.domains).toEqual([]);
    expect(parsed.rejectedCount).toBe(parsed.consideredLines);
  });

  it('does not treat # as a comment, because the upstream format has none', () => {
    const parsed = parseDomainList('# a comment\nmailinator.com\n');

    expect(parsed.domains).toEqual(['mailinator.com']);
    expect(parsed.rejectedCount).toBe(1);
  });

  it('returns an empty result for an empty payload', () => {
    const parsed = parseDomainList('');

    expect(parsed.domains).toEqual([]);
    expect(parsed.totalLines).toBe(0);
    expect(parsed.consideredLines).toBe(0);
  });

  it('rejects binary-looking content', () => {
    expect(() => parseDomainList(`${NUL.repeat(64)}mailinator.com`)).toThrow(
      BlocklistValidationError,
    );
  });

  it('rejects a payload full of UTF-8 replacement characters', () => {
    expect(() => parseDomainList(REPLACEMENT.repeat(100))).toThrow(BlocklistValidationError);
  });

  it('sanitises rejected samples so upstream data cannot write escape sequences', () => {
    // Padded with real entries so the payload stays plausibly text; the binary
    // heuristic is a separate control and is exercised on its own above.
    const padding = Array.from({ length: 400 }, (_value, index) => `d${index}.example`);
    const parsed = parseDomainList(
      [...padding, `${ESCAPE}[31mnot a domain${ESCAPE}[0m`].join('\n'),
    );

    expect(parsed.rejectedCount).toBe(1);
    expect(parsed.rejectedSamples[0]).not.toContain(ESCAPE);
    expect(parsed.rejectedSamples[0]).toContain('?');
  });

  it('caps the number of rejected samples it keeps', () => {
    const parsed = parseDomainList(Array.from({ length: 50 }, () => 'nope').join('\n'));

    expect(parsed.rejectedCount).toBe(50);
    expect(parsed.rejectedSamples).toHaveLength(5);
  });
});

describe('parseDomainList trust boundary', () => {
  // Pipeline-level, not validator-isolation: these drive the real parser over a real
  // payload and assert on the candidate set it produces.

  it('does not add a domain extracted from an email address in the payload', () => {
    const parsed = parseDomainList(
      ['mailinator.com', 'user@never-extracted.example', 'yopmail.com'].join('\n'),
    );

    expect(parsed.domains).toEqual(['mailinator.com', 'yopmail.com']);
    expect(parsed.domains).not.toContain('never-extracted.example');
    expect(parsed.rejectedCount).toBe(1);
    expect(parsed.acceptedLines).toBe(2);
  });

  it.each([
    ['an email address', 'user@salvaged.example', 'salvaged.example'],
    ['a bare at-prefix', '@salvaged.example', 'salvaged.example'],
    ['an https URL', 'https://salvaged.example', 'salvaged.example'],
    ['an http URL', 'http://salvaged.example', 'salvaged.example'],
    ['a path', 'salvaged.example/path', 'salvaged.example'],
    ['a mailto URI', 'mailto:user@salvaged.example', 'salvaged.example'],
  ])('never turns %s into a candidate domain', (_label, entry, forbidden) => {
    const parsed = parseDomainList(['mailinator.com', entry].join('\n'));

    expect(parsed.domains).toEqual(['mailinator.com']);
    expect(parsed.domains).not.toContain(forbidden);
    expect(parsed.rejectedCount).toBe(1);
  });

  it('counts a payload of addresses as invalid, so the ratio check refuses it', () => {
    // The intended failure mode if an upstream ever changes format: sync fails loudly
    // rather than silently absorbing a different contract.
    const parsed = parseDomainList(
      Array.from({ length: 20 }, (_value, index) => `user${index}@addresses.example`).join('\n'),
    );

    expect(parsed.domains).toEqual([]);
    expect(parsed.acceptedLines).toBe(0);
    expect(parsed.rejectedCount).toBe(20);
  });

  it('still accepts the documented domain forms alongside rejected ones', () => {
    const parsed = parseDomainList(
      ['mailinator.com', 'MAILINATOR.COM', 'mailinator.com.', 'user@mailinator.com'].join('\n'),
    );

    // The three domain-shaped rows collapse onto one domain; the address is rejected.
    expect(parsed.domains).toEqual(['mailinator.com']);
    expect(parsed.acceptedLines).toBe(3);
    expect(parsed.duplicateCount).toBe(2);
    expect(parsed.rejectedCount).toBe(1);
  });
});
