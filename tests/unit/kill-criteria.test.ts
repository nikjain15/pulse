import { describe, expect, it } from 'vitest';
import {
  KILL_DEGRADATION_RATE,
  KILL_MIN_ATTEMPTS,
  KILL_WINDOW_DAYS,
  evaluateKillLine,
  sumOutcomes,
  type PilotDay,
} from '@/lib/kill-criteria';

/**
 * The kill line (R1).
 *
 * A kill criterion that is only consulted when things are going well is not one, so
 * the tests that matter here are the ones where the answer is unwelcome: the line
 * crossed, and the line NOT crossed on a sample too small to read. The second is
 * the one that protects the criterion's credibility, because a threshold that fires
 * on two bad narrations would be quietly ignored within a week.
 */

const day = (date: string, narrated: number, factsOnly: number, guardRejected = 0): PilotDay => ({
  date,
  outcomes: { narrated, factsOnly, guardRejected, skippedCached: 0 },
});

/** N days ending 2026-08-07, each with the same counts. */
function week(narrated: number, factsOnly: number, days = KILL_WINDOW_DAYS): PilotDay[] {
  return Array.from({ length: days }, (_, i) =>
    day(`2026-08-${String(i + 1).padStart(2, '0')}`, narrated, factsOnly),
  );
}

describe('sumOutcomes', () => {
  it('adds every counter across the window', () => {
    const total = sumOutcomes([day('2026-08-01', 3, 1, 1), day('2026-08-02', 2, 4, 2)]);
    expect(total).toEqual({ narrated: 5, factsOnly: 5, guardRejected: 3, skippedCached: 0 });
  });

  it('is zero for an empty window rather than throwing', () => {
    expect(sumOutcomes([])).toEqual({ narrated: 0, factsOnly: 0, guardRejected: 0, skippedCached: 0 });
  });
});

describe('the kill line holds when the product is working', () => {
  it('reports holding on a healthy week', () => {
    // 7 days x (3 narrated, 1 degraded): 28 attempts, 7 degraded, 25%. Under the
    // line and over the minimum sample.
    const v = evaluateKillLine(week(3, 1));
    expect(v.status).toBe('holding');
    expect(v.attempts).toBe(28);
    expect(v.windowRate).toBeCloseTo(0.25, 10);
    expect(v.action).toContain('Continue');
  });

  it('holds just below the line rather than rounding into a kill', () => {
    // 6 of 14 per day -> 42.9%, under 50%.
    const v = evaluateKillLine(week(8, 6));
    expect(v.status).toBe('holding');
    expect(v.windowRate! < KILL_DEGRADATION_RATE).toBe(true);
  });
});

describe('the kill line fires when it should', () => {
  it('crosses at exactly the threshold, not only above it', () => {
    // 50/50 every day: the line is "at or above".
    const v = evaluateKillLine(week(5, 5));
    expect(v.status).toBe('crossed');
    expect(v.windowRate).toBeCloseTo(0.5, 10);
    expect(v.reason).toContain('at or above');
  });

  it('names a consequence that is not "try harder"', () => {
    const v = evaluateKillLine(week(2, 8));
    expect(v.status).toBe('crossed');
    expect(v.action).toContain('auto-publish OFF');
    expect(v.action).toContain('human reviews');
    // And makes going back deliberate rather than a quiet switch.
    expect(v.action).toContain('new pre-committed line');
  });

  it('judges the WINDOW, not the worst day in it', () => {
    // Two catastrophic days inside an otherwise healthy week must not kill the
    // product: that is what the alert threshold in health.ts is for.
    const days: PilotDay[] = [
      day('2026-08-01', 10, 0),
      day('2026-08-02', 10, 0),
      day('2026-08-03', 0, 10), // 100% degraded
      day('2026-08-04', 0, 10), // 100% degraded
      day('2026-08-05', 10, 0),
      day('2026-08-06', 10, 0),
      day('2026-08-07', 10, 0),
    ];
    const v = evaluateKillLine(days);
    expect(v.status).toBe('holding');
    expect(v.windowRate).toBeCloseTo(20 / 70, 10);
  });
});

describe('the line refuses to read an unreadable sample', () => {
  it('will not fire on a short history, however bad it looks', () => {
    // Three days, all fully degraded. Alarming, and not seven days.
    const v = evaluateKillLine(week(0, 10, 3));
    expect(v.status).toBe('not_enough_data');
    expect(v.reason).toContain(`evaluated over ${KILL_WINDOW_DAYS}`);
    expect(v.windowRate).toBeNull();
  });

  it('will not fire on a full week with too few attempts', () => {
    // 7 days, 1 attempt each, every one degraded: 100% on n=7.
    const v = evaluateKillLine(week(0, 1));
    expect(v.status).toBe('not_enough_data');
    expect(v.attempts).toBe(7);
    expect(v.attempts < KILL_MIN_ATTEMPTS).toBe(true);
    // The rate is still reported, so the number is visible without being acted on.
    expect(v.windowRate).toBeCloseTo(1, 10);
    expect(v.action).toContain('not readable yet');
  });

  it('handles a completely empty history', () => {
    const v = evaluateKillLine([]);
    expect(v.status).toBe('not_enough_data');
    expect(v.attempts).toBe(0);
    expect(v.windowRate).toBeNull();
  });
});

describe('the window is the most recent days, in order', () => {
  it('evaluates the tail when more than a week of history exists', () => {
    const healthy = week(10, 0, 14).map((d, i) => ({ ...d, date: `2026-07-${String(i + 1).padStart(2, '0')}` }));
    const bad = week(0, 10, 7).map((d, i) => ({ ...d, date: `2026-08-${String(i + 1).padStart(2, '0')}` }));
    const v = evaluateKillLine([...healthy, ...bad]);
    // The recent week is what counts; fourteen good days before it do not rescue it.
    expect(v.status).toBe('crossed');
    expect(v.daysConsidered).toBe(KILL_WINDOW_DAYS);
  });

  it('sorts an out-of-order series rather than trusting the caller', () => {
    // Shuffled input must give the same verdict as sorted input, or the criterion
    // would silently evaluate the wrong week.
    const bad = week(0, 10, 7).map((d, i) => ({ ...d, date: `2026-08-${String(i + 1).padStart(2, '0')}` }));
    const healthy = week(10, 0, 7).map((d, i) => ({ ...d, date: `2026-07-${String(i + 1).padStart(2, '0')}` }));
    const shuffled = [bad[3], healthy[0], bad[0], healthy[5], bad[6], healthy[2], bad[1], healthy[1], bad[2], healthy[3], bad[4], healthy[4], bad[5], healthy[6]];
    expect(evaluateKillLine(shuffled).status).toBe('crossed');
  });
});

describe('the consent criterion is N=1 and dominates every rate', () => {
  it('kills on a single report even in a perfectly healthy week', () => {
    const v = evaluateKillLine(week(10, 0), true);
    expect(v.status).toBe('crossed');
    expect(v.reason).toContain('N=1');
    expect(v.action).toContain('Stop auto-publishing immediately');
    expect(v.action).toContain('RUNBOOK');
  });

  it('kills on a single report even with no data at all', () => {
    // The criterion cannot be deferred for want of a sample.
    const v = evaluateKillLine([], true);
    expect(v.status).toBe('crossed');
    expect(v.action).not.toContain('Keep running');
  });

  it('does not tell anyone to tune a threshold', () => {
    const v = evaluateKillLine(week(10, 0), true);
    expect(v.action).toContain('kills the auto-publish design');
  });
});
