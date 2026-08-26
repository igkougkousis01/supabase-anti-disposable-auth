import { describe, expect, it } from 'vitest';

import {
  assertCandidateIsSafe,
  evaluateCandidateSafety,
  DEFAULT_SAFETY_THRESHOLDS,
} from '../../src/blocklist/safety.js';
import type { SafetyInput } from '../../src/blocklist/safety.js';
import { SuspiciousUpdateError } from '../../src/lib/errors.js';

/** A healthy candidate: large, almost entirely valid, close to the installed size. */
function healthy(overrides: Partial<SafetyInput> = {}): SafetyInput {
  return {
    candidateCount: 12_483,
    consideredLines: 12_650,
    acceptedLines: 12_600,
    currentCount: 12_400,
    ...overrides,
  };
}

describe('evaluateCandidateSafety', () => {
  it('accepts a normal update', () => {
    const verdict = evaluateCandidateSafety(healthy());

    expect(verdict.ok).toBe(true);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.firstSync).toBe(false);
  });

  it('accepts a small legitimate delta in either direction', () => {
    expect(evaluateCandidateSafety(healthy({ candidateCount: 12_300 })).ok).toBe(true);
    expect(evaluateCandidateSafety(healthy({ candidateCount: 13_900 })).ok).toBe(true);
  });

  it('rejects zero domains', () => {
    const verdict = evaluateCandidateSafety(healthy({ candidateCount: 0, acceptedLines: 0 }));

    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('no valid domains');
  });

  it('rejects a candidate below the absolute minimum', () => {
    const verdict = evaluateCandidateSafety(
      healthy({ candidateCount: 40, acceptedLines: 40, consideredLines: 40, currentCount: 10_000 }),
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('below the minimum');
  });

  it('rejects a poor valid-line ratio', () => {
    const verdict = evaluateCandidateSafety(
      healthy({ acceptedLines: 6_000, consideredLines: 12_650 }),
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('lines were valid domains');
  });

  it('rejects a catastrophic drop even when the candidate is otherwise healthy', () => {
    const verdict = evaluateCandidateSafety(
      healthy({ candidateCount: 5_000, acceptedLines: 5_000, consideredLines: 5_000 }),
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('would remove');
    expect(verdict.shrinkRatio).toBeCloseTo(0.597, 2);
  });

  it('allows a drop that stays inside the limit', () => {
    const verdict = evaluateCandidateSafety(
      healthy({ candidateCount: 9_000, acceptedLines: 9_000, consideredLines: 9_000 }),
    );

    expect(verdict.ok).toBe(true);
  });

  it('skips the drop check on a first sync, and says so', () => {
    const verdict = evaluateCandidateSafety(
      healthy({
        candidateCount: 1_200,
        acceptedLines: 1_200,
        consideredLines: 1_200,
        currentCount: 0,
      }),
    );

    expect(verdict.firstSync).toBe(true);
    expect(verdict.ok).toBe(true);
    expect(verdict.shrinkRatio).toBe(0);
  });

  it('still enforces the absolute minimum on a first sync', () => {
    const verdict = evaluateCandidateSafety(
      healthy({ candidateCount: 40, acceptedLines: 40, consideredLines: 40, currentCount: 0 }),
    );

    expect(verdict.ok).toBe(false);
  });

  it('still enforces the validity ratio on a first sync', () => {
    const verdict = evaluateCandidateSafety(
      healthy({
        candidateCount: 2_000,
        acceptedLines: 2_000,
        consideredLines: 12_000,
        currentCount: 0,
      }),
    );

    expect(verdict.ok).toBe(false);
  });

  it('reports every failing reason at once', () => {
    const verdict = evaluateCandidateSafety({
      candidateCount: 10,
      acceptedLines: 10,
      consideredLines: 5_000,
      currentCount: 10_000,
    });

    expect(verdict.reasons).toHaveLength(3);
  });

  it('honours custom thresholds', () => {
    const verdict = evaluateCandidateSafety(
      { candidateCount: 5, acceptedLines: 5, consideredLines: 5, currentCount: 0 },
      { ...DEFAULT_SAFETY_THRESHOLDS, minimumDomainCount: 1 },
    );

    expect(verdict.ok).toBe(true);
  });
});

describe('assertCandidateIsSafe', () => {
  it('returns the verdict when the candidate is safe', () => {
    expect(assertCandidateIsSafe(healthy()).ok).toBe(true);
  });

  it('throws a SuspiciousUpdateError naming both counts', () => {
    let thrown: unknown;
    try {
      assertCandidateIsSafe(
        healthy({
          candidateCount: 40,
          acceptedLines: 40,
          consideredLines: 40,
          currentCount: 10_000,
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SuspiciousUpdateError);
    const error = thrown as SuspiciousUpdateError;
    expect(error.message).toContain('Suspicious blocklist update rejected');
    expect(error.hint).toContain('Current domains: 10,000');
    expect(error.hint).toContain('Candidate domains: 40');
    expect(error.hint).toContain('left unchanged');
  });

  it('exposes no override switch', () => {
    // Asserted as a design decision, not an implementation detail: there is
    // deliberately no flag that makes an unsafe candidate acceptable.
    expect(Object.keys(DEFAULT_SAFETY_THRESHOLDS).sort()).toEqual([
      'maximumShrinkRatio',
      'minimumDomainCount',
      'minimumValidRatio',
    ]);
  });
});
