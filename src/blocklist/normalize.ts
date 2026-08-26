/**
 * Domain normalisation, kept in lockstep with `guard.normalize_domain()`.
 *
 * There is exactly one normalisation contract in this project and it is defined by
 * the PostgreSQL function in `migrations/001_create_domain_functions.sql`. This module
 * reimplements it so a 150,000-entry list can be canonicalised in process instead of
 * with one round trip per domain -- it is a performance mirror, never a second
 * opinion.
 *
 *   'MAILINATOR.COM'      -> 'mailinator.com'
 *   ' mailinator.com '    -> 'mailinator.com'
 *   '@mailinator.com'     -> 'mailinator.com'
 *   'user@mailinator.com' -> 'mailinator.com'
 *   'mailinator.com.'     -> 'mailinator.com'   (trailing dots are stripped)
 *   'not a domain'        -> undefined
 *
 * The asymmetry that matters
 * --------------------------
 * The two implementations are not merely "similar". Accepting something PostgreSQL
 * would reject violates the `CHECK` constraint and aborts the whole sync transaction;
 * rejecting something PostgreSQL would accept merely drops one domain from the list.
 * Where a judgement call exists, this module therefore errs towards rejecting.
 *
 * That is why whitespace trimming is ASCII-only rather than `String.trim()`:
 * `String.trim()` strips U+00A0, U+FEFF and friends, whereas PostgreSQL's
 * `[[:space:]]` is locale-dependent and may not. Trimming less can only cost us a
 * domain; trimming more could cost us the sync.
 */

import { isDomainShapedEntry, isValidDomain, MAX_DOMAIN_LENGTH } from './validate.js';

/**
 * Input longer than this is rejected before any regular expression runs.
 *
 * Matches the `length(input) <= 1024` guard in the PostgreSQL function. The longest
 * legal email address is 254 characters, so this is generous while still bounding the
 * work a pathological line can cause.
 */
export const MAX_NORMALIZE_INPUT_LENGTH = 1024;

/** ASCII whitespace only -- see the module comment for why this is not `String.trim()`. */
const ASCII_TRIM_PATTERN = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g;

/**
 * `[\s\S]` rather than `.` because PostgreSQL's `.` matches newlines and JavaScript's
 * does not. Greedy, so `a@b@example.com` resolves using the LAST `@`, exactly as
 * `regexp_replace(value, '^.*@', '')` does.
 */
const LOCAL_PART_PATTERN = /^[\s\S]*@/;

/** `rtrim(value, '.')` removes every trailing dot, not just one. */
const TRAILING_DOTS_PATTERN = /\.+$/;

/**
 * Canonicalises an email address or bare domain.
 *
 * @returns the normalised domain, or `undefined` when the input cannot be confidently
 * normalised. `undefined` means "unknown", never "matched".
 */
export function normalizeDomain(input: string | null | undefined): string | undefined {
  if (input === null || input === undefined) {
    return undefined;
  }

  if (input.length > MAX_NORMALIZE_INPUT_LENGTH) {
    return undefined;
  }

  const trimmed = input.replace(ASCII_TRIM_PATTERN, '').toLowerCase();
  const domainPart = trimmed.replace(LOCAL_PART_PATTERN, '').replace(TRAILING_DOTS_PATTERN, '');

  if (domainPart.length > MAX_DOMAIN_LENGTH) {
    return undefined;
  }

  return isValidDomain(domainPart) ? domainPart : undefined;
}

/**
 * Normalises one row supplied by a blocklist provider.
 *
 * This is the ONLY normalisation entry point the ingestion pipeline may use, and the
 * ordering it enforces is the point:
 *
 *   provider row -> validate domain-shaped -> normalise -> validate domain
 *
 * {@link normalizeDomain} is a faithful mirror of `guard.normalize_domain()`, which
 * extracts a domain from an email address on purpose -- correct for the authentication
 * input it will eventually see, wrong for a feed that is contractually a list of
 * domains. Handing a provider row straight to it would let `user@example.com` be
 * salvaged into `example.com`, turning a corrupted or substituted payload into
 * blocklist entries that look perfectly legitimate.
 *
 * The shape gate runs first and is not recoverable from: an address, a URL, a path or
 * anything else that is not already a bare domain is rejected, never repaired.
 *
 *   'mailinator.com'          -> 'mailinator.com'
 *   'MAILINATOR.COM'          -> 'mailinator.com'
 *   'mailinator.com.'         -> 'mailinator.com'   (trailing dots stripped)
 *   'user@mailinator.com'     -> undefined
 *   '@mailinator.com'         -> undefined
 *   'https://mailinator.com'  -> undefined
 *   'mailinator.com/path'     -> undefined
 *
 * Rejected rows are counted, and the valid-line ratio in `safety.ts` decides what that
 * means. An upstream that started emitting addresses would therefore fail the sync
 * rather than have its new format silently absorbed -- which is the intended outcome:
 * a format change is something an operator must see, not something to paper over.
 */
export function normalizeProviderDomain(entry: string | null | undefined): string | undefined {
  if (entry === null || entry === undefined) {
    return undefined;
  }

  // Bound the work before any pattern runs, matching normalizeDomain's own guard.
  if (entry.length > MAX_NORMALIZE_INPUT_LENGTH) {
    return undefined;
  }

  const trimmed = entry.replace(ASCII_TRIM_PATTERN, '');
  if (!isDomainShapedEntry(trimmed)) {
    return undefined;
  }

  return normalizeDomain(trimmed);
}
