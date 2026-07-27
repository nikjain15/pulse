/**
 * Shared, transport-agnostic types for the RAG core.
 *
 * Everything in this package is pure: no live network, no database driver.
 * Embedding and token-estimation are injected as functions so callers can
 * mock them in tests or wire real implementations at the edge.
 */

/** A source document to be indexed. */
export interface Doc {
  id: string;
  text: string;
}

/** A ranked retrieval hit. Higher score means more relevant. */
export interface RetrievalResult {
  id: string;
  score: number;
  text: string;
}

/** A retriever produces ranked results for a free-text query. */
export interface Retriever {
  query(query: string, topK: number): Promise<RetrievalResult[]>;
}
