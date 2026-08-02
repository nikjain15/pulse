# Stakeholders, Pulse (D5)

## Read this first: what these reviews are and are not

**These reviews are simulated. Nik built Pulse alone and ran all three of them himself, role-playing
each reviewer against his own code.**

No designer, no security engineer, no privacy specialist, no lawyer, no data scientist, and no
external party has read this codebase, reviewed it, audited it, or approved anything in it. Nobody
signed off. Nothing here is a professional opinion, a legal opinion, an audit result, or a
certification. The role names below ("senior product designer", "security and privacy reviewer",
"data and research lead") are hats one person put on to argue against himself in writing. Treat every
finding as a self-critique, and treat the confidence level accordingly: a solo author is worst placed
to find the defects that come from his own blind spots, which is exactly the class of defect a real
reviewer is hired for.

What the exercise is worth is still real. It was run against the shipped code with file and line
citations, it found defects that were not previously written down, and it distinguishes things that
were fixed (none, this round) from things that stay open (all of them). It is a structured
self-critique. It is not assurance.

The stakeholder table below is likewise hypothetical. It maps the roles that **would** need to be
involved before Pulse could be used beyond this cohort. None of these people exist for this project
today.

---

## Stakeholder map (hypothetical)

| Who | Needs from me | Decision they own | What they would block on |
|---|---|---|---|
| Cohort program lead (the data owner) | A plain statement that Pulse publishes model-written sentences about named participants, not only public GitHub facts; the opt-out path; the incident plan if a narrative is wrong about someone | Whether Pulse may run against the cohort's repo and participants at all | Discovering the AI prose scope from a participant complaint rather than from me |
| Each cohort member (the data subject) | To know before it happens that a sentence about them can auto-publish, what it is built from, and how to leave | Their own consent, via `narrationOptIn` and `/opt-out` | Anything published about them that they did not opt into |
| Security engineer | The threat model, `firestore.rules`, the write-path split between browser and Admin SDK, the guard's actual coverage | Whether the trust-based provenance and the unauthenticated routes are acceptable for the deployment | Narrative writes staying client-side; the world-readable opt-out list |
| Privacy / data protection reviewer | A data inventory, a lawful-basis statement, a retention window, a deletion path, and the list of third parties that receive personal data (Anthropic, GitHub, Firebase, Vercel) | Whether the processing is lawful and proportionate | There being no written retention window and no deletion path for the feed (see S4) |
| Legal counsel | The auto-publish design, the fact that a model writes sentences about identifiable named people with no human in the loop, and the opt-out that does not verify identity | Terms of use, the lawful basis, and the defamation and IP exposure of auto-published prose about a person | An unverified opt-out that lets anyone remove anyone; auto-published prose about a named person with no review step |
| Accessibility specialist | The live app, `DESIGN-SPEC.md` §4, and an honest statement of what has and has not been tested | Whether the product meets WCAG 2.2 AA | Focus indicators below the 3:1 non-text contrast floor (D1); no keyboard or screen-reader testing having ever been run (D2) |
| Design lead | The flows, the four states per surface, and the destructive-action patterns | The interaction model, and whether a destructive unverified action ships without a confirm step | `/opt-out` being one field, one click, permanent, and unverifiable (D3) |
| Data / research lead | The eval datasets, the label provenance, and the sample sizes behind the published numbers | Whether a reported metric may appear in a README or a doc | The 100% headline resting on 26 invented rows written by the guard's own author (E1) |
| SRE / on-call owner | Runbook, degradation modes, alerting, and the shared quota story | Whether it can be operated | In-memory rate limiting being the only ceiling on an unauthenticated model-spending route (S5) |
| Finance / budget owner | The cost model and the live spend counter | The spend ceiling | No hard cap, only a modeled budget and a notify-not-cap alert |

**None of these roles has been filled. The column "what they would block on" is my prediction of
their objection, not their objection.**

## The single biggest misalignment risk

Everyone above would ask a different question, but they would collide on one thing: **what Pulse
actually publishes about a person, versus what people think it publishes.**

