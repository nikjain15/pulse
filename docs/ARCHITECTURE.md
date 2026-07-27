# Pulse, Architecture

Grounded in the actual code paths under `lib/`, `app/api/`, and `firestore.rules`. File references are to this repo.

## Stack

- **Next.js 16 / React 19 / TypeScript:** app router, server routes under `app/api/*`.
- **Firestore (realtime):** client SDK in the browser for live reads; `firebase-admin` server-side for privileged writes. Security enforced by `firestore.rules` (~21 KB of rules, tested).
- **Server-side AI:** `@anthropic-ai/sdk`, called only from server routes. The API key never reaches the client. The auto-publish narration, extraction and brief paths call a single model (`claude-opus-4-8`, env `ANTHROPIC_MODEL`). The generative Ask-Pulse answer path routes through an embedded `@conduit/client` and picks a model per turn (see below).
- **Vercel:** hosting and cron/poll trigger. Live at pulsecohort.vercel.app.
- **MCP:** a separate, read-only Model Context Protocol server exposes the cohort's public activity to MCP clients. See [MCP.md](MCP.md).

## Component overview

```mermaid
graph TD
  subgraph Sources["Attacker-influenced sources"]
    GH["GitHub commits / PRs / branch names"]
  end

  subgraph Server["Next.js server routes (app/api)"]
    POLL["Sense poll"]
    NAR["lib/narrate.ts\nnarrate()"]
    EXT["lib/extract.ts\nBank extraction"]
    BRIEF["lib/brief.ts\nHome brief"]
    PLAN["lib/agent-plan.ts\nAsk-Pulse ACTION path\n(validatePlan)"]
    ASK["lib/ask-agent.ts\nAsk-Pulse ANSWER path\n@conduit/agent loop"]
    ROUTE["lib/conduit/routing.ts\nper-turn tier"]
    CONDUIT["lib/conduit/client.ts\nembedded @conduit/client"]
    GUARD["lib/sense.ts\ncheckNarrative / checkRecipeBody\nshouldNarrate (cache)"]
    SDK["@anthropic-ai/sdk\nHaiku 4.5 default / Opus 4.8 escalation"]
  end

  subgraph Bus["Shared-context bus (cross-app)"]
    DISPATCH["app/api/context/dispatch"]
    INBOX["app/api/context/inbox"]
    SC["lib/shared-context.ts"]
  end

  subgraph Data["Firestore"]
    FS[("board / narratives\nagentTasks / sharedMemory")]
    RULES["firestore.rules"]
  end

  CLIENT["React client (realtime)"]

  GH --> POLL --> GUARD
  GUARD -->|shouldNarrate miss| NAR --> SDK
  SDK --> GUARD
  GUARD -->|ok| FS
  GUARD -->|reject / no key / refusal| FS
  BRIEF --> SDK
  PLAN --> SDK
  ASK --> ROUTE --> CONDUIT --> SDK
  ASK -->|guarded answer| GUARD
  EXT --> SDK
  NAR --> FS
  FS <--> RULES <--> CLIENT
  DISPATCH --> SC --> FS
  INBOX --> SC
  Rally["Rally (sibling app)"] <-->|same contract| SC
```

Key point: **every model output crosses the `checkNarrative` / `checkRecipeBody` guard before it can be published**, and the cache guard (`shouldNarrate`) runs *before* the model is ever called, so the common path costs nothing.

## Sense → narrate → publish (the auto-publish path)

This is the critical sequence: attacker-controlled text (commit messages, PR titles, branch names) is read, fed to a model, and auto-published to 64 people with no human in the loop. The guard is the backstop.

```mermaid
sequenceDiagram
  autonumber
  participant Poll as Sense poll (server)
  participant Cache as shouldNarrate (lib/sense.ts)
  participant Model as claude-opus-4-8
  participant Guard as checkNarrative (lib/sense.ts)
  participant FS as Firestore
  participant Team as Cohort (64 readers)

  Poll->>Cache: handle + commit SHAs
  alt SHA range already narrated
    Cache-->>Poll: skip (skipped_cached) - no model call
  else new work
    Cache-->>Poll: proceed
    Poll->>Model: system + delimited evidence (effort: low)
    alt no API key / refusal / network error
      Model-->>Poll: unavailable
      Poll->>FS: publish FACTS ONLY (commit counts, PR titles)
    else text returned
      Model-->>Guard: narrative sentence
      Guard->>Guard: empty? too long? markup? names another member?
      alt guard rejects
        Guard-->>FS: publish FACTS ONLY, silently
      else guard ok
        Guard-->>FS: publish narrative + cache key
      end
    end
  end
  FS-->>Team: realtime update
```

The `names_another_member` rule is the load-bearing one: injection's payoff is publishing a sentence about *someone else*. An actor's commits may only ever produce a sentence about that actor. The guard folds Unicode (NFKD, strips combining marks and zero-width/bidi controls) before a whole-word mention scan, closing the cheapest evasions. Documented residual: cross-script homoglyphs are not folded (`foldForMention` comment, `lib/sense.ts`).

## Cross-app agent-to-agent dispatch (Pulse ↔ Rally)

A real, working mechanism, not a mock:

