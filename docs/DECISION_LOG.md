# Decision log, Pulse

## Honesty note

The reviews recorded in the Pushback section below were **simulated**. Nik builds Pulse solo and ran
all three reviews himself, role-playing each reviewer against his own code. No designer, security
engineer, privacy specialist, lawyer, or data scientist has reviewed this repo. Nobody approved
anything. See [STAKEHOLDERS.md](STAKEHOLDERS.md) for the full statement.

## Assumptions (D4)

| Unknown | Assumption made | Cheap check |
|---|---|---|
| Whether cohort participants understand that AI prose can be published about them | They mostly do not, and have read only "Pulse shows public GitHub facts" | Ask three participants what they think Pulse can say about them |
| Whether the guard's 100% fixture score reflects production behaviour | It does not generalise; 26 self-authored rows is not evidence of a production rate | Feed a week of real cohort commit messages through `checkNarrative` and count |
| Whether anyone has ever used Pulse with a keyboard alone | Nobody has, including Nik | Unplug the mouse and try to create a task |
| Whether Vercel overwrites `x-forwarded-for` so the rate-limit key is trustworthy | Assumed yes, unverified in this repo | Log the header shape from one deployed request |
| Whether the cohort program lead would consider the current scope acceptable | Assumed yes, never asked | Send one paragraph describing what Pulse publishes and wait for a reply |

## Scope cuts (B3)

Cut from these reviews to keep the deliverable a review rather than a rewrite: no code was changed.
Every finding stays open with the file that would close it named. The reviews deliberately did not
attempt fixes, because a fix invented in the same session as the critique is unreviewed twice over.

## Skipped artifacts / questions

| What | Why | Pillar affected |
|---|---|---|
| Dependency and supply-chain review | Partly closed on 2026-08-02, see Supply chain below. Still out of scope: the vendored `conduit/` provenance and the CI workflow's secret and permission handling | Security |
| Testing against the live deployed app | The design review read source only; nothing was observed in a real browser, on a real screen reader, or at a real viewport | Design, accessibility |
| The rules, integration, and e2e suites | The eval review read only the three eval harnesses; nothing here speaks to the quality of the other 934 test cases | Evals |
| A real accessibility audit | Requires a specialist and a screen reader; the review can only report that none has been run | Design, accessibility |
| Any legal or privacy opinion | Requires a lawyer and a data protection reviewer; none exists for this project | Privacy, legal |

## Supply chain (added 2026-08-02)

The three simulated reviews scoped supply chain out. GitHub then reported 16 Dependabot alerts on
the default branch, so it was triaged properly rather than left as a written down gap.

`npm audit` and the Dependabot API were cross referenced, and each finding was checked for whether
it is reachable from code this product actually ships. That is the question that decides severity
here, because a vulnerability in a linter is not a vulnerability in a product.

**Fixed.** `npm audit fix` with no force flag, so no major versions moved. Total findings went from
17 to 12 and high severity from 5 to 3. Closed: `brace-expansion` (high), `fast-uri` (high),
`@hono/node-server`, `@modelcontextprotocol/sdk`, `tar`. All five reach the tree only through
`eslint`, `firebase-tools` and other build tooling, never through a shipped path. Next was also
moved from 16.2.10 to 16.2.12, the newest stable release.

**Open, and honestly not fixable today.**

| Package | Severity | Why it is still here |
|---|---|---|
| `next` | high | The advisory range runs to `16.3.0-preview.7` and 16.2.12 is the newest stable release, so no patched version exists yet. npm's suggested fix is a downgrade to `next@9.3.3`, seven majors back, which is not a fix. |
| `postcss` | high | Reaches the tree through `next` and `@tailwindcss/postcss`. Same constraint, and the same downgrade suggestion. |
| `sharp` | high | An optional dependency of `next` for image optimization. Same constraint. |
| `firebase-admin` and its `@google-cloud/storage`, `gaxios`, `retry-request`, `teeny-request`, `uuid` chain | moderate | The offered fix is `firebase-admin@10.3.0`, a major downgrade from 14.x. |
| `firebase-tools`, `@google-cloud/pubsub`, `@opentelemetry/core` | moderate | Development dependency only. Never shipped. |

