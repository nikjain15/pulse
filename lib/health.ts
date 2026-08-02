/**
 * Alert thresholds. SH3.
 *
 * The gap this closes: Pulse had a live spend counter (`lib/usage.ts`, `/api/usage`) and a
 * discriminated degradation union (`NarrationResult` in `lib/narrate.ts`), and **nothing
 * anywhere said what number means "it is broken"**. A dashboard with no threshold is a
 * number somebody glances at, not a control. You cannot page on a vibe.
 *
 * This module is pure: thresholds as constants, one function that turns counters into a
 * verdict. No Firestore, no clock of its own, no network. `lib/usage-admin.ts` keeps the
 * counters, `/api/usage` serves the verdict.
 *
 * ## Be honest about what this is not
 *
 * There is **no notification channel wired**. No pager, no email, no Slack webhook, no
 * cron. Nothing in this repository will wake anybody up. What is built is the MEASUREMENT
 * and the THRESHOLD: `/api/usage` now returns a status of `ok`, `warn` or `alert` with the
 * numbers behind it, so an external check can poll one URL and decide. Calling that
 * "alerting" would be the overclaim; the honest description is that the last mile is a
 * person refreshing a page, and that is written down rather than implied.
 */

import type { UsageTotals } from './usage';

/**
 * Facts-only is a designed, harmless fallback for ONE member's week. A facts-only RATE is a
 * different animal: it means the model path is down, the key is wrong, or the guard has
 * started rejecting everything, and the visible symptom is a feed that quietly goes silent.
 * Nobody complains about a feed that is merely less chatty, which is exactly why it needs a
 * number rather than a reader.
 *
 * 20% is the warn line because the healthy rate is not zero: a member with nothing to say
 * legitimately lands on `nothing_to_say`. 50% is the alert line because at half of all
 * narration attempts degrading, the product has effectively stopped doing the thing it
 * exists to do.
 */
export const DEGRADATION_WARN_RATE = 0.2;
export const DEGRADATION_ALERT_RATE = 0.5;

/** Below this many attempts the rate is noise, so it is reported and never alerted on. */
export const DEGRADATION_MIN_SAMPLE = 20;

/**
 * A guard-rejection rate is the sharper signal hiding inside the degradation rate. A
 * `nothing_to_say` is the model behaving; a `names_another_member` or `contains_markup` at
 * volume means something is steering the model, which is the attack this product is built
 * against. Any sustained rate above 10% of attempts deserves a look at the material.
 */
export const GUARD_REJECTION_ALERT_RATE = 0.1;

/**
 * Spend. TESTING.md prices the uncached path at about $524 over the pilot against about
 * $11 of credit, and `shouldNarrate` is what keeps the real number near the latter. So the
 * threshold is set against the credit, not against the projection: $0.75/day is comfortably
 * above the modelled cached rate and would still exhaust the pilot budget in a fortnight.
 */
export const SPEND_WARN_USD_PER_DAY = 0.5;
export const SPEND_ALERT_USD_PER_DAY = 0.75;

/** The whole pilot budget. Crossing it is an alert regardless of rate. */
export const PILOT_BUDGET_USD = 11;

export type HealthLevel = 'ok' | 'warn' | 'alert';

/** One narration attempt's outcome, counted. Mirrors `NarrationResult` minus the payloads. */
export type OutcomeCounts = {
  /** A sentence was written, checked and published. */
  narrated: number;
  /** Degraded to facts only, for any reason. */
  factsOnly: number;
  /** Specifically: the deterministic guard rejected the model's sentence. */
  guardRejected: number;
  /** No new commits, so no model call was made. Never a degradation; excluded from the rate. */
  skippedCached: number;
};

export function emptyOutcomes(): OutcomeCounts {
  return { narrated: 0, factsOnly: 0, guardRejected: 0, skippedCached: 0 };
}

export type HealthSignal = {
  id: 'degradation_rate' | 'guard_rejection_rate' | 'spend_rate' | 'pilot_budget';
  level: HealthLevel;
  /** The measured number. */
  value: number;
  /** The line it was measured against, at the level reported. */
  threshold: number;
  /** How many observations the value rests on. Small n is reported, never alerted on. */
  sample: number;
  /** One sentence a human can act on. */
  says: string;
};

export type HealthReport = {
  level: HealthLevel;
  signals: HealthSignal[];
  /** Always present. The notification gap, restated wherever the verdict is read. */
  notified: false;
  notice: string;
};

const NOT_WIRED =
  'Measured, not notified. Nothing in this repository sends an alert anywhere; ' +
  'polling GET /api/usage is the whole delivery mechanism today.';

/**
 * The degradation rate: attempts that produced facts only, over attempts that made a model
 * call at all. `skipped_cached` is deliberately excluded, because it is the budget guard working,
 * and folding it in would let a healthy cache hide a broken model behind a flattering ratio.
 */
export function degradationRate(o: OutcomeCounts): number {
  const attempts = o.narrated + o.factsOnly;
  return attempts === 0 ? 0 : o.factsOnly / attempts;
}

