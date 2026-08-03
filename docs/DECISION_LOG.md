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

**That cut expired on 2026-08-02.** A separate pass then closed SH10, B2, SH9, SH8, SH3 and the eval
fixture cap, in code, with tests. The reasoning above still holds for why the *review* did not fix
them: what changed is that the fixes were made later, deliberately, and are recorded below with what
each one did not close.

## Skipped artifacts / questions

| What | Why | Pillar affected |
|---|---|---|
| Dependency and supply-chain review | Closed further on 2026-08-02: triaged, then gated in CI with an expiry-enforced allowlist, a pinned secret scan, and least-privilege workflow permissions. Still out of scope: the vendored `conduit/` provenance and a lockfile review | Security |
| Testing against the live deployed app | The design review read source only; nothing was observed in a real browser, on a real screen reader, or at a real viewport | Design, accessibility |
| The rules, integration, and e2e suites | The eval review read only the three eval harnesses; nothing here speaks to the QUALITY of the other 934 test cases. Since 2026-08-02 the rules and integration suites at least RUN in CI (B2), which is a different claim | Evals |
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

> Superseded on 2026-08-02 by "The not-fixable findings were fixable" below. The table and
> the reachability analysis that follow are kept as written, because the reasoning is what
> makes the correction legible. Three of the five rows are now closed outright. Read the
> correction before relying on anything in this subsection.

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

**The wider gap this exposed, now closed (2026-08-02, SH10).** CI ran typecheck, lint, unit tests
and a build and no dependency audit at all, which is why 16 alerts accumulated unnoticed. It now
runs `scripts/audit/gate.mjs` on every pull request, in its own `supply-chain` job so a
supply-chain failure reads as one rather than as "the build broke".

The gate fails on any high or critical advisory in a **production** dependency that is not covered
by an entry in `scripts/audit/allowlist.json`. Each entry carries the package, the GHSA id, a
reason that has to actually argue reachability, a link, and an **expiry date**.

