# ADR-0001: model output publishes to the shared feed with no human in the loop

Date: 2026-08-02
Status: accepted, and in force on the narration path since the pilot began

**Written after the fact.** The decision was made when the narration path was built; this document
reconstructs it from the code that shipped, so the reasoning below is the reasoning the code
embodies rather than a recollection of a meeting. Where the code does not settle a question, this
says so instead of filling the gap.

## The fork

Pulse writes a sentence about what a member did that week and puts it in a feed the whole cohort
reads. There are two ways to ship that, and they are not close together:

1. **Draft for review.** The model writes, a human approves, the feed shows approved sentences.
2. **Auto-publish behind a machine gate.** The model writes, deterministic code decides whether it
   is publishable, and the feed shows what survives.

Pulse does the second.

## What was picked

`narrate` produces a sentence and `checkNarrative` (`lib/sense.ts:400`) decides its fate before it
reaches anybody. The guard is deterministic and refuses on four grounds: empty, over
`NARRATIVE_MAX_CHARS`, containing markup or HTML, or **naming a member other than the actor**.

The fourth is the load-bearing one. Pulse's whole risk is a sentence that attributes something to
the wrong person in front of their colleagues, so the guard folds both the narrative and every
member name through `foldForMention` before matching. That exists because the cheapest injection
evasion is typographic: a zero-width character spliced into a name, or a combining-mark variant,
renders identically to a reader and slips a naive word match. A commit message can steer the model
into emitting exactly that, so the comparison happens in the space a reader actually sees.

A refusal is not an error. It degrades to a facts-only line, which is a real product state rather
than a failure path, and the degradation is counted (`lib/health.ts`).

## What was rejected

**Draft-for-review.** A human queue would catch everything the guard catches and everything it
cannot, including the failure mode the guard is structurally blind to (below).

It was rejected because it does not survive contact with the product's shape. Pulse narrates for a
65-person cohort every week, so review is a recurring weekly obligation on one person, and the
value of the feed is that it is *there on Monday* rather than *there once somebody got to it*. A
review queue that runs late produces a feed nobody trusts to be current, which is a different
failure from the one it prevents but not obviously a smaller one.

The honest version: this was a judgment about a solo-operated pilot, not a general claim that
auto-publish beats review. At a different scale or with a different operator the answer flips, and
that is what the reversal conditions below are for.

## What it gives up

**The guard checks shape, not truth.** `checkNarrative` cannot tell a true sentence from a
plausible invented one. A narrative that says a member shipped a feature they did not ship, in
clean prose, naming only its own actor, passes every check in the function. Nothing in the
deterministic path will ever catch that.

That gap is covered elsewhere and only partly: `lib/groundedness.ts` runs a model judge over
narratives against the evidence, and that judge is itself validated against human labels rather
than assumed. But the judge is a sampled quality measurement, not an inline gate on the publish
path, so the true position is that **a structurally-valid invention can publish**, and the detector
for it is a person reading the feed.

Two smaller costs, both accepted knowingly:

- **The guard over-refuses.** A member legitimately mentioned in another member's week is
  indistinguishable from an injected name, so a genuinely collaborative sentence gets refused and
  degraded to facts. Precision was traded for safety in the direction that matters.
- **No editorial voice.** Nobody smooths a clumsy sentence before 65 people read it.

## What would change my mind

Reversal conditions, pre-committed in `docs/DECISION_LOG.md` §Kill criteria and evaluated by
`lib/kill-criteria.ts`:

- **K2, and it is N=1.** One participant reporting a published narrative they did not consent to,
  or one naming somebody other than its actor, kills this decision outright. Not a threshold to
  tune: the guard would have failed at the exact thing it exists to do, and the fallback is
  draft-for-review.
- **K1, the rate.** A degradation rate at or above 0.5 across a full pilot week with at least 20
  attempts means the guard is refusing so much that the feed has stopped being a feed. Same
  consequence: auto-publish off, drafts to a human.
- **Scale.** The review-is-too-slow argument is a 65-person argument. It does not obviously hold at
  650, and nothing currently triggers a re-examination, which is a gap this ADR records rather than
  closes.

## Related

- `docs/DECISION_LOG.md` §Kill criteria, for K1 and K2 in full.
- `lib/sense.ts:400`, the guard.
- `lib/health.ts`, for what a broken narration rate looks like as a number.
