/**
 * Bounded retry for provider calls. **The only retry in Pulse.**
 *
 * Pulse's model paths were written to degrade gracefully: narration falls back to facts only,
 * the brief falls back to an assembled sentence, extraction falls back to a thin recipe. That
 * design is deliberate and stays exactly as it is. What was missing is the step BEFORE it: a
 * transient 429 or 503, the provider saying "ask again in a moment", went straight to the
 * fallback, so a blip that a second attempt would have survived cost a member their sentence
 * for the week.
 *
 * So this module is a layer in front of the fallback, never a replacement for it. When retries
 * are exhausted the original error is rethrown, the caller's existing `catch` runs unchanged,
 * and the user sees exactly what they saw before.
 *
 * Note on the vendored Conduit sources: `conduit/packages/inference/src/core.ts` contains its
 * own 429 backoff, but Pulse only vendors that file for its type surface and injects its own
 * provider call (see `conduit/VENDOR.md`), so none of that code runs here. This module is the
 * real one.
 *
 * Pure and injectable: `now`, `random` and the timer are all parameters, so every test in
 * `tests/unit/retry.test.ts` runs with no real clock and no real timer.
 */

/** Statuses worth a second attempt. Everything else is the provider telling us the request
 *  itself is wrong, and asking again would only spend money and time to be told so twice.
 *  529 is Anthropic's "overloaded"; 408 is a request timeout, which is transient by definition. */
const TRANSIENT_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

/** Network-level failures carry no HTTP status. These are the shapes Node, undici and the
 *  Anthropic SDK produce when the socket never got an answer. */
const NETWORK_ERROR_NAMES = new Set([
  'AbortError',
  'TimeoutError',
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'APIUserAbortError',
  'FetchError',
  'RetryAttemptTimeout',
]);

const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const NETWORK_ERROR_MESSAGE =
  /(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network|fetch failed|terminated|timed out|timeout|aborted)/i;

/**
 * The defaults, and why these numbers.
 *
 * Every Pulse model call is small and short: `narrate` and `composeBrief` ask for 300 tokens at
 * `effort: 'low'`, `extractRecipe` 700, one Ask-Pulse turn 512. None of them is a reasoning
 * problem, so a healthy call returns in a couple of seconds. They also all sit inside a Next
 * route handler on Vercel, whose default function ceiling is 10s and which no route in this repo
 * raises with `maxDuration`. Blowing that ceiling is strictly worse than degrading, because the
 * user gets a dead request instead of a warm fallback sentence.
 *
 * That ceiling is what fixes the numbers:
 *
 * - `attemptTimeoutMs: 6_000`: comfortably above a healthy call, low enough that a hung socket
 *   is noticed with time left to do something about it.
 * - `totalBudgetMs: 9_000`: the whole ladder, retries and sleeps included, finishes under the
 *   10s ceiling with a moment to spare for the fallback to be assembled and serialised.
 * - `maxRetries: 2` (3 attempts): a transient blip almost always clears on the second try;
 *   a third is the cheap insurance against a single unlucky redeploy on the provider side.
 *   More would not fit the budget anyway.
 * - `baseDelayMs: 250` / `maxDelayMs: 2_000` with FULL jitter (`random() * capped`): full
 *   jitter, not equal jitter, because the narration path fans out across a whole cohort in one
 *   sync; if every member's retry waited the same 250ms they would re-collide as one wave.
 * - `maxRetryAfterMs: 2_000`: a `Retry-After` is honoured, but a provider (or an attacker who
 *   can shape a response) asking us to sit for an hour must not hang a user-facing request. Past
 *   the cap we prefer to degrade now; the total budget enforces the same thing independently.
 */
export const RETRY_DEFAULTS = {
  maxRetries: 2,
  attemptTimeoutMs: 6_000,
  totalBudgetMs: 9_000,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
  maxRetryAfterMs: 2_000,
} as const;

/** Why an attempt ended. Emitted for every attempt, so a caller can log which one succeeded. */
export type AttemptOutcome =
  /** The call returned. `attempt > 1` means a retry saved it. */
  | 'ok'
  /** Transient failure, and we are going to try again after `delayMs`. */
  | 'retrying'
  /** Transient failure, but out of retries or out of budget. The error is about to be rethrown. */
  | 'gave_up'
  /** Permanent failure (a 400, a 401, a bug). Rethrown immediately, never retried. */
  | 'permanent';

export type AttemptRecord = {
  /** 1-based. */
  attempt: number;
  outcome: AttemptOutcome;
  /** How long the whole operation has taken so far, measured with the injected clock. */
  elapsedMs: number;
  /** HTTP status, when the failure had one. */
  status?: number;
  /** The wait before the next attempt. Only set when `outcome === 'retrying'`. */
  delayMs?: number;
  /** Short machine-readable note: `timeout`, `retry_after`, `backoff`, `out_of_budget`,
   *  `no_retries_left`, `not_transient`. */
  reason?: string;
};

