import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  agreementStats,
  classBalanceProblems,
  enforcedFailures,
  kappaBand,
  type Comparison,
  type ValidationResults,
} from '../../evals/judge-metrics';

/**
 * The arithmetic behind judge validation, checked offline.
 *
 * This suite is the reason CI can say anything about the judge without a key.
 * `run-judge-validation.ts` needs ANTHROPIC_API_KEY and costs money, so it does
 * not run on every pull request. The maths does.
 *
 * The test that matters most is "an always-grounded judge scores kappa 0". That
 * is the exact failure `run-groundedness-eval.ts` could not see: it reported the
 * judge as raw agreement, and raw agreement rewards a judge that has stopped
 * discriminating. Conduit hit this for real, where a cheap model rejected every
 * case and a raw catch rate scored it a flawless 100 percent.
 */

const comps = (spec: Array<[boolean, boolean]>): Comparison[] =>
  spec.map(([gold, judge]) => ({ gold, judge }));

/** n grounded and n ungrounded cases, judged however `fn` says. */
const balanced = (n: number, fn: (gold: boolean, i: number) => boolean): Comparison[] => {
  const out: Comparison[] = [];
  for (let i = 0; i < n; i++) out.push({ gold: true, judge: fn(true, i) });
  for (let i = 0; i < n; i++) out.push({ gold: false, judge: fn(false, i) });
  return out;
};

describe('agreementStats · the degenerate judges', () => {
  it('scores an always-grounded judge at kappa 0, however good its raw agreement looks', () => {
    const s = agreementStats(balanced(12, () => true));
    expect(s.agreement).toBe(0.5);
    expect(s.baseRate).toBe(0.5);
    expect(s.kappa).toBe(0);
    expect(s.trueGroundedRate).toBe(1); // keeps everything honest
    expect(s.trueUngroundedRate).toBe(0); // and catches nothing at all
  });

  it('scores an always-UNgrounded judge at kappa 0 too, which a catch rate calls perfect', () => {
    // This is Conduit's real finding, reproduced. A judge that rejects every
    // case has a 100% invention catch rate and is completely useless.
    const s = agreementStats(balanced(12, () => false));
    expect(s.trueUngroundedRate).toBe(1);
    expect(s.kappa).toBe(0);
    expect(s.trueGroundedRate).toBe(0);
  });

  it('a skewed set lets an always-grounded judge post high raw agreement, and kappa still says 0', () => {
    // 18 grounded, 2 ungrounded. Raw agreement 90%, which reads as excellent.
    const spec: Array<[boolean, boolean]> = [];
    for (let i = 0; i < 18; i++) spec.push([true, true]);
    for (let i = 0; i < 2; i++) spec.push([false, true]);
    const s = agreementStats(comps(spec));
    expect(s.agreement).toBeCloseTo(0.9, 10);
    expect(s.baseRate).toBeCloseTo(0.9, 10);
    expect(s.kappa).toBe(0);
  });

  it('scores a perfect judge at kappa 1', () => {
    const s = agreementStats(balanced(12, (gold) => gold));
    expect(s.agreement).toBe(1);
    expect(s.kappa).toBe(1);
    expect(s.fp).toBe(0);
    expect(s.fn).toBe(0);
  });

  it('scores an inverted judge below zero, not merely low', () => {
    const s = agreementStats(balanced(12, (gold) => !gold));
    expect(s.agreement).toBe(0);
    expect(s.kappa).toBeLessThan(0);
    expect(kappaBand(s.kappa)).toBe('worse than chance');
  });
});

describe('agreementStats · separating the two ways a judge is wrong', () => {
  it('distinguishes a judge that over-flags from one that lets inventions through', () => {
    // Both score the same raw agreement. Only one of them publishes fiction.
    const overFlags = agreementStats(
      comps([
        [true, false], [true, false], [true, true], [true, true],
        [false, false], [false, false], [false, false], [false, false],
      ])
    );
    const letsThrough = agreementStats(
      comps([
        [true, true], [true, true], [true, true], [true, true],
        [false, true], [false, true], [false, false], [false, false],
      ])
    );

    expect(overFlags.agreement).toBe(letsThrough.agreement); // identical headline
    expect(overFlags.fp).toBe(0); // nothing invented reached a reader
    expect(letsThrough.fp).toBe(2); // two inventions published
    expect(overFlags.trueUngroundedRate).toBe(1);
    expect(letsThrough.trueUngroundedRate).toBe(0.5);
  });

  it('handles an empty set without dividing by zero', () => {
    const s = agreementStats([]);
    expect(s.n).toBe(0);
    expect(s.kappa).toBe(0);
    expect(s.agreement).toBe(0);
  });
});