**The expiry is the point.** RoleOS has the same idea in `scripts/audit-gate.mjs`, and it has one
real defect: its review dates live inside a free-text reason string ("no stable fix; review
2026-08"), nothing reads them, and every entry sailed past its date in silence. An allowlist that
only grows is worse than no allowlist, because it looks like a control. Here `expires` is a
machine-read field, an entry past its date **fails the build on its own** whether or not the
advisory is still present, and `tests/unit/audit-gate.test.ts` pins that behaviour along with the
malformed-entry cases. Two conditions warn rather than fail: an entry inside 21 days of expiry, and
an entry whose advisory upstream has fixed. Turning good news into a red build teaches people to
delete the gate.

Seeded with the four advisories that are actually open today, expiring **2026-09-15**, using the
reachability arguments above. One correction to this log's own earlier text while seeding it: `next`
itself no longer carries a high advisory of its own. Moving to 16.2.12 cleared them, and what
remains is `postcss` (three advisories) and `sharp` (one), reached through next as bundled
transitive dependencies with no independently upgradable version. The three-open-highs framing was
right about the count and slightly wrong about the packages.

Also added in the same job: a **secret scan**. gitleaks, pinned to 8.30.1 by version *and* SHA-256
rather than the marketplace action, because a job that exists to reduce supply-chain trust should
not add an unpinned dependency to do it. It runs over full history (`--log-opts=--all`), since a
secret committed and later "removed" is still leaked. Clean on the current tree. And the workflow now
declares `permissions: contents: read`, which was one of the items this log listed as out of scope.

### The not-fixable findings were fixable (correction, 2026-08-02)

Everything above rests on one claim: that `postcss` and `sharp` reach this tree only through `next`,
and that no version of either could be taken without downgrading `next`. The first half is true. The
second half was wrong, and it was wrong at the time it was written, not just overtaken by events.

`next@16.2.12` declares `postcss` as an exact pin of `8.4.31` and `sharp` as an optional `^0.34.5`.
Neither range accepts the patched release, which is what `npm audit fix` reports and what this log
repeated. But npm's `overrides` exists precisely to force a transitive dependency past a parent's
range, and it was never tried. `package.json` now carries:

```json
"overrides": { "next": { "postcss": "^8.5.25", "sharp": "^0.35.0" } }
```

Resolved versions moved from `postcss 8.4.31` to `8.5.25` and `sharp 0.34.5` to `0.35.3`, both
outside every advisory range. `npm audit --omit=dev` went from **3 high and 6 moderate to 0 high and
6 moderate**. Verified on this tree with `npm run typecheck`, `npm run lint` and `npm run build`, all
green, plus the unit suite. The build is the check that matters here, because `postcss` runs inside
the Tailwind pipeline at build time and a broken override would surface there rather than in tests.

All four allowlist entries are therefore deleted rather than re-dated, and
`scripts/audit/allowlist.json` is now empty. The gate had already been saying so: it prints a
`no longer reported` note for an entry upstream has fixed, and it printed one for all four before
they were removed. The note worked. Nobody read it for the days it took to notice.

What this cost: three high advisories sat documented as unavoidable, with a careful reachability
argument attached, when a four-line change closed them. A good reachability argument is not a
substitute for checking whether a fix exists, and the more convincing the argument reads the less
likely anyone is to re-check. That is the failure mode worth naming, because the allowlist mechanism
is designed to defend against exactly it and still did not.

**What remains, and it is not gated.** Six moderate advisories, all one chain:
`firebase-admin 14.2.0` to `@google-cloud/storage 7.21.0` to `teeny-request` and `gaxios`, ending at
`uuid 9.0.1`. Both are already the newest published versions, so there is nothing to upgrade to; the
only fix npm offers is `firebase-admin@10.3.0`, four majors back. The advisory,
[GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq), is a missing buffer bounds
check in `uuid` **v3, v5 and v6, and only when a `buf` argument is supplied**.

That is falsifiable rather than asserted. Every `uuid` call site in the installed tree:

```
find node_modules -name '*.js' -not -path '*/node_modules/uuid/*' \
  | xargs grep -hoE "uuid[_0-9a-zA-Z]*\.(v[0-9]+)" | sort | uniq -c
#   7 uuid.v1     (universal-analytics, a firebase-tools dev dependency)
#  15 uuid.v4
#   1 uuid_1.v4   (gaxios, multipart boundary)
```

No `v3`, `v5` or `v6` call anywhere, in prod or dev, and no `buf` argument to pass. If that grep ever
returns a `v3`, `v5` or `v6` line, this argument is dead and the chain needs re-triage. Moderate
findings do not gate merges here by policy, so no allowlist entry is created; this paragraph is the
record.

## The high-value suites now run in CI (added 2026-08-02, B2)

TESTING.md calls the rules and integration suites the ones that would actually catch a privacy
regression, and CI never ran them. They ran through `npm run gate`, on Nik's laptop, which means
they ran when he remembered. A test that gates nothing is documentation.

An `emulator` job now runs them on every pull request: Temurin 21, `npm ci`, `npm run test:rules`,
`npm run test:integration`. Rally already does this successfully in its own `ci.yml` and this is
modelled on it directly. Two additions for reliability, because a flaky gate is worse than none:
the emulator jars are cached by `actions/cache`, so the job does not sit behind a Google CDN on the
critical path, which is the most likely source of flake here; and the job has a 20-minute timeout so
a hung emulator fails visibly instead of burning an hour.

Verified locally before shipping, against a real Firestore emulator: 148 rules tests and 55
integration tests, both green, about 7s and 18s. The e2e suite stays out of CI. It needs a built app
and a browser as well as the emulator, and the honest reason it is excluded is that its reliability
under CI has not been demonstrated, not that it is unimportant.

## Retention and deletion (added 2026-08-02, SH9)

Three verified gaps: no written retention window, no deletion path, and the opt-out tombstone list
is itself readable. Two are now closed and one is documented rather than fixed. Full text in
[RETENTION.md](RETENTION.md).

**The policy is code.** `lib/retention.ts` holds it as a typed table with a window, a basis field,
an enforcement mechanism, and a note per data class. That shape was chosen so the enforcement and
the documentation cannot drift apart, and so `unenforcedRules()` can return the classes nothing
enforces, which the sweep prints on every run. A policy that cannot report its own holes will
eventually stop having any.

**Windows, and why they are enforced three different ways.** Pulse has no single credential that
reaches everything, so:

- `usageCalls` (90d) and `askThreads/{uid}/turns` (30d) prune on their **write path**. That is the
  only enforcement that needs no service account and therefore runs in every deployment, which is
  why it was given to the two collections that grow fastest. Both are bounded to one batch,
  unawaited, and swallow errors: a retention pass must never delay a narration or break a
  conversation. Its limit, stated rather than hidden: a member who never opens Ask Pulse again
  keeps their old turns until they do.
- `briefs` (30d) and `introductions` (60d) need the **sweep** (`npm run retention:sweep`), which
  needs a credential and, honestly, **has no scheduler**. It is a manual act today.
- `pulse`, `tasks`, `recipes` and `comments` have **no window and no enforcing code**. For the feed
  that is a product decision: the feed is the cohort's memory of what people built, and a feed that
  erases itself is worth less. It is not a claim of coverage, and the code reports it as
  unenforced.

`introductions` gets the shortest content window because it is the one document that names somebody
who was struggling, and an offer of help is useful for days and embarrassing for years.

**Deletion.** `scripts/retention/delete-participant.ts`, dry run by default. It deletes the
member's private documents, everything they authored, every feed event where they are the actor or
the named other party, and both sides of every introduction; it redacts rather than deletes their
uid from other people's credit and kudos lists, and unassigns their shared tasks with the sensed
evidence stripped; and it **creates** an opt-out tombstone, because without one the pre-index
rebuilds them from the public repo on the next render and the deletion undoes itself in fifteen
minutes. `members/{uid}` goes last, so a run that dies half way leaves a findable subject.

**What deletion cannot reach** is returned with every report, including dry runs, because a report
that lists only successes teaches the reader that deletion is total: GitHub itself, the public
cohort repository, the tombstone (deliberately permanent), shared task cards, Anthropic-side logs of
prompts and completions, Vercel request logs and any Firestore backup taken beforehand, anything a
member already read or screenshotted, the Firebase Auth identity, and the cross-app context bus,
which `forgetShared` covers separately and this path does not call.

**The readable tombstone list stays open, and here is the honest accounting.** It was previously
defended in this log and it is still not fixable today: the pre-index runs unauthenticated through
the client SDK, so tightening the rule breaks the filter and shows people who opted out, which is
strictly worse than the leak. Hashing the handles was considered and **rejected**, because the
candidate set is a public repository of about 65 GitHub logins: anyone can hash all of them in a
second and recover the list exactly. Shipping that would have bought the appearance of protection
and nothing else, which is the one thing this project will not do.

What did change is a real defect found next to it: `fetchOptOuts` read a single 300-document page
and dropped `nextPageToken`, so the 301st person to opt out would have been silently missing from
the filter and would have reappeared on the landing page. The exact failure the module's own header
says must never happen, waiting behind a number nobody would have noticed crossing. It now follows
every page and throws rather than returning a partial list, and `removeOptedOut` already turns a
throw into "show nobody". Covered by `tests/unit/opt-out.test.ts`, which is the first unit test the
exit path has ever had.

## Incident response (added 2026-08-02, SH8)

[RUNBOOK.md](RUNBOOK.md) is the rollback for the one incident that hurts a person: a prompt or model
change is live and the sentences Pulse is publishing about the cohort are wrong.

The order is the decision worth recording. **The kill switch is first and it is not a git revert.**
Unsetting `ANTHROPIC_API_KEY` makes `narrate()` return `facts_only` before it builds a prompt, which
lands the product on its own designed degradation rather than on an error, and it is about three
minutes because the redeploy is the only wait. A revert is a build and a review under pressure and
is strictly slower. Then the sentences already published are blanked while the evidence is kept
(`scripts/incident/redact-narratives.ts`, dry run by default, `--since` required so the tool cannot
blank the whole feed by accident), and only then does anyone work out what shipped. Each step names
how long it takes and what tells you it worked, and the "it worked" signals are the thresholds in
`lib/health.ts` rather than a feeling.

**The incident becomes a permanent eval case** in step 5, and that step only exists because the
fixture cap was fixed first: every sentence that shipped becomes a row in `evals/guard-fixture.json`,
and the runbook is explicit that if the guard still does not block it, the correct move is a
`knownResiduals` entry, never relabelling it as allowed to get a green run.

**What the runbook does not have, and says so:** nothing alerts, there is no staged rollout so a
prompt change reaches all 64 members at once, and `--apply` needs a service account that is not
configured everywhere. And you cannot unsend a screenshot: the rollback fixes the record, not the
relationship, which is why step 1 is measured in minutes.

## Observability threshold (added 2026-08-02, SH3)

Pulse had a live spend counter and a discriminated degradation union and **nothing anywhere that
said what number means "it is broken"**. A dashboard with no threshold is a number somebody glances
at. `lib/health.ts` is the threshold.

- **Degradation rate** over 20% warns, over 50% alerts, and below 20 attempts it is reported and
  never judged, because three degraded attempts out of three is a 100% rate that means nothing and
  alerting on it trains people to ignore alerts. `skipped_cached` is deliberately **excluded from
  the denominator**: it is the budget guard working, and folding it in would let a warm cache hide a
  completely broken model path behind a flattering ratio.
- **Guard-rejection rate** over 10% alerts separately. It is the sharper signal hiding inside the
  degradation rate, and it wants a different response: a `nothing_to_say` is the model behaving, a
  wave of `names_another_member` is something steering it.
- **Spend** over $0.75/day alerts, set against the ~$11 of pilot credit rather than against the
  ~$524 uncached projection, and the per-day divisor floors at one day so ten minutes of traffic
  cannot invent an alarming number.

The counters are new: `recordOutcome` in `lib/usage-admin.ts` records what each narration attempt
DID, as distinct from what it cost, and `/api/usage` returns the verdict.

**The honest half.** There is no notification channel. No pager, no cron, no email, no webhook.
Nothing in this repository will wake anybody up. What is built is the measurement and the threshold;
the last mile is a person opening a URL. That is stated in the module, in the API response body as
a `notice` field, in the runbook, and in a unit test that asserts the response keeps saying it, so
the claim cannot quietly drift into "we have alerting".

## The eval fixture cap was a guard rail installed backwards (fixed 2026-08-02)

`tests/unit/eval-metrics.test.ts` asserted `rows.length <= 60` on the guard fixture, so CI actively
failed if the safety dataset that most needed growing grew. It now asserts a **floor** of 70 rows
and a minimum of 25 per class. Adding cases can never break the build; removing them can.

The fixture grew from 49 rows to 76 (41 must-block, 35 must-allow), every new row checked against
the real `checkNarrative` before it was written rather than labelled by hand. The new cases cover
fullwidth peer names folded by NFKD, case variants, a hyphen acting as a word boundary where an
underscore does not, praise that names a peer (the rule is about naming, not tone), an injected
instruction that also names a peer, doubled backticks and underscores, an HTML comment, a markdown
image, and the two rows either side of the 200-character cap. That takes the 95% Wilson lower bound
on recall from 87.1% to **91.4%**, which is the number now printed next to the 100% in
`docs/EVALS.md`, `README.md` and `evals/README.md`.

The more useful addition is `knownResiduals`: four evasions the guard genuinely **misses** today,
now written into the fixture instead of absent from it. Cyrillic homoglyph, soft hyphen, a name
spelled with separating spaces, and a Turkish dotless `ı`. They are excluded from the score on
purpose, because scoring them would report a recall below the 1.0 safety floor and the tempting fix
would be to relabel them as allowed. Instead the unit test asserts each one **still evades**, so the
day `foldForMention` is widened and one starts being blocked, CI goes red and tells you to promote
it into the score. A fixture that names what it misses is worth more than one that reports 100%
over a set chosen to produce 100%.

## Kill criteria (R1)

Two criteria. One is a rate and one is a single event, and they are deliberately different shapes.

### K1, the rate: degradation at or above 50% for a full pilot week

**Kill the auto-publish design if the degradation rate is at or above 0.5 across 7 consecutive
days, with at least 20 narration attempts in that window.**

**Consequence: auto-publish OFF.** Narratives become drafts a human reviews before they reach the
feed. Going back to auto-publish afterwards requires a new pre-committed line, not a quiet switch.

Committed 2026-08-02, before the window it governs. Evaluated by `evaluateKillLine` in
[`lib/kill-criteria.ts`](../lib/kill-criteria.ts), covered by `tests/unit/kill-criteria.test.ts`.

Neither number is new, which is the point. 0.5 is `DEGRADATION_ALERT_RATE` and 20 is
`DEGRADATION_MIN_SAMPLE`, both already in `lib/health.ts` with their reasoning: at half of all
narration attempts degrading the product has stopped doing the thing it exists to do, and below 20
attempts the rate is noise. What this adds is the window, the consequence, and the commitment.

**Why a window and not the existing alert.** `DEGRADATION_ALERT_RATE` fires on one reading, and one
bad reading is a reason to look rather than a reason to stop: a provider blip, one member's odd
week, a key rotated at the wrong moment. Sustained over a week with a readable sample is a
different claim. The tests pin this both ways: two catastrophic days inside an otherwise healthy
week do **not** kill the product, and a full week at 100% degradation on only 7 attempts does
**not** either, because a rate read off 7 attempts is not evidence.

**Result so far: not enough data.** No pilot week of outcome counters has been evaluated against
this line yet. That is the honest status, and `evaluateKillLine` returns exactly that rather than a
reassuring "holding".

### K2, the single event: one non-consented publication

**Kill the auto-publish design if a participant reports a published narrative they did not consent
to, or one that named somebody other than its actor.** N=1. Not a rate, never averaged, and it
dominates K1: `evaluateKillLine` returns `crossed` on a consent report even in a perfectly healthy
week and even with no data at all.

**Result so far: no such report.**

The asymmetry between K1 and K2 is deliberate. A rate can be argued about. A single person publicly
attributed something they did not say cannot be, and a criterion that could be averaged away would
not be protecting the thing that actually matters here.

### The detector gap, still open and still stated

`lib/health.ts` defines what a broken narration rate looks like and `/api/usage` reports it, so K1
is measurable rather than felt. **But nothing polls it and nothing alerts**, in this repo or any
other in the portfolio.

K2 is worse and cannot be fixed by wiring: no number would catch it. A single wrong narrative that
the guard passed reads as a perfectly healthy narration, so the only detector is a participant
speaking up, and [RUNBOOK.md](RUNBOOK.md) is what happens next. Writing the criterion down does not
create the detector, and pretending otherwise would be the overclaim.

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
   **Since fixed (2026-08-02):** the doc line is rewritten to scope the claim to the context bus,
   the policy exists in `lib/retention.ts` and `docs/RETENTION.md`, `usageCalls` now prunes at 90
   days on its write path, and a deletion path exists. The tombstone stays permanent on purpose.
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
   most needs more rows grows past 60. **Since fixed (2026-08-02):** the cap is a floor of 70, the
   fixture is 76 rows, and the Wilson lower bound (now 91.4%) is printed next to the 100% in every
   place the number appears. The 7-row and 8-row datasets are untouched and still bottom out where
   they did.

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
