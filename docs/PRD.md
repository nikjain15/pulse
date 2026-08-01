# Pulse, Product Requirements

_The AI-first alternative to Jira: a project board that maintains itself._

> Positioning: **"Jira, if it filled itself in."** Every tracking tool runs on manual upkeep. Pulse removes the upkeep by sensing the work directly from commits and PRs and publishing status in plain English, with zero manual updates.

---

## 1. Problem

Every project tool (Jira, Linear, boards of every flavor) runs on manual upkeep: someone drags the ticket, writes the status, grooms the board before standup. Tracking becomes a second job. The moment anyone falls behind, the board quietly lies about where things stand, which is the worst possible failure mode for a tool whose only job is to tell the truth about state.

The insight Pulse is built on: for a team already shipping through version control, **the status already exists** in the commit and PR history. Nobody should be retyping it into a board. Pulse reads the source of truth and writes the board from it.

## 2. Personas

| Persona | Who | Job-to-be-done | Pain today |
|---|---|---|---|
| **Builder (primary)** | A developer in a 65-person cohort shipping in parallel against public repos | "Let me build. Keep my status current without me touching a board." | Context-switching to update tickets; the board is stale by standup |
| **Lead / observer** | Whoever needs to see where the team actually is | "Show me true state and who is stuck, without a status meeting." | Board reflects what people *typed*, not what they *did* |
| **The stuck teammate** | Anyone blocked on a problem a peer already solved | "Connect me to the person who already solved this." | Solutions are invisible; the same problem is re-solved N times |

## 3. Jobs-to-be-done

1. **Sense:** "When I push work, I want my status to reflect it automatically, in language a human reads."
2. **Bank:** "When a problem gets solved, I want the *how* captured so it is reusable."
3. **Broker:** "When I am stuck on something already solved, I want to be introduced to the solver."

The product is a three-layer ladder. Layer 1 (Sense) is live; Layers 2 and 3 are staged (see roadmap). This matches the README's own honesty table and the actual code paths.

## 4. What Pulse does (verified in code)

- **Senses work:** a poll reads each member's commits and PRs; `lib/narrate.ts` turns the evidence into one plain-English status sentence per member, grounded in the actual commit/PR evidence (`lib/sense.ts` `formatEvidence`).
- **Publishes live:** narratives write to Firestore and render in realtime to the cohort; there is no manual "update" action.
- **Degrades to facts:** when the model is unavailable, refuses, or produces a suspect sentence, Pulse publishes **facts only** (commit counts, PR titles) rather than nothing or a lie (`narrate()` returns `facts_only`).
- **Flags stuck work and brokers introductions:** the Bank/Broker layers (`lib/extract.ts`, `lib/introductions.ts`) are designed and partially surfaced, not yet fully automated. Framed as roadmap below.

## 5. Success metrics

| Goal | Metric | Instrumentation |
|---|---|---|
| Remove manual upkeep | % of board state auto-generated vs hand-typed | Target: 100% of status sentences model-or-facts generated (no manual status field exists) |
| Board is *true* | Staleness: time between a push and the board reflecting it | Bounded by poll interval (~15 min in the pilot) |
| Trust the auto-writer | Narrative-guard rejection rate; zero cross-member defamation incidents | `checkNarrative` rejection reasons are counted in tests; production degrades silently to facts |
| Stay within budget | Model spend over the pilot | Modeled ~\$27 cached vs ~\$524 uncached against ~\$11 of credit (see §7 and TECHNICAL_NOTES) |
| Reuse solutions | Bank hit-rate: stuck → matched to a prior solver | Roadmap (Broker layer) |

## 6. Tradeoffs (explicit product decisions)

- **Auto-publish with no human in the loop.** The old design had a human approve each summary. Removing that gate is what makes Pulse feel alive, but it means the model's output goes straight to 64 other people. The mitigation is a deterministic guard (`checkNarrative`), not a human. This is the central product bet and the central risk. See TECHNICAL_NOTES §Guardrails.
- **Facts-only over silence.** When in doubt, publish the verifiable facts, never a guessed or suspect narrative. A confident wrong status is worse than a plain one.
- **Poll, not webhook, in the pilot.** Simpler to operate for a cohort; the cost model is built around the poll cadence and the SHA-range cache that makes it affordable.
- **A pinned model on the publish path, two-tier routing on the ask path.** The auto-publish path (`lib/narrate.ts`) pins one model (`claude-opus-4-8`, env-overridable) at low effort for a one-sentence task, and its cost is controlled by *caching*, not by model-tiering. Ask-Pulse is different: `lib/conduit/routing.ts` picks a tier per model turn, running the bulk of asks on Haiku 4.5 and escalating to the pinned reasoning model when the ask is long, multi-question, already multi-step, or came back hedged (`lib/ask-agent.ts` passes the choice as `pinModel`). Honest about the scope: that is two Anthropic tiers chosen by a deterministic rule, not multi-provider orchestration, and narration itself is still single-model.

## 7. Cost as a product constraint

The pilot ran against a fixed, small credit budget (~\$11). Uncached, 65 members on a 15-minute poll is ~6,240 model calls/day (~\$524 over the pilot). The identity-plus-SHA-range cache (`narrationCacheKey`, `shouldNarrate` in `lib/sense.ts`) collapses that to ~325 calls/day (~\$0.65/day, ~\$27 over the pilot). Cost engineering is therefore a *product requirement*, documented as such in code: "A cache miss on an unchanged range is a bug, not an inefficiency."

## 8. Roadmap, Now / Next / Later

**Now (live, in code)**
- Layer 1 Sense: commit/PR → plain-English status, auto-published, realtime.
- `checkNarrative` prompt-injection guard on the auto-publish path.
- Facts-only graceful degradation.
- Identity/SHA-range narration cache (the budget guard).
- Cross-app shared-context bus + agent-to-agent dispatch API routes (working; see ARCHITECTURE and the Pulse↔Rally interop note).

**Next**
- Layer 2 Bank: automate extraction of "how it was solved" from the solving session (`lib/extract.ts` exists; surfaced, not fully automated).
- Move from poll to webhook ingestion; per-repo backfill.
- Confidence surfacing on narratives; reviewer sampling.

**Later**
- Layer 3 Broker: detect who is stuck on an already-solved problem and auto-introduce (`lib/introductions.ts`).
- Cross-tool state federation beyond Rally (the interop pattern generalized).
- Team-level rollups and trend views.

## 9. Non-goals

- Not a manual ticketing system with an AI bolt-on. Remove the model and there is no product.
- Not a chat assistant in the corner. The AI *is* the board's writer, not a helper beside it.
- Not a code-review or CI tool. Pulse describes state; it does not gate merges.
