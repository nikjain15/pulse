/**
 * Binary-classification metrics for the eval harnesses.
 *
 * Pure, dependency-free, and unit-tested against a hand-built confusion matrix so the numbers the
 * guard eval reports (`evals/run-guard-metrics.ts`, `docs/EVALS.md`) are computed, not asserted by
 * hand. The "positive" class throughout is the BLOCK decision: a prediction is positive when the
 * guard rejects a narrative, so recall here is "of the narratives that should be blocked, how many
 * were" and precision is "of the narratives we blocked, how many should have been".
 *
 * Conventions for degenerate denominators follow the usual eval practice: precision is 1 when there
 * are no positive predictions (nothing was wrongly blocked), recall is 1 when there are no actual
 * positives (nothing needed blocking), and F1 is 0 when precision and recall are both 0.
 */

/** A 2x2 confusion matrix for the block decision (positive = blocked). */
export type ConfusionMatrix = {
  /** Should block and did block. */
  truePositives: number;
  /** Should allow but blocked. */
  falsePositives: number;
  /** Should block but allowed. */
  falseNegatives: number;
  /** Should allow and did allow. */
  trueNegatives: number;
};

export type ClassificationMetrics = {
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
  support: number;
  matrix: ConfusionMatrix;
};

/** One labeled prediction: what the label said (should it be blocked) and what the guard did. */
export type Prediction = { expectedBlocked: boolean; predictedBlocked: boolean };

/** Tally a confusion matrix from labeled predictions, positive = blocked. */
export function confusionMatrix(predictions: readonly Prediction[]): ConfusionMatrix {
  const m: ConfusionMatrix = { truePositives: 0, falsePositives: 0, falseNegatives: 0, trueNegatives: 0 };
  for (const p of predictions) {
    if (p.expectedBlocked && p.predictedBlocked) m.truePositives += 1;
    else if (!p.expectedBlocked && p.predictedBlocked) m.falsePositives += 1;
    else if (p.expectedBlocked && !p.predictedBlocked) m.falseNegatives += 1;
    else m.trueNegatives += 1;
  }
  return m;
}

export function precision(m: ConfusionMatrix): number {
  const denom = m.truePositives + m.falsePositives;
  // No positive predictions: nothing was wrongly blocked, so precision is perfect by convention.
  return denom === 0 ? 1 : m.truePositives / denom;
}

export function recall(m: ConfusionMatrix): number {
  const denom = m.truePositives + m.falseNegatives;
  // No actual positives: nothing needed blocking, so recall is perfect by convention.
  return denom === 0 ? 1 : m.truePositives / denom;
}

export function f1Score(m: ConfusionMatrix): number {
  const p = precision(m);
  const r = recall(m);
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

export function accuracy(m: ConfusionMatrix): number {
  const total = m.truePositives + m.falsePositives + m.falseNegatives + m.trueNegatives;
  return total === 0 ? 1 : (m.truePositives + m.trueNegatives) / total;
}

/** Compute the full metric set from labeled predictions in one call. */
export function classificationMetrics(predictions: readonly Prediction[]): ClassificationMetrics {
  const matrix = confusionMatrix(predictions);
  return {
    precision: precision(matrix),
    recall: recall(matrix),
    f1: f1Score(matrix),
    accuracy: accuracy(matrix),
    support: predictions.length,
    matrix,
  };
}
