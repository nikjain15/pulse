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
import { agreementStats, kappaBand, type Comparison } from './judge-metrics.ts';

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
//
// This block used to print one line, `agreement vs labels`, and that line could not be
// read. On a set that is half grounded, a judge answering "grounded" to everything scores
// 50%; on a skewed set it scores the skew. Raw agreement measures the dataset as much as
// the judge, and it cannot tell a judge that over-flags from one that publishes inventions.
// It now reports through `judge-metrics.ts`, next to the number it has to beat.
//
// This is still the SMALL set, and it is a spot check rather than the validation. The real
// measurement is `run-judge-validation.ts`, on a purpose-built class-balanced set that
// includes cases `scoreGroundedness` is blind to. See EVALS.md §5.
if (process.env.ANTHROPIC_API_KEY) {
  const comparisons: Comparison[] = [];
  for (const c of data.cases) {
    const verdict = await judgeGroundedness(c.narrative, c.evidence, c.material);
    if (!verdict) continue;
    comparisons.push({ gold: c.grounded, judge: verdict.grounded });
  }
  if (comparisons.length) {
    const s = agreementStats(comparisons);
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    console.log('\nLLM judge (judgeGroundedness)');
    console.log('-----------------------------');
    console.log(`raw agreement         : ${pct(s.agreement)}  (${s.tp + s.tn}/${s.n})`);
    console.log(`always-grounded judge : ${pct(s.baseRate)}   <- the number above must beat this`);
    console.log(`Cohen's kappa         : ${s.kappa.toFixed(3)}   (${kappaBand(s.kappa)})`);
    console.log(`kept honest narratives: ${pct(s.trueGroundedRate)}   (${s.tp}/${s.tp + s.fn})`);
    console.log(`caught inventions     : ${pct(s.trueUngroundedRate)}   (${s.tn}/${s.tn + s.fp})`);
    console.log('\n(Spot check only. The validation is `npm run eval:judge-validation`.)');
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