export function guardRejectionRate(o: OutcomeCounts): number {
  const attempts = o.narrated + o.factsOnly;
  return attempts === 0 ? 0 : o.guardRejected / attempts;
}

/** USD per day since the counter started. Zero when it has not been running for a day. */
export function spendPerDay(totals: UsageTotals, sinceMs: number | null, now: Date = new Date()): number {
  if (!sinceMs) return 0;
  const days = (now.getTime() - sinceMs) / 86_400_000;
  if (days <= 0) return 0;
  // Under a full day, extrapolating from ten minutes of traffic invents an alarming number
  // out of nothing. Report the raw total per elapsed day but never below one day of divisor.
  return totals.costUsd / Math.max(days, 1);
}

const worst = (levels: HealthLevel[]): HealthLevel =>
  levels.includes('alert') ? 'alert' : levels.includes('warn') ? 'warn' : 'ok';

/**
 * Turn counters into a verdict. Pure, deterministic, and the only place a number becomes a
 * judgement.
 */
export function evaluateHealth({
  outcomes,
  totals,
  countingSinceMs = null,
  now = new Date(),
}: {
  outcomes: OutcomeCounts;
  totals: UsageTotals;
  countingSinceMs?: number | null;
  now?: Date;
}): HealthReport {
  const signals: HealthSignal[] = [];

  const attempts = outcomes.narrated + outcomes.factsOnly;
  const degraded = degradationRate(outcomes);
  const enoughSample = attempts >= DEGRADATION_MIN_SAMPLE;

  signals.push({
    id: 'degradation_rate',
    level: !enoughSample
      ? 'ok'
      : degraded >= DEGRADATION_ALERT_RATE
        ? 'alert'
        : degraded >= DEGRADATION_WARN_RATE
          ? 'warn'
          : 'ok',
    value: degraded,
    threshold: degraded >= DEGRADATION_ALERT_RATE ? DEGRADATION_ALERT_RATE : DEGRADATION_WARN_RATE,
    sample: attempts,
    says: !enoughSample
      ? `${attempts} narration attempts so far, below the ${DEGRADATION_MIN_SAMPLE} needed to read a rate. Reported, not judged.`
      : degraded >= DEGRADATION_ALERT_RATE
        ? 'Half or more of narration attempts are degrading to facts only. The feed is going quiet and nobody will complain about it. Check the API key, the model id, and docs/RUNBOOK.md.'
        : degraded >= DEGRADATION_WARN_RATE
          ? 'Narration is degrading more often than the designed baseline. Worth looking at the reasons before it becomes silence.'
          : 'Narration is landing at the expected rate.',
  });

  const rejected = guardRejectionRate(outcomes);
  signals.push({
    id: 'guard_rejection_rate',
    level: enoughSample && rejected >= GUARD_REJECTION_ALERT_RATE ? 'alert' : 'ok',
    value: rejected,
    threshold: GUARD_REJECTION_ALERT_RATE,
    sample: attempts,
    says:
      enoughSample && rejected >= GUARD_REJECTION_ALERT_RATE
        ? 'The deterministic guard is rejecting model output at volume. Either a prompt change broke the model\'s framing, or something in the material is steering it toward naming peers. Read the rejected reasons before touching the guard.'
        : 'Guard rejections are within the expected range.',
  });

  const perDay = spendPerDay(totals, countingSinceMs, now);
  signals.push({
    id: 'spend_rate',
    level: perDay >= SPEND_ALERT_USD_PER_DAY ? 'alert' : perDay >= SPEND_WARN_USD_PER_DAY ? 'warn' : 'ok',
    value: perDay,
    threshold: perDay >= SPEND_ALERT_USD_PER_DAY ? SPEND_ALERT_USD_PER_DAY : SPEND_WARN_USD_PER_DAY,
    sample: totals.calls,
    says:
      perDay >= SPEND_ALERT_USD_PER_DAY
        ? `Spending $${perDay.toFixed(2)}/day against a $${PILOT_BUDGET_USD} pilot budget. At this rate the credit is gone inside a fortnight. The usual cause is the narration cache missing on unchanged work.`
        : perDay >= SPEND_WARN_USD_PER_DAY
          ? `Spending $${perDay.toFixed(2)}/day, above the modelled cached rate. Check the cache hit rate before it becomes the alert.`
          : 'Spend is within the modelled range.',
  });

  signals.push({
    id: 'pilot_budget',
    level: totals.costUsd >= PILOT_BUDGET_USD ? 'alert' : totals.costUsd >= PILOT_BUDGET_USD * 0.75 ? 'warn' : 'ok',
    value: totals.costUsd,
    threshold: PILOT_BUDGET_USD,
    sample: totals.calls,
    says:
      totals.costUsd >= PILOT_BUDGET_USD
        ? 'The pilot budget is spent. Every further model call is unfunded.'
        : totals.costUsd >= PILOT_BUDGET_USD * 0.75
          ? 'Three quarters of the pilot budget is spent.'
          : 'Inside the pilot budget.',
  });

  return {
    level: worst(signals.map((s) => s.level)),
    signals,
    notified: false,
    notice: NOT_WIRED,
  };
}
