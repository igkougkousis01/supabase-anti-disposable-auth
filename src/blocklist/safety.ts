/**
 * Suspicious-update protection.
 *
 * This module is the reason a remote list can be trusted at all. Everything upstream
 * of it is plumbing; this is the part that decides whether a candidate dataset is
 * allowed anywhere near installed data.
 *
 * The threat it answers is concrete. An upstream repository can be compromised, a CDN
 * can serve a truncated file, a maintainer can push a bad commit, and a proxy can
 * return a stub. In every one of those cases the response is a perfectly well-formed
 * list -- it just is not the list. Content validity cannot distinguish them; only
 * plausibility can.
 *
 * The governing principle is that STALE-BUT-KNOWN-GOOD BEATS FRESH-BUT-WRONG. A
 * blocklist that is a week old still blocks the domains it knew about. A blocklist
 * that has been replaced by forty entries protects nothing, and nobody finds out until
 * the disposable signups arrive. So when a candidate is implausible, the update is
 * refused and the installed data is left exactly as it was.
 *
 * There is deliberately no override flag. A `--force` would be reached for precisely
 * when it is most dangerous -- during an incident, under time pressure, by someone who
 * wants the command to stop complaining. An operator who genuinely wants a small list
 * can insert rows directly; that is a conscious act, not a flag on a scheduled job.
 */

import { SuspiciousUpdateError } from '../lib/errors.js';

export interface SafetyThresholds {
  /**
   * Fewest domains a candidate may contain.
   *
   * The supported upstream carries roughly 150,000 entries, and any list worth
   * syncing is in the tens of thousands. 1,000 sits orders of magnitude below every
   * plausible real dataset while still being far above what a truncated download, a
   * stub file or an error page produces -- so it separates the two cases without ever
   * being close to a legitimate list.
   */
  readonly minimumDomainCount: number;

  /**
   * Smallest fraction of non-blank lines that must normalise to a valid domain.
   *
   * A healthy plain-text domain list is ~100% valid; the real upstream sits above
   * 0.99. An HTML error page, a JSON body or a markdown README scores near zero. 0.8
   * is therefore not a tuned value but a wide gutter: it tolerates an upstream
   * introducing a header block or a few malformed entries, while anything that is not
   * fundamentally a domain list fails by a wide margin.
   */
  readonly minimumValidRatio: number;

  /**
   * Largest fraction of the installed list that may disappear in one update.
   *
   * Curation removes a slice at a time; upstream lists churn by low single-digit
   * percentages between revisions and generally grow. A third of the list vanishing
   * at once is not curation, it is damage -- truncation, a partial regeneration, or a
   * malicious replacement. 0.3 leaves room for an unusually aggressive real cleanup
   * while still catching the failure modes that matter.
   */
  readonly maximumShrinkRatio: number;
}

export const DEFAULT_SAFETY_THRESHOLDS: SafetyThresholds = {
  minimumDomainCount: 1_000,
  minimumValidRatio: 0.8,
  maximumShrinkRatio: 0.3,
};

export interface SafetyInput {
  /** Distinct valid domains in the candidate, after normalisation and deduplication. */
  readonly candidateCount: number;
  /** Non-blank lines in the payload. Zero means there was nothing to judge. */
  readonly consideredLines: number;
  /** Non-blank lines that normalised successfully, before deduplication. */
  readonly acceptedLines: number;
  /** Rows currently in `guard.blocked_domains`. */
  readonly currentCount: number;
}

export interface SafetyVerdict {
  readonly ok: boolean;
  /**
   * True when there is no installed blocklist to compare against.
   *
   * The percentage-drop check is meaningless here -- there is no denominator -- so it
   * is skipped, and the absolute minimum plus the validity ratio carry the weight
   * alone. That is a genuine reduction in protection and is documented as such: the
   * first sync is the one moment this tool cannot tell a good list from a plausible
   * bad one by comparison. Every subsequent sync can.
   */
  readonly firstSync: boolean;
  /** Human-readable reasons the candidate was refused. Empty when `ok`. */
  readonly reasons: string[];
  /** Valid fraction of non-blank lines, or `1` when there were none. */
  readonly validRatio: number;
  /** Fraction of the installed list that would disappear. `0` on a first sync. */
  readonly shrinkRatio: number;
}

/** Judges a candidate without throwing, so callers can report as well as enforce. */
export function evaluateCandidateSafety(
  input: SafetyInput,
  thresholds: SafetyThresholds = DEFAULT_SAFETY_THRESHOLDS,
): SafetyVerdict {
  const firstSync = input.currentCount === 0;
  const validRatio = input.consideredLines === 0 ? 1 : input.acceptedLines / input.consideredLines;
  const shrinkRatio = firstSync
    ? 0
    : Math.max(0, (input.currentCount - input.candidateCount) / input.currentCount);

  const reasons: string[] = [];

  if (input.candidateCount === 0) {
    reasons.push('the candidate contains no valid domains');
  } else if (input.candidateCount < thresholds.minimumDomainCount) {
    reasons.push(
      `the candidate contains ${format(input.candidateCount)} domains, ` +
        `below the minimum of ${format(thresholds.minimumDomainCount)}`,
    );
  }

  if (validRatio < thresholds.minimumValidRatio) {
    reasons.push(
      `only ${percent(validRatio)} of ${format(input.consideredLines)} lines were valid domains, ` +
        `below the minimum of ${percent(thresholds.minimumValidRatio)}`,
    );
  }

  if (!firstSync && shrinkRatio > thresholds.maximumShrinkRatio) {
    reasons.push(
      `the candidate would remove ${percent(shrinkRatio)} of the installed list ` +
        `(${format(input.currentCount)} to ${format(input.candidateCount)} domains), ` +
        `more than the ${percent(thresholds.maximumShrinkRatio)} limit`,
    );
  }

  return { ok: reasons.length === 0, firstSync, reasons, validRatio, shrinkRatio };
}

/**
 * Enforces {@link evaluateCandidateSafety}.
 *
 * @throws SuspiciousUpdateError listing every reason at once. All checks are reported
 * together rather than at the first failure, because "too small AND mostly invalid"
 * tells an operator something quite different from either alone.
 */
export function assertCandidateIsSafe(
  input: SafetyInput,
  thresholds: SafetyThresholds = DEFAULT_SAFETY_THRESHOLDS,
): SafetyVerdict {
  const verdict = evaluateCandidateSafety(input, thresholds);
  if (verdict.ok) {
    return verdict;
  }

  throw new SuspiciousUpdateError(
    `Suspicious blocklist update rejected: ${verdict.reasons.join('; ')}`,
    {
      hint:
        `Current domains: ${format(input.currentCount)}. ` +
        `Candidate domains: ${format(input.candidateCount)}. ` +
        'The installed blocklist was left unchanged. ' +
        'Inspect the upstream source before syncing again.',
    },
  );
}

function format(value: number): string {
  return value.toLocaleString('en-US');
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}
