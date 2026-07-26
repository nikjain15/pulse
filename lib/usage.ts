import type Anthropic from '@anthropic-ai/sdk';

/**
 * Live cost/usage accounting for model calls. TECHNICAL_NOTES §9 named a live counter as
 * roadmap — this is it, the pure half.
 *
 * The cost story in TESTING.md is a *model* (a projected ~$524 uncached vs ~$27 cached).
 * This module turns each real model call into a real, priced number so the projection
 * becomes measurable: every call's token usage is priced here and (via `usage-admin`)
 * persisted and summed. No admin/Firestore import lives in this file, so it stays pure and
 * unit-testable; persistence is the caller's concern.
 */

/** Per-model prices in USD per 1M tokens. Sourced from the published Anthropic price list. */
export type ModelPricing = {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWritePerM: number;
};

/**
 * Opus 4.8 is the pinned default (`ANTHROPIC_MODEL ?? 'claude-opus-4-8'`). Cache read is
 * ~0.1x input, cache write ~1.25x input — the standard ephemeral-cache multipliers.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-8': { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25 },
};

/** Fallback when a call ran on a model we don't have a price for — never silently free. */
export const DEFAULT_PRICING: ModelPricing = MODEL_PRICING['claude-opus-4-8'];

export function pricingFor(model: string): ModelPricing {
  return MODEL_PRICING[model] ?? DEFAULT_PRICING;
}

/** The token counts one model call spent. All fields default to 0. */
export type CallUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

const n = (v: number | null | undefined): number => (typeof v === 'number' && v >= 0 ? v : 0);

/** Normalise the SDK's `response.usage` into a `CallUsage`. Missing fields become 0. */
export function usageFromResponse(u: Anthropic.Usage | null | undefined): CallUsage {
  return {
    inputTokens: n(u?.input_tokens),
    outputTokens: n(u?.output_tokens),
    cacheReadInputTokens: n(u?.cache_read_input_tokens),
    cacheCreationInputTokens: n(u?.cache_creation_input_tokens),
  };
}

/** The USD cost of one call, priced per its model. Pure. */
export function computeCallCostUsd(model: string, usage: CallUsage): number {
  const p = pricingFor(model);
  return (
    (usage.inputTokens * p.inputPerM +
      usage.outputTokens * p.outputPerM +
      usage.cacheReadInputTokens * p.cacheReadPerM +
      usage.cacheCreationInputTokens * p.cacheWritePerM) /
    1_000_000
  );
}

/** The running total surfaced to the operator. */
export type UsageTotals = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
};

export function emptyTotals(): UsageTotals {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0,
  };
}

/** Fold one call into a running total. Pure — the reducer the persisted counter mirrors. */
export function addCall(totals: UsageTotals, model: string, usage: CallUsage): UsageTotals {
  return {
    calls: totals.calls + 1,
    inputTokens: totals.inputTokens + usage.inputTokens,
    outputTokens: totals.outputTokens + usage.outputTokens,
    cacheReadInputTokens: totals.cacheReadInputTokens + usage.cacheReadInputTokens,
    cacheCreationInputTokens: totals.cacheCreationInputTokens + usage.cacheCreationInputTokens,
    costUsd: totals.costUsd + computeCallCostUsd(model, usage),
  };
}

/**
 * Cache-hit rate over cached-eligible input tokens — the number the cost story turns on
 * (skip/cache is what makes the pilot affordable). 0 when nothing has been read or written.
 */
export function cacheHitRate(totals: UsageTotals): number {
  const denom = totals.cacheReadInputTokens + totals.cacheCreationInputTokens;
  return denom ? totals.cacheReadInputTokens / denom : 0;
}