The disclosure that a cohort member is most likely to have read is "Pulse reads the public repo and
shows public facts." The product also writes model-authored English sentences about named individuals
and auto-publishes them to 64 people with no human in the loop, and it maintains a private "who is
stuck" signal about people. Consent for the second thing is real and is enforced (`narrationOptIn`,
`autoNarrationAllowed` in `lib/sense.ts`), but it is reached through a flow the person has to
complete, whereas the pre-index happens to them without being asked (README.md, Known limitations).

The risk is not that this is hidden. It is documented in several places. The risk is that it is
documented in the places a *reviewer* reads and not in the place a *participant* reads, so the gap
gets discovered by the person it is about rather than disclosed by me. Pulse's entire claim is that
it is the honest board. That claim does not survive one participant saying "I did not know it could
say things about me." The mitigation is not more engineering; it is a one-paragraph, participant-facing
notice at the top of the signed-out landing page, and telling the program lead in writing before the
next cohort, not after.

## Sign-offs (SH5)

Approvals that **would** be needed before Pulse could be used beyond this cohort:

| Approval | Owner it would need | Status |
|---|---|---|
| Permission to process cohort participants' activity and publish about them | Cohort program lead | **Not obtained.** Never formally requested. |
| Participant-level informed consent for AI prose about a named person | Each participant | **Partial and not signed off.** `narrationOptIn` is enforced in code for narration; the pre-index of public facts is not consented, only opt-out-able. |
| Security review of the client-side write path and the unauthenticated routes | Security engineer | **Not obtained.** No security engineer has read this code. |
| Privacy review: lawful basis, data inventory, retention window, deletion path, sub-processor list | Privacy / data protection reviewer | **Not obtained.** No retention window or deletion path exists to review. |
| Legal review: terms, defamation exposure of auto-published prose, unverified opt-out | Legal counsel | **Not obtained.** No lawyer has seen this. |
| WCAG 2.2 AA conformance statement | Accessibility specialist | **Not obtained.** No accessibility audit of any kind has been run. |
| Sign-off that a published eval number is defensible | Data / research lead | **Not obtained.** All numbers are self-reported over self-authored fixtures. |

**Obtained: none. Zero of the seven.** Everything above is unapproved.

The plan to get them, in the order the cost of not having them bites:

1. **Before anything leaves this cohort:** write the participant-facing notice described above and
   send it to the program lead in writing. This is the only item that is free and that I control
   entirely, and it closes the misalignment risk.
2. **Before a second cohort or any non-cohort user:** write a retention and deletion policy (S4). It
   is a doc, not a build, and no privacy reviewer can start without it.
3. **Before any deployment where a peer is not a friendly party:** move the narrative write
   server-side under the Admin credential (S1, S2). This is already the named next action in
   `docs/FDE_JOURNEY.md` §2 and it unblocks both the security and privacy conversations.
4. **Before publishing a conformance claim of any kind:** run an actual keyboard pass and an actual
   screen-reader pass, and fix the focus contrast (D1, D2). Until then, claim nothing about
   accessibility.
5. **Before any eval number appears anywhere new:** attach the sample size to the number wherever it
   is reported (E1). The numbers are honest; the denominators are missing.

Approvals 3 through 7 in the table require people I do not have. The honest position is that Pulse is
a cohort pilot and should be described as one, and that "would need sign-off" is not the same as
"is nearly ready for sign-off."

## Pushback (CS1)

Three simulated reviews were run against the code at commit `4753283`. Findings are ranked P0
(blocker), P1 (major), P2 (minor). **No code was changed by any of them.** Every finding below is
open, and each names the file that would close it. Where I disagree with my own reviewer, that is
recorded as a defense rather than quietly dropped.

The full record, with the reasoning, is in [DECISION_LOG.md](DECISION_LOG.md).

### a) Design critique (simulated senior product designer)

