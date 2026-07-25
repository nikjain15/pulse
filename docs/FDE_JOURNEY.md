# Pulse — Forward-Deployed Engineering Journey

How Pulse deploys into a team's live environment: integration points, security, rollout, observability, and how each risk is de-risked. Written from the FDE lens: dropping an auto-writing agent into a place where it can embarrass people if it misbehaves.

## The deployment shape

Pulse is a Next.js app on Vercel reading a team's GitHub activity and writing to Firestore. A deployment is: point it at the repos, give it a GitHub read scope and an Anthropic key, and it starts sensing. The pilot deployment is the 65-person cohort at pulsecohort.vercel.app.

## 1. Integration points

- **Source of truth: GitHub.** Pulse ingests commits, PR titles, and branch names. In the pilot this is a poll on a ~15-minute cadence; the webhook path is roadmap. Integration is read-only against the customer's repos, which keeps the blast radius small.
- **State: Firestore.** Realtime reads to the client, privileged writes server-side via `firebase-admin`. A customer brings their own Firebase project; `.env.example` documents every variable.
- **AI: Anthropic.** One server-side key. No customer data leaves the server boundary except the commit/PR evidence sent to the model, wrapped in an explicit delimiter.
- **Cross-tool: the shared-context bus.** If the customer also runs a sibling app (Rally, or any app implementing `lib/shared-context-contract.ts`), Pulse's agent can dispatch tasks to and read shared memory from it. This is the FDE-relevant part: it is a concrete pattern for **making two independently-deployed agents cooperate on shared state**, which is the exact problem enterprises hit as every tool ships its own agent.

## 2. Security & secrets

- **Secrets via environment only.** `ANTHROPIC_MODEL` + API key, Firebase Admin credentials, GitHub scope — all env vars, none in the client bundle. The AI SDK is imported only in server routes.
- **Server-only writes.** Narratives, agent tasks, and shared-memory notes are written with the Admin SDK. The client cannot forge them; `firestore.rules` is the enforced authorization boundary and is tested by an allow/deny matrix plus a generated attack set (`tests/rules/firestore.test.ts`, `tests/rules/gen-attacks.test.ts`).
- **Prompt-injection containment.** Because Pulse reads attacker-controllable text and auto-publishes, the `checkNarrative` guard (`lib/sense.ts`) is a security control, not a nicety: an actor's commits can only ever produce a sentence about that actor. See TECHNICAL_NOTES §Guardrails.
- **Right to be forgotten.** `forgetShared` (`lib/shared-context.ts`) erases a person's memory notes, activity, and agent tasks in both directions, so erasure is complete, not partial. This matters for any enterprise data-handling review.

## 3. Rollout & cutover

The rollout pattern mirrors how you would safely introduce any auto-writer into a live team:

1. **Facts-only first.** Deploy with no API key, or with the guard tuned strict: Pulse still publishes verifiable facts (commit counts, PR titles). The board is useful and *cannot* say anything embarrassing. This is the safe default and a natural pilot phase.
2. **Shadow the narratives.** Enable narration for a subset or with a reviewer sampling the output, comparing model sentences against the underlying evidence before trusting auto-publish.
3. **Cut over to auto-publish.** Once the guard's behavior is trusted on the team's real commit style, remove the reviewer. The guard remains the backstop; every failure mode (no key, refusal, rate limit, suspect sentence) degrades to facts-only rather than to a lie or an error in the feed.
4. **Cross-app last.** Bring the shared-context bus online only after single-app is stable. `scripts/audit/contract-drift.mjs` gates it: if Pulse and Rally disagree on the contract, the check fails and sharing is treated as broken until fixed. This is the cutover guardrail for the interop layer.

## 4. Observability

- **Structured degradation reasons.** `narrate()` returns a discriminated union (`skipped_cached`, `facts_only` with a reason, `narrated`), so every non-happy path is a named, countable outcome rather than a swallowed error.
- **Cost visibility.** The cache design is documented with a concrete call/cost model (`TESTING.md`); a live spend counter is roadmap. Blaze budget alerts are recommended in `TESTING.md` (notify, not cap).
- **Test gate.** `npm run gate` (typecheck + lint + unit + rules + integration + e2e smoke) is the pre-deploy signal. The cross-app drift check is a separate, explicit gate.
- **Documented operational war stories.** `TESTING.md` records real incidents (e.g. the Firestore-SDK-dead-but-REST-alive sign-up hang) and how they were caught — the kind of institutional knowledge an FDE hands to the customer's on-call.

## 5. De-risking summary

| Risk | Mitigation | Where |
|---|---|---|
| Agent publishes something harmful about a teammate | Deterministic `checkNarrative` guard; facts-only fallback | `lib/sense.ts`, `lib/narrate.ts` |
| Prompt injection via commit/branch text | Delimited prompt + guard + Unicode folding | `buildPrompt`, `foldForMention` |
| Runaway model spend | SHA-range identity cache; rate limiter; modeled budget | `lib/sense.ts`, `lib/rate-limit.ts`, `TESTING.md` |
| Model / network outage | Facts-only degradation, silent, no feed errors | `narrate()` |
| Client forging privileged data | Server-only writes + tested `firestore.rules` | `firestore.rules`, `tests/rules/*` |
| Two agents drifting out of contract | Behavioral golden drift check across both apps | `scripts/audit/contract-drift.mjs` |
| Privacy / erasure request | Complete cross-directional forget | `forgetShared` |

## 6. What a customer engagement would add next

- Webhook ingestion + per-repo backfill (replace the poll).
- A live cost/usage dashboard and per-team budget alerts.
- Multi-tenant isolation (the pilot assumes one cohort).
- LLM-judge sampling of narrative groundedness in production (see EVALS).
- Generalizing the shared-context bus beyond Rally to arbitrary customer tools implementing the contract.
