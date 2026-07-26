import { NextResponse } from 'next/server';
import { readTotals } from '@/lib/usage-admin';
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

export type UsageResponse = UsageTotals & { cacheHitRate: number };

export async function GET() {
  const totals = await readTotals();
  const body: UsageResponse = { ...totals, cacheHitRate: cacheHitRate(totals) };
  return NextResponse.json(body);
}