| # | Rank | Finding | Status |
|---|---|---|---|
| D1 | P1 | Focus indicator fails WCAG 2.2 SC 1.4.11. `components/ui.tsx:138` sets `focus:outline-none focus:ring-1 focus:ring-zinc-600`; zinc-600 on zinc-950 measures 2.57:1 against a 3:1 floor. The comment at `ui.tsx:134` claims this ring exists so no control falls back to something "a keyboard user can't see", and the ring itself is the thing they cannot see. `Button` (`ui.tsx:165`) has no focus style at all and relies on the UA default. | Open. Fix in `components/ui.tsx`. |
| D2 | P1 | Accessibility has never been tested for keyboard or screen reader. Zero occurrences of axe, a11y, WCAG, or contrast tooling in the repo; `tests/e2e/` contains no keyboard traversal test at all. What **is** genuinely asserted: 200% zoom reflow (`responsive.spec.ts:214`), 44px touch targets (`:238`), and reduced motion (`:276`). Accessible names are hand-authored and thoughtful (69 `aria-` usages, `Field` in `ui.tsx:104` deliberately avoids wrapping labels), but nothing verifies them. | Open. Honest verdict: partial evidence, good intent, no test coverage. |
| D3 | P1 | `/opt-out` is a permanent, unverified, irreversible destructive action with no confirmation step. `app/opt-out/page.tsx:118` submits on one click; `firestore.rules:344` denies update and delete, so reversal needs console access, which the page itself admits at `page.tsx:196`. The page's disclosure is genuinely excellent. The flow does not match it. | Open. Fix in `app/opt-out/page.tsx`. |
| D4 | P2 | `Home.tsx:1113` renders "Loading the feed…" as a plain `<p>` with no `aria-live` or `aria-busy`, so a screen-reader user is never told when the feed arrives. The pattern exists elsewhere (`OfflineBanner.tsx:48` uses `aria-live="polite"`), so this is inconsistency, not absence. | Open. Fix in `components/Home.tsx`. |
| D5 | P2 | `app/globals.css:3-21` still ships the Next.js starter's light/dark variable scaffolding while `DESIGN-SPEC.md:104` says dark is canonical. It does not currently mis-render, because the `text-zinc-100` class on `<body>` (`app/layout.tsx:33`) outranks the element-selector rule on specificity. It is dead code one specificity change away from painting `#171717` text on a zinc-950 page. | Open. Fix in `app/globals.css`. |
| D6 | P2 | Placeholder text fails AA. `placeholder:text-zinc-500` on `bg-zinc-950` (`ui.tsx:138`) measures 4.12:1 against the 4.5:1 floor. | Open. Fix in `components/ui.tsx`. |

**This review did not look at:** the live deployed app at pulsecohort.vercel.app in a real browser, on
a real screen reader, or at any real viewport. It read source only, so every rendering claim is
inferred from code rather than observed.

### b) Security and privacy review (simulated)

