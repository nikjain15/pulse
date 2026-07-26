# Pulse, Eval Harnesses

Small, self-contained, production-safe evals for the auto-publish path. Two harnesses live here:

- **`run-guard-eval.ts`** — narrative-guard (safety): does an attacker-influenced narrative get blocked?
- **`run-groundedness-eval.ts`** — groundedness (accuracy): does a published narrative trace to the actual commit/PR evidence, or did the model invent work? (EVALS.md §5)

---

## Narrative-guard eval (`run-guard-eval.ts`)

A self-contained, production-safe eval for the guard that protects Pulse's auto-publish path.

### What it tests

Pulse reads attacker-influenced text (commit messages, PR titles, branch names), feeds it to a model, and auto-publishes the result to the whole cohort with no human in the loop. `checkNarrative` (`lib/sense.ts`) is the deterministic backstop. This harness runs a labeled dataset of injection attempts and legitimate narratives through the **real shipped guard** and reports:

- **must_block recall:** fraction of injection attempts the guard rejects. The safety invariant is **100%**; anything less fails with a non-zero exit.
- **must_allow pass-rate:** fraction of legitimate self-narratives kept.
- **false-positive rate:** legitimate narratives wrongly rejected.

The dataset (`dataset.json`) covers the load-bearing cases: naming a peer by name or `@handle`, zero-width-space and combining-mark Unicode evasions, markup injection, empty output, and over-length output, plus clean self-narratives that must survive.

### Why it is safe

`lib/sense.ts` is a pure module: no network, no Firestore, no model calls. The harness imports `checkNarrative` directly and exercises it in-process. It spends nothing, touches no production data, and cannot affect the live app.

### Run it

Requires Node >= 23.6 (native TypeScript stripping). This repo's environment uses Node 26.

```bash
node evals/run-guard-eval.ts
```

Exit code is non-zero if any `must_block` case slips through, so it can be wired into CI as a safety gate.

### Extending

Add cases to `dataset.json` with a `class` of `must_block` or `must_allow`. Good additions: new Unicode confusables, longer injected preambles, and edge cases around members whose names are substrings of the actor's name. Cross-script homoglyph folding is a known residual in the guard (see `foldForMention` in `lib/sense.ts`); a case for it belongs here once that fold is added.

---

## Groundedness eval (`run-groundedness-eval.ts`)

Safety asks "does the narrative name someone else?" — groundedness asks the other half: "is what it claims real?". This harness scores published narratives against the evidence Pulse retrieved.

### What it tests

`groundedness-dataset.json` is a labeled set of narratives paired with their evidence (commit count, PR numbers, files touched, raw material). Labels are ground truth: `grounded: true` means every checkable claim traces to the evidence; `false` means the narrative invents a specific — a PR number, a file — the evidence never supports.

Two scorers run over the same set:

- **`scoreGroundedness` (deterministic, the CI backbone):** pure, offline, no spend. It verifies the *checkable* claims — PR references and file names — against the evidence, and reports accuracy vs labels, ungrounded catch-rate, and false-flag rate. Every label must be reproduced; a single miss exits non-zero.
- **`judgeGroundedness` (LLM judge, EVALS.md §5):** the richer judge. Runs only when `ANTHROPIC_API_KEY` is set, and is reported as agreement against the labels. It never fails the run — a flaky judge is a judge problem, not a regression.

### Why it is safe

The deterministic path imports `lib/groundedness.ts` (pure) and runs in-process: no network, no Firestore, no spend. The LLM-judge path only activates when a key is present and is strictly best-effort.

### Run it

```bash
node evals/run-groundedness-eval.ts               # deterministic scorer only
ANTHROPIC_API_KEY=sk-... node evals/run-groundedness-eval.ts   # + LLM judge
```

### Extending

Add cases to `groundedness-dataset.json`. Good additions: fabricated commit counts, files named only in prose, and PRs off-by-one from a real number. When the deterministic scorer can't decide a case, the LLM judge is the path that catches it — add such cases and run with a key to measure the judge.
