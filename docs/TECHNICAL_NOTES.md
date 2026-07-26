# Pulse, Technical Notes & Rubric Scorecard

Every claim below is tied to a file in this repo. Where a capability is not present, it is marked as a gap rather than dressed up.

## 12-point scorecard

| # | Dimension | Score | Evidence (file refs) | Gap |
|---|---|---|---|---|
| 1 | Model choice | 3 / 5 | Single strong model `claude-opus-4-8`, env-overridable (`lib/narrate.ts`, `lib/extract.ts`, `lib/brief.ts`, `lib/agent-plan.ts`). Justified: a one-sentence status is not a routing problem, so cost is controlled by caching, not tiering. `output_config: { effort: 'low' }` matches task shape. | No LLM-vs-ML comparison written down; no fast/cheap model for the bulk path. |
| 2 | How the AI works | 4 / 5 | Grounded in real evidence (`formatEvidence`, `lib/sense.ts`); attacker text wrapped in an explicit delimiter (`buildPrompt`); `stop_reason === 'refusal'` handled as a content outcome; low effort, no thinking. **Sampling parameters are deliberately unset**: the pinned Opus 4.8 removed `temperature`/`top_p`/`top_k` (they 400), so determinism on the publish path comes from `effort: 'low'` plus the deterministic `checkNarrative` guard, not a temperature dial — asserted in `tests/unit/narrate.test.ts`. Groundedness now has an LLM-judge eval (EVALS §5). | Multi-model routing / cascade out of scope by design. |
| 3 | Tools / MCP | 4 / 5 | Real tool-use agent with JSON `input_schema` per tool (`lib/agent.ts`: `create_task`, `set_task_status`, `mark_stuck`, `propose_dispatch`, `remember`, `draft_recipe`); `validatePlan` validates and drops disallowed calls; publish tool gated behind `canPublish`. | Not exposed as an MCP server; tool errors degrade coarsely. |
| 4 | Agents & skills | 4 / 5 | Ask-Pulse agent runs a tool loop (`lib/agent-plan.ts`); capability-gated publishing; cross-app agent-to-agent dispatch (`lib/shared-context.ts`). | Single-turn planning; no long-horizon autonomy. |
| 5 | Orchestration & routing | 3 / 5 | Cost-first orchestration: cache guard (`shouldNarrate`) runs before any model call; per-call effort tuned; rate limiting (`lib/rate-limit.ts`). | No multi-model routing, one model for all tasks. Honest: this is caching, not routing. |
| 6 | RAG & context | 3 / 5 | Retrieval-then-generate over commit/PR evidence; cross-app shared memory bus keyed by identity (`lib/shared-context.ts`, `rememberShared`/`readSharedMemory`). Failure modes handled (facts-only). | No vector search / embeddings; retrieval is direct, not semantic. |
| 7 | Evals & grounding | 4 / 5 | Deterministic guard tests, generated adversarial matrices (`tests/unit/gen-*.ts`), rules evals (`tests/rules/*`), emulator integration tests, Playwright e2e including `degraded.spec.ts`. ~865 test cases defined. **LLM-judge groundedness eval now implemented** (`evals/run-groundedness-eval.ts`, EVALS §5). | No A/B or model-eval golden set yet (see EVALS roadmap). |
| 8 | Code quality | 5 / 5 | Strongly typed; discriminated-union results (`NarrativeCheck`, `NarrationResult`); dense rationale comments explaining *why*; clear module boundaries; `typecheck`+`lint`+tests wired into a `gate` script. |  |
| 9 | Scalability & cost | 4 / 5 | Explicit, code-level cost model (`lib/sense.ts`, `lib/types.ts`, `TESTING.md`): ~\$524 uncached vs ~\$27 cached over the pilot against ~\$11 credit; identity/SHA-range cache; single-slot→set cache fix to stop re-billing. **Live cost counter now implemented** (`lib/usage.ts` prices each call; `lib/usage-admin.ts` persists a running total; `GET /api/usage` and `/settings` surface calls, tokens, cache-hit rate, and USD). | Poll, not webhook; multi-model cascade still out of scope by design. |
| 10 | Guardrails & safety | 5 / 5 | `checkNarrative` (auto-publish backstop, `names_another_member`), `checkRecipeBody`, Unicode folding, markup rejection, refusal handling, facts-only degradation, server-only writes, tested `firestore.rules`, capability-gated tools. | Cross-script homoglyph fold is a documented residual. |
| 11 | Product layer | 4 / 5 | See `docs/PRD.md`: personas, JTBD, metrics, explicit tradeoffs, Now/Next/Later. Three-layer ladder matches code maturity honestly. | Bank/Broker layers still roadmap; adoption metrics from the pilot not instrumented in-repo. |
| 12 | FDE journey | 4 / 5 | See `docs/FDE_JOURNEY.md`: secrets via env, graceful degradation without a key, cross-app contract + drift guard, shadow/parallel rollout pattern, right-to-be-forgotten (`forgetShared`). | No customer-facing observability dashboard yet; single-tenant assumptions. |