| # | Rank | Finding | Status |
|---|---|---|---|
| S1 | P1 | The guard's headline promise is enforced on the generation path, not the write path. `checkNarrative` runs only inside `lib/narrate.ts:164`, server-side. `firestore.rules:238-249` pins `actorUid` and `actorName` but places no constraint on the `narrative` string, and `:261` lets the actor rewrite `narrative` freely afterwards. So a signed-in member can publish any sentence naming any peer, straight from the browser. README.md's "a deterministic guard gates every published summary" is true of model-written summaries from `/api/narrate` and not of every published narrative. The capability gap is small (a member could always type the sentence) but the claim is materially wider than the control. | Open. Fix is the server-side narrative write already named in `docs/FDE_JOURNEY.md` §2; the claim itself is fixable today in `README.md`. |
| S2 | P2 | The guard's peer list is supplied by the caller. `app/api/narrate/route.ts:110` takes `otherMembers` from the request body, so `otherMembers: []` disables the `names_another_member` check for that call, on an unauthenticated route. Severity is held at P2 only because S1 means the same outcome is reachable without it. | Open. Fix in `app/api/narrate/route.ts`. |
| S3 | P1 | The opt-out tombstone list is world-readable. `firestore.rules:332` is `allow read: if true`, so the enumerable list of everyone who asked to be hidden is public, which is precisely the privacy-sensitive fact the feature exists to protect. Already disclosed in README.md and in the rules comment; restated here because disclosure is not mitigation. | Open. Needs `firebase-admin` so the pre-index can read privileged; `lib/opt-out.ts:97` moves behind it. |
| S4 | P1 | There is no written retention window and no deletion path. A member can delete individual events (`firestore.rules:265`), but nothing purges a person's history, `optOuts` is create-only and permanent (`firestore.rules:344`), and `usageCalls` rows accumulate forever (`lib/usage-admin.ts:56`). `docs/FDE_JOURNEY.md:23` headlines `forgetShared` as "Right to be forgotten", but that function covers only the shared-context bus, not the feed, the narratives, or the tombstones. The framing overreaches the mechanism. | Open. Needs a written policy plus a server-side purge; the doc claim is fixable today in `docs/FDE_JOURNEY.md`. |
| S5 | P2 | Rate limiting cannot bound spend. `lib/rate-limit.ts:10-13` states the real ceiling is limit times warm instances, which for 20/min (`app/api/narrate/route.ts:17`) is unbounded in the only direction that matters on an unauthenticated model-spending route. Separately, the key is the leftmost `x-forwarded-for` value (`route.ts:22-25`); on Vercel the platform sets that header so it is probably the true client IP, but nothing in this repo verifies it and `x-vercel-forwarded-for` would be unambiguous. Flagged as unverified rather than asserted as a bug. | Open. Fix in `lib/rate-limit.ts` (shared counter) and `app/api/narrate/route.ts`. |
| S6 | P2 | **Logs and traces: substantially a clean pass, with one gap.** Every `console` call was read. `app/api/opt-out/route.ts:39` logs the emulator flag and the error, not the handle, and the thrown error (`lib/opt-out.ts:93`) carries only an HTTP status. `lib/retry.ts:341-365` logs attempt, status and delay, never content. Telemetry records model, kind, token counts and cost only, with no prompt text and no identifiers (`lib/usage-admin.ts:56`, `lib/conduit/report-usage.ts`). The remaining client-side `console.error` calls land in the member's own browser. The gap is not leakage, it is disclosure: commit messages, PR titles, branch names and `displayName` leave the server to Anthropic (`lib/narrate.ts:186-202`), noted in `docs/FDE_JOURNEY.md:13` but in no participant-facing statement, and Vercel Analytics (`app/layout.tsx:46`) plus the in-memory IP map (`route.ts:19`) process IP addresses with no stated basis or retention. | Open. Fix is the participant-facing notice and the retention policy, not code. |

**This review did not look at:** dependency and supply-chain risk. No `npm audit`, no lockfile review,
no check of the vendored `conduit/` code's provenance, and no review of the GitHub Actions workflow's
permissions or secret handling.

### c) Eval review (simulated data and research lead)

