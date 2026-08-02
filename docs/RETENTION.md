# Data retention and deletion

SH9. Before this document there was no retention window written anywhere in Pulse, no deletion
path for a participant, and `usageCalls` and `askThreads` grew forever. The audit found three
gaps and this closes two of them properly and one of them partially. Which is which is stated
below rather than blurred.

The policy is **code**, not prose: `lib/retention.ts` holds it as a typed table, and this document
describes it. If the two ever disagree, the code is the policy and this file is the bug.

## The windows

| Data | Window | Measured from | Enforced by |
|---|---|---|---|
| `usageCalls` (one row per model call) | 90 days | `at` | Write path, `lib/usage-admin.ts` |
| `askThreads/{uid}/turns` (Ask Pulse transcript) | 30 days | `createdAt` | Write path, `lib/ask-thread.ts` |
| `briefs/{uid}` (cached Home brief) | 30 days | `updatedAt` | Sweep, needs a credential |
| `introductions` ("X is stuck on what you solved") | 60 days | `createdAt` | Sweep, needs a credential |
| `members`, `githubLinks`, `boardViews`, `cohortMembers` | Life of the account | n/a | Deletion path, not a clock |
| `pulse` (the feed), `tasks`, `recipes`, `comments` | No window | n/a | Nothing. See below |
| `optOuts/{handle}` (the tombstone) | **Permanent, on purpose** | n/a | Never deleted |
| `usage/totals` | Permanent | n/a | Bounded by shape, one document of counters |

Windows are short because the shape of the thing is short: a 10-week pilot for 65 people. There is
no business reason to hold a year of anything, and every extra month is exposure bought for nothing.

### Why these three windows and not others

- **`introductions` gets the shortest content window (60 days)** because it is the most sensitive
  document in the product: it names somebody who was struggling. An offer of help is useful for
  days and embarrassing for years.
- **`askThreads` gets 30 days** because the panel only ever reads the newest 50 turns
  (`THREAD_LIMIT`). Anything older was already invisible to its owner and was being kept for nobody.
- **`usageCalls` gets 90 days** and is the one class here that is not personal data at all: model,
  kind, token counts, cost. The window exists because an unbounded append-only collection is a cost
  and a liability with no owner, not because the rows are sensitive.

### The classes with no window, stated plainly

`pulse`, `tasks`, `recipes` and `comments` have **no time window and no enforcing code**. That is a
product decision for the feed, which is the cohort's memory of what people built and would be worth
less if it erased itself, and it is a shared-ownership decision for tasks. It is not a claim that
they are covered. `unenforcedRules()` in `lib/retention.ts` returns exactly this list, and the sweep
prints it every run, so nobody can read the policy and come away thinking otherwise.

## Enforcement, and what "enforced" means here

Three different mechanisms, deliberately, because Pulse does not have one credential that can reach
everything:

1. **Write path (runs everywhere, always).** `pruneUsageCalls` fires on a 2% sample of
   `recordCall`, and `pruneOldTurns` fires after every appended Ask Pulse turn. Both are bounded
   to one batch, unawaited, and swallow their errors: a retention pass must never delay a narration
   or break a conversation. This is the only enforcement that needs no service account, which is
   why the two collections that grow fastest are enforced this way.
   - **Its limit, honestly:** a member who never opens Ask Pulse again keeps their old turns until
     they do. Enforcement on write means enforcement only when there is a write.
2. **Sweep (needs a credential).** `npm run retention:sweep` applies every timed rule to completion.
   Dry run by default; `--apply` to delete. It needs `FIREBASE_SERVICE_ACCOUNT` or an emulator.
   - **Its limit, honestly:** there is **no scheduler**. Nothing runs this on a cron. It is a manual
     act today, so `briefs` and `introductions` are enforced exactly as often as somebody remembers.
     Wiring it to a scheduled job is open work, not done work.
3. **Bounded by shape.** `members`, `githubLinks`, `boardViews`, `usage/totals` cannot grow without
   bound: one document per member or per product, with a fixed field set. They leave with the
   account, through the deletion path.

## Deleting a participant

```
node scripts/retention/delete-participant.ts --uid <uid> --handle <github-login>
node scripts/retention/delete-participant.ts --uid <uid> --handle <login> --apply
```

