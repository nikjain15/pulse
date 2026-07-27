/**
 * The two RAG failure modes, handled explicitly.
 *
 * (a) Bad retrieval. If nothing relevant was retrieved, the model must not be
 *     asked to answer from an empty or weak context, because it will invent.
 *     `gateRetrieval` inspects the top score and, below a threshold, returns a
 *     "no relevant context" signal so the caller can say not-found instead.
 *
 * (b) Unfaithful answer. Even with good context, a model can assert things the
 *     context does not support. `checkGroundedness` flags answer sentences whose
 *     content words are not covered by any retrieved chunk.
 *
 *     IMPORTANT: `checkGroundedness` is a LEXICAL-OVERLAP HEURISTIC, not an
 *     entailment checker. It catches claims with no lexical anchor in the
 *     retrieved text. It cannot detect paraphrased contradictions, negation
 *     flips, or numeric errors that reuse the same words. Treat a "grounded"
 *     verdict as "no obvious unsupported span found", not as proof of truth.
 */

import type { RetrievalResult } from "./types.ts";
import { contentTokens, DEFAULT_STOPWORDS } from "./tokenize.ts";

/* ------------------------------------------------------------------ */
/* (a) Bad retrieval gate                                             */
/* ------------------------------------------------------------------ */

export interface RetrievalGateOptions {
  /** Minimum acceptable top score. Below this, context is treated as absent. */
  minTopScore: number;
}

export interface RetrievalGateResult {
  /** True if retrieval cleared the threshold and answering is appropriate. */
  hasRelevantContext: boolean;
  /** The top score observed (0 when there were no results). */
  topScore: number;
  /** Human-readable reason, present when hasRelevantContext is false. */
  reason?: string;
}

/**
 * Decide whether retrieval is strong enough to answer from. The score scale is
 * whatever the retriever produced, so pick `minTopScore` to match it (BM25
 * absolute scores, cosine in [0, 1], or hybrid normalized scores).
 */
export function gateRetrieval(
  results: RetrievalResult[],
  options: RetrievalGateOptions,
): RetrievalGateResult {
  if (results.length === 0) {
    return {
      hasRelevantContext: false,
      topScore: 0,
      reason: "no documents retrieved",
    };
  }
  const topScore = results[0].score;
  if (topScore < options.minTopScore) {
    return {
      hasRelevantContext: false,
      topScore,
      reason: `top score ${topScore.toFixed(4)} below threshold ${options.minTopScore}`,
    };
  }
  return { hasRelevantContext: true, topScore };
}

/* ------------------------------------------------------------------ */
/* (b) Groundedness heuristic                                         */
/* ------------------------------------------------------------------ */

export interface GroundednessOptions {
  /**
   * Minimum fraction of a sentence's content words that must appear in the
   * retrieved text for the sentence to count as supported. Default 0.5.
   */
  minOverlap?: number;
  /** Stopwords excluded from content-word scoring. */
  stopwords?: ReadonlySet<string>;
}

export interface GroundednessClaim {
  sentence: string;
  supported: boolean;
  /** Fraction of content words found in the retrieved text, 0 to 1. */
  overlap: number;
}

export interface GroundednessReport {
  /** True when every content-bearing sentence cleared the overlap threshold. */
  grounded: boolean;
  claims: GroundednessClaim[];
  /** Sentences that failed the threshold. */
  unsupported: string[];
  /** Names the technique so callers do not overclaim. */
  method: "lexical-overlap-heuristic";
}

/** Split an answer into rough sentences on ., !, ? and newlines. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Flag answer sentences not supported by any retrieved chunk, using content-word
 * overlap. This is a heuristic (see the module header): it detects claims that
 * share few or no content words with the retrieved context.
 */
export function checkGroundedness(
  answer: string,
  retrievedChunks: RetrievalResult[],
  options: GroundednessOptions = {},
): GroundednessReport {
  const minOverlap = options.minOverlap ?? 0.5;
  const stopwords = options.stopwords ?? DEFAULT_STOPWORDS;

  const contextVocab = new Set<string>();
  for (const chunk of retrievedChunks) {
    for (const tok of contentTokens(chunk.text, stopwords)) {
      contextVocab.add(tok);
    }
  }

  const claims: GroundednessClaim[] = [];
  const unsupported: string[] = [];

  for (const sentence of splitSentences(answer)) {
    const words = contentTokens(sentence, stopwords);
    if (words.length === 0) {
      // No content words to check (e.g. "It is."). Do not penalize.
      claims.push({ sentence, supported: true, overlap: 1 });
      continue;
    }
    let hits = 0;
    for (const w of words) if (contextVocab.has(w)) hits++;
    const overlap = hits / words.length;
    const supported = overlap >= minOverlap;
    claims.push({ sentence, supported, overlap });
    if (!supported) unsupported.push(sentence);
  }

  return {
    grounded: unsupported.length === 0,
    claims,
    unsupported,
    method: "lexical-overlap-heuristic",
  };
}
