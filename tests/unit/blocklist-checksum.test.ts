import { describe, expect, it } from 'vitest';

import {
  canonicalizeDomains,
  canonicalRepresentation,
  checksumDomains,
  shortChecksum,
} from '../../src/blocklist/checksum.js';
import { parseDomainList } from '../../src/blocklist/parse.js';
import { readBlocklistFixture } from '../helpers/fixtures.js';

describe('canonicalizeDomains', () => {
  it('deduplicates and sorts', () => {
    expect(canonicalizeDomains(['b.example', 'a.example', 'b.example'])).toEqual([
      'a.example',
      'b.example',
    ]);
  });
});

describe('canonicalRepresentation', () => {
  it('is newline-separated with a trailing newline', () => {
    expect(canonicalRepresentation(['a.example', 'b.example'])).toBe('a.example\nb.example\n');
  });

  it('is empty for an empty set, rather than a bare newline', () => {
    expect(canonicalRepresentation([])).toBe('');
  });
});

describe('checksumDomains', () => {
  it('is a 64-character lowercase SHA-256 hex digest', () => {
    expect(checksumDomains(['mailinator.com'])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is independent of upstream ordering', () => {
    const ordered = parseDomainList(readBlocklistFixture('valid-small.txt'));
    const shuffled = parseDomainList(readBlocklistFixture('unordered.txt'));

    expect(checksumDomains(shuffled.domains)).toBe(checksumDomains(ordered.domains));
  });

  it('is independent of duplicates and case variants', () => {
    const clean = parseDomainList(readBlocklistFixture('valid-small.txt'));
    const dirty = parseDomainList(readBlocklistFixture('duplicates.txt'));

    expect(checksumDomains(dirty.domains)).toBe(checksumDomains(clean.domains));
  });

  it('is independent of line endings', () => {
    const lf = parseDomainList(readBlocklistFixture('valid-small.txt'));
    const crlf = parseDomainList(readBlocklistFixture('crlf.txt'));

    expect(checksumDomains(crlf.domains)).toBe(checksumDomains(lf.domains));
  });

  it('changes when a domain changes', () => {
    expect(checksumDomains(['a.example', 'c.example'])).not.toBe(
      checksumDomains(['a.example', 'b.example']),
    );
  });

  it('changes when a domain is added', () => {
    expect(checksumDomains(['a.example', 'b.example'])).not.toBe(checksumDomains(['a.example']));
  });

  it('is stable across calls', () => {
    expect(checksumDomains(['a.example'])).toBe(checksumDomains(['a.example']));
  });
});

describe('shortChecksum', () => {
  it('truncates for display only', () => {
    const checksum = checksumDomains(['a.example']);
    expect(shortChecksum(checksum)).toBe(checksum.slice(0, 12));
  });
});
