# AGENTS.md

This file provides guidance to Claude Code agents (claude.ai/code) when working with code in this repository.

## Project Overview

MCP (Model Context Protocol) server that bridges AI agents (Cursor, Claude Code) with Figma. Three components communicate in a pipeline:

```
Claude Code / Cursor ←(stdio)→ MCP Server ←(WebSocket)→ WebSocket Relay ←(WebSocket)→ Figma Plugin
```

## Build & Development Commands

```bash
bun install              # Install dependencies
bun run build            # Build MCP server (tsup → dist/, dist not in git)
bun run dev              # Build in watch mode
bun socket               # Start WebSocket relay server (port 3055)
bun run start            # Run built MCP server
bun setup                # Full setup (install + write .cursor/mcp.json + .mcp.json)
```

There is **no test suite or linter configured yet** (BL-031, BL-059 in backlog).

## Architecture

### MCP Server (`src/talk_to_figma_mcp/server.ts`, ~3,800 lines)
Implements the MCP protocol via `@modelcontextprotocol/sdk`. Exposes **80+ tools**:
- **Read**: get_document_info, get_node(s)_info, read_my_design, get_styles, get_variable_collections, get_variables, get_annotations, get_local_components, get_reactions
- **Create**: create_rectangle, create_frame, create_text, create_component_from_node, create_component_set, create_component_instance
- **Mutate**: set_fill_color, set_image_fill, set_stroke_color, set_text_content, set_text_style, set_corner_radius, set_effects, set_opacity/visible/locked/blend_mode, rename_node, resize_node, move_node, reparent_node, clone_node, delete_node(s), bind_node_variable, set_component_property, …
- **Auto-layout**: set_layout_mode, set_padding, set_axis_align, set_layout_sizing, set_item_spacing
- **Variables (design tokens)**: create_variable_collection, create_variable, set_variable_value, add/rename/remove_variable_mode, set_variable_alias
- **Styles**: create_paint/text/effect/grid_style, apply_style, rename_style, delete_style
- **Export & misc**: export_node_as_image, scan_text_nodes, scan_nodes_by_types, set_focus, set_selections

Server-side response shaping was removed (BL-060) — plugin's `filterFigmaNode` is the single source of truth. Server is a raw passthrough.

Each request gets a UUID, is tracked in a `pendingRequests` Map with timeout callbacks, and resolves when the plugin responds.

### WebSocket Relay (`src/socket.ts`, ~250 lines)
Lightweight Bun WebSocket server on port 3055 (configurable via `PORT` env). Routes messages between MCP server and Figma plugin using channel-based isolation. Channel names validated against `^[a-zA-Z0-9_-]{1,64}$` (BL-004). Optional shared-secret token via `FIGMA_RELAY_TOKEN` env (BL-005).

### Figma Plugin (`src/cursor_mcp_plugin/`, code.js ~4,300 lines)
`code.js` handles 80+ commands via a dispatcher. `ui.html` is the connection UI. `manifest.json` declares permissions. The plugin is **not built/bundled** — `code.js` is the runtime artifact directly. **Plugin runtime ES compatibility is restrictive — see Patterns.**

## Key Patterns

- **Colors**: Figma uses RGBA 0-1 range. Plugin's `rgbaToHex` (with `channelToByte` clamp helper, BL-006/BL-061) handles all color → hex conversion in responses.
- **Logging**: Server logs go to stderr (stdout reserved for MCP). Plugin uses `Log.{debug,info,warn,error}` helper (BL-038) — new code should use this seam, not `console.*` directly.
- **Timeouts** (BL-007): per-command policy. Default 30s; "long-running" commands (scans, batch ops, exports, instance overrides) start at 5min. Progress updates re-arm a 2min inactivity timer. Override via env vars below.
- **Chunking**: Large operations (scanning 100+ nodes) chunked with progress updates. Cycle-guarded with visited Set (BL-029).
- **Reconnection** (BL-042): exponential backoff (2s → 30s, max 10 attempts). Last-active channel auto-rejoined on reconnect.
- **Zod validation**: All tool parameters validated with Zod schemas.

### ⚠️ Figma plugin runtime ES compatibility

Plugin code.js runs in a restricted JS engine. ES2018+ features have caused multiple `SyntaxError → plugin doesn't load` regressions:

- ❌ `??` nullish coalescing (BL-049)
- ❌ `{ ...obj, key: val }` object spread (BL-058)
- ❌ Likely also: `?.` optional chaining, `{ a, ...rest }` destructuring rest, `Array.prototype.flat`/`flatMap`, `Object.fromEntries`

Use instead:
- `a == null ? fallback : a` for nullish coalescing
- `Object.assign({}, obj, { key: val })` for object spread
- Plain index access for optional chaining

This is the most common foot-gun. BL-059 will add `eslint-plugin-es-x` to catch at lint time.

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | 3055 | Relay listen port |
| `FIGMA_TIMEOUT_MS` | 30000 | Default command timeout |
| `FIGMA_LONG_TIMEOUT_MS` | 300000 | Long-running command timeout |
| `FIGMA_INACTIVITY_TIMEOUT_MS` | 120000 | Inactivity timeout after first progress |
| `FIGMA_RELAY_TOKEN` | (unset) | Optional relay shared secret |

## Backlog Workflow

Single source of truth: **`docs/backlog.html`** (single HTML file with `const DATA` inline JS). Not in git (`docs/` ignored).

Tickets are `BL-NNN` format. **Each ticket = one git commit** with `BL-NNN: short summary` prefix.

Sequence:
1. Edit card's `status: "todo"` → `"doing"` in `docs/backlog.html`
2. Code change
3. Edit `status: "done", completedAt: "YYYY-MM-DD"`
4. `git commit -m "BL-NNN: …"`

`meta.nextTicket` in the JSON tracks the next available ticket id.

## Setup

1. Run `bun setup` — installs dependencies and writes MCP config for both Cursor (`.cursor/mcp.json`) and Claude Code (`.mcp.json`)
2. `bun socket` in one terminal (WebSocket relay on port 3055)
3. In Figma: Plugins → Development → Link existing plugin → select `src/cursor_mcp_plugin/manifest.json`
4. Run plugin in Figma, join a channel, then use tools from Cursor or Claude Code

The MCP config written by `bun setup` uses the published package:

```json
{
  "mcpServers": {
    "TalkToFigma": {
      "command": "bunx",
      "args": ["cursor-talk-to-figma-mcp@latest"]
    }
  }
}
```

For local-source MCP server (this fork), use:

```json
{
  "mcpServers": {
    "TalkToFigma": {
      "command": "bun",
      "args": ["/path-to-repo/src/talk_to_figma_mcp/server.ts"]
    }
  }
}
```

You can also add it manually for Claude Code via the CLI:

```bash
claude mcp add TalkToFigma -- bunx cursor-talk-to-figma-mcp@latest
```

## Agent Notes

- Always call `join_channel` before issuing any Figma commands
- Call `get_document_info` first to understand the design structure
- Use `read_my_design` or `get_selection` before making modifications
- Batch operations (`set_multiple_text_contents`, `delete_multiple_nodes`, `set_multiple_annotations`) are preferred over repeated single-node calls
- All MCP tool parameters are Zod-validated; invalid inputs return structured errors
- The plugin and relay must both be running before any tool calls succeed
- After modifying `code.js`, you must re-run the plugin in Figma (Plugins → Development → run again) — plugin code is loaded once per session
- **When editing `code.js`, avoid ES2018+ syntax** (see Patterns above). When editing `server.ts`, modern syntax is fine (Bun/Node target).
