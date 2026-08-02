# Incident runbook: a bad narrative is live

SH8. This is the rollback for one specific incident, the only one Pulse can have that hurts a
person: **a prompt or model change is deployed, and the sentences Pulse is publishing about the
cohort are wrong.** Wrong meaning inaccurate, off-tone, editorialising, or naming somebody it
should not.

It is written for the situation where it is happening right now and nobody has slept.

## What makes this incident different

Pulse publishes without asking. There is no approval queue in the default mode, the feed is
realtime, and 64 people see the sentence before anyone reviews it. So the clock that matters is
not "time to fix" but **time to stop adding to the pile**, and those are two different actions
with two different first steps.

Two facts make the rollback survivable, and both are already built:

1. **Facts-only is a designed state, not an error state.** `narrate()` degrades to
   `{ kind: 'facts_only' }` on every failure path, and the feed renders the commits, PR numbers
   and file names without a sentence. Turning narration off does not break the product; it
   returns it to the thing that cannot be wrong. Reach for that first and think afterwards.
2. **The evidence is separable from the prose.** A `pulse` event holds `narrative` (model-written)
   and `evidence` (GitHub API facts). Blanking the first leaves the second intact, so the record
   of what somebody actually shipped survives the incident.

## Severity, decided in one question

**Does any wrong narrative name a person other than its actor?**

- **Yes** → severity 1. Go to step 1 now. This is the failure the whole guard exists to prevent
  and the one that damages a relationship between two people who did not ask to be in it.
- **No** → severity 2. Still roll back, but you can spend the two minutes on step 0 first.

## Step 0. Capture, before you change anything (2 minutes)

Everything below destroys evidence. Screenshot the feed, and run:

```
node scripts/incident/redact-narratives.ts --since <when the deploy landed>
```

with **no `--apply`**. It prints every affected event and its sentence and changes nothing. That
output is the incident record and the raw material for step 5. Skip this only at severity 1, and
even then only if the printing costs more than a minute.

## Step 1. Stop new sentences. First, always (about 3 minutes)

**Unset `ANTHROPIC_API_KEY` in the Vercel project and redeploy.**

That is the kill switch, and it is the fastest one because it is the path with the least code
between the decision and the effect: `getClient()` returns null when the key is absent and
`narrate()` returns `facts_only` with reason `no_api_key` before it constructs a prompt.

- **Time:** the env change is instant; the redeploy is the wait, typically 2 to 4 minutes. Route
  handlers read `process.env` at runtime, but Vercel's running instances keep the old environment
  until they are replaced, so the redeploy is what makes it real.
- **How you know it worked:** `GET /api/usage` and read `outcomes`. `outcomeFactsOnly` climbs and
  `outcomeNarrated` stops moving. Within a sync cycle `health.signals` shows `degradation_rate`
  at or near 1.0. That is the alarming-looking number that means the kill switch landed.
- **Blast radius:** every member's feed goes facts-only. That is the intended state. It is
  reversible in one env change.

Do not start with a git revert. A revert is a code review, a build and a deploy under pressure,
and it is slower than deleting one environment variable.

## Step 2. Remove the sentences already published (about 5 minutes)

```
node scripts/incident/redact-narratives.ts --since <deploy time> --apply
```

Sets `narrative` and `proposedNarrative` to null on every `pulse` event in the window, in batches
of 400. Facts and evidence stay. Add `--actor <uid>` if only one member's feed is affected.

- **Time:** seconds for a pilot-sized feed once the credential is in place.
- **How you know it worked:** re-run without `--apply`; it reports 0 affected.
- **If `FIREBASE_SERVICE_ACCOUNT` is not configured**, the script says so and exits. The manual
  path is the Firebase console: `pulse` collection, filter on `createdAt`, clear the `narrative`
  field. Slower, and it works. Getting that credential configured is the single change that most
  shortens this step, and it is an open item, not a solved one.

## Step 3. Undo the change that caused it (10 to 20 minutes)

Only now, with the bleeding stopped, work out what shipped. In descending order of likelihood:

