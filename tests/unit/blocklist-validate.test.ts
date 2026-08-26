import { describe, expect, it } from 'vitest';

import { isValidDomain, MAX_DOMAIN_LENGTH } from '../../src/blocklist/validate.js';

describe('isValidDomain', () => {
  it.each([
    'mailinator.com',
    '10minutemail.com',
    'a.co',
    'sub.domain.example.org',
    'xn--80ak6aa92e.com',
    'a-b.example',
    '1.example',
  ])('accepts %s', (domain) => {
    expect(isValidDomain(domain)).toBe(true);
  });

  it.each([
    '',
    ' ',
    'localhost',
    'example',
    '.example.com',
    'example.com.',
    'example..com',
    'example.com/path',
    'user@example.com',
    'http://example.com',
    'example com',
    '-example.com',
    'example-.com',
    'EXAMPLE.COM',
    'example.c',
    'example.123',
    '192.168.0.1',
  ])('rejects %s', (domain) => {
    expect(isValidDomain(domain)).toBe(false);
  });

  it('rejects anything longer than the DNS presentation limit', () => {
    expect(isValidDomain(`${'a'.repeat(MAX_DOMAIN_LENGTH)}.com`)).toBe(false);
  });
});
