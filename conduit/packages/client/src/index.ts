/**
 * @conduit/client public surface.
 *
 * One thin SDK an app imports. The same method surface runs the core
 * in-process (`mode: "embedded"`) or calls the conduit-gateway over HTTP
 * (`mode: "gateway"`). Switching modes changes the transport, never the
 * methods. The SDK has no external dependencies: the caller injects `fetch`
 * (gateway) or the core functions (embedded).
 */
import { createEmbeddedClient } from "./embedded.ts";
import { createGatewayClient } from "./gateway.ts";
import type { ClientConfig, ConduitClient } from "./types.ts";

export function createClient(config: ClientConfig): ConduitClient {
  switch (config.mode) {
    case "embedded":
      return createEmbeddedClient(config);
    case "gateway":
      return createGatewayClient(config);
    default: {
      // Exhaustiveness guard: a config with an unknown mode is a hard error.
      const unknown = config as { mode?: string };
      throw new Error(`unknown client mode: ${String(unknown.mode)}`);
    }
  }
}

export { ConduitError } from "./error.ts";
export type {
  AgentResult,
  ChatMessage,
  ChatRole,
  ClientConfig,
  ClientMode,
  ConduitClient,
  EmbeddedConfig,
  EmbeddedCore,
  EmbeddedResolve,
  EmbeddedResolveResult,
  EmbeddedResolveTask,
  EmbeddedRetrieve,
  EmbeddedRunAgent,
  EmbeddedEvaluate,
  EmbeddedUsage,
  EvaluateParams,
  EvaluateResult,
  FetchInit,
  FetchLike,
  GatewayConfig,
  HttpResponseLike,
  InferParams,
  InferResult,
  ModelRef,
  RetrievedChunk,
  RetrieveParams,
  RetrieveResult,
  RunAgentParams,
  UsageParams,
  UsageResult,
} from "./types.ts";
