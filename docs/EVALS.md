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

### 5a. Validating the judge itself (added 2026-08-02)

Everything in section 5 above described what the judge *scores*. Nothing measured whether the judge *marks correctly*, and two things were wrong because of it.

**The eval had never run.** `npm run eval:groundedness` crashed with `ERR_MODULE_NOT_FOUND` before scoring a single case: `lib/groundedness.ts` imported `./retry` without a file extension, which Node's native type stripping cannot resolve. No CI job ran any eval script, so a documented eval could fail on every invocation and the repository still looked healthy. Both are fixed: the import carries its extension, and the `check` job now runs all three offline evals, so a crashing eval fails a build instead of going unnoticed.

**The judge was reported as raw agreement, which cannot be read.** One line, `agreement vs labels`, with nothing to compare it against. On a set that is half grounded, a judge answering "grounded" to everything scores 50 percent; on an 80 percent grounded set it scores 80 and looks strong. Raw agreement measures the dataset as much as the judge, and it cannot distinguish a judge that over-flags honest narratives from one that publishes inventions. Only one of those reaches readers.

What exists now:

- **[`evals/judge-metrics.ts`](../evals/judge-metrics.ts)** reports Cohen's kappa next to raw agreement and next to the base rate raw agreement has to beat, plus both per-class rates separately. The method is ported from Conduit's `evals/judge-metrics.ts` rather than reinvented. Conduit's own first run is the argument for it: a cheap model rejected every case, which a raw catch rate scored as a flawless 100 percent detection rate and kappa scored 0.
- **[`evals/judge-validation-dataset.json`](../evals/judge-validation-dataset.json)**, 24 cases, class balanced 12/12 and enforced in code, so an always-grounded judge scores 50 percent agreement and kappa 0 by construction. Six cases are band `U-SCOPE`: invented work carrying no PR number and no file path, so `scoreGroundedness` is blind to them. That band is the only part of the set that measures what the LLM judge adds over a regex, and a unit test fails if it ever empties.
- **[`evals/run-judge-validation.ts`](../evals/run-judge-validation.ts)** (`npm run eval:judge-validation`) grades the **shipped** `judgeGroundedness`, selecting the model through `ANTHROPIC_MODEL`, the only lever the shipped module exposes. Nothing is reimplemented for the test, so the number is evidence about the judge Pulse runs.

**One dimension, deliberately.** Conduit grades faithfulness and relevance separately because its judge makes two separate claims. Pulse's judge returns one binary verdict, `grounded`, so there is one dimension here. Adding a second would mean measuring something Pulse does not ship.

**Nothing is enforced yet, and that is the honest state.** `ENFORCED` in the runner is empty. The floor is kappa 0.6, the conventional production floor, but no keyed run has happened, so no model is claimed as validated. A model absent from `ENFORCED` is not exempt, it is **unvalidated**, and an unvalidated judge must not be described anywhere as a quality gate. Adding a model there is a claim, and it goes in the same commit as the run that clears the floor, never before.

The arithmetic runs offline on every pull request via `tests/unit/judge-metrics.test.ts` (23 cases), including the two degenerate judges that raw agreement flatters.

### 6. Named guard metrics over a labeled fixture (implemented)

Section 1 asserts the guard's safety invariant deterministically. This layer reports the guard's behavior as **named classification metrics** over a labeled fixture, so the quality of the block decision is a number, not a claim.

`evals/guard-fixture.json` is a labeled set of 76 narratives, each `{ narrative, authorHandle, otherMembers, expectedBlocked }`, spanning clean self-narratives, peer-named injections (by name, by `@handle`, and zero-width / combining-mark Unicode evasions), markup/formatting injection, and edge cases (empty, over-length, peer names that appear only as substrings or inside identifiers, and neutral invented non-member handles). The handles are neutral invented fixtures, not production members. The positive class is the **block** decision.

The runner [`evals/run-guard-metrics.ts`](../evals/run-guard-metrics.ts) feeds every row through the **real shipped `checkNarrative`** and computes precision, recall, F1, and accuracy for the block decision from `lib/eval-metrics.ts` (a pure metrics module whose math is unit-tested against a hand-built confusion matrix in `tests/unit/eval-metrics.test.ts`). The same computation is CI-gated in that unit test with floors set just below the measured values, so it runs offline with no key on every push.

