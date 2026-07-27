/**
 * Minimal, dependency-free tokenization used by the lexical retriever and the
 * grounding heuristics. This is deliberately simple: lowercase, split on any
 * run of non-alphanumeric characters, drop empties. It is NOT a model
 * tokenizer; it is a stable, reproducible word splitter for pure logic.
 */

/** Split text into lowercased alphanumeric tokens. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length > 0) out.push(raw);
  }
  return out;
}

/** A small, opt-in English stopword set for the grounding heuristic. */
export const DEFAULT_STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "of", "to", "in", "on",
  "at", "by", "for", "with", "as", "is", "are", "was", "were", "be", "been",
  "being", "it", "its", "this", "that", "these", "those", "from", "into",
  "over", "under", "about", "than", "so", "such", "not", "no", "do", "does",
  "did", "has", "have", "had", "will", "would", "can", "could", "should",
  "may", "might", "must", "we", "you", "they", "he", "she", "i",
]);

/** Tokenize and strip stopwords. Used for content-word overlap scoring. */
export function contentTokens(
  text: string,
  stopwords: ReadonlySet<string> = DEFAULT_STOPWORDS,
): string[] {
  return tokenize(text).filter((t) => !stopwords.has(t));
}
