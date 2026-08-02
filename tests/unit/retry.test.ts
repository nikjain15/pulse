import { describe, expect, it } from 'vitest';
import {
  AttemptTimeoutError,
  RETRY_DEFAULTS,
  backoffDelayMs,
  isTransientError,
  retryAfterMs,
  statusOf,
  withRetry,
  type AttemptRecord,
  type Timer,
} from '@/lib/retry';

/**
 * The retry layer that sits in FRONT of Pulse's graceful degradation.
 *
 * Two things are under test, and they pull in opposite directions. One: a transient blip
 * (a 429, a 503, a dropped socket) must not cost a member their sentence for the week, so it
 * gets another attempt. Two: nothing here may ever hold a user-facing request open, so the
 * whole ladder is bounded in attempts AND in wall time, and a permanent failure (a 400, a 401)
 * is never retried at all.
 *
 * Every test runs on an injected clock, an injected sleep and an injected timer, so the suite
 * has no real timers, no flake, and no reason to be slow.
 */

/** A fake clock, sleep and timer. `sleep` advances the clock by exactly what it slept, so
 *  elapsed time in these tests is the sum of the sleeps plus whatever a timer charged. */
function harness(opts: { timeoutFires?: boolean } = {}) {
  let clock = 0;
  const sleeps: number[] = [];
  const records: AttemptRecord[] = [];

  // Default timer: schedule and never fire. A call that resolves is never a timeout.
  // With `timeoutFires`, every attempt hangs: the timer charges its full budget to the clock
  // and fires on the next macrotask, so the pending call always loses the race.
  const timer: Timer = (ms, fire) => {
    if (!opts.timeoutFires) return () => {};
    const handle = setTimeout(() => {
      clock += ms;
      fire();
    }, 0);
    return () => clearTimeout(handle);
  };

  return {
    sleeps,
    records,
    elapsed: () => clock,
    deps: {
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      timer,
      onAttempt: (r: AttemptRecord) => records.push(r),
    },
  };
}

/** A provider error the way the Anthropic SDK shapes one. */
function apiError(status: number, headers?: Record<string, string>) {
  return Object.assign(new Error(`HTTP ${status}`), { status, headers });
}

/** A call that fails `failures` times and then returns `value`. */
function flaky<T>(failures: number, error: unknown, value: T) {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    if (calls <= failures) throw error;
    return value;
  };
  return { fn, calls: () => calls };
}

describe('isTransientError: retry the weather, never the request', () => {
  it('treats 429, 500, 502, 503, 504 and 529 as worth another attempt', () => {
    for (const status of [429, 500, 502, 503, 504, 529]) {
      expect(isTransientError(apiError(status)), `status ${status}`).toBe(true);
    }
  });

  it('never retries a 400, because the request itself is wrong and will be wrong again', () => {
    // This is the expensive mistake the module exists to avoid: the pinned Opus model 400s on
    // a sampling param, and asking three times buys three identical rejections and the latency
    // of two sleeps before the user gets their fallback.
    expect(isTransientError(apiError(400))).toBe(false);
  });

  it('never retries a 401, because a bad key does not heal by asking twice', () => {
    expect(isTransientError(apiError(401))).toBe(false);
  });

  it('never retries the other permanent statuses (403, 404, 413, 422)', () => {
    for (const status of [403, 404, 413, 422]) {
      expect(isTransientError(apiError(status)), `status ${status}`).toBe(false);
    }
  });

  it('retries a socket failure that carries no HTTP status', () => {
    expect(isTransientError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isTransientError(Object.assign(new Error('boom'), { name: 'APIConnectionError' }))).toBe(true);
    expect(isTransientError(new Error('fetch failed'))).toBe(true);
    expect(isTransientError(new Error('socket hang up'))).toBe(true);
  });

  it('retries its own attempt timeout, because a hung socket is the transient case', () => {
    expect(isTransientError(new AttemptTimeoutError(6_000))).toBe(true);
  });

  it('does not retry an ordinary bug as if it were the network', () => {
    // A malformed response producing a TypeError is a Pulse bug. Retrying it three times
    // wastes the budget and hides the bug behind latency.
    expect(isTransientError(new TypeError('cannot read properties of undefined'))).toBe(false);
    expect(isTransientError('not an error')).toBe(false);
    expect(isTransientError(null)).toBe(false);
  });

  it('finds the status wherever the client hung it', () => {
    expect(statusOf({ status: 503 })).toBe(503);
    expect(statusOf({ statusCode: 429 })).toBe(429);
    expect(statusOf({ response: { status: 500 } })).toBe(500);
    expect(statusOf(new Error('no status'))).toBeUndefined();
  });
});

