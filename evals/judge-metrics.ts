/**
 * Judge validation metrics. EVALS.md §5.
 *
 * WHY THIS FILE EXISTS. `run-groundedness-eval.ts` reported the LLM judge as a
 * single line:
 *
 *     agreement vs labels   : 87.5%  (7/8)
 *
 * That number cannot be read. On a set that is half grounded, a judge that
 * answers "grounded" to everything scores 50 percent while carrying no signal
 * at all; on a set that is 80 percent grounded it scores 80 percent and looks
 * good. Raw agreement measures the dataset as much as the judge, and it hides
 * WHICH way the judge is wrong, which is the part that matters. A judge that
 * waves through invented PR numbers and a judge that flags honest narratives
 * are both "wrong", and only one of them publishes fiction to 64 people.
 *
 * So every number here is reported next to the number it has to beat.
 *
 * The method is ported from Conduit's `evals/judge-metrics.ts`, deliberately
 * rather than reinvented. Conduit's own first run is the argument for it: a
 * cheap model rejected every single case, which a raw catch rate scored as a
 * flawless 100 percent detection rate. Kappa scored it 0.
 *
 * Pure functions over recorded verdicts. No network, no key, no spend, so CI
 * checks the arithmetic on every pull request and only the model call needs a
 * secret.
 */

/** One graded case: what the label says, what the judge said. */
export interface Comparison {
  /** Ground truth from the dataset. */
  gold: boolean;
  /** What the judge returned for the same case. */
  judge: boolean;
}

export interface AgreementStats {
  n: number;
  /** gold grounded, judge grounded. */
  tp: number;
  /** gold grounded, judge said ungrounded: an honest narrative wrongly flagged. */
  fn: number;
  /** gold ungrounded, judge said grounded: an invention published. The dangerous cell. */
  fp: number;
  /** gold ungrounded, judge ungrounded. */
  tn: number;
  /** Raw agreement: the share the judge got right. Never report this alone. */
  agreement: number;
  /** What a judge scores by answering "grounded" to everything. The number raw
   *  agreement has to beat before it means anything. */
  baseRate: number;
  /** Cohen's kappa: agreement corrected for chance. 1 perfect, 0 chance level,
   *  negative worse than chance. 0.6 is the common production floor. */
  kappa: number;
  /** Of the narratives that genuinely are grounded, the share the judge kept.
   *  Low means the judge cries wolf and people stop trusting it. */
  trueGroundedRate: number;
  /** Of the narratives that genuinely are NOT grounded, the share the judge
   *  caught. Low means inventions ship. This is the rate that matters most. */
  trueUngroundedRate: number;
}

const div = (a: number, b: number): number => (b === 0 ? 0 : a / b);

/**
 * Cohen's kappa for two binary raters.
 *
 *   po = observed agreement
 *   pe = agreement expected by chance from the two raters' marginals
 *   k  = (po - pe) / (1 - pe)
 *
 * The degenerate case is worth naming. If both raters always answered the same
 * class, pe is 1 and the formula divides by zero. That is a set with no class
 * variation, not a perfect judge, so it returns 0 and the caller must reject the
 * set as unusable. `assertClassBalance` below exists to make that unreachable
 * with a committed dataset.
 */
export function agreementStats(comparisons: Comparison[]): AgreementStats {
  let tp = 0;
  let fn = 0;
  let fp = 0;
  let tn = 0;

  for (const { gold, judge } of comparisons) {
    if (gold && judge) tp++;
    else if (gold && !judge) fn++;
    else if (!gold && judge) fp++;
    else tn++;
  }

  const n = comparisons.length;
  const po = div(tp + tn, n);

  const goldTrue = tp + fn;
  const goldFalse = fp + tn;
  const judgeTrue = tp + fp;
  const judgeFalse = fn + tn;
  const pe = n === 0 ? 0 : (goldTrue * judgeTrue + goldFalse * judgeFalse) / (n * n);

  return {
    n,
    tp,
    fn,
    fp,
    tn,
    agreement: po,
    baseRate: div(goldTrue, n),
    kappa: pe >= 1 ? 0 : div(po - pe, 1 - pe),
    trueGroundedRate: div(tp, goldTrue),
    trueUngroundedRate: div(tn, goldFalse),
  };
}

