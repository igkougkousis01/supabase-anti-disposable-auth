/**
 * Turns a raw upstream payload into a canonical domain set.
 *
 * The expected format is one domain per line, which is what every provider in this
 * project serves. It is deliberately not a CSV or JSON parser: guessing at a format
 * the upstream did not promise is how a changed endpoint silently becomes a corrupted
 * blocklist. Comments are not supported either, because the supported upstream does
 * not use them -- a `#` line simply fails validation and counts towards the invalid
 * ratio, which is the correct signal if the format ever changes underneath us.
 *
 * This module never parses email addresses, and that is enforced rather than merely
 * intended: every row goes through `normalizeProviderDomain()`, which validates that
 * the entry is already domain-shaped BEFORE normalising it. The address extraction
 * `guard.normalize_domain()` performs is correct for the authentication lookup path
 * and wrong here, so an address, a URL or a path in a provider payload is counted as
 * an invalid row instead of being salvaged into a domain.
 */

import { BlocklistValidationError } from '../lib/errors.js';
import { canonicalizeDomains } from './checksum.js';
import { normalizeProviderDomain } from './normalize.js';

/** How many rejected entries are kept for diagnostics. Enough to see a pattern. */
const REJECTED_SAMPLE_LIMIT = 5;

/** Rejected samples are truncated to this before printing. */
const REJECTED_SAMPLE_LENGTH = 64;

/** Prefix of the payload examined by the binary-content heuristic. */
const BINARY_PROBE_LENGTH = 8192;

/**
 * Fraction of suspicious characters in the probe above which the payload is refused.
 *
 * A text domain list contains none at all, so anything measurable here means we were
 * handed something that is not text: a compressed stream, a protobuf blob, or a
 * mis-decoded encoding.
 */
const BINARY_CHARACTER_RATIO = 0.005;

const CHARACTER_TAB = 0x09;
const CHARACTER_LINE_FEED = 0x0a;
const CHARACTER_CARRIAGE_RETURN = 0x0d;
const CHARACTER_SPACE = 0x20;
const CHARACTER_DELETE = 0x7f;
/** U+FFFD, which is what a failed UTF-8 decode leaves behind. */
const CHARACTER_REPLACEMENT = 0xfffd;

export interface ParsedBlocklist {
  /** Lines in the payload, including blank ones. */
  readonly totalLines: number;
  /** Non-blank lines, i.e. everything that was actually a candidate entry. */
  readonly consideredLines: number;
  /** Non-blank lines that normalised successfully, before deduplication. */
  readonly acceptedLines: number;
  /** Non-blank lines that could not be normalised. */
  readonly rejectedCount: number;
  /** Accepted lines that collapsed onto a domain already seen. */
  readonly duplicateCount: number;
  /** Normalised, deduplicated, deterministically sorted. */
  readonly domains: string[];
  /** A few sanitised rejected entries, for diagnostics. Never the whole payload. */
  readonly rejectedSamples: string[];
}

/**
 * Parses, normalises, deduplicates and sorts.
 *
 * @throws BlocklistValidationError when the payload does not look like text at all.
 * Everything softer than that -- a junk line, a duplicate -- is counted rather than
 * thrown, so the safety thresholds get to make the judgement call with real numbers.
 */
export function parseDomainList(raw: string): ParsedBlocklist {
  assertLooksLikeText(raw);

  // Normalise line endings first so CRLF and lone-CR payloads parse identically.
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');

  const seen = new Set<string>();
  const rejectedSamples: string[] = [];

  let consideredLines = 0;
  let acceptedLines = 0;
  let rejectedCount = 0;
  let duplicateCount = 0;

  for (const line of lines) {
    if (line.trim() === '') {
      continue;
    }
    consideredLines += 1;

    const domain = normalizeProviderDomain(line);
    if (domain === undefined) {
      rejectedCount += 1;
      if (rejectedSamples.length < REJECTED_SAMPLE_LIMIT) {
        rejectedSamples.push(sanitiseForDisplay(line));
      }
      continue;
    }

    acceptedLines += 1;
    if (seen.has(domain)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(domain);
  }

  return {
    totalLines: countLines(lines),
    consideredLines,
    acceptedLines,
    rejectedCount,
    duplicateCount,
    domains: canonicalizeDomains(seen),
    rejectedSamples,
  };
}

/** A trailing newline produces a final empty element that is not a real line. */
function countLines(lines: string[]): number {
  if (lines.length === 0) {
    return 0;
  }
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

/**
 * Refuses payloads that are not plausibly text.
 *
 * Cheap and deliberately blunt: it exists to fail fast on binary garbage, not to
 * judge content. An HTML error page served with HTTP 200 is *text*, so it passes here
 * and is caught downstream by the content-type check and the valid-line ratio, which
 * are the right tools for it.
 */
function assertLooksLikeText(raw: string): void {
  const probe = raw.slice(0, BINARY_PROBE_LENGTH);
  if (probe.length === 0) {
    return;
  }

  let suspicious = 0;
  for (let index = 0; index < probe.length; index += 1) {
    if (isSuspiciousCharacter(probe.charCodeAt(index))) {
      suspicious += 1;
    }
  }

  if (suspicious / probe.length > BINARY_CHARACTER_RATIO) {
    throw new BlocklistValidationError('The upstream payload does not look like a text list', {
      hint: 'The response contained binary or mis-encoded data. The installed blocklist was left unchanged.',
    });
  }
}

/** Control characters a text list never contains, plus the UTF-8 replacement character. */
function isSuspiciousCharacter(code: number): boolean {
  if (
    code === CHARACTER_TAB ||
    code === CHARACTER_LINE_FEED ||
    code === CHARACTER_CARRIAGE_RETURN
  ) {
    return false;
  }
  return code < CHARACTER_SPACE || code === CHARACTER_DELETE || code === CHARACTER_REPLACEMENT;
}

/**
 * Makes an upstream-controlled string safe to print.
 *
 * Rejected entries are remote data. Writing them to a terminal verbatim would let an
 * upstream inject ANSI escape sequences into an operator's console, so every
 * non-printable character is replaced and the result is truncated.
 */
function sanitiseForDisplay(value: string): string {
  const printable = [...value.slice(0, REJECTED_SAMPLE_LENGTH)]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= CHARACTER_SPACE && code !== CHARACTER_DELETE ? character : '?';
    })
    .join('');

  return value.length > REJECTED_SAMPLE_LENGTH ? `${printable}...` : printable;
}
