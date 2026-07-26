import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { adminDb } from './broker-admin';
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
    return true;
  } catch {
    // A sensing failure must never surface as a telemetry crash. Swallow.
    return false;
  }
}

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
