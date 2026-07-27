import { describe, expect, it } from 'vitest';
import { semanticRerank, type RerankItem } from '@/lib/semantic-retrieval';
import type { EmbedFn } from '@/lib/conduit/rag';
import { checkNarrative } from '@/lib/sense';

/**
 * The semantic rerank is pure and injectable: the embed function is a parameter, so these tests
 * drive it with a deterministic mock and never touch a provider.
 *
 * The load-bearing behaviors:
 *   - it surfaces an item that is relevant by MEANING but shares no keyword with the query (the
 *     thing exact-match retrieval misses),
 *   - with no embedder it degrades to `disabled`, handing control back to structured retrieval,
 *   - a weak top match triggers the bad-retrieval gate and returns `not_found` (say not-found,
 *     do not invent),
 *   - and the deterministic narrative guard is entirely independent of this change: it still
 *     blocks a peer-named answer.
 */

/**
 * A tiny topical embedder: maps text to a fixed-dimension vector over concept buckets by keyword.
 * "login"/"auth"/"session" all load the same auth dimension, so a query about auth ranks a task
 * titled "session token" highly WITHOUT any shared surface word.
 */
const CONCEPTS: Record<string, string[]> = {
  auth: ['login', 'auth', 'authentication', 'session', 'token', 'signin', 'credential', 'oauth'],
  billing: ['billing', 'invoice', 'payment', 'charge', 'subscription', 'stripe'],
  perf: ['latency', 'slow', 'performance', 'speed', 'p95', 'throughput'],
};
const DIMS = Object.keys(CONCEPTS);

const mockEmbed: EmbedFn = (text: string) => {
  const lower = text.toLowerCase();
  return DIMS.map((dim) => CONCEPTS[dim].reduce((acc, kw) => (lower.includes(kw) ? acc + 1 : acc), 0));
};

const items: RerankItem[] = [
  { id: 'task:1', text: 'Rotate the session token on refresh' }, // auth, no query keyword
  { id: 'task:2', text: 'Reconcile the monthly invoice export' }, // billing
  { id: 'task:3', text: 'Cut p95 latency on the board feed' }, // perf
];

describe('semanticRerank', () => {
  it('surfaces a semantically relevant item that exact keyword match would miss', async () => {
    const question = 'why is login broken'; // shares NO word with "Rotate the session token on refresh"
    // Exact-match retrieval would find nothing (no item contains "login" or "broken").
    expect(items.every((i) => !i.text.toLowerCase().includes('login'))).toBe(true);

    const outcome = await semanticRerank({ question, items, embed: mockEmbed });
    expect(outcome.kind).toBe('ranked');
    if (outcome.kind !== 'ranked') return;
    expect(outcome.results[0].id).toBe('task:1'); // the auth item ranked top by meaning
    expect(outcome.results[0].score).toBeGreaterThan(0);
  });

  it('degrades to disabled when no embedder is configured', async () => {
    const outcome = await semanticRerank({ question: 'anything at all', items });
    expect(outcome).toEqual({ kind: 'disabled' });
  });

  it('returns not_found when nothing clears the relevance floor (bad-retrieval gate)', async () => {
    // A query over concepts none of the items touch: every cosine score is 0.
    const outcome = await semanticRerank({
      question: 'holiday party planning logistics',
      items,
      embed: mockEmbed,
    });
    expect(outcome.kind).toBe('not_found');
    if (outcome.kind !== 'not_found') return;
    expect(outcome.topScore).toBeLessThan(0.15);
  });

  it('treats an empty candidate set as not_found, never a crash', async () => {
    const outcome = await semanticRerank({ question: 'auth session', items: [], embed: mockEmbed });
    expect(outcome.kind).toBe('not_found');
  });

  it('respects the minTopScore threshold', async () => {
    // "login invoice" embeds across two concepts (auth + billing) -> [1,1,0]; the best item
    // ("session token", auth only) sits at cosine ~0.707. The default floor keeps it; a floor
    // above it turns the same match into not_found.
    const q = 'login invoice';
    const kept = await semanticRerank({ question: q, items, embed: mockEmbed });
    expect(kept.kind).toBe('ranked');

    const gated = await semanticRerank({ question: q, items, embed: mockEmbed, minTopScore: 0.8 });
    expect(gated.kind).toBe('not_found');
    if (gated.kind === 'not_found') expect(gated.topScore).toBeCloseTo(1 / Math.SQRT2, 4);
  });
});

describe('narrative guard is unaffected by the semantic-retrieval change', () => {
  it('still blocks a peer-named answer', () => {
    const actor = { handle: 'rowan_dev', displayName: 'Rowan' };
    const others = [{ handle: 'mira', displayName: 'Mira Okafor' }];
    const result = checkNarrative('Rowan fixed the bug that Mira keeps causing.', actor, others);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('names_another_member');
  });
});
