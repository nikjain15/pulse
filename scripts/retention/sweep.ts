/**
 * Apply the retention windows in `lib/retention.ts`. SH9.
 *
 * Dry run by default. Deleting requires `--apply`, spelled out, because a retention job
 * whose default is "delete" is a job that eventually deletes the wrong thing at 2am.
 *
 *   node scripts/retention/sweep.ts              # report what would go
 *   node scripts/retention/sweep.ts --apply      # actually delete
 *   node scripts/retention/sweep.ts --now 2027-01-01   # pin the clock
 *
 * Needs a credential: FIREBASE_SERVICE_ACCOUNT, or FIRESTORE_EMULATOR_HOST for a local run
 * against the emulator. Without one it says so and exits non-zero rather than reporting a
 * clean sweep of nothing, which is the failure mode that makes a retention job worthless.
 *
 * There is no scheduler. Running this is a manual act today, and that is stated in
 * docs/RETENTION.md rather than implied away.
 */
import { adminDb } from '../../lib/broker-admin.ts';
import { sweepRetention } from '../../lib/retention-admin.ts';
import { RETENTION_POLICY, unenforcedRules } from '../../lib/retention.ts';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const nowFlag = argv[argv.indexOf('--now') + 1];
const now = argv.includes('--now') && nowFlag ? new Date(`${nowFlag}T12:00:00Z`) : new Date();

const db = adminDb();
if (!db) {
  console.error('No Firestore credential. Set FIREBASE_SERVICE_ACCOUNT, or FIRESTORE_EMULATOR_HOST for a local run.');
  console.error('Refusing to report a clean sweep it did not perform.');
  process.exit(2);
}

const report = await sweepRetention(db, { now, dryRun: !apply });

console.log(`Retention sweep ${report.dryRun ? '(DRY RUN, nothing deleted)' : '(APPLYING)'} at ${report.at}`);
console.log('');
for (const o of report.outcomes) {
  const verb = report.dryRun ? 'would delete' : 'deleted';
  const line = `  ${o.collection.padEnd(28)} window ${String(o.windowDays).padStart(3)}d  ${verb} ${o.matched}`;
  console.log(o.skipped ? `${line}  SKIPPED: ${o.skipped}` : line);
}

if (report.notSwept.length) {
  console.log('\nNot handled by this sweep:');
  report.notSwept.forEach((n) => console.log(`  - ${n}`));
}

const unenforced = unenforcedRules();
if (unenforced.length) {
  console.log('\nDocumented but enforced by no code at all, which is the honest status of these:');
  unenforced.forEach((r) => console.log(`  - ${r.collection}: ${r.what}`));
}

console.log(`\n${RETENTION_POLICY.length} data classes in the policy. Full text: docs/RETENTION.md`);
if (report.dryRun) console.log('Re-run with --apply to delete.');
