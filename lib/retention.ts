/**
 * Retention policy. SH9.
 *
 * The gap this closes, stated plainly: Pulse had **no written retention window anywhere**
 * and no deletion path. `usageCalls` rows accumulated forever, `askThreads` turns
 * accumulated forever, and the only thing resembling erasure was `forgetShared`, which
 * covers the cross-app context bus and nothing else.
 *
 * This module is the policy, as data rather than as prose, and it is **pure**: no
 * Firestore import, no clock of its own, no I/O. That is what lets it be unit-tested, and lets the
 * enforcement code and the documentation read from the same source. `lib/retention-admin.ts`
 * is what acts on it; `docs/RETENTION.md` is generated reading from it.
 *
 * A window written in a document nobody executes is not a retention policy, it is a wish.
 * Every rule below carries `enforcedBy`, and the value `'none'` is a legitimate answer that
 * says out loud that this particular class is only documented. Read those honestly: they
 * are the parts of the policy that are still just prose.
 */

/** How a rule is actually applied, in this repository, today. */
export type Enforcement =
  /** Trimmed by `scripts/retention/sweep.ts` against `lib/retention-admin.ts`. Needs the Admin SDK. */
  | 'sweep'
  /** Trimmed inline by the code that writes the collection. Runs on every deployment, credential or not. */
  | 'write-path'
  /** Bounded by construction: the document holds a fixed number of fields and cannot grow. */
  | 'bounded-by-shape'
  /** Written down and not enforced by any code. Say so rather than implying otherwise. */
  | 'none';

export type RetentionRule = {
  /** Firestore collection path, with `{uid}` / `{handle}` where the id is the subject's key. */
  collection: string;
  /** What is in it, in one line. */
  what: string;
  /**
   * Days after `basis` at which a document is eligible for deletion. `null` means the data
   * is kept for as long as the account exists, and leaves with the account. The deletion
   * path, not the clock, is what removes it.
   */
  windowDays: number | null;
  /** The timestamp field the window is measured from. Null when `windowDays` is null. */
  basis: string | null;
  enforcedBy: Enforcement;
  /** Removed by `deleteParticipantData`? Some classes deliberately survive; see `note`. */
  removedByParticipantDeletion: boolean;
  /** Why this window, and what it costs. The honest half. */
  note: string;
};

/**
 * The policy.
 *
 * Windows are short on purpose. Pulse is a 10-week cohort pilot for 65 people; there is no
 * business reason to hold a year of anything, and every extra month is a month of exposure
 * bought for nothing.
 */
