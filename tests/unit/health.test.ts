import { describe, expect, it } from 'vitest';
import {
  DEGRADATION_ALERT_RATE,
  DEGRADATION_MIN_SAMPLE,
  DEGRADATION_WARN_RATE,
  degradationRate,
  emptyOutcomes,
  evaluateHealth,
  guardRejectionRate,
  PILOT_BUDGET_USD,
  spendPerDay,
  SPEND_ALERT_USD_PER_DAY,
  type OutcomeCounts,
} from '@/lib/health';
import { emptyTotals, type UsageTotals } from '@/lib/usage';

/**
 * SH3. Pulse had a spend counter and a degradation union and no threshold, so no number
 * meant "broken". These tests pin what each number now means.
 */

const NOW = new Date('2026-08-02T12:00:00Z');
const daysAgo = (n: number) => NOW.getTime() - n * 86_400_000;

const outcomes = (over: Partial<OutcomeCounts> = {}): OutcomeCounts => ({ ...emptyOutcomes(), ...over });
const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({ ...emptyTotals(), ...over });

describe('degradation rate', () => {
  it('is facts-only over attempts that actually called the model', () => {
    expect(degradationRate(outcomes({ narrated: 8, factsOnly: 2 }))).toBeCloseTo(0.2, 10);
  });

  it('excludes skipped_cached from the denominator', () => {
    // The budget guard skipping unchanged work is the cache doing its job. Counting it as a
    // healthy attempt would let a warm cache mask a completely broken model path.
    const withSkips = outcomes({ narrated: 0, factsOnly: 10, skippedCached: 990 });
    expect(degradationRate(withSkips)).toBe(1);
  });

  it('is zero, not NaN, when nothing has been attempted', () => {
    expect(degradationRate(emptyOutcomes())).toBe(0);
    expect(guardRejectionRate(emptyOutcomes())).toBe(0);
  });
});

describe('evaluateHealth verdicts', () => {
  const at = (o: Partial<OutcomeCounts>, t: Partial<UsageTotals> = {}, sinceDays = 10) =>
    evaluateHealth({
      outcomes: outcomes(o),
      totals: totals(t),
      countingSinceMs: daysAgo(sinceDays),
      now: NOW,
    });

  const signal = (r: ReturnType<typeof at>, id: string) => r.signals.find((s) => s.id === id)!;

  it('is ok on a healthy sample', () => {
    const r = at({ narrated: 95, factsOnly: 5 }, { costUsd: 1, calls: 100 });
    expect(r.level).toBe('ok');
  });

  it('warns above the warn rate and alerts above the alert rate', () => {
    expect(signal(at({ narrated: 70, factsOnly: 30 }), 'degradation_rate').level).toBe('warn');
    expect(signal(at({ narrated: 40, factsOnly: 60 }), 'degradation_rate').level).toBe('alert');
  });

  it('refuses to judge a rate below the minimum sample', () => {
    // Three attempts, all degraded, is a 100% rate and means nothing. Reporting it as an
    // alert would train the reader to ignore the alert.
    const r = at({ narrated: 0, factsOnly: 3 });
    const s = signal(r, 'degradation_rate');
    expect(s.value).toBe(1);
    expect(s.level).toBe('ok');
    expect(s.sample).toBeLessThan(DEGRADATION_MIN_SAMPLE);
    expect(s.says).toContain('below the');
  });

  it('alerts separately when the guard is rejecting model output at volume', () => {
    // A high guard-rejection rate is the injection-shaped signal hiding inside the
    // degradation rate, and it wants a different response than "the API key is wrong".
    const r = at({ narrated: 60, factsOnly: 40, guardRejected: 35 });
    expect(signal(r, 'guard_rejection_rate').level).toBe('alert');
    expect(r.level).toBe('alert');
  });

  it('alerts on spend rate and on the pilot budget independently', () => {
    const rate = at({ narrated: 30, factsOnly: 0 }, { costUsd: 8, calls: 30 }, 10);
    expect(signal(rate, 'spend_rate').value).toBeCloseTo(0.8, 10);
    expect(signal(rate, 'spend_rate').level).toBe('alert');

    const budget = at({ narrated: 30, factsOnly: 0 }, { costUsd: PILOT_BUDGET_USD, calls: 30 }, 365);
    expect(signal(budget, 'spend_rate').level).toBe('ok'); // slow burn
    expect(signal(budget, 'pilot_budget').level).toBe('alert');
  });

  it('takes the worst signal as the overall level', () => {
    const r = at({ narrated: 40, factsOnly: 60 }, { costUsd: 0, calls: 100 });
    expect(r.level).toBe('alert');
  });

  it('says in the payload that nothing is actually notified', () => {
    // The honesty invariant. If a channel is ever wired, this test is the thing that has to
    // change, deliberately, rather than the claim drifting on its own.
    const r = at({ narrated: 100, factsOnly: 0 });
    expect(r.notified).toBe(false);
    expect(r.notice).toContain('not notified');
  });
});

describe('spend per day', () => {
  it('is zero before counting has started', () => {
    expect(spendPerDay(totals({ costUsd: 5 }), null, NOW)).toBe(0);
  });

  it('does not extrapolate an alarming rate out of ten minutes of traffic', () => {
    const tenMinutes = NOW.getTime() - 600_000;
    // $2 in ten minutes is $288/day extrapolated. The divisor floors at one day, so it
    // reports $2/day: still over the alert line, without inventing two orders of magnitude.
    const rate = spendPerDay(totals({ costUsd: 2 }), tenMinutes, NOW);
    expect(rate).toBe(2);
    expect(rate).toBeGreaterThan(SPEND_ALERT_USD_PER_DAY);
  });

  it('divides by elapsed days once a day has elapsed', () => {
    expect(spendPerDay(totals({ costUsd: 10 }), daysAgo(20), NOW)).toBeCloseTo(0.5, 10);
  });
});

describe('the thresholds themselves', () => {
  it('keeps warn strictly below alert, so the two levels cannot collapse', () => {
    expect(DEGRADATION_WARN_RATE).toBeLessThan(DEGRADATION_ALERT_RATE);
  });
});
