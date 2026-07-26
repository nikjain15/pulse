import { describe, expect, it } from 'vitest';
import {
  addCall,
  cacheHitRate,
  computeCallCostUsd,
  emptyTotals,
  pricingFor,
  usageFromResponse,
  type CallUsage,
} from '@/lib/usage';

/**
 * The pure half of the live cost counter (TECHNICAL_NOTES §9). Pricing and the running
 * total are asserted here; persistence (usage-admin) is best-effort and covered separately.
 */

const usage = (over: Partial<CallUsage> = {}): CallUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  ...over,
});

describe('computeCallCostUsd — real dollars per call', () => {
  it('prices Opus 4.8 input and output at the published rate', () => {
    // 1M input @ $5 + 1M output @ $25 = $30.
    const cost = computeCallCostUsd('claude-opus-4-8', usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }));
    expect(cost).toBeCloseTo(30, 6);
  });

  it('prices cache reads far below fresh input', () => {
    const read = computeCallCostUsd('claude-opus-4-8', usage({ cacheReadInputTokens: 1_000_000 }));
    const fresh = computeCallCostUsd('claude-opus-4-8', usage({ inputTokens: 1_000_000 }));
    expect(read).toBeLessThan(fresh);
    expect(read).toBeCloseTo(0.5, 6);
  });

  it('never treats an unknown model as free — falls back to a real price', () => {
    expect(computeCallCostUsd('some-future-model', usage({ inputTokens: 1_000_000 }))).toBeGreaterThan(0);
  });

  it('is zero for a zero-token call', () => {
    expect(computeCallCostUsd('claude-opus-4-8', usage())).toBe(0);
  });
});

describe('usageFromResponse — normalises the SDK usage shape', () => {
  it('maps present fields and defaults missing ones to 0', () => {
    const u = usageFromResponse({ input_tokens: 100, output_tokens: 20 } as never);
    expect(u).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
  });

  it('treats null/undefined usage as an all-zero call', () => {
    expect(usageFromResponse(null)).toEqual(usage());
  });
});

describe('addCall / totals — the persisted counter mirrors this reducer', () => {
  it('accumulates calls, tokens, and cost', () => {
    let t = emptyTotals();
    t = addCall(t, 'claude-opus-4-8', usage({ inputTokens: 1_000, outputTokens: 200 }));
    t = addCall(t, 'claude-opus-4-8', usage({ inputTokens: 500, outputTokens: 50 }));
    expect(t.calls).toBe(2);
    expect(t.inputTokens).toBe(1_500);
    expect(t.outputTokens).toBe(250);
    expect(t.costUsd).toBeGreaterThan(0);
  });

  it('reports cache-hit rate over cached-eligible tokens', () => {
    const t = addCall(emptyTotals(), 'claude-opus-4-8', usage({ cacheReadInputTokens: 900, cacheCreationInputTokens: 100 }));
    expect(cacheHitRate(t)).toBeCloseTo(0.9, 6);
  });

  it('reports a 0 cache-hit rate before anything is cached', () => {
    expect(cacheHitRate(emptyTotals())).toBe(0);
  });
});

describe('pricingFor', () => {
  it('returns the pinned model price', () => {
    expect(pricingFor('claude-opus-4-8').inputPerM).toBe(5);
  });
});
