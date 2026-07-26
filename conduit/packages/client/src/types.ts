/**
 * Public wire and method types for @conduit/client.
 *
 * These types are intentionally self-contained. The client does not import the
 * other conduit packages at runtime: the caller injects the core functions
 * (embedded mode) or an HTTP `fetch` (gateway mode). Keeping the shapes local is
 * what lets the SDK ship with zero external dependencies and stay testable.
 */

/* ── Chat primitives ──────────────────────────────────────────────────────── */

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ModelRef {
  provider: string;
  model: string;
}

/* ── Method params (identical in both modes) ──────────────────────────────── */

export interface InferParams {
  useCase: string;
  messages: ChatMessage[];
  system?: string;
  maxTokens?: number;
  pinModel?: ModelRef;
}

export interface RetrieveParams {
  query: string;
  topK?: number;
}

export interface RunAgentParams {
  goal: string;
  maxSteps?: number;
}

export interface EvaluateParams {
  datasetId: string;
}

export interface UsageParams {
  window?: string;
}

/* ── Method results (identical in both modes) ─────────────────────────────── */

export interface InferResult {
  output: string;
  model: string;
  provider: string;
  costUsd: number;
  latencyMs: number;
  decisionId?: string;
}

export interface RetrievedChunk {
  id: string;
  score: number;
  text: string;
}

export interface RetrieveResult {
  chunks: RetrievedChunk[];
  grounded: boolean;
}

export interface AgentResult {
  answer: string;
  steps: unknown[];
}

export interface EvaluateResult {
  summary: string;
  metrics: Record<string, number>;
}

export interface UsageResult {
  totalCostUsd: number;
  byUseCase: Record<string, number>;
}

/* ── The unified client surface both modes implement ──────────────────────── */

export interface ConduitClient {
  readonly mode: ClientMode;
  infer(params: InferParams): Promise<InferResult>;
  retrieve(params: RetrieveParams): Promise<RetrieveResult>;
  runAgent(params: RunAgentParams): Promise<AgentResult>;
  evaluate(params: EvaluateParams): Promise<EvaluateResult>;
  usage(params?: UsageParams): Promise<UsageResult>;
}

/* ── Injected HTTP transport (gateway mode) ───────────────────────────────── */

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * A narrowed `fetch` signature. The global `fetch` (and any spec-compatible
 * mock) is assignable to this, so the caller can pass either.
 */
export type FetchLike = (
  url: string,
  init?: FetchInit,
) => Promise<HttpResponseLike>;

/* ── Injected core functions (embedded mode) ──────────────────────────────── */

/**
 * Result shape the injected `resolve` must return. This is a structural subset
 * of `@conduit/inference` ResolveResult, so a bound `resolve` from that package
 * satisfies it directly.
 */
export interface EmbeddedResolveResult {
  text: string;
  model: ModelRef;
  providerModel?: string;
  costUsd: number;
  latencyMs: number;
  decisionId?: string;
}

export interface EmbeddedResolveTask {
  useCase: string;
  tenantId: string;
  system?: string;
  messages: ChatMessage[];
  maxTokens: number;
  pinModel?: ModelRef;
}

export type EmbeddedResolve = (
  task: EmbeddedResolveTask,
) => Promise<EmbeddedResolveResult>;

export type EmbeddedRetrieve = (
  params: RetrieveParams,
) => Promise<RetrieveResult>;

export type EmbeddedRunAgent = (
  params: RunAgentParams,
) => Promise<AgentResult>;

export type EmbeddedEvaluate = (
  params: EvaluateParams,
) => Promise<EvaluateResult>;

export type EmbeddedUsage = (params: UsageParams) => Promise<UsageResult>;

/**
 * The core implementations the app injects for in-process execution. Each is a
 * thin async function; the caller is responsible for binding any runtime
 * context (transports, DB handles) before injection, which keeps this SDK
 * dependency-light.
 */
export interface EmbeddedCore {
  resolve: EmbeddedResolve;
  retrieve: EmbeddedRetrieve;
  runAgent: EmbeddedRunAgent;
  evaluate: EmbeddedEvaluate;
  usage: EmbeddedUsage;
}

/* ── Config ───────────────────────────────────────────────────────────────── */

export type ClientMode = "embedded" | "gateway";

export interface EmbeddedConfig {
  mode: "embedded";
  core: EmbeddedCore;
  /** Isolation key sent to resolve(). Defaults to "org:example". */
  tenantId?: string;
  /** maxTokens applied when infer() omits it. Defaults to 1024. */
  defaultMaxTokens?: number;
}

export interface GatewayConfig {
  mode: "gateway";
  apiKey: string;
  baseUrl: string;
  /** Injected HTTP transport. Pass the global `fetch` or a mock. */
  fetch: FetchLike;
}

export type ClientConfig = EmbeddedConfig | GatewayConfig;
