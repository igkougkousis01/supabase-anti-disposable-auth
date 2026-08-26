/**
 * Deterministic, offline domain validation.
 *
 * This is not an RFC-complete hostname validator and does not try to be. It is the
 * TypeScript half of a contract with `guard.normalize_domain()`: a value this module
 * accepts MUST also satisfy the `CHECK (domain is not distinct from
 * guard.normalize_domain(domain))` constraint on `guard.blocked_domains`, because a
 * single disagreement aborts an entire sync transaction on a constraint violation.
 *
 * The pattern below is therefore a deliberate transcription of the one in
 * `migrations/001_create_domain_functions.sql`, not an independent design. An
 * integration test compares the two implementations over a corpus so they cannot
 * drift apart silently.
 *
 * No DNS is consulted, no network request is made and no per-domain I/O happens:
 * validating a 150,000-entry list has to stay cheap.
 */

/** Maximum length of a DNS name in presentation format. */
export const MAX_DOMAIN_LENGTH = 253;

/** Maximum length of a single DNS label. */
export const MAX_LABEL_LENGTH = 63;

/**
 * Mirrors the PostgreSQL pattern character for character.
 *
 * Reading it left to right, it encodes every structural rule at once:
 *  - one or more labels, each followed by a dot, then a final alphabetic label;
 *  - a label is 1-63 characters, starts and ends alphanumeric, and may contain
 *    hyphens only internally -- so `-x.com`, `x-.com` and a 64-character label fail;
 *  - `..` cannot appear, and neither a leading nor a trailing dot survives, because
 *    an empty label matches nothing;
 *  - the last label is `[a-z]{2,63}`, which also rejects a bare IPv4 address.
 *
 * A consequence worth stating plainly: a punycode *label* (`xn--80ak6aa92e`) is
 * accepted, but a punycode *TLD* (`xn--p1ai`) is not, because it contains digits and
 * a hyphen. That is the PostgreSQL function's behaviour, and matching it exactly
 * matters more here than accepting a few more domains.
 */
const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Characters a provider row is allowed to contain, before any normalisation.
 *
 * An allowlist rather than a blocklist of forbidden characters, deliberately: it
 * rejects `@`, `/`, `:`, `?`, `#`, backslashes, whitespace, control characters and
 * non-ASCII in one rule, and a character nobody thought about is rejected by default
 * rather than admitted by default.
 *
 * Case is permitted here because case folding is normalisation's job, not shape's.
 */
const DOMAIN_SHAPED_PATTERN = /^[A-Za-z0-9.-]+$/;

/**
 * True when `value` is shaped like a bare domain, before normalisation runs.
 *
 * This is a TRUST BOUNDARY, not a convenience check, and it is the reason the
 * ingestion pipeline validates before it normalises.
 *
 * `guard.normalize_domain()` deliberately extracts a domain from an email address --
 * `user@mailinator.com` becomes `mailinator.com` -- because it will eventually be fed
 * authentication input, where that is exactly right. The provider pipeline has the
 * opposite contract: an upstream is expected to supply DOMAIN ROWS. An address, a URL
 * or a path appearing there means the payload is not what we think it is, and
 * salvaging a domain out of it would convert evidence of a broken or substituted feed
 * into a silently accepted blocklist entry.
 *
 * So a provider row that is not already domain-shaped is rejected outright. It never
 * reaches normalisation, and cannot be repaired into something valid.
 *
 * Expects a value with surrounding whitespace already stripped.
 */
export function isDomainShapedEntry(value: string): boolean {
  if (value.length === 0 || value.length > MAX_DOMAIN_LENGTH) {
    return false;
  }

  return DOMAIN_SHAPED_PATTERN.test(value);
}

/**
 * True when `value` is an already-normalised, storable domain.
 *
 * Expects lowercase ASCII input: it validates, it does not normalise. Use
 * {@link normalizeDomain} for anything that has not been through normalisation.
 */
export function isValidDomain(value: string): boolean {
  if (value.length === 0 || value.length > MAX_DOMAIN_LENGTH) {
    return false;
  }

  return DOMAIN_PATTERN.test(value);
}