export const RETENTION_POLICY: readonly RetentionRule[] = [
  {
    collection: 'usageCalls',
    what: 'One audit row per model call: model, kind, token counts, cost in micros.',
    windowDays: 90,
    basis: 'at',
    enforcedBy: 'write-path',
    removedByParticipantDeletion: false,
    note:
      'The rows carry no member, handle, narrative or prompt text, so they are not personal data. ' +
      'The window exists because an unbounded append-only collection is a cost and a liability ' +
      'with no owner. 90 days is one pilot plus a quarter of hindsight. Enforced inline in ' +
      'lib/usage-admin.ts on write, so it runs wherever the counter runs, and again by the sweep.',
  },
  {
    collection: 'usage/totals',
    what: 'Aggregate spend counters.',
    windowDays: null,
    basis: null,
    enforcedBy: 'bounded-by-shape',
    removedByParticipantDeletion: false,
    note: 'A single document of counters. It cannot grow and identifies nobody, so it is kept.',
  },
  {
    collection: 'askThreads/{uid}/turns',
    what: "The Ask Pulse transcript: a member's own commands and Pulse's replies about their own board.",
    windowDays: 30,
    basis: 'createdAt',
    enforcedBy: 'write-path',
    removedByParticipantDeletion: true,
    note:
      'The most quietly sensitive collection a member creates themselves: it quotes their board ' +
      'and their questions. The panel only ever reads the newest 50 turns (THREAD_LIMIT), so ' +
      'anything older than a month is already invisible and was being kept for nobody. Trimmed ' +
      'client-side on append, which is the only place with the credential to do it.',
  },
  {
    collection: 'briefs/{uid}',
    what: 'Cached model-written Home brief.',
    windowDays: 30,
    basis: 'updatedAt',
    enforcedBy: 'sweep',
    removedByParticipantDeletion: true,
    note:
      'Purely a cache; losing it costs one regeneration and never correctness. It is model-written ' +
      'prose about a named person, so it should not outlive its usefulness by months.',
  },
  {
    collection: 'boardViews/{uid}',
    what: "A member's private lane layout.",
    windowDays: null,
    basis: null,
    enforcedBy: 'bounded-by-shape',
    removedByParticipantDeletion: true,
    note: 'A preference document, one per member, bounded by their own board. Leaves with the account.',
  },
  {
    collection: 'introductions',
    what: '"Marcus is stuck on what you solved", the most sensitive document in the product.',
    windowDays: 60,
    basis: 'createdAt',
    enforcedBy: 'sweep',
    removedByParticipantDeletion: true,
    note:
      'It names someone who was struggling. An offer to help is useful for days and embarrassing ' +
      'for years, so it gets the shortest window of any content class that is not a cache. ' +
      'Deleted for BOTH parties: the stuck person and the helper.',
  },
  {
    collection: 'pulse',
    what: 'The cohort feed: what shipped, plus any published narrative.',
    windowDays: null,
    basis: null,
    enforcedBy: 'none',
    removedByParticipantDeletion: true,
    note:
      'No time window, and that is a deliberate product decision rather than an oversight: the feed ' +
      'IS the cohort memory, and a feed that erases itself after N days erases the record of what ' +
      'people built. It is bounded by the pilot, not by a clock. Every event a member acted in is ' +
      'removed when they ask for deletion, including any narrative written about them.',
  },
  {
    collection: 'tasks',
    what: 'Shared cohort work, some of it created by Pulse from branch names.',
    windowDays: null,
    basis: null,
    enforcedBy: 'none',
    removedByParticipantDeletion: false,
    note:
      'Shared work, and the one class where deletion is NOT total. Tasks a departing member created ' +
      'or was assigned survive, because a project board with holes in it damages people who did not ' +
      'ask for anything. What deletion does instead is unassign them and strip the sensed evidence ' +
      '(commit counts, PR numbers, filenames) that ties the card to a person. Say this to a ' +
      'participant before they ask, not after.',
  },
  {
    collection: 'recipes',
    what: 'Author-written solutions banked for the cohort.',
    windowDays: null,
    basis: null,
    enforcedBy: 'none',
    removedByParticipantDeletion: true,
    note:
      'A recipe is the author\'s own words, published deliberately. Their recipes go with them, and ' +
      'their uid is removed from every other recipe\'s unstuckUids and publicThanksUids lists.',
  },
  {
    collection: 'comments',
    what: 'Task comments.',
    windowDays: null,
    basis: null,
    enforcedBy: 'none',
    removedByParticipantDeletion: true,
    note: 'A member\'s own writing. Removed on deletion.',
  },
  {
    collection: 'cohortMembers/{handle}',
    what: 'Facts pre-indexed from the PUBLIC cohort repo, plus the narration consent flag.',
    windowDays: null,
    basis: null,
    enforcedBy: 'none',
    removedByParticipantDeletion: true,
    note:
      'Deleted on request, and it will come BACK on the next pre-index run unless the handle is also ' +
      'tombstoned in optOuts, because the source is a public GitHub repository Pulse does not own. ' +
      'This is the clearest example of a limit deletion cannot cross, and the deletion path ' +
      'tombstones the handle for exactly this reason.',
  },
  {
    collection: 'githubLinks/{uid}',
    what: 'Connection state, consent flags, and the narrated-work cache keys.',
    windowDays: null,
    basis: null,
    enforcedBy: 'bounded-by-shape',
    removedByParticipantDeletion: true,
    note:
      'Bounded by the member\'s own shipped PR count (narratedWorkKeys). It is the consent record, so ' +
      'it must live exactly as long as the account and not one day longer.',
  },
  {
    collection: 'members/{uid}',
    what: 'Email, display name, photo URL, GitHub handle.',
    windowDays: null,
    basis: null,
    enforcedBy: 'bounded-by-shape',
    removedByParticipantDeletion: true,
    note: 'The account itself. Deleted last, so a failure part-way through leaves a findable subject.',
  },
  {
    collection: 'optOuts/{handle}',
    what: 'The tombstone: a handle that must never be shown.',
    windowDays: null,
    basis: null,
    enforcedBy: 'none',
    removedByParticipantDeletion: false,
    note:
      'PERMANENT ON PURPOSE, and the one place where "we deleted everything" would be the harmful ' +
      'answer. Deleting a tombstone un-hides the person it protects, because the pre-index rebuilds ' +
      'them from the public repo on the next render. It is the only record Pulse keeps about someone ' +
      'who asked to be gone, it holds nothing but a handle and a date, and it is retained forever.',
  },
];

export const MS_PER_DAY = 86_400_000;

export function ruleFor(collection: string): RetentionRule | undefined {
  return RETENTION_POLICY.find((r) => r.collection === collection);
}

/** Rules with an actual time window, i.e. the ones a sweep can act on. */
export function timedRules(): RetentionRule[] {
  return RETENTION_POLICY.filter((r) => r.windowDays !== null);
}

/**
 * The instant before which documents under this rule are eligible for deletion.
 * Null for rules with no time window.
 */
export function cutoffFor(rule: RetentionRule, now: Date = new Date()): Date | null {
  if (rule.windowDays === null) return null;
  return new Date(now.getTime() - rule.windowDays * MS_PER_DAY);
}

/** Is a document written at `at` past this rule's window? False when the rule has no window. */
export function isExpired(rule: RetentionRule, at: Date, now: Date = new Date()): boolean {
  const cutoff = cutoffFor(rule, now);
  return cutoff !== null && at.getTime() < cutoff.getTime();
}

/**
 * The rules that are written down and NOT enforced by any code.
 *
 * Exported so the honesty is queryable rather than a claim: `docs/RETENTION.md` and the
 * unit tests both read this, so the doc cannot say "enforced" about something that is not.
 */
export function unenforcedRules(): RetentionRule[] {
  return RETENTION_POLICY.filter((r) => r.enforcedBy === 'none');
}
