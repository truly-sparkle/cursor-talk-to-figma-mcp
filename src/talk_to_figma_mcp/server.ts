#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";
import { registerPrompts } from "./prompts/index.js";

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
  // BL-073: team-library calls hit the network (library fetch / import by key).
  "get_team_libraries",
  "import_library_component",
  "import_library_variable",
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

// ---- Paint / LayoutGrid zod schemas (BL-067) ----------------------
//
// Tightens previous z.any() in paint/grid arrays so MCP clients can
// auto-document the expected shape. Each schema uses .passthrough() —
// extra fields pass through to Figma without rejection (forward-compat
// for new Figma API fields).

const colorRGBA01 = z.object({
  r: z.number().min(0).max(1),
  g: z.number().min(0).max(1),
  b: z.number().min(0).max(1),
  a: z.number().min(0).max(1).optional(),
});

const gradientStopSchema = z.object({
  position: z.number().min(0).max(1),
  color: colorRGBA01,
});

const paintSchema = z.union([
  z.object({
    type: z.literal("SOLID"),
    color: colorRGBA01.omit({ a: true }),
    opacity: z.number().min(0).max(1).optional(),
    visible: z.boolean().optional(),
    blendMode: z.string().optional(),
  }).passthrough(),
  z.object({
    type: z.enum(["GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND"]),
    gradientStops: z.array(gradientStopSchema).min(2),
    gradientTransform: z.array(z.array(z.number())).optional(),
    opacity: z.number().min(0).max(1).optional(),
    visible: z.boolean().optional(),
  }).passthrough(),
  z.object({
    type: z.literal("IMAGE"),
    imageHash: z.string().optional(),
    scaleMode: z.enum(["FILL", "FIT", "CROP", "TILE"]).optional(),
    opacity: z.number().min(0).max(1).optional(),
    rotation: z.number().optional(),
    visible: z.boolean().optional(),
  }).passthrough(),
]);

const layoutGridSchema = z.union([
  z.object({
    pattern: z.literal("COLUMNS"),
    count: z.number().int().positive(),
    sectionSize: z.number().positive().optional(),
    offset: z.number().optional(),
    gutterSize: z.number().nonnegative().optional(),
    alignment: z.enum(["MIN", "MAX", "STRETCH", "CENTER"]).optional(),
    color: colorRGBA01.optional(),
    visible: z.boolean().optional(),
  }).passthrough(),
  z.object({
    pattern: z.literal("ROWS"),
    count: z.number().int().positive(),
    sectionSize: z.number().positive().optional(),
    offset: z.number().optional(),
    gutterSize: z.number().nonnegative().optional(),
    alignment: z.enum(["MIN", "MAX", "STRETCH", "CENTER"]).optional(),
    color: colorRGBA01.optional(),
    visible: z.boolean().optional(),
  }).passthrough(),
  z.object({
    pattern: z.literal("GRID"),
    sectionSize: z.number().positive(),
    color: colorRGBA01.optional(),
    visible: z.boolean().optional(),
  }).passthrough(),
]);

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
    paint: paintSchema.describe("Paint object — SOLID/GRADIENT_*/IMAGE union"),
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

// ---- Dev Mode / Code Connect (BL-034) ------------------------------
//
// Attach Dev-Mode resources (GitHub/Storybook URLs etc.) and Dev status
// (READY_FOR_DEV / COMPLETED / NONE) to FrameNode-like containers
// (FRAME, COMPONENT, COMPONENT_SET, INSTANCE, SECTION). Calls on
// unsupported nodes return a clear "does not support" error.

wrapToolHandler(
  "set_dev_resource",
  "Add a Dev-Mode resource link (URL + label) to a node via node.addDevResourceAsync. " +
  "Idempotent: Figma dedupes by URL — adding the same URL twice returns the existing resource.",
  {
    nodeId: z.string(),
    name: z.string().min(1).describe("Display label (e.g. 'Storybook')"),
    url: z.string().min(1).describe("Resource URL"),
  },
  (r: any) => `Set dev resource on "${r.name}" (${r.type})${r.resourceId ? ` → ${r.resourceId}` : ""}`,
);

wrapToolHandler(
  "get_dev_resources",
  "List Dev-Mode resources attached to a node (node.devResources). Returns array of { id, name, url }.",
  {
    nodeId: z.string(),
  },
  (r: any) => `${r.resources.length} dev resource(s) on "${r.name}"`,
);

wrapToolHandler(
  "set_dev_status",
  "Set a node's Dev-Mode status: READY_FOR_DEV, COMPLETED, or NONE (clears it). " +
  "Optional description shows next to the status badge.",
  {
    nodeId: z.string(),
    type: z.enum(["READY_FOR_DEV", "COMPLETED", "NONE"]),
    description: z.string().optional(),
  },
  (r: any) => r.devStatus
    ? `Dev status on "${r.name}": ${r.devStatus.type}${r.devStatus.description ? ` — ${r.devStatus.description}` : ""}`
    : `Cleared dev status on "${r.name}"`,
);

// ---- Prototyping / Interactions (BL-014) --------------------------
//
// Wrappers for Figma's prototype reactions, page-level flow starting
// points, frame overflow direction, and the page-level prototypeDevice.
// `set_reaction` replaces the node's reactions array with a single
// entry — Figma allows multiple reactions per node, but the v1 surface
// keeps the API small. Use `clear_reactions` to remove all.

const reactionTriggerSchema = z.union([
  z.object({ type: z.enum(["ON_CLICK", "ON_HOVER", "ON_PRESS", "ON_DRAG"]) }),
  z.object({
    type: z.enum(["MOUSE_ENTER", "MOUSE_LEAVE", "MOUSE_UP", "MOUSE_DOWN"]),
    delay: z.number().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("AFTER_TIMEOUT"),
    timeout: z.number().nonnegative().describe("Delay in seconds"),
  }),
  z.object({
    type: z.literal("ON_KEY_DOWN"),
    device: z.enum([
      "KEYBOARD", "XBOX_ONE", "PS4", "SWITCH_PRO", "UNKNOWN_CONTROLLER",
    ]).optional(),
    keyCodes: z.array(z.number().int()).describe("Key codes (KeyboardEvent.keyCode style)"),
  }),
]);

