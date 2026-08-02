import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { adminDb } from './broker-admin';
import { emptyOutcomes, type OutcomeCounts } from './health';
import { cutoffFor, ruleFor } from './retention';
import {
  computeCallCostUsd,
  emptyTotals,
  type CallUsage,
  type UsageTotals,
} from './usage';

/**
 * Persistence for the live cost/usage counter. This is the Admin-SDK half — like
 * `broker-admin`, it is server-only and writes with elevated privilege. The pure pricing
 * lives in `lib/usage.ts`; this file only stores and reads.
 *
 * Two documents:
 *   - `usage/totals` — atomically-incremented running totals (calls, tokens, cost), the
 *     "show me the number" surface.
 *   - `usageCalls/{auto}` — one row per real model call, so the total is auditable, not a
 *     bare number nobody can trace.
 *
 * Everything here is **best-effort and never throws**: a telemetry write must not fail a
 * narration or block the board. If Firestore isn't configured (`adminDb()` → null, the
 * common case in dev and in tests with no service account), recording is a silent no-op.
 */

const TOTALS_DOC = 'usage/totals';
const CALLS_COLLECTION = 'usageCalls';

/** What produced the call — narration is the auto-publish path; extraction feeds it. */
export type UsageKind = 'narrate' | 'extract' | 'agent' | 'brief' | 'judge';

export type UsageEntry = { model: string; kind: UsageKind; usage: CallUsage };

/**
 * Record one model call: increment the totals doc and append an audit row. Best-effort.
 * Returns true if it persisted, false if it no-op'd or failed — callers ignore the result.
 */