Dry run by default. It prints the same report either way, including the limits section, so the
conversation with the participant can happen before anything is destroyed.

**Deleted outright:** `askThreads/{uid}/turns`, `briefs/{uid}`, `boardViews/{uid}`,
`githubLinks/{uid}`, `cohortMembers/{handle}`, every `comment` and `recipe` they authored, every
`pulse` event where they are the actor **or** the named other party, every `introduction` where they
are the subject **or** the helper, and finally `members/{uid}`.

**Redacted, not deleted:** their uid is removed from `recipes.unstuckUids`,
`recipes.publicThanksUids` and `pulse.kudos`. Shared `tasks` they created or were assigned are
unassigned and have `evidence` and `branch` stripped, which is the data that ties a card to a
person's commits, PR numbers and filenames.

**Created, not deleted:** an `optOuts` tombstone for their handle. Without it the pre-index rebuilds
them from the public cohort repository on the next render and the deletion silently undoes itself
inside fifteen minutes. Supply `--handle` or this does not happen and the script warns you.

`members/{uid}` goes last on purpose, so a run that dies half way leaves a findable subject rather
than orphans nobody can identify. The whole thing is idempotent: running it twice is not an error,
it is somebody who wanted to be sure.

### What deletion cannot reach

Printed with every run, and repeated here because a deletion report that lists only successes
teaches the reader that deletion is total:

- **GitHub itself.** Every commit, PR title and branch name Pulse read stays on github.com under
  the participant's own account. Pulse never had the authority to remove it.
- **The public cohort repository.** It is the source the pre-index reads, which is why the
  tombstone exists.
- **The tombstone itself,** deliberately and forever. Deleting it un-hides the person it protects.
- **Shared tasks.** Cards survive, unassigned and stripped. Deleting them would punch holes in other
  people's boards.
- **Anthropic-side logs** of the prompts and completions from narration and Ask Pulse. Governed by
  Anthropic's retention policy, not by this repository.
- **Vercel request logs, and any Firestore backup or export** taken before deletion ran.
- **Anything a cohort member already read, screenshotted or copied** out of the feed.
- **Firebase Auth.** This path deletes the Firestore record, not the auth user. Removing the auth
  identity is a separate console action and is not automated here.
- **Cross-app shared context.** `forgetShared` in `lib/shared-context.ts` covers the context bus and
  this path does not call it. Run it alongside.

## The readable opt-out list

`firestore.rules` still has `allow read: if true` on `optOuts`, so the list of people who asked to
be hidden is publicly readable. It is unchanged, and here is the honest accounting rather than a
mitigation dressed up as a fix.

- **Why it is still open.** The pre-index runs server-side through the *client* SDK with no
  credential, so the rules cannot tell the landing page apart from a stranger. Closing the read
  requires the Admin SDK on that path, which requires a service-account credential that is not
  configured in every deployment. Flipping the rule before that is done would break the filter and
  show people who opted out, which is strictly worse than the leak.
- **Why hashing the handles was considered and rejected.** Storing SHA-256 of the login instead of
  the login looks like a fix and is not one here: the candidate set is the public cohort repository,
  about 65 known GitHub logins. Anyone can hash all of them in a second and recover the list
  exactly. Shipping that would have bought the appearance of protection and nothing else.
- **What did change.** `fetchOptOuts` had a real latent hole next to the documented one: it read a
  single 300-document page and dropped `nextPageToken`, so the 301st person to opt out would have
  been silently missing from the filter and would have reappeared on the landing page. It now
  follows every page and throws rather than returning a partial list, and `removeOptedOut` already
  turns a throw into "show nobody", which is the safe direction. That is fixed and unit-tested
  (`tests/unit/opt-out.test.ts`).
- **The condition that closes the original finding:** a service-account credential on the pre-index
  path, then `allow read: if request.auth != null`. Until then the list is public and this is the
  paragraph that says so.

## Open, and not claimed as done

1. **No scheduler for the sweep.** `briefs` and `introductions` are enforced only when somebody runs
   the command.
2. **No self-service deletion.** A participant asks Nik; there is no button. `/opt-out` removes them
   from the public surface but does not delete their account data.
3. **The readable tombstone list,** above.
4. **`pulse`, `tasks`, `recipes` and `comments` have no window at all.**
5. **Firebase Auth identities are not deleted** by the participant deletion path.
