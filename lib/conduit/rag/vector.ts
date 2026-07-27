/**
 * Vector retrieval interfaces plus two in-memory implementations.
 *
 * Nothing here connects to a database. The embed function is injected, and the
 * "pgvector" store is expressed as an interface SHAPE only, with an in-memory
 * implementation used for tests. A real deployment would satisfy the same
 * PgVectorStore interface with a Postgres + pgvector driver behind it.
 */

import type { Doc, RetrievalResult, Retriever } from "./types.ts";

/** Turn text into an embedding vector. May be sync or async. */
export type EmbedFn = (text: string) => number[] | Promise<number[]>;

/** Cosine similarity of two equal-length vectors. Returns 0 for degenerate input. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** A vector-backed retriever that owns its embedding step. */
export interface VectorStore extends Retriever {
  add(docs: Doc[]): Promise<void>;
}

/**
 * In-memory cosine-similarity store. Embeds on add and on query using the
 * injected embed function, then ranks by cosine similarity.
 */
export class InMemoryVectorStore implements VectorStore {
  private readonly embed: EmbedFn;
  private readonly records: { id: string; text: string; vector: number[] }[] = [];

  constructor(embed: EmbedFn) {
    this.embed = embed;
  }

  get size(): number {
    return this.records.length;
  }

  async add(docs: Doc[]): Promise<void> {
    for (const doc of docs) {
      const vector = await this.embed(doc.text);
      this.records.push({ id: doc.id, text: doc.text, vector });
    }
  }

  async query(query: string, topK: number): Promise<RetrievalResult[]> {
    const q = await this.embed(query);
    const scored = this.records.map((r) => ({
      id: r.id,
      score: cosineSimilarity(q, r.vector),
      text: r.text,
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(0, topK));
  }
}

/** A stored row: a document plus its precomputed embedding. */
export interface EmbeddingRecord {
  id: string;
  text: string;
  embedding: number[];
}

/**
 * Interface shape for a Postgres + pgvector backed store. This package does NOT
 * implement a driver. It exists so callers can code against a stable contract
 * and swap the in-memory test double for a real DB adapter at the edge.
 */
export interface PgVectorStore extends VectorStore {
  /** Logical table the rows live in (informational for the interface shape). */
  readonly tableName: string;
  /** Insert or replace rows by id, embeddings already computed. */
  upsert(records: EmbeddingRecord[]): Promise<void>;
  /** Rank stored rows against a query embedding (the "ORDER BY embedding <=> $1" step). */
  similaritySearch(embedding: number[], topK: number): Promise<RetrievalResult[]>;
}

/**
 * In-memory implementation of the PgVectorStore shape for tests. Same contract
 * a real pgvector adapter would satisfy, without any database.
 */
export class InMemoryPgVectorStore implements PgVectorStore {
  readonly tableName: string;
  private readonly embed: EmbedFn;
  private readonly rows = new Map<string, EmbeddingRecord>();

  constructor(embed: EmbedFn, tableName = "rag_chunks") {
    this.embed = embed;
    this.tableName = tableName;
  }

  get size(): number {
    return this.rows.size;
  }

  async add(docs: Doc[]): Promise<void> {
    const records: EmbeddingRecord[] = [];
    for (const doc of docs) {
      records.push({ id: doc.id, text: doc.text, embedding: await this.embed(doc.text) });
    }
    await this.upsert(records);
  }

  async upsert(records: EmbeddingRecord[]): Promise<void> {
    for (const rec of records) {
      this.rows.set(rec.id, rec);
    }
  }

  async similaritySearch(embedding: number[], topK: number): Promise<RetrievalResult[]> {
    const scored: RetrievalResult[] = [];
    for (const row of this.rows.values()) {
      scored.push({
        id: row.id,
        score: cosineSimilarity(embedding, row.embedding),
        text: row.text,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(0, topK));
  }

  async query(query: string, topK: number): Promise<RetrievalResult[]> {
    const q = await this.embed(query);
    return this.similaritySearch(q, topK);
  }
}
