import { startStdioServer } from '@conduit/mcp';
import { pulseMcpTools, firestoreReader, type PulseReader } from './mcp-tools';

/**
 * Stdio entry for the Pulse MCP server (see docs/MCP.md).
 *
 * Local MCP clients (Claude Desktop, IDEs) speak stdio. This binds Pulse's read-only tools to
 * an auth-bound reader and connects them over stdio. The MCP SDK is a lazy, optional peer: it is
 * imported only here at call time (via `@conduit/mcp`'s transport), so the pure tool registry
 * stays testable without it. Install `@modelcontextprotocol/sdk` before running this entry.
 *
 * Auth: the reader is authorized only when a verified handle is bound. For the local stdio
 * operator that handle comes from `PULSE_MCP_HANDLE`, resolved against the Admin SDK the same way
 * the app resolves it from an ID token. With no handle and no admin credentials the tools still
 * list, but every call returns "auth required" rather than reading data.
 */
export async function startPulseMcpStdio(): Promise<void> {
  const reader = await buildReader();
  await startStdioServer({
    name: 'pulse',
    version: '0.1.0',
    tools: pulseMcpTools(reader),
  });
}

async function buildReader(): Promise<PulseReader> {
  const handle = process.env.PULSE_MCP_HANDLE ?? null;
  try {
    // Admin SDK is optional here; if it is not configured we return an unauthorized reader.
    const { busDb } = await import('../broker-admin');
    const db = busDb();
    if (db && handle) return firestoreReader(db, handle);
  } catch {
    /* fall through to the unauthorized reader */
  }
  return {
    authorized: false,
    async recentActivity() {
      return [];
    },
    async listRecipes() {
      return [];
    },
  };
}

// Allow `node --import tsx lib/conduit/mcp-stdio.ts` to run the server directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  startPulseMcpStdio().catch((err) => {
    console.error('pulse-mcp failed to start:', err);
    process.exit(1);
  });
}
