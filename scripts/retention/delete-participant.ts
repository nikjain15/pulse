/**
 * Delete one participant's data. SH9.
 *
 * The thing Pulse did not have: somebody asks to be removed, and there is an answer that is
 * not "we filter you out of the landing page".
 *
 *   node scripts/retention/delete-participant.ts --uid <uid> --handle <github-login>
 *   node scripts/retention/delete-participant.ts --uid <uid> --handle <login> --apply
 *
 * Dry run by default, and it prints the same report either way, including everything the
 * deletion CANNOT reach. Read that section out to the participant before they decide,
 * because "we deleted everything" is not true and they deserve the accurate version.
 *
 * Supply the handle. Without it the cohortMembers document is missed and no opt-out
 * tombstone is written, which means the pre-index rebuilds this person from the PUBLIC
 * cohort repository on the next render and the deletion silently undoes itself.
 */
import { adminDb } from '../../lib/broker-admin.ts';
import { deleteParticipantData } from '../../lib/retention-admin.ts';

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : (argv[i + 1] ?? null);
};

const uid = flag('uid');
const handle = flag('handle');
const apply = argv.includes('--apply');

if (!uid) {
  console.error('Usage: node scripts/retention/delete-participant.ts --uid <uid> [--handle <login>] [--apply]');
  process.exit(2);
}

const db = adminDb();
if (!db) {
  console.error('No Firestore credential. Set FIREBASE_SERVICE_ACCOUNT, or FIRESTORE_EMULATOR_HOST for a local run.');
  process.exit(2);
}

if (!handle) {
  console.warn('WARNING: no --handle supplied. The cohortMembers document will be missed and no opt-out');
  console.warn('tombstone will be written, so the pre-index will rebuild this person from the public repo.');
}

const report = await deleteParticipantData(db, { uid, handle, dryRun: !apply });

console.log(`Participant deletion ${report.dryRun ? '(DRY RUN, nothing changed)' : '(APPLYING)'}`);
console.log(`uid=${report.uid} handle=${report.handle ?? 'unknown'}`);
console.log('');

const verb = report.dryRun ? 'would remove' : 'removed';
console.log(`Documents ${verb}:`);
for (const [k, v] of Object.entries(report.deleted)) console.log(`  ${k.padEnd(42)} ${v}`);

console.log(`\nDocuments ${report.dryRun ? 'that would be edited' : 'edited'} rather than removed:`);
for (const [k, v] of Object.entries(report.redacted)) console.log(`  ${k.padEnd(42)} ${v}`);

console.log('\nWhat this does NOT reach. Say this out loud to the participant:');
report.cannotReach.forEach((l) => console.log(`  - ${l}`));

if (report.errors.length) {
  console.error('\nErrors (the run is resumable, it is idempotent):');
  report.errors.forEach((e) => console.error(`  - ${e}`));
}

console.log(report.dryRun ? '\nRe-run with --apply to perform the deletion.' : '\nDone.');
process.exit(report.errors.length ? 1 : 0);