Measured over the current fixture (real numbers, this is a fixture eval of the guard, not a production-accuracy claim):

| Metric (block decision) | Value | Confusion matrix |
|---|---|---|
| Precision | 100.0% | TP=41, FP=0 |
| Recall | 100.0% | FN=0 |
| F1 | 100.0% | (harmonic mean) |
| Accuracy | 100.0% | TN=35 |

Recall is a hard floor of 1.0 (the safety class: no must-block narrative may pass); precision, F1, and accuracy are floored at 0.95 in CI, just below the measured 1.000, so a regression that starts wrongly rejecting legitimate narratives fails the gate. Run it directly with `npm run eval:guard-metrics`.

**Read the 100% honestly, and read its denominator.** These are real numbers, but they are the guard's score on a fixture built for the cases the guard is designed to catch, not a production-accuracy claim. 41 of 41 must-block rows has a 95% Wilson lower bound of **91.4%**, so "100% recall" is statistically compatible with a true recall in the low nineties. That is better than the 87.1% the 26-row fixture supported, and it is still a fixture written by the same person who wrote the code under test.

**What the fixture now says it misses.** The guard's blind spots used to be absent from the fixture entirely, which made the 100% read wider than it was. They are now written into `guard-fixture.json` under `knownResiduals`: a cross-script homoglyph (Cyrillic `М` for Latin `M`), a soft hyphen spliced into a peer name, a name spelled with separating spaces, and a Turkish dotless `ı`. None of them is folded by `foldForMention`, and all four evade the guard today. They are deliberately **excluded from the scored rows**, because scoring them would report a recall below the 1.0 safety floor and the tempting fix would be to relabel them as allowed, which would be a lie about what the guard does. Instead `tests/unit/eval-metrics.test.ts` asserts each one still evades, so the day the fold is widened and one starts being blocked, CI goes red and says to promote it into the scored set. The 100% therefore says the guard handles the evasion classes in the scored fixture (name, `@handle`, zero-width, combining-mark, fullwidth, case, hyphen boundary), and the residual list says what it does not.

**The row count is a floor now, not a ceiling.** The unit test used to assert `rows.length <= 60`, so CI failed if anyone grew the dataset that most needed growing. It now asserts a minimum of 70 rows and at least 25 in each class. Adding cases never breaks the build; removing them does.

### 6a. Semantic retrieval tests (implemented, but the feature is dormant)

`lib/semantic-retrieval.ts` (a cosine vector rerank over the vendored `@conduit/rag`) has its own unit tests covering ranking, the empty/`disabled` path, and the bad-retrieval `not_found` gate. The tests exercise the code with a mock embedder. Be clear about what this proves: it proves the rerank behaves correctly *when an embedder is injected*. In production no embedding provider is wired at the ask-pulse route, so the `search_board` tool degrades to substring matching and the semantic path never runs live. These are tests of a dormant feature, not evidence of live semantic retrieval quality. Retrieval quality on the live substring path is covered indirectly by the answer-path e2e tests, not by a retrieval metric.

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
| **The judge itself** | Cohen's kappa vs a 0.6 floor, reported with the base rate and both per-class rates, on a 12/12 class-balanced set | Harness implemented and CI-gated offline; **no model validated yet**, `ENFORCED` is empty until a keyed run clears the floor |
| Prompt/model choice | A/B usefulness vs cost; golden model comparison | Roadmap |

## Optional runnable eval harness

A self-contained, production-safe injection harness for the narrative guard lives at [`/evals`](../evals/README.md). It runs a labeled dataset of injection attempts through the real `checkNarrative` function and reports recall on the "must-block" class and the false-positive rate on the "must-allow" class. It imports the shipped guard directly, touches no network and no Firestore, and is documented in that folder's README. Alongside it, `evals/run-guard-metrics.ts` (`npm run eval:guard-metrics`) runs the labeled fixture from section 6 through the same real guard and prints the named precision / recall / F1 / accuracy of the block decision.