/** Landis and Koch bands, the convention kappa is normally read against. */
export function kappaBand(kappa: number): string {
  if (kappa < 0) return 'worse than chance';
  if (kappa < 0.21) return 'slight';
  if (kappa < 0.41) return 'fair';
  if (kappa < 0.61) return 'moderate';
  if (kappa < 0.81) return 'substantial';
  return 'almost perfect';
}

/**
 * The class-balance guard.
 *
 * A validation set skewed towards one class makes an always-one-answer judge
 * look competent on raw agreement, and it makes kappa unstable. This refuses
 * anything outside a 40/60 split, and refuses a set with no variation at all,
 * which is the input that would silently return kappa 0 above.
 *
 * Returns the reasons the set is unusable. Empty means it is usable.
 */
export function classBalanceProblems(golds: boolean[], tolerance = 0.1): string[] {
  const out: string[] = [];
  const n = golds.length;
  if (n === 0) {
    out.push('the validation set is empty');
    return out;
  }
  const grounded = golds.filter(Boolean).length;
  const share = grounded / n;
  if (grounded === 0) out.push('every case is labelled ungrounded, so kappa cannot be computed');
  if (grounded === n) out.push('every case is labelled grounded, so kappa cannot be computed');
  if (Math.abs(share - 0.5) > tolerance) {
    out.push(
      `class balance is ${grounded}/${n} grounded (${(share * 100).toFixed(0)}%), outside the ` +
        `${((0.5 - tolerance) * 100).toFixed(0)} to ${((0.5 + tolerance) * 100).toFixed(0)}% band. ` +
        `An always-grounded judge would score ${(share * 100).toFixed(0)}% raw agreement on it.`
    );
  }
  return out;
}

/** One model's result on the one dimension Pulse's judge actually claims. */
export interface ModelReport {
  model: string;
  groundedness: AgreementStats;
}

/**
 * A (model, dimension) pair Pulse relies on and therefore holds to the floor.
 *
 * Every model measured gets recorded. Only what the repo CLAIMS gets enforced.
 * The distinction runs the strict way: a pair that is not listed here is not
 * exempt, it is UNVALIDATED, and an unvalidated judge must not be described
 * anywhere as a quality gate. Adding a pair here is a claim that the measurement
 * backs it.
 *
 * Pulse's judge returns one binary verdict, `grounded`, so there is exactly one
 * dimension. Conduit grades two because its judge makes two separate claims.
 * Adding a second dimension here would mean measuring something Pulse does not
 * ship.
 */
export interface EnforcedPair {
  model: string;
  dimension: 'groundedness';
}

export interface ValidationResults {
  /** ISO date of the run. A stale result is a stale claim. */
  ran: string;
  datasetVersion: string;
  cases: number;
  reports: ModelReport[];
  /** Kappa an enforced pair must clear. */
  kappaFloor: number;
  /** What this repo claims is validated. Anything absent is unvalidated. */
  enforced: EnforcedPair[];
  notes?: string;
}

/** Every enforced pair that does not clear the floor, described for an error
 *  message. Empty means every claim this repo makes is backed by a measurement. */
export function enforcedFailures(results: ValidationResults): string[] {
  const out: string[] = [];
  for (const pair of results.enforced) {
    const report = results.reports.find((r) => r.model === pair.model);
    if (!report) {
      out.push(`${pair.model}: claimed validated for ${pair.dimension} but never measured`);
      continue;
    }
    const stats = report.groundedness;
    if (stats.kappa < results.kappaFloor) {
      out.push(
        `${pair.model} ${pair.dimension}: kappa ${stats.kappa.toFixed(3)} is below the floor ` +
          `${results.kappaFloor} (${kappaBand(stats.kappa)})`
      );
    }
  }
  return out;
}
