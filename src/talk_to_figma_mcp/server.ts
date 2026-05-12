#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";

// Define TypeScript interfaces for Figma responses
interface FigmaResponse {
  id: string;
  result?: any;
  error?: string;
}

// Define interface for command progress updates
interface CommandProgressUpdate {
  type: 'command_progress';
  commandId: string;
  commandType: string;
  status: 'started' | 'in_progress' | 'completed' | 'error';
  progress: number;
  totalItems: number;
  processedItems: number;
  currentChunk?: number;
  totalChunks?: number;
  chunkSize?: number;
  message: string;
  payload?: any;
  timestamp: number;
}

// Update the getInstanceOverridesResult interface to match the plugin implementation
interface getInstanceOverridesResult {
  success: boolean;
  message: string;
  sourceInstanceId: string;
  mainComponentId: string;
  overridesCount: number;
}

interface setInstanceOverridesResult {
  success: boolean;
  message: string;
  totalCount?: number;
  results?: Array<{
    success: boolean;
    instanceId: string;
    instanceName: string;
    appliedCount?: number;
    message?: string;
  }>;
}

// Custom logging functions that write to stderr instead of stdout to avoid being captured
const logger = {
  info: (message: string) => process.stderr.write(`[INFO] ${message}\n`),
  debug: (message: string) => process.stderr.write(`[DEBUG] ${message}\n`),
  warn: (message: string) => process.stderr.write(`[WARN] ${message}\n`),
  error: (message: string) => process.stderr.write(`[ERROR] ${message}\n`),
  log: (message: string) => process.stderr.write(`[LOG] ${message}\n`)
};

// WebSocket connection and request tracking
let ws: WebSocket | null = null;
const pendingRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  lastActivity: number; // Add timestamp for last activity
}>();

// Track which channel each client is in
let currentChannel: string | null = null;

// Reconnection state
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY_MS = 2000;
const RECONNECT_MAX_DELAY_MS = 30000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;

function shutdown() {
  shuttingDown = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
}
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });

// ---- Per-command timeout policy (BL-007) -----------------------------
//
// Three numbers govern how long we wait for Figma to answer:
//   - default: starting budget for ordinary, fast commands
//   - long:    starting budget for known long-running commands (scans,
//              multi-node ops, full-file exports)
//   - inactivity: once Figma sends its first progress_update, we re-arm
//              this timer; long ops can keep streaming progress and stay
//              alive past `long` so long as they don't go silent.
//
// All three are overridable via env in case a particular plugin or file
// needs more headroom.
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const TIMEOUTS = {
  default:    envInt("FIGMA_TIMEOUT_MS",            30_000),
  long:       envInt("FIGMA_LONG_TIMEOUT_MS",       300_000),  // 5 min
  inactivity: envInt("FIGMA_INACTIVITY_TIMEOUT_MS", 120_000),  // 2 min after last progress
};

// Commands that routinely run long (chunked scans, batch updates, full-file
// reads, big exports). They start with `TIMEOUTS.long` instead of `default`.
const LONG_RUNNING_COMMANDS: ReadonlySet<string> = new Set([
  "scan_text_nodes",
  "scan_nodes_by_types",
  "set_multiple_text_contents",
  "set_multiple_annotations",
  "get_nodes_info",
  "read_my_design",
  "export_node_as_image",
  "get_instance_overrides",
  "set_instance_overrides",
]);

function defaultTimeoutFor(command: string): number {
  return LONG_RUNNING_COMMANDS.has(command) ? TIMEOUTS.long : TIMEOUTS.default;
}
// ---------------------------------------------------------------------

// Create MCP server
const server = new McpServer({
  name: "TalkToFigmaMCP",
  version: "1.0.0",
});

// Add command line argument parsing
const args = process.argv.slice(2);
const serverArg = args.find(arg => arg.startsWith('--server='));
const serverUrl = serverArg ? serverArg.split('=')[1] : 'localhost';
const WS_URL = serverUrl === 'localhost' ? `ws://${serverUrl}` : `wss://${serverUrl}`;

