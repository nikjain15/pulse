# Vendored Conduit sources

This directory holds a copied (not forked, not submoduled) snapshot of the Conduit
AI platform, upstream at `github.com/nikjain15/conduit`. Only the source needed by
Pulse is vendored, under the same `packages/<name>/src` layout as upstream so the
inter-package relative imports keep resolving unchanged.

## What is here

| Package              | Purpose in Pulse                                                              |
| -------------------- | ----------------------------------------------------------------------------- |
| `@conduit/agent`     | The bounded reason-act loop that drives Pulse's generative "Ask Pulse" answer. |
| `@conduit/client`    | The unified SDK. Pulse uses embedded mode, injecting its own model call.       |
| `@conduit/mcp`       | The pure tool registry + transports behind Pulse's read-only MCP server.       |
| `@conduit/inference` | The pure core (`core.ts`) that defines the resolve/type contract. Pulse has no |
|                      | in-process resolver of its own, so the type surface is vendored for the agent. |

Only `inference/src/core.ts` is vendored: it is self-contained (no internal imports)
and supplies the `ChatMessage` type the agent loop shares. The provider adapters,
judge, and RAG/eval packages are intentionally not vendored; Pulse injects its own
model call as the embedded client's `resolve`, so no runtime provider code is needed.

### None of the vendored runtime code runs, including its retry

`inference/src/core.ts` is vendored for its **type surface only**. Its bodies, including the
429 backoff around `anthropic.retries` / `retryBaseMs`, are dead code in this repo: nothing
imports or calls them, because Pulse supplies its own `resolve`. Do not read that file as
evidence that Pulse retries anything.

Pulse's real resilience is `lib/retry.ts`, and it is the only retry in the app. It wraps every
live provider call (`lib/narrate.ts`, `lib/brief.ts`, `lib/extract.ts`, `lib/agent-plan.ts`,
`lib/groundedness.ts`, and the single provider seam in `lib/conduit/client.ts`) with bounded
retry, jittered backoff and a per-attempt timeout, then rethrows so each caller's existing
graceful degradation runs unchanged. See the failure ladder in `docs/ARCHITECTURE.md`.

## How imports resolve

The four packages are exposed to Pulse via `@conduit/*` aliases declared in
`tsconfig.json` (`paths`) and mirrored in `vitest.config.ts`. Next.js reads the
tsconfig paths, so the same aliases work in `next build`, `tsc`, and Vitest. No code
inside the vendored files was edited; the imports are resolved entirely by the alias
mapping.

## Updating

This is a point-in-time copy. To refresh, re-copy the matching `packages/*/src`
files from upstream and re-run `npm run typecheck && npm run test:unit`. Keep the
copy dependency-light: do not vendor provider adapters or the MCP SDK. The MCP SDK
is loaded lazily at runtime only by the stdio/HTTP transports and is an optional
peer, kept out of the pure registry path so the registry stays unit-testable
without it.
