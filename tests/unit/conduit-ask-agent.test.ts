import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { runAgent } from '@conduit/agent';
import { runAskAgent, parseTurn } from '@/lib/ask-agent';
import { checkNarrative } from '@/lib/sense';
import type { BoardContext } from '@/lib/agent';

/**
 * End-to-end tests for the generative "Ask Pulse" answer path rebuilt as a Conduit agent loop.
 * The provider is mocked: a fake Anthropic whose `messages.create` returns canned JSON replies
 * drives the loop through the real client → resolve → parse → runAgent → guard stack.
 */

/** A fake Anthropic that replays a scripted sequence of assistant text replies, one per turn. */
function scriptedAnthropic(replies: string[]): Anthropic {
  let i = 0;
  return {
    messages: {
      create: async (body: { model: string }) => {
        const text = replies[Math.min(i, replies.length - 1)];
        i += 1;
        return {
          model: body.model,
          content: [{ type: 'text', text }],
          usage: { input_tokens: 100, output_tokens: 20 },
        };
      },
    },
  } as unknown as Anthropic;
}

const ctx: BoardContext = {
  uid: 'u1',
  canPublish: false,
  projects: [{ id: 'p1', name: 'Docs' }],
  tasks: [
    { id: 't1', title: 'Write the launch post', status: 'todo', mine: true, project: 'Docs', dueDate: '2020-01-01' },
    { id: 't2', title: 'Fix the flaky test', status: 'in_progress', mine: true, project: 'Docs' },
    { id: 't3', title: 'Someone elses card', status: 'done', mine: false },
  ],
};

const identity = {
  actor: { handle: 'nik', displayName: 'Nik' },
  otherMembers: [{ handle: 'priya', displayName: 'Priya' }],
};

describe('runAskAgent — bounded agent loop', () => {
  it('gathers with a read-only tool, then terminates with a guarded answer', async () => {
    const anthropic = scriptedAnthropic([
      JSON.stringify({ tool: 'board_stats', args: {} }),
      JSON.stringify({ final: 'You have two open cards and one is overdue.' }),
    ]);
    const out = await runAskAgent({ utterance: 'what should I focus on?', ctx, identity, anthropic, maxSteps: 5 });

    expect(out.answer).toBe('You have two open cards and one is overdue.');
    expect(out.stoppedAtCap).toBe(false);
    // A read-only tool was actually invoked, and its call is recorded in the trace.
    const toolCalls = out.steps.filter((s) => s.kind === 'tool_call');
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0]).toMatchObject({ tool: 'board_stats', ok: true });
    // The board-triage skill was selected at runtime by intent.
    expect(out.loadedSkills).toContain('board-triage');
  });

  it('respects the step cap: a model that never finalizes stops at maxSteps with no answer', async () => {
    // Always proposes a tool call, never a final answer.
    const anthropic = scriptedAnthropic([JSON.stringify({ tool: 'list_tasks', args: {} })]);
    const out = await runAskAgent({ utterance: 'plan my week', ctx, identity, anthropic, maxSteps: 3 });

    expect(out.stoppedAtCap).toBe(true);
    expect(out.answer).toBeUndefined();
    // Exactly maxSteps model turns were taken.
    expect(out.steps.filter((s) => s.kind === 'tool_call').length).toBe(3);
  });

  it('never shows an answer the deterministic guard refuses (peer-named output blocked)', async () => {
    const anthropic = scriptedAnthropic([
      JSON.stringify({ final: 'Priya is behind on her review and it is dragging you down.' }),
    ]);
    const out = await runAskAgent({ utterance: 'how am I doing?', ctx, identity, anthropic, maxSteps: 3 });

    expect(out.answer).toBeUndefined();
    expect(out.blocked?.reason).toBe('names_another_member');
  });

  it('blocks markup even with no cohort roster (belt-and-braces guard on the shown answer)', async () => {
    const anthropic = scriptedAnthropic([JSON.stringify({ final: 'Here is a <script>alert(1)</script> answer' })]);
    const out = await runAskAgent({
      utterance: 'hello',
      ctx,
      identity: { actor: { handle: 'nik', displayName: 'Nik' }, otherMembers: [] },
      anthropic,
      maxSteps: 2,
    });
    expect(out.answer).toBeUndefined();
    expect(out.blocked?.reason).toBe('contains_markup');
  });

  it('degrades to no answer (never throws) when the provider fails', async () => {
    const anthropic = {
      messages: { create: async () => { throw new Error('provider down'); } },
    } as unknown as Anthropic;
    const out = await runAskAgent({ utterance: 'what is left?', ctx, identity, anthropic, maxSteps: 3 });
    expect(out.answer).toBeUndefined();
    expect(out.blocked).toBeUndefined();
  });
});

describe('parseTurn', () => {
  it('reads a tool call, a final answer, and falls back to prose', () => {
    expect(parseTurn('{"tool":"list_tasks","args":{"status":"todo"}}')).toEqual({
      toolCall: { name: 'list_tasks', args: { status: 'todo' } },
    });
    expect(parseTurn('{"final":"all done"}')).toEqual({ finalAnswer: 'all done' });
    expect(parseTurn('just some prose')).toEqual({ finalAnswer: 'just some prose' });
  });
});

describe('no-authority invariant (via @conduit/agent directly)', () => {
  it('refuses a side-effecting tool unless allowSideEffects is set', async () => {
    let ran = false;
    const out = await runAgent({
      goal: 'do the thing',
      tools: [
        {
          name: 'mutate',
          description: 'writes something',
          jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
          sideEffecting: true,
          async handler() {
            ran = true;
            return 'done';
          },
        },
      ],
      maxSteps: 2,
      // The model proposes the side-effecting tool, then would answer.
      callModel: async () => ({ toolCall: { name: 'mutate', args: {} } }),
    });
    expect(ran).toBe(false);
    expect(out.steps.some((s) => s.kind === 'tool_error' && s.error.kind === 'side_effect_refused')).toBe(true);
  });
});

describe('the deterministic guard is unchanged and still blocks', () => {
  it('rejects a narrative that names another member', () => {
    const check = checkNarrative(
      'Shipped the parser, then fixed Priya\'s broken migration',
      { handle: 'nik', displayName: 'Nik' },
      [{ handle: 'priya', displayName: 'Priya' }],
    );
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe('names_another_member');
  });
});