/** Cancels a pending timer. */
type CancelTimer = () => void;

/** Schedules `fire` after `ms`. Injectable so tests need no real timer. */
export type Timer = (ms: number, fire: () => void) => CancelTimer;

export type RetryOptions = {
  maxRetries?: number;
  attemptTimeoutMs?: number;
  totalBudgetMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxRetryAfterMs?: number;
  /** Injected for tests. Defaults to `Math.random`. */
  random?: () => number;
  /** Injected for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Injected for tests. Defaults to a real `setTimeout` sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests. Defaults to `setTimeout`/`clearTimeout`. */
  timer?: Timer;
  /** Called once per attempt, always. This is the observability seam. */
  onAttempt?: (record: AttemptRecord) => void;
};

/** Thrown when an attempt outruns `attemptTimeoutMs`. Transient by construction. */
export class AttemptTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`model call exceeded ${timeoutMs}ms`);
    this.name = 'RetryAttemptTimeout';
    this.timeoutMs = timeoutMs;
  }
}

/** The HTTP status on a provider error, when there is one. The Anthropic SDK puts it on
 *  `status`; other clients use `statusCode` or nest it under `response`. */
export function statusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  const raw = e.status ?? e.statusCode ?? e.response?.status;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

/**
 * Is this worth trying again?
 *
 * The rule that matters is the negative one: a 400 (malformed request, an unsupported sampling
 * param) and a 401 (bad key) are FACTS about the request, not weather. Retrying them burns the
 * user's latency budget to receive the identical rejection. So a failure that carries a status
 * is transient only if that status is in the allow-list, full stop.
 *
 * A failure with no status is a network or abort failure, the socket never got an answer, and
 * those are the textbook retryable case. We still require it to look like one, so an ordinary
 * programming bug (a TypeError from a malformed response) is not retried three times.
 */
export function isTransientError(err: unknown): boolean {
  const status = statusOf(err);
  if (status !== undefined) return TRANSIENT_STATUSES.has(status);

  if (err instanceof AttemptTimeoutError) return true;
  if (typeof err !== 'object' || err === null) return false;

  const e = err as { name?: unknown; code?: unknown; message?: unknown };
  if (typeof e.name === 'string' && NETWORK_ERROR_NAMES.has(e.name)) return true;
  if (typeof e.code === 'string' && NETWORK_ERROR_CODES.has(e.code)) return true;
  if (typeof e.message === 'string' && NETWORK_ERROR_MESSAGE.test(e.message)) return true;
  return false;
}

/** Read a header off whatever shape the client handed us: a `Headers`, a `Map`, or a plain
 *  object. Header names are case-insensitive, so the plain-object path scans case-folded. */
function headerValue(err: unknown, name: string): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const headers = (err as { headers?: unknown }).headers;
  if (!headers) return undefined;

  if (typeof (headers as Headers).get === 'function') {
    const v = (headers as Headers).get(name);
    return v ?? undefined;
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === lower && (typeof v === 'string' || typeof v === 'number')) {
      return String(v);
    }
  }
  return undefined;
}

/**
 * The provider's own instruction, in milliseconds, capped.
 *
 * `Retry-After` is either delta-seconds or an HTTP date. Both are honoured. Both are then
 * capped at `maxMs`, because the header arrives on the untrusted side of the wire and a
 * user-facing request must not be parked for an hour by a number in a response. A value we
 * cannot parse, or a negative one, is simply ignored so the backoff applies instead.
 */
export function retryAfterMs(err: unknown, maxMs: number, nowMs: number): number | undefined {
  const raw = headerValue(err, 'retry-after');
  if (raw === undefined) return undefined;

  const trimmed = raw.trim();
  if (trimmed === '') return undefined;

  const seconds = Number(trimmed);
  const ms = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(trimmed) - nowMs;

  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return Math.min(ms, maxMs);
}

/** Exponential backoff with FULL jitter: a uniform draw over `[0, capped delay)`. Spreading a
 *  cohort-wide fan-out is the whole point, so the low end must be reachable too. */