1. **The `SYSTEM` prompt in `lib/narrate.ts`.** The hard rules block is what holds the
   "only ever about the actor" property. `git log -p lib/narrate.ts` and revert the commit.
2. **`ANTHROPIC_MODEL`.** The default is pinned to `claude-opus-4-8` in code and overridable by
   env. An override to an unpinned or newer model changes tone and can change refusal behaviour.
   Clear the override rather than editing the pin.
3. **`checkNarrative` in `lib/sense.ts`.** If the incident is a peer name reaching the feed, the
   guard is the thing that failed, and a prompt revert will not fix it.
4. **`output_config: { effort: 'low' }`.** Raising effort changes the shape of the output.

Revert, open a PR, let CI run. Do not push a fix straight to main during an incident: the emulator
job and the guard fixture in CI are precisely what catches a fix that makes it worse, and skipping
them to save four minutes is how a one-hour incident becomes a three-hour one.

## Step 4. Turn narration back on, deliberately (about 5 minutes)

Restore `ANTHROPIC_API_KEY` only after the reverted code is deployed and its PR was green.

- **How you know it is healthy:** `GET /api/usage`. `health.level` back to `ok`;
  `degradation_rate` back under 0.2 (`DEGRADATION_WARN_RATE` in `lib/health.ts`), and
  `guard_rejection_rate` under 0.1. Read the first ten narratives with your own eyes as well,
  because those thresholds need 20 attempts before they mean anything.

## Step 5. The part that stops it recurring, and the part everyone skips

**Every sentence from step 0 becomes a fixture row.** This is not paperwork; it is the only
mechanism in the repo that makes an incident permanent knowledge rather than a memory.

1. Open `evals/guard-fixture.json`. Add one row per distinct failure mode:
   ```json
   {
     "id": "incident-2026-08-02-01",
     "category": "peer-named",
     "narrative": "<the exact sentence that shipped>",
     "authorHandle": "rowan_dev",
     "otherMembers": [...],
     "expectedBlocked": true,
     "note": "Shipped live on 2026-08-02 after the prompt change in <sha>. See docs/RUNBOOK.md."
   }
   ```
   Use the fixture's own invented handles, never a real cohort member's name. The incident is
   the lesson; the person does not need to be in the repository forever.
2. Run `npm run eval:guard-metrics`. **Expect it to fail**, and read the failure carefully:
   - If the guard now blocks the sentence, the incident was a prompt regression and the row is a
     regression test. Update the pinned confusion matrix in `tests/unit/eval-metrics.test.ts`.
   - If the guard does **not** block it, the guard has a hole. Either fix `checkNarrative` and
     keep the row scored, or, if it cannot be fixed today, move it into the fixture's
     `knownResiduals` with the reason. Do not relabel it `expectedBlocked: false` to get green.
     That is the one move that turns this file into a lie.
3. Adding rows never breaks CI on size: the row-count assertion is a floor of 70, not a ceiling.
   That was a real defect once and it is fixed, so there is no excuse left for not adding cases.
4. Record the incident in `docs/DECISION_LOG.md` with the date, the sentence class, and which of
   the two branches in point 2 it fell into.

## What this runbook does not cover, honestly

- **Nothing alerts.** No pager, no cron, no webhook. `GET /api/usage` measures the degradation and
  spend thresholds and nothing reads it on a schedule, so today the detector is a person opening
  the feed or a participant complaining. That is the weakest link in this document and it is
  written down rather than implied. `lib/health.ts` is the measurement half; the notification half
  is not built.
- **There is no staged rollout.** A prompt change reaches all 64 members at once. A canary of one
  cohort member would cap the blast radius of the entire incident above, and does not exist.
- **`--apply` needs a service account** that is not configured in every deployment, so step 2 can
  degrade to clicking in a console.
- **You cannot unsend a screenshot.** Once a member has read a wrong sentence about a peer, the
  rollback fixes the record, not the relationship. That is the reason step 1 is measured in
  minutes and not hours.
