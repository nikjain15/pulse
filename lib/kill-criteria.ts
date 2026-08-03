/**
 * The kill line. R1.
 *
 * `lib/health.ts` answers "is it broken right now". This answers a different and
 * harder question: **"is it broken badly enough, for long enough, that Pulse should
 * stop doing this?"** Those are not the same, and conflating them is how a product
 * survives on a run of individually-forgivable bad days.
 *
 * ## Why an alert threshold is not a kill line
 *
 * `DEGRADATION_ALERT_RATE` fires on a single reading. A single bad reading is a
 * reason to look, not a reason to stop: a provider blip, one member's odd week, a
 * key rotated at the wrong moment. A kill line has to be about persistence, so
 * this evaluates a **window**, requires a **minimum sample** across it, and names
 * a **consequence that is not "try harder"**.
 *
 * ## The line, pre-committed
 *
 *   Kill the auto-publish design if the degradation rate is at or above 0.5
 *   across a full pilot week (7 consecutive days) with at least 20 narration
 *   attempts in that window.
 *
 *   Consequence: auto-publish OFF. Narratives become drafts a human reviews
 *   before they reach the feed. That is a real change of direction, not a tuning
 *   pass.
 *
 * The number is not invented here. 0.5 is `DEGRADATION_ALERT_RATE`, already in
 * `health.ts` with its reasoning: at half of all narration attempts degrading,
 * the product has stopped doing the thing it exists to do. 20 is
 * `DEGRADATION_MIN_SAMPLE`, already there for the same reason. What is new is the
 * window, the consequence, and the commitment to check.
 *
 * ## The second criterion, which no number can carry
 *
 * The consent criterion in `docs/DECISION_LOG.md` stays and is deliberately N=1:
 * one published narrative a participant did not consent to, or one that names
 * somebody other than its actor, kills the design outright. It is not modelled in
 * this file because it is not a rate and must never be averaged. `evaluate` below
 * takes it as an input the operator sets from a human report, and a `true` there
 * dominates every rate in the module.
 *
 * That asymmetry is the point. A rate can be argued about. A single person
 * publicly attributed something they did not say cannot.
 *
 * ## What this does not do
 *
 * It does not poll and it does not page, for the same reason `health.ts` does not:
 * nothing in this repository has a notification channel. This computes the verdict
 * from counters somebody supplies. The last mile is still a person looking, and
 * saying so is more useful than implying a control loop that does not exist.
 *
 * Pure: no Firestore, no network, no clock of its own.
 */

import {
  DEGRADATION_ALERT_RATE,
  DEGRADATION_MIN_SAMPLE,
  degradationRate,
  type OutcomeCounts,
} from './health';

/** Days of history the kill line is evaluated over. A full pilot week. */
export const KILL_WINDOW_DAYS = 7;

/** The degradation rate that, sustained across the window, kills auto-publish. */
export const KILL_DEGRADATION_RATE = DEGRADATION_ALERT_RATE;

/** Narration attempts required across the window before the rate is readable. */
export const KILL_MIN_ATTEMPTS = DEGRADATION_MIN_SAMPLE;

/** One day of counted outcomes. `date` is an ISO yyyy-mm-dd, used only for ordering. */
export type PilotDay = {
  date: string;
  outcomes: OutcomeCounts;
};

export type KillStatus =
  /** Fewer than KILL_WINDOW_DAYS of history, or too few attempts in it. */
  | 'not_enough_data'
  /** The window is readable and the line has not been crossed. */
  | 'holding'
  /** The line has been crossed. Act on the consequence. */
  | 'crossed';

export type KillVerdict = {
  status: KillStatus;
  /** Which criterion decided it, so the answer is never an unattributed verdict. */
  reason: string;
  /** Degradation rate across the window, or null when it is not readable. */
  windowRate: number | null;
  /** Narration attempts summed across the window. */
  attempts: number;
  /** Days of history actually used. */
  daysConsidered: number;
  /** What to do now. Always concrete; never "keep improving it". */
  action: string;
};