**Reachability of the three open high findings, checked against this codebase rather than assumed.**

The `next` advisories cover Server Actions, middleware and proxy bypass, rewrites, cache confusion,
and image optimization. Of those:

- No Server Actions exist. `grep -rl "use server"` over `app/` and `lib/` returns nothing, which
  rules out the Server Action SSRF, the denial of service, the unbounded Edge payload, and the
  unauthenticated Server Function disclosure.
- No middleware exists. There is no `middleware.ts` anywhere, which rules out the middleware and
  proxy bypass.
- No rewrites exist. `next.config.ts` is empty of configuration, which rules out the rewrites SSRF
  and leaves no configured remote image hosts.
- `next/image` is not used. The only mention in the codebase is a comment in
  `components/TaskCard.tsx:113` explaining why it is deliberately avoided, so the image optimizer
  is reachable only as a default endpoint with no remote hosts allowed.
- Cache confusion is the one class not ruled out by code shape, and it is the reason this is
  recorded as accepted risk rather than dismissed.

`postcss` runs at build time, in the Tailwind pipeline, over CSS this repository controls. The
path traversal and source map advisories need attacker controlled CSS, which does not exist here.

`sharp` is only exercised through image optimization, which the previous point covers.

**Accepted risk, and the condition that changes it.** Upgrade `next` the day a stable release
lands outside the advisory range, and re run this triage. Until then the three high findings stay
open, documented, and reachable only through the cache confusion class.

**The wider gap this exposed.** CI runs typecheck, lint, unit tests and a build. It runs no
dependency audit at all, which is why 16 alerts accumulated unnoticed. Adding `npm audit --omit=dev`
to `.github/workflows/ci.yml`, with an allowlist for findings that have no available fix, would
stop this recurring. That is not done yet and is the next action.

## Kill criteria (R1)

Kill or pivot the auto-publish design if a cohort participant reports a published narrative they did
not consent to, or a narrative that named someone other than its actor, at any point during the
pilot. Result so far: no such report, and no monitoring in place that would surface one other than a
participant speaking up. That is a weak check and is recorded as weak.

---

## Pushback (CS1)

Findings from the three simulated reviews run at commit `4753283`. **Nothing below was fixed in
code.** The value of the log is that each item is now written down with a rank, a file, and either a
plan or a defended reason for leaving it.

### Decisions these reviews changed

None yet, in code. Four claims in prose are now recorded as wrong or overstated, and correcting them
is the cheapest work on the list:

1. **README.md's "a deterministic guard gates every published summary" is too wide** (S1, P1). The
   guard runs at `lib/narrate.ts:164`, on the generation path. `firestore.rules:238-249` constrains
   `actorUid` and `actorName` and places no constraint on the `narrative` string, and `:261` lets the
   actor rewrite it afterwards, so any signed-in member can publish any sentence about any peer from
   the browser. The correct claim is that the guard gates every model-written summary, not every
   published narrative. Changed: the claim is now recorded as overstated. Not yet changed: the README.
2. **`docs/FDE_JOURNEY.md:23` headlines `forgetShared` as "Right to be forgotten"** (S4, P1). That
   function covers the shared-context bus only. Nothing purges the feed, the narratives, or the
   tombstones, `optOuts` is create-only and permanent (`firestore.rules:344`), and `usageCalls` rows
   accumulate forever (`lib/usage-admin.ts:56`). There is no retention window written anywhere.
   Changed: recorded. Not yet changed: the doc, or the missing policy.
