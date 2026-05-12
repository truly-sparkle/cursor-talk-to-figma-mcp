# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP (Model Context Protocol) server that bridges Cursor AI IDE / Claude Code with Figma. Three components communicate in a pipeline:

```
Cursor / Claude Code ←(stdio)→ MCP Server ←(WebSocket)→ WebSocket Relay ←(WebSocket)→ Figma Plugin
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

There is **no test suite or linter configured** (BL-031, BL-059 in backlog).
Plugin runtime ES compatibility is the most common foot-gun — see Patterns.

## Architecture

### MCP Server (`src/talk_to_figma_mcp/server.ts`, ~3,800 lines)
The main server implementing the MCP protocol via `@modelcontextprotocol/sdk`. Exposes **80+ tools** across these areas:
- Read: get_document_info, get_node(s)_info, read_my_design, get_styles, get_variable_collections, get_variables, get_annotations, get_local_components, get_reactions
- Create: create_rectangle, create_frame, create_text, create_component_from_node, create_component_set, create_component_instance
- Mutate: set_fill_color, set_image_fill, set_stroke_color, set_text_content, set_text_style, set_corner_radius, set_effects, set_opacity, set_visible, set_locked, set_blend_mode, rename_node, resize_node, move_node, reparent_node, clone_node, delete_node(s), bind_node_variable, set_component_property, etc.
- Auto-layout: set_layout_mode, set_padding, set_axis_align, set_layout_sizing, set_item_spacing
- Variables (design tokens): create_variable_collection, create_variable, set_variable_value, add/rename/remove_variable_mode, set_variable_alias
- Styles: create_paint/text/effect/grid_style, apply_style, rename_style, delete_style
- Export & misc: export_node_as_image, scan_text_nodes, scan_nodes_by_types, set_focus, set_selections

Server-side response shaping was removed (BL-060) — plugin's `filterFigmaNode` is the single source of truth. Server is a raw passthrough.

Each request gets a UUID, is tracked in a `pendingRequests` Map with timeout callbacks, and resolves when the plugin responds.

### WebSocket Relay (`src/socket.ts`, ~250 lines)
Lightweight Bun WebSocket server on port 3055 (configurable via `PORT` env). Routes messages between MCP server and Figma plugin using channel-based isolation. Clients call `join` to enter a channel; messages broadcast only within the same channel.

Channel names validated against `^[a-zA-Z0-9_-]{1,64}$` (BL-004). Optional shared-secret token via `FIGMA_RELAY_TOKEN` env (BL-005, constant-time compare).

### Figma Plugin (`src/cursor_mcp_plugin/`, code.js ~4,300 lines)
Runs inside Figma. `code.js` is the plugin main thread handling 80+ commands via a dispatcher. `ui.html` is the plugin UI for WebSocket connection management. `manifest.json` declares permissions (dynamic-page access, localhost network). The plugin is **not built/bundled** — `code.js` is written directly as the runtime artifact.

**Plugin runtime ES compatibility** is restrictive. See Patterns below.

## Key Patterns

- **Colors**: Figma uses RGBA 0-1 range. Plugin's `rgbaToHex` (with `channelToByte` clamp helper, BL-061) handles all color → hex conversion before sending responses.
- **Logging**: Server logs go to stderr (stdout reserved for MCP protocol). Plugin uses `Log.{debug,info,warn,error}` helper (BL-038) — new code should use this seam, not `console.*` directly.
- **Timeouts** (BL-007): per-command policy. Default 30s, "long-running" commands (scans, batch ops, exports, instance overrides) start at 5min. Progress updates re-arm a 2min inactivity timer. Override via `FIGMA_TIMEOUT_MS`, `FIGMA_LONG_TIMEOUT_MS`, `FIGMA_INACTIVITY_TIMEOUT_MS` env vars.
- **Chunking**: Large operations (scanning 100+ nodes) are chunked with progress updates to prevent Figma UI freezing. Cycle-guarded with visited Set (BL-029).
- **Reconnection** (BL-042): exponential backoff (2s → 30s, max 10 attempts). Last-active channel auto-rejoined on reconnect.
- **Zod validation**: All tool parameters are validated with Zod schemas.

### Figma plugin runtime ES compatibility ⚠️

**Plugin code.js runs in a restricted JS engine.** ES2018+ features have caused multiple `SyntaxError → plugin doesn't load` regressions:

- ❌ `??` nullish coalescing (BL-049)
- ❌ `{ ...obj, key: val }` object spread (BL-058)
- ❌ Likely also: `?.` optional chaining, `{ a, ...rest }` destructuring rest, `Array.prototype.flat`/`flatMap`, `Object.fromEntries`

**Use instead:**
- `a == null ? fallback : a` for nullish coalescing
- `Object.assign({}, obj, { key: val })` for object spread
- Plain index access for optional chaining

This is the most common foot-gun in this codebase. BL-059 will add `eslint-plugin-es-x` to catch these at lint time.

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | 3055 | Relay listen port |
| `FIGMA_TIMEOUT_MS` | 30000 | Default command timeout |
| `FIGMA_LONG_TIMEOUT_MS` | 300000 | Long-running command timeout (5min) |
| `FIGMA_INACTIVITY_TIMEOUT_MS` | 120000 | Inactivity timeout after first progress (2min) |
| `FIGMA_RELAY_TOKEN` | (unset) | Optional relay shared secret (BL-005) |

## Backlog Workflow

Single source of truth: `docs/backlog.html` (single HTML file with `const DATA` inline JS). Not in git (`docs/` ignored). Tickets are `BL-NNN` format; each ticket = one git commit with `BL-NNN: short summary` prefix.

Sequence: edit `status: "todo" → "doing"` → code → `"done", completedAt: "..."` → commit. See `docs/backlog.html` for the full board.

## Setup

1. Run `bun setup` — installs dependencies and writes MCP config for both Cursor (`.cursor/mcp.json`) and Claude Code (`.mcp.json`)
2. `bun socket` in one terminal (WebSocket relay)
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