describe('retryAfterMs: honour the provider, never let it park the request', () => {
  it('honours a delta-seconds Retry-After header', () => {
    expect(retryAfterMs(apiError(429, { 'retry-after': '1' }), 5_000, 0)).toBe(1_000);
  });

  it('honours an HTTP-date Retry-After header', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const err = apiError(503, { 'retry-after': 'Thu, 01 Jan 2026 00:00:02 GMT' });
    expect(retryAfterMs(err, 5_000, now)).toBe(2_000);
  });

  it('caps an absurd Retry-After rather than hanging the request for an hour', () => {
    // The header arrives on the untrusted side of the wire. A user waiting on Home must never
    // be parked by a number in a response: past the cap Pulse prefers to degrade now.
    expect(retryAfterMs(apiError(429, { 'retry-after': '3600' }), 2_000, 0)).toBe(2_000);
  });

  it('ignores a Retry-After it cannot parse, so the backoff curve applies instead', () => {
    expect(retryAfterMs(apiError(429, { 'retry-after': 'soon' }), 5_000, 0)).toBeUndefined();
    expect(retryAfterMs(apiError(429, { 'retry-after': '' }), 5_000, 0)).toBeUndefined();
    expect(retryAfterMs(apiError(429, { 'retry-after': '-5' }), 5_000, 0)).toBeUndefined();
    expect(retryAfterMs(apiError(429), 5_000, 0)).toBeUndefined();
  });

  it('reads Retry-After from a Headers instance and case-insensitively from an object', () => {
    const withHeaders = Object.assign(new Error('429'), {
      status: 429,
      headers: new Headers({ 'Retry-After': '2' }),
    });
    expect(retryAfterMs(withHeaders, 5_000, 0)).toBe(2_000);
    expect(retryAfterMs(apiError(429, { 'Retry-After': '2' }), 5_000, 0)).toBe(2_000);
  });
});

describe('backoffDelayMs: full jitter, so a cohort-wide fan-out cannot re-collide', () => {
  it('grows the ceiling exponentially and then caps it', () => {
    const always = () => 0.999999;
    expect(backoffDelayMs(0, 250, 2_000, always)).toBe(249);
    expect(backoffDelayMs(1, 250, 2_000, always)).toBe(499);
    expect(backoffDelayMs(2, 250, 2_000, always)).toBe(999);
    expect(backoffDelayMs(9, 250, 2_000, always)).toBe(1_999);
  });

  it('draws a different delay each time, so two callers do not retry in lockstep', () => {
    // Narration fans out across the whole cohort in one sync. Fixed backoff would send every
    // member's retry back at the provider as a single wave, which is how a blip becomes an outage.
    const draws = [0.01, 0.5, 0.99];
    let i = 0;
    const delays = draws.map(() => backoffDelayMs(1, 250, 2_000, () => draws[i++]));
    expect(new Set(delays).size).toBe(draws.length);
    for (const d of delays) expect(d).toBeLessThan(500);
  });
});