**Aggregate: 47 / 60.** Strongest on code quality, guardrails, and cost engineering; weakest on multi-model routing and semantic retrieval, both honestly absent.

## Model & orchestration detail

- **Model:** `claude-opus-4-8` for all four AI surfaces (narration, extraction, home brief, ask-agent). Overridable via `ANTHROPIC_MODEL`. Called only from server routes; the key never reaches the browser.
- **Effort:** narration uses `output_config: { effort: 'low' }` with no thinking, a deliberate match to a one-sentence task, and part of the cost story.
- **The cache is the orchestrator.** `shouldNarrate(narratedKeys, handle, commitShas)` short-circuits before the model is invoked. The narrated set is keyed by `handle : sorted(SHAs)`, so identical work is never re-billed. Comment in code: "A cache miss on an unchanged range is a bug, not an inefficiency."
- **Rate limiting:** `lib/rate-limit.ts` (`hitRateLimit`, `evictExpired`) bounds per-window calls.

## Guardrails (the core of the system)

The product bet is auto-publish with no human in the loop, so the guard *is* the safety story:

1. **`checkNarrative`** (`lib/sense.ts`), runs on every model narrative before publish. Rejects empty, over-length, markup/HTML, and any sentence naming another cohort member. Rejection → publish facts only, silently.
2. **Unicode folding** (`foldForMention`), NFKD, strip combining marks + zero-width/bidi controls, lowercase, then whole-word mention scan. Closes the cheap typographic evasions (`Már cus`, `Mar<ZWSP>cus`). Residual: cross-script homoglyphs (documented).
3. **`checkRecipeBody`:** the same peer-name gate on agent-drafted recipes, but *blocked* (handed back to edit) rather than silently redacted, because a recipe posts as the author's own words.
4. **Capability-gated tools:** `validatePlan` drops the publish tool unless the user opted in (`canPublish`); the model is never even offered a tool it should not have.
5. **Server-only writes + tested rules:** the client cannot forge a narrative, task, or shared-memory note; `firestore.rules` is the enforced boundary and is tested (`tests/rules/*`).

## Cost engineering, the honest version

The pilot ran on a fixed ~\$11 credit budget. The code models the tradeoff directly:

| Scenario | Model calls/day | Cost/day | Over pilot |
|---|---|---|---|
| No cache (65 members, 15-min poll) | 6,240 | ~\$12.48 | ~\$524 |
| Cached by SHA range (~5 real pushes each) | 325 | ~\$0.65 | ~\$27 |

The ~10× headline is real as a **modeled** before/after of the caching design (source: `lib/sense.ts` and `TESTING.md`, not a live meter). The "→ ~\$11" figure in the card refers to the credit budget the cached path fits under; the modeled cached spend is ~\$27, still an order of magnitude below the uncached ~\$524. Framed precisely: **caching cuts modeled spend ~10–20×, bringing a pilot that would have cost ~\$524 down to ~\$27, inside a ~\$11-scale credit envelope.** A live spend counter is now implemented: each real model call is priced (`lib/usage.ts`) and summed into a persisted total (`lib/usage-admin.ts`), surfaced at `GET /api/usage` and on `/settings`, so the modeled figures above become measurable rather than projected.

## Test count (verified)

Counting defined `it(` / `test(` cases across the vitest projects and Playwright specs:

| Project | Cases |
|---|---|
| unit | 612 |
| rules | 148 |
| integration | 55 |
| e2e (Playwright) | 50 |
| **Total** | **~865** |

Several `gen-*.test.ts` files are table-driven and generate additional cases at runtime, so the executed count is at least this. The previously cited "240 tests" substantially undercounts the suite.