3. **`docs/EVALS.md`'s groundedness layer is filed under "Narrative accuracy"** (E2, P0). The
   deterministic scorer at `lib/groundedness.ts:51-81` checks PR numbers and file tokens, the labels
   in `evals/groundedness-dataset.json` were written to match what it can check, and
   `run-groundedness-eval.ts:92` fails only on disagreement with those labels. `evals/README.md:99`
   invites fabricated commit counts as good additions, and the scorer has no commit-count check, so
   such a case would fail the run and will therefore never be added. It is a regression detector for
   a regex. Changed: recorded. Not yet changed: the doc or the scorer.
4. **Every published eval number is missing its denominator** (E1, P0). 26 of 26 must-block rows is a
   95% Wilson lower bound of 87.1%; the 7-row and 8-row sets bottom out at 64.6% and 67.6%. And
   `tests/unit/eval-metrics.test.ts:108` asserts `rows.length <= 60`, so CI fails if the fixture that
   most needs more rows grows past 60. Changed: recorded. Not yet changed: the numbers, the cap, or
   the fixture.

### Decisions explicitly defended, and kept

1. **The readable opt-out tombstone list stays** (S3, P1). `firestore.rules:332` is `allow read: if
   true`, so the list of people who asked to be hidden is public. The steel-man is strong: this is
   the one place the product leaks exactly the fact it exists to protect. It is kept anyway, because
   the pre-index runs unauthenticated through the client SDK and closing it needs a service-account
   credential that does not exist, and because a working exit with a visible list is better for the
   people it serves than no exit at all. The failure mode is embarrassment, not harm. Logged as open
   at P1 rather than downgraded.
2. **`/opt-out` keeps its one-click submit** (D3, P1). The reviewer wants a confirmation step in front
   of a permanent, unverified, irreversible action (`app/opt-out/page.tsx:118`, reversal denied at
   `firestore.rules:344`). Defended: every extra step on the exit is a step where somebody gives up
   and stays indexed against their wishes, and the design premise is that leaving must be cheaper
   than staying. The right fix is an undo path, not friction on the way out, so the open item is the
   missing reversal, not the missing confirm.
3. **Precision stays in the reported guard metrics** (E5, P2). The reviewer wants only recall, on the
   grounds that a false positive costs facts-only, which is a designed and harmless fallback. Partly
   conceded, partly defended: a guard that started rejecting every legitimate narrative would turn the
   whole product facts-only in silence, and precision is the only number that would catch it. What is
   conceded is the framing, four metrics at 100% reads as a stronger result than one metric at 100%
   with a stated denominator, and the denominator is what is missing.
4. **No code was changed by any of these reviews** (all three). Defended deliberately: the deliverable
   is the review. A fix written in the same session as the critique, by the same person, with no
   second reader, would carry the appearance of resolution without the substance of one, which is the
   exact failure this document exists to avoid.

### Full finding list

Ranks and citations for all seventeen findings are in
[STAKEHOLDERS.md](STAKEHOLDERS.md), Pushback section: six from the design review (D1 to D6), six from
the security and privacy review (S1 to S6), five from the eval review (E1 to E5). Summary by rank:

- **P0 (2):** E1 sample sizes and the CI row cap; E2 the circular groundedness eval.
- **P1 (8):** D1 focus contrast; D2 no keyboard or screen-reader testing; D3 unverified permanent
  opt-out with no reversal; S1 guard claim wider than the control; S3 readable tombstone list; S4 no
  retention window or deletion path; E3 a judge that cannot fail; E4 the homoglyph residual.
- **P2 (7):** D4 unannounced loading state; D5 dead light-theme scaffolding; D6 placeholder contrast;
  S2 caller-supplied guard peer list; S5 rate-limit ceiling and the unverified IP key; S6 logs are
  clean, disclosure is not; E5 metric weighting.

One of those, S6, is recorded as substantially a clean pass: every `console` call in the repo was
read and none of them logs a handle, a narrative, prompt text, or a credential.