const reactionActionSchema = z.union([
  z.object({ type: z.literal("BACK") }),
  z.object({ type: z.literal("CLOSE") }),
  z.object({
    type: z.literal("URL"),
    url: z.string().min(1),
  }),
  z.object({
    type: z.literal("NODE"),
    destinationId: z.string().min(1),
    navigation: z.enum(["NAVIGATE", "OVERLAY", "SWAP", "PUSH", "BACK", "CLOSE"]),
    transition: z.any().optional().describe("Transition object (figma.NavigationTransition)"),
    preserveScrollPosition: z.boolean().optional(),
    overlayRelativePosition: z.any().optional(),
    resetVideoPosition: z.boolean().optional(),
    resetScrollPosition: z.boolean().optional(),
    resetInteractiveComponents: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("SCROLL_TO"),
    destinationId: z.string().min(1),
    transition: z.any().optional(),
  }),
  // Passthrough for less-common action shapes (variables, conditional).
  z.object({
    type: z.enum(["SET_VARIABLE", "SET_VARIABLE_MODE", "CONDITIONAL"]),
  }).passthrough(),
]);

wrapToolHandler(
  "set_reaction",
  "Set a single prototype reaction on a node, replacing any existing reactions array. " +
  "Trigger forms: ON_CLICK / ON_HOVER / ON_PRESS / ON_DRAG / MOUSE_*; AFTER_TIMEOUT (timeout in seconds); ON_KEY_DOWN (keyCodes[]). " +
  "Action forms: NODE (destinationId + navigation: NAVIGATE/OVERLAY/SWAP/PUSH/BACK/CLOSE), URL, BACK, CLOSE, SCROLL_TO. " +
  "Use clear_reactions to remove all reactions.",
  {
    nodeId: z.string().describe("Node to attach the reaction to"),
    trigger: reactionTriggerSchema,
    action: reactionActionSchema,
  },
  (r: any) => `Set reaction on "${r.name}" (${r.type}): ${r.reaction.trigger.type} -> ${r.reaction.action.type}`,
);

wrapToolHandler(
  "clear_reactions",
  "Clear all prototype reactions on a node (sets reactions = []).",
  { nodeId: z.string() },
  (r: any) => `Cleared reactions on "${r.name}" (${r.type})`,
);

wrapToolHandler(
  "set_flow_starting_point",
  "Add (or update) a flow starting point on a page. If a starting point with the same nodeId " +
  "already exists, its name is updated; otherwise a new entry is appended to page.flowStartingPoints. " +
  "The node should be a top-level frame on the page for the flow to be useful in the prototype panel.",
  {
    pageId: z.string().describe("ID of the PAGE node owning the flow"),
    nodeId: z.string().describe("ID of the frame that starts the flow"),
    name: z.string().optional().describe("Display name; defaults to 'Flow <node name>'"),
  },
  (r: any) =>
    `${r.replaced ? "Updated" : "Added"} flow starting point "${r.name}" on page ${r.pageId} ` +
    `(now ${r.flowStartingPointsCount} flow(s))`,
);

wrapToolHandler(
  "set_overflow_direction",
  "Set a frame's prototype overflow direction (controls scroll behavior in prototypes). " +
  "NONE | HORIZONTAL | VERTICAL | BOTH.",
  {
    nodeId: z.string(),
    direction: z.enum(["NONE", "HORIZONTAL", "VERTICAL", "BOTH"]),
  },
  (r: any) => `Set overflowDirection on "${r.name}" to ${r.overflowDirection}`,
);