// Document Info Tool
server.tool(
  "get_document_info",
  "Get detailed information about the current Figma document",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_document_info");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting document info: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Selection Tool
server.tool(
  "get_selection",
  "Get information about the current selection in Figma",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_selection");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting selection: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Read My Design Tool
server.tool(
  "read_my_design",
  "Get detailed information about the current selection in Figma, including all node details",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("read_my_design", {});
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting node info: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Node Info Tool
server.tool(
  "get_node_info",
  "Get detailed information about a specific node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to get information about"),
  },
  async ({ nodeId }: any) => {
    try {
      const result = await sendCommandToFigma("get_node_info", { nodeId });
      return {
        content: [
          {
            type: "text",
            // The plugin already runs filterFigmaNode (see code.js): hex-converts
            // colors, normalizes imageRef→imageHash, and strips boundVariables.
            // Server-side post-processing was a duplicate of that pipeline.
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting node info: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Note: filterFigmaNode + rgbaToHex + channelToByte (BL-006) used to live
// here as a server-side normalization layer. They were dead code: the
// plugin's own filterFigmaNode (code.js) already hex-converts colors,
// normalizes imageRef→imageHash, and strips boundVariables before sending
// the response. Removed in BL-060. The plugin is now the single source of
// truth for response shaping.

// Nodes Info Tool
server.tool(
  "get_nodes_info",
  "Get detailed information about multiple nodes in Figma",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to get information about")
  },
  async ({ nodeIds }: any) => {
    try {
      const results = await Promise.all(
        nodeIds.map(async (nodeId: any) => {
          const result = await sendCommandToFigma('get_node_info', { nodeId });
          return { nodeId, info: result };
        })
      );
      return {
        content: [
          {
            type: "text",
            // See BL-060: server-side filterFigmaNode removed — plugin
            // already shapes the response.
            text: JSON.stringify(results.map((result) => result.info))
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting nodes info: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);


// Create Rectangle Tool
server.tool(
  "create_rectangle",
  "Create a new rectangle in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    width: z.number().describe("Width of the rectangle"),
    height: z.number().describe("Height of the rectangle"),
    name: z.string().optional().describe("Optional name for the rectangle"),
    parentId: z
      .string()
      .optional()
      .describe("Optional parent node ID to append the rectangle to"),
  },
  async ({ x, y, width, height, name, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_rectangle", {
        x,
        y,
        width,
        height,
        name: name || "Rectangle",
        parentId,
      });
      return {
        content: [
          {
            type: "text",
            text: `Created rectangle "${JSON.stringify(result)}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating rectangle: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Create Frame Tool
server.tool(
  "create_frame",
  "Create a new frame in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    width: z.number().describe("Width of the frame"),
    height: z.number().describe("Height of the frame"),
    name: z.string().optional().describe("Optional name for the frame"),
    parentId: z
      .string()
      .optional()
      .describe("Optional parent node ID to append the frame to"),
    fillColor: z
      .object({
        r: z.number().min(0).max(1).describe("Red component (0-1)"),
        g: z.number().min(0).max(1).describe("Green component (0-1)"),
        b: z.number().min(0).max(1).describe("Blue component (0-1)"),
        a: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Alpha component (0-1)"),
      })
      .optional()
      .describe("Fill color in RGBA format"),
    strokeColor: z
      .object({
        r: z.number().min(0).max(1).describe("Red component (0-1)"),
        g: z.number().min(0).max(1).describe("Green component (0-1)"),
        b: z.number().min(0).max(1).describe("Blue component (0-1)"),
        a: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Alpha component (0-1)"),
      })
      .optional()
      .describe("Stroke color in RGBA format"),
    strokeWeight: z.number().positive().optional().describe("Stroke weight"),
    layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).optional().describe("Auto-layout mode for the frame"),
    layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional().describe("Whether the auto-layout frame wraps its children"),
    paddingTop: z.number().optional().describe("Top padding for auto-layout frame"),
    paddingRight: z.number().optional().describe("Right padding for auto-layout frame"),
    paddingBottom: z.number().optional().describe("Bottom padding for auto-layout frame"),
    paddingLeft: z.number().optional().describe("Left padding for auto-layout frame"),
    primaryAxisAlignItems: z
      .enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"])
      .optional()
      .describe("Primary axis alignment for auto-layout frame. Note: When set to SPACE_BETWEEN, itemSpacing will be ignored as children will be evenly spaced."),
    counterAxisAlignItems: z.enum(["MIN", "MAX", "CENTER", "BASELINE"]).optional().describe("Counter axis alignment for auto-layout frame"),
    layoutSizingHorizontal: z.enum(["FIXED", "HUG", "FILL"]).optional().describe("Horizontal sizing mode for auto-layout frame"),
    layoutSizingVertical: z.enum(["FIXED", "HUG", "FILL"]).optional().describe("Vertical sizing mode for auto-layout frame"),
    itemSpacing: z
      .number()
      .optional()
      .describe("Distance between children in auto-layout frame. Note: This value will be ignored if primaryAxisAlignItems is set to SPACE_BETWEEN.")
  },
  async ({
    x,
    y,
    width,
    height,
    name,
    parentId,
    fillColor,
    strokeColor,
    strokeWeight,
    layoutMode,
    layoutWrap,
    paddingTop,
    paddingRight,
    paddingBottom,
    paddingLeft,
    primaryAxisAlignItems,
    counterAxisAlignItems,
    layoutSizingHorizontal,
    layoutSizingVertical,
    itemSpacing
  }: any) => {
    try {
      const result = await sendCommandToFigma("create_frame", {
        x,
        y,
        width,
        height,
        name: name || "Frame",
        parentId,
        fillColor: fillColor || { r: 1, g: 1, b: 1, a: 1 },
        strokeColor: strokeColor,
        strokeWeight: strokeWeight,
        layoutMode,
        layoutWrap,
        paddingTop,
        paddingRight,
        paddingBottom,
        paddingLeft,
        primaryAxisAlignItems,
        counterAxisAlignItems,
        layoutSizingHorizontal,
        layoutSizingVertical,
        itemSpacing
      });
      const typedResult = result as { name: string; id: string };
      return {
        content: [
          {
            type: "text",
            text: `Created frame "${typedResult.name}" with ID: ${typedResult.id}. Use the ID as the parentId to appendChild inside this frame.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating frame: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Create Text Tool
server.tool(
  "create_text",
  "Create a new text element in Figma",
  {
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    text: z.string().describe("Text content"),
    fontSize: z.number().optional().describe("Font size (default: 14)"),
    fontWeight: z
      .number()
      .optional()
      .describe("Font weight (e.g., 400 for Regular, 700 for Bold)"),
    fontColor: z
      .object({
        r: z.number().min(0).max(1).describe("Red component (0-1)"),
        g: z.number().min(0).max(1).describe("Green component (0-1)"),
        b: z.number().min(0).max(1).describe("Blue component (0-1)"),
        a: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Alpha component (0-1)"),
      })
      .optional()
      .describe("Font color in RGBA format"),
    name: z
      .string()
      .optional()
      .describe("Semantic layer name for the text node"),
    parentId: z
      .string()
      .optional()
      .describe("Optional parent node ID to append the text to"),
  },
  async ({ x, y, text, fontSize, fontWeight, fontColor, name, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_text", {
        x,
        y,
        text,
        fontSize: fontSize || 14,
        fontWeight: fontWeight || 400,
        fontColor: fontColor || { r: 0, g: 0, b: 0, a: 1 },
        name: name || "Text",
        parentId,
      });
      const typedResult = result as { name: string; id: string };
      return {
        content: [
          {
            type: "text",
            text: `Created text "${typedResult.name}" with ID: ${typedResult.id}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating text: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Set Fill Color Tool
server.tool(
  "set_fill_color",
  "Set the fill color of a node in Figma can be TextNode or FrameNode",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    r: z.number().min(0).max(1).describe("Red component (0-1)"),
    g: z.number().min(0).max(1).describe("Green component (0-1)"),
    b: z.number().min(0).max(1).describe("Blue component (0-1)"),
    a: z.number().min(0).max(1).optional().describe("Alpha component (0-1)"),
  },
  async ({ nodeId, r, g, b, a }: any) => {
    try {
      const result = await sendCommandToFigma("set_fill_color", {
        nodeId,
        color: { r, g, b, a: a || 1 },
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Set fill color of node "${typedResult.name
              }" to RGBA(${r}, ${g}, ${b}, ${a || 1})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting fill color: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Set Image Fill Tool
server.tool(
  "set_image_fill",
  "Set an image fill on a node. Provide either imageHash (reuse an image already in this Figma file — typically obtained from another node's fills via get_node_info) or imageBytes (base64-encoded image). Useful for moving an image rectangle's content into a placeholder frame, or replacing a placeholder's fill with an image.",
  {
    nodeId: z.string().describe("The ID of the node whose fill to set"),
    imageHash: z.string().optional().describe("Hash of an image already present in this Figma file"),
    imageBytes: z.string().optional().describe("Base64-encoded image bytes (PNG/JPG/GIF/WEBP). Data-URL prefix accepted."),
    scaleMode: z.enum(["FILL", "FIT", "CROP", "TILE"]).optional().describe("How the image is sized in the frame (default FILL)"),
    opacity: z.number().min(0).max(1).optional().describe("Fill opacity 0-1 (default 1)"),
    rotation: z.number().optional().describe("Image rotation in degrees (default 0; ignored for CROP)"),
    replace: z.boolean().optional().describe("If true (default), replaces existing fills. If false, appends on top."),
  },
  async ({ nodeId, imageHash, imageBytes, scaleMode, opacity, rotation, replace }: any) => {
    if (!imageHash && !imageBytes) {
      return {
        content: [{ type: "text", text: "Error: provide either imageHash or imageBytes" }],
      };
    }
    try {
      const result = await sendCommandToFigma("set_image_fill", {
        nodeId,
        imageHash,
        imageBytes,
        scaleMode,
        opacity,
        rotation,
        replace,
      });
      const typed = result as { name: string; imageHash: string; scaleMode: string };
      return {
        content: [
          {
            type: "text",
            text: `Set image fill on "${typed.name}" — hash: ${typed.imageHash}, scaleMode: ${typed.scaleMode}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting image fill: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Reparent Node Tool
server.tool(
  "reparent_node",
  "Move a node into a different parent (frame, group, page, etc.). Unlike move_node (which only changes coordinates), this changes parentage. Useful for placing an existing node inside a placeholder frame.",
  {
    nodeId: z.string().describe("The ID of the node to move"),
    newParentId: z.string().describe("The ID of the target parent container"),
    index: z.number().int().nonnegative().optional().describe("Insertion index among the parent's children (default: append at end)"),
    preservePosition: z.boolean().optional().describe("If true (default), preserves the node's absolute on-canvas position by adjusting its local x/y after reparenting. Ignored when the new parent uses auto-layout."),
  },
  async ({ nodeId, newParentId, index, preservePosition }: any) => {
    try {
      const result = await sendCommandToFigma("reparent_node", {
        nodeId,
        newParentId,
        index,
        preservePosition,
      });
      const typed = result as { name: string; parentId: string; index: number };
      return {
        content: [
          {
            type: "text",
            text: `Reparented "${typed.name}" into ${typed.parentId} at index ${typed.index}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error reparenting node: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Effects Tool
server.tool(
  "set_effects",
  "Replace (or append) the effect stack on a node: drop shadow, inner shadow, layer blur, background blur.",
  {
    nodeId: z.string().describe("The ID of the node"),
    effects: z.array(z.object({
      type: z.enum(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR"]),
      color: z.object({
        r: z.number().min(0).max(1),
        g: z.number().min(0).max(1),
        b: z.number().min(0).max(1),
        a: z.number().min(0).max(1).optional(),
      }).optional().describe("Required for shadow types. Default a=0.25 if omitted."),
      offset: z.object({ x: z.number(), y: z.number() }).optional().describe("Shadow offset; default {0,0}"),
      radius: z.number().nonnegative().optional().describe("Blur radius / shadow blur; required for blurs"),
      spread: z.number().optional().describe("Shadow spread; ignored for blurs"),
      blendMode: z.string().optional().describe("Default NORMAL"),
      visible: z.boolean().optional().describe("Default true"),
    })).describe("Effect stack (in render order)"),
    append: z.boolean().optional().describe("If true, append to existing effects instead of replacing (default false)"),
  },
  async ({ nodeId, effects, append }: any) => {
    try {
      const result = await sendCommandToFigma("set_effects", { nodeId, effects, append });
      const typed = result as { name: string; effects: any[] };
      return {
        content: [
          {
            type: "text",
            text: `Set ${typed.effects.length} effect(s) on "${typed.name}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting effects: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Text Style Tool
server.tool(
  "set_text_style",
  "Set font and paragraph properties on a text node. Complements set_text_content (which only changes the string). All fields are optional — only the provided ones are applied.",
  {
    nodeId: z.string().describe("The ID of the text node"),
    fontFamily: z.string().optional().describe("e.g. 'Inter'"),
    fontStyle: z.string().optional().describe("e.g. 'Regular', 'Bold', 'Medium Italic'"),
    fontSize: z.number().positive().optional(),
    letterSpacing: z.union([
      z.number(),
      z.object({ value: z.number(), unit: z.enum(["PIXELS", "PERCENT"]) }),
    ]).optional().describe("A bare number is treated as PIXELS"),
    lineHeight: z.union([
      z.number(),
      z.literal("AUTO"),
      z.object({ value: z.number(), unit: z.enum(["PIXELS", "PERCENT"]) }),
    ]).optional().describe("A bare number is treated as PIXELS; 'AUTO' for default"),
    textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"]).optional(),
    textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(),
    textAlignHorizontal: z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional(),
    textAlignVertical: z.enum(["TOP", "CENTER", "BOTTOM"]).optional(),
    paragraphSpacing: z.number().nonnegative().optional(),
    paragraphIndent: z.number().nonnegative().optional(),
  },
  async (args: any) => {
    try {
      const result = await sendCommandToFigma("set_text_style", args);
      const typed = result as { name: string; fontName: any; fontSize: any };
      return {
        content: [
          {
            type: "text",
            text: `Updated text style on "${typed.name}" — font: ${JSON.stringify(typed.fontName)}, size: ${typed.fontSize}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting text style: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// ---- Tool wrappers (BL-027) ---------------------------------------
//
// Common tool-handler pattern: send to Figma, format result on success,
// uniform error envelope on failure. New tools should use wrapToolHandler;
// the three nodePropTool / variableTool / styleTool aliases below remain
// for backward compatibility but delegate to it.
//
// Existing 60+ tools that hand-roll try/catch with bespoke error strings
// are not migrated wholesale here — they continue to work. Migrate
// opportunistically when touching a tool. The shared envelope:
//   { content: [{ type: "text", text: "Error in <name>: <message>" }, ...] }
//
// `verbose: true` appends a pretty-printed JSON of the result for
// debugging-friendly tools (variables, styles).
type ToolWrapOpts = { verbose?: boolean };

function mcpTextEnvelope(...texts: string[]) {
  return { content: texts.map((text) => ({ type: "text" as const, text })) };
}

function formatToolError(toolName: string, error: unknown): string {
  return `Error in ${toolName}: ${error instanceof Error ? error.message : String(error)}`;
}

function wrapToolHandler(
  name: string,
  description: string,
  paramSchema: Record<string, any>,
  successText: (typed: any) => string,
  opts: ToolWrapOpts = {},
) {
  server.tool(name, description, paramSchema, async (args: any) => {
    try {
      const result = await sendCommandToFigma(name as any, args);
      const lines = [successText(result)];
      if (opts.verbose) lines.push(JSON.stringify(result, null, 2));
      return mcpTextEnvelope(...lines);
    } catch (error) {
      return mcpTextEnvelope(formatToolError(name, error));
    }
  });
}

// ---- Trivial node-property tools ---------------------------------

// Backward-compat alias. New code should use wrapToolHandler directly.
function nodePropTool(
  name: string,
  description: string,
  paramSchema: Record<string, any>,
  successText: (typed: any) => string,
) {
  wrapToolHandler(name, description, paramSchema, successText);
}

nodePropTool(
  "rename_node",
  "Rename a node (sets node.name).",
  {
    nodeId: z.string().describe("The ID of the node"),
    name: z.string().min(1).describe("New name (non-empty)"),
  },
  (r: any) => `Renamed node ${r.id} to "${r.name}" (${r.type})`,
);

nodePropTool(
  "set_opacity",
  "Set node opacity (0-1). Clamps out-of-range values.",
  {
    nodeId: z.string().describe("The ID of the node"),
    opacity: z.number().min(0).max(1).describe("Opacity 0-1"),
  },
  (r: any) => `Set opacity of "${r.name}" to ${r.opacity}`,
);

nodePropTool(
  "set_visible",
  "Show or hide a node (sets node.visible).",
  {
    nodeId: z.string().describe("The ID of the node"),
    visible: z.boolean().describe("true to show, false to hide"),
  },
  (r: any) => `Set "${r.name}" visible: ${r.visible}`,
);

nodePropTool(
  "set_locked",
  "Lock or unlock a node (sets node.locked).",
  {
    nodeId: z.string().describe("The ID of the node"),
    locked: z.boolean().describe("true to lock, false to unlock"),
  },
  (r: any) => `Set "${r.name}" locked: ${r.locked}`,
);

nodePropTool(
  "set_blend_mode",
  "Set node blend mode. PASS_THROUGH only valid for groups/frames.",
  {
    nodeId: z.string().describe("The ID of the node"),
    blendMode: z.enum([
      "PASS_THROUGH", "NORMAL",
      "DARKEN", "MULTIPLY", "LINEAR_BURN", "COLOR_BURN",
      "LIGHTEN", "SCREEN", "LINEAR_DODGE", "COLOR_DODGE",
      "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT",
      "DIFFERENCE", "EXCLUSION",
      "HUE", "SATURATION", "COLOR", "LUMINOSITY",
    ]).describe("Blend mode"),
  },
  (r: any) => `Set "${r.name}" blendMode: ${r.blendMode}`,
);

wrapToolHandler(
  "add_fill",
  "Append a paint to a node's fills (or insert at index). Existing fills are preserved. " +
  "SOLID paints get color clamped 0-1; GRADIENT/IMAGE paints pass through (caller supplies valid shape).",
  {
    nodeId: z.string(),
    paint: z.any().describe("Paint object: { type:'SOLID', color:{r,g,b}, opacity? } or GRADIENT/IMAGE shape"),
    index: z.number().int().nonnegative().optional().describe("Insertion index (default: append at end)"),
  },
  (r: any) => `Added fill to "${r.name}" (now ${r.fills.length} fill(s))`,
);

wrapToolHandler(
  "remove_fill_at",
  "Remove the fill at the given index from a node's fills array. Other fills are preserved.",
  {
    nodeId: z.string(),
    index: z.number().int().nonnegative(),
  },
  (r: any) => `Removed fill[${r.removed?.type ?? "?"}] from "${r.name}" (${r.fills.length} remaining)`,
);

// ---- Plugin Data / metadata (BL-026) ------------------------------

wrapToolHandler(
  "set_plugin_data",
  "Store private metadata on a node, scoped to this plugin (figma.setPluginData). " +
  "Values must be strings — JSON.stringify objects first. Empty value deletes the key.",
  {
    nodeId: z.string(),
    key: z.string().min(1),
    value: z.string(),
  },
  (r: any) => r.deleted
    ? `Deleted plugin data ${r.key} on ${r.id}`
    : `Set plugin data ${r.key} on ${r.id} (${r.valueLength} chars)`,
);

wrapToolHandler(
  "get_plugin_data",
  "Read private plugin data from a node. Returns empty string if the key doesn't exist.",
  {
    nodeId: z.string(),
    key: z.string().min(1),
  },
  (r: any) => `${r.key} = ${JSON.stringify(r.value)}`,
);

wrapToolHandler(
  "set_shared_plugin_data",
  "Store metadata visible to other plugins (figma.setSharedPluginData). Namespaced by `namespace`. " +
  "Use this when multiple tools need to share data on the same node. Empty value deletes.",
  {
    nodeId: z.string(),
    namespace: z.string().min(1).describe("Shared namespace (e.g. your plugin id or org)"),
    key: z.string().min(1),
    value: z.string(),
  },
  (r: any) => r.deleted
    ? `Deleted shared data ${r.namespace}/${r.key} on ${r.id}`
    : `Set shared data ${r.namespace}/${r.key} on ${r.id} (${r.valueLength} chars)`,
);

wrapToolHandler(
  "get_shared_plugin_data",
  "Read shared plugin data by namespace + key. Returns empty string if missing.",
  {
    nodeId: z.string(),
    namespace: z.string().min(1),
    key: z.string().min(1),
  },
  (r: any) => `${r.namespace}/${r.key} = ${JSON.stringify(r.value)}`,
);

// ---- FigJam nodes (BL-035) ----------------------------------------
// All three tools require the file to be a FigJam document; in a Figma
// design file the underlying API is undefined and the plugin returns
// a clear error.

wrapToolHandler(
  "create_sticky",
  "Create a FigJam sticky note. text optional. authorVisible toggles the author footer.",
  {
    text: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    parentId: z.string().optional().describe("Container to insert into (default: current page)"),
    authorVisible: z.boolean().optional(),
  },
  (r: any) => `Created sticky "${r.id}" at (${r.x}, ${r.y})`,
);

wrapToolHandler(
  "create_shape_with_text",
  "Create a FigJam shape-with-text (flowchart shape with embedded label). " +
  "shapeType: SQUARE | ELLIPSE | ROUNDED_RECTANGLE | DIAMOND | TRIANGLE_UP | TRIANGLE_DOWN | " +
  "PARALLELOGRAM_RIGHT | PARALLELOGRAM_LEFT | TRAPEZOID | HEXAGON | " +
  "PREDEFINED_PROCESS | DOCUMENT_SINGLE | DOCUMENT_MULTIPLE | MANUAL_INPUT | SHIELD | " +
  "ENG_DATABASE | ENG_QUEUE | ENG_FILE | ENG_FOLDER | " +
  "CHEVRON_RIGHT_ARROW | CHEVRON_RIGHT_DOUBLE_ARROW | CHEVRON_LEFT_ARROW | FLOWCHART_PROCESS",
  {
    shapeType: z.string().optional().describe("Default SQUARE"),
    text: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    parentId: z.string().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
  },
  (r: any) => `Created shape-with-text (${r.shapeType}) "${r.id}"`,
);

wrapToolHandler(
  "create_table",
  "Create a FigJam table with `rows` × `cols` cells. Default 2×2.",
  {
    rows: z.number().int().positive().optional(),
    cols: z.number().int().positive().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    parentId: z.string().optional(),
  },
  (r: any) => `Created table ${r.numRows}×${r.numColumns} "${r.id}"`,
);

wrapToolHandler(
  "get_viewport_bounds",
  "Read the current Figma viewport: center (canvas coords), zoom factor, and visible bounds rect.",
  {},
  (r: any) => `Viewport: center (${r.center.x}, ${r.center.y}), zoom ${r.zoom}`,
);

wrapToolHandler(
  "set_viewport_zoom",
  "Set viewport zoom level (positive number, typical range 0.02-256).",
  { zoom: z.number().positive() },
  (r: any) => `Viewport zoom set to ${r.zoom}`,
);

wrapToolHandler(
  "set_viewport_center",
  "Set viewport center to canvas coordinates (x, y).",
  { x: z.number(), y: z.number() },
  (r: any) => `Viewport centered at (${r.center.x}, ${r.center.y})`,
);

wrapToolHandler(
  "scroll_and_zoom_into_view",
  "Frame one or more nodes in the viewport (figma.viewport.scrollAndZoomIntoView).",
  { nodeIds: z.array(z.string()).min(1) },
  (r: any) => `Framed ${r.framedNodeCount} node(s); center (${r.center.x}, ${r.center.y}), zoom ${r.zoom}`,
);

wrapToolHandler(
  "set_image_filters",
  "Adjust an IMAGE paint's filters: exposure, contrast, saturation, temperature, tint, highlights, shadows. " +
  "Each value is -1..1 (clamped). Only specified keys change; others are preserved.",
  {
    nodeId: z.string(),
    filters: z.object({
      exposure: z.number().min(-1).max(1).optional(),
      contrast: z.number().min(-1).max(1).optional(),
      saturation: z.number().min(-1).max(1).optional(),
      temperature: z.number().min(-1).max(1).optional(),
      tint: z.number().min(-1).max(1).optional(),
      highlights: z.number().min(-1).max(1).optional(),
      shadows: z.number().min(-1).max(1).optional(),
    }),
    paintIndex: z.number().int().nonnegative().optional().describe("Paint index in fills/strokes (default 0)"),
    target: z.enum(["fills", "strokes"]).optional().describe("Default 'fills'"),
  },
  (r: any) => `Set image filters on "${r.name}" ${r.target}[${r.paintIndex}]`,
);

wrapToolHandler(
  "get_image_bytes_by_hash",
  "Read an image's raw bytes from a Figma file by its imageHash, returned as base64. " +
  "Useful for re-uploading an image to another node, exporting outside Figma, or hash-based deduplication checks.",
  {
    imageHash: z.string(),
  },
  (r: any) => `Got ${r.byteLength} bytes for image ${r.imageHash}`,
);

wrapToolHandler(
  "set_constraints",
  "Set constraint behavior on a non-auto-layout child. " +
  "horizontal/vertical each accept: MIN | MAX | CENTER | STRETCH | SCALE. " +
  "Provide one or both — omitted axis is left unchanged.",
  {
    nodeId: z.string().describe("Target node id"),
    horizontal: z.enum(["MIN", "MAX", "CENTER", "STRETCH", "SCALE"]).optional(),
    vertical: z.enum(["MIN", "MAX", "CENTER", "STRETCH", "SCALE"]).optional(),
  },
  (r: any) => `Set constraints on "${r.name}": ${JSON.stringify(r.constraints)}`,
);

// -------------------------------------------------------------------

// ---- Design System: Variables (read) ------------------------------

server.tool(
  "get_variable_collections",
  "List all local Figma Variable collections (design tokens) with their modes and member variable IDs. Foundation for design-system work — call this first to discover collections, then get_variables for the actual values.",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_variable_collections", {});
      const typed = result as { count: number; collections: any[] };
      return {
        content: [
          { type: "text", text: `Found ${typed.count} variable collection(s)` },
          { type: "text", text: JSON.stringify(typed.collections, null, 2) },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching variable collections: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

server.tool(
  "get_variables",
  "List local Figma Variables (design tokens). Optional collectionId filter. COLOR variables are returned with both raw {r,g,b,a} and a hex string for readability. VARIABLE_ALIAS values are flagged so you can resolve aliases.",
  {
    collectionId: z.string().optional().describe("If provided, only variables in this collection are returned"),
  },
  async ({ collectionId }: any) => {
    try {
      const result = await sendCommandToFigma("get_variables", { collectionId });
      const typed = result as { count: number; variables: any[] };
      return {
        content: [
          { type: "text", text: `Found ${typed.count} variable(s)${collectionId ? ` in collection ${collectionId}` : ""}` },
          { type: "text", text: JSON.stringify(typed.variables, null, 2) },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching variables: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// ---- Design System: Variables (write) -----------------------------

// Backward-compat alias. New code should use wrapToolHandler({verbose:true}).
function variableTool(
  name: string,
  description: string,
  paramSchema: Record<string, any>,
  successText: (typed: any) => string,
) {
  wrapToolHandler(name, description, paramSchema, successText, { verbose: true });
}

variableTool(
  "create_variable_collection",
  "Create a new Figma Variable collection. Returns the collection with its auto-generated default modeId — capture this to set values later.",
  {
    name: z.string().min(1).describe("Collection name, e.g. 'colors' or 'spacing'"),
  },
  (r: any) => `Created collection "${r.name}" (id: ${r.id}, defaultModeId: ${r.defaultModeId})`,
);

variableTool(
  "create_variable",
  "Create a Variable inside a collection. Optionally seed an initial value for the collection's default mode.\n" +
  "- COLOR value: { r, g, b, a? } with 0-1 channels\n" +
  "- FLOAT: number\n" +
  "- BOOLEAN: true/false\n" +
  "- STRING: string",
  {
    collectionId: z.string().describe("Target collection id"),
    name: z.string().min(1).describe("Variable name, e.g. 'color/brand/500' (slashes create groups)"),
    type: z.enum(["BOOLEAN", "FLOAT", "STRING", "COLOR"]).describe("Variable type"),
    value: z.union([
      z.boolean(),
      z.number(),
      z.string(),
      z.object({
        r: z.number().min(0).max(1),
        g: z.number().min(0).max(1),
        b: z.number().min(0).max(1),
        a: z.number().min(0).max(1).optional(),
      }),
    ]).optional().describe("Optional initial value for the default mode (type matches `type`)"),
  },
  (r: any) => `Created variable "${r.name}" (${r.resolvedType}, id: ${r.id})`,
);

variableTool(
  "set_variable_value",
  "Set a Variable's value for a specific mode. Value is validated against the variable's resolvedType.",
  {
    variableId: z.string().describe("Variable id"),
    modeId: z.string().describe("Mode id (from the parent collection's modes)"),
    value: z.union([
      z.boolean(),
      z.number(),
      z.string(),
      z.object({
        r: z.number().min(0).max(1),
        g: z.number().min(0).max(1),
        b: z.number().min(0).max(1),
        a: z.number().min(0).max(1).optional(),
      }),
    ]).describe("Value matching the variable's resolvedType"),
  },
  (r: any) => `Set value of "${r.name}" for mode`,
);

variableTool(
  "add_variable_mode",
  "Add a new mode to a variable collection (e.g. 'dark', 'compact'). Returns the new modeId — use it with set_variable_value.",
  {
    collectionId: z.string().describe("Collection id"),
    name: z.string().min(1).describe("Mode name, e.g. 'dark'"),
  },
  (r: any) => `Added mode "${r.name}" (modeId: ${r.modeId})`,
);

variableTool(
  "rename_variable_mode",
  "Rename a mode within a collection.",
  {
    collectionId: z.string().describe("Collection id"),
    modeId: z.string().describe("Mode id to rename"),
    name: z.string().min(1).describe("New mode name"),
  },
  (r: any) => `Renamed mode ${r.modeId} to "${r.name}"`,
);

variableTool(
  "remove_variable_mode",
  "Remove a mode from a collection. The collection must have at least one remaining mode.",
  {
    collectionId: z.string().describe("Collection id"),
    modeId: z.string().describe("Mode id to remove"),
  },
  (_r: any) => `Removed mode`,
);

// ---- Design System: Variables (bind to node) ----------------------

const BIND_FIELDS_DESC =
  "fills | strokes (paint binding via paintIndex/paintProperty) " +
  "OR one of: width, height, minWidth, minHeight, maxWidth, maxHeight, " +
  "cornerRadius, topLeftRadius, topRightRadius, bottomLeftRadius, bottomRightRadius, " +
  "paddingLeft, paddingRight, paddingTop, paddingBottom, " +
  "itemSpacing, counterAxisSpacing, " +
  "fontSize, lineHeight, letterSpacing, paragraphSpacing, paragraphIndent, " +
  "characters, opacity, visible";

variableTool(
  "bind_node_variable",
  "Bind a Variable to a node property. For fills/strokes the variable is attached to a paint at paintIndex (default 0); for everything else it's set on the node directly via setBoundVariable. The variable's resolvedType must match the field (COLOR for paint, FLOAT for sizes/spacing/font, BOOLEAN for visible, STRING for characters).",
  {
    nodeId: z.string().describe("Target node id"),
    field: z.string().describe(BIND_FIELDS_DESC),
    variableId: z.string().describe("Variable id to bind"),
    paintIndex: z.number().int().nonnegative().optional().describe("Paint index for fills/strokes (default 0)"),
    paintProperty: z.enum(["color"]).optional().describe("Paint property for fills/strokes (default 'color')"),
  },
  (r: any) => `Bound ${r.variableId} to ${r.name}.${r.field}`,
);

variableTool(
  "unbind_node_variable",
  "Remove a Variable binding from a node property. Same field set as bind_node_variable.",
  {
    nodeId: z.string().describe("Target node id"),
    field: z.string().describe(BIND_FIELDS_DESC),
    paintIndex: z.number().int().nonnegative().optional().describe("Paint index for fills/strokes (default 0)"),
    paintProperty: z.enum(["color"]).optional().describe("Paint property for fills/strokes (default 'color')"),
  },
  (r: any) => `Unbound variable from ${r.name}.${r.field}`,
);

variableTool(
  "set_variable_alias",
  "Make a variable's value (for one mode) reference another variable, instead of a literal value. " +
  "This is the foundation of token hierarchies — e.g. a 'semantic' token like color/text/primary aliases " +
  "a 'primitive' like color/blue/600. Both variables must have the same resolvedType.",
  {
    variableId: z.string().describe("Source variable id (the one that will hold the alias)"),
    modeId: z.string().describe("Mode id of the source variable to set"),
    targetVariableId: z.string().describe("Target variable id to point at"),
  },
  (r: any) => `Set "${r.name}" mode value → alias of ${r.id}`,
);

// ---- Design System: Styles (create) -------------------------------

// Backward-compat alias. New code should use wrapToolHandler({verbose:true}).
function styleTool(
  name: string,
  description: string,
  paramSchema: Record<string, any>,
  successText: (typed: any) => string,
) {
  wrapToolHandler(name, description, paramSchema, successText, { verbose: true });
}

styleTool(
  "create_paint_style",
  "Create a Paint style (color/gradient/image fill token). Multiple paints are allowed — they stack. " +
  "SOLID paints get color {r,g,b} 0-1 clamping; GRADIENT/IMAGE paints pass through (you must supply valid shape).",
  {
    name: z.string().min(1).describe("Style name, e.g. 'color/brand/primary' (slashes create groups)"),
    paints: z.array(z.any()).describe("Paint array. SOLID: { type:'SOLID', color:{r,g,b}, opacity? }"),
    description: z.string().optional(),
  },
  (r: any) => `Created paint style "${r.name}" (${r.id})`,
);

styleTool(
  "create_text_style",
  "Create a Text style. Font is loaded automatically before being applied to the style.",
  {
    name: z.string().min(1).describe("Style name, e.g. 'text/heading/lg'"),
    fontFamily: z.string().describe("e.g. 'Inter'"),
    fontStyle: z.string().describe("e.g. 'Regular', 'Bold'"),
    fontSize: z.number().positive(),
    letterSpacing: z.union([
      z.number(),
      z.object({ value: z.number(), unit: z.enum(["PIXELS", "PERCENT"]) }),
    ]).optional(),
    lineHeight: z.union([
      z.number(),
      z.literal("AUTO"),
      z.object({ value: z.number(), unit: z.enum(["PIXELS", "PERCENT"]) }),
    ]).optional(),
    textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"]).optional(),
    textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(),
    paragraphSpacing: z.number().nonnegative().optional(),
    paragraphIndent: z.number().nonnegative().optional(),
    description: z.string().optional(),
  },
  (r: any) => `Created text style "${r.name}" (${r.id})`,
);

styleTool(
  "create_effect_style",
  "Create an Effect style (shadow/blur token). Effect shape matches set_effects.",
  {
    name: z.string().min(1),
    effects: z.array(z.object({
      type: z.enum(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR"]),
      color: z.object({
        r: z.number().min(0).max(1),
        g: z.number().min(0).max(1),
        b: z.number().min(0).max(1),
        a: z.number().min(0).max(1).optional(),
      }).optional(),
      offset: z.object({ x: z.number(), y: z.number() }).optional(),
      radius: z.number().nonnegative().optional(),
      spread: z.number().optional(),
      blendMode: z.string().optional(),
      visible: z.boolean().optional(),
    })),
    description: z.string().optional(),
  },
  (r: any) => `Created effect style "${r.name}" (${r.id})`,
);

styleTool(
  "create_grid_style",
  "Create a Layout Grid style. layoutGrids is an array of grid configs (COLUMNS/ROWS/GRID).",
  {
    name: z.string().min(1),
    layoutGrids: z.array(z.any()).describe("Layout grid array, e.g. [{ pattern:'COLUMNS', count:12, gutterSize:16 }]"),
    description: z.string().optional(),
  },
  (r: any) => `Created grid style "${r.name}" (${r.id})`,
);

styleTool(
  "apply_style",
  "Apply a Style to a node. target picks which slot on the node:\n" +
  "- fill   → fillStyleId   (PAINT style)\n" +
  "- stroke → strokeStyleId (PAINT style)\n" +
  "- text   → textStyleId   (TEXT style)\n" +
  "- effect → effectStyleId (EFFECT style)\n" +
  "- grid   → gridStyleId   (GRID style)\n" +
  "Style type is verified against target before applying.",
  {
    nodeId: z.string().describe("Target node id"),
    styleId: z.string().describe("Style id to apply"),
    target: z.enum(["fill", "stroke", "text", "effect", "grid"]),
  },
  (r: any) => `Applied "${r.styleName}" to ${r.name}.${r.target}`,
);

styleTool(
  "rename_style",
  "Rename a Style. Use slashes in the name to organize into groups (e.g. 'color/brand/primary').",
  {
    styleId: z.string(),
    name: z.string().min(1),
  },
  (r: any) => `Renamed style ${r.id} → "${r.name}"`,
);

styleTool(
  "delete_style",
  "Delete a Style. Nodes that referenced it lose the binding (their last cached values remain).",
  {
    styleId: z.string(),
  },
  (r: any) => `Deleted style "${r.name}" (${r.id})`,
);

// ---- Design System: Components (basics) ---------------------------

styleTool(
  "create_component_from_node",
  "Convert an existing node into a Component (figma.createComponentFromNode). " +
  "If the node is already a COMPONENT, returns it unchanged. The node's identity is preserved; " +
  "any existing instances elsewhere are not affected.",
  {
    nodeId: z.string().describe("Node id to promote into a component"),
  },
  (r: any) => r.alreadyComponent
    ? `Already a component: "${r.name}" (${r.id})`
    : `Created component "${r.name}" (${r.id}, key: ${r.key})`,
);

styleTool(
  "detach_instance",
  "Detach an instance — turns it into a regular Frame, breaking the link to its main component. " +
  "Existing overrides are baked in.",
  {
    nodeId: z.string().describe("Instance node id"),
  },
  (r: any) => `Detached "${r.name}" → ${r.type}`,
);

styleTool(
  "swap_instance",
  "Replace an instance's main component while preserving its position and overrides where compatible. " +
  "Useful for switching variants by component id (also see set_component_property for variant props).",
  {
    nodeId: z.string().describe("Instance node id"),
    mainComponentId: z.string().describe("New main component id"),
  },
  (r: any) => `Swapped "${r.name}" → main: "${r.mainComponent.name}" (${r.mainComponent.id})`,
);

// ---- Design System: Component Set + Properties --------------------

styleTool(
  "create_component_set",
  "Combine sibling Components into a Component Set (variants). All ids must be COMPONENT nodes. " +
  "Their parent (or current page) becomes the parent of the new set. Optional name renames the set.",
  {
    componentIds: z.array(z.string()).min(1).describe("Component ids to combine as variants"),
    name: z.string().optional().describe("Optional name for the resulting Component Set"),
  },
  (r: any) => `Created component set "${r.name}" (${r.id}) with ${r.variantCount} variant(s)`,
);

styleTool(
  "add_component_property",
  "Add a Component Property definition to a Component Set or Component. " +
  "Returns the propertyId — use it as a key in set_component_property.\n" +
  "- BOOLEAN: defaultValue is true/false\n" +
  "- TEXT:    defaultValue is a string\n" +
  "- INSTANCE_SWAP: defaultValue is a component id; options.preferredValues is allowed\n" +
  "- VARIANT: rare in code (Figma derives variants from naming convention)",
  {
    componentSetId: z.string().describe("Target COMPONENT_SET or COMPONENT id"),
    name: z.string().min(1),
    type: z.enum(["BOOLEAN", "TEXT", "INSTANCE_SWAP", "VARIANT"]),
    defaultValue: z.union([z.boolean(), z.string(), z.number()])
      .describe("Default value: BOOLEAN→true/false, TEXT→string, INSTANCE_SWAP→component id (string), VARIANT→variant option (string)"),
    options: z.record(z.any()).optional(),
  },
  (r: any) => `Added property "${r.name}" (${r.type}, propertyId: ${r.propertyId})`,
);

styleTool(
  "set_component_property",
  "Set Component Property values on an instance. properties is { propertyId: value }. " +
  "Use add_component_property's returned propertyId as the key (it's something like 'Variant#123:0').",
  {
    instanceId: z.string().describe("Instance node id"),
    properties: z.record(z.any()).describe("{ propertyId: value } map"),
  },
  (r: any) => `Set component properties on "${r.name}"`,
);

// -------------------------------------------------------------------

// Set Stroke Color Tool
server.tool(
  "set_stroke_color",
  "Set the stroke color of a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    r: z.number().min(0).max(1).describe("Red component (0-1)"),
    g: z.number().min(0).max(1).describe("Green component (0-1)"),
    b: z.number().min(0).max(1).describe("Blue component (0-1)"),
    a: z.number().min(0).max(1).optional().describe("Alpha component (0-1)"),
    weight: z.number().positive().optional().describe("Stroke weight"),
  },
  async ({ nodeId, r, g, b, a, weight }: any) => {
    try {
      const result = await sendCommandToFigma("set_stroke_color", {
        nodeId,
        color: { r, g, b, a: a || 1 },
        weight: weight || 1,
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Set stroke color of node "${typedResult.name
              }" to RGBA(${r}, ${g}, ${b}, ${a || 1}) with weight ${weight || 1}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting stroke color: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Move Node Tool
server.tool(
  "move_node",
  "Move a node to a new position in Figma",
  {
    nodeId: z.string().describe("The ID of the node to move"),
    x: z.number().describe("New X position"),
    y: z.number().describe("New Y position"),
  },
  async ({ nodeId, x, y }: any) => {
    try {
      const result = await sendCommandToFigma("move_node", { nodeId, x, y });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Moved node "${typedResult.name}" to position (${x}, ${y})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error moving node: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Clone Node Tool
server.tool(
  "clone_node",
  "Clone an existing node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to clone"),
    x: z.number().optional().describe("New X position for the clone"),
    y: z.number().optional().describe("New Y position for the clone")
  },
  async ({ nodeId, x, y }: any) => {
    try {
      const result = await sendCommandToFigma('clone_node', { nodeId, x, y });
      const typedResult = result as { name: string, id: string };
      return {
        content: [
          {
            type: "text",
            text: `Cloned node "${typedResult.name}" with new ID: ${typedResult.id}${x !== undefined && y !== undefined ? ` at position (${x}, ${y})` : ''}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error cloning node: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Resize Node Tool
server.tool(
  "resize_node",
  "Resize a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to resize"),
    width: z.number().positive().describe("New width"),
    height: z.number().positive().describe("New height"),
  },
  async ({ nodeId, width, height }: any) => {
    try {
      const result = await sendCommandToFigma("resize_node", {
        nodeId,
        width,
        height,
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Resized node "${typedResult.name}" to width ${width} and height ${height}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error resizing node: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Delete Node Tool
server.tool(
  "delete_node",
  "Delete a node from Figma",
  {
    nodeId: z.string().describe("The ID of the node to delete"),
  },
  async ({ nodeId }: any) => {
    try {
      await sendCommandToFigma("delete_node", { nodeId });
      return {
        content: [
          {
            type: "text",
            text: `Deleted node with ID: ${nodeId}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error deleting node: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Delete Multiple Nodes Tool
server.tool(
  "delete_multiple_nodes",
  "Delete multiple nodes from Figma at once",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to delete"),
  },
  async ({ nodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("delete_multiple_nodes", { nodeIds });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error deleting multiple nodes: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Export Node as Image Tool (BL-025)
server.tool(
  "export_node_as_image",
  "Export a node as an image. Format defaults to PNG.\n" +
  "- PNG/JPG: raster. Use `scale` (shortcut for SCALE constraint) or pass `constraint: { type:'SCALE'|'WIDTH'|'HEIGHT', value }`.\n" +
  "  Optional `contentsOnly` (excludes shadows/strokes outside bounds) and `useAbsoluteBounds`.\n" +
  "- SVG/PDF: vector. `scale`/`constraint`/`contentsOnly`/`useAbsoluteBounds` are ignored.\n" +
  "Returned as base64 plus MIME type; the MCP envelope re-wraps as image content for raster formats.",
  {
    nodeId: z.string().describe("The ID of the node to export"),
    format: z.enum(["PNG", "JPG", "SVG", "PDF"]).optional().describe("Export format (default PNG)"),
    scale: z.number().positive().optional().describe("Raster scale shortcut (1 = native, 2 = 2x). Ignored for SVG/PDF."),
    constraint: z.object({
      type: z.enum(["SCALE", "WIDTH", "HEIGHT"]),
      value: z.number().positive(),
    }).optional().describe("Explicit raster constraint; overrides `scale`."),
    contentsOnly: z.boolean().optional().describe("PNG/JPG only: exclude content outside the node's frame"),
    useAbsoluteBounds: z.boolean().optional().describe("PNG/JPG only: use absolute bounding box"),
  },
  async ({ nodeId, format, scale, constraint, contentsOnly, useAbsoluteBounds }: any) => {
    try {
      const result = await sendCommandToFigma("export_node_as_image", {
        nodeId,
        format: format || "PNG",
        scale: scale || 1,
        constraint,
        contentsOnly,
        useAbsoluteBounds,
      });
      const typedResult = result as {
        imageData: string;
        mimeType: string;
        format: string;
        byteLength: number;
      };

      // Raster formats (PNG/JPG) return as MCP image content for inline preview;
      // vector formats (SVG/PDF) return as text + base64 since image preview
      // typically doesn't render them.
      const isRaster = typedResult.format === "PNG" || typedResult.format === "JPG";
      if (isRaster) {
        return {
          content: [
            {
              type: "image",
              data: typedResult.imageData,
              mimeType: typedResult.mimeType || "image/png",
            },
          ],
        };
      }
      return {
        content: [
          { type: "text", text: `Exported ${typedResult.format} (${typedResult.byteLength} bytes, ${typedResult.mimeType})` },
          { type: "text", text: typedResult.imageData },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error exporting node as image: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Text Content Tool
server.tool(
  "set_text_content",
  "Set the text content of an existing text node in Figma",
  {
    nodeId: z.string().describe("The ID of the text node to modify"),
    text: z.string().describe("New text content"),
  },
  async ({ nodeId, text }: any) => {
    try {
      const result = await sendCommandToFigma("set_text_content", {
        nodeId,
        text,
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Updated text content of node "${typedResult.name}" to "${text}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting text content: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Get Styles Tool
server.tool(
  "get_styles",
  "Get all styles from the current Figma document",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_styles");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting styles: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Get Local Components Tool
server.tool(
  "get_local_components",
  "Get all local components from the Figma document",
  {},
  async () => {
    try {
      const result = await sendCommandToFigma("get_local_components");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting local components: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Get Annotations Tool
server.tool(
  "get_annotations",
  "Get all annotations in the current document or specific node",
  {
    nodeId: z.string().describe("node ID to get annotations for specific node"),
    includeCategories: z.boolean().optional().default(true).describe("Whether to include category information")
  },
  async ({ nodeId, includeCategories }: any) => {
    try {
      const result = await sendCommandToFigma("get_annotations", {
        nodeId,
        includeCategories
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting annotations: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Set Annotation Tool
server.tool(
  "set_annotation",
  "Create or update an annotation",
  {
    nodeId: z.string().describe("The ID of the node to annotate"),
    annotationId: z.string().optional().describe("The ID of the annotation to update (if updating existing annotation)"),
    labelMarkdown: z.string().describe("The annotation text in markdown format"),
    categoryId: z.string().optional().describe("The ID of the annotation category"),
    properties: z.array(z.object({
      type: z.string()
    })).optional().describe("Additional properties for the annotation")
  },
  async ({ nodeId, annotationId, labelMarkdown, categoryId, properties }: any) => {
    try {
      const result = await sendCommandToFigma("set_annotation", {
        nodeId,
        annotationId,
        labelMarkdown,
        categoryId,
        properties
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting annotation: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

interface SetMultipleAnnotationsParams {
  nodeId: string;
  annotations: Array<{
    nodeId: string;
    labelMarkdown: string;
    categoryId?: string;
    annotationId?: string;
    properties?: Array<{ type: string }>;
  }>;
}

// Set Multiple Annotations Tool
server.tool(
  "set_multiple_annotations",
  "Set multiple annotations parallelly in a node",
  {
    nodeId: z
      .string()
      .describe("The ID of the node containing the elements to annotate"),
    annotations: z
      .array(
        z.object({
          nodeId: z.string().describe("The ID of the node to annotate"),
          labelMarkdown: z.string().describe("The annotation text in markdown format"),
          categoryId: z.string().optional().describe("The ID of the annotation category"),
          annotationId: z.string().optional().describe("The ID of the annotation to update (if updating existing annotation)"),
          properties: z.array(z.object({
            type: z.string()
          })).optional().describe("Additional properties for the annotation")
        })
      )
      .describe("Array of annotations to apply"),
  },
  async ({ nodeId, annotations }: any) => {
    try {
      if (!annotations || annotations.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No annotations provided",
            },
          ],
        };
      }

      // Initial response to indicate we're starting the process
      const initialStatus = {
        type: "text" as const,
        text: `Starting annotation process for ${annotations.length} nodes. This will be processed in batches of 5...`,
      };

      // Track overall progress
      let totalProcessed = 0;
      const totalToProcess = annotations.length;

      // Use the plugin's set_multiple_annotations function with chunking
      const result = await sendCommandToFigma("set_multiple_annotations", {
        nodeId,
        annotations,
      });

      // Cast the result to a specific type to work with it safely
      interface AnnotationResult {
        success: boolean;
        nodeId: string;
        annotationsApplied?: number;
        annotationsFailed?: number;
        totalAnnotations?: number;
        completedInChunks?: number;
        results?: Array<{
          success: boolean;
          nodeId: string;
          error?: string;
          annotationId?: string;
        }>;
      }

      const typedResult = result as AnnotationResult;

      // Format the results for display
      const success = typedResult.annotationsApplied && typedResult.annotationsApplied > 0;
      const progressText = `
      Annotation process completed:
      - ${typedResult.annotationsApplied || 0} of ${totalToProcess} successfully applied
      - ${typedResult.annotationsFailed || 0} failed
      - Processed in ${typedResult.completedInChunks || 1} batches
      `;

      // Detailed results
      const detailedResults = typedResult.results || [];
      const failedResults = detailedResults.filter(item => !item.success);

      // Create the detailed part of the response
      let detailedResponse = "";
      if (failedResults.length > 0) {
        detailedResponse = `\n\nNodes that failed:\n${failedResults.map(item =>
          `- ${item.nodeId}: ${item.error || "Unknown error"}`
        ).join('\n')}`;
      }

      return {
        content: [
          initialStatus,
          {
            type: "text" as const,
            text: progressText + detailedResponse,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting multiple annotations: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Create Component Instance Tool
server.tool(
  "create_component_instance",
  "Create an instance of a component in Figma. For LOCAL components (from get_local_components), use componentId with the id field. For published LIBRARY components, use componentKey with the publishedKey field.",
  {
    componentId: z.string().optional().describe("ID of a local component (use the id field from get_local_components result). Use this for unpublished/local components."),
    componentKey: z.string().optional().describe("Key of a published library component to instantiate (use the publishedKey field from get_local_components result). Only works for published components."),
    x: z.number().describe("X position"),
    y: z.number().describe("Y position"),
    parentId: z.string().optional().describe("Optional parent node ID to place the instance into"),
  },
  async ({ componentId, componentKey, x, y, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_component_instance", {
        componentId,
        componentKey,
        x,
        y,
        parentId,
      });
      const typedResult = result as any;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(typedResult),
          }
        ]
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating component instance: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Copy Instance Overrides Tool
server.tool(
  "get_instance_overrides",
  "Get all override properties from a selected component instance. These overrides can be applied to other instances, which will swap them to match the source component.",
  {
    nodeId: z.string().optional().describe("Optional ID of the component instance to get overrides from. If not provided, currently selected instance will be used."),
  },
  async ({ nodeId }: any) => {
    try {
      const result = await sendCommandToFigma("get_instance_overrides", {
        instanceNodeId: nodeId || null
      });
      const typedResult = result as getInstanceOverridesResult;

      return {
        content: [
          {
            type: "text",
            text: typedResult.success
              ? `Successfully got instance overrides: ${typedResult.message}`
              : `Failed to get instance overrides: ${typedResult.message}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error copying instance overrides: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Set Instance Overrides Tool
server.tool(
  "set_instance_overrides",
  "Apply previously copied overrides to selected component instances. Target instances will be swapped to the source component and all copied override properties will be applied.",
  {
    sourceInstanceId: z.string().describe("ID of the source component instance"),
    targetNodeIds: z.array(z.string()).describe("Array of target instance IDs. Currently selected instances will be used.")
  },
  async ({ sourceInstanceId, targetNodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("set_instance_overrides", {
        sourceInstanceId: sourceInstanceId,
        targetNodeIds: targetNodeIds || []
      });
      const typedResult = result as setInstanceOverridesResult;

      if (typedResult.success) {
        const successCount = typedResult.results?.filter(r => r.success).length || 0;
        return {
          content: [
            {
              type: "text",
              text: `Successfully applied ${typedResult.totalCount || 0} overrides to ${successCount} instances.`
            }
          ]
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: `Failed to set instance overrides: ${typedResult.message}`
            }
          ]
        };
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting instance overrides: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);


// Set Corner Radius Tool
server.tool(
  "set_corner_radius",
  "Set the corner radius of a node in Figma",
  {
    nodeId: z.string().describe("The ID of the node to modify"),
    radius: z.number().min(0).describe("Corner radius value"),
    corners: z
      .array(z.boolean())
      .length(4)
      .optional()
      .describe(
        "Optional array of 4 booleans to specify which corners to round [topLeft, topRight, bottomRight, bottomLeft]"
      ),
  },
  async ({ nodeId, radius, corners }: any) => {
    try {
      const result = await sendCommandToFigma("set_corner_radius", {
        nodeId,
        radius,
        corners: corners || [true, true, true, true],
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Set corner radius of node "${typedResult.name}" to ${radius}px`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting corner radius: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Define design strategy prompt
server.prompt(
  "design_strategy",
  "Best practices for working with Figma designs",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `When working with Figma designs, follow these best practices:

1. Start with Document Structure:
   - First use get_document_info() to understand the current document
   - Plan your layout hierarchy before creating elements
   - Create a main container frame for each screen/section

2. Naming Conventions:
   - Use descriptive, semantic names for all elements
   - Follow a consistent naming pattern (e.g., "Login Screen", "Logo Container", "Email Input")
   - Group related elements with meaningful names

3. Layout Hierarchy:
   - Create parent frames first, then add child elements
   - For forms/login screens:
     * Start with the main screen container frame
     * Create a logo container at the top
     * Group input fields in their own containers
     * Place action buttons (login, submit) after inputs
     * Add secondary elements (forgot password, signup links) last

4. Input Fields Structure:
   - Create a container frame for each input field
   - Include a label text above or inside the input
   - Group related inputs (e.g., username/password) together

5. Element Creation:
   - Use create_frame() for containers and input fields
   - Use create_text() for labels, buttons text, and links
   - Set appropriate colors and styles:
     * Use fillColor for backgrounds
     * Use strokeColor for borders
     * Set proper fontWeight for different text elements

6. Mofifying existing elements:
  - use set_text_content() to modify text content.

7. Visual Hierarchy:
   - Position elements in logical reading order (top to bottom)
   - Maintain consistent spacing between elements
   - Use appropriate font sizes for different text types:
     * Larger for headings/welcome text
     * Medium for input labels
     * Standard for button text
     * Smaller for helper text/links

8. Best Practices:
   - Verify each creation with get_node_info()
   - Use parentId to maintain proper hierarchy
   - Group related elements together in frames
   - Keep consistent spacing and alignment

Example Login Screen Structure:
- Login Screen (main frame)
  - Logo Container (frame)
    - Logo (image/text)
  - Welcome Text (text)
  - Input Container (frame)
    - Email Input (frame)
      - Email Label (text)
      - Email Field (frame)
    - Password Input (frame)
      - Password Label (text)
      - Password Field (frame)
  - Login Button (frame)
    - Button Text (text)
  - Helper Links (frame)
    - Forgot Password (text)
    - Don't have account (text)`,
          },
        },
      ],
      description: "Best practices for working with Figma designs",
    };
  }
);

server.prompt(
  "read_design_strategy",
  "Best practices for reading Figma designs",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `When reading Figma designs, follow these best practices:

1. Start with selection:
   - First use read_my_design() to understand the current selection
   - If no selection ask user to select single or multiple nodes
`,
          },
        },
      ],
      description: "Best practices for reading Figma designs",
    };
  }
);

// Text Node Scanning Tool
server.tool(
  "scan_text_nodes",
  "Scan all text nodes in the selected Figma node",
  {
    nodeId: z.string().describe("ID of the node to scan"),
  },
  async ({ nodeId }: any) => {
    try {
      // Initial response to indicate we're starting the process
      const initialStatus = {
        type: "text" as const,
        text: "Starting text node scanning. This may take a moment for large designs...",
      };

      // Use the plugin's scan_text_nodes function with chunking flag
      const result = await sendCommandToFigma("scan_text_nodes", {
        nodeId,
        useChunking: true,  // Enable chunking on the plugin side
        chunkSize: 10       // Process 10 nodes at a time
      });

      // If the result indicates chunking was used, format the response accordingly
      if (result && typeof result === 'object' && 'chunks' in result) {
        const typedResult = result as {
          success: boolean,
          totalNodes: number,
          processedNodes: number,
          chunks: number,
          textNodes: Array<any>
        };

        const summaryText = `
        Scan completed:
        - Found ${typedResult.totalNodes} text nodes
        - Processed in ${typedResult.chunks} chunks
        `;

        return {
          content: [
            initialStatus,
            {
              type: "text" as const,
              text: summaryText
            },
            {
              type: "text" as const,
              text: JSON.stringify(typedResult.textNodes, null, 2)
            }
          ],
        };
      }

      // If chunking wasn't used or wasn't reported in the result format, return the result as is
      return {
        content: [
          initialStatus,
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error scanning text nodes: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Node Type Scanning Tool
server.tool(
  "scan_nodes_by_types",
  "Scan for child nodes with specific types in the selected Figma node",
  {
    nodeId: z.string().describe("ID of the node to scan"),
    types: z.array(z.string()).describe("Array of node types to find in the child nodes (e.g. ['COMPONENT', 'FRAME'])")
  },
  async ({ nodeId, types }: any) => {
    try {
      // Initial response to indicate we're starting the process
      const initialStatus = {
        type: "text" as const,
        text: `Starting node type scanning for types: ${types.join(', ')}...`,
      };

      // Use the plugin's scan_nodes_by_types function
      const result = await sendCommandToFigma("scan_nodes_by_types", {
        nodeId,
        types
      });

      // Format the response
      if (result && typeof result === 'object' && 'matchingNodes' in result) {
        const typedResult = result as {
          success: boolean,
          count: number,
          matchingNodes: Array<{
            id: string,
            name: string,
            type: string,
            bbox: {
              x: number,
              y: number,
              width: number,
              height: number
            }
          }>,
          searchedTypes: Array<string>
        };

        const summaryText = `Scan completed: Found ${typedResult.count} nodes matching types: ${typedResult.searchedTypes.join(', ')}`;

        return {
          content: [
            initialStatus,
            {
              type: "text" as const,
              text: summaryText
            },
            {
              type: "text" as const,
              text: JSON.stringify(typedResult.matchingNodes, null, 2)
            }
          ],
        };
      }

      // If the result is in an unexpected format, return it as is
      return {
        content: [
          initialStatus,
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error scanning nodes by types: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Text Replacement Strategy Prompt
server.prompt(
  "text_replacement_strategy",
  "Systematic approach for replacing text in Figma designs",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Intelligent Text Replacement Strategy

## 1. Analyze Design & Identify Structure
- Scan text nodes to understand the overall structure of the design
- Use AI pattern recognition to identify logical groupings:
  * Tables (rows, columns, headers, cells)
  * Lists (items, headers, nested lists)
  * Card groups (similar cards with recurring text fields)
  * Forms (labels, input fields, validation text)
  * Navigation (menu items, breadcrumbs)
\`\`\`
scan_text_nodes(nodeId: "node-id")
get_node_info(nodeId: "node-id")  // optional
\`\`\`

## 2. Strategic Chunking for Complex Designs
- Divide replacement tasks into logical content chunks based on design structure
- Use one of these chunking strategies that best fits the design:
  * **Structural Chunking**: Table rows/columns, list sections, card groups
  * **Spatial Chunking**: Top-to-bottom, left-to-right in screen areas
  * **Semantic Chunking**: Content related to the same topic or functionality
  * **Component-Based Chunking**: Process similar component instances together

## 3. Progressive Replacement with Verification
- Create a safe copy of the node for text replacement
- Replace text chunk by chunk with continuous progress updates
- After each chunk is processed:
  * Export that section as a small, manageable image
  * Verify text fits properly and maintain design integrity
  * Fix issues before proceeding to the next chunk

\`\`\`
// Clone the node to create a safe copy
clone_node(nodeId: "selected-node-id", x: [new-x], y: [new-y])

// Replace text chunk by chunk
set_multiple_text_contents(
  nodeId: "parent-node-id", 
  text: [
    { nodeId: "node-id-1", text: "New text 1" },
    // More nodes in this chunk...
  ]
)

// Verify chunk with small, targeted image exports
export_node_as_image(nodeId: "chunk-node-id", format: "PNG", scale: 0.5)
\`\`\`

## 4. Intelligent Handling for Table Data
- For tabular content:
  * Process one row or column at a time
  * Maintain alignment and spacing between cells
  * Consider conditional formatting based on cell content
  * Preserve header/data relationships

## 5. Smart Text Adaptation
- Adaptively handle text based on container constraints:
  * Auto-detect space constraints and adjust text length
  * Apply line breaks at appropriate linguistic points
  * Maintain text hierarchy and emphasis
  * Consider font scaling for critical content that must fit

## 6. Progressive Feedback Loop
- Establish a continuous feedback loop during replacement:
  * Real-time progress updates (0-100%)
  * Small image exports after each chunk for verification
  * Issues identified early and resolved incrementally
  * Quick adjustments applied to subsequent chunks

## 7. Final Verification & Context-Aware QA
- After all chunks are processed:
  * Export the entire design at reduced scale for final verification
  * Check for cross-chunk consistency issues
  * Verify proper text flow between different sections
  * Ensure design harmony across the full composition

## 8. Chunk-Specific Export Scale Guidelines
- Scale exports appropriately based on chunk size:
  * Small chunks (1-5 elements): scale 1.0
  * Medium chunks (6-20 elements): scale 0.7
  * Large chunks (21-50 elements): scale 0.5
  * Very large chunks (50+ elements): scale 0.3
  * Full design verification: scale 0.2

## Sample Chunking Strategy for Common Design Types

### Tables
- Process by logical rows (5-10 rows per chunk)
- Alternative: Process by column for columnar analysis
- Tip: Always include header row in first chunk for reference

### Card Lists
- Group 3-5 similar cards per chunk
- Process entire cards to maintain internal consistency
- Verify text-to-image ratio within cards after each chunk

### Forms
- Group related fields (e.g., "Personal Information", "Payment Details")
- Process labels and input fields together
- Ensure validation messages and hints are updated with their fields

### Navigation & Menus
- Process hierarchical levels together (main menu, submenu)
- Respect information architecture relationships
- Verify menu fit and alignment after replacement

## Best Practices
- **Preserve Design Intent**: Always prioritize design integrity
- **Structural Consistency**: Maintain alignment, spacing, and hierarchy
- **Visual Feedback**: Verify each chunk visually before proceeding
- **Incremental Improvement**: Learn from each chunk to improve subsequent ones
- **Balance Automation & Control**: Let AI handle repetitive replacements but maintain oversight
- **Respect Content Relationships**: Keep related content consistent across chunks

Remember that text is never just text—it's a core design element that must work harmoniously with the overall composition. This chunk-based strategy allows you to methodically transform text while maintaining design integrity.`,
          },
        },
      ],
      description: "Systematic approach for replacing text in Figma designs",
    };
  }
);

// Set Multiple Text Contents Tool
server.tool(
  "set_multiple_text_contents",
  "Set multiple text contents parallelly in a node",
  {
    nodeId: z
      .string()
      .describe("The ID of the node containing the text nodes to replace"),
    text: z
      .array(
        z.object({
          nodeId: z.string().describe("The ID of the text node"),
          text: z.string().describe("The replacement text"),
        })
      )
      .describe("Array of text node IDs and their replacement texts"),
  },
  async ({ nodeId, text }: any) => {
    try {
      if (!text || text.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No text provided",
            },
          ],
        };
      }

      // Initial response to indicate we're starting the process
      const initialStatus = {
        type: "text" as const,
        text: `Starting text replacement for ${text.length} nodes. This will be processed in batches of 5...`,
      };

      // Track overall progress
      let totalProcessed = 0;
      const totalToProcess = text.length;

      // Use the plugin's set_multiple_text_contents function with chunking
      const result = await sendCommandToFigma("set_multiple_text_contents", {
        nodeId,
        text,
      });

      // Cast the result to a specific type to work with it safely
      interface TextReplaceResult {
        success: boolean;
        nodeId: string;
        replacementsApplied?: number;
        replacementsFailed?: number;
        totalReplacements?: number;
        completedInChunks?: number;
        results?: Array<{
          success: boolean;
          nodeId: string;
          error?: string;
          originalText?: string;
          translatedText?: string;
        }>;
      }

      const typedResult = result as TextReplaceResult;

      // Format the results for display
      const success = typedResult.replacementsApplied && typedResult.replacementsApplied > 0;
      const progressText = `
      Text replacement completed:
      - ${typedResult.replacementsApplied || 0} of ${totalToProcess} successfully updated
      - ${typedResult.replacementsFailed || 0} failed
      - Processed in ${typedResult.completedInChunks || 1} batches
      `;

      // Detailed results
      const detailedResults = typedResult.results || [];
      const failedResults = detailedResults.filter(item => !item.success);

      // Create the detailed part of the response
      let detailedResponse = "";
      if (failedResults.length > 0) {
        detailedResponse = `\n\nNodes that failed:\n${failedResults.map(item =>
          `- ${item.nodeId}: ${item.error || "Unknown error"}`
        ).join('\n')}`;
      }

      return {
        content: [
          initialStatus,
          {
            type: "text" as const,
            text: progressText + detailedResponse,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting multiple text contents: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Annotation Conversion Strategy Prompt
server.prompt(
  "annotation_conversion_strategy",
  "Strategy for converting manual annotations to Figma's native annotations",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Automatic Annotation Conversion
            
## Process Overview

The process of converting manual annotations (numbered/alphabetical indicators with connected descriptions) to Figma's native annotations:

1. Get selected frame/component information
2. Scan and collect all annotation text nodes
3. Scan target UI elements (components, instances, frames)
4. Match annotations to appropriate UI elements
5. Apply native Figma annotations

## Step 1: Get Selection and Initial Setup

First, get the selected frame or component that contains annotations:

\`\`\`typescript
// Get the selected frame/component
const selection = await get_selection();
const selectedNodeId = selection[0].id

// Get available annotation categories for later use
const annotationData = await get_annotations({
  nodeId: selectedNodeId,
  includeCategories: true
});
const categories = annotationData.categories;
\`\`\`

## Step 2: Scan Annotation Text Nodes

Scan all text nodes to identify annotations and their descriptions:

\`\`\`typescript
// Get all text nodes in the selection
const textNodes = await scan_text_nodes({
  nodeId: selectedNodeId
});

// Filter and group annotation markers and descriptions

// Markers typically have these characteristics:
// - Short text content (usually single digit/letter)
// - Specific font styles (often bold)
// - Located in a container with "Marker" or "Dot" in the name
// - Have a clear naming pattern (e.g., "1", "2", "3" or "A", "B", "C")


// Identify description nodes
// Usually longer text nodes near markers or with matching numbers in path
  
\`\`\`

## Step 3: Scan Target UI Elements

Get all potential target elements that annotations might refer to:

\`\`\`typescript
// Scan for all UI elements that could be annotation targets
const targetNodes = await scan_nodes_by_types({
  nodeId: selectedNodeId,
  types: [
    "COMPONENT",
    "INSTANCE",
    "FRAME"
  ]
});
\`\`\`

## Step 4: Match Annotations to Targets

Match each annotation to its target UI element using these strategies in order of priority:

1. **Path-Based Matching**:
   - Look at the marker's parent container name in the Figma layer hierarchy
   - Remove any "Marker:" or "Annotation:" prefixes from the parent name
   - Find UI elements that share the same parent name or have it in their path
   - This works well when markers are grouped with their target elements

2. **Name-Based Matching**:
   - Extract key terms from the annotation description
   - Look for UI elements whose names contain these key terms
   - Consider both exact matches and semantic similarities
   - Particularly effective for form fields, buttons, and labeled components

3. **Proximity-Based Matching** (fallback):
   - Calculate the center point of the marker
   - Find the closest UI element by measuring distances to element centers
   - Consider the marker's position relative to nearby elements
   - Use this method when other matching strategies fail

Additional Matching Considerations:
- Give higher priority to matches found through path-based matching
- Consider the type of UI element when evaluating matches
- Take into account the annotation's context and content
- Use a combination of strategies for more accurate matching

## Step 5: Apply Native Annotations

Convert matched annotations to Figma's native annotations using batch processing:

\`\`\`typescript
// Prepare annotations array for batch processing
const annotationsToApply = Object.values(annotations).map(({ marker, description }) => {
  // Find target using multiple strategies
  const target = 
    findTargetByPath(marker, targetNodes) ||
    findTargetByName(description, targetNodes) ||
    findTargetByProximity(marker, targetNodes);
  
  if (target) {
    // Determine appropriate category based on content
    const category = determineCategory(description.characters, categories);

    // Determine appropriate additional annotationProperty based on content
    const annotationProperty = determineProperties(description.characters, target.type);
    
    return {
      nodeId: target.id,
      labelMarkdown: description.characters,
      categoryId: category.id,
      properties: annotationProperty
    };
  }
  return null;
}).filter(Boolean); // Remove null entries

// Apply annotations in batches using set_multiple_annotations
if (annotationsToApply.length > 0) {
  await set_multiple_annotations({
    nodeId: selectedNodeId,
    annotations: annotationsToApply
  });
}
\`\`\`


This strategy focuses on practical implementation based on real-world usage patterns, emphasizing the importance of handling various UI elements as annotation targets, not just text nodes.`
          },
        },
      ],
      description: "Strategy for converting manual annotations to Figma's native annotations",
    };
  }
);

// Instance Slot Filling Strategy Prompt
server.prompt(
  "swap_overrides_instances",
  "Guide to swap instance overrides between instances",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Swap Component Instance and Override Strategy

## Overview
This strategy enables transferring content and property overrides from a source instance to one or more target instances in Figma, maintaining design consistency while reducing manual work.

## Step-by-Step Process

### 1. Selection Analysis
- Use \`get_selection()\` to identify the parent component or selected instances
- For parent components, scan for instances with \`scan_nodes_by_types({ nodeId: "parent-id", types: ["INSTANCE"] })\`
- Identify custom slots by name patterns (e.g. "Custom Slot*" or "Instance Slot") or by examining text content
- Determine which is the source instance (with content to copy) and which are targets (where to apply content)

### 2. Extract Source Overrides
- Use \`get_instance_overrides()\` to extract customizations from the source instance
- This captures text content, property values, and style overrides
- Command syntax: \`get_instance_overrides({ nodeId: "source-instance-id" })\`
- Look for successful response like "Got component information from [instance name]"

### 3. Apply Overrides to Targets
- Apply captured overrides using \`set_instance_overrides()\`
- Command syntax:
  \`\`\`
  set_instance_overrides({
    sourceInstanceId: "source-instance-id", 
    targetNodeIds: ["target-id-1", "target-id-2", ...]
  })
  \`\`\`

### 4. Verification
- Verify results with \`get_node_info()\` or \`read_my_design()\`
- Confirm text content and style overrides have transferred successfully

## Key Tips
- Always join the appropriate channel first with \`join_channel()\`
- When working with multiple targets, check the full selection with \`get_selection()\`
- Preserve component relationships by using instance overrides rather than direct text manipulation`,
          },
        },
      ],
      description: "Strategy for transferring overrides between component instances in Figma",
    };
  }
);

// Set Layout Mode Tool
server.tool(
  "set_layout_mode",
  "Set the layout mode and wrap behavior of a frame in Figma",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).describe("Layout mode for the frame"),
    layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional().describe("Whether the auto-layout frame wraps its children")
  },
  async ({ nodeId, layoutMode, layoutWrap }: any) => {
    try {
      const result = await sendCommandToFigma("set_layout_mode", {
        nodeId,
        layoutMode,
        layoutWrap: layoutWrap || "NO_WRAP"
      });
      const typedResult = result as { name: string };
      return {
        content: [
          {
            type: "text",
            text: `Set layout mode of frame "${typedResult.name}" to ${layoutMode}${layoutWrap ? ` with ${layoutWrap}` : ''}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting layout mode: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Padding Tool
server.tool(
  "set_padding",
  "Set padding values for an auto-layout frame in Figma",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    paddingTop: z.number().optional().describe("Top padding value"),
    paddingRight: z.number().optional().describe("Right padding value"),
    paddingBottom: z.number().optional().describe("Bottom padding value"),
    paddingLeft: z.number().optional().describe("Left padding value"),
  },
  async ({ nodeId, paddingTop, paddingRight, paddingBottom, paddingLeft }: any) => {
    try {
      const result = await sendCommandToFigma("set_padding", {
        nodeId,
        paddingTop,
        paddingRight,
        paddingBottom,
        paddingLeft,
      });
      const typedResult = result as { name: string };

      // Create a message about which padding values were set
      const paddingMessages = [];
      if (paddingTop !== undefined) paddingMessages.push(`top: ${paddingTop}`);
      if (paddingRight !== undefined) paddingMessages.push(`right: ${paddingRight}`);
      if (paddingBottom !== undefined) paddingMessages.push(`bottom: ${paddingBottom}`);
      if (paddingLeft !== undefined) paddingMessages.push(`left: ${paddingLeft}`);

      const paddingText = paddingMessages.length > 0
        ? `padding (${paddingMessages.join(', ')})`
        : "padding";

      return {
        content: [
          {
            type: "text",
            text: `Set ${paddingText} for frame "${typedResult.name}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting padding: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Axis Align Tool
server.tool(
  "set_axis_align",
  "Set primary and counter axis alignment for an auto-layout frame in Figma",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    primaryAxisAlignItems: z
      .enum(["MIN", "MAX", "CENTER", "SPACE_BETWEEN"])
      .optional()
      .describe("Primary axis alignment (MIN/MAX = left/right in horizontal, top/bottom in vertical). Note: When set to SPACE_BETWEEN, itemSpacing will be ignored as children will be evenly spaced."),
    counterAxisAlignItems: z
      .enum(["MIN", "MAX", "CENTER", "BASELINE"])
      .optional()
      .describe("Counter axis alignment (MIN/MAX = top/bottom in horizontal, left/right in vertical)")
  },
  async ({ nodeId, primaryAxisAlignItems, counterAxisAlignItems }: any) => {
    try {
      const result = await sendCommandToFigma("set_axis_align", {
        nodeId,
        primaryAxisAlignItems,
        counterAxisAlignItems
      });
      const typedResult = result as { name: string };

      // Create a message about which alignments were set
      const alignMessages = [];
      if (primaryAxisAlignItems !== undefined) alignMessages.push(`primary: ${primaryAxisAlignItems}`);
      if (counterAxisAlignItems !== undefined) alignMessages.push(`counter: ${counterAxisAlignItems}`);

      const alignText = alignMessages.length > 0
        ? `axis alignment (${alignMessages.join(', ')})`
        : "axis alignment";

      return {
        content: [
          {
            type: "text",
            text: `Set ${alignText} for frame "${typedResult.name}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting axis alignment: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Layout Sizing Tool
server.tool(
  "set_layout_sizing",
  "Set horizontal and vertical sizing modes for an auto-layout frame in Figma",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    layoutSizingHorizontal: z
      .enum(["FIXED", "HUG", "FILL"])
      .optional()
      .describe("Horizontal sizing mode (HUG for frames/text only, FILL for auto-layout children only)"),
    layoutSizingVertical: z
      .enum(["FIXED", "HUG", "FILL"])
      .optional()
      .describe("Vertical sizing mode (HUG for frames/text only, FILL for auto-layout children only)")
  },
  async ({ nodeId, layoutSizingHorizontal, layoutSizingVertical }: any) => {
    try {
      const result = await sendCommandToFigma("set_layout_sizing", {
        nodeId,
        layoutSizingHorizontal,
        layoutSizingVertical
      });
      const typedResult = result as { name: string };

      // Create a message about which sizing modes were set
      const sizingMessages = [];
      if (layoutSizingHorizontal !== undefined) sizingMessages.push(`horizontal: ${layoutSizingHorizontal}`);
      if (layoutSizingVertical !== undefined) sizingMessages.push(`vertical: ${layoutSizingVertical}`);

      const sizingText = sizingMessages.length > 0
        ? `layout sizing (${sizingMessages.join(', ')})`
        : "layout sizing";

      return {
        content: [
          {
            type: "text",
            text: `Set ${sizingText} for frame "${typedResult.name}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting layout sizing: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Item Spacing Tool
server.tool(
  "set_item_spacing",
  "Set distance between children in an auto-layout frame",
  {
    nodeId: z.string().describe("The ID of the frame to modify"),
    itemSpacing: z.number().optional().describe("Distance between children. Note: This value will be ignored if primaryAxisAlignItems is set to SPACE_BETWEEN."),
    counterAxisSpacing: z.number().optional().describe("Distance between wrapped rows/columns. Only works when layoutWrap is set to WRAP.")
  },
  async ({ nodeId, itemSpacing, counterAxisSpacing}: any) => {
    try {
      const params: any = { nodeId };
      if (itemSpacing !== undefined) params.itemSpacing = itemSpacing;
      if (counterAxisSpacing !== undefined) params.counterAxisSpacing = counterAxisSpacing;
      
      const result = await sendCommandToFigma("set_item_spacing", params);
      const typedResult = result as { name: string, itemSpacing?: number, counterAxisSpacing?: number };

      let message = `Updated spacing for frame "${typedResult.name}":`;
      if (itemSpacing !== undefined) message += ` itemSpacing=${itemSpacing}`;
      if (counterAxisSpacing !== undefined) message += ` counterAxisSpacing=${counterAxisSpacing}`;

      return {
        content: [
          {
            type: "text",
            text: message,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting spacing: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// A tool to get Figma Prototyping Reactions from multiple nodes
server.tool(
  "get_reactions",
  "Get Figma Prototyping Reactions from multiple nodes. CRITICAL: The output MUST be processed using the 'reaction_to_connector_strategy' prompt IMMEDIATELY to generate parameters for connector lines via the 'create_connections' tool.",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to get reactions from"),
  },
  async ({ nodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("get_reactions", { nodeIds });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          },
          {
            type: "text",
            text: "IMPORTANT: You MUST now use the reaction data above and follow the `reaction_to_connector_strategy` prompt to prepare the parameters for the `create_connections` tool call. This is a required next step."
          }
        ],
        followUp: {
          type: "prompt",
          prompt: "reaction_to_connector_strategy",
        },
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting reactions: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Create Connectors Tool
server.tool(
  "set_default_connector",
  "Set a copied connector node as the default connector",
  {
    connectorId: z.string().optional().describe("The ID of the connector node to set as default")
  },
  async ({ connectorId }: any) => {
    try {
      const result = await sendCommandToFigma("set_default_connector", {
        connectorId
      });

      return {
        content: [
          {
            type: "text",
            text: `Default connector set: ${JSON.stringify(result)}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting default connector: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Connect Nodes Tool
server.tool(
  "create_connections",
  "Create connections between nodes using the default connector style",
  {
    connections: z.array(z.object({
      startNodeId: z.string().describe("ID of the starting node"),
      endNodeId: z.string().describe("ID of the ending node"),
      text: z.string().optional().describe("Optional text to display on the connector")
    })).describe("Array of node connections to create")
  },
  async ({ connections }: any) => {
    try {
      if (!connections || connections.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No connections provided"
            }
          ]
        };
      }

      const result = await sendCommandToFigma("create_connections", {
        connections
      });

      return {
        content: [
          {
            type: "text",
            text: `Created ${connections.length} connections: ${JSON.stringify(result)}`
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating connections: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Set Focus Tool
server.tool(
  "set_focus",
  "Set focus on a specific node in Figma by selecting it and scrolling viewport to it",
  {
    nodeId: z.string().describe("The ID of the node to focus on"),
  },
  async ({ nodeId }: any) => {
    try {
      const result = await sendCommandToFigma("set_focus", { nodeId });
      const typedResult = result as { name: string; id: string };
      return {
        content: [
          {
            type: "text",
            text: `Focused on node "${typedResult.name}" (ID: ${typedResult.id})`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting focus: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Selections Tool
server.tool(
  "set_selections",
  "Set selection to multiple nodes in Figma and scroll viewport to show them",
  {
    nodeIds: z.array(z.string()).describe("Array of node IDs to select"),
  },
  async ({ nodeIds }: any) => {
    try {
      const result = await sendCommandToFigma("set_selections", { nodeIds });
      const typedResult = result as { selectedNodes: Array<{ name: string; id: string }>; count: number };
      return {
        content: [
          {
            type: "text",
            text: `Selected ${typedResult.count} nodes: ${typedResult.selectedNodes.map(node => `"${node.name}" (${node.id})`).join(', ')}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error setting selections: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Strategy for converting Figma prototype reactions to connector lines
server.prompt(
  "reaction_to_connector_strategy",
  "Strategy for converting Figma prototype reactions to connector lines using the output of 'get_reactions'",
  (extra) => {
    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: `# Strategy: Convert Figma Prototype Reactions to Connector Lines

## Goal
Process the JSON output from the \`get_reactions\` tool to generate an array of connection objects suitable for the \`create_connections\` tool. This visually represents prototype flows as connector lines on the Figma canvas.

## Input Data
You will receive JSON data from the \`get_reactions\` tool. This data contains an array of nodes, each with potential reactions. A typical reaction object looks like this:
\`\`\`json
{
  "trigger": { "type": "ON_CLICK" },
  "action": {
    "type": "NAVIGATE",
    "destinationId": "destination-node-id",
    "navigationTransition": { ... },
    "preserveScrollPosition": false
  }
}
\`\`\`

## Step-by-Step Process

### 1. Preparation & Context Gathering
   - **Action:** Call \`read_my_design\` on the relevant node(s) to get context about the nodes involved (names, types, etc.). This helps in generating meaningful connector labels later.
   - **Action:** Call \`set_default_connector\` **without** the \`connectorId\` parameter.
   - **Check Result:** Analyze the response from \`set_default_connector\`.
     - If it confirms a default connector is already set (e.g., "Default connector is already set"), proceed to Step 2.
     - If it indicates no default connector is set (e.g., "No default connector set..."), you **cannot** proceed with \`create_connections\` yet. Inform the user they need to manually copy a connector from FigJam, paste it onto the current page, select it, and then you can run \`set_default_connector({ connectorId: "SELECTED_NODE_ID" })\` before attempting \`create_connections\`. **Do not proceed to Step 2 until a default connector is confirmed.**

### 2. Filter and Transform Reactions from \`get_reactions\` Output
   - **Iterate:** Go through the JSON array provided by \`get_reactions\`. For each node in the array:
     - Iterate through its \`reactions\` array.
   - **Filter:** Keep only reactions where the \`action\` meets these criteria:
     - Has a \`type\` that implies a connection (e.g., \`NAVIGATE\`, \`OPEN_OVERLAY\`, \`SWAP_OVERLAY\`). **Ignore** types like \`CHANGE_TO\`, \`CLOSE_OVERLAY\`, etc.
     - Has a valid \`destinationId\` property.
   - **Extract:** For each valid reaction, extract the following information:
     - \`sourceNodeId\`: The ID of the node the reaction belongs to (from the outer loop).
     - \`destinationNodeId\`: The value of \`action.destinationId\`.
     - \`actionType\`: The value of \`action.type\`.
     - \`triggerType\`: The value of \`trigger.type\`.

### 3. Generate Connector Text Labels
   - **For each extracted connection:** Create a concise, descriptive text label string.
   - **Combine Information:** Use the \`actionType\`, \`triggerType\`, and potentially the names of the source/destination nodes (obtained from Step 1's \`read_my_design\` or by calling \`get_node_info\` if necessary) to generate the label.
   - **Example Labels:**
     - If \`triggerType\` is "ON\_CLICK" and \`actionType\` is "NAVIGATE": "On click, navigate to [Destination Node Name]"
     - If \`triggerType\` is "ON\_DRAG" and \`actionType\` is "OPEN\_OVERLAY": "On drag, open [Destination Node Name] overlay"
   - **Keep it brief and informative.** Let this generated string be \`generatedText\`.

### 4. Prepare the \`connections\` Array for \`create_connections\`
   - **Structure:** Create a JSON array where each element is an object representing a connection.
   - **Format:** Each object in the array must have the following structure:
     \`\`\`json
     {
       "startNodeId": "sourceNodeId_from_step_2",
       "endNodeId": "destinationNodeId_from_step_2",
       "text": "generatedText_from_step_3"
     }
     \`\`\`
   - **Result:** This final array is the value you will pass to the \`connections\` parameter when calling the \`create_connections\` tool.

### 5. Execute Connection Creation
   - **Action:** Call the \`create_connections\` tool, passing the array generated in Step 4 as the \`connections\` argument.
   - **Verify:** Check the response from \`create_connections\` to confirm success or failure.

This detailed process ensures you correctly interpret the reaction data, prepare the necessary information, and use the appropriate tools to create the connector lines.`
          },
        },
      ],
      description: "Strategy for converting Figma prototype reactions to connector lines using the output of 'get_reactions'",
    };
  }
);


// Define command types and parameters
type FigmaCommand =
  | "get_document_info"
  | "get_selection"
  | "get_node_info"
  | "get_nodes_info"
  | "read_my_design"
  | "create_rectangle"
  | "create_frame"
  | "create_text"
  | "set_fill_color"
  | "set_image_fill"
  | "set_effects"
  | "set_text_style"
  | "reparent_node"
  | "rename_node"
  | "set_opacity"
  | "set_visible"
  | "set_locked"
  | "set_blend_mode"
  | "get_variable_collections"
  | "get_variables"
  | "create_variable_collection"
  | "create_variable"
  | "set_variable_value"
  | "add_variable_mode"
  | "rename_variable_mode"
  | "remove_variable_mode"
  | "bind_node_variable"
  | "unbind_node_variable"
  | "set_variable_alias"
  | "create_paint_style"
  | "create_text_style"
  | "create_effect_style"
  | "create_grid_style"
  | "apply_style"
  | "rename_style"
  | "delete_style"
  | "set_constraints"
  | "add_fill"
  | "remove_fill_at"
  | "set_image_filters"
  | "get_image_bytes_by_hash"
  | "get_viewport_bounds"
  | "set_viewport_zoom"
  | "set_viewport_center"
  | "scroll_and_zoom_into_view"
  | "set_plugin_data"
  | "get_plugin_data"
  | "set_shared_plugin_data"
  | "get_shared_plugin_data"
  | "create_sticky"
  | "create_shape_with_text"
  | "create_table"
  | "create_component_from_node"
  | "detach_instance"
  | "swap_instance"
  | "create_component_set"
  | "add_component_property"
  | "set_component_property"
  | "set_stroke_color"
  | "move_node"
  | "resize_node"
  | "delete_node"
  | "delete_multiple_nodes"
  | "get_styles"
  | "get_local_components"
  | "create_component_instance"
  | "get_instance_overrides"
  | "set_instance_overrides"
  | "export_node_as_image"
  | "join"
  | "set_corner_radius"
  | "clone_node"
  | "set_text_content"
  | "scan_text_nodes"
  | "set_multiple_text_contents"
  | "get_annotations"
  | "set_annotation"
  | "set_multiple_annotations"
  | "scan_nodes_by_types"
  | "set_layout_mode"
  | "set_padding"
  | "set_axis_align"
  | "set_layout_sizing"
  | "set_item_spacing"
  | "get_reactions"
  | "set_default_connector"
  | "create_connections"
  | "set_focus"
  | "set_selections";

type CommandParams = {
  get_document_info: Record<string, never>;
  get_selection: Record<string, never>;
  get_node_info: { nodeId: string };
  get_nodes_info: { nodeIds: string[] };
  create_rectangle: {
    x: number;
    y: number;
    width: number;
    height: number;
    name?: string;
    parentId?: string;
  };
  create_frame: {
    x: number;
    y: number;
    width: number;
    height: number;
    name?: string;
    parentId?: string;
    fillColor?: { r: number; g: number; b: number; a?: number };
    strokeColor?: { r: number; g: number; b: number; a?: number };
    strokeWeight?: number;
  };
  create_text: {
    x: number;
    y: number;
    text: string;
    fontSize?: number;
    fontWeight?: number;
    fontColor?: { r: number; g: number; b: number; a?: number };
    name?: string;
    parentId?: string;
  };
  set_fill_color: {
    nodeId: string;
    r: number;
    g: number;
    b: number;
    a?: number;
  };
  set_image_fill: {
    nodeId: string;
    imageHash?: string;
    imageBytes?: string;
    scaleMode?: "FILL" | "FIT" | "CROP" | "TILE";
    opacity?: number;
    rotation?: number;
    replace?: boolean;
  };
  reparent_node: {
    nodeId: string;
    newParentId: string;
    index?: number;
    preservePosition?: boolean;
  };
  set_effects: {
    nodeId: string;
    effects: Array<{
      type: "DROP_SHADOW" | "INNER_SHADOW" | "LAYER_BLUR" | "BACKGROUND_BLUR";
      color?: { r: number; g: number; b: number; a?: number };
      offset?: { x: number; y: number };
      radius?: number;
      spread?: number;
      blendMode?: string;
      visible?: boolean;
    }>;
    append?: boolean;
  };
  set_text_style: {
    nodeId: string;
    fontFamily?: string;
    fontStyle?: string;
    fontSize?: number;
    letterSpacing?: number | { value: number; unit: "PIXELS" | "PERCENT" };
    lineHeight?: number | "AUTO" | { value: number; unit: "PIXELS" | "PERCENT" };
    textCase?: "ORIGINAL" | "UPPER" | "LOWER" | "TITLE" | "SMALL_CAPS" | "SMALL_CAPS_FORCED";
    textDecoration?: "NONE" | "UNDERLINE" | "STRIKETHROUGH";
    textAlignHorizontal?: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
    textAlignVertical?: "TOP" | "CENTER" | "BOTTOM";
    paragraphSpacing?: number;
    paragraphIndent?: number;
  };
  rename_node: { nodeId: string; name: string };
  set_opacity: { nodeId: string; opacity: number };
  set_visible: { nodeId: string; visible: boolean };
  set_locked: { nodeId: string; locked: boolean };
  set_blend_mode: { nodeId: string; blendMode: string };
  get_variable_collections: Record<string, never>;
  get_variables: { collectionId?: string };
  create_variable_collection: { name: string };
  create_variable: {
    collectionId: string;
    name: string;
    type: "BOOLEAN" | "FLOAT" | "STRING" | "COLOR";
    value?: any;
  };
  set_variable_value: {
    variableId: string;
    modeId: string;
    value: any;
  };
  add_variable_mode: { collectionId: string; name: string };
  rename_variable_mode: { collectionId: string; modeId: string; name: string };
  remove_variable_mode: { collectionId: string; modeId: string };
  bind_node_variable: {
    nodeId: string;
    field: string;
    variableId: string;
    paintIndex?: number;
    paintProperty?: "color";
  };
  unbind_node_variable: {
    nodeId: string;
    field: string;
    paintIndex?: number;
    paintProperty?: "color";
  };
  set_variable_alias: {
    variableId: string;
    modeId: string;
    targetVariableId: string;
  };
  create_paint_style: {
    name: string;
    paints: any[];
    description?: string;
  };
  create_text_style: {
    name: string;
    fontFamily: string;
    fontStyle: string;
    fontSize: number;
    letterSpacing?: number | { value: number; unit: "PIXELS" | "PERCENT" };
    lineHeight?: number | "AUTO" | { value: number; unit: "PIXELS" | "PERCENT" };
    textCase?: "ORIGINAL" | "UPPER" | "LOWER" | "TITLE" | "SMALL_CAPS" | "SMALL_CAPS_FORCED";
    textDecoration?: "NONE" | "UNDERLINE" | "STRIKETHROUGH";
    paragraphSpacing?: number;
    paragraphIndent?: number;
    description?: string;
  };
  create_effect_style: {
    name: string;
    effects: any[];
    description?: string;
  };
  create_grid_style: {
    name: string;
    layoutGrids: any[];
    description?: string;
  };
  apply_style: {
    nodeId: string;
    styleId: string;
    target: "fill" | "stroke" | "text" | "effect" | "grid";
  };
  rename_style: { styleId: string; name: string };
  delete_style: { styleId: string };
  set_constraints: {
    nodeId: string;
    horizontal?: "MIN" | "MAX" | "CENTER" | "STRETCH" | "SCALE";
    vertical?: "MIN" | "MAX" | "CENTER" | "STRETCH" | "SCALE";
  };
  add_fill: { nodeId: string; paint: any; index?: number };
  remove_fill_at: { nodeId: string; index: number };
  set_image_filters: {
    nodeId: string;
    filters: Partial<{
      exposure: number; contrast: number; saturation: number;
      temperature: number; tint: number; highlights: number; shadows: number;
    }>;
    paintIndex?: number;
    target?: "fills" | "strokes";
  };
  get_image_bytes_by_hash: { imageHash: string };
  get_viewport_bounds: Record<string, never>;
  set_viewport_zoom: { zoom: number };
  set_viewport_center: { x: number; y: number };
  scroll_and_zoom_into_view: { nodeIds: string[] };
  set_plugin_data: { nodeId: string; key: string; value: string };
  get_plugin_data: { nodeId: string; key: string };
  set_shared_plugin_data: { nodeId: string; namespace: string; key: string; value: string };
  get_shared_plugin_data: { nodeId: string; namespace: string; key: string };
  create_sticky: { text?: string; x?: number; y?: number; parentId?: string; authorVisible?: boolean };
  create_shape_with_text: {
    shapeType?: string;
    text?: string;
    x?: number; y?: number; parentId?: string;
    width?: number; height?: number;
  };
  create_table: { rows?: number; cols?: number; x?: number; y?: number; parentId?: string };
  create_component_from_node: { nodeId: string };
  detach_instance: { nodeId: string };
  swap_instance: { nodeId: string; mainComponentId: string };
  create_component_set: { componentIds: string[]; name?: string };
  add_component_property: {
    componentSetId: string;
    name: string;
    type: "BOOLEAN" | "TEXT" | "INSTANCE_SWAP" | "VARIANT";
    defaultValue: any;
    options?: Record<string, any>;
  };
  set_component_property: {
    instanceId: string;
    properties: Record<string, any>;
  };
  set_stroke_color: {
    nodeId: string;
    r: number;
    g: number;
    b: number;
    a?: number;
    weight?: number;
  };
  move_node: {
    nodeId: string;
    x: number;
    y: number;
  };
  resize_node: {
    nodeId: string;
    width: number;
    height: number;
  };
  delete_node: {
    nodeId: string;
  };
  delete_multiple_nodes: {
    nodeIds: string[];
  };
  get_styles: Record<string, never>;
  get_local_components: Record<string, never>;
  get_team_components: Record<string, never>;
  create_component_instance: {
    componentKey: string;
    x: number;
    y: number;
  };
  get_instance_overrides: {
    instanceNodeId: string | null;
  };
  set_instance_overrides: {
    targetNodeIds: string[];
    sourceInstanceId: string;
  };
  export_node_as_image: {
    nodeId: string;
    format?: "PNG" | "JPG" | "SVG" | "PDF";
    scale?: number;
    constraint?: { type: "SCALE" | "WIDTH" | "HEIGHT"; value: number };
    contentsOnly?: boolean;
    useAbsoluteBounds?: boolean;
  };
  execute_code: {
    code: string;
  };
  join: {
    channel: string;
  };
  set_corner_radius: {
    nodeId: string;
    radius: number;
    corners?: boolean[];
  };
  clone_node: {
    nodeId: string;
    x?: number;
    y?: number;
  };
  set_text_content: {
    nodeId: string;
    text: string;
  };
  scan_text_nodes: {
    nodeId: string;
    useChunking: boolean;
    chunkSize: number;
  };
  set_multiple_text_contents: {
    nodeId: string;
    text: Array<{ nodeId: string; text: string }>;
  };
  get_annotations: {
    nodeId?: string;
    includeCategories?: boolean;
  };
  set_annotation: {
    nodeId: string;
    annotationId?: string;
    labelMarkdown: string;
    categoryId?: string;
    properties?: Array<{ type: string }>;
  };
  set_multiple_annotations: SetMultipleAnnotationsParams;
  scan_nodes_by_types: {
    nodeId: string;
    types: Array<string>;
  };
  get_reactions: { nodeIds: string[] };
  set_default_connector: {
    connectorId?: string | undefined;
  };
  create_connections: {
    connections: Array<{
      startNodeId: string;
      endNodeId: string;
      text?: string;
    }>;
  };
  set_focus: {
    nodeId: string;
  };
  set_selections: {
    nodeIds: string[];
  };

};


// Helper function to process Figma node responses
function processFigmaNodeResponse(result: unknown): any {
  if (!result || typeof result !== "object") {
    return result;
  }

  // Check if this looks like a node response
  const resultObj = result as Record<string, unknown>;
  if ("id" in resultObj && typeof resultObj.id === "string") {
    // It appears to be a node response, log the details
    console.info(
      `Processed Figma node: ${resultObj.name || "Unknown"} (ID: ${resultObj.id
      })`
    );

    if ("x" in resultObj && "y" in resultObj) {
      console.debug(`Node position: (${resultObj.x}, ${resultObj.y})`);
    }

    if ("width" in resultObj && "height" in resultObj) {
      console.debug(`Node dimensions: ${resultObj.width}×${resultObj.height}`);
    }
  }

  return result;
}

// Update the connectToFigma function
function connectToFigma(port: number = 3055) {
  // If already connected, do nothing
  if (ws && ws.readyState === WebSocket.OPEN) {
    logger.info('Already connected to Figma');
    return;
  }

  const wsUrl = serverUrl === 'localhost' ? `${WS_URL}:${port}` : WS_URL;
  logger.info(`Connecting to Figma socket server at ${wsUrl}...`);
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    logger.info('Connected to Figma socket server');
    reconnectAttempts = 0;

    // Auto-rejoin the previously active channel after a reconnect.
    // Without this, subsequent commands fail with "Must join a channel...".
    const channelToRejoin = currentChannel;
    if (channelToRejoin) {
      currentChannel = null; // sendCommandToFigma allows "join" without a channel
      sendCommandToFigma("join", { channel: channelToRejoin })
        .then(() => {
          currentChannel = channelToRejoin;
          logger.info(`Rejoined channel: ${channelToRejoin}`);
        })
        .catch((err) => {
          logger.error(`Failed to rejoin channel ${channelToRejoin}: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
  });

  ws.on("message", (data: any) => {
    try {
      // Define a more specific type with an index signature to allow any property access
      interface ProgressMessage {
        message: FigmaResponse | any;
        type?: string;
        id?: string;
        [key: string]: any; // Allow any other properties
      }

      const json = JSON.parse(data) as ProgressMessage;

      // Handle progress updates
      if (json.type === 'progress_update') {
        const progressData = json.message.data as CommandProgressUpdate;
        const requestId = json.id || '';

        if (requestId && pendingRequests.has(requestId)) {
          const request = pendingRequests.get(requestId)!;

          // Update last activity timestamp
          request.lastActivity = Date.now();

          // Reset the timeout to prevent timeouts during long-running operations
          clearTimeout(request.timeout);

          // Re-arm with the inactivity budget. As long as Figma keeps
          // streaming progress_updates, the request stays alive past its
          // initial timeout (BL-007).
          request.timeout = setTimeout(() => {
            if (pendingRequests.has(requestId)) {
              logger.error(`Request ${requestId} timed out after ${TIMEOUTS.inactivity / 1000}s of inactivity`);
              pendingRequests.delete(requestId);
              request.reject(new Error('Request to Figma timed out (no progress)'));
            }
          }, TIMEOUTS.inactivity);

          // Log progress
          logger.info(`Progress update for ${progressData.commandType}: ${progressData.progress}% - ${progressData.message}`);

          // For completed updates, we could resolve the request early if desired
          if (progressData.status === 'completed' && progressData.progress === 100) {
            // Optionally resolve early with partial data
            // request.resolve(progressData.payload);
            // pendingRequests.delete(requestId);

            // Instead, just log the completion, wait for final result from Figma
            logger.info(`Operation ${progressData.commandType} completed, waiting for final result`);
          }
        }
        return;
      }

      // Handle regular responses
      const myResponse = json.message;
      logger.debug(`Received message: ${JSON.stringify(myResponse)}`);
      logger.log('myResponse' + JSON.stringify(myResponse));

      // Handle response to a request
      if (
        myResponse.id &&
        pendingRequests.has(myResponse.id) &&
        myResponse.result
      ) {
        const request = pendingRequests.get(myResponse.id)!;
        clearTimeout(request.timeout);

        if (myResponse.error) {
          logger.error(`Error from Figma: ${myResponse.error}`);
          request.reject(new Error(myResponse.error));
        } else {
          if (myResponse.result) {
            request.resolve(myResponse.result);
          }
        }

        pendingRequests.delete(myResponse.id);
      } else {
        // Handle broadcast messages or events
        logger.info(`Received broadcast message: ${JSON.stringify(myResponse)}`);
      }
    } catch (error) {
      logger.error(`Error parsing message: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ws.on('error', (error) => {
    logger.error(`Socket error: ${error}`);
  });

  ws.on('close', () => {
    logger.info('Disconnected from Figma socket server');
    ws = null;

    // Reject all pending requests
    for (const [id, request] of pendingRequests.entries()) {
      clearTimeout(request.timeout);
      request.reject(new Error("Connection closed"));
      pendingRequests.delete(id);
    }

    if (shuttingDown) return;

    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logger.error(`Giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`);
      return;
    }

    // Exponential backoff with cap (2s → 4s → 8s → ... → 30s)
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts),
      RECONNECT_MAX_DELAY_MS
    );
    reconnectAttempts++;
    logger.info(`Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectToFigma(port);
    }, delay);
  });
}

// Function to join a channel
async function joinChannel(channelName: string): Promise<void> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("Not connected to Figma");
  }

  try {
    await sendCommandToFigma("join", { channel: channelName });
    currentChannel = channelName;
    logger.info(`Joined channel: ${channelName}`);
  } catch (error) {
    logger.error(`Failed to join channel: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

// Function to send commands to Figma
function sendCommandToFigma(
  command: FigmaCommand,
  params: unknown = {},
  timeoutMs?: number
): Promise<unknown> {
  // Per-command default; explicit timeoutMs argument overrides the policy.
  const effectiveTimeout = timeoutMs ?? defaultTimeoutFor(command);
  return new Promise((resolve, reject) => {
    // If not connected, try to connect first
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectToFigma();
      reject(new Error("Not connected to Figma. Attempting to connect..."));
      return;
    }

    // Check if we need a channel for this command
    const requiresChannel = command !== "join";
    if (requiresChannel && !currentChannel) {
      reject(new Error("Must join a channel before sending commands"));
      return;
    }

    const id = uuidv4();
    // Optional shared-secret for the relay (BL-005). If set, attach it to
    // every "join" frame; otherwise omit the field entirely.
    const relayToken = process.env.FIGMA_RELAY_TOKEN || "";
    const request = {
      id,
      type: command === "join" ? "join" : "message",
      ...(command === "join"
        ? {
            channel: (params as any).channel,
            ...(relayToken ? { token: relayToken } : {}),
          }
        : { channel: currentChannel }),
      message: {
        id,
        command,
        params: {
          ...(params as any),
          commandId: id, // Include the command ID in params
        },
      },
    };

    // Set timeout for request
    const timeout = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        logger.error(`Request ${id} (${command}) to Figma timed out after ${effectiveTimeout / 1000}s`);
        reject(new Error(`Request to Figma timed out (${command}, ${effectiveTimeout / 1000}s)`));
      }
    }, effectiveTimeout);

    // Store the promise callbacks to resolve/reject later
    pendingRequests.set(id, {
      resolve,
      reject,
      timeout,
      lastActivity: Date.now()
    });

    // Send the request
    logger.info(`Sending command to Figma: ${command}`);
    logger.debug(`Request details: ${JSON.stringify(request)}`);
    ws.send(JSON.stringify(request));
  });
}

// Update the join_channel tool
server.tool(
  "join_channel",
  "Join a specific channel to communicate with Figma",
  {
    channel: z.string().describe("The name of the channel to join").default(""),
  },
  async ({ channel }: any) => {
    try {
      if (!channel) {
        // If no channel provided, ask the user for input
        return {
          content: [
            {
              type: "text",
              text: "Please provide a channel name to join:",
            },
          ],
          followUp: {
            tool: "join_channel",
            description: "Join the specified channel",
          },
        };
      }

      await joinChannel(channel);
      return {
        content: [
          {
            type: "text",
            text: `Successfully joined channel: ${channel}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error joining channel: ${error instanceof Error ? error.message : String(error)
              }`,
          },
        ],
      };
    }
  }
);

// Start the server
async function main() {
  try {
    // Try to connect to Figma socket server
    connectToFigma();
  } catch (error) {
    logger.warn(`Could not connect to Figma initially: ${error instanceof Error ? error.message : String(error)}`);
    logger.warn('Will try to connect when the first command is sent');
  }

  // Start the MCP server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('FigmaMCP server running on stdio');
}

// Run the server
main().catch(error => {
  logger.error(`Error starting FigmaMCP server: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});



