# Pulse, Forward-Deployed Engineering Journey

How Pulse deploys into a team's live environment: integration points, security, rollout, observability, and how each risk is de-risked. Written from the FDE lens: dropping an auto-writing agent into a place where it can embarrass people if it misbehaves.

## The deployment shape

Pulse is a Next.js app on Vercel reading a team's GitHub activity and writing to Firestore. A deployment is: point it at the repos, give it a GitHub read scope and an Anthropic key, and it starts sensing. The pilot deployment is the 65-person cohort at pulsecohort.vercel.app.

## 1. Integration points

- **Source of truth: GitHub.** Pulse ingests commits, PR titles, and branch names. In the pilot this is a poll on a ~15-minute cadence; the webhook path is roadmap. Integration is read-only against the customer's repos, which keeps the blast radius small.
- **State: Firestore.** Realtime reads to the client. Most board writes happen in the browser as the signed-in member, under `firestore.rules`; the privileged paths (broker introductions, usage counters, the cross-app bus) write server-side via `firebase-admin`. See §2 for the exact split. A customer brings their own Firebase project; `.env.example` documents every variable.
- **AI: Anthropic.** One server-side key. No customer data leaves the server boundary except the commit/PR evidence sent to the model, wrapped in an explicit delimiter.
- **Cross-tool: the shared-context bus.** If the customer also runs a sibling app (Rally, or any app implementing `lib/shared-context-contract.ts`), Pulse's agent can dispatch tasks to and read shared memory from it. This is the FDE-relevant part: it is a concrete pattern for **making two independently-deployed agents cooperate on shared state**, which is the exact problem enterprises hit as every tool ships its own agent.

## 2. Security & secrets

- **Secrets via environment only.** `ANTHROPIC_MODEL` + API key, Firebase Admin credentials, GitHub scope, all env vars, none in the client bundle. The AI SDK is imported only in server routes.
- **What the Admin SDK actually writes.** The service-account credential is initialised in `lib/broker-admin.ts` and is used by exactly three write paths: broker introductions and `intro_made` events (`lib/broker-admin.ts`, deliberately impossible to create from a client), the cost/usage counters (`lib/usage-admin.ts`), and the cross-app bus, meaning shared-memory notes, activity, and agent tasks written by `lib/shared-context.ts` behind the authenticated `/api/context/*` routes. `lib/auth-server.ts` verifies the caller's identity for those routes; `lib/conduit/mcp-tools.ts` is read-only; `/api/opt-out` uses Firestore REST with no elevated credential, on purpose, because leaving must not cost you an account. For all of these, a client cannot forge the write.
- **Narrative provenance is trust-based today, not cryptographic.** Narratives are the exception and the README says so too. `/api/narrate` only generates the sentence; the write happens in the browser as the signed-in member (`narrateShip` in `lib/sync.ts` calls `fetch('/api/narrate')` client-side, and evidence is set client-side with it). `firestore.rules` still requires a signed-in user and pins authorship through immutable `creatorUid`/`ownerUid`, and the facts a narrative cites (PR numbers) stay public and checkable, but a determined peer could forge a plausible-looking receipt. **Next action:** move the narrative write server-side behind the same Admin credential the bus already uses, which is what turns provenance from trust-based into enforced.
- **The rules are the enforced boundary and are tested as one.** `firestore.rules` is covered by an allow/deny matrix plus a generated attack set (`tests/rules/firestore.test.ts`, `tests/rules/gen-attacks.test.ts`).
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
- **Cost visibility.** The cache design is documented with a concrete call/cost model (`TESTING.md`), and the live spend counter now ships: every real model call is priced in `lib/usage.ts`, summed into a persisted total by `lib/usage-admin.ts`, and read back at `GET /api/usage` and on `/settings` as calls, tokens, cache-hit rate, and USD. Blaze budget alerts are recommended in `TESTING.md` (notify, not cap). Next action: per-team budgets on top of the counter.
- **Test gate.** `npm run gate` (typecheck + lint + unit + rules + integration + e2e smoke) is the pre-deploy signal. The cross-app drift check is a separate, explicit gate.
- **Documented operational war stories.** `TESTING.md` records real incidents (e.g. the Firestore-SDK-dead-but-REST-alive sign-up hang) and how they were caught, the kind of institutional knowledge an FDE hands to the customer's on-call.

## 5. De-risking summary

| Risk | Mitigation | Where |
|---|---|---|
| Agent publishes something harmful about a teammate | Deterministic `checkNarrative` guard; facts-only fallback | `lib/sense.ts`, `lib/narrate.ts` |
| Prompt injection via commit/branch text | Delimited prompt + guard + Unicode folding | `buildPrompt`, `foldForMention` |
| Runaway model spend | SHA-range identity cache; rate limiter; modeled budget | `lib/sense.ts`, `lib/rate-limit.ts`, `TESTING.md` |
| Model / network outage | Facts-only degradation, silent, no feed errors | `narrate()` |
| Client forging privileged data | Admin-SDK-only writes for introductions, usage counters and the bus; tested `firestore.rules` everywhere else | `lib/broker-admin.ts`, `lib/usage-admin.ts`, `firestore.rules`, `tests/rules/*` |
| Peer forging a narrative receipt | Not closed today: narratives are written client-side, so provenance is trust-based. Cited facts stay publicly checkable; next action is a server-side narrative write | `lib/sync.ts`, `app/api/narrate/route.ts` |
| Two agents drifting out of contract | Behavioral golden drift check across both apps | `scripts/audit/contract-drift.mjs` |
| Privacy / erasure request | Complete cross-directional forget | `forgetShared` |

## 6. What a customer engagement would add next

- Webhook ingestion + per-repo backfill (replace the poll).
- Server-side narrative writes under the Admin credential, so provenance stops being trust-based.
- Per-team budget alerts on top of the shipped cost/usage counter.
- Multi-tenant isolation (the pilot assumes one cohort).
- LLM-judge sampling of narrative groundedness in production (see EVALS).
- Generalizing the shared-context bus beyond Rally to arbitrary customer tools implementing the contract.
