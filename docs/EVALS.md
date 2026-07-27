# Pulse, Evaluation Strategy

How Pulse establishes that its AI behaves: what is implemented today, and what is roadmap. Metrics are named, and claims are tied to real files.

## Why evals matter here specifically

Pulse auto-publishes model output to 64 people with no human in the loop. The eval surface is therefore not "is the sentence nice" but "**can attacker-controlled input ever cause a harmful publish**." The highest-value tests in the repo are the guard and rules tests, not accuracy tests.

## The ladder

### 1. Deterministic unit tests (implemented, the backbone)

The guard, the cache, and the contract are pure functions and are tested exhaustively.

- **Narrative guard:** `tests/unit/sense.test.ts`, `tests/unit/narrate.test.ts` exercise `checkNarrative` for: empty, over-length, markup/HTML, and the load-bearing `names_another_member` case, including Unicode evasions (zero-width splice, combining-mark variants) that `foldForMention` must fold.
- **Generated adversarial matrix:** `tests/unit/gen-sense.test.ts`, `tests/unit/gen-voice.test.ts`, and others table-drive many inputs (digits, single words, 200-char branches, unicode, empty) so coverage does not depend on a human enumerating cases.
- **Cache correctness:** `narrationCacheKey` / `shouldNarrate` are tested so a cache miss on unchanged work (a budget bug) is caught.
- **Cross-app contract:** `tests/unit/contract-golden.test.ts` pins exact contract values; `scripts/audit/contract-drift.mjs` runs it in *both* Pulse and Rally.

**Named metric:** on the guard, the safety-relevant target is **recall on the `names_another_member` class = 100%** (no peer-naming sentence may pass). Because the guard is deterministic, this is asserted directly rather than sampled. False-positive rate (rejecting a legitimate self-narrative) is traded off deliberately toward more rejections, since the fallback is facts-only, not failure.

### 2. Firestore rules evals (implemented)

`tests/rules/firestore.test.ts` and `tests/rules/gen-attacks.test.ts` treat the security rules as the model of "who can write what" and run an allow/deny matrix plus a generated attack set against the emulator. This is the authorization eval: it proves the client cannot forge a narrative, a task, or a shared-memory note.

### 3. Integration / behavioral evals against a real emulator (implemented)

`tests/integration/*` drive the real `lib/data` and `lib/shared-context` functions against the Firestore emulator through the real client SDK, so the rules under test apply exactly as in the browser. Covers sensing, narration cache, reconcile, double-post idempotency, and the cross-app task lifecycle (`shared-context.test.ts`, `cross-app-regression.test.ts`).

### 4. End-to-end (implemented, Playwright)

`tests/e2e/*.spec.ts` (approval queue, ask-ladder, correction, degraded, celebration, privacy, etc.) drive the running app. `degraded.spec.ts` specifically asserts the facts-only path renders when the model is unavailable, the graceful-degradation eval at the UI layer.

### 5. Groundedness / LLM-judge (implemented)

Implemented at [`evals/run-groundedness-eval.ts`](../evals/run-groundedness-eval.ts). Where safety asks "does the narrative name someone else?", this asks the accuracy half: does what the narrative claims trace to the commit/PR evidence Pulse retrieved, or did the model invent work? It runs a labeled dataset (`evals/groundedness-dataset.json`) through two scorers over the same cases:

- **`scoreGroundedness` (deterministic, the CI backbone):** pure and offline — it verifies the *checkable* claims (PR references, file names) against the retrieved evidence and reports accuracy vs labels, ungrounded catch-rate, and false-flag rate. Every label must be reproduced or the run exits non-zero, exactly like the guard eval.
- **`judgeGroundedness` (LLM judge):** the richer judge scoped here originally. It scores a narrative against its evidence and returns a grounded/ungrounded verdict; it runs only when `ANTHROPIC_API_KEY` is set (it costs a model call) and is reported as agreement against the labels. Best-effort — a flaky judge never fails the run.