wrapToolHandler(
  "set_prototype_device",
  "Set figma.currentPage.prototypeDevice — the device frame used when running the prototype. " +
  "Pass a preset shorthand (just presetIdentifier) for a quick PRESET, or supply { type, size?, presetIdentifier?, rotation? } " +
  "for full control. type: NONE | PRESET | CUSTOM | PRESENTATION.",
  {
    presetIdentifier: z.string().optional().describe("Figma preset id, e.g. 'IPHONE_15_PRO'"),
    type: z.enum(["NONE", "PRESET", "CUSTOM", "PRESENTATION"]).optional(),
    size: z.object({
      width: z.number().positive(),
      height: z.number().positive(),
    }).optional().describe("Required when type='CUSTOM'"),
    rotation: z.enum(["NONE", "CCW_90"]).optional(),
  },
  (r: any) => {
    const d = r.prototypeDevice || {};
    const parts = [d.type || "?"];
    if (d.presetIdentifier) parts.push(d.presetIdentifier);
    if (d.size) parts.push(`${d.size.width}×${d.size.height}`);
    if (d.rotation) parts.push(d.rotation);
    return `Set prototypeDevice on page ${r.pageId}: ${parts.join(" / ")}`;
  },
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

// ---- Gradient & image paints (BL-009, BL-010) ---------------------

const gradientArgs = {
  nodeId: z.string(),
  gradientType: z.enum(["GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND"]),
  gradientStops: z.array(z.object({
    position: z.number().min(0).max(1),
    color: z.object({
      r: z.number().min(0).max(1),
      g: z.number().min(0).max(1),
      b: z.number().min(0).max(1),
      a: z.number().min(0).max(1).optional(),
    }),
  })).min(2),
  gradientTransform: z.array(z.array(z.number())).optional()
    .describe("2x3 affine transform [[a,b,tx],[c,d,ty]]; default identity (left→right linear)"),
  opacity: z.number().min(0).max(1).optional(),
  visible: z.boolean().optional(),
  replace: z.boolean().optional().describe("Default true. false to append to existing paints"),
};

wrapToolHandler(
  "set_gradient_fill",
  "Set a gradient fill (LINEAR/RADIAL/ANGULAR/DIAMOND). Stops in 0..1 with RGBA colors. " +
  "gradientTransform 2x3 controls direction/scale (identity = horizontal). " +
  "replace=true (default) replaces fills array; false appends.",
  gradientArgs,
  (r: any) => `Set gradient fill on "${r.name}" (${r.paint.gradientStops.length} stops)`,
);

wrapToolHandler(
  "set_gradient_stroke",
  "Set a gradient stroke. Same args as set_gradient_fill but for strokes[].",
  gradientArgs,
  (r: any) => `Set gradient stroke on "${r.name}" (${r.paint.gradientStops.length} stops)`,
);

wrapToolHandler(
  "set_image_stroke",
  "Set an image stroke. Provide imageHash OR imageBytes (base64). Same shape as set_image_fill.",
  {
    nodeId: z.string(),
    imageHash: z.string().optional(),
    imageBytes: z.string().optional(),
    scaleMode: z.enum(["FILL", "FIT", "CROP", "TILE"]).optional(),
    opacity: z.number().min(0).max(1).optional(),
    rotation: z.number().optional(),
    visible: z.boolean().optional(),
    replace: z.boolean().optional(),
  },
  (r: any) => `Set image stroke on "${r.name}" (hash: ${r.paint.imageHash})`,
);

// ---- Stroke properties full set (BL-013) --------------------------

wrapToolHandler(
  "set_stroke_weight",
  "Set stroke weight (uniform). For per-side weights see set_individual_stroke_weights.",
  { nodeId: z.string(), weight: z.number().min(0) },
  (r: any) => `Set strokeWeight on "${r.name}" to ${r.strokeWeight}`,
);

wrapToolHandler(
  "set_stroke_align",
  "Set stroke alignment: CENTER | INSIDE | OUTSIDE.",
  { nodeId: z.string(), align: z.enum(["CENTER", "INSIDE", "OUTSIDE"]) },
  (r: any) => `Set strokeAlign on "${r.name}" to ${r.strokeAlign}`,
);

wrapToolHandler(
  "set_stroke_cap",
  "Set stroke endpoint cap: NONE | ROUND | SQUARE | ARROW_LINES | ARROW_EQUILATERAL.",
  { nodeId: z.string(), cap: z.enum(["NONE", "ROUND", "SQUARE", "ARROW_LINES", "ARROW_EQUILATERAL"]) },
  (r: any) => `Set strokeCap on "${r.name}" to ${r.strokeCap}`,
);

wrapToolHandler(
  "set_stroke_join",
  "Set stroke corner join: MITER | BEVEL | ROUND.",
  { nodeId: z.string(), join: z.enum(["MITER", "BEVEL", "ROUND"]) },
  (r: any) => `Set strokeJoin on "${r.name}" to ${r.strokeJoin}`,
);

wrapToolHandler(
  "set_dash_pattern",
  "Set stroke dash pattern: array of dash/gap lengths. Empty array = solid.",
  { nodeId: z.string(), pattern: z.array(z.number().min(0)) },
  (r: any) => `Set dashPattern on "${r.name}" to [${r.dashPattern.join(", ")}]`,
);

wrapToolHandler(
  "set_individual_stroke_weights",
  "Set per-side stroke weights (RECTANGLE/FRAME). Provide one or more of top/right/bottom/left.",
  {
    nodeId: z.string(),
    top: z.number().min(0).optional(),
    right: z.number().min(0).optional(),
    bottom: z.number().min(0).optional(),
    left: z.number().min(0).optional(),
  },
  (r: any) => `Set individual stroke weights on "${r.name}": T=${r.strokeTopWeight} R=${r.strokeRightWeight} B=${r.strokeBottomWeight} L=${r.strokeLeftWeight}`,
);

// ---- Z-order / grouping (BL-017) ----------------------------------

wrapToolHandler(
  "reorder_node",
  "Move a node to a specific z-index within its current parent.",
  { nodeId: z.string(), index: z.number().int().nonnegative() },
  (r: any) => `Reordered "${r.name}" to index ${r.index}`,
);

wrapToolHandler(
  "group_nodes",
  "Group nodes into a GroupNode (figma.group). All nodes should share the same parent. parentId optional (defaults to first node's parent or current page).",
  { nodeIds: z.array(z.string()).min(1), parentId: z.string().optional(), name: z.string().optional() },
  (r: any) => `Created group "${r.id}" (${r.childCount} children)`,
);

wrapToolHandler(
  "ungroup_node",
  "Ungroup a GroupNode — children become siblings of the group's parent. Returns the freed children.",
  { nodeId: z.string() },
  (r: any) => `Ungrouped ${r.ungroupedFrom} → ${r.children.length} children`,
);

wrapToolHandler(
  "bring_to_front",
  "Move a node to the front (last child of its parent — topmost z-order).",
  { nodeId: z.string() },
  (r: any) => `Brought ${r.id} to front (index ${r.index})`,
);

wrapToolHandler(
  "send_to_back",
  "Move a node to the back (first child — bottom of z-order).",
  { nodeId: z.string() },
  (r: any) => `Sent ${r.id} to back`,
);

// ---- Text advanced (BL-023) ---------------------------------------

wrapToolHandler(
  "set_text_range_style",
  "Apply font/size/spacing/case/decoration/fills to a substring of a text node. " +
  "style is a partial; only specified keys are applied. Range is [start, end). " +
  "Fonts in the range are auto-loaded.",
  {
    nodeId: z.string(),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    style: z.object({
      fontFamily: z.string().optional(),
      fontStyle: z.string().optional(),
      fontSize: z.number().positive().optional(),
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
      fills: z.array(paintSchema).optional(),
    }),
  },
  (r: any) => `Applied style on ${r.id} [${r.start}, ${r.end}): ${r.applied.join(", ")}`,
);

wrapToolHandler(
  "set_hyperlink",
  "Set or clear a URL hyperlink on a text range. Pass href=null to clear.",
  {
    nodeId: z.string(),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    href: z.string().nullable(),
  },
  (r: any) => r.cleared ? `Cleared hyperlink on [${r.start}, ${r.end})` : `Set hyperlink on [${r.start}, ${r.end}) → ${r.href}`,
);

wrapToolHandler(
  "set_text_auto_resize",
  "Set text node's auto-resize behavior: WIDTH_AND_HEIGHT (grow both) | HEIGHT (fixed width, grow height) | NONE (fixed) | TRUNCATE.",
  {
    nodeId: z.string(),
    mode: z.enum(["WIDTH_AND_HEIGHT", "HEIGHT", "NONE", "TRUNCATE"]),
  },
  (r: any) => `Set textAutoResize on "${r.name}" to ${r.textAutoResize}`,
);

wrapToolHandler(
  "set_text_truncation",
  "Set text truncation: 'DISABLED' or 'ENDING' (with optional maxLines).",
  {
    nodeId: z.string(),
    truncation: z.enum(["DISABLED", "ENDING"]),
    maxLines: z.number().int().min(1).optional(),
  },
  (r: any) => `Set textTruncation on "${r.name}": ${r.textTruncation}${r.maxLines ? ` (maxLines=${r.maxLines})` : ""}`,
);

wrapToolHandler(
  "set_list_options",
  "Apply list formatting (bullet/numbered) to a text range. Optional indentLevel adjusts nesting.",
  {
    nodeId: z.string(),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    listType: z.enum(["ORDERED", "UNORDERED", "NONE"]),
    indentLevel: z.number().int().min(0).optional(),
  },
  (r: any) => `Set list ${r.listType} on [${r.start}, ${r.end})${r.indentLevel != null ? ` indent=${r.indentLevel}` : ""}`,
);

// ---- Node creation expansion (BL-011) -----------------------------

const placement = {
  x: z.number().optional(),
  y: z.number().optional(),
  parentId: z.string().optional(),
  name: z.string().optional(),
};
const sized = {
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
};

wrapToolHandler(
  "create_ellipse",
  "Create an ELLIPSE node. width/height optional (Figma default 100×100).",
  { ...placement, ...sized },
  (r: any) => `Created ellipse "${r.id}" at (${r.x}, ${r.y})`,
);

wrapToolHandler(
  "create_line",
  "Create a LINE from (x1,y1) to (x2,y2). Length+rotation derived from endpoints; node is anchored at start. Optional strokeColor (RGBA 0-1) and strokeWeight.",
  {
    x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(),
    name: z.string().optional(),
    parentId: z.string().optional(),
    strokeColor: z.object({
      r: z.number().min(0).max(1),
      g: z.number().min(0).max(1),
      b: z.number().min(0).max(1),
      a: z.number().min(0).max(1).optional(),
    }).optional(),
    strokeWeight: z.number().positive().optional(),
  },
  (r: any) => `Created line "${r.id}" length ${r.length.toFixed(1)} rot ${r.rotation.toFixed(1)}°`,
);

wrapToolHandler(
  "create_polygon",
  "Create a POLYGON. pointCount default 3 (must be ≥3).",
  { ...placement, ...sized, pointCount: z.number().int().min(3).optional() },
  (r: any) => `Created polygon "${r.id}" (${r.pointCount} sides)`,
);

wrapToolHandler(
  "create_star",
  "Create a STAR. pointCount default 5 (must be ≥3). innerRadius is the star ratio 0..1 (smaller = pointier).",
  {
    ...placement, ...sized,
    pointCount: z.number().int().min(3).optional(),
    innerRadius: z.number().min(0).max(1).optional(),
  },
  (r: any) => `Created star "${r.id}" (${r.pointCount} points, inner ${r.innerRadius})`,
);

wrapToolHandler(
  "create_vector",
  "Create a VECTOR from one or more SVG path strings. " +
  "paths: [{ data: 'M ... Z', windingRule?: 'NONZERO' | 'EVENODD' }]. " +
  "Use this for arbitrary shapes you can't compose from rect/ellipse/polygon.",
  {
    ...placement,
    paths: z.array(z.object({
      data: z.string().min(1),
      windingRule: z.enum(["NONZERO", "EVENODD"]).optional(),
    })).min(1),
  },
  (r: any) => `Created vector "${r.id}" with ${r.pathCount} path(s)`,
);

wrapToolHandler(
  "create_section",
  "Create a SECTION (canvas-level grouping container, not a Frame).",
  { ...placement, ...sized },
  (r: any) => `Created section "${r.id}" at (${r.x}, ${r.y})`,
);

wrapToolHandler(
  "create_component",
  "Create an empty COMPONENT (vs create_component_from_node which promotes an existing node).",
  { ...placement, ...sized },
  (r: any) => `Created empty component "${r.id}" (key: ${r.key})`,
);

wrapToolHandler(
  "combine_as_variants",
  "Wrap existing components as a Component Set (figma.combineAsVariants). " +
  "Lower-level than create_component_set (BL-056) — same call but keep BL-056's nicer ergonomics for typical use.",
  {
    componentIds: z.array(z.string()).min(1),
    parentId: z.string().optional(),
    name: z.string().optional(),
  },
  (r: any) => `Combined ${r.variantCount} variants into "${r.id}"`,
);

// ---- Page management (BL-012) -------------------------------------

wrapToolHandler(
  "get_pages",
  "List all pages in the current document. Returns id/name/childCount/isCurrent/index.",
  {},
  (r: any) => `${r.count} page(s); current=${r.currentPageId}`,
);

wrapToolHandler(
  "create_page",
  "Create a new page. If `index` is given, insert there; otherwise append at end.",
  { name: z.string().min(1), index: z.number().int().nonnegative().optional() },
  (r: any) => `Created page "${r.name}" at index ${r.index} (id: ${r.id})`,
);

wrapToolHandler(
  "delete_page",
  "Delete a page. Refuses to delete the last remaining page. If deleting the current page, switches to another first.",
  { pageId: z.string() },
  (r: any) => `Deleted page ${r.deletedId} (${r.remaining} remaining)`,
);

wrapToolHandler(
  "rename_page",
  "Rename a page.",
  { pageId: z.string(), name: z.string().min(1) },
  (r: any) => `Renamed page ${r.id} → "${r.name}"`,
);

wrapToolHandler(
  "set_current_page",
  "Switch the active page (figma.setCurrentPageAsync). Required for dynamic-page documentAccess mode.",
  { pageId: z.string() },
  (r: any) => `Current page: "${r.name}" (${r.currentPageId})`,
);

wrapToolHandler(
  "reorder_pages",
  "Reorder pages on the document. orderedIds must list the new order; all referenced ids must be existing PAGE nodes (omitted pages keep their relative position at the end).",
  { orderedIds: z.array(z.string()).min(1) },
  (r: any) => `Reordered to ${r.pages.length} pages`,
);

// ---- Auto-layout advanced (BL-021) --------------------------------

wrapToolHandler(
  "set_layout_wrap",
  "Set auto-layout wrap mode on a frame. wrap: NO_WRAP | WRAP. Frame must have layoutMode != 'NONE'.",
  { nodeId: z.string(), wrap: z.enum(["NO_WRAP", "WRAP"]) },
  (r: any) => `Set layoutWrap on "${r.name}" to ${r.layoutWrap}`,
);

wrapToolHandler(
  "set_min_max_size",
  "Set min/max width and height on a node. Provide one or more; null clears the constraint. Negative values rejected.",
  {
    nodeId: z.string(),
    minWidth: z.number().min(0).nullable().optional(),
    maxWidth: z.number().min(0).nullable().optional(),
    minHeight: z.number().min(0).nullable().optional(),
    maxHeight: z.number().min(0).nullable().optional(),
  },
  (r: any) => `Set size constraints on "${r.name}": minW=${r.minWidth} maxW=${r.maxWidth} minH=${r.minHeight} maxH=${r.maxHeight}`,
);

wrapToolHandler(
  "set_layout_align",
  "Set a CHILD's layoutAlign within its auto-layout parent. Differs from set_axis_align (which sets parent's primary/counterAxisAlignItems). Values: MIN | CENTER | MAX | STRETCH | INHERIT.",
  {
    nodeId: z.string(),
    align: z.enum(["MIN", "CENTER", "MAX", "STRETCH", "INHERIT"]),
  },
  (r: any) => `Set layoutAlign on "${r.name}" to ${r.layoutAlign}`,
);

wrapToolHandler(
  "set_layout_grow",
  "Set node.layoutGrow (0 or 1). 1 = fill main axis when in auto-layout parent.",
  { nodeId: z.string(), grow: z.union([z.literal(0), z.literal(1)]) },
  (r: any) => `Set layoutGrow on "${r.name}" to ${r.layoutGrow}`,
);

wrapToolHandler(
  "set_counter_axis_spacing",
  "Set gap between wrapped rows/cols (counterAxisSpacing). Only meaningful when layoutWrap='WRAP'. Frame must have layoutMode != 'NONE'.",
  { nodeId: z.string(), spacing: z.number() },
  (r: any) => `Set counterAxisSpacing on "${r.name}" to ${r.counterAxisSpacing}`,
);

// ---- Corner / Geometry (BL-022) -----------------------------------
//
// `set_corner_radius` (above) sets a uniform radius. These tools fill the
// granular gap: per-corner radii, squircle smoothing, rotation, axis flip,
// flatten, outline-stroke, and boolean ops (union/subtract/intersect/exclude).

wrapToolHandler(
  "set_individual_corner_radii",
  "Set per-corner radius on a node (RECTANGLE / FRAME / COMPONENT / INSTANCE). " +
  "Provide one or more of topLeft / topRight / bottomLeft / bottomRight; omitted corners are left unchanged. " +
  "For uniform radius, use set_corner_radius.",
  {
    nodeId: z.string(),
    topLeft: z.number().min(0).optional(),
    topRight: z.number().min(0).optional(),
    bottomLeft: z.number().min(0).optional(),
    bottomRight: z.number().min(0).optional(),
  },
  (r: any) =>
    `Set corner radii on "${r.name}": TL=${r.topLeftRadius} TR=${r.topRightRadius} BL=${r.bottomLeftRadius} BR=${r.bottomRightRadius}`,
);

wrapToolHandler(
  "set_corner_smoothing",
  "Set corner smoothing (squircle) on a node. smoothing is 0..1 (0 = circular arc, 1 = full iOS-style squircle).",
  {
    nodeId: z.string(),
    smoothing: z.number().min(0).max(1).describe("0..1"),
  },
  (r: any) => `Set cornerSmoothing on "${r.name}" to ${r.cornerSmoothing}`,
);

wrapToolHandler(
  "set_rotation",
  "Set node rotation in degrees. Counter-clockwise positive. Anchor is the node's pivot.",
  {
    nodeId: z.string(),
    degrees: z.number().describe("Rotation in degrees"),
  },
  (r: any) => `Set rotation of "${r.name}" to ${r.rotation}°`,
);

wrapToolHandler(
  "set_flip",
  "Flip a node horizontally and/or vertically by mutating its relativeTransform. " +
  "The flipped node stays anchored at its original top-left bounding box. " +
  "Round-trip safe — calling twice with the same axes restores the original transform.",
  {
    nodeId: z.string(),
    horizontal: z.boolean().optional().describe("Mirror across the vertical axis"),
    vertical: z.boolean().optional().describe("Mirror across the horizontal axis"),
  },
  (r: any) =>
    `Flipped "${r.name}" (horizontal=${r.horizontal}, vertical=${r.vertical})`,
);

wrapToolHandler(
  "flatten",
  "Flatten one or more nodes into a single VectorNode (figma.flatten). " +
  "Useful for collapsing complex shape stacks into a single editable path. parentId optional — defaults to first node's parent.",
  {
    nodeIds: z.array(z.string()).min(1),
    parentId: z.string().optional(),
  },
  (r: any) => `Flattened ${r.notFoundIds.length === 0 ? "all" : ""} nodes into ${r.type} "${r.id}"`,
);

wrapToolHandler(
  "outline_stroke",
  "Convert a node's stroke into a filled VectorNode path (node.outlineStroke). " +
  "Returns id=null with a message if the node has no stroke.",
  {
    nodeId: z.string(),
  },
  (r: any) =>
    r.id == null
      ? `outline_stroke: ${r.message} (source: "${r.sourceName}")`
      : `Outlined stroke of "${r.sourceName}" → ${r.type} "${r.id}"`,
);

wrapToolHandler(
  "boolean_operation",
  "Combine two or more nodes via a vector boolean op. " +
  "operation: union | subtract | intersect | exclude. parentId optional (defaults to first node's parent).",
  {
    nodeIds: z.array(z.string()).min(2),
    operation: z.enum(["union", "subtract", "intersect", "exclude"]),
    parentId: z.string().optional(),
  },
  (r: any) => `Boolean ${r.operation} → ${r.type} "${r.id}"`,
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
    paints: z.array(paintSchema).describe("Paint array — SOLID/GRADIENT_*/IMAGE union, multiple stack."),
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
    layoutGrids: z.array(layoutGridSchema).describe("Layout grid array — COLUMNS/ROWS/GRID union."),
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

// Get Component Properties Tool (BL-071)
server.tool(
  "get_component_properties",
  "Read the current component property values of an instance (instance.componentProperties): each property's type, value, and any bound variable. The read counterpart to set_component_property.",
  {
    instanceId: z.string().describe("ID of the component INSTANCE to read."),
  },
  async ({ instanceId }: any) => {
    try {
      const result = await sendCommandToFigma("get_component_properties", { instanceId });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error reading component properties: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Get Component Property Definitions Tool (BL-071)
server.tool(
  "get_component_property_definitions",
  "Read the component property definitions of a component set or non-variant component: each property's type, default value, and (for VARIANT) the available options / (for INSTANCE_SWAP) preferredValues. Pass a variant component's id and it resolves to its parent set automatically.",
  {
    componentSetId: z.string().describe("ID of the COMPONENT_SET or COMPONENT to read definitions from."),
  },
  async ({ componentSetId }: any) => {
    try {
      const result = await sendCommandToFigma("get_component_property_definitions", { componentSetId });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error reading component property definitions: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Get Team Libraries Tool (BL-073)
server.tool(
  "get_team_libraries",
  "List available library variable collections from enabled team libraries (key, name, libraryName). Pass a libraryCollectionKey to instead list the variables in that collection (key, name, resolvedType) — use those keys with import_library_variable. Note: Figma's API does not expose a list of library components; import those by key via import_library_component.",
  {
    libraryCollectionKey: z
      .string()
      .optional()
      .describe("A library variable collection key. Omit to list collections; provide it to list that collection's variables."),
  },
  async ({ libraryCollectionKey }: any) => {
    try {
      const result = await sendCommandToFigma("get_team_libraries", { libraryCollectionKey });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting team libraries: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Import Library Component Tool (BL-073)
server.tool(
  "import_library_component",
  "Import a published library component by key and, by default, create and place an instance of it. Set createInstance=false to import the main component only. For a component set, import a specific variant's key.",
  {
    componentKey: z.string().describe("The published component's key."),
    createInstance: z
      .boolean()
      .optional()
      .describe("Create and place an instance after importing. Default true."),
    x: z.number().optional().describe("Instance X position (default 0). Only used when creating an instance."),
    y: z.number().optional().describe("Instance Y position (default 0). Only used when creating an instance."),
    parentId: z.string().optional().describe("Parent node to append the instance to. Defaults to the current page."),
  },
  async ({ componentKey, createInstance, x, y, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("import_library_component", {
        componentKey, createInstance, x, y, parentId,
      });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error importing library component: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Import Library Variable Tool (BL-073)
server.tool(
  "import_library_variable",
  "Import a published library variable by key into the local document (via figma.variables.importVariableByKeyAsync). Get keys from get_team_libraries(libraryCollectionKey). Returns the imported variable's summary.",
  {
    variableKey: z.string().describe("The published variable's key."),
  },
  async ({ variableKey }: any) => {
    try {
      const result = await sendCommandToFigma("import_library_variable", { variableKey });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error importing library variable: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Set Mask Tool (BL-074)
server.tool(
  "set_mask",
  "Toggle a node's mask flag. When isMask is true, the node masks its later siblings within the same parent.",
  {
    nodeId: z.string().describe("ID of the node to set as (or unset from) a mask."),
    isMask: z.boolean().describe("true to make the node a mask, false to clear."),
  },
  async ({ nodeId, isMask }: any) => {
    try {
      const result = await sendCommandToFigma("set_mask", { nodeId, isMask });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error setting mask: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Set Layout Positioning Tool (BL-074)
server.tool(
  "set_layout_positioning",
  "Set a node's layoutPositioning. ABSOLUTE lets an auto-layout child be positioned freely (ignored by the layout flow); AUTO returns it to the flow. Only meaningful for children of an auto-layout frame.",
  {
    nodeId: z.string().describe("ID of the node (an auto-layout child) to adjust."),
    mode: z.enum(["AUTO", "ABSOLUTE"]).describe("AUTO = follow layout flow; ABSOLUTE = position freely."),
  },
  async ({ nodeId, mode }: any) => {
    try {
      const result = await sendCommandToFigma("set_layout_positioning", { nodeId, mode });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error setting layout positioning: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Create Slice Tool (BL-074)
server.tool(
  "create_slice",
  "Create a slice (an export region) at the given position and size. Slices define export bounds independent of the nodes beneath them.",
  {
    x: z.number().optional().describe("X position (default 0)."),
    y: z.number().optional().describe("Y position (default 0)."),
    width: z.number().positive().optional().describe("Width (default 100, must be positive)."),
    height: z.number().positive().optional().describe("Height (default 100, must be positive)."),
    name: z.string().optional().describe("Slice name."),
    parentId: z.string().optional().describe("Parent to append the slice to. Defaults to the current page."),
  },
  async ({ x, y, width, height, name, parentId }: any) => {
    try {
      const result = await sendCommandToFigma("create_slice", { x, y, width, height, name, parentId });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error creating slice: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Figma Notify Tool (BL-074)
server.tool(
  "figma_notify",
  "Show a transient toast notification in the Figma UI (figma.notify). Useful for surfacing progress or status to the user at the canvas.",
  {
    message: z.string().describe("The message to display."),
    options: z
      .object({
        timeout: z.number().optional().describe("Auto-dismiss after this many milliseconds."),
        error: z.boolean().optional().describe("Style as an error toast."),
      })
      .optional()
      .describe("Notification options."),
  },
  async ({ message, options }: any) => {
    try {
      const result = await sendCommandToFigma("figma_notify", { message, options });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error showing notification: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
);

// Measure Distance Tool (BL-074)
server.tool(
  "measure_distance",
  "Measure the spatial relationship between two nodes' absolute bounding boxes: center-to-center delta and distance, plus the edge-to-edge gap on each axis (0 when the boxes overlap on that axis). Equivalent to Figma's Measure tool.",
  {
    nodeIdA: z.string().describe("First node id."),
    nodeIdB: z.string().describe("Second node id."),
  },
  async ({ nodeIdA, nodeIdB }: any) => {
    try {
      const result = await sendCommandToFigma("measure_distance", { nodeIdA, nodeIdB });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error measuring distance: ${error instanceof Error ? error.message : String(error)}` }],
      };
    }
  }
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

// design_strategy moved to ./prompts (BL-028). Register here so it lands
// in the same MCP server.
registerPrompts(server);


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

// Find Nodes By Criteria Tool (BL-069)
server.tool(
  "find_nodes_by_criteria",
  "Find nodes anywhere in a subtree by type and/or name. Unlike scan_nodes_by_types, this also filters by name (case-insensitive substring, or a regex). Searches descendants of rootId, or the current page when rootId is omitted. At least one of `types` or `namePattern` must be given.",
  {
    rootId: z
      .string()
      .optional()
      .describe("ID of the node to search within. Defaults to the current page."),
    types: z
      .array(z.string())
      .optional()
      .describe("Node types to match, e.g. ['COMPONENT', 'FRAME', 'TEXT']. Omit to match any type."),
    namePattern: z
      .string()
      .optional()
      .describe("Name to match. Case-insensitive substring by default, or a regular expression when `regex` is true."),
    regex: z
      .boolean()
      .optional()
      .describe("Treat namePattern as a regular expression. Default false."),
    includeHidden: z
      .boolean()
      .optional()
      .describe("Include hidden nodes and descendants of hidden nodes. Default false."),
  },
  async ({ rootId, types, namePattern, regex, includeHidden }: any) => {
    try {
      const result = await sendCommandToFigma("find_nodes_by_criteria", {
        rootId,
        types,
        namePattern,
        regex,
        includeHidden,
      });
      const typedResult = result as {
        count: number;
        matchingNodes: unknown[];
      };
      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${typedResult.count} matching node(s).`,
          },
          {
            type: "text" as const,
            text: JSON.stringify(typedResult.matchingNodes, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error finding nodes: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Find Node By Name Tool (BL-069)
server.tool(
  "find_node_by_name",
  "Find the first node whose name matches, anywhere in a subtree. Returns a single node summary or a not-found result. Searches descendants of rootId, or the current page when rootId is omitted.",
  {
    name: z.string().describe("Name to match."),
    rootId: z
      .string()
      .optional()
      .describe("ID of the node to search within. Defaults to the current page."),
    exact: z
      .boolean()
      .optional()
      .describe("Require an exact, case-sensitive name match. Default false = case-insensitive substring."),
  },
  async ({ name, rootId, exact }: any) => {
    try {
      const result = await sendCommandToFigma("find_node_by_name", {
        name,
        rootId,
        exact,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error finding node: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// List Available Fonts Tool (BL-072)
server.tool(
  "list_available_fonts",
  "List fonts available in the current Figma environment, grouped by family with their styles. The full catalog is large (1000+ families), so pass a searchPattern to narrow it; results are capped (default 50 families) and a `truncated` flag is set when more match. Useful before text work to confirm a font exists.",
  {
    searchPattern: z
      .string()
      .optional()
      .describe("Case-insensitive substring to filter font families, e.g. 'Inter'. Strongly recommended — the unfiltered catalog has 1000+ families."),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Max number of families to return (default 50). Narrow with searchPattern instead of raising this for large results."),
  },
  async ({ searchPattern, limit }: any) => {
    try {
      const result = await sendCommandToFigma("list_available_fonts", { searchPattern, limit });
      const typedResult = result as {
        count: number;
        totalFamilies: number;
        totalFonts: number;
        truncated: boolean;
        fonts: unknown[];
      };
      const famWord = typedResult.totalFamilies === 1 ? "family" : "families";
      const styleWord = typedResult.totalFonts === 1 ? "style" : "styles";
      const summary = typedResult.truncated
        ? `Found ${typedResult.totalFamilies} font ${famWord} (${typedResult.totalFonts} ${styleWord}); showing first ${typedResult.count}. Narrow with searchPattern or raise limit.`
        : `Found ${typedResult.totalFamilies} font ${famWord} (${typedResult.totalFonts} ${styleWord}).`;
      return {
        content: [
          {
            type: "text" as const,
            text: summary,
          },
          {
            type: "text" as const,
            text: JSON.stringify(typedResult.fonts),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error listing fonts: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Load Font Tool (BL-072)
server.tool(
  "load_font",
  "Explicitly load a font (family + style) so it is ready for text operations. Text tools load fonts automatically, but prefetching is faster for batch work. Errors if the font is not available.",
  {
    family: z.string().describe("Font family, e.g. 'Inter'."),
    style: z.string().describe("Font style, e.g. 'Regular', 'Bold', 'Medium'."),
  },
  async ({ family, style }: any) => {
    try {
      const result = await sendCommandToFigma("load_font", { family, style });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error loading font: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Align Nodes Tool (BL-070)
server.tool(
  "align_nodes",
  "Align multiple nodes to a shared edge or center of their combined bounding box, like Figma's Align buttons. Works across different (axis-aligned) parents on the current page. Nodes are skipped (and reported in `skipped`) if they are managed by a parent auto-layout, not on the current page, or under a rotated/scaled parent.",
  {
    nodeIds: z.array(z.string()).min(2).describe("IDs of nodes to align (at least 2)."),
    axis: z
      .enum(["left", "right", "top", "bottom", "center-h", "center-v"])
      .describe("left/right/center-h move along X; top/bottom/center-v move along Y."),
  },
  async ({ nodeIds, axis }: any) => {
    try {
      const result = await sendCommandToFigma("align_nodes", { nodeIds, axis });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error aligning nodes: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Distribute Nodes Tool (BL-070)
server.tool(
  "distribute_nodes",
  "Distribute 3+ nodes so the gaps between them are equal along the given direction, like Figma's Distribute spacing. The first and last nodes stay put. Nodes are skipped (and reported in `skipped`) if they are managed by a parent auto-layout, not on the current page, or under a rotated/scaled parent.",
  {
    nodeIds: z.array(z.string()).min(3).describe("IDs of nodes to distribute (at least 3)."),
    direction: z
      .enum(["horizontal", "vertical"])
      .describe("Axis along which to equalize spacing."),
  },
  async ({ nodeIds, direction }: any) => {
    try {
      const result = await sendCommandToFigma("distribute_nodes", { nodeIds, direction });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error distributing nodes: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Tidy Up Tool (BL-070)
server.tool(
  "tidy_up",
  "Pack nodes into a single row (horizontal) or column (vertical) with uniform spacing, ordered by their current position and aligned on the cross-axis. Nodes are skipped (and reported in `skipped`) if they are managed by a parent auto-layout, not on the current page, or under a rotated/scaled parent.",
  {
    nodeIds: z.array(z.string()).min(2).describe("IDs of nodes to tidy (at least 2)."),
    axis: z
      .enum(["horizontal", "vertical"])
      .describe("horizontal = row, vertical = column."),
    spacing: z
      .number()
      .optional()
      .describe("Gap between nodes in pixels. Default 0."),
  },
  async ({ nodeIds, axis, spacing }: any) => {
    try {
      const result = await sendCommandToFigma("tidy_up", { nodeIds, axis, spacing });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error tidying nodes: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Text Replacement Strategy Prompt

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

// Instance Slot Filling Strategy Prompt

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
  | "get_component_properties"
  | "get_component_property_definitions"
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
  | "set_layout_wrap"
  | "set_min_max_size"
  | "set_layout_align"
  | "set_layout_grow"
  | "set_counter_axis_spacing"
  | "get_pages"
  | "create_page"
  | "delete_page"
  | "rename_page"
  | "set_current_page"
  | "reorder_pages"
  | "create_ellipse"
  | "create_line"
  | "create_polygon"
  | "create_star"
  | "create_vector"
  | "create_section"
  | "create_component"
  | "combine_as_variants"
  | "set_text_range_style"
  | "set_hyperlink"
  | "set_text_auto_resize"
  | "set_text_truncation"
  | "set_list_options"
  | "set_gradient_fill"
  | "set_image_stroke"
  | "set_gradient_stroke"
  | "set_stroke_weight"
  | "set_stroke_align"
  | "set_stroke_cap"
  | "set_stroke_join"
  | "set_dash_pattern"
  | "set_individual_stroke_weights"
  | "reorder_node"
  | "group_nodes"
  | "ungroup_node"
  | "bring_to_front"
  | "send_to_back"
  | "get_reactions"
  | "set_default_connector"
  | "create_connections"
  | "set_reaction"
  | "clear_reactions"
  | "set_flow_starting_point"
  | "set_overflow_direction"
  | "set_prototype_device"
  | "set_focus"
  | "set_selections"
  | "set_dev_resource"
  | "get_dev_resources"
  | "set_dev_status"
  | "set_individual_corner_radii"
  | "set_corner_smoothing"
  | "set_rotation"
  | "set_flip"
  | "flatten"
  | "outline_stroke"
  | "boolean_operation"
  | "find_nodes_by_criteria"
  | "find_node_by_name"
  | "list_available_fonts"
  | "load_font"
  | "align_nodes"
  | "distribute_nodes"
  | "tidy_up"
  | "get_team_libraries"
  | "import_library_component"
  | "import_library_variable"
  | "set_mask"
  | "set_layout_positioning"
  | "create_slice"
  | "figma_notify"
  | "measure_distance";

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
  get_component_properties: {
    instanceId: string;
  };
  get_component_property_definitions: {
    componentSetId: string;
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
  set_dev_resource: {
    nodeId: string;
    name: string;
    url: string;
  };
  get_dev_resources: {
    nodeId: string;
  };
  set_dev_status: {
    nodeId: string;
    type: "READY_FOR_DEV" | "COMPLETED" | "NONE";
    description?: string;
  };
  set_reaction: {
    nodeId: string;
    trigger: { type: string; [key: string]: any };
    action: { type: string; [key: string]: any };
  };
  clear_reactions: { nodeId: string };
  set_flow_starting_point: {
    pageId: string;
    nodeId: string;
    name?: string;
  };
  set_overflow_direction: {
    nodeId: string;
    direction: "NONE" | "HORIZONTAL" | "VERTICAL" | "BOTH";
  };
  set_prototype_device: {
    presetIdentifier?: string;
    type?: "NONE" | "PRESET" | "CUSTOM" | "PRESENTATION";
    size?: { width: number; height: number };
    rotation?: "NONE" | "CCW_90";
  };
  set_individual_corner_radii: {
    nodeId: string;
    topLeft?: number;
    topRight?: number;
    bottomLeft?: number;
    bottomRight?: number;
  };
  set_corner_smoothing: { nodeId: string; smoothing: number };
  set_rotation: { nodeId: string; degrees: number };
  set_flip: { nodeId: string; horizontal?: boolean; vertical?: boolean };
  flatten: { nodeIds: string[]; parentId?: string };
  outline_stroke: { nodeId: string };
  boolean_operation: {
    nodeIds: string[];
    operation: "union" | "subtract" | "intersect" | "exclude";
    parentId?: string;
  };
  find_nodes_by_criteria: {
    rootId?: string;
    types?: Array<string>;
    namePattern?: string;
    regex?: boolean;
    includeHidden?: boolean;
  };
  find_node_by_name: {
    name: string;
    rootId?: string;
    exact?: boolean;
  };
  list_available_fonts: {
    searchPattern?: string;
    limit?: number;
  };
  load_font: {
    family: string;
    style: string;
  };
  align_nodes: {
    nodeIds: string[];
    axis: "left" | "right" | "top" | "bottom" | "center-h" | "center-v";
  };
  distribute_nodes: {
    nodeIds: string[];
    direction: "horizontal" | "vertical";
  };
  tidy_up: {
    nodeIds: string[];
    axis: "horizontal" | "vertical";
    spacing?: number;
  };
  get_team_libraries: {
    libraryCollectionKey?: string;
  };
  import_library_component: {
    componentKey: string;
    createInstance?: boolean;
    x?: number;
    y?: number;
    parentId?: string;
  };
  import_library_variable: {
    variableKey: string;
  };
  set_mask: {
    nodeId: string;
    isMask: boolean;
  };
  set_layout_positioning: {
    nodeId: string;
    mode: "AUTO" | "ABSOLUTE";
  };
  create_slice: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    name?: string;
    parentId?: string;
  };
  figma_notify: {
    message: string;
    options?: { timeout?: number; error?: boolean };
  };
  measure_distance: {
    nodeIdA: string;
    nodeIdB: string;
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



