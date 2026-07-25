/**
 * Narrative-guard injection eval — runs a labeled dataset through the REAL shipped guard
 * (`checkNarrative` in ../lib/sense.ts) and reports safety metrics.
 *
 * Safe by construction: `lib/sense.ts` is a pure module (no network, no Firestore, no model).
 * This harness imports it directly, touches no production data, and spends nothing.
 *
 * Run (Node >= 23.6 strips TypeScript natively):
 *   node evals/run-guard-eval.ts
 *
 * Two classes in the dataset:
 *   - must_block : an attacker-influenced narrative that MUST be rejected. Recall here must be 1.0.
 *   - must_allow : a legitimate self-narrative that SHOULD pass. Rejecting one is a false positive.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { checkNarrative } from '../lib/sense.ts';

type Member = { handle: string | null; displayName: string };
type Case = {
  id: string;
  class: 'must_block' | 'must_allow';
  note: string;
  narrative: string;
};
type Dataset = { actor: Member; otherMembers: Member[]; cases: Case[] };

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(resolve(here, 'dataset.json'), 'utf8')) as Dataset;

let blockTotal = 0;
let blockCaught = 0;
let allowTotal = 0;
let allowPassed = 0;
const failures: string[] = [];

for (const c of data.cases) {
  const result = checkNarrative(c.narrative, data.actor, data.otherMembers);
  const passed = result.ok;
  if (c.class === 'must_block') {
    blockTotal += 1;
    if (!passed) blockCaught += 1;
    else failures.push(`  ✗ [${c.id}] should BLOCK but passed — ${c.note}`);
  } else {
    allowTotal += 1;
    if (passed) allowPassed += 1;
    else failures.push(`  ✗ [${c.id}] should ALLOW but was rejected (${(result as { reason: string }).reason}) — ${c.note}`);
  }
}

const recall = blockTotal ? blockCaught / blockTotal : 1;
const fpRate = allowTotal ? (allowTotal - allowPassed) / allowTotal : 0;

console.log('\nNarrative-guard eval (checkNarrative)');
console.log('-------------------------------------');
console.log(`must_block recall     : ${(recall * 100).toFixed(1)}%  (${blockCaught}/${blockTotal} injections blocked)`);
console.log(`must_allow pass-rate  : ${(allowPassed / (allowTotal || 1) * 100).toFixed(1)}%  (${allowPassed}/${allowTotal} legit narratives kept)`);
console.log(`false-positive rate   : ${(fpRate * 100).toFixed(1)}%`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(f);
}

// The safety-critical invariant: no injection may pass. Non-zero exit fails CI.
if (recall < 1) {
  console.error('\nFAIL: at least one must_block case passed the guard.');
  process.exit(1);
}
console.log('\nPASS: every injection was blocked.\n');
