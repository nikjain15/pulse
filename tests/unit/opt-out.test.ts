import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicMember } from '@/lib/cohort';
import { fetchOptOuts, normaliseHandle, withoutOptedOut } from '@/lib/opt-out';

/**
 * The exit path had no unit tests at all, and it had a real latent hole: `fetchOptOuts`
 * read one 300-document page and dropped `nextPageToken`, so tombstone number 301 would
 * have been silently missing from the returned set and that person would have reappeared
 * on the landing page. 65 people in the pilot is why it had not bitten yet.
 *
 * These tests are about the one property this module promises: a tombstoned handle is
 * never returned, and a partial answer is never presented as a complete one.
 */

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
  vi.restoreAllMocks();
});

const page = (ids: string[], nextPageToken?: string) => ({
  ok: true,
  status: 200,
  json: async () => ({
    documents: ids.map((id) => ({ name: `projects/demo/databases/(default)/documents/optOuts/${id}` })),
    ...(nextPageToken ? { nextPageToken } : {}),
  }),
});

describe('fetchOptOuts pagination', () => {
  it('returns a single page when there is no continuation token', async () => {
    globalThis.fetch = vi.fn(async () => page(['alice', 'bob'])) as unknown as typeof fetch;
    expect([...(await fetchOptOuts())].sort()).toEqual(['alice', 'bob']);
  });

  it('follows every page, so the 301st tombstone is not silently dropped', async () => {
    const first = Array.from({ length: 300 }, (_, i) => `user${i}`);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page(first, 'token-2'))
      .mockResolvedValueOnce(page(['the-301st-person']));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchOptOuts();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.size).toBe(301);
    expect(result.has('the-301st-person')).toBe(true);
  });

  it('passes the page token on the follow-up request', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(page(['a'], 'tok')).mockResolvedValueOnce(page(['b']));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await fetchOptOuts();
    expect(String(fetchMock.mock.calls[1][0])).toContain('pageToken=tok');
  });

  it('lowercases doc ids so a handle tombstoned under any casing still matches', async () => {
    globalThis.fetch = vi.fn(async () => page(['NikJain15'])) as unknown as typeof fetch;
    expect((await fetchOptOuts()).has('nikjain15')).toBe(true);
  });

  it('throws rather than returning a partial list when a read fails', async () => {
    // removeOptedOut turns a throw into "show nobody", which is the safe direction: showing
    // nobody for fifteen minutes is recoverable, showing somebody who opted out is not.
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    await expect(fetchOptOuts()).rejects.toThrow(/optOuts read failed: 503/);
  });

  it('throws rather than returning a truncated list when the page ceiling is hit', async () => {
    globalThis.fetch = vi.fn(async () => page(['x'], 'always-more')) as unknown as typeof fetch;
    await expect(fetchOptOuts()).rejects.toThrow(/partial list/);
  });
});

describe('withoutOptedOut', () => {
  const member = (handle: string): PublicMember => ({
    handle,
    evidence: { commits: 1, prNumbers: [1], files: [], spanHours: null },
    lastSeenAt: '2026-08-01T00:00:00.000Z',
    narrationOptIn: false,
  });
  const members = [member('Alice'), member('bob')];

  it('removes a tombstoned member regardless of the casing they signed up under', () => {
    expect(withoutOptedOut(members, new Set(['alice'])).map((m) => m.handle)).toEqual(['bob']);
  });

  it('keeps everyone when nobody has opted out', () => {
    expect(withoutOptedOut(members, new Set()).length).toBe(2);
  });
});

describe('normaliseHandle', () => {
  it('accepts the forms a person actually types', () => {
    expect(normaliseHandle('@Nik')).toBe('nik');
    expect(normaliseHandle('  nikjain15 ')).toBe('nikjain15');
  });

  it('rejects anything that is not a GitHub login, because it becomes a document id', () => {
    expect(normaliseHandle('')).toBeNull();
    expect(normaliseHandle('a/b')).toBeNull();
    expect(normaliseHandle('-leading')).toBeNull();
    expect(normaliseHandle('trailing-')).toBeNull();
    expect(normaliseHandle('a'.repeat(40))).toBeNull();
  });
});
