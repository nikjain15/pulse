# Pulse — Narrative-Guard Eval Harness

A small, self-contained, production-safe eval for the guard that protects Pulse's auto-publish path.

## What it tests

Pulse reads attacker-influenced text (commit messages, PR titles, branch names), feeds it to a model, and auto-publishes the result to the whole cohort with no human in the loop. `checkNarrative` (`lib/sense.ts`) is the deterministic backstop. This harness runs a labeled dataset of injection attempts and legitimate narratives through the **real shipped guard** and reports:

- **must_block recall** — fraction of injection attempts the guard rejects. The safety invariant is **100%**; anything less fails with a non-zero exit.
- **must_allow pass-rate** — fraction of legitimate self-narratives kept.
- **false-positive rate** — legitimate narratives wrongly rejected.

The dataset (`dataset.json`) covers the load-bearing cases: naming a peer by name or `@handle`, zero-width-space and combining-mark Unicode evasions, markup injection, empty output, and over-length output, plus clean self-narratives that must survive.

## Why it is safe

`lib/sense.ts` is a pure module: no network, no Firestore, no model calls. The harness imports `checkNarrative` directly and exercises it in-process. It spends nothing, touches no production data, and cannot affect the live app.

## Run it

Requires Node >= 23.6 (native TypeScript stripping). This repo's environment uses Node 26.

```bash
node evals/run-guard-eval.ts
```

Exit code is non-zero if any `must_block` case slips through, so it can be wired into CI as a safety gate.

## Extending

Add cases to `dataset.json` with a `class` of `must_block` or `must_allow`. Good additions: new Unicode confusables, longer injected preambles, and edge cases around members whose names are substrings of the actor's name. Cross-script homoglyph folding is a known residual in the guard (see `foldForMention` in `lib/sense.ts`); a case for it belongs here once that fold is added.