| # | Rank | Finding | Status |
|---|---|---|---|
| E1 | P0 | The published numbers are too small to mean what they look like. `evals/guard-fixture.json` has 26 must-block rows; 26 out of 26 gives a 95% Wilson lower bound of **87.1%**, so the headline "100% recall" is statistically compatible with a true recall in the high eighties. `evals/dataset.json` has 7 must-block and 3 must-allow rows, a lower bound of 64.6% and 43.8%. `evals/groundedness-dataset.json` has 8 rows total, lower bound 67.6%. All three sets are invented fixtures written by the same person who wrote the code under test, in the same repo, with full knowledge of the implementation. That is disclosed, and disclosure does not make 26 rows into evidence. Worse: `tests/unit/eval-metrics.test.ts:108` asserts `rows.length <= 60`, so CI actively **fails** if anyone grows the fixture past 60. The eval that most needs more data has an upper bound on data enforced in CI. | Open. Fix in `evals/guard-fixture.json`, `tests/unit/eval-metrics.test.ts`, and the numbers in `docs/EVALS.md` and `README.md`. |
| E2 | P0 | The groundedness eval cannot fail for any reason except a code change. `evals/run-groundedness-eval.ts:92` exits non-zero only when the deterministic scorer disagrees with the labels, and the labels were written to match what `scoreGroundedness` (`lib/groundedness.ts:51-81`) is able to check, which is PR numbers and file-path tokens. The proof is in the repo's own docs: `evals/README.md:99` invites "fabricated commit counts" as good additions, but the scorer has no commit-count check, so such a case labeled ungrounded would fail the run on day one and would therefore never be added. The dataset is constrained to the scorer's shape. This is a regression detector for a regex, not a measure of narrative accuracy, and `docs/EVALS.md` presents it under "Narrative accuracy". | Open. Fix in `lib/groundedness.ts` and `evals/groundedness-dataset.json`. |
| E3 | P1 | The LLM judge can never fail a run and can silently score nothing. `judgeGroundedness` returns `null` on a missing key (`lib/groundedness.ts:142`) and on any error at all (`:172`); the runner skips nulls (`run-groundedness-eval.ts:78`) and prints the agreement block only when `judged > 0` (`:82`). A judge that returns `null` for all 8 rows produces no output and the run still prints PASS (`:96`). There is no floor on rows judged and no assertion on agreement. `docs/EVALS.md:39` calls it best-effort, which is accurate, but the summary table at `:82` lists it as Implemented, which reads stronger than "runs, is never checked". | Open. Fix in `evals/run-groundedness-eval.ts`. |
| E4 | P1 | The homoglyph blind spot is the most likely way the headline number is wrong in production. `foldForMention` (`lib/sense.ts:503-509`) folds combining marks and zero-width characters but not cross-script confusables, and the fixture does not exercise it. It is disclosed twice (`lib/sense.ts:501`, `docs/EVALS.md:62`) and it is still the cheapest evasion available: one character in a commit message. Until a confusables fold lands and rows are added, the fixture measures the guard against the evasions its own author already thought of, which is the definition of a contaminated test set. | Open. Fix in `lib/sense.ts`, then `evals/guard-fixture.json`. |
| E5 | P2 | Three of the four reported metrics are close to meaningless here, and reporting them at 100% each borrows credibility the safety number has not earned. The 23 negative rows are clean self-narratives, and the production cost of a false positive is facts-only (`lib/narrate.ts:173`), a designed and harmless fallback. So precision, F1 and accuracy measure a failure mode whose product cost is near zero, and the CI floor of 0.95 on precision (`docs/EVALS.md:60`) gates against a regression nobody would notice. Recall is the number that matters, and it is one number, not four. | Open. Fix in `docs/EVALS.md` and `README.md`. |

**This review did not look at:** the rules, integration, and e2e suites (`tests/rules/`,
`tests/integration/`, `tests/e2e/`). It read only the three eval harnesses and their datasets, so
nothing here speaks to whether the 934 test cases the README counts are well-constructed.

### Where I defend the current design

Three of the reviewers' findings are noted and deliberately not acted on, and I would argue with them
rather than fix them.

- **S3, the readable tombstone list.** The reviewer wants this closed before launch. I would not
  block the pilot on it. A working exit with a visible list beats no exit, the alternative needs a
  credential that does not exist, and the failure mode is embarrassment rather than harm. It stays
  open, in writing, at P1.
- **D3, no confirmation step on opt-out.** The reviewer wants a confirm dialog. Every extra step on
  the exit is a step where somebody gives up and stays indexed against their wishes, and the whole
  design premise is that leaving must be cheaper than staying. I would add an undo affordance rather
  than a confirm gate, and I would rather fix the missing reversal path (`firestore.rules:344`) than
  add friction to the departure.
- **E5, dropping precision and F1.** Partially defended. The reviewer is right that recall is the
  safety number. I keep precision reported, because a guard that starts rejecting every legitimate
  narrative would silently turn the whole product facts-only and precision is the only thing that
  would catch it. What I concede is the framing: four numbers at 100% in a table reads as a stronger
  result than one number at 100% with a stated denominator, and the denominator is what is missing.
