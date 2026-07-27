# Vendored Conduit RAG subset

A copied (not forked, not submoduled) snapshot of the `@conduit/rag` source needed
by Pulse's Ask-Pulse semantic rerank. Upstream at `github.com/nikjain15/conduit`
under `packages/rag/src`. The files are byte-for-byte from upstream; only this
`index.ts` re-export surface and this note are Pulse-authored.

## What is here

| File               | Purpose in Pulse                                                        |
| ------------------ | ---------------------------------------------------------------------- |
| `types.ts`         | `Doc` / `RetrievalResult` / `Retriever`: the transport-agnostic shapes. |
| `vector.ts`        | Cosine similarity and the in-memory vector store used by the rerank.    |
| `tokenize.ts`      | Dependency-free tokenizer shared by the grounding heuristic.            |
| `failure-modes.ts` | `gateRetrieval` (bad-retrieval gate) and the grounding heuristic.       |

## Why only this subset

Pulse injects its own embed function and never runs a database driver, so only the
pure, injectable pieces are vendored. The lexical (BM25), hybrid merger, and
token-budget context packer are intentionally left upstream: the Ask-Pulse rerank
ranks a small, already-retrieved set of the user's own board items by cosine
similarity, then uses `gateRetrieval` to refuse to answer from a weak match. No
provider code, no network, no Firestore.

## How imports resolve

These files import each other by relative `./*.ts` path (upstream layout), which
resolves under the repo's `bundler` module resolution with
`allowImportingTsExtensions`. Pulse code imports the subset from
`@/lib/conduit/rag`. No alias entry is needed because the directory is inside the
app tree, unlike the `@conduit/*` packages under `conduit/packages`.

## Updating

Point-in-time copy. To refresh, re-copy the matching `packages/rag/src` files from
upstream and re-run `npm run typecheck && npm run test:unit`. Keep it
dependency-light: do not vendor provider adapters or a pgvector driver.