Still spot-checked, not asserted: **faithfulness** of free-form prose that carries no checkable specific — the deterministic scorer deliberately does not second-guess phrasing, and the LLM judge is the path that covers it where a key exists.

### 6. Named guard metrics over a labeled fixture (implemented)

Section 1 asserts the guard's safety invariant deterministically. This layer reports the guard's behavior as **named classification metrics** over a labeled fixture, so the quality of the block decision is a number, not a claim.

`evals/guard-fixture.json` is a labeled set of 49 narratives, each `{ narrative, authorHandle, otherMembers, expectedBlocked }`, spanning clean self-narratives, peer-named injections (by name, by `@handle`, and zero-width / combining-mark Unicode evasions), markup/formatting injection, and edge cases (empty, over-length, peer names that appear only as substrings or inside identifiers, and neutral invented non-member handles). The handles are neutral invented fixtures, not production members. The positive class is the **block** decision.

The runner [`evals/run-guard-metrics.ts`](../evals/run-guard-metrics.ts) feeds every row through the **real shipped `checkNarrative`** and computes precision, recall, F1, and accuracy for the block decision from `lib/eval-metrics.ts` (a pure metrics module whose math is unit-tested against a hand-built confusion matrix in `tests/unit/eval-metrics.test.ts`). The same computation is CI-gated in that unit test with floors set just below the measured values, so it runs offline with no key on every push.

Measured over the current fixture (real numbers, this is a fixture eval of the guard, not a production-accuracy claim):

| Metric (block decision) | Value | Confusion matrix |
|---|---|---|
| Precision | 100.0% | TP=26, FP=0 |
| Recall | 100.0% | FN=0 |
| F1 | 100.0% | (harmonic mean) |
| Accuracy | 100.0% | TN=23 |

Recall is a hard floor of 1.0 (the safety class: no must-block narrative may pass); precision, F1, and accuracy are floored at 0.95 in CI, just below the measured 1.000, so a regression that starts wrongly rejecting legitimate narratives fails the gate. Run it directly with `npm run eval:guard-metrics`.

### 7. A/B and model evals (roadmap)

Not implemented. Planned once traffic justifies it: A/B the narration prompt and effort setting, measuring reader-reported usefulness against cost per member-day; and a small golden set to compare candidate models before changing `ANTHROPIC_MODEL`.

## Metrics summary

| Layer | Metric | Status |
|---|---|---|
| Narrative guard | Recall on `names_another_member` = 100% (asserted, deterministic) | Implemented |
| Narrative guard | Named precision / recall / F1 / accuracy on the block decision over a labeled fixture (100.0% / 100.0% / 100.0% / 100.0%, CI-gated) | Implemented (fixture eval) |
| Narrative guard | False-positive rate (legit self-narrative rejected) | Tracked; deliberately biased toward rejection |
| Rules | Allow/deny precision on the authorization matrix | Implemented |
| Degradation | Facts-only fallback fires on every model failure mode | Implemented (unit + e2e) |
| Cost | Cache-hit rate; model calls/day vs budget | Modeled in code + TESTING.md; live counter is roadmap |
| Narrative accuracy | Groundedness: checkable claims trace to evidence (deterministic, asserted); LLM judge on top | Implemented |
| Narrative accuracy | Faithfulness of unfalsifiable prose | Spot-checked (LLM judge where a key exists) |
| Prompt/model choice | A/B usefulness vs cost; golden model comparison | Roadmap |

## Optional runnable eval harness

A self-contained, production-safe injection harness for the narrative guard lives at [`/evals`](../evals/README.md). It runs a labeled dataset of injection attempts through the real `checkNarrative` function and reports recall on the "must-block" class and the false-positive rate on the "must-allow" class. It imports the shipped guard directly, touches no network and no Firestore, and is documented in that folder's README. Alongside it, `evals/run-guard-metrics.ts` (`npm run eval:guard-metrics`) runs the labeled fixture from section 6 through the same real guard and prints the named precision / recall / F1 / accuracy of the block decision.
