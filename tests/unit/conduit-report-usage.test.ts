import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decisionFromInfer,
  reportDecision,
  type ReporterFetch,
} from '@/lib/conduit/report-usage';

/**
 * The live-usage reporter. It POSTs each metered decision to the Conduit gateway ONLY when both
 * `CONDUIT_GATEWAY_URL` and `CONDUIT_GATEWAY_TOKEN` are set, and must never throw. These tests
 * assert the POST shape + bearer when the env is present, and a true NO-OP when it is absent.
 */

const URL = 'https://gateway.example.test';
const TOKEN = 'tkn_live_123';

/** A fetch mock recording the single call it receives and returning a 202. */
function capturingFetch() {
  const calls: { url: string; init: Parameters<ReporterFetch>[1] }[] = [];
  const fetchImpl: ReporterFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 202 };
  };
  return { fetchImpl, calls };
}

const infer = {
  output: 'hello',
  model: 'claude-opus-4-8',
  provider: 'anthropic',
  costUsd: 0.0123,
  latencyMs: 420,
};

describe('reportDecision: env gating', () => {
  beforeEach(() => {
    delete process.env.CONDUIT_GATEWAY_URL;
    delete process.env.CONDUIT_GATEWAY_TOKEN;
  });
  afterEach(() => {
    delete process.env.CONDUIT_GATEWAY_URL;
    delete process.env.CONDUIT_GATEWAY_TOKEN;
  });

  it('POSTs the decision with a bearer token when both env vars are set', async () => {
    process.env.CONDUIT_GATEWAY_URL = URL;
    process.env.CONDUIT_GATEWAY_TOKEN = TOKEN;
    const { fetchImpl, calls } = capturingFetch();

    const decision = decisionFromInfer('ask-pulse', infer, {
      gateStatus: 'allowed',
      at: '2026-07-26T00:00:00.000Z',
    });
    await reportDecision(decision, { fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${URL}/v1/decisions`);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].init.headers['content-type']).toBe('application/json');

    const body = JSON.parse(calls[0].init.body);
    expect(body).toEqual({
      useCase: 'ask-pulse',
      model: 'claude-opus-4-8',
      provider: 'anthropic',
      costUsd: 0.0123,
      latencyMs: 420,
      gateStatus: 'allowed',
      at: '2026-07-26T00:00:00.000Z',
    });
  });

  it('trims a trailing slash on the gateway URL', async () => {
    process.env.CONDUIT_GATEWAY_URL = `${URL}/`;
    process.env.CONDUIT_GATEWAY_TOKEN = TOKEN;
    const { fetchImpl, calls } = capturingFetch();

    await reportDecision(decisionFromInfer('ask-pulse', infer), { fetchImpl });

    expect(calls[0].url).toBe(`${URL}/v1/decisions`);
  });

  it('is a NO-OP when the env is absent: no send, no throw', async () => {
    const { fetchImpl, calls } = capturingFetch();
    await expect(
      reportDecision(decisionFromInfer('ask-pulse', infer), { fetchImpl }),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('does not send when only the URL is set', async () => {
    process.env.CONDUIT_GATEWAY_URL = URL;
    const { fetchImpl, calls } = capturingFetch();
    await reportDecision(decisionFromInfer('ask-pulse', infer), { fetchImpl });
    expect(calls).toHaveLength(0);
  });

  it('does not send when only the token is set', async () => {
    process.env.CONDUIT_GATEWAY_TOKEN = TOKEN;
    const { fetchImpl, calls } = capturingFetch();
    await reportDecision(decisionFromInfer('ask-pulse', infer), { fetchImpl });
    expect(calls).toHaveLength(0);
  });

  it('swallows a thrown fetch: the answer path is never broken', async () => {
    process.env.CONDUIT_GATEWAY_URL = URL;
    process.env.CONDUIT_GATEWAY_TOKEN = TOKEN;
    const throwing: ReporterFetch = async () => {
      throw new Error('network down');
    };
    await expect(
      reportDecision(decisionFromInfer('ask-pulse', infer), { fetchImpl: throwing }),
    ).resolves.toBeUndefined();
  });

  it('aborts a slow gateway via the timeout without throwing', async () => {
    vi.useFakeTimers();
    process.env.CONDUIT_GATEWAY_URL = URL;
    process.env.CONDUIT_GATEWAY_TOKEN = TOKEN;

    // A fetch that rejects when its abort signal fires, mimicking a real aborted request.
    const hanging: ReporterFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });

    const promise = reportDecision(decisionFromInfer('ask-pulse', infer), {
      fetchImpl: hanging,
      timeoutMs: 10,
    });
    await vi.advanceTimersByTimeAsync(20);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});

describe('decisionFromInfer: wire mapping', () => {
  it('omits optional fields that were not provided', () => {
    const d = decisionFromInfer('ask-pulse', infer, { at: '2026-07-26T00:00:00.000Z' });
    expect(d).toEqual({
      useCase: 'ask-pulse',
      model: 'claude-opus-4-8',
      provider: 'anthropic',
      costUsd: 0.0123,
      latencyMs: 420,
      at: '2026-07-26T00:00:00.000Z',
    });
    expect('gateStatus' in d).toBe(false);
    expect('tokensIn' in d).toBe(false);
    expect('tokensOut' in d).toBe(false);
  });

  it('attaches token counts and gate status when supplied', () => {
    const d = decisionFromInfer('ask-pulse', infer, {
      gateStatus: 'blocked',
      tokensIn: 100,
      tokensOut: 20,
    });
    expect(d.gateStatus).toBe('blocked');
    expect(d.tokensIn).toBe(100);
    expect(d.tokensOut).toBe(20);
  });
});
