import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { runAskAgent } from '@/lib/ask-agent';
import { acceptsSampling } from '@/lib/conduit/client';
import {
  ASK_CHEAP_MODEL,
  ASK_REASONING_MODEL,
  difficultyTier,
  isHardAsk,
  looksLowConfidence,
} from '@/lib/conduit/routing';
import type { BoardContext } from '@/lib/agent';

/**
 * Difficulty-based cascade for the Ask-Pulse answer path. Ask-Pulse used to pin one model; these
 * tests drive the real client → resolve → routing stack with a mocked Anthropic that records the
 * exact model id each turn targeted, so routing decisions are asserted end to end (not just via the
 * pure predicate). The sampling contract and the unchanged deterministic guard are checked too.
 */

/** A fake Anthropic that records the model each call targeted and replays scripted replies. */
function scriptedAnthropic(replies: string[]) {
  const models: string[] = [];
  let i = 0;
  const anthropic = {
    messages: {
      create: async (body: { model: string }) => {
        models.push(body.model);
        const text = replies[Math.min(i, replies.length - 1)];
        i += 1;
        return { model: body.model, content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 20 } };
      },
    },
  } as unknown as Anthropic;
  return { anthropic, models };
}

const ctx: BoardContext = {
  uid: 'u1',
  canPublish: false,
  projects: [{ id: 'p1', name: 'Docs' }],
  tasks: [
    { id: 't1', title: 'Write the launch post', status: 'todo', mine: true, project: 'Docs', dueDate: '2020-01-01' },
    { id: 't2', title: 'Fix the flaky test', status: 'in_progress', mine: true, project: 'Docs' },
  ],
};

const identity = {
  actor: { handle: 'nik', displayName: 'Nik' },
  otherMembers: [{ handle: 'priya', displayName: 'Priya' }],
};

describe('difficulty predicate (pure)', () => {
  it('keeps a short single-question ask on the cheap tier', () => {
    expect(difficultyTier({ utterance: 'what should I focus on?', stepIndex: 0 })).toBe('cheap');
    expect(difficultyTier({ utterance: 'what should I focus on?', stepIndex: 1 })).toBe('cheap');
  });

  it('escalates a long/complex ask, a multi-step loop, and a low-confidence pass', () => {
    const longAsk = 'I have a lot going on '.repeat(6) + 'so what should I do first and why?';
    expect(difficultyTier({ utterance: longAsk, stepIndex: 0 })).toBe('reasoning');
    expect(difficultyTier({ utterance: 'short', stepIndex: 2 })).toBe('reasoning');
    expect(difficultyTier({ utterance: 'a? b?', stepIndex: 0 })).toBe('reasoning');
    expect(isHardAsk({ words: 1, chars: 5, questions: 0, stepIndex: 0, lowConfidence: true })).toBe(true);
  });

  it('flags hedged or empty answers as low-confidence', () => {
    expect(looksLowConfidence("I'm not sure what to focus on")).toBe(true);
    expect(looksLowConfidence('   ')).toBe(true);
    expect(looksLowConfidence('You have two open cards, one overdue.')).toBe(false);
  });
});

describe('runAskAgent: real cascade', () => {
  it('routes a simple ask to the cheap tier (Haiku)', async () => {
    const { anthropic, models } = scriptedAnthropic([
      JSON.stringify({ tool: 'board_stats', args: {} }),
      JSON.stringify({ final: 'You have two open cards and one is overdue.' }),
    ]);
    const out = await runAskAgent({ utterance: 'what should I focus on?', ctx, identity, anthropic, maxSteps: 5 });

    expect(out.answer).toBe('You have two open cards and one is overdue.');
    expect(out.tiers).toEqual(['cheap', 'cheap']);
    expect(out.escalated).toBe(false);
    expect(models).toEqual([ASK_CHEAP_MODEL.model, ASK_CHEAP_MODEL.model]);
  });

  it('escalates a long/complex ask to the reasoning tier (Opus) from the first turn', async () => {
    const longAsk =
      'There is honestly so much on my plate right now across several different projects and I keep ' +
      'losing track of the details, so can you carefully look at absolutely everything on my board ' +
      'and then tell me clearly what actually matters the most for me to finish this week, and why?';
    const { anthropic, models } = scriptedAnthropic([JSON.stringify({ final: 'Focus on the launch post first.' })]);
    const out = await runAskAgent({ utterance: longAsk, ctx, identity, anthropic, maxSteps: 5 });

    expect(out.answer).toBe('Focus on the launch post first.');
    expect(out.tiers[0]).toBe('reasoning');
    expect(models[0]).toBe(ASK_REASONING_MODEL.model);
  });

  it('escalates a multi-step loop to the reasoning tier once it goes deep', async () => {
    // Always proposes a tool call; the loop runs to the cap without finalizing.
    const { anthropic, models } = scriptedAnthropic([JSON.stringify({ tool: 'list_tasks', args: {} })]);
    const out = await runAskAgent({ utterance: 'plan my week', ctx, identity, anthropic, maxSteps: 4 });

    expect(out.stoppedAtCap).toBe(true);
    expect(out.tiers).toEqual(['cheap', 'cheap', 'reasoning', 'reasoning']);
    expect(models).toEqual([
      ASK_CHEAP_MODEL.model,
      ASK_CHEAP_MODEL.model,
      ASK_REASONING_MODEL.model,
      ASK_REASONING_MODEL.model,
    ]);
  });

  it('escalates a low-confidence cheap answer by re-running on the reasoning tier', async () => {
    const { anthropic, models } = scriptedAnthropic([
      JSON.stringify({ final: "I'm not sure what you should focus on." }),
      JSON.stringify({ final: 'Focus on the launch post, it is overdue.' }),
    ]);
    const out = await runAskAgent({ utterance: 'what next?', ctx, identity, anthropic, maxSteps: 5 });

    expect(out.escalated).toBe(true);
    expect(out.answer).toBe('Focus on the launch post, it is overdue.');
    // First (cheap) pass, then the forced reasoning retry.
    expect(models).toEqual([ASK_CHEAP_MODEL.model, ASK_REASONING_MODEL.model]);
    expect(out.tiers).toEqual(['reasoning']);
  });

  it('does not escalate a confident cheap answer', async () => {
    const { anthropic, models } = scriptedAnthropic([JSON.stringify({ final: 'You have two open cards.' })]);
    const out = await runAskAgent({ utterance: 'how many cards?', ctx, identity, anthropic, maxSteps: 5 });

    expect(out.escalated).toBe(false);
    expect(out.answer).toBe('You have two open cards.');
    expect(models).toEqual([ASK_CHEAP_MODEL.model]);
  });
});

describe('sampling contract holds across both tiers', () => {
  it('cheap tier accepts sampling, reasoning tier rejects it', () => {
    expect(acceptsSampling(ASK_CHEAP_MODEL.model)).toBe(true);
    expect(acceptsSampling(ASK_REASONING_MODEL.model)).toBe(false);
    // The valid Haiku id is used for the cheap tier.
    expect(ASK_CHEAP_MODEL.model).toBe('claude-haiku-4-5');
  });
});

describe('the deterministic guard still blocks after the routing change', () => {
  it('never shows a peer-named answer, whichever tier produced it', async () => {
    const { anthropic } = scriptedAnthropic([
      JSON.stringify({ final: 'Priya is behind on her review and it is dragging you down.' }),
    ]);
    const out = await runAskAgent({ utterance: 'how am I doing?', ctx, identity, anthropic, maxSteps: 3 });

    expect(out.answer).toBeUndefined();
    expect(out.blocked?.reason).toBe('names_another_member');
  });
});
