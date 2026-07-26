import { describe, expect, it } from 'vitest';
import { scoreGroundedness } from '@/lib/groundedness';
import type { Evidence } from '@/lib/types';

/**
 * Groundedness scorer — the accuracy half of the eval ladder (EVALS.md §5). Safety
 * (naming a peer) is `checkNarrative`'s job; this catches the model inventing work that
 * never happened. Deterministic and pure, so it's asserted here, not sampled.
 */

const EV = (over: Partial<Evidence> = {}): Evidence => ({
  commits: 5,
  prNumbers: [40],
  files: ['lib/sense.ts'],
  spanHours: 2,
  ...over,
});

describe('scoreGroundedness — checkable claims must trace to evidence', () => {
  it('passes plain prose with no checkable specifics', () => {
    const r = scoreGroundedness('Cracked the auth flow after a long fight.', EV());
    expect(r.grounded).toBe(true);
    expect(r.ungroundedClaims).toEqual([]);
  });

  it('passes a PR number that is in the evidence', () => {
    expect(scoreGroundedness('Landed PR 40.', EV({ prNumbers: [40, 41] })).grounded).toBe(true);
  });

  it('flags a PR number the evidence never retrieved', () => {
    const r = scoreGroundedness('Shipped PR 999 overhauling billing.', EV({ prNumbers: [40] }));
    expect(r.grounded).toBe(false);
    expect(r.ungroundedClaims[0]).toContain('999');
  });

  it('flags a #-style PR reference that is not in evidence', () => {
    expect(scoreGroundedness('Closed #123 and #124.', EV({ prNumbers: [123] })).grounded).toBe(false);
  });

  it('passes a file that was actually touched (by basename)', () => {
    const r = scoreGroundedness('Reworked lib/sense.ts.', EV({ files: ['lib/sense.ts'] }));
    expect(r.grounded).toBe(true);
  });

  it('passes a file named only in the raw material', () => {
    const r = scoreGroundedness('Updated README.md.', EV({ files: [] }), ['docs: rewrite README.md']);
    expect(r.grounded).toBe(true);
  });

  it('flags a file that was neither touched nor mentioned', () => {
    const r = scoreGroundedness('Rewrote lib/payments.ts for Stripe.', EV({ files: ['lib/sense.ts'] }));
    expect(r.grounded).toBe(false);
    expect(r.ungroundedClaims[0]).toContain('payments.ts');
  });
});
