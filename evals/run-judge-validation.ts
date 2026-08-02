/**
 * Judge validation. EVALS.md §5. Does `judgeGroundedness` mark correctly?
 *
 * This is the number that has to exist before any groundedness score the judge
 * produces can be read at all. `run-groundedness-eval.ts` scores narratives.
 * This scores the SCORER.
 *
 * It validates the SHIPPED judge. It imports `judgeGroundedness` from
 * `lib/groundedness.ts`, the same function `run-groundedness-eval.ts` calls, and
 * selects the model the only way the shipped module allows, through
 * `ANTHROPIC_MODEL`. Nothing here reimplements the prompt or the parsing, so a
 * passing number is evidence about the judge Pulse actually runs rather than
 * about a copy written to be measured.
 *
 * WHAT IT DOES NOT DO. It does not grade a second dimension. Conduit's
 * equivalent grades faithfulness and relevance separately because its judge
 * makes two separate claims. Pulse's judge returns one binary verdict,
 * `grounded`, so there is one dimension. Inventing a second would mean measuring
 * something Pulse does not ship.
 *
 * Run:
 *   ANTHROPIC_API_KEY=… node evals/run-judge-validation.ts
 *   ANTHROPIC_API_KEY=… ANTHROPIC_MODEL=claude-haiku-4-5-20251001 node evals/run-judge-validation.ts
 *
 * Writes evals/judge-validation-results.json so the numbers in EVALS.md have a
 * dated artifact behind them rather than a remembered figure.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { judgeGroundedness } from '../lib/groundedness.ts';
import type { Evidence } from '../lib/types.ts';
import {
  agreementStats,
  classBalanceProblems,
  enforcedFailures,
  kappaBand,
  type Comparison,
  type EnforcedPair,
  type ModelReport,
  type ValidationResults,
} from './judge-metrics.ts';

type Case = {
  id: string;
  band: string;
  grounded: boolean;
  narrative: string;
  evidence: Evidence;
  material: string[];
  why: string;
};
type Dataset = { version: string; note: string; cases: Case[] };

/**
 * The kappa an enforced judge must clear. 0.6 is the conventional production
 * floor and the same one Conduit uses; it is the bottom of Landis and Koch's
 * "substantial" band.
 *
 * Set BELOW what was measured, in the same commit as the run that justifies it,
 * never above. If no run has justified a floor yet, nothing is enforced, which
 * is the state this file ships in until the first keyed run happens.
 */
const KAPPA_FLOOR = 0.6;

/**
 * The (model, dimension) pairs Pulse CLAIMS are validated.
 *
 * Empty on the first commit, deliberately. A pair goes in here only after a
 * recorded run shows it clearing the floor, and adding one is a claim that the
 * measurement backs it. A pair that is absent is not exempt, it is UNVALIDATED,
 * and an unvalidated judge must not be described anywhere as a quality gate.
 */
const ENFORCED: EnforcedPair[] = [];

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(
  readFileSync(resolve(here, 'judge-validation-dataset.json'), 'utf8')
) as Dataset;

// The set must be usable before anything is measured on it. A skewed set makes
// an always-one-answer judge look competent and makes kappa unstable, so this
// refuses to run rather than producing a number nobody should read.
const balance = classBalanceProblems(data.cases.map((c) => c.grounded));
if (balance.length) {
  console.error('FAIL: the validation set is not usable.');
  for (const b of balance) console.error(`  - ${b}`);
  process.exit(1);
}

const model = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8';

if (!process.env.ANTHROPIC_API_KEY) {
  console.log('\nJudge validation');
  console.log('----------------');
  console.log('SKIPPED: no ANTHROPIC_API_KEY set, so the judge cannot be called.');
  console.log(`The set itself is valid: ${data.cases.length} cases, class balance checked.`);
  console.log('The arithmetic is covered offline by tests/unit/judge-metrics.test.ts.');
  console.log('\nThis is a skip, not a pass. Nothing about the judge has been measured here.\n');
  process.exit(0);
}