/** Sum a window's counters. Exported because the window total is worth asserting on. */
export function sumOutcomes(days: PilotDay[]): OutcomeCounts {
  return days.reduce<OutcomeCounts>(
    (acc, d) => ({
      narrated: acc.narrated + d.outcomes.narrated,
      factsOnly: acc.factsOnly + d.outcomes.factsOnly,
      guardRejected: acc.guardRejected + d.outcomes.guardRejected,
      skippedCached: acc.skippedCached + d.outcomes.skippedCached,
    }),
    { narrated: 0, factsOnly: 0, guardRejected: 0, skippedCached: 0 },
  );
}

/**
 * Evaluate the kill line against the most recent window.
 *
 * `consentViolationReported` is the N=1 criterion and dominates everything. It is
 * a parameter rather than a counter because nothing in Pulse can detect it: the
 * only detector is a participant speaking up, which `docs/DECISION_LOG.md` states
 * plainly rather than dressing up as monitoring.
 */
export function evaluateKillLine(
  days: PilotDay[],
  consentViolationReported = false,
): KillVerdict {
  // Newest last, so the window is the tail. Sorting here rather than trusting the
  // caller, because an out-of-order series would silently evaluate the wrong week.
  const ordered = [...days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const window = ordered.slice(-KILL_WINDOW_DAYS);
  const totals = sumOutcomes(window);
  const attempts = totals.narrated + totals.factsOnly;

  if (consentViolationReported) {
    return {
      status: 'crossed',
      reason:
        'A participant reported a published narrative they did not consent to, or one naming ' +
        'somebody other than its actor. This criterion is N=1 and is not averaged.',
      windowRate: attempts > 0 ? degradationRate(totals) : null,
      attempts,
      daysConsidered: window.length,
      action:
        'Stop auto-publishing immediately and follow docs/RUNBOOK.md. Do not tune a threshold: ' +
        'this criterion kills the auto-publish design rather than adjusting it.',
    };
  }

  if (window.length < KILL_WINDOW_DAYS) {
    return {
      status: 'not_enough_data',
      reason: `${window.length} day(s) of history, and the line is evaluated over ${KILL_WINDOW_DAYS}.`,
      windowRate: null,
      attempts,
      daysConsidered: window.length,
      action: `Keep running. Re-check once ${KILL_WINDOW_DAYS} days of outcomes exist.`,
    };
  }

  if (attempts < KILL_MIN_ATTEMPTS) {
    // Refusing to read a rate off a tiny sample is the same discipline the eval
    // sets use. A 1-in-2 degradation rate on two attempts is not evidence.
    return {
      status: 'not_enough_data',
      reason:
        `${attempts} narration attempt(s) across the window, below the ${KILL_MIN_ATTEMPTS} ` +
        'needed for the rate to mean anything.',
      windowRate: attempts > 0 ? degradationRate(totals) : null,
      attempts,
      daysConsidered: window.length,
      action: 'Keep running. The rate is not readable yet, so it is reported and not acted on.',
    };
  }

  const rate = degradationRate(totals);
  if (rate >= KILL_DEGRADATION_RATE) {
    return {
      status: 'crossed',
      reason:
        `Degradation rate ${(rate * 100).toFixed(1)}% across ${window.length} days ` +
        `(${attempts} attempts) is at or above the ${(KILL_DEGRADATION_RATE * 100).toFixed(0)}% kill line.`,
      windowRate: rate,
      attempts,
      daysConsidered: window.length,
      action:
        'Turn auto-publish OFF. Narratives become drafts a human reviews before they reach the ' +
        'feed. Reverting to auto-publish requires a new pre-committed line, not a quiet switch back.',
    };
  }

  return {
    status: 'holding',
    reason:
      `Degradation rate ${(rate * 100).toFixed(1)}% across ${window.length} days ` +
      `(${attempts} attempts), below the ${(KILL_DEGRADATION_RATE * 100).toFixed(0)}% kill line.`,
    windowRate: rate,
    attempts,
    daysConsidered: window.length,
    action: 'Continue. Re-check every pilot week.',
  };
}
