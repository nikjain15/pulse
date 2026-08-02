import { NextResponse } from 'next/server';
import { readOutcomes, readTotals } from '@/lib/usage-admin';
import { evaluateHealth, type HealthReport, type OutcomeCounts } from '@/lib/health';
import { cacheHitRate, type UsageTotals } from '@/lib/usage';

/**
 * GET /api/usage — the live cost/usage counter. TECHNICAL_NOTES §9 called a live counter
 * roadmap; this is the read side.
 *
 * The cost story (TESTING.md) was until now a projection: ~$524 uncached vs ~$27 cached.
 * Every real model call now increments a persisted counter (see `lib/usage-admin`), so this
 * turns the projection into a measured number — calls made, tokens spent, cache-hit rate,
 * and total USD. Read-only and safe: it exposes aggregate spend, never any narrative,
 * member, or key.
 *
 * When the Admin SDK isn't configured, `readTotals` returns zeros rather than erroring —
 * the endpoint always answers.
 */

export type UsageResponse = UsageTotals & {
  cacheHitRate: number;
  /**
   * SH3. The counter alone never said what number means "it is broken". `health` is the
   * verdict: `ok`, `warn` or `alert`, with the measured value and the line it crossed for
   * each signal. Thresholds live in `lib/health.ts`.
   *
   * This is the whole delivery mechanism. Nothing sends an alert anywhere; an external
   * check polling this endpoint and reading `health.level` is what turns it into one, and
   * `health.notice` says so in the payload rather than only in a document.
   */
  health: HealthReport;
  outcomes: OutcomeCounts;
};

export async function GET() {
  const [totals, { outcomes, countingSinceMs }] = await Promise.all([readTotals(), readOutcomes()]);
  const body: UsageResponse = {
    ...totals,
    cacheHitRate: cacheHitRate(totals),
    outcomes,
    health: evaluateHealth({ outcomes, totals, countingSinceMs }),
  };
  return NextResponse.json(body);
}
