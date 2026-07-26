import { describe, it, expect } from 'vitest';
import { pulseMcpRegistry, type PulseReader } from '@/lib/conduit/mcp-tools';

/** A fake reader standing in for the auth-bound Firestore reader. */
function reader(authorized: boolean): PulseReader {
  return {
    authorized,
    async recentActivity(limit) {
      return [
        { handle: 'nik', kind: 'shipped', summary: 'the parser', at: '2026-07-25' },
        { handle: 'priya', kind: 'started', summary: 'the migration', at: '2026-07-24' },
      ].slice(0, limit);
    },
    async listRecipes(limit) {
      return [{ title: 'Taming flaky tests', author: 'nik' }].slice(0, limit);
    },
  };
}

describe('Pulse MCP registry', () => {
  it('lists the read-only tools, sorted, with input schemas', () => {
    const list = pulseMcpRegistry(reader(true)).list();
    expect(list.map((t) => t.name)).toEqual(['pulse_list_recipes', 'pulse_recent_activity']);
    for (const t of list) {
      expect(t.inputSchema.type).toBe('object');
      expect(typeof t.description).toBe('string');
    }
  });

  it('calls a tool and returns text + structured content', async () => {
    const outcome = await pulseMcpRegistry(reader(true)).call('pulse_recent_activity', { limit: 2 });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.content[0].text).toContain('@nik shipped: the parser');
      expect(Array.isArray(outcome.result.structuredContent)).toBe(true);
    }
  });

  it('honors auth: an unbound identity gets an error result, not data', async () => {
    const outcome = await pulseMcpRegistry(reader(false)).call('pulse_recent_activity', {});
    expect(outcome.ok).toBe(true); // registry call succeeded...
    if (outcome.ok) {
      expect(outcome.result.isError).toBe(true); // ...but the tool refused.
      expect(outcome.result.content[0].text).toContain('auth required');
    }
  });

  it('validates arguments (limit out of range is rejected before the handler)', async () => {
    const outcome = await pulseMcpRegistry(reader(true)).call('pulse_recent_activity', { limit: 999 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('invalid_arguments');
  });

  it('rejects an unknown tool', async () => {
    const outcome = await pulseMcpRegistry(reader(true)).call('pulse_delete_everything', {});
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('unknown_tool');
  });
});
