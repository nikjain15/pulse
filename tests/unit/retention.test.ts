import { describe, expect, it } from 'vitest';
import {
  cutoffFor,
  isExpired,
  MS_PER_DAY,
  RETENTION_POLICY,
  ruleFor,
  timedRules,
  unenforcedRules,
} from '@/lib/retention';
import { DELETION_LIMITS } from '@/lib/retention-admin';

/**
 * The retention policy is data, not prose, precisely so it can be tested. What is asserted
 * here is not "the windows are correct" (that is a judgement) but that the policy is
 * complete, internally consistent, and cannot quietly claim enforcement it does not have.
 */

const NOW = new Date('2026-08-02T12:00:00Z');

describe('retention policy shape', () => {
  it('covers every collection the rules file defines', () => {
    // If a new collection is added to firestore.rules and not to the policy, this is the
    // test that says so. Kept as an explicit list rather than parsing the rules file,
    // because a parser that silently matches nothing would pass forever.
    const covered = new Set(RETENTION_POLICY.map((r) => r.collection));
    for (const expected of [
      'members/{uid}',
      'cohortMembers/{handle}',
      'githubLinks/{uid}',
      'briefs/{uid}',
      'boardViews/{uid}',
      'askThreads/{uid}/turns',
      'tasks',
      'comments',
      'pulse',
      'recipes',
      'introductions',
      'optOuts/{handle}',
      'usageCalls',
    ]) {
      expect(covered).toContain(expected);
    }
  });

  it('gives every rule a window with a basis field, or no window at all', () => {
    for (const rule of RETENTION_POLICY) {
      if (rule.windowDays === null) expect(rule.basis).toBeNull();
      else {
        expect(rule.basis).toBeTruthy();
        expect(rule.windowDays).toBeGreaterThan(0);
      }
    }
  });

  it('makes every rule explain itself', () => {
    for (const rule of RETENTION_POLICY) {
      expect(rule.what.length).toBeGreaterThan(10);
      expect(rule.note.length).toBeGreaterThan(40);
    }
  });

  it('names the rules that no code enforces, rather than leaving them to look enforced', () => {
    // This is the honesty assertion. `unenforcedRules` is non-empty today and the docs say
    // which ones. The test exists so a future edit cannot mark something 'sweep' without
    // the sweep actually handling it.
    const unenforced = unenforcedRules().map((r) => r.collection);
    expect(unenforced).toContain('pulse');
    expect(unenforced).toContain('tasks');
    for (const rule of RETENTION_POLICY) {
      if (rule.enforcedBy === 'none') expect(rule.windowDays).toBeNull();
    }
  });

  it('keeps the opt-out tombstone permanent and out of participant deletion', () => {
    // Deleting a tombstone un-hides the person it protects. This is the one place where
    // "we removed everything about you" would be the harmful answer.
    const tombstone = ruleFor('optOuts/{handle}')!;
    expect(tombstone.windowDays).toBeNull();
    expect(tombstone.removedByParticipantDeletion).toBe(false);
  });
});

describe('window arithmetic', () => {
  it('computes a cutoff exactly windowDays before now', () => {
    const rule = ruleFor('usageCalls')!;
    const cutoff = cutoffFor(rule, NOW)!;
    expect(NOW.getTime() - cutoff.getTime()).toBe(90 * MS_PER_DAY);
  });

  it('returns no cutoff for a rule with no window', () => {
    expect(cutoffFor(ruleFor('members/{uid}')!, NOW)).toBeNull();
  });

  it('expires a document one millisecond past the window and not one before', () => {
    const rule = ruleFor('askThreads/{uid}/turns')!; // 30 days
    const cutoff = cutoffFor(rule, NOW)!;
    expect(isExpired(rule, new Date(cutoff.getTime() - 1), NOW)).toBe(true);
    expect(isExpired(rule, cutoff, NOW)).toBe(false);
    expect(isExpired(rule, NOW, NOW)).toBe(false);
  });

  it('never expires anything under a rule with no window', () => {
    const rule = ruleFor('pulse')!;
    expect(isExpired(rule, new Date('2000-01-01'), NOW)).toBe(false);
  });

  it('lists exactly the rules a sweep can act on', () => {
    expect(timedRules().map((r) => r.collection).sort()).toEqual(
      ['askThreads/{uid}/turns', 'briefs/{uid}', 'introductions', 'usageCalls'].sort()
    );
  });
});

describe('deletion limits are stated, always', () => {
  it('names GitHub, the public cohort repo, the tombstone, shared tasks, and third-party logs', () => {
    const text = DELETION_LIMITS.join(' ').toLowerCase();
    for (const must of ['github', 'public cohort repository', 'tombstone', 'shared tasks', 'anthropic', 'vercel']) {
      expect(text).toContain(must);
    }
  });

  it('is not empty, so no report can be printed without it', () => {
    expect(DELETION_LIMITS.length).toBeGreaterThanOrEqual(6);
  });
});