- **Shared contract:** `lib/shared-context-contract.ts` defines the paths (`sharedMemory/{handle}`, `sharedActivity/{handle}`, `agentTasks`), handle normalization, and the legal task lifecycle (`pending → claimed → done|failed`, `canTransition`).
- **Adapter:** `lib/shared-context.ts` implements `dispatchTask`, `claimTasks`, `completeTask`, `rememberShared`, `logSharedActivity`. Claiming and completion run inside `db.runTransaction` so a task can be claimed once and only follows legal transitions. `APP = 'pulse'` is the only per-app difference from Rally's identical adapter.
- **Live routes:** `app/api/context/dispatch/route.ts` (one app's agent asks another's), `app/api/context/inbox/route.ts` (claim + complete), `app/api/ask-pulse/route.ts` (reads/writes shared memory).
- **Drift guard:** `scripts/audit/contract-drift.mjs` runs *both* apps' behavioral golden tests (`tests/unit/contract-golden.test.ts`) and fails if either contract drifts. Behavioral, not textual, so formatting differences do not false-positive.
- **Cross-app tests:** `tests/integration/shared-context.test.ts` and `tests/integration/cross-app-regression.test.ts` exercise the lifecycle against a real Firestore emulator.

Maturity: **working mechanism, test-proven, wired to live API routes.** Full cross-app operation requires the sibling Rally checkout (`../nikjain15-project-2`); the drift script skips-with-warning if it is absent. Framed honestly on the site as "a working demonstration."

## Ask-Pulse: two paths, one guard

Ask-Pulse has two distinct paths, and only one of them is a generative agent:

- **The ACTION path** (create, move, edit a card) still runs through `lib/agent-plan.ts` + `validatePlan` unchanged. Anything with authority is deterministically re-resolved before it can touch the board; that re-resolution is Pulse's injection backstop for side-effecting tools.
- **The generative ANSWER path** (the prose Pulse shows when you ask a question or say hello) is a bounded reason-act loop on the vendored `@conduit/agent` (`lib/ask-agent.ts`, see `conduit/VENDOR.md`). It exposes typed, **read-only** tools over the user's own board (`list_tasks`, `list_projects`, `find_task`, `search_board`, `board_stats`), loads skills at runtime by intent rather than through hard-coded branches, and never sets `allowSideEffects`, so a side-effecting tool would be refused by default. The model call is routed through an embedded `@conduit/client` (`lib/conduit/client.ts`), so every generation flows through Conduit's unified interface and returns a metered record.

Both paths converge on the same backstop: every answer the loop produces passes through the unchanged deterministic `checkNarrative` before it can be shown or dispatched. The agent's output is untrusted model text until it passes exactly the check that gates published narration.

### Per-turn model routing

`lib/conduit/routing.ts` chooses a model per model turn instead of pinning one. The bulk of asks run on a cheap tier (Haiku 4.5, `claude-haiku-4-5`); an ask escalates to the reasoning tier (Opus 4.8, `ANTHROPIC_MODEL`) when it is long or multi-question, when the bounded loop goes multi-step, or when a cheap first pass comes back low-confidence (a hedged or empty answer triggers one reasoning-tier retry). The decision is a pure function of signals available at each turn, so it is deterministic and unit-tested, and it feeds `client.infer({ pinModel })`, so every call stays metered exactly as before. Routing only chooses which model id is targeted; with no API key the path is never reached, and every produced answer still passes `checkNarrative`.

### Live-usage reporting (env-gated)

Each metered call from the answer path can be reported to a central Conduit gateway (`lib/conduit/report-usage.ts`, `POST /v1/decisions`), tagged with the guard outcome. It is env-gated: it is a no-op unless both `CONDUIT_GATEWAY_URL` and `CONDUIT_GATEWAY_TOKEN` are set, and it is fire-and-forget, so it can never delay or change the answer. The default deployment behaves exactly as before.

### Semantic retrieval (present, tested, dormant in production)

`lib/semantic-retrieval.ts` (a cosine vector rerank over the vendored `@conduit/rag`) and the `search_board` tool exist and are unit-tested, but they are **dormant in production**. The embedder is injected, and no embedding provider is wired at the ask-pulse route (`app/api/ask-pulse/route.ts` calls `runAskAgent` without an `embed`). With none configured, `semanticRerank` returns `{ kind: 'disabled' }` and `search_board` degrades to the same case-insensitive substring match the exact-match path uses. So live retrieval is substring matching today; the semantic rerank activates only once a real embedder is injected. It is a strict enhancement, not a live capability, and is not claimed as one.

## Data model & security

- Writes that matter (narratives, agent tasks, shared memory) are **server-only** via `firebase-admin`; the client SDK is realtime-read plus tightly-scoped writes.
- `firestore.rules` is the real access-control surface and is tested two ways: `tests/rules/firestore.test.ts` (allow/deny) and `tests/rules/gen-attacks.test.ts` (generated attack matrix).
- The reader's own brief is cached under the reader's uid so rules permit only them to write it (`lib/use-brief.ts`).

## Failure modes designed for

| Failure | Behavior | Where |
|---|---|---|
| No API key | Publish facts only | `narrate()` `no_api_key` |
| Model refusal (safety) | Publish facts only | checks `stop_reason === 'refusal'` |
| Rate limit / network | Publish facts only | try/catch → `model_unavailable` |
| Prompt injection naming a peer | Reject, publish facts only, silently | `checkNarrative` `names_another_member` |
| Model emits markup/HTML | Reject (belt-and-braces with React escaping) | `checkNarrative` `contains_markup` |
| Firestore SDK dead but REST alive | Documented sign-up hang, covered in TESTING.md | `TESTING.md` |
| Unchanged work re-polled | No model call (cache hit) | `shouldNarrate` |
