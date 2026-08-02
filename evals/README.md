# Pulse, Eval Harnesses

Small, self-contained, production-safe evals for the auto-publish path. Two harnesses live here:

- **`run-guard-eval.ts`** — narrative-guard (safety): does an attacker-influenced narrative get blocked?
- **`run-guard-metrics.ts`**: narrative-guard (named metrics), precision / recall / F1 / accuracy of the block decision over a labeled fixture. (EVALS.md §6)
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

## Named-metric guard eval (`run-guard-metrics.ts`)

Where `run-guard-eval.ts` reports safety recall as a pass/fail invariant, this harness reports the guard's block decision as **named classification metrics**.

### What it tests

`guard-fixture.json` is a labeled fixture of 76 rows, each `{ narrative, authorHandle, otherMembers, expectedBlocked }`, covering clean self-narratives, peer-named injections (name, `@handle`, zero-width and combining-mark Unicode evasions), markup/formatting injection, and edge cases (empty, over-length, peer names that appear only as substrings or inside identifiers, and neutral invented non-member handles). The positive class is the **block** decision.

The runner feeds every row through the **real shipped `checkNarrative`** and computes precision, recall, F1, and accuracy from `lib/eval-metrics.ts`, whose math is unit-tested against a hand-built confusion matrix. Over the current fixture the guard scores 100.0% precision / 100.0% recall / 100.0% F1 / 100.0% accuracy (TP=41, FP=0, FN=0, TN=35). This is a fixture eval of the guard, not a production-accuracy claim; the handles are neutral invented fixtures. 41 of 41 must-block rows is a 95% Wilson lower bound of 91.4%.

The fixture also carries `knownResiduals`: four evasions the guard misses today (cross-script homoglyph, soft hyphen, spaced-out name, dotless `ı`), kept out of the score on purpose and asserted in `tests/unit/eval-metrics.test.ts` to still evade. Promote one into `rows` the day the fold is widened to catch it. Growing `rows` is always safe: the unit test enforces a floor of 70 rows, never a ceiling.

### Why it is safe

Same as the guard eval: `lib/sense.ts` and `lib/eval-metrics.ts` are pure modules imported in-process. No network, no Firestore, no spend.

### Run it

```bash
node evals/run-guard-metrics.ts      # or: npm run eval:guard-metrics
```

The identical computation is CI-gated in `tests/unit/eval-metrics.test.ts` with floors just below the measured values (recall hard-floored at 1.0), so it runs offline with no key on every push.

### Extending

Add rows to `guard-fixture.json`. If you add rows that change the measured confusion matrix, update the pinned matrix in `tests/unit/eval-metrics.test.ts` and the numbers in `docs/EVALS.md` together.

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
