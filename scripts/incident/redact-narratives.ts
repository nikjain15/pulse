/**
 * Incident tool: strip published narratives from the feed, leaving the facts. SH8.
 *
 * This is step 2 of the rollback in docs/RUNBOOK.md. Step 1 stops new bad sentences being
 * written; this removes the ones already on 64 people's screens. It does exactly what
 * `narrate()` does when it degrades, setting `narrative` to null, so the feed lands on the
 * product's own designed fallback rather than on an empty card or an error.
 *
 *   node scripts/incident/redact-narratives.ts --since 2026-08-02T09:00:00Z
 *   node scripts/incident/redact-narratives.ts --since 2026-08-02T09:00:00Z --apply
 *
 * Dry run by default. `--since` is required: a tool that can blank the entire history of
 * the feed by default is a bigger incident than the one it was reaching for.
 *
 * What it does NOT do: delete the events. The ship happened, the commits are real, and the
 * evidence line is API facts that cannot be wrong. Deleting the events would erase people's
 * work to fix Pulse's sentence.
 */
import { adminDb } from '../../lib/broker-admin.ts';

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : (argv[i + 1] ?? null);
};

const sinceRaw = flag('since');
const apply = argv.includes('--apply');
const actor = flag('actor');

if (!sinceRaw) {
  console.error('Usage: node scripts/incident/redact-narratives.ts --since <ISO timestamp> [--actor <uid>] [--apply]');
  console.error('--since is required. Blanking the whole feed by accident is a worse incident than the one you have.');
  process.exit(2);
}

const since = new Date(sinceRaw);
if (Number.isNaN(since.getTime())) {
  console.error(`--since is not a parseable timestamp: ${sinceRaw}`);
  process.exit(2);
}

const db = adminDb();
if (!db) {
  console.error('No Firestore credential. Set FIREBASE_SERVICE_ACCOUNT.');
  console.error('Without it, use the Firebase console: pulse collection, filter createdAt, clear the narrative field.');
  process.exit(2);
}

let query = db.collection('pulse').where('createdAt', '>=', since);
if (actor) query = query.where('actorUid', '==', actor);

const snap = await query.get();
const affected = snap.docs.filter((d) => d.get('narrative') !== null || d.get('proposedNarrative') !== null);

console.log(`${apply ? 'REDACTING' : 'DRY RUN'}: ${affected.length} of ${snap.size} events since ${since.toISOString()}`);
console.log('');
for (const doc of affected) {
  const text = (doc.get('narrative') ?? doc.get('proposedNarrative')) as string;
  console.log(`  ${doc.id}  ${doc.get('actorName')}: ${JSON.stringify(text).slice(0, 100)}`);
}

if (!apply) {
  console.log('\nRe-run with --apply to blank these. Facts and evidence are kept; only the sentence goes.');
  console.log('Copy the lines above into evals/guard-fixture.json before you clear them. See docs/RUNBOOK.md step 5.');
  process.exit(0);
}

// Batched, 400 at a time: Firestore caps a batch at 500 writes.
for (let i = 0; i < affected.length; i += 400) {
  const batch = db.batch();
  for (const doc of affected.slice(i, i + 400)) {
    batch.update(doc.ref, { narrative: null, proposedNarrative: null });
  }
  await batch.commit();
}

console.log(`\nRedacted ${affected.length} events. The feed is facts-only for that window.`);
console.log('Now do step 5: turn the sentences above into fixture rows, or the same prompt ships again.');