export function backoffDelayMs(
  attemptIndex: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number
): number {
  const capped = Math.min(maxDelayMs, baseDelayMs * 2 ** attemptIndex);
  return Math.floor(random() * capped);
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const realTimer: Timer = (ms, fire) => {
  const handle = setTimeout(fire, ms);
  return () => clearTimeout(handle);
};

/**
 * Run `fn` with bounded retry, exponential backoff with full jitter, and a hard per-attempt
 * timeout. Rethrows the final error so the caller's existing degradation runs unchanged.
 *
 * `fn` receives an `AbortSignal` and should hand it to the SDK (`messages.create(body,
 * { signal })`) so a timed-out attempt actually stops consuming a socket. The timeout is
 * enforced by a race regardless, so a call that ignores the signal is still bounded, and the
 * signal is what stops it from billing tokens in the background.
 */
export async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? RETRY_DEFAULTS.maxRetries;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? RETRY_DEFAULTS.attemptTimeoutMs;
  const totalBudgetMs = options.totalBudgetMs ?? RETRY_DEFAULTS.totalBudgetMs;
  const baseDelayMs = options.baseDelayMs ?? RETRY_DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? RETRY_DEFAULTS.maxDelayMs;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? RETRY_DEFAULTS.maxRetryAfterMs;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const timer = options.timer ?? realTimer;
  const onAttempt = options.onAttempt;

  const startedAt = now();
  const elapsed = () => now() - startedAt;
  const remaining = () => totalBudgetMs - elapsed();

  let attempt = 0;
  for (;;) {
    attempt += 1;

    // Never let one attempt outlive the budget for the whole operation. On the last legal
    // attempt this is what stops a slow-but-alive provider from blowing the route's ceiling.
    const budgetedTimeout = Math.max(0, Math.min(attemptTimeoutMs, remaining()));

    try {
      const value = await runAttempt(fn, budgetedTimeout, timer);
      onAttempt?.({ attempt, outcome: 'ok', elapsedMs: elapsed() });
      return value;
    } catch (err) {
      const status = statusOf(err);

      if (!isTransientError(err)) {
        onAttempt?.({ attempt, outcome: 'permanent', elapsedMs: elapsed(), status, reason: 'not_transient' });
        throw err;
      }

      const timedOut = err instanceof AttemptTimeoutError;

      if (attempt > maxRetries) {
        onAttempt?.({
          attempt,
          outcome: 'gave_up',
          elapsedMs: elapsed(),
          status,
          reason: timedOut ? 'timeout' : 'no_retries_left',
        });
        throw err;
      }

      // The provider's own instruction wins over our curve when it sends one, capped.
      const advised = retryAfterMs(err, maxRetryAfterMs, now());
      const delayMs = advised ?? backoffDelayMs(attempt - 1, baseDelayMs, maxDelayMs, random);

      // A retry we cannot afford is not a retry, it is a slower failure. Give up now and let
      // the caller degrade while there is still time to render the fallback.
      if (delayMs >= remaining()) {
        onAttempt?.({ attempt, outcome: 'gave_up', elapsedMs: elapsed(), status, reason: 'out_of_budget' });
        throw err;
      }

      onAttempt?.({
        attempt,
        outcome: 'retrying',
        elapsedMs: elapsed(),
        status,
        delayMs,
        reason: timedOut ? 'timeout' : advised !== undefined ? 'retry_after' : 'backoff',
      });

      await sleep(delayMs);
    }
  }
}

/**
 * The default observer: one server-side line per retry, and one when a call only succeeded
 * because of a retry. Silent on the happy first attempt, because that is every call.
 *
 * This is what makes the resilience visible in production. Without it a retried 429 looks
 * identical to a call that just worked, and the operator never learns the provider is wobbling
 * until the day a narration quietly goes facts-only.
 */
export function logAttempts(label: string): (record: AttemptRecord) => void {
  return (record) => {
    if (record.outcome === 'ok') {
      if (record.attempt > 1) {
        console.warn(
          `${label}: succeeded on attempt ${record.attempt} after ${record.elapsedMs}ms`
        );
      }
      return;
    }
    if (record.outcome === 'permanent') return; // The caller's own degradation reports this.
    console.warn(
      `${label}: attempt ${record.attempt} ${record.outcome}` +
        (record.status ? ` (status ${record.status})` : '') +
        (record.reason ? ` [${record.reason}]` : '') +
        (record.delayMs !== undefined ? `, waiting ${record.delayMs}ms` : '')
    );
  };
}

/**
 * One attempt, hard-bounded. The abort is the polite half (it tells the SDK to stop); the race
 * is the load-bearing half (a call that ignores its signal still cannot hang the request).
 */
async function runAttempt<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timer: Timer
): Promise<T> {
  const controller = new AbortController();
  let cancel: CancelTimer = () => {};

  const timeout = new Promise<never>((_, reject) => {
    cancel = timer(timeoutMs, () => {
      const err = new AttemptTimeoutError(timeoutMs);
      controller.abort(err);
      reject(err);
    });
  });

  try {
    // `fn` first: a call that has already settled must win the race, so a timer that fires in
    // the same tick can never mislabel a successful call as a timeout.
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    cancel();
  }
}
