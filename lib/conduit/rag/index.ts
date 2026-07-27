/**
 * Vendored subset of @conduit/rag (upstream `packages/rag/src`).
 *
 * Only the pieces Pulse's Ask-Pulse semantic rerank needs are copied here, kept
 * dependency-light and byte-for-byte from upstream so the pure logic stays
 * unit-testable with an injected embed function and no database or network:
 *
 *   - the vector retriever (cosine similarity + an in-memory store),
 *   - the bad-retrieval gate (`gateRetrieval`), which turns a weak top score
 *     into an explicit "no relevant context" signal so the caller says
 *     not-found instead of inventing,
 *   - the tokenizer the gate's sibling grounding heuristic shares.
 *
 * See lib/conduit/rag/VENDOR.md for what is and is not vendored, and why.
 */

export type { Doc, RetrievalResult, Retriever } from './types.ts';

export { tokenize, contentTokens, DEFAULT_STOPWORDS } from './tokenize.ts';

export {
  cosineSimilarity,
  InMemoryVectorStore,
  InMemoryPgVectorStore,
} from './vector.ts';
export type {
  EmbedFn,
  VectorStore,
  PgVectorStore,
  EmbeddingRecord,
} from './vector.ts';

export { gateRetrieval, checkGroundedness } from './failure-modes.ts';
export type {
  RetrievalGateOptions,
  RetrievalGateResult,
  GroundednessOptions,
  GroundednessClaim,
  GroundednessReport,
} from './failure-modes.ts';