const comparisons: Comparison[] = [];
const disagreements: string[] = [];
let unscored = 0;

for (const c of data.cases) {
  const verdict = await judgeGroundedness(c.narrative, c.evidence, c.material);
  if (!verdict) {
    // judgeGroundedness returns null on a refusal, an unparseable reply or a
    // transport failure. Counting that as either answer would be inventing a
    // verdict, so it is excluded and reported.
    unscored += 1;
    disagreements.push(`  ? [${c.id}] (${c.band}) judge returned no usable verdict`);
    continue;
  }
  comparisons.push({ gold: c.grounded, judge: verdict.grounded });
  if (verdict.grounded !== c.grounded) {
    const direction = c.grounded
      ? 'flagged an honest narrative'
      : 'PASSED AN INVENTED CLAIM';
    disagreements.push(`  x [${c.id}] (${c.band}) ${direction}: ${verdict.reason.slice(0, 120)}`);
  }
}

const stats = agreementStats(comparisons);
const report: ModelReport = { model, groundedness: stats };

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

console.log('\nJudge validation — judgeGroundedness');
console.log('------------------------------------');
console.log(`model                 : ${model}`);
console.log(`cases scored          : ${stats.n} of ${data.cases.length}${unscored ? ` (${unscored} unscored)` : ''}`);
console.log(`raw agreement         : ${pct(stats.agreement)}`);
console.log(`always-grounded judge : ${pct(stats.baseRate)}   <- the number above must beat this`);
console.log(`Cohen's kappa         : ${stats.kappa.toFixed(3)}   (${kappaBand(stats.kappa)}, floor ${KAPPA_FLOOR})`);
console.log(`kept honest narratives: ${pct(stats.trueGroundedRate)}   (${stats.tp}/${stats.tp + stats.fn})`);
console.log(`caught inventions     : ${pct(stats.trueUngroundedRate)}   (${stats.tn}/${stats.tn + stats.fp})`);
console.log(`confusion             : tp ${stats.tp}  fn ${stats.fn}  fp ${stats.fp}  tn ${stats.tn}`);

if (disagreements.length) {
  console.log('\nWhere it disagreed with the labels:');
  for (const d of disagreements) console.log(d);
}

// fp is the cell that publishes fiction to 64 people. Called out separately so
// it cannot be averaged away into a single agreement number.
if (stats.fp > 0) {
  console.log(
    `\nNOTE: ${stats.fp} invented narrative(s) were passed as grounded. ` +
      'That is the failure direction that reaches readers.'
  );
}

const results: ValidationResults = {
  ran: new Date().toISOString().slice(0, 10),
  datasetVersion: data.version,
  cases: stats.n,
  reports: [report],
  kappaFloor: KAPPA_FLOOR,
  enforced: ENFORCED,
  notes:
    'Labels are decidable from the evidence, not opinion. Set is class balanced ' +
    '12/12, so an always-grounded judge scores 50% raw agreement and kappa 0. ' +
    'Band U-SCOPE is invisible to the deterministic scorer by construction.',
};
writeFileSync(
  resolve(here, 'judge-validation-results.json'),
  `${JSON.stringify(results, null, 2)}\n`
);

const failures = enforcedFailures(results);
if (failures.length) {
  console.error('\nFAIL: a judge this repo claims is validated does not clear the floor.');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

if (ENFORCED.length === 0) {
  console.log(
    `\nNothing is enforced yet: ENFORCED is empty, so this run RECORDS a number ` +
      `without gating on it.\nTo enforce ${model}, add it to ENFORCED in this file, ` +
      `in the same commit as a run that clears ${KAPPA_FLOOR}.\n`
  );
} else {
  console.log('\nPASS: every judge this repo claims is validated clears the floor.\n');
}
