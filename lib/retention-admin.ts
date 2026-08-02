import type { Firestore, Query } from 'firebase-admin/firestore';
import { cutoffFor, RETENTION_POLICY, timedRules, type RetentionRule } from './retention';

/**
 * The half of the retention policy that touches data. SH9.
 *
 * Admin SDK, so **server-only and rule-exempt**, like `broker-admin`. That is what it takes
 * to delete a document a member cannot delete themselves: `firestore.rules` denies
 * `members` delete outright, and denies any client write to `cohortMembers`, `introductions`
 * and `pulse` events they did not author. A deletion path that could run from a browser
 * would be a deletion path an attacker could aim at somebody else.
 *
 * Two operations:
 *   - `sweepRetention`, which applies the time windows in `lib/retention.ts`.
 *   - `deleteParticipantData`, which removes one person and reports exactly what it could not reach.
 *
 * Both default to **dry run**. A deletion tool whose default is "delete" is a tool that
 * eventually deletes the wrong thing at 2am. Ask for it explicitly.
 */

export type SweepOutcome = {
  collection: string;
  windowDays: number;
  cutoff: string;
  /** Documents older than the cutoff. Deleted when `dryRun` is false. */
  matched: number;
  deleted: number;
  /** Set when the collection could not be swept, with the reason. Never throws. */
  skipped?: string;
};

export type SweepReport = {
  dryRun: boolean;
  at: string;
  outcomes: SweepOutcome[];
  /** Rules with a window that this sweep does not implement, named rather than omitted. */
  notSwept: string[];
};

/** Collections the sweep can walk directly. Sub-collection rules are handled at their write path. */
const SWEEPABLE = new Set(['usageCalls', 'briefs/{uid}', 'introductions']);

/** Firestore caps a batch at 500 writes; stay under it with room for the commit itself. */
const BATCH = 400;

/** Delete every document a query returns, in batches. Returns the count. */
async function deleteQuery(db: Firestore, query: Query): Promise<number> {
  let total = 0;
  for (;;) {
    const snap = await query.limit(BATCH).get();
    if (snap.empty) return total;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    total += snap.size;
    if (snap.size < BATCH) return total;
  }
}

/**
 * Apply every time-windowed rule this sweep implements.
 *
 * `briefs` is keyed by uid, one document per member, so it is swept by its `updatedAt`
 * field rather than by age of creation: a brief regenerated yesterday is current no matter
 * when the member joined.
 */
export async function sweepRetention(
  db: Firestore,
  { now = new Date(), dryRun = true }: { now?: Date; dryRun?: boolean } = {}
): Promise<SweepReport> {
  const outcomes: SweepOutcome[] = [];
  const notSwept: string[] = [];

  for (const rule of timedRules()) {
    if (!SWEEPABLE.has(rule.collection)) {
      notSwept.push(`${rule.collection} (enforced at its write path, not by this sweep)`);
      continue;
    }
    const cutoff = cutoffFor(rule, now)!;
    const path = rule.collection.replace('/{uid}', '');
    const outcome: SweepOutcome = {
      collection: rule.collection,
      windowDays: rule.windowDays!,
      cutoff: cutoff.toISOString(),
      matched: 0,
      deleted: 0,
    };

    try {
      const query = db.collection(path).where(rule.basis!, '<', cutoff);
      outcome.matched = (await query.count().get()).data().count;
      if (!dryRun && outcome.matched > 0) outcome.deleted = await deleteQuery(db, query);
    } catch (err) {
      // A missing index or an empty collection must not abort the whole sweep, and must
      // not be reported as a clean pass either.
      outcome.skipped = err instanceof Error ? err.message : String(err);
    }
    outcomes.push(outcome);
  }

  return { dryRun, at: now.toISOString(), outcomes, notSwept };
}

// --- participant deletion ---------------------------------------------------------------

export type DeletionReport = {
  dryRun: boolean;
  uid: string;
  handle: string | null;
  /** Collection -> number of documents deleted (or that would be). */
  deleted: Record<string, number>;
  /** Documents edited rather than removed, with what was stripped. */
  redacted: Record<string, number>;
  /** Everything this path deliberately or necessarily leaves behind. Always populated. */
  cannotReach: string[];
  errors: string[];
};

/**
 * Everything a participant deletion CANNOT remove.
 *
 * This list is returned with every run, including dry runs, because a deletion report that
 * only lists successes teaches the reader that deletion is total. It is not, and the
 * difference is the part a participant actually needs to hear.
 */
export const DELETION_LIMITS: readonly string[] = [
  'GitHub itself. Every commit, PR title and branch name Pulse read stays on github.com, under the participant\'s own account. Pulse never had the authority to delete it and never will.',
  'The public cohort repository. It is the source the pre-index reads. A deleted cohortMembers document is rebuilt from it on the next render, which is why this path also writes an optOuts tombstone.',
  'The optOuts tombstone itself, deliberately. It is retained forever, holds only a handle and a date, and deleting it would un-hide the person it protects.',
  'Shared tasks. Cards the participant created or was assigned survive, unassigned and with their sensed evidence stripped. Deleting them would punch holes in other people\'s boards.',
  'Anthropic-side logs of the prompts and completions from narration and Ask Pulse. Retention there is governed by Anthropic\'s policy, not by this repository.',
  'Hosting request logs at Vercel, and any Firestore point-in-time backup or export taken before deletion ran.',
  'Anything a cohort member already read, screenshotted, or copied out of the feed.',
  'Cross-app shared context is handled separately by forgetShared (lib/shared-context.ts); this path does not call it, and it must be run alongside.',
];

async function deleteAll(db: Firestore, query: Query, dryRun: boolean): Promise<number> {
  const count = (await query.count().get()).data().count;
  if (dryRun || count === 0) return count;
  return deleteQuery(db, query);
}

