/**
 * Deterministic fingerprint of a domain set.
 *
 * The checksum must depend on the SET of domains and on nothing else -- not on the
 * order the upstream happened to emit them in, not on duplicates, not on line endings.
 * That property is what makes it usable for no-op detection: if the upstream
 * regenerates its file with a different sort order tomorrow, we must not rewrite
 * 150,000 rows for a dataset that did not change.
 *
 * Canonical form:
 *
 *   domain1.example\ndomain2.example\ndomain3.example\n
 *
 * sorted, deduplicated, with a trailing newline. SHA-256 over its UTF-8 bytes.
 */

import { createHash } from 'node:crypto';

/**
 * Sorts and deduplicates, returning a new array.
 *
 * The comparator is explicit code-unit ordering rather than `localeCompare` or the
 * default `Array.sort()` string coercion: a locale-sensitive sort would make the
 * checksum depend on the machine's locale, which is precisely the kind of
 * non-determinism this module exists to eliminate.
 */
export function canonicalizeDomains(domains: Iterable<string>): string[] {
  return [...new Set(domains)].sort(compareCodeUnits);
}

/** Byte-for-byte representation the checksum is taken over. Empty input yields `''`. */
export function canonicalRepresentation(domains: readonly string[]): string {
  return domains.length === 0 ? '' : `${domains.join('\n')}\n`;
}

/**
 * SHA-256 of the canonical representation, lowercase hex.
 *
 * Canonicalises first, so callers cannot accidentally checksum an unsorted or
 * duplicate-bearing array and get a value that will never match again.
 */
export function checksumDomains(domains: Iterable<string>): string {
  const canonical = canonicalRepresentation(canonicalizeDomains(domains));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Short, human-facing form. Enough to eyeball across two runs; never used to compare. */
export function shortChecksum(checksum: string, length = 12): string {
  return checksum.slice(0, length);
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}