describe('withRetry: the step in front of the fallback', () => {
  it('returns on the first attempt and never sleeps when the call succeeds', async () => {
    const h = harness();
    const { fn, calls } = flaky(0, apiError(429), 'answer');

    await expect(withRetry(() => fn(), h.deps)).resolves.toBe('answer');

    expect(calls()).toBe(1);
    expect(h.sleeps).toEqual([]);
    expect(h.records).toEqual([{ attempt: 1, outcome: 'ok', elapsedMs: 0 }]);
  });

  it('retries a 429 and returns the answer the second attempt gave', async () => {
    const h = harness();
    const { fn, calls } = flaky(1, apiError(429), 'answer');

    await expect(withRetry(() => fn(), { ...h.deps, random: () => 0.5 })).resolves.toBe('answer');

    expect(calls()).toBe(2);
    expect(h.sleeps).toEqual([125]); // full jitter over the 250ms first-retry ceiling
    expect(h.records.map((r) => r.outcome)).toEqual(['retrying', 'ok']);
    expect(h.records[1].attempt).toBe(2);
  });

  it('retries a 503 and a dropped socket the same way', async () => {
    for (const err of [apiError(503), new Error('socket hang up')]) {
      const h = harness();
      const { fn, calls } = flaky(1, err, 'answer');
      await expect(withRetry(() => fn(), { ...h.deps, random: () => 0 })).resolves.toBe('answer');
      expect(calls()).toBe(2);
    }
  });

  it('gives up after the retry cap and rethrows, so the caller degrades to facts only', async () => {
    const h = harness();
    const boom = apiError(429);
    const { fn, calls } = flaky(99, boom, 'never');

    await expect(withRetry(() => fn(), { ...h.deps, random: () => 0 })).rejects.toBe(boom);

    // Three attempts total: the default cap is two retries, and the rethrown error is the
    // provider's own, so the caller's existing catch reads exactly what it read before.
    expect(calls()).toBe(RETRY_DEFAULTS.maxRetries + 1);
    expect(h.records.at(-1)).toMatchObject({ outcome: 'gave_up', reason: 'no_retries_left' });
  });

  it('rethrows a 400 immediately, without a single retry', async () => {
    const h = harness();
    const boom = apiError(400);
    const { fn, calls } = flaky(99, boom, 'never');

    await expect(withRetry(() => fn(), h.deps)).rejects.toBe(boom);

    expect(calls()).toBe(1);
    expect(h.sleeps).toEqual([]);
    expect(h.records).toEqual([
      { attempt: 1, outcome: 'permanent', elapsedMs: 0, status: 400, reason: 'not_transient' },
    ]);
  });

  it('rethrows a 401 immediately, without a single retry', async () => {
    const h = harness();
    const boom = apiError(401);
    const { fn, calls } = flaky(99, boom, 'never');

    await expect(withRetry(() => fn(), h.deps)).rejects.toBe(boom);

    expect(calls()).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  it('waits exactly the Retry-After the provider asked for, not the backoff curve', async () => {
    const h = harness();
    const { fn } = flaky(1, apiError(429, { 'retry-after': '1' }), 'answer');

    await expect(withRetry(() => fn(), { ...h.deps, random: () => 0.999 })).resolves.toBe('answer');

    expect(h.sleeps).toEqual([1_000]);
    expect(h.records[0]).toMatchObject({ outcome: 'retrying', reason: 'retry_after', delayMs: 1_000 });
  });

  it('caps an absurd Retry-After instead of parking the request on it', async () => {
    const h = harness();
    const { fn } = flaky(1, apiError(429, { 'retry-after': '3600' }), 'answer');

    await expect(
      withRetry(() => fn(), { ...h.deps, maxRetryAfterMs: 500, random: () => 0 })
    ).resolves.toBe('answer');

    expect(h.sleeps).toEqual([500]);
  });

  it('times out a hanging call instead of holding the request open', async () => {
    const h = harness({ timeoutFires: true });
    let aborted = false;
    // A call that never settles and never checks its signal: the worst case, and the one the
    // race exists for. The abort is still raised, so the SDK stops billing tokens in the dark.
    const fn = (signal: AbortSignal) =>
      new Promise<string>(() => {
        signal.addEventListener('abort', () => {
          aborted = true;
        });
      });

    await expect(
      withRetry(fn, { ...h.deps, maxRetries: 0, attemptTimeoutMs: 6_000 })
    ).rejects.toBeInstanceOf(AttemptTimeoutError);

    expect(aborted).toBe(true);
    expect(h.records.at(-1)).toMatchObject({ outcome: 'gave_up', reason: 'timeout' });
  });

  it('keeps total elapsed time inside the budget even when every attempt hangs', async () => {
    const h = harness({ timeoutFires: true });
    const fn = () => new Promise<string>(() => {});

    await expect(
      withRetry(fn, {
        ...h.deps,
        random: () => 0.5,
        attemptTimeoutMs: 6_000,
        totalBudgetMs: 9_000,
      })
    ).rejects.toBeInstanceOf(AttemptTimeoutError);

    // The bound that matters: these calls sit in a Next route with a 10s ceiling, so the whole
    // ladder must finish with time left for the fallback to be assembled and sent.
    expect(h.elapsed()).toBeLessThanOrEqual(9_000);
    expect(h.records.at(-1)?.outcome).toBe('gave_up');
  });

  it('shortens the last attempt to what is left of the budget rather than overrunning it', async () => {
    const h = harness({ timeoutFires: true });
    const fn = () => new Promise<string>(() => {});

    await expect(
      withRetry(fn, { ...h.deps, random: () => 0, attemptTimeoutMs: 6_000, totalBudgetMs: 9_000 })
    ).rejects.toBeInstanceOf(AttemptTimeoutError);

    // Attempt 1 spends its full 6s; attempt 2 is clamped to the remaining 3s, not given 6 more.
    expect(h.elapsed()).toBe(9_000);
  });

  it('gives up early rather than sleeping past the budget for a retry it cannot afford', async () => {
    const h = harness();
    const boom = apiError(429, { 'retry-after': '30' });
    const { fn, calls } = flaky(99, boom, 'never');

    await expect(withRetry(() => fn(), { ...h.deps, totalBudgetMs: 1_000 })).rejects.toBe(boom);

    // A retry we cannot afford is not a retry, it is a slower failure.
    expect(calls()).toBe(1);
    expect(h.sleeps).toEqual([]);
    expect(h.records.at(-1)).toMatchObject({ outcome: 'gave_up', reason: 'out_of_budget' });
  });

  it('reports every attempt, so a caller can log which one actually succeeded', async () => {
    const h = harness();
    const { fn } = flaky(2, apiError(503), 'answer');

    await expect(withRetry(() => fn(), { ...h.deps, random: () => 0.5 })).resolves.toBe('answer');

    expect(h.records).toEqual([
      { attempt: 1, outcome: 'retrying', elapsedMs: 0, status: 503, delayMs: 125, reason: 'backoff' },
      { attempt: 2, outcome: 'retrying', elapsedMs: 125, status: 503, delayMs: 250, reason: 'backoff' },
      { attempt: 3, outcome: 'ok', elapsedMs: 375 },
    ]);
  });

  it('hands the attempt an abort signal, so the SDK can be told to stop', async () => {
    const h = harness();
    let seen: AbortSignal | undefined;
    await withRetry(async (signal) => {
      seen = signal;
      return 'answer';
    }, h.deps);

    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
  });
});