export async function recordCall(entry: UsageEntry, db: Firestore | null = adminDb()): Promise<boolean> {
  if (!db) return false;
  const cost = computeCallCostUsd(entry.model, entry.usage);
  try {
    await db.doc(TOTALS_DOC).set(
      {
        calls: FieldValue.increment(1),
        inputTokens: FieldValue.increment(entry.usage.inputTokens),
        outputTokens: FieldValue.increment(entry.usage.outputTokens),
        cacheReadInputTokens: FieldValue.increment(entry.usage.cacheReadInputTokens),
        cacheCreationInputTokens: FieldValue.increment(entry.usage.cacheCreationInputTokens),
        costUsdMicros: FieldValue.increment(Math.round(cost * 1_000_000)),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await db.collection(CALLS_COLLECTION).add({
      model: entry.model,
      kind: entry.kind,
      ...entry.usage,
      costUsdMicros: Math.round(cost * 1_000_000),
      at: FieldValue.serverTimestamp(),
    });
    // Retention, enforced by the write path rather than only written down. Sampled so the
    // cost is amortised: one call in fifty pays for a small delete pass, and every call
    // pays nothing. Unawaited, because a retention pass must never delay a narration.
    if (sample()) void pruneUsageCalls(db);
    return true;
  } catch {
    // A sensing failure must never surface as a telemetry crash. Swallow.
    return false;
  }
}

/** How often `recordCall` triggers a prune. Injectable so tests are not at the mercy of a coin flip. */
export const PRUNE_SAMPLE_RATE = 0.02;
let sample: () => boolean = () => Math.random() < PRUNE_SAMPLE_RATE;

/** Test seam: force the prune on or off. Returns the previous sampler so it can be restored. */
export function setPruneSampler(next: () => boolean): () => boolean {
  const previous = sample;
  sample = next;
  return previous;
}

/** Firestore caps a batch at 500 writes. */
const PRUNE_BATCH = 200;

/**
 * Delete `usageCalls` rows past the retention window in `lib/retention.ts`.
 *
 * Bounded to one batch per pass on purpose: this runs inline on a request path, so it
 * trims steadily rather than stalling a narration behind a ten thousand document sweep.
 * `scripts/retention/sweep.ts` is the one that runs to completion.
 *
 * Never throws. A retention miss is a problem to fix; a crashed narration is a broken feed.
 */
export async function pruneUsageCalls(
  db: Firestore | null = adminDb(),
  now: Date = new Date()
): Promise<number> {
  if (!db) return 0;
  const rule = ruleFor(CALLS_COLLECTION);
  const cutoff = rule ? cutoffFor(rule, now) : null;
  if (!cutoff) return 0;
  try {
    const snap = await db
      .collection(CALLS_COLLECTION)
      .where('at', '<', cutoff)
      .limit(PRUNE_BATCH)
      .get();
    if (snap.empty) return 0;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    return snap.size;
  } catch {
    return 0;
  }
}

/**
 * Record what a narration attempt DID, as distinct from what it cost. SH3.
 *
 * `recordCall` answers "how much are we spending"; this answers "is it working". The
 * counters live on the same totals document, incremented atomically, because a degradation
 * rate is only meaningful next to the call count it is a fraction of.
 *
 * `skipped_cached` is counted too, and deliberately excluded from the rate later: it is the
 * budget guard working, and folding it into the denominator would let a healthy cache hide
 * a broken model behind a flattering ratio.
 *
 * Best-effort and never throws, like everything else in this file.
 */
export async function recordOutcome(
  outcome: NarrationOutcome,
  db: Firestore | null = adminDb()
): Promise<boolean> {
  if (!db) return false;
  const field = OUTCOME_FIELD[outcome.kind];
  const patch: Record<string, unknown> = {
    [field]: FieldValue.increment(1),
    updatedAt: FieldValue.serverTimestamp(),
    // When counting began, so a rate has a denominator in time. Set once.
    countingSince: FieldValue.serverTimestamp(),
  };
  // A guard rejection is a facts-only outcome AND its own sharper signal. Count both.
  if (outcome.kind === 'facts_only' && GUARD_REASONS.has(outcome.reason)) {
    patch.outcomeGuardRejected = FieldValue.increment(1);
  }
  try {
    // merge:true with a serverTimestamp on countingSince would overwrite it every call, so
    // it is written only when the document does not have one yet.
    const ref = db.doc(TOTALS_DOC);
    const snap = await ref.get();
    if (snap.exists && snap.get('countingSince')) delete patch.countingSince;
    await ref.set(patch, { merge: true });
    return true;
  } catch {
    return false;
  }
}

/** The narration outcomes worth counting. Mirrors `NarrationResult` in lib/narrate.ts. */
export type NarrationOutcome =
  | { kind: 'narrated' }
  | { kind: 'facts_only'; reason: string }
  | { kind: 'skipped_cached' };

const OUTCOME_FIELD: Record<NarrationOutcome['kind'], string> = {
  narrated: 'outcomeNarrated',
  facts_only: 'outcomeFactsOnly',
  skipped_cached: 'outcomeSkippedCached',
};

/**
 * The facts-only reasons that came from the deterministic guard rejecting a sentence, as
 * opposed to the model declining or being unreachable. `checkNarrative`'s reasons, plus
 * `refused`, which is the model's own safety classifier and belongs in the same bucket.
 */
const GUARD_REASONS = new Set([
  'names_another_member',
  'contains_markup',
  'too_long',
  'empty',
  'refused',
]);

/** Read the running totals. Returns zeros when unconfigured or empty. Never throws. */
export async function readTotals(db: Firestore | null = adminDb()): Promise<UsageTotals> {
  if (!db) return emptyTotals();
  try {
    const snap = await db.doc(TOTALS_DOC).get();
    if (!snap.exists) return emptyTotals();
    const d = snap.data() ?? {};
    const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
    return {
      calls: num(d.calls),
      inputTokens: num(d.inputTokens),
      outputTokens: num(d.outputTokens),
      cacheReadInputTokens: num(d.cacheReadInputTokens),
      cacheCreationInputTokens: num(d.cacheCreationInputTokens),
      // Stored as integer micros to keep the atomic counter exact; presented as dollars.
      costUsd: num(d.costUsdMicros) / 1_000_000,
    };
  } catch {
    return emptyTotals();
  }
}

/**
 * The health inputs: outcome counters plus when counting began. SH3.
 *
 * Read separately from `readTotals` so the spend surface keeps its exact old shape and
 * nothing that consumes it has to change. Returns zeros when unconfigured, because an endpoint
 * that always answers is worth more than one that is precise about being unavailable.
 */
export async function readOutcomes(
  db: Firestore | null = adminDb()
): Promise<{ outcomes: OutcomeCounts; countingSinceMs: number | null }> {
  if (!db) return { outcomes: emptyOutcomes(), countingSinceMs: null };
  try {
    const snap = await db.doc(TOTALS_DOC).get();
    if (!snap.exists) return { outcomes: emptyOutcomes(), countingSinceMs: null };
    const d = snap.data() ?? {};
    const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
    const since = d.countingSince;
    return {
      outcomes: {
        narrated: num(d.outcomeNarrated),
        factsOnly: num(d.outcomeFactsOnly),
        guardRejected: num(d.outcomeGuardRejected),
        skippedCached: num(d.outcomeSkippedCached),
      },
      countingSinceMs:
        since && typeof (since as { toMillis?: () => number }).toMillis === 'function'
          ? (since as { toMillis: () => number }).toMillis()
          : null,
    };
  } catch {
    return { outcomes: emptyOutcomes(), countingSinceMs: null };
  }
}