describe('kappaBand', () => {
  it('names the Landis and Koch bands at their boundaries', () => {
    expect(kappaBand(-0.2)).toBe('worse than chance');
    expect(kappaBand(0.2)).toBe('slight');
    expect(kappaBand(0.4)).toBe('fair');
    expect(kappaBand(0.6)).toBe('moderate');
    expect(kappaBand(0.8)).toBe('substantial');
    expect(kappaBand(0.9)).toBe('almost perfect');
  });

  it('puts the 0.6 floor at the bottom of "substantial", not inside "moderate"', () => {
    expect(kappaBand(0.59)).toBe('moderate');
    expect(kappaBand(0.61)).toBe('substantial');
  });
});

describe('classBalanceProblems · the guard that makes kappa readable', () => {
  it('accepts an evenly balanced set', () => {
    expect(classBalanceProblems([true, true, false, false])).toEqual([]);
  });

  it('rejects a set with no ungrounded cases, which would make kappa meaningless', () => {
    const p = classBalanceProblems([true, true, true, true]);
    expect(p.length).toBeGreaterThan(0);
    expect(p.join(' ')).toContain('kappa cannot be computed');
  });

  it('rejects a set with no grounded cases', () => {
    const p = classBalanceProblems([false, false, false, false]);
    expect(p.join(' ')).toContain('kappa cannot be computed');
  });

  it('rejects a skewed set and says what an always-grounded judge would score on it', () => {
    const golds = [...Array(9).fill(true), false];
    const p = classBalanceProblems(golds);
    expect(p.length).toBe(1);
    expect(p[0]).toContain('90%');
  });
});

describe('enforcedFailures · only what is claimed is enforced', () => {
  const results = (over: Partial<ValidationResults> = {}): ValidationResults => ({
    ran: '2026-08-02',
    datasetVersion: 'v1',
    cases: 24,
    kappaFloor: 0.6,
    reports: [
      { model: 'good-model', groundedness: agreementStats(balanced(12, (g) => g)) },
      { model: 'useless-model', groundedness: agreementStats(balanced(12, () => true)) },
    ],
    enforced: [],
    ...over,
  });

  it('passes when nothing is claimed, and that is a recorded number rather than a gate', () => {
    expect(enforcedFailures(results())).toEqual([]);
  });

  it('does NOT fail on a bad model that the repo never claimed was validated', () => {
    // The useless model scores kappa 0 and is still measured and reported. It is
    // simply not something this repo says it relies on.
    expect(enforcedFailures(results({ enforced: [] }))).toEqual([]);
  });

  it('fails the moment a bad model is claimed', () => {
    const f = enforcedFailures(
      results({ enforced: [{ model: 'useless-model', dimension: 'groundedness' }] })
    );
    expect(f.length).toBe(1);
    expect(f[0]).toContain('below the floor');
  });

  it('passes when a claimed model clears the floor', () => {
    expect(
      enforcedFailures(results({ enforced: [{ model: 'good-model', dimension: 'groundedness' }] }))
    ).toEqual([]);
  });

  it('fails a claim for a model that was never measured, rather than skipping it', () => {
    // Claiming validation for something you did not run is the exact failure
    // this whole file exists to make impossible.
    const f = enforcedFailures(
      results({ enforced: [{ model: 'never-ran', dimension: 'groundedness' }] })
    );
    expect(f.length).toBe(1);
    expect(f[0]).toContain('never measured');
  });
});

describe('the committed validation set', () => {
  const data = JSON.parse(
    readFileSync(resolve(__dirname, '../../evals/judge-validation-dataset.json'), 'utf8')
  ) as { version: string; cases: Array<{ id: string; band: string; grounded: boolean; why: string }> };

  it('is class balanced, so an always-grounded judge scores kappa 0 on it', () => {
    expect(classBalanceProblems(data.cases.map((c) => c.grounded))).toEqual([]);
  });

  it('has unique ids', () => {
    const ids = data.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every case a reason the label can be checked against', () => {
    for (const c of data.cases) {
      expect(c.why.length, `${c.id} needs a why`).toBeGreaterThan(30);
    }
  });

  it('includes cases the deterministic scorer cannot see, or the judge is measuring nothing new', () => {
    // U-SCOPE cases carry no PR number and no file path, so scoreGroundedness
    // is blind to them by construction. If this band ever empties, the run
    // stops measuring what the LLM judge is actually for.
    const uScope = data.cases.filter((c) => c.band === 'U-SCOPE');
    expect(uScope.length).toBeGreaterThanOrEqual(4);
    for (const c of uScope) expect(c.grounded).toBe(false);
  });

  it('includes honest-but-modest narratives, so over-flagging is measured too', () => {
    const vague = data.cases.filter((c) => c.band === 'G-VAGUE');
    expect(vague.length).toBeGreaterThanOrEqual(3);
    for (const c of vague) expect(c.grounded).toBe(true);
  });
});
