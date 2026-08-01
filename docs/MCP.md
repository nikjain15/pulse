# Pulse MCP server

Pulse exposes a small, **read-only** Model Context Protocol server so an MCP client (Claude
Desktop, an IDE) can read the cohort's public activity. It is built on the vendored
`@conduit/mcp` package (see `conduit/VENDOR.md`).

## Tools

| Tool                    | Reads                                          | Arguments                     |
| ----------------------- | ---------------------------------------------- | ----------------------------- |
| `pulse_recent_activity` | The cohort's recent public activity feed.      | `limit?` (integer, 1–50)      |
| `pulse_list_recipes`    | Recipes the cohort has published.              | `limit?` (integer, 1–50)      |

Both are read-only. There is no tool that writes: the server cannot create tasks, publish a
recipe, or touch the shared bus. This is deliberate: it mirrors Pulse's authority model, where
the agent is a planner with no more power than a signed-in user, and the MCP surface has even
less: it only ever reads what is already cohort-readable.

## Auth

The tools call an injected reader that the transport binds to a **verified identity**. When no
verified identity is bound (no `PULSE_MCP_HANDLE`, or no Admin credentials), `tools/list` still
works but every `tools/call` returns an `auth required` error result instead of data. Identity is
never taken from tool arguments.

## Running it (stdio, local clients)

The MCP SDK is an optional peer, loaded lazily only by the transport, so the pure tool registry
stays testable without it. Install it, then run the stdio entry:

```bash
npm i @modelcontextprotocol/sdk tsx
PULSE_MCP_HANDLE=<your-verified-handle> npm run mcp:stdio
```

`@modelcontextprotocol/sdk` (the transport) and `tsx` (to run the TypeScript entry) are optional
peers, installed only when you actually run the server. They are intentionally not project
dependencies, so the pure tool registry and its tests need neither.

Claude Desktop config:

```json
{
  "mcpServers": {
    "pulse": {
      "command": "npm",
      "args": ["run", "mcp:stdio"],
      "env": { "PULSE_MCP_HANDLE": "your-handle" }
    }
  }
}
```

## Roadmap: hosted (HTTP/SSE) transport, not implemented

**Status: design only.** stdio is the one transport you can run today. There is no `app/api/mcp/`
route in this repo, so the URLs below serve nothing yet; they document the intended shape so the
build is a mounting job rather than a redesign.

The building block already exists: `@conduit/mcp` exports `createSseHandler`
(`conduit/packages/mcp/src/http.ts`), and the tool registry is transport-agnostic. The planned
deployment serves that same registry over SSE, mounted behind Pulse's auth so the bound handle comes
from the session rather than an env var. The intended URL shape:

```
GET  https://<pulse-host>/api/mcp/sse       # planned: opens the SSE stream
POST https://<pulse-host>/api/mcp/messages  # planned: posts client -> server messages
```

The design goal is that the tool set and the read-only, auth-honoring contract stay identical across
stdio and hosted; only the transport and the source of the verified identity differ. Next action:
add the `app/api/mcp/` route pair wired to `createSseHandler`, with the handle resolved from the
verified session.