/**
 * Delete one participant's data, keyed by Firebase Auth uid and (where known) GitHub handle.
 *
 * Order matters. `members/{uid}` goes LAST, so a run that dies half way through leaves the
 * subject findable and the job re-runnable rather than leaving orphans nobody can identify.
 *
 * Idempotent: running it twice is not an error, it is somebody who wanted to be sure.
 */
export async function deleteParticipantData(
  db: Firestore,
  {
    uid,
    handle = null,
    dryRun = true,
    tombstone = true,
  }: { uid: string; handle?: string | null; dryRun?: boolean; tombstone?: boolean }
): Promise<DeletionReport> {
  const report: DeletionReport = {
    dryRun,
    uid,
    handle,
    deleted: {},
    redacted: {},
    cannotReach: [...DELETION_LIMITS],
    errors: [],
  };

  const step = async (label: string, fn: () => Promise<number>) => {
    try {
      report.deleted[label] = await fn();
    } catch (err) {
      report.errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // 1. The member's own private documents, keyed by uid.
  await step('askThreads/{uid}/turns', () =>
    deleteAll(db, db.collection('askThreads').doc(uid).collection('turns'), dryRun)
  );
  for (const c of ['briefs', 'boardViews', 'githubLinks'] as const) {
    await step(`${c}/{uid}`, async () => {
      const ref = db.collection(c).doc(uid);
      if (!(await ref.get()).exists) return 0;
      if (!dryRun) await ref.delete();
      return 1;
    });
  }

  // 2. Content the member authored, and content written ABOUT them.
  await step('comments', () => deleteAll(db, db.collection('comments').where('authorUid', '==', uid), dryRun));
  await step('recipes', () => deleteAll(db, db.collection('recipes').where('authorUid', '==', uid), dryRun));
  await step('pulse (as actor)', () => deleteAll(db, db.collection('pulse').where('actorUid', '==', uid), dryRun));
  await step('pulse (as named other)', () =>
    deleteAll(db, db.collection('pulse').where('otherUid', '==', uid), dryRun)
  );
  // Both sides of an introduction. It names a person who was struggling; leaving the
  // helper's copy behind would leave the sentence intact and only remove the index.
  await step('introductions (as subject)', () =>
    deleteAll(db, db.collection('introductions').where('stuckUid', '==', uid), dryRun)
  );
  await step('introductions (as helper)', () =>
    deleteAll(db, db.collection('introductions').where('helperUid', '==', uid), dryRun)
  );

  // 3. Membership in other people's documents. The uid appears in recipe credit arrays and
  //    in feed kudos; both are lists of who did what, so the uid comes out and the document
  //    stays. Counted as redaction, never as deletion.
  await step('cohortMembers/{handle}', async () => {
    if (!handle) return 0;
    const ref = db.collection('cohortMembers').doc(handle.toLowerCase());
    if (!(await ref.get()).exists) return 0;
    if (!dryRun) await ref.delete();
    return 1;
  });

  const redactArrayMembership = async (
    label: string,
    collection: string,
    fields: string[]
  ): Promise<void> => {
    try {
      let touched = 0;
      for (const field of fields) {
        const snap = await db.collection(collection).where(field, 'array-contains', uid).get();
        for (const doc of snap.docs) {
          const list = (doc.get(field) as string[]) ?? [];
          if (!dryRun) await doc.ref.update({ [field]: list.filter((v) => v !== uid) });
          touched++;
        }
      }
      report.redacted[label] = (report.redacted[label] ?? 0) + touched;
    } catch (err) {
      report.errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  await redactArrayMembership('recipes (credit lists)', 'recipes', ['unstuckUids', 'publicThanksUids']);
  await redactArrayMembership('pulse (kudos)', 'pulse', ['kudos']);

  // 4. Shared tasks: unassign and strip the sensed evidence, do not delete. The card is
  //    somebody else's board too. `evidence` is the field that ties a card to a person's
  //    commits, PR numbers and filenames, so that is the field that goes.
  try {
    let touched = 0;
    for (const field of ['assigneeUid', 'creatorUid']) {
      const snap = await db.collection('tasks').where(field, '==', uid).get();
      for (const doc of snap.docs) {
        const patch: Record<string, unknown> = { evidence: null, branch: null };
        if (field === 'assigneeUid') patch.assigneeUid = null;
        if (!dryRun) await doc.ref.update(patch);
        touched++;
      }
    }
    report.redacted['tasks (unassigned, evidence stripped)'] = touched;
  } catch (err) {
    report.errors.push(`tasks: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 5. The tombstone. Without it the pre-index rebuilds this person from the public repo on
  //    the next render and the deletion undoes itself within fifteen minutes.
  if (tombstone && handle) {
    await step('optOuts/{handle} (created, not deleted)', async () => {
      const ref = db.collection('optOuts').doc(handle.toLowerCase());
      if ((await ref.get()).exists) return 0;
      if (!dryRun) await ref.set({ handle: handle.toLowerCase(), createdAt: new Date() });
      return 1;
    });
  } else if (!handle) {
    report.cannotReach.push(
      'No GitHub handle was supplied, so no optOuts tombstone was written. The pre-index will rebuild this person from the public repo. Re-run with the handle.'
    );
  }

  // 6. The account document, last.
  await step('members/{uid}', async () => {
    const ref = db.collection('members').doc(uid);
    if (!(await ref.get()).exists) return 0;
    if (!dryRun) await ref.delete();
    return 1;
  });

  return report;
}

/** Every collection the policy names, for the doc generator and the tests. */
export function policyCollections(): string[] {
  return RETENTION_POLICY.map((r: RetentionRule) => r.collection);
}
