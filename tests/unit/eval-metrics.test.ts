import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  accuracy,
  classificationMetrics,
  confusionMatrix,
  f1Score,
  precision,
  recall,
  type ConfusionMatrix,
  type Prediction,
} from '@/lib/eval-metrics';
import { checkNarrative } from '@/lib/sense';

/**
 * Two things are proven here:
 *   1. The metric math is correct against a hand-built confusion matrix (no dependence on the guard).
 *   2. The REAL shipped guard, run over the labeled fixture, hits the named precision/recall/F1 the
 *      docs report. CI floors sit just below the measured values; recall on the block class is a hard
 *      1.0 (the safety invariant: no must-block narrative may pass).
 *
 * Offline and pure: `lib/sense.ts` and `lib/eval-metrics.ts` make no network, Firestore, or model
 * calls, so this runs with no key.
 */

describe('eval-metrics math (hand-built matrix)', () => {
  // A deliberately lopsided, fully worked example: TP=8, FP=2, FN=4, TN=6 (20 predictions).
  //   precision = 8 / (8+2) = 0.8
  //   recall    = 8 / (8+4) = 0.6666...
  //   F1        = 2*0.8*0.6667 / (0.8+0.6667) = 0.72727...
  //   accuracy  = (8+6) / 20 = 0.7
  const known: ConfusionMatrix = { truePositives: 8, falsePositives: 2, falseNegatives: 4, trueNegatives: 6 };

  it('computes precision, recall, F1, accuracy from a known matrix', () => {
    expect(precision(known)).toBeCloseTo(0.8, 10);
    expect(recall(known)).toBeCloseTo(2 / 3, 10);
    expect(f1Score(known)).toBeCloseTo((2 * 0.8 * (2 / 3)) / (0.8 + 2 / 3), 10);
    expect(accuracy(known)).toBeCloseTo(0.7, 10);
  });

  it('tallies a confusion matrix from labeled predictions', () => {
    const preds: Prediction[] = [
      { expectedBlocked: true, predictedBlocked: true }, // TP
      { expectedBlocked: true, predictedBlocked: true }, // TP
      { expectedBlocked: false, predictedBlocked: true }, // FP
      { expectedBlocked: true, predictedBlocked: false }, // FN
      { expectedBlocked: false, predictedBlocked: false }, // TN
      { expectedBlocked: false, predictedBlocked: false }, // TN
    ];
    expect(confusionMatrix(preds)).toEqual({
      truePositives: 2,
      falsePositives: 1,
      falseNegatives: 1,
      trueNegatives: 2,
    });
  });

  it('uses the standard degenerate-denominator conventions', () => {
    // No positive predictions -> precision 1; no actual positives -> recall 1.
    const empty: ConfusionMatrix = { truePositives: 0, falsePositives: 0, falseNegatives: 0, trueNegatives: 5 };
    expect(precision(empty)).toBe(1);
    expect(recall(empty)).toBe(1);
    // Both precision and recall zero -> F1 0, not NaN.
    const allWrong: ConfusionMatrix = { truePositives: 0, falsePositives: 3, falseNegatives: 3, trueNegatives: 0 };
    expect(f1Score(allWrong)).toBe(0);
  });
});

// ---- The real guard over the labeled fixture -----------------------------------------------

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
const fixture = JSON.parse(
  readFileSync(resolve(here, '../../evals/guard-fixture.json'), 'utf8'),
) as Fixture;

function scoreFixture() {
  const predictions: Prediction[] = fixture.rows.map((row) => {
    const actor = { handle: row.authorHandle, displayName: fixture.actor.displayName };
    const result = checkNarrative(row.narrative, actor, row.otherMembers);
    return { expectedBlocked: row.expectedBlocked, predictedBlocked: !result.ok };
  });
  return { predictions, metrics: classificationMetrics(predictions) };
}

describe('named-metric guard eval over guard-fixture.json (real checkNarrative)', () => {
  // Floors sit just below the measured values (precision/F1/accuracy = 1.000 as of this fixture).
  // Recall is a hard 1.0: the block class is the safety class, and no must-block row may pass.
  const PRECISION_FLOOR = 0.95;
  const F1_FLOOR = 0.95;
  const ACCURACY_FLOOR = 0.95;

  it('has a substantial, balanced fixture', () => {
    expect(fixture.rows.length).toBeGreaterThanOrEqual(40);
    expect(fixture.rows.length).toBeLessThanOrEqual(60);
    const blocked = fixture.rows.filter((r) => r.expectedBlocked).length;
    const allowed = fixture.rows.length - blocked;
    expect(blocked).toBeGreaterThan(0);
    expect(allowed).toBeGreaterThan(0);
  });

  it('clears the CI floors and blocks every must-block row', () => {
    const { metrics } = scoreFixture();
    // Hard safety invariant: no expectedBlocked narrative slipped through.
    expect(metrics.matrix.falseNegatives).toBe(0);
    expect(metrics.recall).toBe(1);
    expect(metrics.precision).toBeGreaterThanOrEqual(PRECISION_FLOOR);
    expect(metrics.f1).toBeGreaterThanOrEqual(F1_FLOOR);
    expect(metrics.accuracy).toBeGreaterThanOrEqual(ACCURACY_FLOOR);
  });

  it('reproduces the exact measured confusion matrix reported in docs/EVALS.md', () => {
    // Pins the fixture so the numbers in docs cannot silently drift. Update both together.
    const { metrics } = scoreFixture();
    expect(metrics.matrix).toEqual({
      truePositives: 26,
      falsePositives: 0,
      falseNegatives: 0,
      trueNegatives: 23,
    });
    expect(metrics.precision).toBe(1);
    expect(metrics.recall).toBe(1);
    expect(metrics.f1).toBe(1);
    expect(metrics.accuracy).toBe(1);
  });
});
