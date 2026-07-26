import Anthropic from '@anthropic-ai/sdk';
import { createClient, type ConduitClient, type EmbeddedResolve } from '@conduit/client';
import { computeCallCostUsd, usageFromResponse } from '../usage';

/**
 * Pulse's embedding of `@conduit/client` (see conduit/VENDOR.md).
 *
 * Pulse has no in-process resolver of its own: it calls Anthropic directly. So it runs the
 * client in EMBEDDED mode and injects that Anthropic call as the client's `resolve`. Every
 * generation Pulse makes through the agent loop therefore flows through Conduit's one unified
 * interface and comes back as a metered record (priced `costUsd`, measured `latencyMs`), while
 * the actual provider call stays byte-identical to what Pulse did before.
 *
 * **Server-only.** This reads `ANTHROPIC_API_KEY`, which must never ship to a browser
 * (AGENTS.md rule 8), exactly like `lib/narrate.ts` and `lib/agent-plan.ts`.
 */

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8';

/** Optional sampling knobs a caller may request. Forwarded to the provider ONLY when the
 *  target model accepts them (see `acceptsSampling`). */
export type Sampling = { temperature?: number; topP?: number; topK?: number };

/**
 * The sampling contract. `temperature` / `top_p` / `top_k` are accepted only by Haiku 4.5 and
 * older models; the current generation (Opus 5 / Opus 4.8 / Opus 4.7 / Sonnet 5 / Fable 5)
 * rejects them with HTTP 400. So Pulse decides per target model whether the params may be sent,
 * rather than sending them blindly. Unknown or newer ids default-deny: never send a param the
 * model might reject.
 */
export function acceptsSampling(model: string): boolean {
  const m = model.toLowerCase();
  // Reject-list: current-generation models that 400 on sampling params.
  if (/opus-(4-7|4-8|5)|sonnet-5|fable-5/.test(m)) return false;
  // Haiku 4.5 and older Claude 3.x families accept sampling.
  if (/haiku-4-5|haiku-3|claude-3/.test(m)) return true;
  // Anything else (unrecognised or newer): default deny.
  return false;
}

/**
 * Build the injected `resolve`: one Anthropic text generation, priced and timed. This is the
 * single seam between Pulse and the provider. It never throws sampling params at a model that
 * would reject them; it prices the call with the same `lib/usage` math the live cost counter uses.
 */
export function buildPulseResolve(anthropic: Anthropic, sampling?: Sampling): EmbeddedResolve {
  return async (task) => {
    const model = task.pinModel?.model ?? MODEL;

    const body: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: task.maxTokens,
      messages: task.messages.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })),
    };
    if (task.system) body.system = task.system;

    // Sampling contract: attach knobs only when the target model accepts them.
    if (sampling && acceptsSampling(model)) {
      if (sampling.temperature !== undefined) body.temperature = sampling.temperature;
      if (sampling.topP !== undefined) body.top_p = sampling.topP;
      if (sampling.topK !== undefined) body.top_k = sampling.topK;
    }

    const started = Date.now();
    const response = await anthropic.messages.create(body);
    const latencyMs = Date.now() - started;

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    const usage = usageFromResponse(response.usage);
    const providerModel = response.model ?? model;

    return {
      text,
      model: { provider: 'anthropic', model },
      providerModel,
      costUsd: computeCallCostUsd(providerModel, usage),
      latencyMs,
    };
  };
}

/**
 * Construct the embedded Conduit client for Pulse. Only `infer` (via the injected `resolve`) is
 * wired to a real implementation — that is the one method Pulse's generative path uses. The
 * remaining surface (retrieve / runAgent / evaluate / usage) is present to satisfy the unified
 * interface but not used by Pulse today, so it fails loudly rather than pretending to work.
 */
export function createPulseConduitClient(anthropic: Anthropic, sampling?: Sampling): ConduitClient {
  const notWired = (name: string) => async () => {
    throw new Error(`@conduit/client.${name} is not wired in Pulse; only infer() is used`);
  };
  return createClient({
    mode: 'embedded',
    tenantId: 'app:pulse',
    core: {
      resolve: buildPulseResolve(anthropic, sampling),
      retrieve: notWired('retrieve') as never,
      runAgent: notWired('runAgent') as never,
      evaluate: notWired('evaluate') as never,
      usage: notWired('usage') as never,
    },
  });
}

export const CONDUIT_MODEL = MODEL;
