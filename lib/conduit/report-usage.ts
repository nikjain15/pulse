import type { InferResult } from '@conduit/client';

/**
 * Live-usage reporting for the Conduit gateway.
 *
 * When Pulse's generative Ask-Pulse path routes a model call through the embedded
 * `@conduit/client` (see `./client.ts` and `../ask-agent.ts`), each call comes back as a metered
 * record. This module ships that record to the Conduit gateway's authed `POST /v1/decisions`
 * endpoint so a tenant's live usage is visible centrally, WITHOUT ever coupling the answer to the
 * network hop.
 *
 * Three invariants make that safe:
 *
 *   1. **Env-gated.** The reporter does nothing unless BOTH `CONDUIT_GATEWAY_URL` and
 *      `CONDUIT_GATEWAY_TOKEN` are set. Absent either, `reportDecision` is a NO-OP: no fetch, no
 *      throw. So the default deployment (and every existing test) behaves exactly as before.
 *   2. **Fire-and-forget.** The caller does not await the send and must never let it change the
 *      answer. Every failure (network, timeout, non-2xx, a thrown `fetch`) is swallowed. A short
 *      abort timeout keeps a slow gateway from holding a request open.
 *   3. **Server-only.** The bearer token is read from the server environment; like the rest of
 *      `lib/conduit/`, this never runs in a browser.
 */

/** The wire shape accepted by `POST /v1/decisions`. Tenant is derived server-side from the token. */
export interface DecisionReport {
  useCase: string;
  model: string;
  provider: string;
  costUsd: number;
  latencyMs: number;
  tokensIn?: number;
  tokensOut?: number;
  /** The outcome of Pulse's deterministic guard for the answer this call fed, when known. */
  gateStatus?: string;
  /** ISO-8601 instant the decision was recorded. */
  at: string;
}

/** A narrowed `fetch`, so a test can inject a mock. The global `fetch` is assignable to this. */
export type ReporterFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

export interface ReportOptions {
  /** Injected transport; defaults to the global `fetch`. */
  fetchImpl?: ReporterFetch;
  /** Abort the send after this many ms. Defaults to 1500. */
  timeoutMs?: number;
}

/** Read the gateway config from the environment. Returns null unless BOTH values are present. */
function gatewayConfig(): { url: string; token: string } | null {
  const url = process.env.CONDUIT_GATEWAY_URL;
  const token = process.env.CONDUIT_GATEWAY_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

/**
 * Report one metered decision to the gateway. Fire-and-forget: resolves once the attempt settles
 * and NEVER rejects. A NO-OP (resolving immediately) when the gateway env is absent. Callers may
 * safely ignore the returned promise.
 */
export async function reportDecision(decision: DecisionReport, opts: ReportOptions = {}): Promise<void> {
  const config = gatewayConfig();
  if (!config) return;

  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as ReporterFetch | undefined);
  if (!fetchImpl) return;

  const timeoutMs = opts.timeoutMs ?? 1500;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    await fetchImpl(`${config.url}/v1/decisions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(decision),
      signal: controller.signal,
    });
    // Any status is fine here: we do not retry and do not surface failures to the answer path.
  } catch {
    // Swallow everything (network error, abort/timeout, a thrown fetch). Reporting is best-effort.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build a `DecisionReport` from a Conduit `InferResult` plus the `useCase` and (optionally) the
 * gate outcome. Keeps the mapping in one place so callers do not hand-assemble the wire shape.
 * `tokensIn` / `tokensOut` are only attached when provided, since `InferResult` does not carry them.
 */
export function decisionFromInfer(
  useCase: string,
  result: Pick<InferResult, 'model' | 'provider' | 'costUsd' | 'latencyMs'>,
  extra: { gateStatus?: string; tokensIn?: number; tokensOut?: number; at?: string } = {},
): DecisionReport {
  const report: DecisionReport = {
    useCase,
    model: result.model,
    provider: result.provider,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    at: extra.at ?? new Date().toISOString(),
  };
  if (extra.tokensIn !== undefined) report.tokensIn = extra.tokensIn;
  if (extra.tokensOut !== undefined) report.tokensOut = extra.tokensOut;
  if (extra.gateStatus !== undefined) report.gateStatus = extra.gateStatus;
  return report;
}
