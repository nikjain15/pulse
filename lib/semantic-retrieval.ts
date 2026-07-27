/**
 * Semantic rerank for the Ask-Pulse answer path.
 *
 * Pulse's retrieval today is structured board queries plus exact-match (title substring in
 * `find_task`, `fileOverlap` in `lib/sense.ts`). Exact match misses items that are relevant by
 * meaning but share no keyword with the question ("auth is broken" vs a task titled "login
 * session bug"). This module adds an OPTIONAL semantic rerank over the already-retrieved board
 * items, built on the vendored `@conduit/rag` vector retriever (`lib/conduit/rag`).
 *
 * Two design rules keep it safe and honest:
 *
 *   1. The embed function is INJECTED. With no embedding provider configured, `embed` is
 *      undefined and this returns `{ kind: 'disabled' }`, so the caller falls straight back to
 *      the existing structured retrieval. It is a strict enhancement: never a dependency, and it
 *      invents no accuracy where no embedder exists.
 *
 *   2. The bad-retrieval failure mode is handled explicitly. If the best cosine score is below a
 *      floor, `gateRetrieval` reports no relevant context and this returns `{ kind: 'not_found' }`
 *      so the caller can say it did not find anything, rather than answering from a weak match and
 *      inventing. Grounded by construction.
 *
 * This module ranks; it does not generate. Every answer the agent produces still passes through
 * the unchanged deterministic guard `checkNarrative` before it can be shown.
 */

import { InMemoryVectorStore, gateRetrieval, type EmbedFn, type RetrievalResult } from './conduit/rag';

/** A candidate board item to rank: a stable id and the text to embed (title, project, PR summary). */
export type RerankItem = { id: string; text: string };

export type RerankOutcome =
  /** No embedder configured: the caller keeps the existing structured retrieval. */
  | { kind: 'disabled' }
  /** Nothing cleared the relevance floor: the caller says not-found rather than inventing. */
  | { kind: 'not_found'; topScore: number; reason: string }
  /** Ranked hits, best first, each above the floor. */
  | { kind: 'ranked'; results: RetrievalResult[] };

export type SemanticRerankInput = {
  /** The user's free-text question. */
  question: string;
  /** The board items already retrieved by the structured path, to be reranked by meaning. */
  items: readonly RerankItem[];
  /** Injected embedder. Omitted (or undefined) means no provider is configured: rerank is a no-op. */
  embed?: EmbedFn;
  /** How many ranked hits to return. */
  topK?: number;
  /**
   * Minimum acceptable top cosine score, in [0, 1]. Below this, retrieval is treated as absent so
   * the caller says not-found. Deliberately modest: the goal is to catch a genuinely empty match,
   * not to second-guess a real one.
   */
  minTopScore?: number;
};

export const DEFAULT_TOP_K = 5;
export const DEFAULT_MIN_TOP_SCORE = 0.15;

/**
 * Rerank `items` against `question` by cosine similarity of their embeddings, then gate on the top
 * score. Never throws for want of an embedder: with none, it degrades to `{ kind: 'disabled' }`.
 */
export async function semanticRerank(input: SemanticRerankInput): Promise<RerankOutcome> {
  const { question, items, embed } = input;
  const topK = input.topK ?? DEFAULT_TOP_K;
  const minTopScore = input.minTopScore ?? DEFAULT_MIN_TOP_SCORE;

  // No embedding provider: hand control back to the structured retrieval, unchanged.
  if (!embed) return { kind: 'disabled' };

  // Nothing was retrieved to rerank: that is itself a bad-retrieval outcome.
  if (items.length === 0) {
    return { kind: 'not_found', topScore: 0, reason: 'no documents retrieved' };
  }

  const store = new InMemoryVectorStore(embed);
  await store.add(items.map((i) => ({ id: i.id, text: i.text })));
  const ranked = await store.query(question, topK);

  const gate = gateRetrieval(ranked, { minTopScore });
  if (!gate.hasRelevantContext) {
    return { kind: 'not_found', topScore: gate.topScore, reason: gate.reason ?? 'low relevance' };
  }
  return { kind: 'ranked', results: ranked };
}
