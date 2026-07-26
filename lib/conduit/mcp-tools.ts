import { ToolRegistry, type ConduitTool, type ToolResult } from '@conduit/mcp';
import type { Firestore } from 'firebase-admin/firestore';

/**
 * Pulse's Model Context Protocol tools (see conduit/VENDOR.md, docs/MCP.md).
 *
 * These are READ-ONLY. An MCP client (Claude Desktop, an IDE) can read the cohort's public
 * activity, but the server exposes no tool that writes: it cannot create tasks, publish
 * recipes, or touch the bus. That mirrors Pulse's whole authority model — the agent is a
 * planner with no more power than a signed-in user, and this surface has even less: it only
 * reads what is already cohort-readable.
 *
 * Auth is honored exactly as the app honors it. A read runs through an injected `reader` that
 * the transport binds to a verified identity (an ID-token-derived handle); with no reader bound,
 * the tools return an explicit "auth required" result rather than reading anything. The pure
 * `ToolRegistry` below needs no Firestore and no SDK, so it is unit-testable on its own.
 */

/** The read surface the tools call. The transport binds this to a verified caller; a request
 *  with no verified identity gets `authorized: false` and no data. */
export interface PulseReader {
  authorized: boolean;
  /** The cohort's recent public activity feed items (already cohort-readable). */
  recentActivity(limit: number): Promise<Array<{ handle: string; kind: string; summary: string; at: string }>>;
  /** Public recipes the cohort has published. */
  listRecipes(limit: number): Promise<Array<{ title: string; author: string }>>;
}

const text = (s: string, structured?: unknown): ToolResult => ({
  content: [{ type: 'text', text: s }],
  ...(structured !== undefined ? { structuredContent: structured } : {}),
});

const unauthorized = (): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: 'auth required: no verified Pulse identity is bound to this session' }],
});

/** Build the read-only Pulse MCP tools over an injected, auth-bound reader. */
export function pulseMcpTools(reader: PulseReader): ConduitTool[] {
  return [
    {
      name: 'pulse_recent_activity',
      description:
        "Read the Pulse cohort's recent public activity feed (who shipped or started what). " +
        'Read-only. Honors Pulse auth: returns nothing unless a verified identity is bound.',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } },
        additionalProperties: false,
      },
      async handler(args: { limit?: number }) {
        if (!reader.authorized) return unauthorized();
        const rows = await reader.recentActivity(Math.min(args.limit ?? 20, 50));
        const lines = rows.map((r) => `${r.at} @${r.handle} ${r.kind}: ${r.summary}`);
        return text(lines.join('\n') || '(no recent activity)', rows);
      },
    },
    {
      name: 'pulse_list_recipes',
      description:
        'List recipes the Pulse cohort has published (title and author handle). Read-only. ' +
        'Honors Pulse auth: returns nothing unless a verified identity is bound.',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } },
        additionalProperties: false,
      },
      async handler(args: { limit?: number }) {
        if (!reader.authorized) return unauthorized();
        const rows = await reader.listRecipes(Math.min(args.limit ?? 20, 50));
        const lines = rows.map((r) => `${r.title} by @${r.author}`);
        return text(lines.join('\n') || '(no recipes yet)', rows);
      },
    },
  ];
}

/** Convenience: a registry over the read-only tools. */
export function pulseMcpRegistry(reader: PulseReader): ToolRegistry {
  return new ToolRegistry(pulseMcpTools(reader));
}

/**
 * Bind a live reader over the Admin Firestore, honoring the caller's verified handle.
 * `authorized` reflects whether a handle was verified; the reads only ever touch
 * cohort-readable collections. Best-effort: a Firestore error yields empty rows, never a throw.
 */
export function firestoreReader(db: Firestore, handle: string | null): PulseReader {
  return {
    authorized: handle !== null,
    async recentActivity(limit) {
      try {
        const snap = await db.collection('pulse').orderBy('at', 'desc').limit(limit).get();
        return snap.docs.map((d) => {
          const v = d.data() as Record<string, unknown>;
          return {
            handle: String(v.handle ?? ''),
            kind: String(v.kind ?? 'event'),
            summary: String(v.summary ?? v.narrative ?? ''),
            at: String(v.at ?? ''),
          };
        });
      } catch {
        return [];
      }
    },
    async listRecipes(limit) {
      try {
        const snap = await db.collection('recipes').limit(limit).get();
        return snap.docs.map((d) => {
          const v = d.data() as Record<string, unknown>;
          return { title: String(v.title ?? v.problem ?? ''), author: String(v.author ?? v.handle ?? '') };
        });
      } catch {
        return [];
      }
    },
  };
}
