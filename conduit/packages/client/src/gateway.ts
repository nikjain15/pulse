/**
 * Gateway transport: implements the unified client surface by calling the
 * conduit-gateway over HTTP against the fixed API contract.
 */
import { ConduitError } from "./error.ts";
import type {
  AgentResult,
  ConduitClient,
  EvaluateParams,
  EvaluateResult,
  FetchLike,
  GatewayConfig,
  InferParams,
  InferResult,
  RetrieveParams,
  RetrieveResult,
  RunAgentParams,
  UsageParams,
  UsageResult,
} from "./types.ts";

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function createGatewayClient(config: GatewayConfig): ConduitClient {
  const base = trimSlash(config.baseUrl);
  const fetchImpl: FetchLike = config.fetch;

  const authHeader = `Bearer ${config.apiKey}`;

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = { Authorization: authHeader };
    const init: { method: string; headers: Record<string, string>; body?: string } = {
      method,
      headers,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const res = await fetchImpl(`${base}${path}`, init);
    if (!res.ok) {
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        try {
          parsed = await res.text();
        } catch {
          parsed = null;
        }
      }
      throw new ConduitError(
        `conduit-gateway ${method} ${path} failed with status ${res.status}`,
        res.status,
        parsed,
      );
    }
    return (await res.json()) as T;
  }

  return {
    mode: "gateway",

    infer(params: InferParams): Promise<InferResult> {
      return request<InferResult>("POST", "/v1/infer", params);
    },

    retrieve(params: RetrieveParams): Promise<RetrieveResult> {
      return request<RetrieveResult>("POST", "/v1/retrieve", params);
    },

    runAgent(params: RunAgentParams): Promise<AgentResult> {
      return request<AgentResult>("POST", "/v1/agent", params);
    },

    evaluate(params: EvaluateParams): Promise<EvaluateResult> {
      return request<EvaluateResult>("POST", "/v1/evals/run", params);
    },

    usage(params?: UsageParams): Promise<UsageResult> {
      const window = params?.window;
      const query = window ? `?window=${encodeURIComponent(window)}` : "";
      return request<UsageResult>("GET", `/v1/usage${query}`);
    },
  };
}
