import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { acceptsSampling, buildPulseResolve, createPulseConduitClient } from '@/lib/conduit/client';

describe('sampling contract', () => {
  it('denies sampling for the current generation, allows it for Haiku 4.5 and older', () => {
    for (const m of ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5']) {
      expect(acceptsSampling(m)).toBe(false);
    }
    for (const m of ['claude-haiku-4-5', 'claude-3-5-haiku-20241022', 'claude-3-haiku-20240307']) {
      expect(acceptsSampling(m)).toBe(true);
    }
  });
});

/** Capture the body Pulse sends to the provider so we can assert what params were forwarded. */
function capturingAnthropic(model: string) {
  const seen: Record<string, unknown>[] = [];
  const anthropic = {
    messages: {
      create: async (body: Record<string, unknown>) => {
        seen.push(body);
        return {
          model,
          content: [{ type: 'text', text: 'hello from the model' }],
          usage: { input_tokens: 1000, output_tokens: 200 },
        };
      },
    },
  } as unknown as Anthropic;
  return { anthropic, seen };
}

describe('buildPulseResolve — the injected model call', () => {
  it('never forwards sampling params to a model that would reject them', async () => {
    const { anthropic, seen } = capturingAnthropic('claude-opus-4-8');
    const resolve = buildPulseResolve(anthropic, { temperature: 0.7, topP: 0.9, topK: 40 });
    await resolve({
      useCase: 'ask-pulse',
      tenantId: 'app:pulse',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 128,
      pinModel: { provider: 'anthropic', model: 'claude-opus-4-8' },
    });
    expect('temperature' in seen[0]).toBe(false);
    expect('top_p' in seen[0]).toBe(false);
    expect('top_k' in seen[0]).toBe(false);
  });

  it('forwards sampling params to Haiku 4.5', async () => {
    const { anthropic, seen } = capturingAnthropic('claude-haiku-4-5');
    const resolve = buildPulseResolve(anthropic, { temperature: 0.5 });
    await resolve({
      useCase: 'ask-pulse',
      tenantId: 'app:pulse',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 128,
      pinModel: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    });
    expect(seen[0].temperature).toBe(0.5);
  });

  it('returns a metered record (priced cost, provider model, latency)', async () => {
    const { anthropic } = capturingAnthropic('claude-opus-4-8');
    const client = createPulseConduitClient(anthropic);
    const res = await client.infer({
      useCase: 'ask-pulse',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 128,
    });
    expect(res.output).toBe('hello from the model');
    expect(res.provider).toBe('anthropic');
    expect(res.costUsd).toBeGreaterThan(0);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
