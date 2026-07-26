/**
 * Groundedness eval — EVALS.md §5. Does a published narrative trace to the actual commit/PR
 * evidence, or did the model invent work?
 *
 * Two scorers, one dataset (`groundedness-dataset.json`, labels are ground truth):
 *   - Deterministic (`scoreGroundedness`) — the CI backbone. Pure, offline, no spend. Every
 *     labeled case must be classified correctly; a single miss exits non-zero and fails CI.
 *   - LLM judge (`judgeGroundedness`) — the richer judge scoped in EVALS.md §5. Runs only
 *     when ANTHROPIC_API_KEY is set. Reported as agreement against the labels; it never
 *     fails the run (a flaky judge is a judge problem, not a regression).
 *
 * Run (Node >= 23.6 strips TypeScript natively):
 *   node evals/run-groundedness-eval.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { scoreGroundedness, judgeGroundedness } from '../lib/groundedness.ts';
import type { Evidence } from '../lib/types.ts';

type Case = {
  id: string;
  grounded: boolean;
  narrative: string;
  evidence: Evidence;
  material: string[];
};
type Dataset = { note: string; cases: Case[] };

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(
  readFileSync(resolve(here, 'groundedness-dataset.json'), 'utf8')
) as Dataset;

let correct = 0;
let ungroundedTotal = 0;
let ungroundedCaught = 0;
let groundedTotal = 0;
let groundedKept = 0;
const failures: string[] = [];

for (const c of data.cases) {
  const { grounded } = scoreGroundedness(c.narrative, c.evidence, c.material);
  const ok = grounded === c.grounded;
  if (ok) correct += 1;

  if (c.grounded) {
    groundedTotal += 1;
    if (grounded) groundedKept += 1;
    else failures.push(`  ✗ [${c.id}] grounded narrative flagged as ungrounded`);
  } else {
    ungroundedTotal += 1;
    if (!grounded) ungroundedCaught += 1;
    else failures.push(`  ✗ [${c.id}] invented claim slipped through as grounded`);
  }
}

const accuracy = data.cases.length ? correct / data.cases.length : 1;
const recall = ungroundedTotal ? ungroundedCaught / ungroundedTotal : 1;
const falseFlag = groundedTotal ? (groundedTotal - groundedKept) / groundedTotal : 0;

console.log('\nGroundedness eval (scoreGroundedness)');
console.log('-------------------------------------');
console.log(`accuracy vs labels    : ${(accuracy * 100).toFixed(1)}%  (${correct}/${data.cases.length})`);
console.log(`ungrounded catch-rate : ${(recall * 100).toFixed(1)}%  (${ungroundedCaught}/${ungroundedTotal} inventions caught)`);
console.log(`false-flag rate       : ${(falseFlag * 100).toFixed(1)}%  (grounded narratives wrongly flagged)`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(f);
}

// Optional LLM-judge pass — richer, but only where a key exists. Best-effort, never fails CI.
if (process.env.ANTHROPIC_API_KEY) {
  let judged = 0;
  let agreed = 0;
  for (const c of data.cases) {
    const verdict = await judgeGroundedness(c.narrative, c.evidence, c.material);
    if (!verdict) continue;
    judged += 1;
    if (verdict.grounded === c.grounded) agreed += 1;
  }
  if (judged) {
    console.log('\nLLM judge (judgeGroundedness)');
    console.log('-----------------------------');
    console.log(`agreement vs labels   : ${((agreed / judged) * 100).toFixed(1)}%  (${agreed}/${judged})`);
  }
} else {
  console.log('\n(LLM judge skipped: set ANTHROPIC_API_KEY to run judgeGroundedness too.)');
}

// The invariant: the deterministic scorer must reproduce every label. A miss is a regression.
if (accuracy < 1) {
  console.error('\nFAIL: the deterministic groundedness scorer misclassified a labeled case.');
  process.exit(1);
}
console.log('\nPASS: every labeled case classified correctly.\n');
