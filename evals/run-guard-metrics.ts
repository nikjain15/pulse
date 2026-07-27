/**
 * Named-metric eval for the narrative publish guard.
 *
 * Runs a labeled fixture (`guard-fixture.json`) through the REAL shipped guard
 * (`checkNarrative` in ../lib/sense.ts) and reports named precision, recall, F1, and accuracy for
 * the BLOCK decision (positive class = blocked). The same computation is CI-gated in
 * `tests/unit/eval-metrics.test.ts` with floors just below the measured values; this runner is the
 * human-readable view and the source of the numbers reported in `docs/EVALS.md`.
 *
 * Safe by construction: `lib/sense.ts` is a pure module (no network, no Firestore, no model). This
 * harness imports it directly, touches no production data, and spends nothing. Handles in the
 * fixture are neutral invented fixtures, not production members.
 *
 * Run (Node >= 23.6 strips TypeScript natively):
 *   node evals/run-guard-metrics.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { checkNarrative } from '../lib/sense.ts';
import { classificationMetrics, type Prediction } from '../lib/eval-metrics.ts';

type Member = { handle: string | null; displayName: string };
type Row = {
  id: string;
  category: string;
  narrative: string;
  authorHandle: string;
  otherMembers: Member[];
  expectedBlocked: boolean;
  note: string;
};
type Fixture = { actor: Member; otherMembers: Member[]; rows: Row[] };

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(resolve(here, 'guard-fixture.json'), 'utf8')) as Fixture;

const predictions: Prediction[] = [];
const disagreements: string[] = [];

for (const row of fixture.rows) {
  const actor = { handle: row.authorHandle, displayName: fixture.actor.displayName };
  const result = checkNarrative(row.narrative, actor, row.otherMembers);
  const predictedBlocked = !result.ok;
  predictions.push({ expectedBlocked: row.expectedBlocked, predictedBlocked });
  if (predictedBlocked !== row.expectedBlocked) {
    disagreements.push(
      `  [${row.id}] label=${row.expectedBlocked ? 'block' : 'allow'} guard=${predictedBlocked ? 'block' : 'allow'}: ${row.note}`,
    );
  }
}

const m = classificationMetrics(predictions);
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

console.log('\nNarrative-guard named-metric eval (checkNarrative over guard-fixture.json)');
console.log('-------------------------------------------------------------------------');
console.log(`rows            : ${m.support}  (block=${m.matrix.truePositives + m.matrix.falseNegatives}, allow=${m.matrix.falsePositives + m.matrix.trueNegatives})`);
console.log(`confusion matrix: TP=${m.matrix.truePositives} FP=${m.matrix.falsePositives} FN=${m.matrix.falseNegatives} TN=${m.matrix.trueNegatives}`);
console.log(`precision (block): ${pct(m.precision)}`);
console.log(`recall    (block): ${pct(m.recall)}`);
console.log(`F1        (block): ${pct(m.f1)}`);
console.log(`accuracy         : ${pct(m.accuracy)}`);

if (disagreements.length) {
  console.log('\nGuard/label disagreements:');
  for (const d of disagreements) console.log(d);
} else {
  console.log('\nEvery fixture label reproduced by the real guard.');
}

// The safety-critical invariant mirrors the deterministic guard eval: no must-block row may pass.
if (m.matrix.falseNegatives > 0) {
  console.error('\nFAIL: at least one expectedBlocked row was allowed by the guard.');
  process.exit(1);
}
console.log('\nPASS.\n');
