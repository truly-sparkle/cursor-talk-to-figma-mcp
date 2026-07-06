// This is the main code file for the Cursor MCP Figma plugin
// It handles Figma API commands

// Plugin state
const state = {
  serverPort: 3055, // Default port
};

// ---- Logger (BL-038, BL-008) --------------------------------------
// New code should use Log.* instead of console.* directly. The wrapper
// gives us a single seam to gate output by level and to consistently
// route severity:
//   debug → quiet diagnostics, off in production
//   info  → normal lifecycle events ("scan started", "deletion done")
//   warn  → recoverable problems (skipped node, fallback used)
//   error → caught exceptions, command failures
//
// Level threshold: stored in figma.clientStorage at "LOG_LEVEL". Default
// "info" (debug muted). Change at runtime via figma.clientStorage in the
// plugin's console, or by editing settings.
//
// Existing 100+ direct console calls are not migrated wholesale; they
// keep firing through console.* and aren't gated. New code goes through
// Log.* so at least the noisy paths can be quieted incrementally.
var LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
var currentLogLevel = LOG_LEVELS.info;

(async function initLogLevel() {
  try {
    var stored = await figma.clientStorage.getAsync("LOG_LEVEL");
    if (stored && LOG_LEVELS[stored] != null) currentLogLevel = LOG_LEVELS[stored];
  } catch (e) {
    // ignore
  }
})();

const Log = {
  setLevel: function (lvl) {
    if (LOG_LEVELS[lvl] == null) return false;
    currentLogLevel = LOG_LEVELS[lvl];
    figma.clientStorage.setAsync("LOG_LEVEL", lvl).catch(function () {});
    return true;
  },
  debug: function () { if (currentLogLevel <= 10) console.log.apply(console, arguments); },
  info:  function () { if (currentLogLevel <= 20) console.log.apply(console, arguments); },
  warn:  function () { if (currentLogLevel <= 30) console.warn.apply(console, arguments); },
  error: function () { if (currentLogLevel <= 40) console.error.apply(console, arguments); },
};


// Helper function for progress updates
async function sendProgressUpdate(
  commandId,
  commandType,
  status,
  progress,
  totalItems,
  processedItems,
  message,
  payload = null
) {
  const update = {
    type: "command_progress",
    commandId,
    commandType,
    status,
    progress,
    totalItems,
    processedItems,
    message,
    timestamp: Date.now(),
  };

  // Add optional chunk information if present
  if (payload) {
    if (
      payload.currentChunk !== undefined &&
      payload.totalChunks !== undefined
    ) {
      update.currentChunk = payload.currentChunk;
      update.totalChunks = payload.totalChunks;
      update.chunkSize = payload.chunkSize;
    }
    update.payload = payload;
  }

  // Send to UI
  figma.ui.postMessage(update);
  Log.info(`Progress update: ${status} - ${progress}% - ${message}`);

  // Yield so the Figma plugin sandbox flushes postMessage to ui.html
  // before the next iteration begins. Uses the shared delay() helper
  // (BL-036) instead of an inline setTimeout-Promise to keep the
  // wait-pattern consistent across the plugin.
  await delay(0);

  return update;
}

// Show UI
figma.showUI(__html__, { width: 350, height: 600 });

// Best-effort cleanup of the legacy analyticsClientId from prior versions.
// Older builds wrote a persistent client_id into clientStorage to identify
// the user across sessions for GA4. Remove it on first run after the
// telemetry was stripped (BL-057).
(async () => {
  try {
    const legacy = await figma.clientStorage.getAsync("analyticsClientId");
    if (legacy) await figma.clientStorage.deleteAsync("analyticsClientId");
  } catch (e) {
    // Non-fatal — clientStorage is best-effort.
  }
})();

// ---- Command serialization (BL) -----------------------------------
// Pipelined MCP calls arrive concurrently; running them in parallel lets
// their mutations and progress updates interleave. Serialize with a
// promise-chain queue so only ONE command runs at a time. runOneCommand
// NEVER rejects (it catches internally) so a failing command can't break
// the chain for the next one.
var commandQueue = Promise.resolve();

async function runOneCommand(msg) {
  try {
    const result = await handleCommand(msg.command, msg.params);
    figma.ui.postMessage({
      type: "command-result",
      id: msg.id,
      result,
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "command-error",
      id: msg.id,
      error: error.message || "Error executing command",
    });
  } finally {
    // Drop any cancellation flag for this command's id to avoid unbounded
    // growth. The server stamps params.commandId with its own request id,
    // which is what cancel_command's cancelId targets.
    if (msg.params && msg.params.commandId) {
      clearCancelled(msg.params.commandId);
    }
  }
}

// Plugin commands from UI
figma.ui.onmessage = async (msg) => {
  switch (msg.type) {
    case "update-settings":
      updateSettings(msg);
      break;
    case "notify":
      figma.notify(msg.message);
      break;
    case "close-plugin":
      figma.closePlugin();
      break;
    case "execute-command":
      // cancel_command must bypass the serialization queue so a cancel can
      // take effect while a long command is still running in the queue.
      if (msg.command === "cancel_command") {
        try {
          const cancelResult = await handleCommand(msg.command, msg.params);
          figma.ui.postMessage({
            type: "command-result",
            id: msg.id,
            result: cancelResult,
          });
        } catch (error) {
          figma.ui.postMessage({
            type: "command-error",
            id: msg.id,
            error: error.message || "Error executing command",
          });
        }
        break;
      }
      // Execute commands received from UI (which gets them from WebSocket).
      // Chained onto commandQueue so commands run one at a time.
      commandQueue = commandQueue.then(function () {
        return runOneCommand(msg);
      });
      break;
  }
};

// Listen for plugin commands from menu
figma.on("run", ({ command }) => {
  figma.ui.postMessage({ type: "auto-connect" });
});

// Update plugin settings
function updateSettings(settings) {
  if (settings.serverPort) {
    state.serverPort = settings.serverPort;
  }

  figma.clientStorage.setAsync("settings", {
    serverPort: state.serverPort,
  });
}

// Handle commands from UI
async function handleCommand(command, params) {
  switch (command) {
    case "get_document_info":
      return await getDocumentInfo();
    case "get_selection":
      return await getSelection();
    case "get_node_info":
      if (!params || !params.nodeId) {
        throw new Error("Missing nodeId parameter");
      }
      return await getNodeInfo(params.nodeId);
    case "get_nodes_info":
      if (!params || !params.nodeIds || !Array.isArray(params.nodeIds)) {
        throw new Error("Missing or invalid nodeIds parameter");
      }
      return await getNodesInfo(params.nodeIds);
    case "read_my_design":
      return await readMyDesign();
    case "create_rectangle":
      return await createRectangle(params);
    case "create_frame":
      return await createFrame(params);
    case "create_text":
      return await createText(params);
    case "set_fill_color":
      return await setFillColor(params);
    case "set_image_fill":
      return await setImageFill(params);
    case "reparent_node":
      return await reparentNode(params);
    case "set_effects":
      return await setEffects(params);
    case "set_text_style":
      return await setTextStyle(params);
    case "get_variable_collections":
      return await getVariableCollections(params);
    case "get_variables":
      return await getVariables(params);
    case "create_variable_collection":
      return await createVariableCollection(params);
    case "create_variable":
      return await createVariable(params);
    case "set_variable_value":
      return await setVariableValue(params);
    case "add_variable_mode":
      return await addVariableMode(params);
    case "rename_variable_mode":
      return await renameVariableMode(params);
    case "remove_variable_mode":
      return await removeVariableMode(params);
    case "bind_node_variable":
      return await bindNodeVariable(params);
    case "unbind_node_variable":
      return await unbindNodeVariable(params);
    case "set_variable_alias":
      return await setVariableAlias(params);
    case "create_paint_style":
      return await createPaintStyle(params);
    case "create_text_style":
      return await createTextStyle(params);
    case "create_effect_style":
      return await createEffectStyle(params);
    case "create_grid_style":
      return await createGridStyle(params);
    case "apply_style":
      return await applyStyle(params);
    case "rename_style":
      return await renameStyle(params);
    case "delete_style":
      return await deleteStyle(params);
    case "set_constraints":
      return await setConstraints(params);
    case "add_fill":
      return await addFill(params);
    case "remove_fill_at":
      return await removeFillAt(params);
    case "set_image_filters":
      return await setImageFilters(params);
    case "get_image_bytes_by_hash":
      return await getImageBytesByHash(params);
    case "get_viewport_bounds":
      return await getViewportBounds(params);
    case "set_viewport_zoom":
      return await setViewportZoom(params);
    case "set_viewport_center":
      return await setViewportCenter(params);
    case "scroll_and_zoom_into_view":
      return await scrollAndZoomIntoView(params);
    case "set_dev_resource":
      return await setDevResource(params);
    case "get_dev_resources":
      return await getDevResources(params);
    case "set_dev_status":
      return await setDevStatus(params);
    case "set_reaction":
      return await setReaction(params);
    case "clear_reactions":
      return await clearReactions(params);
    case "set_flow_starting_point":
      return await setFlowStartingPoint(params);
    case "set_overflow_direction":
      return await setOverflowDirection(params);
    case "set_prototype_device":
      return await setPrototypeDevice(params);
    case "set_individual_corner_radii":
      return await setIndividualCornerRadii(params);
    case "set_corner_smoothing":
      return await setCornerSmoothing(params);
    case "set_rotation":
      return await setRotation(params);
    case "set_flip":
      return await setFlip(params);
    case "flatten":
      return await flattenNodes(params);
    case "outline_stroke":
      return await outlineStroke(params);
    case "boolean_operation":
      return await booleanOperation(params);
    case "set_plugin_data":
      return await setPluginData(params);
    case "get_plugin_data":
      return await getPluginData(params);
    case "set_shared_plugin_data":
      return await setSharedPluginData(params);
    case "get_shared_plugin_data":
      return await getSharedPluginData(params);
    case "create_sticky":
      return await createSticky(params);
    case "create_shape_with_text":
      return await createShapeWithText(params);
    case "create_table":
      return await createTable(params);
    case "create_component_from_node":
      return await createComponentFromNode(params);
    case "detach_instance":
      return await detachInstance(params);
    case "swap_instance":
      return await swapInstance(params);
    case "create_component_set":
      return await createComponentSet(params);
    case "add_component_property":
      return await addComponentProperty(params);
    case "set_component_property":
      return await setComponentProperty(params);
    case "get_component_properties":
      return await getComponentProperties(params);
    case "get_component_property_definitions":
      return await getComponentPropertyDefinitions(params);
    case "rename_node":
      return await renameNode(params);
    case "set_opacity":
      return await setOpacity(params);
    case "set_visible":
      return await setVisible(params);
    case "set_locked":
      return await setLocked(params);
    case "set_blend_mode":
      return await setBlendMode(params);
    case "set_stroke_color":
      return await setStrokeColor(params);
    case "move_node":
      return await moveNode(params);
    case "resize_node":
      return await resizeNode(params);
    case "delete_node":
      return await deleteNode(params);
    case "delete_multiple_nodes":
      return await deleteMultipleNodes(params);
    case "get_styles":
      return await getStyles();
    case "get_local_components":
      return await getLocalComponents(params);
    // case "get_team_components":
    //   return await getTeamComponents();
    case "create_component_instance":
      return await createComponentInstance(params);
    case "export_node_as_image":
      return await exportNodeAsImage(params);
    case "set_corner_radius":
      return await setCornerRadius(params);
    case "set_text_content":
      return await setTextContent(params);
    case "clone_node":
      return await cloneNode(params);
    case "scan_text_nodes":
      return await scanTextNodes(params);
    case "set_multiple_text_contents":
      return await setMultipleTextContents(params);
    case "get_annotations":
      return await getAnnotations(params);
    case "set_annotation":
      return await setAnnotation(params);
    case "scan_nodes_by_types":
      return await scanNodesByTypes(params);
    case "set_multiple_annotations":
      return await setMultipleAnnotations(params);
    case "get_instance_overrides":
      // Check if instanceNode parameter is provided
      if (params && params.instanceNodeId) {
        // Get the instance node by ID
        const instanceNode = await figma.getNodeByIdAsync(params.instanceNodeId);
        if (!instanceNode) {
          throw new Error(`Instance node not found with ID: ${params.instanceNodeId}`);
        }
        return await getInstanceOverrides(instanceNode);
      }
      // Call without instance node if not provided
      return await getInstanceOverrides();

    case "set_instance_overrides":
      // Check if instanceNodeIds parameter is provided
      if (params && params.targetNodeIds) {
        // Validate that targetNodeIds is an array
        if (!Array.isArray(params.targetNodeIds)) {
          throw new Error("targetNodeIds must be an array");
        }

        // Get the instance nodes by IDs
        const targetNodes = await getValidTargetInstances(params.targetNodeIds);
        if (!targetNodes.success) {
          figma.notify(targetNodes.message);
          return { success: false, message: targetNodes.message };
        }

        if (params.sourceInstanceId) {

          // get source instance data
          let sourceInstanceData = null;
          sourceInstanceData = await getSourceInstanceData(params.sourceInstanceId);

          if (!sourceInstanceData.success) {
            figma.notify(sourceInstanceData.message);
            return { success: false, message: sourceInstanceData.message };
          }
          return await setInstanceOverrides(targetNodes.targetInstances, sourceInstanceData);
        } else {
          throw new Error("Missing sourceInstanceId parameter");
        }
      }
    case "set_layout_mode":
      return await setLayoutMode(params);
    case "set_padding":
      return await setPadding(params);
    case "set_axis_align":
      return await setAxisAlign(params);
    case "set_layout_sizing":
      return await setLayoutSizing(params);
    case "set_item_spacing":
      return await setItemSpacing(params);
    case "set_layout_wrap":
      return await setLayoutWrap(params);
    case "set_min_max_size":
      return await setMinMaxSize(params);
    case "set_layout_align":
      return await setLayoutAlign(params);
    case "set_layout_grow":
      return await setLayoutGrow(params);
    case "set_counter_axis_spacing":
      return await setCounterAxisSpacing(params);
    case "get_pages":
      return await getPages(params);
    case "create_page":
      return await createPage(params);
    case "delete_page":
      return await deletePage(params);
    case "rename_page":
      return await renamePage(params);
    case "set_current_page":
      return await setCurrentPage(params);
    case "reorder_pages":
      return await reorderPages(params);
    case "create_ellipse":
      return await createEllipse(params);
    case "create_line":
      return await createLine(params);
    case "create_polygon":
      return await createPolygon(params);
    case "create_star":
      return await createStar(params);
    case "create_vector":
      return await createVector(params);
    case "cancel_command":
      markCancelled(params && params.cancelId);
      return { cancelled: true };
    case "batch_commands":
      return await executeBatch(params);
    case "create_section":
      return await createSection(params);
    case "create_component":
      return await createEmptyComponent(params);
    case "combine_as_variants":
      return await combineAsVariantsTool(params);
    case "set_text_range_style":
      return await setTextRangeStyle(params);
    case "set_hyperlink":
      return await setHyperlink(params);
    case "set_text_auto_resize":
      return await setTextAutoResize(params);
    case "set_text_truncation":
      return await setTextTruncation(params);
    case "set_list_options":
      return await setListOptions(params);
    case "set_gradient_fill":
      return await setGradientFill(params);
    case "set_image_stroke":
      return await setImageStroke(params);
    case "set_gradient_stroke":
      return await setGradientStroke(params);
    case "set_stroke_weight":
      return await setStrokeWeight(params);
    case "set_stroke_align":
      return await setStrokeAlign(params);
    case "set_stroke_cap":
      return await setStrokeCap(params);
    case "set_stroke_join":
      return await setStrokeJoin(params);
    case "set_dash_pattern":
      return await setDashPattern(params);
    case "set_individual_stroke_weights":
      return await setIndividualStrokeWeights(params);
    case "reorder_node":
      return await reorderNode(params);
    case "group_nodes":
      return await groupNodes(params);
    case "ungroup_node":
      return await ungroupNode(params);
    case "bring_to_front":
      return await bringToFront(params);
    case "send_to_back":
      return await sendToBack(params);
    case "get_reactions":
      if (!params || !params.nodeIds || !Array.isArray(params.nodeIds)) {
        throw new Error("Missing or invalid nodeIds parameter");
      }
      return await getReactions(params.nodeIds, params.commandId);
    case "set_default_connector":
      return await setDefaultConnector(params);
    case "create_connections":
      return await createConnections(params);
    case "set_focus":
      return await setFocus(params);
    case "set_selections":
      return await setSelections(params);
    case "find_nodes_by_criteria":
      return await findNodesByCriteria(params);
    case "find_node_by_name":
      return await findNodeByName(params);
    case "list_available_fonts":
      return await listAvailableFonts(params);
    case "load_font":
      return await loadFont(params);
    case "align_nodes":
      return await alignNodes(params);
    case "distribute_nodes":
      return await distributeNodes(params);
    case "tidy_up":
      return await tidyUp(params);
    case "get_team_libraries":
      return await getTeamLibraries(params);
    case "import_library_component":
      return await importLibraryComponent(params);
    case "import_library_variable":
      return await importLibraryVariable(params);
    case "set_mask":
      return await setMask(params);
    case "set_layout_positioning":
      return await setLayoutPositioning(params);
    case "create_slice":
      return await createSlice(params);
    case "figma_notify":
      return await figmaNotify(params);
    case "measure_distance":
      return await measureDistance(params);
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

// Command implementations

async function getDocumentInfo() {
  await figma.currentPage.loadAsync();
  const page = figma.currentPage;
  return {
    name: page.name,
    id: page.id,
    type: page.type,
    children: page.children.map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
    })),
    currentPage: {
      id: page.id,
      name: page.name,
      childCount: page.children.length,
    },
    pages: [
      {
        id: page.id,
        name: page.name,
        childCount: page.children.length,
      },
    ],
  };
}

async function getSelection() {
  return {
    selectionCount: figma.currentPage.selection.length,
    selection: figma.currentPage.selection.map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
      visible: node.visible,
    })),
  };
}

// Clamp a Figma 0-1 channel into a valid 0-255 byte. Out-of-range / NaN
// values would otherwise produce broken hex (e.g. r=1.5 → 383 → "17f").
// Mirror of server.ts:channelToByte (BL-006). Plugin runtime — keep
// hand-written, no helpers from server side.
function channelToByte(v) {
  var n = typeof v === "number" && isFinite(v) ? v : 0;
  return Math.round(Math.max(0, Math.min(1, n)) * 255);
}

function rgbaToHex(color) {
  if (!color || typeof color !== "object") return "#000000";
  var r = channelToByte(color.r);
  var g = channelToByte(color.g);
  var b = channelToByte(color.b);
  var a = color.a == null ? 255 : channelToByte(color.a);

  if (a === 255) {
    return (
      "#" +
      [r, g, b]
        .map((x) => {
          return x.toString(16).padStart(2, "0");
        })
        .join("")
    );
  }

  return (
    "#" +
    [r, g, b, a]
      .map((x) => {
        return x.toString(16).padStart(2, "0");
      })
      .join("")
  );
}

// Normalize a Paint (fill or stroke) for client-facing JSON.
// JSON_REST_V1 export uses `imageRef` for image hashes; we expose it as
// `imageHash` to match the Plugin API and the input key of set_image_fill.
function processPaint(paint) {
  var processed = Object.assign({}, paint);
  delete processed.boundVariables;

  if (processed.imageRef) {
    processed.imageHash = processed.imageRef;
    delete processed.imageRef;
  }

  if (processed.gradientStops) {
    processed.gradientStops = processed.gradientStops.map((stop) => {
      var processedStop = Object.assign({}, stop);
      if (processedStop.color) {
        processedStop.color = rgbaToHex(processedStop.color);
      }
      delete processedStop.boundVariables;
      return processedStop;
    });
  }

  if (processed.color) {
    processed.color = rgbaToHex(processed.color);
  }

  return processed;
}

function filterFigmaNode(node) {
  if (node.type === "VECTOR") {
    // Return a minimal identity stub instead of null so vector nodes still
    // carry id/name/type. Full vectorPaths/geometry are intentionally
    // omitted to keep the payload small.
    return { id: node.id, name: node.name, type: node.type };
  }

  var filtered = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  if (node.fills && node.fills.length > 0) {
    filtered.fills = node.fills.map((fill) => {
      return processPaint(fill);
    });
  }

  if (node.strokes && node.strokes.length > 0) {
    filtered.strokes = node.strokes.map((stroke) => {
      return processPaint(stroke);
    });
  }

  if (node.cornerRadius !== undefined) {
    filtered.cornerRadius = node.cornerRadius;
  }

  if (node.absoluteBoundingBox) {
    filtered.absoluteBoundingBox = node.absoluteBoundingBox;
  }

  if (node.characters) {
    filtered.characters = node.characters;
  }

  if (node.style) {
    filtered.style = {
      fontFamily: node.style.fontFamily,
      fontStyle: node.style.fontStyle,
      fontWeight: node.style.fontWeight,
      fontSize: node.style.fontSize,
      textAlignHorizontal: node.style.textAlignHorizontal,
      letterSpacing: node.style.letterSpacing,
      lineHeightPx: node.style.lineHeightPx,
    };
  }

  if (node.children) {
    filtered.children = node.children
      .map((child) => {
        return filterFigmaNode(child);
      })
      .filter((child) => {
        return child !== null;
      });
  }

  return filtered;
}

async function getNodeInfo(nodeId) {
  const node = await figma.getNodeByIdAsync(nodeId);

  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  const response = await node.exportAsync({
    format: "JSON_REST_V1",
  });

  return filterFigmaNode(response.document);
}

async function getNodesInfo(nodeIds) {
  try {
    // Load all nodes in parallel
    const nodes = await Promise.all(
      nodeIds.map((id) => figma.getNodeByIdAsync(id))
    );

    // Filter out any null values (nodes that weren't found)
    const validNodes = nodes.filter((node) => node !== null);

    // Export all valid nodes in parallel
    const responses = await Promise.all(
      validNodes.map(async (node) => {
        const response = await node.exportAsync({
          format: "JSON_REST_V1",
        });
        return {
          nodeId: node.id,
          document: filterFigmaNode(response.document),
        };
      })
    );

    return responses;
  } catch (error) {
    throw new Error(`Error getting nodes info: ${error.message}`);
  }
}

async function getReactions(nodeIds, suppliedCommandId) {
  try {
    const commandId = suppliedCommandId || generateCommandId();
    sendProgressUpdate(
      commandId,
      "get_reactions",
      "started",
      0,
      nodeIds.length,
      0,
      `Starting deep search for reactions in ${nodeIds.length} nodes and their children`
    );

    // Function to find nodes with reactions from the node and all its children
    async function findNodesWithReactions(node, processedNodes = new Set(), depth = 0, results = []) {
      // Skip already processed nodes (prevent circular references)
      if (processedNodes.has(node.id)) {
        return results;
      }
      
      processedNodes.add(node.id);
      
      // Check if the current node has reactions
      let filteredReactions = [];
      if (node.reactions && node.reactions.length > 0) {
        // Filter out reactions with navigation === 'CHANGE_TO'
        filteredReactions = node.reactions.filter(r => {
          // Some reactions may have action or actions array
          if (r.action && r.action.navigation === 'CHANGE_TO') return false;
          if (Array.isArray(r.actions)) {
            // If any action in actions array is CHANGE_TO, exclude
            return !r.actions.some(a => a.navigation === 'CHANGE_TO');
          }
          return true;
        });
      }
      const hasFilteredReactions = filteredReactions.length > 0;
      
      // If the node has filtered reactions, add it to results and apply highlight effect
      if (hasFilteredReactions) {
        results.push({
          id: node.id,
          name: node.name,
          type: node.type,
          depth: depth,
          hasReactions: true,
          reactions: filteredReactions,
          path: getNodePath(node)
        });
        // Apply highlight effect (orange border)
        await highlightNodeWithAnimation(node);
      }
      
      // If node has children, recursively search them
      if (node.children) {
        for (const child of node.children) {
          await findNodesWithReactions(child, processedNodes, depth + 1, results);
        }
      }
      
      return results;
    }
    
    // Function to apply animated highlight effect to a node
    async function highlightNodeWithAnimation(node) {
      // Save original stroke properties
      const originalStrokeWeight = node.strokeWeight;
      const originalStrokes = node.strokes ? [...node.strokes] : [];
      
      try {
        // Apply orange border stroke
        node.strokeWeight = 4;
        node.strokes = [{
          type: 'SOLID',
          color: { r: 1, g: 0.5, b: 0 }, // Orange color
          opacity: 0.8
        }];
        
        // Set timeout for animation effect (restore to original after 1.5 seconds)
        setTimeout(() => {
          try {
            // Restore original stroke properties
            node.strokeWeight = originalStrokeWeight;
            node.strokes = originalStrokes;
          } catch (restoreError) {
            Log.error(`Error restoring node stroke: ${restoreError.message}`);
          }
        }, 1500);
      } catch (highlightError) {
        Log.error(`Error highlighting node: ${highlightError.message}`);
        // Continue even if highlighting fails
      }
    }
    
    // Get node hierarchy path as a string
    function getNodePath(node) {
      const path = [];
      let current = node;
      
      while (current && current.parent) {
        path.unshift(current.name);
        current = current.parent;
      }
      
      return path.join(' > ');
    }

    // Array to store all results
    let allResults = [];
    let processedCount = 0;
    const totalCount = nodeIds.length;
    
    // Iterate through each node and its children to search for reactions
    for (let i = 0; i < nodeIds.length; i++) {
      try {
        const nodeId = nodeIds[i];
        const node = await figma.getNodeByIdAsync(nodeId);
        
        if (!node) {
          processedCount++;
          sendProgressUpdate(
            commandId,
            "get_reactions",
            "in_progress",
            processedCount / totalCount,
            totalCount,
            processedCount,
            `Node not found: ${nodeId}`
          );
          continue;
        }
        
        // Search for reactions in the node and its children
        const processedNodes = new Set();
        const nodeResults = await findNodesWithReactions(node, processedNodes);
        
        // Add results
        allResults = allResults.concat(nodeResults);
        
        // Update progress
        processedCount++;
        sendProgressUpdate(
          commandId,
          "get_reactions",
          "in_progress",
          processedCount / totalCount,
          totalCount,
          processedCount,
          `Processed node ${processedCount}/${totalCount}, found ${nodeResults.length} nodes with reactions`
        );
      } catch (error) {
        processedCount++;
        sendProgressUpdate(
          commandId,
          "get_reactions",
          "in_progress",
          processedCount / totalCount,
          totalCount,
          processedCount,
          `Error processing node: ${error.message}`
        );
      }
    }

    // Completion update
    sendProgressUpdate(
      commandId,
      "get_reactions",
      "completed",
      1,
      totalCount,
      totalCount,
      `Completed deep search: found ${allResults.length} nodes with reactions.`
    );

    return {
      nodesCount: nodeIds.length,
      nodesWithReactions: allResults.length,
      nodes: allResults
    };
  } catch (error) {
    throw new Error(`Failed to get reactions: ${error.message}`);
  }
}

async function readMyDesign() {
  try {
    // Load all selected nodes in parallel
    const nodes = await Promise.all(
      figma.currentPage.selection.map((node) => figma.getNodeByIdAsync(node.id))
    );

    // Filter out any null values (nodes that weren't found)
    const validNodes = nodes.filter((node) => node !== null);

    // Export all valid nodes in parallel
    const responses = await Promise.all(
      validNodes.map(async (node) => {
        const response = await node.exportAsync({
          format: "JSON_REST_V1",
        });
        return {
          nodeId: node.id,
          document: filterFigmaNode(response.document),
        };
      })
    );

    return responses;
  } catch (error) {
    throw new Error(`Error getting nodes info: ${error.message}`);
  }
}

async function createRectangle(params) {
  const {
    x = 0,
    y = 0,
    width = 100,
    height = 100,
    name = "Rectangle",
    parentId,
    fillColor,
    strokeColor,
    strokeWeight,
    cornerRadius,
  } = params || {};

  const rect = figma.createRectangle();
  rect.x = x;
  rect.y = y;
  rect.resize(width, height);
  rect.name = name;

  // Set fill color if provided
  if (fillColor) {
    const paintStyle = {
      type: "SOLID",
      color: {
        r: parseFloat(fillColor.r) || 0,
        g: parseFloat(fillColor.g) || 0,
        b: parseFloat(fillColor.b) || 0,
      },
      opacity: (fillColor.a == null || isNaN(parseFloat(fillColor.a))) ? 1 : parseFloat(fillColor.a),
    };
    rect.fills = [paintStyle];
  }

  // Set stroke color if provided
  if (strokeColor) {
    const strokeStyle = {
      type: "SOLID",
      color: {
        r: parseFloat(strokeColor.r) || 0,
        g: parseFloat(strokeColor.g) || 0,
        b: parseFloat(strokeColor.b) || 0,
      },
      opacity: (strokeColor.a == null || isNaN(parseFloat(strokeColor.a))) ? 1 : parseFloat(strokeColor.a),
    };
    rect.strokes = [strokeStyle];
  }

  // Set stroke weight if provided
  if (strokeWeight !== undefined) {
    rect.strokeWeight = strokeWeight;
  }

  // Set corner radius if provided
  if (cornerRadius !== undefined) {
    rect.cornerRadius = cornerRadius;
  }

  // If parentId is provided, append to that node, otherwise append to current page
  if (parentId) {
    const parentNode = await figma.getNodeByIdAsync(parentId);
    if (!parentNode) {
      throw new Error(`Parent node not found with ID: ${parentId}`);
    }
    if (!("appendChild" in parentNode)) {
      throw new Error(`Parent node does not support children: ${parentId}`);
    }
    parentNode.appendChild(rect);
  } else {
    figma.currentPage.appendChild(rect);
  }

  return {
    id: rect.id,
    name: rect.name,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    parentId: rect.parent ? rect.parent.id : undefined,
  };
}

async function createFrame(params) {
  const {
    x = 0,
    y = 0,
    width = 100,
    height = 100,
    name = "Frame",
    parentId,
    fillColor,
    strokeColor,
    strokeWeight,
    layoutMode = "NONE",
    layoutWrap = "NO_WRAP",
    paddingTop = 10,
    paddingRight = 10,
    paddingBottom = 10,
    paddingLeft = 10,
    primaryAxisAlignItems = "MIN",
    counterAxisAlignItems = "MIN",
    layoutSizingHorizontal = "FIXED",
    layoutSizingVertical = "FIXED",
    itemSpacing = 0,
    cornerRadius,
    opacity,
  } = params || {};

  const frame = figma.createFrame();
  frame.x = x;
  frame.y = y;
  frame.resize(width, height);
  frame.name = name;

  // Set layout mode if provided
  if (layoutMode !== "NONE") {
    frame.layoutMode = layoutMode;
    frame.layoutWrap = layoutWrap;

    // Set padding values only when layoutMode is not NONE
    frame.paddingTop = paddingTop;
    frame.paddingRight = paddingRight;
    frame.paddingBottom = paddingBottom;
    frame.paddingLeft = paddingLeft;

    // Set axis alignment only when layoutMode is not NONE
    frame.primaryAxisAlignItems = primaryAxisAlignItems;
    frame.counterAxisAlignItems = counterAxisAlignItems;

    // Set item spacing only when layoutMode is not NONE
    frame.itemSpacing = itemSpacing;
  }

  // Set corner radius if provided
  if (cornerRadius !== undefined) {
    frame.cornerRadius = cornerRadius;
  }

  // Set opacity if provided
  if (opacity !== undefined) {
    frame.opacity = opacity;
  }

  // Set fill color if provided
  if (fillColor) {
    const paintStyle = {
      type: "SOLID",
      color: {
        r: parseFloat(fillColor.r) || 0,
        g: parseFloat(fillColor.g) || 0,
        b: parseFloat(fillColor.b) || 0,
      },
      opacity: (fillColor.a == null || isNaN(parseFloat(fillColor.a))) ? 1 : parseFloat(fillColor.a),
    };
    frame.fills = [paintStyle];
  }

  // Set stroke color and weight if provided
  if (strokeColor) {
    const strokeStyle = {
      type: "SOLID",
      color: {
        r: parseFloat(strokeColor.r) || 0,
        g: parseFloat(strokeColor.g) || 0,
        b: parseFloat(strokeColor.b) || 0,
      },
      opacity: (strokeColor.a == null || isNaN(parseFloat(strokeColor.a))) ? 1 : parseFloat(strokeColor.a),
    };
    frame.strokes = [strokeStyle];
  }

  // Set stroke weight if provided
  if (strokeWeight !== undefined) {
    frame.strokeWeight = strokeWeight;
  }

  // If parentId is provided, append to that node, otherwise append to current page
  let parentNode = null;
  if (parentId) {
    parentNode = await figma.getNodeByIdAsync(parentId);
    if (!parentNode) {
      throw new Error(`Parent node not found with ID: ${parentId}`);
    }
    if (!("appendChild" in parentNode)) {
      throw new Error(`Parent node does not support children: ${parentId}`);
    }
    parentNode.appendChild(frame);
  } else {
    figma.currentPage.appendChild(frame);
  }

  // Set layout sizing AFTER appendChild. The two modes have DIFFERENT
  // requirements in Figma and must be gated separately or the assignment throws:
  //   - "FILL" requires the PARENT to be auto-layout (and the node to be a child).
  //   - "HUG"  requires the FRAME ITSELF to be auto-layout (nothing to hug otherwise).
  //   - "FIXED" is valid in either context.
  // Gating the whole block on the parent (an earlier fix) both threw on HUG for a
  // non-auto parent and dropped HUG on a top-level auto-layout frame.
  const ownAuto = frame.layoutMode && frame.layoutMode !== "NONE";
  const parentAuto = parentNode && parentNode.layoutMode && parentNode.layoutMode !== "NONE";
  if (layoutSizingHorizontal === "FILL") {
    if (parentAuto) frame.layoutSizingHorizontal = "FILL";
  } else if (layoutSizingHorizontal === "HUG") {
    if (ownAuto) frame.layoutSizingHorizontal = "HUG";
  } else if (layoutSizingHorizontal === "FIXED") {
    if (ownAuto || parentAuto) frame.layoutSizingHorizontal = "FIXED";
  }
  if (layoutSizingVertical === "FILL") {
    if (parentAuto) frame.layoutSizingVertical = "FILL";
  } else if (layoutSizingVertical === "HUG") {
    if (ownAuto) frame.layoutSizingVertical = "HUG";
  } else if (layoutSizingVertical === "FIXED") {
    if (ownAuto || parentAuto) frame.layoutSizingVertical = "FIXED";
  }

  return {
    id: frame.id,
    name: frame.name,
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
    fills: frame.fills,
    strokes: frame.strokes,
    strokeWeight: frame.strokeWeight,
    layoutMode: frame.layoutMode,
    layoutWrap: frame.layoutWrap,
    parentId: frame.parent ? frame.parent.id : undefined,
  };
}

async function createText(params) {
  const {
    x = 0,
    y = 0,
    text = "Text",
    fontSize = 14,
    fontWeight = 400,
    fontColor = { r: 0, g: 0, b: 0, a: 1 }, // Default to black
    name = "",
    parentId,
    fontFamily,
    fontStyle,
    width,
    textAutoResize,
    textAlignHorizontal,
    letterSpacing,
    lineHeight,
  } = params || {};

  // Map common font weights to Figma font styles
  const getFontStyle = (weight) => {
    switch (weight) {
      case 100:
        return "Thin";
      case 200:
        return "Extra Light";
      case 300:
        return "Light";
      case 400:
        return "Regular";
      case 500:
        return "Medium";
      case 600:
        return "Semi Bold";
      case 700:
        return "Bold";
      case 800:
        return "Extra Bold";
      case 900:
        return "Black";
      default:
        return "Regular";
    }
  };

  const textNode = figma.createText();
  textNode.x = x;
  textNode.y = y;
  textNode.name = name || text;
  // Honor an explicit fontFamily/fontStyle if given, otherwise fall back to
  // Inter + the weight→style mapping. Load whichever font before applying.
  const resolvedFamily = fontFamily || "Inter";
  const resolvedStyle = fontStyle || getFontStyle(fontWeight);
  try {
    await figma.loadFontAsync({
      family: resolvedFamily,
      style: resolvedStyle,
    });
    textNode.fontName = { family: resolvedFamily, style: resolvedStyle };
    textNode.fontSize = parseInt(fontSize);
  } catch (error) {
    Log.error("Error setting font size", error);
  }
  setCharacters(textNode, text);

  // Inline text-style params (reuse the same idioms as setTextStyle).
  if (textAlignHorizontal) {
    textNode.textAlignHorizontal = textAlignHorizontal;
  }
  if (letterSpacing !== undefined) {
    textNode.letterSpacing = typeof letterSpacing === "number"
      ? { value: letterSpacing, unit: "PIXELS" }
      : letterSpacing;
  }
  if (lineHeight !== undefined) {
    if (lineHeight === "AUTO") textNode.lineHeight = { unit: "AUTO" };
    else if (typeof lineHeight === "number") {
      textNode.lineHeight = { value: lineHeight, unit: "PIXELS" };
    } else {
      textNode.lineHeight = lineHeight;
    }
  }
  // A fixed width implies wrapping: set HEIGHT auto-resize then resize the
  // node to the requested width so text wraps within it.
  if (typeof width === "number") {
    textNode.textAutoResize = textAutoResize || "HEIGHT";
    textNode.resize(width, textNode.height);
  } else if (textAutoResize) {
    textNode.textAutoResize = textAutoResize;
  }

  // Set text color
  const paintStyle = {
    type: "SOLID",
    color: {
      r: parseFloat(fontColor.r) || 0,
      g: parseFloat(fontColor.g) || 0,
      b: parseFloat(fontColor.b) || 0,
    },
    opacity: (fontColor.a == null || isNaN(parseFloat(fontColor.a))) ? 1 : parseFloat(fontColor.a),
  };
  textNode.fills = [paintStyle];

  // If parentId is provided, append to that node, otherwise append to current page
  if (parentId) {
    const parentNode = await figma.getNodeByIdAsync(parentId);
    if (!parentNode) {
      throw new Error(`Parent node not found with ID: ${parentId}`);
    }
    if (!("appendChild" in parentNode)) {
      throw new Error(`Parent node does not support children: ${parentId}`);
    }
    parentNode.appendChild(textNode);
  } else {
    figma.currentPage.appendChild(textNode);
  }

  return {
    id: textNode.id,
    name: textNode.name,
    x: textNode.x,
    y: textNode.y,
    width: textNode.width,
    height: textNode.height,
    characters: textNode.characters,
    fontSize: textNode.fontSize,
    fontWeight: fontWeight,
    fontColor: fontColor,
    fontName: textNode.fontName,
    fills: textNode.fills,
    parentId: textNode.parent ? textNode.parent.id : undefined,
  };
}

async function setFillColor(params) {
  Log.debug("setFillColor", params);
  const {
    nodeId,
    color: { r, g, b, a },
  } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  if (!("fills" in node)) {
    throw new Error(`Node does not support fills: ${nodeId}`);
  }

  // Create RGBA color
  const rgbColor = {
    r: parseFloat(r) || 0,
    g: parseFloat(g) || 0,
    b: parseFloat(b) || 0,
    a: parseFloat(a) || 1,
  };

  // Set fill
  const paintStyle = {
    type: "SOLID",
    color: {
      r: parseFloat(rgbColor.r),
      g: parseFloat(rgbColor.g),
      b: parseFloat(rgbColor.b),
    },
    opacity: parseFloat(rgbColor.a),
  };

  Log.info("paintStyle", paintStyle);

  node.fills = [paintStyle];

  return {
    id: node.id,
    name: node.name,
    fills: [paintStyle],
  };
}

const VALID_SCALE_MODES = new Set(["FILL", "FIT", "CROP", "TILE"]);

function decodeBase64ToBytes(b64) {
  const clean = b64.replace(/^data:[^;]+;base64,/, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function resolveImageHash({ imageHash, imageBytes }) {
  if (imageHash) {
    const existing = figma.getImageByHash(imageHash);
    if (!existing) {
      throw new Error(`No image found in this file for hash: ${imageHash}`);
    }
    return imageHash;
  }
  if (imageBytes) {
    const bytes = decodeBase64ToBytes(imageBytes);
    const created = figma.createImage(bytes);
    return created.hash;
  }
  throw new Error("Provide either imageHash or imageBytes");
}

async function setImageFill(params) {
  const {
    nodeId,
    imageHash,
    imageBytes,
    scaleMode = "FILL",
    opacity = 1,
    rotation = 0,
    replace = true,
  } = params || {};

  if (!nodeId) throw new Error("Missing nodeId parameter");
  if (!VALID_SCALE_MODES.has(scaleMode)) {
    throw new Error(`Invalid scaleMode: ${scaleMode} (allowed: FILL, FIT, CROP, TILE)`);
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found with ID: ${nodeId}`);
  if (!("fills" in node)) throw new Error(`Node does not support fills: ${nodeId}`);

  const hash = await resolveImageHash({ imageHash, imageBytes });

  const imagePaint = {
    type: "IMAGE",
    imageHash: hash,
    scaleMode,
    opacity: Math.min(1, Math.max(0, opacity)),
    // rotation is only meaningful for non-CROP modes; Figma ignores it for CROP
    rotation,
  };

  // node.fills is readonly (returns frozen array) — must assign a new array
  const existing = replace ? [] : (Array.isArray(node.fills) ? node.fills.slice() : []);
  node.fills = [...existing, imagePaint];

  return {
    id: node.id,
    name: node.name,
    imageHash: hash,
    scaleMode,
    fills: node.fills,
  };
}

async function reparentNode(params) {
  const { nodeId, newParentId, index, preservePosition = true } = params || {};

  if (!nodeId) throw new Error("Missing nodeId parameter");
  if (!newParentId) throw new Error("Missing newParentId parameter");

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found with ID: ${nodeId}`);
  if (!("parent" in node) || node.removed) {
    throw new Error(`Node cannot be reparented: ${nodeId}`);
  }

  const newParent = await figma.getNodeByIdAsync(newParentId);
  if (!newParent) throw new Error(`Parent not found with ID: ${newParentId}`);
  if (typeof newParent.appendChild !== "function") {
    throw new Error(`Target is not a container: ${newParentId} (${newParent.type})`);
  }

  // Guard against reparenting a node into its own descendant
  let walker = newParent;
  while (walker) {
    if (walker.id === node.id) {
      throw new Error("Cannot reparent a node into itself or its descendant");
    }
    walker = walker.parent;
  }

  // Capture absolute position before move; Figma's child coords are parent-relative
  const absBefore = preservePosition && "absoluteTransform" in node
    ? { x: node.absoluteTransform[0][2], y: node.absoluteTransform[1][2] }
    : null;

  if (typeof index === "number") {
    newParent.insertChild(index, node);
  } else {
    newParent.appendChild(node);
  }

  // Re-apply absolute position by converting through new parent's transform.
  // Skips when new parent is auto-layout (it owns positioning) or when caller opted out.
  const parentIsAutoLayout = "layoutMode" in newParent && newParent.layoutMode !== "NONE";
  if (absBefore && !parentIsAutoLayout && "absoluteTransform" in newParent && "x" in node) {
    const pt = newParent.absoluteTransform;
    node.x = absBefore.x - pt[0][2];
    node.y = absBefore.y - pt[1][2];
  }

  return {
    id: node.id,
    name: node.name,
    parentId: node.parent ? node.parent.id : null,
    index: node.parent && "children" in node.parent
      ? node.parent.children.indexOf(node)
      : -1,
  };
}

async function loadFontsForNode(node) {
  // Mixed fontName across runs requires loading every distinct font in the text node
  if (node.fontName === figma.mixed) {
    const len = node.characters.length;
    const seen = new Set();
    for (let i = 0; i < len; i++) {
      const f = node.getRangeFontName(i, i + 1);
      const key = `${f.family}__${f.style}`;
      if (!seen.has(key)) {
        seen.add(key);
        await figma.loadFontAsync(f);
      }
    }
  } else {
    await figma.loadFontAsync(node.fontName);
  }
}

async function setTextStyle(params) {
  const {
    nodeId,
    fontFamily,
    fontStyle,
    fontSize,
    letterSpacing,
    lineHeight,
    textCase,
    textDecoration,
    textAlignHorizontal,
    textAlignVertical,
    paragraphSpacing,
    paragraphIndent,
  } = params || {};

  if (!nodeId) throw new Error("Missing nodeId parameter");

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found with ID: ${nodeId}`);
  if (node.type !== "TEXT") {
    throw new Error(`Node is not a text node: ${nodeId} (${node.type})`);
  }

  await loadFontsForNode(node);

  // If caller specifies a new font, load that one too before applying
  if (fontFamily || fontStyle) {
    const baseFont = node.fontName === figma.mixed
      ? { family: "Inter", style: "Regular" }
      : node.fontName;
    const next = {
      family: fontFamily || baseFont.family,
      style: fontStyle || baseFont.style,
    };
    await figma.loadFontAsync(next);
    node.fontName = next;
  }

  if (typeof fontSize === "number") node.fontSize = fontSize;
  if (letterSpacing !== undefined) {
    node.letterSpacing = typeof letterSpacing === "number"
      ? { value: letterSpacing, unit: "PIXELS" }
      : letterSpacing;
  }
  if (lineHeight !== undefined) {
    if (lineHeight === "AUTO") node.lineHeight = { unit: "AUTO" };
    else if (typeof lineHeight === "number") {
      node.lineHeight = { value: lineHeight, unit: "PIXELS" };
    } else {
      node.lineHeight = lineHeight;
    }
  }
  if (textCase) node.textCase = textCase;
  if (textDecoration) node.textDecoration = textDecoration;
  if (textAlignHorizontal) node.textAlignHorizontal = textAlignHorizontal;
  if (textAlignVertical) node.textAlignVertical = textAlignVertical;
  if (typeof paragraphSpacing === "number") node.paragraphSpacing = paragraphSpacing;
  if (typeof paragraphIndent === "number") node.paragraphIndent = paragraphIndent;

  return {
    id: node.id,
    name: node.name,
    fontName: node.fontName,
    fontSize: node.fontSize,
    textAlignHorizontal: node.textAlignHorizontal,
    textAlignVertical: node.textAlignVertical,
    textCase: node.textCase,
    textDecoration: node.textDecoration,
  };
}

const VALID_EFFECT_TYPES = new Set([
  "DROP_SHADOW",
  "INNER_SHADOW",
  "LAYER_BLUR",
  "BACKGROUND_BLUR",
]);

function normalizeEffect(e) {
  if (!e || !e.type) throw new Error("Effect missing 'type'");
  if (!VALID_EFFECT_TYPES.has(e.type)) {
    throw new Error(`Invalid effect type: ${e.type}`);
  }
  const visible = e.visible !== false;
  if (e.type === "LAYER_BLUR" || e.type === "BACKGROUND_BLUR") {
    if (typeof e.radius !== "number") {
      throw new Error(`${e.type} requires numeric 'radius'`);
    }
    return { type: e.type, radius: e.radius, visible };
  }
  // Shadows
  const c = e.color || {};
  // Use `== null` (matches null + undefined) since 0 is a valid color value
  // and `??` is not supported by all Figma plugin runtimes.
  const cr = c.r == null ? 0 : c.r;
  const cg = c.g == null ? 0 : c.g;
  const cb = c.b == null ? 0 : c.b;
  const ca = c.a == null ? 0.25 : c.a;
  return {
    type: e.type,
    color: {
      r: Math.min(1, Math.max(0, cr)),
      g: Math.min(1, Math.max(0, cg)),
      b: Math.min(1, Math.max(0, cb)),
      a: Math.min(1, Math.max(0, ca)),
    },
    offset: {
      x: (e.offset && e.offset.x) || 0,
      y: (e.offset && e.offset.y) || 0,
    },
    radius: typeof e.radius === "number" ? e.radius : 4,
    spread: typeof e.spread === "number" ? e.spread : 0,
    blendMode: e.blendMode || "NORMAL",
    visible,
  };
}

async function setEffects(params) {
  const { nodeId, effects, append = false } = params || {};

  if (!nodeId) throw new Error("Missing nodeId parameter");
  if (!Array.isArray(effects)) throw new Error("'effects' must be an array");

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found with ID: ${nodeId}`);
  if (!("effects" in node)) {
    throw new Error(`Node does not support effects: ${nodeId} (${node.type})`);
  }

  const normalized = effects.map(normalizeEffect);
  const existing = append && Array.isArray(node.effects) ? node.effects.slice() : [];
  node.effects = [...existing, ...normalized];

  return {
    id: node.id,
    name: node.name,
    effects: node.effects,
  };
}

// ---- Design System: Variables (read) ------------------------------

function summarizeCollection(c) {
  return {
    id: c.id,
    name: c.name,
    key: c.key,
    remote: c.remote,
    hiddenFromPublishing: c.hiddenFromPublishing,
    defaultModeId: c.defaultModeId,
    modes: (c.modes || []).map((m) => ({ modeId: m.modeId, name: m.name })),
    variableIds: c.variableIds || [],
  };
}

function summarizeVariable(v) {
  // valuesByMode keys are modeIds; values can be primitives or VariableAlias
  const valuesByMode = {};
  if (v.valuesByMode) {
    for (const [modeId, raw] of Object.entries(v.valuesByMode)) {
      if (raw && typeof raw === "object" && raw.type === "VARIABLE_ALIAS") {
        valuesByMode[modeId] = { type: "VARIABLE_ALIAS", id: raw.id };
      } else if (v.resolvedType === "COLOR" && raw && typeof raw === "object") {
        // Render color as hex for readability; keep raw too for round-tripping
        valuesByMode[modeId] = { color: raw, hex: rgbaToHex(raw) };
      } else {
        valuesByMode[modeId] = raw;
      }
    }
  }
  return {
    id: v.id,
    name: v.name,
    key: v.key,
    remote: v.remote,
    resolvedType: v.resolvedType,
    variableCollectionId: v.variableCollectionId,
    description: v.description,
    hiddenFromPublishing: v.hiddenFromPublishing,
    scopes: v.scopes,
    valuesByMode,
  };
}

async function getVariableCollections(_params) {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  return {
    count: collections.length,
    collections: collections.map(summarizeCollection),
  };
}

async function getVariables(params) {
  const { collectionId } = params || {};
  const all = await figma.variables.getLocalVariablesAsync();
  const filtered = collectionId
    ? all.filter((v) => v.variableCollectionId === collectionId)
    : all;
  return {
    count: filtered.length,
    variables: filtered.map(summarizeVariable),
  };
}

// ---- Design System: Variables (write) -----------------------------

const VARIABLE_TYPES = new Set(["BOOLEAN", "FLOAT", "STRING", "COLOR"]);

async function createVariableCollection(params) {
  const { name } = params || {};
  if (!name || typeof name !== "string") {
    throw new Error("'name' must be a non-empty string");
  }
  const collection = figma.variables.createVariableCollection(name);
  return summarizeCollection(collection);
}

async function createVariable(params) {
  const { collectionId, name, type, value } = params || {};
  if (!collectionId) throw new Error("Missing collectionId");
  if (!name) throw new Error("Missing name");
  if (!VARIABLE_TYPES.has(type)) {
    throw new Error(`Invalid type: ${type} (allowed: BOOLEAN, FLOAT, STRING, COLOR)`);
  }
  const collection = await figma.variables.getVariableCollectionByIdAsync(collectionId);
  if (!collection) throw new Error(`Collection not found: ${collectionId}`);

  const variable = figma.variables.createVariable(name, collection, type);

  // Optionally seed an initial value for the collection's default mode
  if (value !== undefined) {
    variable.setValueForMode(collection.defaultModeId, normalizeVariableValue(type, value));
  }

  return summarizeVariable(variable);
}

function normalizeVariableValue(type, value) {
  if (type === "COLOR") {
    if (!value || typeof value !== "object") {
      throw new Error("COLOR value must be {r,g,b,a?} with 0-1 channels");
    }
    return {
      r: Math.max(0, Math.min(1, Number(value.r) || 0)),
      g: Math.max(0, Math.min(1, Number(value.g) || 0)),
      b: Math.max(0, Math.min(1, Number(value.b) || 0)),
      a: value.a == null ? 1 : Math.max(0, Math.min(1, Number(value.a))),
    };
  }
  if (type === "FLOAT") {
    const n = Number(value);
    if (!isFinite(n)) throw new Error("FLOAT value must be a finite number");
    return n;
  }
  if (type === "BOOLEAN") {
    if (typeof value !== "boolean") throw new Error("BOOLEAN value must be true/false");
    return value;
  }
  if (type === "STRING") {
    if (typeof value !== "string") throw new Error("STRING value must be a string");
    return value;
  }
  throw new Error("Unknown variable type: " + type);
}

async function setVariableValue(params) {
  const { variableId, modeId, value } = params || {};
  if (!variableId) throw new Error("Missing variableId");
  if (!modeId) throw new Error("Missing modeId");

  const variable = await figma.variables.getVariableByIdAsync(variableId);
  if (!variable) throw new Error(`Variable not found: ${variableId}`);

  variable.setValueForMode(modeId, normalizeVariableValue(variable.resolvedType, value));
  return summarizeVariable(variable);
}

async function getCollectionOrThrow(collectionId) {
  if (!collectionId) throw new Error("Missing collectionId");
  const collection = await figma.variables.getVariableCollectionByIdAsync(collectionId);
  if (!collection) throw new Error(`Collection not found: ${collectionId}`);
  return collection;
}

async function addVariableMode(params) {
  const { collectionId, name } = params || {};
  if (!name) throw new Error("Missing name");
  const collection = await getCollectionOrThrow(collectionId);
  const modeId = collection.addMode(name);
  return { modeId, name, collectionId, modes: collection.modes };
}

async function renameVariableMode(params) {
  const { collectionId, modeId, name } = params || {};
  if (!modeId) throw new Error("Missing modeId");
  if (!name) throw new Error("Missing name");
  const collection = await getCollectionOrThrow(collectionId);
  collection.renameMode(modeId, name);
  return { modeId, name, collectionId, modes: collection.modes };
}

async function removeVariableMode(params) {
  const { collectionId, modeId } = params || {};
  if (!modeId) throw new Error("Missing modeId");
  const collection = await getCollectionOrThrow(collectionId);
  collection.removeMode(modeId);
  return { collectionId, modes: collection.modes };
}

// ---- Design System: Variables (bind to node) ----------------------

// Fields that can take a bound variable directly via setBoundVariable.
// Anything in fills/strokes goes through the paint helper instead.
const SIMPLE_BIND_FIELDS = new Set([
  // Geometry
  "width", "height",
  "minWidth", "minHeight", "maxWidth", "maxHeight",
  "cornerRadius",
  "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius",
  // Auto-layout
  "paddingLeft", "paddingRight", "paddingTop", "paddingBottom",
  "itemSpacing", "counterAxisSpacing",
  // Text
  "fontSize", "lineHeight", "letterSpacing",
  "paragraphSpacing", "paragraphIndent",
  "characters", // STRING variable
  // Visual
  "opacity",
  // Boolean
  "visible",
]);

const VALID_PAINT_PROPS = new Set(["color"]);

async function bindNodeVariable(params) {
  const {
    nodeId,
    field,
    variableId,
    paintIndex = 0,
    paintProperty = "color",
  } = params || {};

  if (!nodeId) throw new Error("Missing nodeId");
  if (!field) throw new Error("Missing field");
  if (!variableId) throw new Error("Missing variableId");

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);

  const variable = await figma.variables.getVariableByIdAsync(variableId);
  if (!variable) throw new Error(`Variable not found: ${variableId}`);

  if (field === "fills" || field === "strokes") {
    if (!VALID_PAINT_PROPS.has(paintProperty)) {
      throw new Error(`Invalid paintProperty: ${paintProperty} (allowed: color)`);
    }
    if (!(field in node)) {
      throw new Error(`Node does not support ${field}: ${nodeId} (${node.type})`);
    }
    const paints = (node[field] || []).slice();
    if (!paints[paintIndex]) {
      throw new Error(`No paint at ${field}[${paintIndex}] (length: ${paints.length})`);
    }
    paints[paintIndex] = figma.variables.setBoundVariableForPaint(
      paints[paintIndex],
      paintProperty,
      variable
    );
    node[field] = paints;
  } else if (SIMPLE_BIND_FIELDS.has(field)) {
    if (typeof node.setBoundVariable !== "function") {
      throw new Error(`Node does not support setBoundVariable: ${nodeId} (${node.type})`);
    }
    node.setBoundVariable(field, variable);
  } else {
    throw new Error(`Unsupported field: ${field}. ` +
      `Allowed: fills, strokes, or one of {${Array.from(SIMPLE_BIND_FIELDS).join(", ")}}`);
  }

  return {
    id: node.id,
    name: node.name,
    field,
    variableId,
    boundVariables: node.boundVariables,
  };
}

// Make a source variable's value (for one mode) be an alias to another variable.
// Both variables must have the same resolvedType; this is how a "semantic"
// token (e.g. color/text/primary) references a "primitive" (color/blue/600).
async function setVariableAlias(params) {
  const { variableId, modeId, targetVariableId } = params || {};
  if (!variableId) throw new Error("Missing variableId");
  if (!modeId) throw new Error("Missing modeId");
  if (!targetVariableId) throw new Error("Missing targetVariableId");
  if (variableId === targetVariableId) {
    throw new Error("A variable cannot alias itself");
  }

  const source = await figma.variables.getVariableByIdAsync(variableId);
  if (!source) throw new Error(`Source variable not found: ${variableId}`);

  const target = await figma.variables.getVariableByIdAsync(targetVariableId);
  if (!target) throw new Error(`Target variable not found: ${targetVariableId}`);

  if (source.resolvedType !== target.resolvedType) {
    throw new Error(
      `Type mismatch: source is ${source.resolvedType}, target is ${target.resolvedType}`
    );
  }

  const aliasValue = figma.variables.createVariableAlias(target);
  source.setValueForMode(modeId, aliasValue);

  return summarizeVariable(source);
}

// ---- Design System: Styles (create) -------------------------------

function summarizeStyle(s) {
  return {
    id: s.id,
    name: s.name,
    type: s.type,
    key: s.key,
    description: s.description,
    remote: s.remote,
  };
}

function clamp01(v) {
  var n = typeof v === "number" && isFinite(v) ? v : 0;
  return Math.max(0, Math.min(1, n));
}

// Normalize a SOLID paint passed by the caller into Figma's strict shape.
// GRADIENT_* and IMAGE paints pass through (caller must supply valid shape).
function normalizePaintForStyle(p) {
  if (!p || typeof p !== "object") {
    throw new Error("Each paint must be an object with a 'type' field");
  }
  if (p.type === "SOLID") {
    var c = p.color || {};
    return {
      type: "SOLID",
      color: { r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b) },
      opacity: p.opacity == null ? 1 : clamp01(p.opacity),
      visible: p.visible !== false,
      blendMode: p.blendMode || "NORMAL",
    };
  }
  return p;
}

async function createPaintStyle(params) {
  const { name, paints, description } = params || {};
  if (!name) throw new Error("Missing name");
  if (!Array.isArray(paints) || paints.length === 0) {
    throw new Error("'paints' must be a non-empty array");
  }
  const style = figma.createPaintStyle();
  style.name = name;
  if (description) style.description = description;
  style.paints = paints.map(normalizePaintForStyle);
  return summarizeStyle(style);
}

async function createTextStyle(params) {
  const {
    name, description,
    fontFamily, fontStyle, fontSize,
    letterSpacing, lineHeight,
    textCase, textDecoration,
    paragraphSpacing, paragraphIndent,
  } = params || {};

  if (!name) throw new Error("Missing name");
  if (!fontFamily || !fontStyle) throw new Error("Text style requires fontFamily + fontStyle");
  if (typeof fontSize !== "number") throw new Error("Text style requires numeric fontSize");

  await figma.loadFontAsync({ family: fontFamily, style: fontStyle });

  const style = figma.createTextStyle();
  style.name = name;
  if (description) style.description = description;
  style.fontName = { family: fontFamily, style: fontStyle };
  style.fontSize = fontSize;

  if (letterSpacing !== undefined) {
    style.letterSpacing = typeof letterSpacing === "number"
      ? { value: letterSpacing, unit: "PIXELS" }
      : letterSpacing;
  }
  if (lineHeight !== undefined) {
    if (lineHeight === "AUTO") style.lineHeight = { unit: "AUTO" };
    else if (typeof lineHeight === "number") {
      style.lineHeight = { value: lineHeight, unit: "PIXELS" };
    } else {
      style.lineHeight = lineHeight;
    }
  }
  if (textCase) style.textCase = textCase;
  if (textDecoration) style.textDecoration = textDecoration;
  if (typeof paragraphSpacing === "number") style.paragraphSpacing = paragraphSpacing;
  if (typeof paragraphIndent === "number") style.paragraphIndent = paragraphIndent;

  return summarizeStyle(style);
}

async function createEffectStyle(params) {
  const { name, effects, description } = params || {};
  if (!name) throw new Error("Missing name");
  if (!Array.isArray(effects) || effects.length === 0) {
    throw new Error("'effects' must be a non-empty array");
  }
  const style = figma.createEffectStyle();
  style.name = name;
  if (description) style.description = description;
  style.effects = effects.map(normalizeEffect);  // shared with setEffects
  return summarizeStyle(style);
}

async function createGridStyle(params) {
  const { name, layoutGrids, description } = params || {};
  if (!name) throw new Error("Missing name");
  if (!Array.isArray(layoutGrids) || layoutGrids.length === 0) {
    throw new Error("'layoutGrids' must be a non-empty array");
  }
  const style = figma.createGridStyle();
  style.name = name;
  if (description) style.description = description;
  style.layoutGrids = layoutGrids;
  return summarizeStyle(style);
}

// ---- Design System: Styles (apply / rename / delete) --------------

// Map of node-style-target → setter info. Modern API requires Async setters
// when documentAccess: "dynamic-page"; we use the async variants throughout.
const STYLE_TARGETS = {
  fill:   { idField: "fillStyleId",   setter: "setFillStyleIdAsync"   },
  stroke: { idField: "strokeStyleId", setter: "setStrokeStyleIdAsync" },
  text:   { idField: "textStyleId",   setter: "setTextStyleIdAsync"   },
  effect: { idField: "effectStyleId", setter: "setEffectStyleIdAsync" },
  grid:   { idField: "gridStyleId",   setter: "setGridStyleIdAsync"   },
};

async function applyStyle(params) {
  const { nodeId, styleId, target } = params || {};
  if (!nodeId) throw new Error("Missing nodeId");
  if (!styleId) throw new Error("Missing styleId");
  const cfg = STYLE_TARGETS[target];
  if (!cfg) throw new Error(`Invalid target: ${target} (allowed: fill, stroke, text, effect, grid)`);

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);

  // Verify the style exists and matches the target
  const style = await figma.getStyleByIdAsync(styleId);
  if (!style) throw new Error(`Style not found: ${styleId}`);

  // text target must use TEXT style, etc.
  const expectedStyleType =
    target === "text" ? "TEXT" :
    target === "effect" ? "EFFECT" :
    target === "grid" ? "GRID" :
    "PAINT"; // fill | stroke
  if (style.type !== expectedStyleType) {
    throw new Error(`Style type mismatch: target '${target}' needs ${expectedStyleType}, got ${style.type}`);
  }

  if (typeof node[cfg.setter] === "function") {
    await node[cfg.setter](styleId);
  } else if (cfg.idField in node) {
    // Fallback for older runtimes; readonly in dynamic-page mode
    node[cfg.idField] = styleId;
  } else {
    throw new Error(`Node does not support ${cfg.idField}: ${node.type}`);
  }

  return {
    id: node.id,
    name: node.name,
    target,
    styleId,
    styleName: style.name,
  };
}

async function renameStyle(params) {
  const { styleId, name } = params || {};
  if (!styleId) throw new Error("Missing styleId");
  if (!name) throw new Error("Missing name");
  const style = await figma.getStyleByIdAsync(styleId);
  if (!style) throw new Error(`Style not found: ${styleId}`);
  style.name = name;
  return summarizeStyle(style);
}

async function deleteStyle(params) {
  const { styleId } = params || {};
  if (!styleId) throw new Error("Missing styleId");
  const style = await figma.getStyleByIdAsync(styleId);
  if (!style) throw new Error(`Style not found: ${styleId}`);
  const summary = summarizeStyle(style);
  style.remove();
  // Figma plugin runtime doesn't support ES2018 object-spread → use Object.assign.
  return Object.assign({}, summary, { removed: true });
}

// ---- Design System: Components (create / detach / swap) -----------

// ---- FigJam nodes (BL-035) ----------------------------------------
//
// These APIs only exist when the file is a FigJam document. We surface a
// clearer error than "function is not defined" when called from a Figma
// design file.

function ensureFigjam(api) {
  if (typeof figma[api] !== "function") {
    throw new Error(
      "figma." + api + " is not available — current editor type is " +
      figma.editorType + ". This tool only works in FigJam files."
    );
  }
}

async function placeAt(node, x, y, parentId) {
  if (typeof x === "number") node.x = x;
  if (typeof y === "number") node.y = y;
  if (parentId) {
    const parent = await figma.getNodeByIdAsync(parentId);
    if (!parent) throw new Error("Parent not found: " + parentId);
    if (typeof parent.appendChild !== "function") {
      throw new Error("Target is not a container: " + parentId);
    }
    parent.appendChild(node);
  }
}

const STICKY_AUTHOR_VISIBILITY = new Set(["TRUE", "FALSE"]);

async function createSticky(params) {
  ensureFigjam("createSticky");
  const { text, x, y, parentId, authorVisible } = params || {};
  const sticky = figma.createSticky();
  if (typeof text === "string" && text.length > 0) {
    if (sticky.text && typeof sticky.text.characters !== "undefined") {
      // sticky.text is a TextNode-like sub-object; setting characters
      // requires the default font to be loaded.
      await figma.loadFontAsync(sticky.text.fontName || { family: "Inter", style: "Medium" });
      sticky.text.characters = text;
    }
  }
  if (typeof authorVisible === "boolean") sticky.authorVisible = authorVisible;
  await placeAt(sticky, x, y, parentId);
  return { id: sticky.id, name: sticky.name, type: sticky.type, x: sticky.x, y: sticky.y };
}

const SHAPE_WITH_TEXT_TYPES = new Set([
  "SQUARE", "ELLIPSE", "ROUNDED_RECTANGLE", "DIAMOND", "TRIANGLE_UP",
  "TRIANGLE_DOWN", "PARALLELOGRAM_RIGHT", "PARALLELOGRAM_LEFT",
  "ENG_DATABASE", "ENG_QUEUE", "ENG_FILE", "ENG_FOLDER",
  "TRAPEZOID", "PREDEFINED_PROCESS", "SHIELD", "DOCUMENT_SINGLE",
  "DOCUMENT_MULTIPLE", "MANUAL_INPUT", "HEXAGON", "CHEVRON_RIGHT_ARROW",
  "CHEVRON_RIGHT_DOUBLE_ARROW", "CHEVRON_LEFT_ARROW", "FLOWCHART_PROCESS",
]);

async function createShapeWithText(params) {
  ensureFigjam("createShapeWithText");
  const {
    shapeType = "SQUARE",
    text,
    x, y, parentId,
    width, height,
  } = params || {};
  if (!SHAPE_WITH_TEXT_TYPES.has(shapeType)) {
    throw new Error("Invalid shapeType: " + shapeType);
  }
  const shape = figma.createShapeWithText();
  shape.shapeType = shapeType;
  if (typeof text === "string" && text.length > 0 && shape.text) {
    await figma.loadFontAsync(shape.text.fontName || { family: "Inter", style: "Medium" });
    shape.text.characters = text;
  }
  if (typeof width === "number" && typeof height === "number") {
    shape.resize(width, height);
  }
  await placeAt(shape, x, y, parentId);
  return {
    id: shape.id,
    name: shape.name,
    type: shape.type,
    shapeType: shape.shapeType,
    x: shape.x, y: shape.y,
  };
}

async function createTable(params) {
  ensureFigjam("createTable");
  const { rows = 2, cols = 2, x, y, parentId } = params || {};
  if (!Number.isInteger(rows) || rows < 1) throw new Error("rows must be a positive integer");
  if (!Number.isInteger(cols) || cols < 1) throw new Error("cols must be a positive integer");
  const table = figma.createTable(rows, cols);
  await placeAt(table, x, y, parentId);
  return {
    id: table.id,
    name: table.name,
    type: table.type,
    numRows: table.numRows,
    numColumns: table.numColumns,
    x: table.x, y: table.y,
  };
}

// ---- Plugin Data / metadata (BL-026) ------------------------------

// Both plugin-data variants only accept strings. Callers wanting structured
// data should JSON.stringify before storing. Empty string deletes the key
// in Figma's API; we surface that as `deleted: true` for clarity.

async function setPluginData(params) {
  const { nodeId, key, value } = params || {};
  if (!nodeId) throw new Error("Missing nodeId");
  if (!key) throw new Error("Missing key");
  if (typeof value !== "string") throw new Error("value must be a string (JSON.stringify objects first)");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);
  if (typeof node.setPluginData !== "function") {
    throw new Error("Node does not support pluginData: " + node.type);
  }
  node.setPluginData(key, value);
  return { id: node.id, key: key, valueLength: value.length, deleted: value === "" };
}

async function getPluginData(params) {
  const { nodeId, key } = params || {};
  if (!nodeId) throw new Error("Missing nodeId");
  if (!key) throw new Error("Missing key");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);
  if (typeof node.getPluginData !== "function") {
    throw new Error("Node does not support pluginData: " + node.type);
  }
  const value = node.getPluginData(key);
  return { id: node.id, key: key, value: value };
}

async function setSharedPluginData(params) {
  const { nodeId, namespace, key, value } = params || {};
  if (!nodeId) throw new Error("Missing nodeId");
  if (!namespace) throw new Error("Missing namespace");
  if (!key) throw new Error("Missing key");
  if (typeof value !== "string") throw new Error("value must be a string");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);
  if (typeof node.setSharedPluginData !== "function") {
    throw new Error("Node does not support sharedPluginData: " + node.type);
  }
  node.setSharedPluginData(namespace, key, value);
  return { id: node.id, namespace: namespace, key: key, valueLength: value.length, deleted: value === "" };
}

async function getSharedPluginData(params) {
  const { nodeId, namespace, key } = params || {};
  if (!nodeId) throw new Error("Missing nodeId");
  if (!namespace) throw new Error("Missing namespace");
  if (!key) throw new Error("Missing key");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);
  if (typeof node.getSharedPluginData !== "function") {
    throw new Error("Node does not support sharedPluginData: " + node.type);
  }
  const value = node.getSharedPluginData(namespace, key);
  return { id: node.id, namespace: namespace, key: key, value: value };
}

// ---- Viewport / camera (BL-033) -----------------------------------

async function getViewportBounds(_params) {
  const v = figma.viewport;
  return {
    center: { x: v.center.x, y: v.center.y },
    zoom: v.zoom,
    bounds: {
      x: v.bounds.x,
      y: v.bounds.y,
      width: v.bounds.width,
      height: v.bounds.height,
    },
  };
}

async function setViewportZoom(params) {
  const { zoom } = params || {};
  if (typeof zoom !== "number" || !isFinite(zoom) || zoom <= 0) {
    throw new Error("zoom must be a positive number (0.02-256 typical range)");
  }
  figma.viewport.zoom = zoom;
  return { zoom: figma.viewport.zoom };
}

async function setViewportCenter(params) {
  const { x, y } = params || {};
  if (typeof x !== "number" || typeof y !== "number") {
    throw new Error("x and y must be numbers (canvas coordinates)");
  }
  figma.viewport.center = { x: x, y: y };
  return { center: { x: figma.viewport.center.x, y: figma.viewport.center.y } };
}

async function scrollAndZoomIntoView(params) {
  const { nodeIds } = params || {};
  if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
    throw new Error("nodeIds must be a non-empty string array");
  }
  const nodes = [];
  for (let i = 0; i < nodeIds.length; i++) {
    const n = await figma.getNodeByIdAsync(nodeIds[i]);
    if (!n) throw new Error("Node not found: " + nodeIds[i]);
    nodes.push(n);
  }
  figma.viewport.scrollAndZoomIntoView(nodes);
  const v = figma.viewport;
  return {
    framedNodeCount: nodes.length,
    center: { x: v.center.x, y: v.center.y },
    zoom: v.zoom,
  };
}

// ---- Prototyping (BL-014) ----------------------------------------
//
// Wraps Figma's reactions / flow-starting-points / overflow / prototype
// device APIs. The trigger and action shapes are validated on the server
// (Zod) — here we just normalize and assign. Plugin runtime forbids
// `??` / `?.` / object spread, so keep helpers explicit.

var REACTION_TRIGGER_TYPES = [
  "ON_CLICK",
  "ON_HOVER",
  "ON_PRESS",
  "ON_DRAG",
  "AFTER_TIMEOUT",
  "MOUSE_ENTER",
  "MOUSE_LEAVE",
  "MOUSE_UP",
  "MOUSE_DOWN",
  "ON_KEY_DOWN",
];

var REACTION_ACTION_TYPES = [
  "BACK",
  "CLOSE",
  "URL",
  "NODE",
  "SCROLL_TO",
  "SET_VARIABLE",
  "SET_VARIABLE_MODE",
  "CONDITIONAL",
];

var NODE_NAVIGATIONS = [
  "NAVIGATE", "OVERLAY", "SWAP", "PUSH", "BACK", "CLOSE",
];

function normalizeTrigger(trigger) {
  if (!trigger || typeof trigger !== "object") {
    throw new Error("trigger must be an object with a 'type' field");
  }
  var type = trigger.type;
  if (REACTION_TRIGGER_TYPES.indexOf(type) === -1) {
    throw new Error(
      "Unsupported trigger.type: " + String(type) +
      ". Allowed: " + REACTION_TRIGGER_TYPES.join(", ")
    );
  }
  if (type === "AFTER_TIMEOUT") {
    var timeout = trigger.timeout;
    if (typeof timeout !== "number" || !isFinite(timeout) || timeout < 0) {
      throw new Error("AFTER_TIMEOUT trigger requires a non-negative numeric 'timeout' (seconds)");
    }
    return { type: "AFTER_TIMEOUT", timeout: timeout };
  }
  if (type === "ON_KEY_DOWN") {
    var device = trigger.device == null ? "KEYBOARD" : trigger.device;
    var keyCodes = trigger.keyCodes;
    if (!Array.isArray(keyCodes)) {
      throw new Error("ON_KEY_DOWN trigger requires 'keyCodes' (number[])");
    }
    return { type: "ON_KEY_DOWN", device: device, keyCodes: keyCodes.slice() };
  }
  // Plain triggers without extra fields.
  return { type: type };
}

function normalizeAction(action) {
  if (!action || typeof action !== "object") {
    throw new Error("action must be an object with a 'type' field");
  }
  var type = action.type;
  if (REACTION_ACTION_TYPES.indexOf(type) === -1) {
    throw new Error(
      "Unsupported action.type: " + String(type) +
      ". Allowed: " + REACTION_ACTION_TYPES.join(", ")
    );
  }
  if (type === "BACK" || type === "CLOSE") {
    return { type: type };
  }
  if (type === "URL") {
    if (typeof action.url !== "string" || action.url.length === 0) {
      throw new Error("URL action requires a non-empty 'url' string");
    }
    return { type: "URL", url: action.url };
  }
  if (type === "NODE") {
    if (typeof action.destinationId !== "string" || action.destinationId.length === 0) {
      throw new Error("NODE action requires 'destinationId' string");
    }
    var nav = action.navigation;
    if (NODE_NAVIGATIONS.indexOf(nav) === -1) {
      throw new Error(
        "NODE action requires 'navigation' in: " + NODE_NAVIGATIONS.join(", ")
      );
    }
    var nodeAction = {
      type: "NODE",
      destinationId: action.destinationId,
      navigation: nav,
      transition: action.transition == null ? null : action.transition,
      preserveScrollPosition: action.preserveScrollPosition === true,
    };
    if (action.overlayRelativePosition != null) {
      nodeAction.overlayRelativePosition = action.overlayRelativePosition;
    }
    if (action.resetVideoPosition != null) {
      nodeAction.resetVideoPosition = action.resetVideoPosition === true;
    }
    if (action.resetScrollPosition != null) {
      nodeAction.resetScrollPosition = action.resetScrollPosition === true;
    }
    if (action.resetInteractiveComponents != null) {
      nodeAction.resetInteractiveComponents = action.resetInteractiveComponents === true;
    }
    return nodeAction;
  }
  if (type === "SCROLL_TO") {
    if (typeof action.destinationId !== "string" || action.destinationId.length === 0) {
      throw new Error("SCROLL_TO action requires 'destinationId' string");
    }
    return {
      type: "SCROLL_TO",
      destinationId: action.destinationId,
      transition: action.transition == null ? null : action.transition,
    };
  }
  // SET_VARIABLE / SET_VARIABLE_MODE / CONDITIONAL — passthrough; caller
  // is responsible for matching Figma's expected shape exactly.
  return action;
}

async function setReaction(params) {
  if (!params || typeof params.nodeId !== "string") {
    throw new Error("Missing nodeId parameter");
  }
  var node = await figma.getNodeByIdAsync(params.nodeId);
  if (!node) {
    throw new Error("Node not found: " + params.nodeId);
  }
  if (!("reactions" in node)) {
    throw new Error("Node type " + node.type + " does not support reactions");
  }
  var trigger = normalizeTrigger(params.trigger);
  var action = normalizeAction(params.action);
  var reaction = { trigger: trigger, action: action };

  // Some node types expose async setter; prefer it when present.
  if (typeof node.setReactionsAsync === "function") {
    await node.setReactionsAsync([reaction]);
  } else {
    node.reactions = [reaction];
  }
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    reactionsCount: 1,
    reaction: reaction,
  };
}

async function clearReactions(params) {
  if (!params || typeof params.nodeId !== "string") {
    throw new Error("Missing nodeId parameter");
  }
  var node = await figma.getNodeByIdAsync(params.nodeId);
  if (!node) {
    throw new Error("Node not found: " + params.nodeId);
  }
  if (!("reactions" in node)) {
    throw new Error("Node type " + node.type + " does not support reactions");
  }
  if (typeof node.setReactionsAsync === "function") {
    await node.setReactionsAsync([]);
  } else {
    node.reactions = [];
  }
  return { id: node.id, name: node.name, type: node.type, reactionsCount: 0 };
}

async function setFlowStartingPoint(params) {
  if (!params || typeof params.pageId !== "string") {
    throw new Error("Missing pageId parameter");
  }
  if (typeof params.nodeId !== "string") {
    throw new Error("Missing nodeId parameter");
  }
  var page = await figma.getNodeByIdAsync(params.pageId);
  if (!page) {
    throw new Error("Page not found: " + params.pageId);
  }
  if (page.type !== "PAGE") {
    throw new Error("pageId must reference a PAGE node, got: " + page.type);
  }
  var node = await figma.getNodeByIdAsync(params.nodeId);
  if (!node) {
    throw new Error("Node not found: " + params.nodeId);
  }
  // Flow starting points must live on top-level frames.
  var name = typeof params.name === "string" && params.name.length > 0
    ? params.name
    : "Flow " + (node.name || node.id);

  var existing = Array.isArray(page.flowStartingPoints)
    ? page.flowStartingPoints.slice()
    : [];
  var nextPoints = [];
  var replaced = false;
  for (var i = 0; i < existing.length; i++) {
    var fp = existing[i];
    if (fp && fp.nodeId === params.nodeId) {
      nextPoints.push({ nodeId: params.nodeId, name: name });
      replaced = true;
    } else {
      nextPoints.push(fp);
    }
  }
  if (!replaced) {
    nextPoints.push({ nodeId: params.nodeId, name: name });
  }
  page.flowStartingPoints = nextPoints;
  return {
    pageId: page.id,
    nodeId: params.nodeId,
    name: name,
    replaced: replaced,
    flowStartingPointsCount: nextPoints.length,
  };
}

var OVERFLOW_DIRECTIONS = ["NONE", "HORIZONTAL", "VERTICAL", "BOTH"];

async function setOverflowDirection(params) {
  if (!params || typeof params.nodeId !== "string") {
    throw new Error("Missing nodeId parameter");
  }
  var direction = params.direction;
  if (OVERFLOW_DIRECTIONS.indexOf(direction) === -1) {
    throw new Error(
      "direction must be one of: " + OVERFLOW_DIRECTIONS.join(", ")
    );
  }
  var node = await figma.getNodeByIdAsync(params.nodeId);
  if (!node) {
    throw new Error("Node not found: " + params.nodeId);
  }
  if (!("overflowDirection" in node)) {
    throw new Error("Node type " + node.type + " does not support overflowDirection");
  }
  node.overflowDirection = direction;
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    overflowDirection: node.overflowDirection,
  };
}

var PROTOTYPE_DEVICE_TYPES = ["NONE", "PRESET", "CUSTOM", "PRESENTATION"];

async function setPrototypeDevice(params) {
  var p = params || {};
  var device;
  if (p.presetIdentifier && !p.type) {
    // Shorthand: just a preset identifier.
    device = { type: "PRESET", presetIdentifier: p.presetIdentifier };
    if (p.rotation) device.rotation = p.rotation;
  } else {
    var type = p.type;
    if (PROTOTYPE_DEVICE_TYPES.indexOf(type) === -1) {
      throw new Error(
        "type must be one of: " + PROTOTYPE_DEVICE_TYPES.join(", ")
      );
    }
    device = { type: type };
    if (p.presetIdentifier) device.presetIdentifier = p.presetIdentifier;
    if (p.size) device.size = p.size;
    if (p.rotation) device.rotation = p.rotation;
  }
  figma.currentPage.prototypeDevice = device;
  var current = figma.currentPage.prototypeDevice;
  return {
    pageId: figma.currentPage.id,
    prototypeDevice: current,
  };
}

// ---- Image follow-ups (BL-024) ------------------------------------

const IMAGE_FILTER_KEYS = [
  "exposure", "contrast", "saturation",
  "temperature", "tint", "highlights", "shadows",
];

function clampFilter(v) {
  var n = typeof v === "number" && isFinite(v) ? v : 0;
  return Math.max(-1, Math.min(1, n));
}

async function setImageFilters(params) {
  const { nodeId, filters, paintIndex = 0, target = "fills" } = params || {};
  if (!nodeId) throw new Error("Missing nodeId");
  if (!filters || typeof filters !== "object") {
    throw new Error("Missing filters object");
  }
  if (target !== "fills" && target !== "strokes") {
    throw new Error("target must be 'fills' or 'strokes'");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);
  if (!(target in node)) {
    throw new Error("Node does not support " + target + ": " + node.type);
  }

  const paints = Array.isArray(node[target]) ? node[target].slice() : [];
  const paint = paints[paintIndex];
  if (!paint) throw new Error("No paint at " + target + "[" + paintIndex + "]");
  if (paint.type !== "IMAGE") {
    throw new Error("Paint at index " + paintIndex + " is not an IMAGE (type: " + paint.type + ")");
  }

  const nextFilters = Object.assign({}, paint.filters || {});
  for (let i = 0; i < IMAGE_FILTER_KEYS.length; i++) {
    const key = IMAGE_FILTER_KEYS[i];
    if (filters[key] !== undefined) nextFilters[key] = clampFilter(filters[key]);
  }
  paints[paintIndex] = Object.assign({}, paint, { filters: nextFilters });
  node[target] = paints;

  return {
    id: node.id,
    name: node.name,
    paintIndex: paintIndex,
    target: target,
    filters: nextFilters,
  };
}

async function getImageBytesByHash(params) {
  const { imageHash } = params || {};
  if (!imageHash) throw new Error("Missing imageHash");
  const image = figma.getImageByHash(imageHash);
  if (!image) throw new Error("No image found for hash: " + imageHash);
  const bytes = await image.getBytesAsync();
  // base64-encode for transport over the WebSocket relay (text JSON only).
  // Build the binary string in blocks via String.fromCharCode.apply on each
  // block, then btoa once. Per-byte concatenation stalls (30s+) on multi-MB
  // images; block-wise is dramatically faster. Blocks stay small (8192) so
  // fromCharCode.apply never overflows the argument limit — do NOT use spread.
  const BLOCK = 8192;
  const blockStrings = [];
  for (let i = 0; i < bytes.length; i += BLOCK) {
    const end = Math.min(i + BLOCK, bytes.length);
    blockStrings.push(String.fromCharCode.apply(null, bytes.subarray(i, end)));
  }
  const binary = blockStrings.join("");
  return {
    imageHash: imageHash,
    byteLength: bytes.length,
    base64: btoa(binary),
  };
}

// ---- Paint stack helpers (BL-015) ---------------------------------

// Append/insert a paint without replacing the existing fills array.
// Mirrors Figma's "Add fill" UI button.
async function addFill(params) {
  const { nodeId, paint, index } = params || {};
  if (!nodeId) throw new Error("Missing nodeId");
  if (!paint || typeof paint !== "object") throw new Error("Missing paint object");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);
  if (!("fills" in node)) {
    throw new Error("Node does not support fills: " + node.type);
  }
  const next = Array.isArray(node.fills) ? node.fills.slice() : [];
  // SOLID paints get the same clamp + defaults as set_image_fill / styles.
  const normalized = paint.type === "SOLID" ? normalizePaintForStyle(paint) : paint;
  if (typeof index === "number" && index >= 0 && index <= next.length) {
    next.splice(index, 0, normalized);
  } else {
    next.push(normalized);
  }
  node.fills = next;
  return { id: node.id, name: node.name, fills: node.fills };
}

async function removeFillAt(params) {
  const { nodeId, index } = params || {};
  if (!nodeId) throw new Error("Missing nodeId");
  if (typeof index !== "number") throw new Error("Missing numeric index");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);
  if (!("fills" in node)) {
    throw new Error("Node does not support fills: " + node.type);
  }
  const current = Array.isArray(node.fills) ? node.fills.slice() : [];
  if (index < 0 || index >= current.length) {
    throw new Error("Index out of range: " + index + " (length " + current.length + ")");
  }
  const removed = current.splice(index, 1)[0];
  node.fills = current;
  return { id: node.id, name: node.name, removed: removed, fills: node.fills };
}

// ---- Layout: Constraints (BL-019) ---------------------------------

const CONSTRAINT_VALUES = new Set(["MIN", "MAX", "CENTER", "STRETCH", "SCALE"]);

async function setConstraints(params) {
  const { nodeId, horizontal, vertical } = params || {};
  if (!nodeId) throw new Error("Missing nodeId");
  if (!horizontal && !vertical) {
    throw new Error("Provide at least one of horizontal/vertical");
  }
  if (horizontal && !CONSTRAINT_VALUES.has(horizontal)) {
    throw new Error("Invalid horizontal: " + horizontal);
  }
  if (vertical && !CONSTRAINT_VALUES.has(vertical)) {
    throw new Error("Invalid vertical: " + vertical);
  }
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);
  if (!("constraints" in node)) {
    throw new Error("Node does not support constraints: " + node.type);
  }
  // node.constraints is a frozen object — must replace wholesale.
  const next = Object.assign({}, node.constraints);
  if (horizontal) next.horizontal = horizontal;
  if (vertical) next.vertical = vertical;
  node.constraints = next;
  return { id: node.id, name: node.name, constraints: node.constraints };
}

async function createComponentFromNode(params) {
  const { nodeId } = params || {};
  if (!nodeId) throw new Error("Missing nodeId");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);

  if (node.type === "COMPONENT") {
    return { id: node.id, name: node.name, type: node.type, key: node.key, alreadyComponent: true };
  }
  if (typeof figma.createComponentFromNode !== "function") {
    throw new Error("figma.createComponentFromNode is not available in this runtime");
  }
  const component = figma.createComponentFromNode(node);
  return {
    id: component.id,
    name: component.name,
    type: component.type,
    key: component.key,
  };
}

async function detachInstance(params) {
  const { nodeId } = params || {};
  if (!nodeId) throw new Error("Missing nodeId");
  const instance = await figma.getNodeByIdAsync(nodeId);
  if (!instance) throw new Error(`Node not found: ${nodeId}`);
  if (instance.type !== "INSTANCE") {
    throw new Error(`Node is not an instance: ${nodeId} (${instance.type})`);
  }
  const frame = instance.detachInstance();
  return { id: frame.id, name: frame.name, type: frame.type };
}

async function swapInstance(params) {
  const { nodeId, mainComponentId } = params || {};
  if (!nodeId) throw new Error("Missing nodeId");
  if (!mainComponentId) throw new Error("Missing mainComponentId");

  const instance = await figma.getNodeByIdAsync(nodeId);
  if (!instance) throw new Error(`Instance not found: ${nodeId}`);
  if (instance.type !== "INSTANCE") {
    throw new Error(`Node is not an instance: ${nodeId} (${instance.type})`);
  }

  const main = await figma.getNodeByIdAsync(mainComponentId);
  if (!main) throw new Error(`Main component not found: ${mainComponentId}`);
  if (main.type !== "COMPONENT") {
    throw new Error(`Target is not a component: ${mainComponentId} (${main.type})`);
  }

  instance.swapComponent(main);

  return {
    id: instance.id,
    name: instance.name,
    mainComponent: { id: main.id, name: main.name },
  };
}

// ---- Design System: Component Set + Properties --------------------

async function createComponentSet(params) {
  const { componentIds, name } = params || {};
  if (!Array.isArray(componentIds) || componentIds.length === 0) {
    throw new Error("'componentIds' must be a non-empty array");
  }
  const components = [];
  for (const id of componentIds) {
    const c = await figma.getNodeByIdAsync(id);
    if (!c) throw new Error(`Component not found: ${id}`);
    if (c.type !== "COMPONENT") {
      throw new Error(`Not a component: ${id} (${c.type})`);
    }
    components.push(c);
  }
  // combineAsVariants requires a parent. Use the first component's parent
  // (variants must come from siblings) or fall back to current page.
  const parent = components[0].parent || figma.currentPage;
  const set = figma.combineAsVariants(components, parent);
  if (name && typeof name === "string") set.name = name;
  return {
    id: set.id,
    name: set.name,
    type: set.type,
    variantCount: components.length,
  };
}

const VALID_PROPERTY_TYPES = new Set(["BOOLEAN", "TEXT", "INSTANCE_SWAP", "VARIANT"]);

async function addComponentProperty(params) {
  const { componentSetId, name, type, defaultValue, options } = params || {};
  if (!componentSetId) throw new Error("Missing componentSetId");
  if (!name) throw new Error("Missing name");
  if (!VALID_PROPERTY_TYPES.has(type)) {
    throw new Error(`Invalid type: ${type} (allowed: ${Array.from(VALID_PROPERTY_TYPES).join(", ")})`);
  }

  const target = await figma.getNodeByIdAsync(componentSetId);
  if (!target) throw new Error(`Node not found: ${componentSetId}`);
  if (target.type !== "COMPONENT_SET" && target.type !== "COMPONENT") {
    throw new Error(`Target must be COMPONENT_SET or COMPONENT, got ${target.type}`);
  }

  // INSTANCE_SWAP can take preferredValues option (array of {type:'COMPONENT', key} etc.)
  // VARIANT requires a list of variant option strings.
  const opts = options && typeof options === "object" ? options : undefined;

  const propertyId = target.addComponentProperty(name, type, defaultValue, opts);
  return {
    propertyId,
    name,
    type,
    defaultValue,
    componentPropertyDefinitions: target.componentPropertyDefinitions,
  };
}

async function setComponentProperty(params) {
  const { instanceId, properties } = params || {};
  if (!instanceId) throw new Error("Missing instanceId");
  if (!properties || typeof properties !== "object") {
    throw new Error("'properties' must be an object { propertyId: value }");
  }

  const instance = await figma.getNodeByIdAsync(instanceId);
  if (!instance) throw new Error(`Instance not found: ${instanceId}`);
  if (instance.type !== "INSTANCE") {
    throw new Error(`Not an instance: ${instanceId} (${instance.type})`);
  }

  instance.setProperties(properties);
  return {
    id: instance.id,
    name: instance.name,
    componentProperties: instance.componentProperties,
  };
}

// BL-071: read component property values (instance) and definitions (set/component).

async function getComponentProperties(params) {
  const p = params || {};
  const instanceId = p.instanceId;
  if (!instanceId) throw new Error("Missing instanceId");

  const node = await figma.getNodeByIdAsync(instanceId);
  if (!node) throw new Error(`Node not found: ${instanceId}`);
  if (node.type !== "INSTANCE") {
    throw new Error(`Not an instance: ${instanceId} (${node.type}). Use get_component_property_definitions for a component or component set.`);
  }

  const main = await node.getMainComponentAsync();
  return {
    id: node.id,
    name: node.name,
    mainComponentId: main ? main.id : null,
    mainComponentName: main ? main.name : null,
    componentProperties: node.componentProperties,
  };
}

async function getComponentPropertyDefinitions(params) {
  const p = params || {};
  const componentSetId = p.componentSetId;
  if (!componentSetId) throw new Error("Missing componentSetId");

  const node = await figma.getNodeByIdAsync(componentSetId);
  if (!node) throw new Error(`Node not found: ${componentSetId}`);

  if (node.type === "INSTANCE") {
    throw new Error(`'${componentSetId}' is an instance. Use get_component_properties for instances, or pass its main component / component set id.`);
  }
  if (node.type !== "COMPONENT_SET" && node.type !== "COMPONENT") {
    throw new Error(`Target must be COMPONENT_SET or COMPONENT, got ${node.type}`);
  }

  // A COMPONENT that is a variant of a set can't expose definitions directly —
  // Figma throws on read; the definitions live on the parent set.
  let source = node;
  let resolvedFrom = null;
  if (node.type === "COMPONENT" && node.parent && node.parent.type === "COMPONENT_SET") {
    source = node.parent;
    resolvedFrom = { variantId: node.id, componentSetId: node.parent.id };
  }

  return {
    id: source.id,
    name: source.name,
    type: source.type,
    resolvedFrom: resolvedFrom,
    componentPropertyDefinitions: source.componentPropertyDefinitions,
  };
}

async function unbindNodeVariable(params) {
  const { nodeId, field, paintIndex = 0, paintProperty = "color" } = params || {};
  if (!nodeId) throw new Error("Missing nodeId");
  if (!field) throw new Error("Missing field");

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);

  if (field === "fills" || field === "strokes") {
    const paints = (node[field] || []).slice();
    if (!paints[paintIndex]) {
      throw new Error(`No paint at ${field}[${paintIndex}]`);
    }
    paints[paintIndex] = figma.variables.setBoundVariableForPaint(
      paints[paintIndex],
      paintProperty,
      null
    );
    node[field] = paints;
  } else if (SIMPLE_BIND_FIELDS.has(field)) {
    node.setBoundVariable(field, null);
  } else {
    throw new Error(`Unsupported field: ${field}`);
  }

  return {
    id: node.id,
    name: node.name,
    field,
    boundVariables: node.boundVariables,
  };
}

// ---- Trivial node-property helpers --------------------------------

async function getMutableNode(nodeId) {
  if (!nodeId) throw new Error("Missing nodeId parameter");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found with ID: ${nodeId}`);
  if (node.removed) throw new Error(`Node was removed: ${nodeId}`);
  return node;
}

async function renameNode(params) {
  const { nodeId, name } = params || {};
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("'name' must be a non-empty string");
  }
  const node = await getMutableNode(nodeId);
  // Pages, sections, frames, and most node types support rename.
  // DocumentNode is the only frequent exception worth surfacing clearly.
  if (node.type === "DOCUMENT") throw new Error("Cannot rename the document root");
  node.name = name;
  return { id: node.id, name: node.name, type: node.type };
}

async function setOpacity(params) {
  const { nodeId, opacity } = params || {};
  if (typeof opacity !== "number") throw new Error("'opacity' must be a number 0-1");
  const node = await getMutableNode(nodeId);
  if (!("opacity" in node)) {
    throw new Error(`Node does not support opacity: ${nodeId} (${node.type})`);
  }
  node.opacity = Math.min(1, Math.max(0, opacity));
  return { id: node.id, name: node.name, opacity: node.opacity };
}

async function setVisible(params) {
  const { nodeId, visible } = params || {};
  if (typeof visible !== "boolean") throw new Error("'visible' must be a boolean");
  const node = await getMutableNode(nodeId);
  if (!("visible" in node)) {
    throw new Error(`Node does not support visibility: ${nodeId} (${node.type})`);
  }
  node.visible = visible;
  return { id: node.id, name: node.name, visible: node.visible };
}

async function setLocked(params) {
  const { nodeId, locked } = params || {};
  if (typeof locked !== "boolean") throw new Error("'locked' must be a boolean");
  const node = await getMutableNode(nodeId);
  if (!("locked" in node)) {
    throw new Error(`Node does not support locking: ${nodeId} (${node.type})`);
  }
  node.locked = locked;
  return { id: node.id, name: node.name, locked: node.locked };
}

const VALID_BLEND_MODES = new Set([
  "PASS_THROUGH", "NORMAL",
  "DARKEN", "MULTIPLY", "LINEAR_BURN", "COLOR_BURN",
  "LIGHTEN", "SCREEN", "LINEAR_DODGE", "COLOR_DODGE",
  "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT",
  "DIFFERENCE", "EXCLUSION",
  "HUE", "SATURATION", "COLOR", "LUMINOSITY",
]);

async function setBlendMode(params) {
  const { nodeId, blendMode } = params || {};
  if (!blendMode || !VALID_BLEND_MODES.has(blendMode)) {
    throw new Error(`Invalid blendMode: ${blendMode}`);
  }
  const node = await getMutableNode(nodeId);
  if (!("blendMode" in node)) {
    throw new Error(`Node does not support blendMode: ${nodeId} (${node.type})`);
  }
  // PASS_THROUGH is only valid for groups/frames; let Figma reject if unsupported
  node.blendMode = blendMode;
  return { id: node.id, name: node.name, blendMode: node.blendMode };
}

// -------------------------------------------------------------------

async function setStrokeColor(params) {
  const {
    nodeId,
    color: { r, g, b, a },
    weight = 1,
  } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  if (!("strokes" in node)) {
    throw new Error(`Node does not support strokes: ${nodeId}`);
  }

  // Create RGBA color
  const rgbColor = {
    r: r !== undefined ? r : 0,
    g: g !== undefined ? g : 0,
    b: b !== undefined ? b : 0,
    a: a !== undefined ? a : 1,
  };

  // Set stroke
  const paintStyle = {
    type: "SOLID",
    color: {
      r: rgbColor.r,
      g: rgbColor.g,
      b: rgbColor.b,
    },
    opacity: rgbColor.a,
  };

  node.strokes = [paintStyle];

  // Set stroke weight if available
  if ("strokeWeight" in node) {
    node.strokeWeight = weight;
  }

  return {
    id: node.id,
    name: node.name,
    strokes: node.strokes,
    strokeWeight: "strokeWeight" in node ? node.strokeWeight : undefined,
  };
}

async function moveNode(params) {
  const { nodeId, x, y } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  if (x === undefined || y === undefined) {
    throw new Error("Missing x or y parameters");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  if (!("x" in node) || !("y" in node)) {
    throw new Error(`Node does not support position: ${nodeId}`);
  }

  node.x = x;
  node.y = y;

  return {
    id: node.id,
    name: node.name,
    x: node.x,
    y: node.y,
  };
}

async function resizeNode(params) {
  const { nodeId, width, height } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  if (width === undefined || height === undefined) {
    throw new Error("Missing width or height parameters");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  if (!("resize" in node)) {
    throw new Error(`Node does not support resizing: ${nodeId}`);
  }

  node.resize(width, height);

  return {
    id: node.id,
    name: node.name,
    width: node.width,
    height: node.height,
  };
}

async function deleteNode(params) {
  const { nodeId } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  // Save node info before deleting
  const nodeInfo = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  node.remove();

  return nodeInfo;
}

async function getStyles() {
  const styles = {
    colors: await figma.getLocalPaintStylesAsync(),
    texts: await figma.getLocalTextStylesAsync(),
    effects: await figma.getLocalEffectStylesAsync(),
    grids: await figma.getLocalGridStylesAsync(),
  };

  return {
    colors: styles.colors.map((style) => ({
      id: style.id,
      name: style.name,
      key: style.key,
      paint: style.paints[0],
    })),
    texts: styles.texts.map((style) => ({
      id: style.id,
      name: style.name,
      key: style.key,
      fontSize: style.fontSize,
      fontName: style.fontName,
    })),
    effects: styles.effects.map((style) => ({
      id: style.id,
      name: style.name,
      key: style.key,
    })),
    grids: styles.grids.map((style) => ({
      id: style.id,
      name: style.name,
      key: style.key,
    })),
  };
}

async function getLocalComponents(params) {
  const commandId = (params && params.commandId) || generateCommandId();
  const pages = figma.root.children;
  const totalPages = pages.length;

  await sendProgressUpdate(
    commandId,
    "get_local_components",
    "started",
    0,
    totalPages,
    0,
    "Starting component scan across " + totalPages + " pages...",
    null
  );

  var allComponents = [];

  for (var i = 0; i < totalPages; i++) {
    var page = pages[i];
    await page.loadAsync();

    var pageComponents = page.findAllWithCriteria({ types: ["COMPONENT"] });

    for (var j = 0; j < pageComponents.length; j++) {
      var component = pageComponents[j];
      allComponents.push({
        id: component.id,
        name: component.name,
        key: "key" in component ? component.key : null,
      });
    }

    var progress = Math.round(((i + 1) / totalPages) * 100);
    await sendProgressUpdate(
      commandId,
      "get_local_components",
      "in_progress",
      progress,
      totalPages,
      i + 1,
      "Scanned " + page.name + ": " + pageComponents.length + " components (total so far: " + allComponents.length + ")",
      null
    );
  }

  await sendProgressUpdate(
    commandId,
    "get_local_components",
    "completed",
    100,
    totalPages,
    totalPages,
    "Found " + allComponents.length + " components across " + totalPages + " pages",
    null
  );

  return {
    count: allComponents.length,
    components: allComponents,
  };
}

// async function getTeamComponents() {
//   try {
//     const teamComponents =
//       await figma.teamLibrary.getAvailableComponentsAsync();

//     return {
//       count: teamComponents.length,
//       components: teamComponents.map((component) => ({
//         key: component.key,
//         name: component.name,
//         description: component.description,
//         libraryName: component.libraryName,
//       })),
//     };
//   } catch (error) {
//     throw new Error(`Error getting team components: ${error.message}`);
//   }
// }

/**
 * Create an instance of a component and place it at (x, y) under parentId, or
 * the current page when parentId is missing/invalid. Shared by
 * create_component_instance and import_library_component (BL-077).
 */
async function placeNewInstance(component, x, y, parentId) {
  const instance = component.createInstance();
  instance.x = typeof x === "number" ? x : 0;
  instance.y = typeof y === "number" ? y : 0;
  if (parentId) {
    const parent = await figma.getNodeByIdAsync(parentId);
    if (parent && "appendChild" in parent) parent.appendChild(instance);
    else figma.currentPage.appendChild(instance);
  } else {
    figma.currentPage.appendChild(instance);
  }
  return instance;
}

async function createComponentInstance(params) {
  const { componentKey, componentId, x = 0, y = 0, parentId } = params || {};

  if (!componentKey && !componentId) {
    throw new Error("Missing componentKey or componentId parameter. Use componentId for local components (from get_local_components), or componentKey for published library components.");
  }

  try {
    let component;

    if (componentId) {
      // Local component: get node directly by ID
      const node = await figma.getNodeByIdAsync(componentId);
      if (!node) {
        throw new Error(`Component node not found with id: ${componentId}`);
      }
      if (node.type !== "COMPONENT") {
        throw new Error(`Node ${componentId} is not a COMPONENT (got type: ${node.type}). Use get_local_components to find valid component IDs.`);
      }
      component = node;
    } else {
      // Published library component: import by key
      component = await figma.importComponentByKeyAsync(componentKey);
    }

    const instance = await placeNewInstance(component, x, y, parentId);

    const mainComponent = await instance.getMainComponentAsync();

    return {
      id: instance.id,
      name: instance.name,
      x: instance.x,
      y: instance.y,
      width: instance.width,
      height: instance.height,
      mainComponentId: mainComponent ? mainComponent.id : undefined,
    };
  } catch (error) {
    throw new Error(`Error creating component instance: ${error.message}`);
  }
}

// ===== BL-073: Team library discovery + import =====

/**
 * List available library variable collections, or — when a libraryCollectionKey
 * is given — the variables inside one collection. Figma's team-library API only
 * exposes variable collections (the old getAvailableComponentsAsync was removed),
 * so component discovery goes through the Figma REST API or existing instances;
 * import_library_component then pulls a component in by key.
 */
async function getTeamLibraries(params) {
  const p = params || {};
  const key = p.libraryCollectionKey;
  if (!figma.teamLibrary) {
    throw new Error("Team library API unavailable — manifest.json permissions must include 'teamlibrary' (and reload the plugin)");
  }

  if (key) {
    const vars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(key);
    const list = [];
    for (let i = 0; i < vars.length; i++) {
      list.push({ key: vars[i].key, name: vars[i].name, resolvedType: vars[i].resolvedType });
    }
    return { libraryCollectionKey: key, count: list.length, variables: list };
  }

  const collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
  const list = [];
  for (let i = 0; i < collections.length; i++) {
    list.push({ key: collections[i].key, name: collections[i].name, libraryName: collections[i].libraryName });
  }
  return { count: list.length, collections: list };
}

/**
 * Import a published component by key, then (by default) create and place an
 * instance. Set createInstance=false to import the main only. For a component
 * SET, import a specific variant's key.
 */
async function importLibraryComponent(params) {
  const p = params || {};
  const componentKey = p.componentKey;
  if (!componentKey) throw new Error("Missing componentKey");
  const createInstance = p.createInstance === false ? false : true;

  let main;
  try {
    main = await figma.importComponentByKeyAsync(componentKey);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    throw new Error(`Could not import component by key "${componentKey}": ${msg}. For a component set, import a specific variant's key.`);
  }

  const result = {
    success: true,
    mainComponentId: main.id,
    mainComponentName: main.name,
    key: main.key,
  };

  if (!createInstance) {
    result.instanceCreated = false;
    return result;
  }

  const instance = await placeNewInstance(main, p.x, p.y, p.parentId);

  result.instanceCreated = true;
  result.instanceId = instance.id;
  result.instanceName = instance.name;
  result.x = instance.x;
  result.y = instance.y;
  result.width = instance.width;
  result.height = instance.height;
  return result;
}

/** Import a published variable by key into the local document. */
async function importLibraryVariable(params) {
  const p = params || {};
  const variableKey = p.variableKey;
  if (!variableKey) throw new Error("Missing variableKey");
  if (!figma.variables || !figma.variables.importVariableByKeyAsync) {
    throw new Error("Variable import API is not available in this context");
  }

  let variable;
  try {
    variable = await figma.variables.importVariableByKeyAsync(variableKey);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    throw new Error(`Could not import variable by key "${variableKey}": ${msg}`);
  }

  return { success: true, variable: summarizeVariable(variable) };
}

// ===== BL-074: Misc tools (mask · layout positioning · slice · notify · measure) =====

/** Toggle a node's mask flag (the node masks its later siblings within the parent). */
async function setMask(params) {
  const p = params || {};
  const nodeId = p.nodeId;
  if (!nodeId) throw new Error("Missing nodeId");
  if (typeof p.isMask !== "boolean") throw new Error("'isMask' must be a boolean");

  const node = await getMutableNode(nodeId);
  if (!("isMask" in node)) {
    throw new Error(`Node does not support masking: ${nodeId} (${node.type})`);
  }
  node.isMask = p.isMask;
  return { id: node.id, name: node.name, isMask: node.isMask };
}

/**
 * Set a node's layoutPositioning (AUTO | ABSOLUTE). ABSOLUTE lets an auto-layout
 * child be positioned freely (ignored by the layout flow). Only meaningful when
 * the parent is an auto-layout frame.
 */
async function setLayoutPositioning(params) {
  const p = params || {};
  const nodeId = p.nodeId;
  const mode = p.mode;
  if (!nodeId) throw new Error("Missing nodeId");
  if (mode !== "AUTO" && mode !== "ABSOLUTE") {
    throw new Error('mode must be "AUTO" or "ABSOLUTE"');
  }

  const node = await getMutableNode(nodeId);
  if (!("layoutPositioning" in node)) {
    throw new Error(`Node does not support layoutPositioning: ${nodeId} (${node.type})`);
  }
  node.layoutPositioning = mode;

  const parent = node.parent;
  const parentIsAutoLayout = parent && "layoutMode" in parent && parent.layoutMode !== "NONE";
  return {
    id: node.id,
    name: node.name,
    layoutPositioning: node.layoutPositioning,
    note: parentIsAutoLayout ? undefined : "parent is not an auto-layout frame; layoutPositioning has no effect until it is",
  };
}

/** Create a slice (export region) at x/y with the given size. */
async function createSlice(params) {
  const p = params || {};
  const x = typeof p.x === "number" ? p.x : 0;
  const y = typeof p.y === "number" ? p.y : 0;
  const width = typeof p.width === "number" ? p.width : 100;
  const height = typeof p.height === "number" ? p.height : 100;
  if (width <= 0 || height <= 0) {
    throw new Error("width and height must be positive");
  }

  const slice = figma.createSlice();
  slice.x = x;
  slice.y = y;
  slice.resize(width, height);
  if (p.name) slice.name = p.name;

  if (p.parentId) {
    const parent = await figma.getNodeByIdAsync(p.parentId);
    if (parent && "appendChild" in parent) parent.appendChild(slice);
    else figma.currentPage.appendChild(slice);
  } else {
    figma.currentPage.appendChild(slice);
  }

  return { id: slice.id, name: slice.name, x: slice.x, y: slice.y, width: slice.width, height: slice.height };
}

/** Show a toast notification in the Figma UI. */
async function figmaNotify(params) {
  const p = params || {};
  const message = p.message;
  if (typeof message !== "string" || message.length === 0) {
    throw new Error("'message' must be a non-empty string");
  }

  const options = {};
  if (p.options && typeof p.options === "object") {
    if (typeof p.options.timeout === "number") options.timeout = p.options.timeout;
    if (p.options.error === true) options.error = true;
  }
  figma.notify(message, options);
  return { success: true, message: message };
}

/**
 * Measure the spatial relationship between two nodes' absolute bounding boxes:
 * center-to-center delta/distance and the edge-to-edge gap on each axis (0 when
 * the boxes overlap on that axis). Equivalent to Figma's Measure tool.
 */
async function measureDistance(params) {
  const p = params || {};
  const nodeIdA = p.nodeIdA;
  const nodeIdB = p.nodeIdB;
  if (!nodeIdA || !nodeIdB) throw new Error("Both nodeIdA and nodeIdB are required");

  const a = await figma.getNodeByIdAsync(nodeIdA);
  if (!a) throw new Error(`Node not found: ${nodeIdA}`);
  const b = await figma.getNodeByIdAsync(nodeIdB);
  if (!b) throw new Error(`Node not found: ${nodeIdB}`);

  if (!("absoluteBoundingBox" in a) || !a.absoluteBoundingBox) {
    throw new Error(`Node has no bounding box: ${nodeIdA} (${a.type})`);
  }
  if (!("absoluteBoundingBox" in b) || !b.absoluteBoundingBox) {
    throw new Error(`Node has no bounding box: ${nodeIdB} (${b.type})`);
  }

  const ba = a.absoluteBoundingBox;
  const bb = b.absoluteBoundingBox;
  const aRight = ba.x + ba.width, aBottom = ba.y + ba.height;
  const bRight = bb.x + bb.width, bBottom = bb.y + bb.height;

  const dx = (bb.x + bb.width / 2) - (ba.x + ba.width / 2);
  const dy = (bb.y + bb.height / 2) - (ba.y + ba.height / 2);
  const centerDistance = Math.sqrt(dx * dx + dy * dy);

  let horizontalGap = 0;
  if (bb.x >= aRight) horizontalGap = bb.x - aRight;
  else if (ba.x >= bRight) horizontalGap = ba.x - bRight;

  let verticalGap = 0;
  if (bb.y >= aBottom) verticalGap = bb.y - aBottom;
  else if (ba.y >= bBottom) verticalGap = ba.y - bBottom;

  return {
    a: { id: a.id, name: a.name, bbox: ba },
    b: { id: b.id, name: b.name, bbox: bb },
    centerDelta: { dx: dx, dy: dy },
    centerDistance: centerDistance,
    horizontalGap: horizontalGap,
    verticalGap: verticalGap,
  };
}

// BL-025: format/constraint extended. PNG/JPG support raster constraints
// (SCALE/WIDTH/HEIGHT), SVG/PDF are vector and ignore constraint type.
const VALID_EXPORT_FORMATS = new Set(["PNG", "JPG", "SVG", "PDF"]);
const VALID_CONSTRAINT_TYPES = new Set(["SCALE", "WIDTH", "HEIGHT"]);

function mimeForExportFormat(format) {
  switch (format) {
    case "PNG": return "image/png";
    case "JPG": return "image/jpeg";
    case "SVG": return "image/svg+xml";
    case "PDF": return "application/pdf";
    default:    return "application/octet-stream";
  }
}

async function exportNodeAsImage(params) {
  const {
    nodeId,
    scale = 1,
    format = "PNG",
    constraint,
    contentsOnly,
    useAbsoluteBounds,
  } = params || {};

  if (!nodeId) throw new Error("Missing nodeId parameter");
  if (!VALID_EXPORT_FORMATS.has(format)) {
    throw new Error("Invalid format: " + format + " (PNG | JPG | SVG | PDF)");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found with ID: " + nodeId);
  if (!("exportAsync" in node)) {
    throw new Error("Node does not support exporting: " + nodeId);
  }

  // Build settings per format. exportAsync's typed unions reject unknown keys
  // for SVG/PDF, so we keep raster-only options out of those branches.
  let settings;
  if (format === "SVG") {
    settings = { format: "SVG" };
  } else if (format === "PDF") {
    settings = { format: "PDF" };
  } else {
    // PNG or JPG
    let resolvedConstraint;
    if (constraint && typeof constraint === "object") {
      if (!VALID_CONSTRAINT_TYPES.has(constraint.type)) {
        throw new Error("Invalid constraint.type: " + constraint.type);
      }
      if (typeof constraint.value !== "number" || constraint.value <= 0) {
        throw new Error("constraint.value must be a positive number");
      }
      resolvedConstraint = { type: constraint.type, value: constraint.value };
    } else {
      resolvedConstraint = { type: "SCALE", value: scale };
    }
    settings = {
      format: format,
      constraint: resolvedConstraint,
    };
    if (typeof contentsOnly === "boolean") settings.contentsOnly = contentsOnly;
    if (typeof useAbsoluteBounds === "boolean") settings.useAbsoluteBounds = useAbsoluteBounds;
  }

  try {
    const bytes = await node.exportAsync(settings);
    const mimeType = mimeForExportFormat(format);
    const base64 = customBase64Encode(bytes);
    return {
      nodeId: nodeId,
      format: format,
      settings: settings,
      byteLength: bytes.length,
      mimeType: mimeType,
      imageData: base64,
    };
  } catch (error) {
    throw new Error("Error exporting node: " + (error.message || String(error)));
  }
}
function customBase64Encode(bytes) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let base64 = "";

  const byteLength = bytes.byteLength;
  const byteRemainder = byteLength % 3;
  const mainLength = byteLength - byteRemainder;

  let a, b, c, d;
  let chunk;

  // Main loop deals with bytes in chunks of 3
  for (let i = 0; i < mainLength; i = i + 3) {
    // Combine the three bytes into a single integer
    chunk = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];

    // Use bitmasks to extract 6-bit segments from the triplet
    a = (chunk & 16515072) >> 18; // 16515072 = (2^6 - 1) << 18
    b = (chunk & 258048) >> 12; // 258048 = (2^6 - 1) << 12
    c = (chunk & 4032) >> 6; // 4032 = (2^6 - 1) << 6
    d = chunk & 63; // 63 = 2^6 - 1

    // Convert the raw binary segments to the appropriate ASCII encoding
    base64 += chars[a] + chars[b] + chars[c] + chars[d];
  }

  // Deal with the remaining bytes and padding
  if (byteRemainder === 1) {
    chunk = bytes[mainLength];

    a = (chunk & 252) >> 2; // 252 = (2^6 - 1) << 2

    // Set the 4 least significant bits to zero
    b = (chunk & 3) << 4; // 3 = 2^2 - 1

    base64 += chars[a] + chars[b] + "==";
  } else if (byteRemainder === 2) {
    chunk = (bytes[mainLength] << 8) | bytes[mainLength + 1];

    a = (chunk & 64512) >> 10; // 64512 = (2^6 - 1) << 10
    b = (chunk & 1008) >> 4; // 1008 = (2^6 - 1) << 4

    // Set the 2 least significant bits to zero
    c = (chunk & 15) << 2; // 15 = 2^4 - 1

    base64 += chars[a] + chars[b] + chars[c] + "=";
  }

  return base64;
}

async function setCornerRadius(params) {
  const { nodeId, radius, corners } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  if (radius === undefined) {
    throw new Error("Missing radius parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  // Check if node supports corner radius
  if (!("cornerRadius" in node)) {
    throw new Error(`Node does not support corner radius: ${nodeId}`);
  }

  // If corners array is provided, set individual corner radii
  if (corners && Array.isArray(corners) && corners.length === 4) {
    if ("topLeftRadius" in node) {
      // Node supports individual corner radii
      if (corners[0]) node.topLeftRadius = radius;
      if (corners[1]) node.topRightRadius = radius;
      if (corners[2]) node.bottomRightRadius = radius;
      if (corners[3]) node.bottomLeftRadius = radius;
    } else {
      // Node only supports uniform corner radius
      node.cornerRadius = radius;
    }
  } else {
    // Set uniform corner radius
    node.cornerRadius = radius;
  }

  return {
    id: node.id,
    name: node.name,
    cornerRadius: "cornerRadius" in node ? node.cornerRadius : undefined,
    topLeftRadius: "topLeftRadius" in node ? node.topLeftRadius : undefined,
    topRightRadius: "topRightRadius" in node ? node.topRightRadius : undefined,
    bottomRightRadius:
      "bottomRightRadius" in node ? node.bottomRightRadius : undefined,
    bottomLeftRadius:
      "bottomLeftRadius" in node ? node.bottomLeftRadius : undefined,
  };
}

async function setTextContent(params) {
  const { nodeId, text } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  if (text === undefined) {
    throw new Error("Missing text parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  if (node.type !== "TEXT") {
    throw new Error(`Node is not a text node: ${nodeId}`);
  }

  try {
    await figma.loadFontAsync(node.fontName);

    await setCharacters(node, text);

    return {
      id: node.id,
      name: node.name,
      characters: node.characters,
      fontName: node.fontName,
    };
  } catch (error) {
    throw new Error(`Error setting text content: ${error.message}`);
  }
}

// Initialize settings on load
(async function initializePlugin() {
  try {
    const savedSettings = await figma.clientStorage.getAsync("settings");
    if (savedSettings) {
      if (savedSettings.serverPort) {
        state.serverPort = savedSettings.serverPort;
      }
    }

    // Send initial settings to UI
    figma.ui.postMessage({
      type: "init-settings",
      settings: {
        serverPort: state.serverPort,
      },
    });
  } catch (error) {
    Log.error("Error loading settings:", error);
  }
})();

function uniqBy(arr, predicate) {
  const cb = typeof predicate === "function" ? predicate : (o) => o[predicate];
  return [
    ...arr
      .reduce((map, item) => {
        const key = item === null || item === undefined ? item : cb(item);

        map.has(key) || map.set(key, item);

        return map;
      }, new Map())
      .values(),
  ];
}
const setCharacters = async (node, characters, options) => {
  const fallbackFont = (options && options.fallbackFont) || {
    family: "Inter",
    style: "Regular",
  };
  try {
    if (node.fontName === figma.mixed) {
      if (options && options.smartStrategy === "prevail") {
        const fontHashTree = {};
        for (let i = 1; i < node.characters.length; i++) {
          const charFont = node.getRangeFontName(i - 1, i);
          const key = `${charFont.family}::${charFont.style}`;
          fontHashTree[key] = fontHashTree[key] ? fontHashTree[key] + 1 : 1;
        }
        const prevailedTreeItem = Object.entries(fontHashTree).sort(
          (a, b) => b[1] - a[1]
        )[0];
        const [family, style] = prevailedTreeItem[0].split("::");
        const prevailedFont = {
          family,
          style,
        };
        await figma.loadFontAsync(prevailedFont);
        node.fontName = prevailedFont;
      } else if (options && options.smartStrategy === "strict") {
        return setCharactersWithStrictMatchFont(node, characters, fallbackFont);
      } else if (options && options.smartStrategy === "experimental") {
        return setCharactersWithSmartMatchFont(node, characters, fallbackFont);
      } else {
        const firstCharFont = node.getRangeFontName(0, 1);
        await figma.loadFontAsync(firstCharFont);
        node.fontName = firstCharFont;
      }
    } else {
      await figma.loadFontAsync({
        family: node.fontName.family,
        style: node.fontName.style,
      });
    }
  } catch (err) {
    Log.warn(
      `Failed to load "${node.fontName["family"]} ${node.fontName["style"]}" font and replaced with fallback "${fallbackFont.family} ${fallbackFont.style}"`,
      err
    );
    await figma.loadFontAsync(fallbackFont);
    node.fontName = fallbackFont;
  }
  try {
    node.characters = characters;
    return true;
  } catch (err) {
    Log.warn(`Failed to set characters. Skipped.`, err);
    return false;
  }
};

const setCharactersWithStrictMatchFont = async (
  node,
  characters,
  fallbackFont
) => {
  const fontHashTree = {};
  for (let i = 1; i < node.characters.length; i++) {
    const startIdx = i - 1;
    const startCharFont = node.getRangeFontName(startIdx, i);
    const startCharFontVal = `${startCharFont.family}::${startCharFont.style}`;
    while (i < node.characters.length) {
      i++;
      const charFont = node.getRangeFontName(i - 1, i);
      if (startCharFontVal !== `${charFont.family}::${charFont.style}`) {
        break;
      }
    }
    fontHashTree[`${startIdx}_${i}`] = startCharFontVal;
  }
  await figma.loadFontAsync(fallbackFont);
  node.fontName = fallbackFont;
  node.characters = characters;
  Log.info(fontHashTree);
  await Promise.all(
    Object.keys(fontHashTree).map(async (range) => {
      Log.info(range, fontHashTree[range]);
      const [start, end] = range.split("_");
      const [family, style] = fontHashTree[range].split("::");
      const matchedFont = {
        family,
        style,
      };
      await figma.loadFontAsync(matchedFont);
      return node.setRangeFontName(Number(start), Number(end), matchedFont);
    })
  );
  return true;
};

const getDelimiterPos = (str, delimiter, startIdx = 0, endIdx = str.length) => {
  const indices = [];
  let temp = startIdx;
  for (let i = startIdx; i < endIdx; i++) {
    if (
      str[i] === delimiter &&
      i + startIdx !== endIdx &&
      temp !== i + startIdx
    ) {
      indices.push([temp, i + startIdx]);
      temp = i + startIdx + 1;
    }
  }
  temp !== endIdx && indices.push([temp, endIdx]);
  return indices.filter(Boolean);
};

const buildLinearOrder = (node) => {
  const fontTree = [];
  const newLinesPos = getDelimiterPos(node.characters, "\n");
  newLinesPos.forEach(([newLinesRangeStart, newLinesRangeEnd], n) => {
    const newLinesRangeFont = node.getRangeFontName(
      newLinesRangeStart,
      newLinesRangeEnd
    );
    if (newLinesRangeFont === figma.mixed) {
      const spacesPos = getDelimiterPos(
        node.characters,
        " ",
        newLinesRangeStart,
        newLinesRangeEnd
      );
      spacesPos.forEach(([spacesRangeStart, spacesRangeEnd], s) => {
        const spacesRangeFont = node.getRangeFontName(
          spacesRangeStart,
          spacesRangeEnd
        );
        if (spacesRangeFont === figma.mixed) {
          const spacesRangeFont = node.getRangeFontName(
            spacesRangeStart,
            spacesRangeStart[0]
          );
          fontTree.push({
            start: spacesRangeStart,
            delimiter: " ",
            family: spacesRangeFont.family,
            style: spacesRangeFont.style,
          });
        } else {
          fontTree.push({
            start: spacesRangeStart,
            delimiter: " ",
            family: spacesRangeFont.family,
            style: spacesRangeFont.style,
          });
        }
      });
    } else {
      fontTree.push({
        start: newLinesRangeStart,
        delimiter: "\n",
        family: newLinesRangeFont.family,
        style: newLinesRangeFont.style,
      });
    }
  });
  return fontTree
    .sort((a, b) => +a.start - +b.start)
    .map(({ family, style, delimiter }) => ({ family, style, delimiter }));
};

const setCharactersWithSmartMatchFont = async (
  node,
  characters,
  fallbackFont
) => {
  const rangeTree = buildLinearOrder(node);
  const fontsToLoad = uniqBy(
    rangeTree,
    ({ family, style }) => `${family}::${style}`
  ).map(({ family, style }) => ({
    family,
    style,
  }));

  await Promise.all([...fontsToLoad, fallbackFont].map(figma.loadFontAsync));

  node.fontName = fallbackFont;
  node.characters = characters;

  let prevPos = 0;
  rangeTree.forEach(({ family, style, delimiter }) => {
    if (prevPos < node.characters.length) {
      const delimeterPos = node.characters.indexOf(delimiter, prevPos);
      const endPos =
        delimeterPos > prevPos ? delimeterPos : node.characters.length;
      const matchedFont = {
        family,
        style,
      };
      node.setRangeFontName(prevPos, endPos, matchedFont);
      prevPos = endPos + 1;
    }
  });
  return true;
};

// Add the cloneNode function implementation
async function cloneNode(params) {
  const { nodeId, x, y } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  // Clone the node
  const clone = node.clone();

  // If x and y are provided, move the clone to that position
  if (x !== undefined && y !== undefined) {
    if (!("x" in clone) || !("y" in clone)) {
      throw new Error(`Cloned node does not support position: ${nodeId}`);
    }
    clone.x = x;
    clone.y = y;
  }

  // Add the clone to the same parent as the original node
  if (node.parent) {
    node.parent.appendChild(clone);
  } else {
    figma.currentPage.appendChild(clone);
  }

  return {
    id: clone.id,
    name: clone.name,
    x: "x" in clone ? clone.x : undefined,
    y: "y" in clone ? clone.y : undefined,
    width: "width" in clone ? clone.width : undefined,
    height: "height" in clone ? clone.height : undefined,
  };
}

async function scanTextNodes(params) {
  Log.info(`Starting to scan text nodes from node ID: ${params.nodeId}`);
  const {
    nodeId,
    useChunking = true,
    chunkSize = 10,
    commandId = generateCommandId(),
  } = params || {};

  const node = await figma.getNodeByIdAsync(nodeId);

  if (!node) {
    Log.error(`Node with ID ${nodeId} not found`);
    // Send error progress update
    sendProgressUpdate(
      commandId,
      "scan_text_nodes",
      "error",
      0,
      0,
      0,
      `Node with ID ${nodeId} not found`,
      { error: `Node not found: ${nodeId}` }
    );
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // If chunking is not enabled, use the original implementation
  if (!useChunking) {
    const textNodes = [];
    try {
      // Send started progress update
      sendProgressUpdate(
        commandId,
        "scan_text_nodes",
        "started",
        0,
        1, // Not known yet how many nodes there are
        0,
        `Starting scan of node "${node.name || nodeId}" without chunking`,
        null
      );

      await findTextNodes(node, [], 0, textNodes);

      // Send completed progress update
      sendProgressUpdate(
        commandId,
        "scan_text_nodes",
        "completed",
        100,
        textNodes.length,
        textNodes.length,
        `Scan complete. Found ${textNodes.length} text nodes.`,
        { textNodes }
      );

      return {
        success: true,
        message: `Scanned ${textNodes.length} text nodes.`,
        count: textNodes.length,
        textNodes: textNodes,
        commandId,
      };
    } catch (error) {
      Log.error("Error scanning text nodes:", error);

      // Send error progress update
      sendProgressUpdate(
        commandId,
        "scan_text_nodes",
        "error",
        0,
        0,
        0,
        `Error scanning text nodes: ${error.message}`,
        { error: error.message }
      );

      throw new Error(`Error scanning text nodes: ${error.message}`);
    }
  }

  // Chunked implementation
  Log.info(`Using chunked scanning with chunk size: ${chunkSize}`);

  // First, collect all nodes to process (without processing them yet)
  const nodesToProcess = [];

  // Send started progress update
  sendProgressUpdate(
    commandId,
    "scan_text_nodes",
    "started",
    0,
    0, // Not known yet how many nodes there are
    0,
    `Starting chunked scan of node "${node.name || nodeId}"`,
    { chunkSize }
  );

  await collectNodesToProcess(node, [], 0, nodesToProcess);

  const totalNodes = nodesToProcess.length;
  Log.info(`Found ${totalNodes} total nodes to process`);

  // Calculate number of chunks needed
  const totalChunks = Math.ceil(totalNodes / chunkSize);
  Log.info(`Will process in ${totalChunks} chunks`);

  // Send update after node collection
  sendProgressUpdate(
    commandId,
    "scan_text_nodes",
    "in_progress",
    5, // 5% progress for collection phase
    totalNodes,
    0,
    `Found ${totalNodes} nodes to scan. Will process in ${totalChunks} chunks.`,
    {
      totalNodes,
      totalChunks,
      chunkSize,
    }
  );

  // Process nodes in chunks
  const allTextNodes = [];
  let processedNodes = 0;
  let chunksProcessed = 0;

  for (let i = 0; i < totalNodes; i += chunkSize) {
    // Best-effort cancellation (CONTRACT item D): stop between chunks and
    // return whatever we have collected so far.
    if (isCancelled(commandId)) break;

    const chunkEnd = Math.min(i + chunkSize, totalNodes);
    Log.info(
      `Processing chunk ${chunksProcessed + 1}/${totalChunks} (nodes ${i} to ${chunkEnd - 1
      })`
    );

    // Send update before processing chunk
    sendProgressUpdate(
      commandId,
      "scan_text_nodes",
      "in_progress",
      Math.round(5 + (chunksProcessed / totalChunks) * 90), // 5-95% for processing
      totalNodes,
      processedNodes,
      `Processing chunk ${chunksProcessed + 1}/${totalChunks}`,
      {
        currentChunk: chunksProcessed + 1,
        totalChunks,
        textNodesFound: allTextNodes.length,
      }
    );

    const chunkNodes = nodesToProcess.slice(i, chunkEnd);
    const chunkTextNodes = [];

    // Process each node in this chunk
    for (const nodeInfo of chunkNodes) {
      if (nodeInfo.node.type === "TEXT") {
        try {
          const textNodeInfo = await processTextNode(
            nodeInfo.node,
            nodeInfo.parentPath,
            nodeInfo.depth
          );
          if (textNodeInfo) {
            chunkTextNodes.push(textNodeInfo);
          }
        } catch (error) {
          Log.error(`Error processing text node: ${error.message}`);
          // Continue with other nodes
        }
      }

      // Brief delay to allow UI updates and prevent freezing
      await delay(5);
    }

    // Add results from this chunk
    allTextNodes.push(...chunkTextNodes);
    processedNodes += chunkNodes.length;
    chunksProcessed++;

    // Send update after processing chunk
    sendProgressUpdate(
      commandId,
      "scan_text_nodes",
      "in_progress",
      Math.round(5 + (chunksProcessed / totalChunks) * 90), // 5-95% for processing
      totalNodes,
      processedNodes,
      `Processed chunk ${chunksProcessed}/${totalChunks}. Found ${allTextNodes.length} text nodes so far.`,
      {
        currentChunk: chunksProcessed,
        totalChunks,
        processedNodes,
        textNodesFound: allTextNodes.length,
        chunkResult: chunkTextNodes,
      }
    );

    // Small delay between chunks to prevent UI freezing
    if (i + chunkSize < totalNodes) {
      await delay(50);
    }
  }

  // Send completed progress update
  sendProgressUpdate(
    commandId,
    "scan_text_nodes",
    "completed",
    100,
    totalNodes,
    processedNodes,
    `Scan complete. Found ${allTextNodes.length} text nodes.`,
    {
      textNodes: allTextNodes,
      processedNodes,
      chunks: chunksProcessed,
    }
  );

  return {
    success: true,
    message: `Chunked scan complete. Found ${allTextNodes.length} text nodes.`,
    totalNodes: allTextNodes.length,
    processedNodes: processedNodes,
    chunks: chunksProcessed,
    textNodes: allTextNodes,
    commandId,
  };
}

// Helper function to collect all nodes that need to be processed
async function collectNodesToProcess(
  node,
  parentPath = [],
  depth = 0,
  nodesToProcess = []
) {
  // Skip invisible nodes
  if (node.visible === false) return;

  // Get the path to this node
  const nodePath = [...parentPath, node.name || `Unnamed ${node.type}`];

  // Add this node to the processing list
  nodesToProcess.push({
    node: node,
    parentPath: nodePath,
    depth: depth,
  });

  // Recursively add children
  if ("children" in node) {
    for (const child of node.children) {
      await collectNodesToProcess(child, nodePath, depth + 1, nodesToProcess);
    }
  }
}

// Process a single text node
async function processTextNode(node, parentPath, depth) {
  if (node.type !== "TEXT") return null;

  try {
    // Safely extract font information
    let fontFamily = "";
    let fontStyle = "";

    if (node.fontName) {
      if (typeof node.fontName === "object") {
        if ("family" in node.fontName) fontFamily = node.fontName.family;
        if ("style" in node.fontName) fontStyle = node.fontName.style;
      }
    }

    // Create a safe representation of the text node
    const safeTextNode = {
      id: node.id,
      name: node.name || "Text",
      type: node.type,
      characters: node.characters,
      fontSize: typeof node.fontSize === "number" ? node.fontSize : 0,
      fontFamily: fontFamily,
      fontStyle: fontStyle,
      x: typeof node.x === "number" ? node.x : 0,
      y: typeof node.y === "number" ? node.y : 0,
      width: typeof node.width === "number" ? node.width : 0,
      height: typeof node.height === "number" ? node.height : 0,
      path: parentPath.join(" > "),
      depth: depth,
    };

    // Highlight the node briefly (optional visual feedback)
    try {
      const originalFills = JSON.parse(JSON.stringify(node.fills));
      node.fills = [
        {
          type: "SOLID",
          color: { r: 1, g: 0.5, b: 0 },
          opacity: 0.3,
        },
      ];

      // Brief delay for the highlight to be visible
      await delay(100);

      try {
        node.fills = originalFills;
      } catch (err) {
        Log.error("Error resetting fills:", err);
      }
    } catch (highlightErr) {
      Log.error("Error highlighting text node:", highlightErr);
      // Continue anyway, highlighting is just visual feedback
    }

    return safeTextNode;
  } catch (nodeErr) {
    Log.error("Error processing text node:", nodeErr);
    return null;
  }
}

// A delay function that returns a promise
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Keep the original findTextNodes for backward compatibility
async function findTextNodes(node, parentPath = [], depth = 0, textNodes = []) {
  // Skip invisible nodes
  if (node.visible === false) return;

  // Get the path to this node including its name
  const nodePath = [...parentPath, node.name || `Unnamed ${node.type}`];

  if (node.type === "TEXT") {
    try {
      // Safely extract font information to avoid Symbol serialization issues
      let fontFamily = "";
      let fontStyle = "";

      if (node.fontName) {
        if (typeof node.fontName === "object") {
          if ("family" in node.fontName) fontFamily = node.fontName.family;
          if ("style" in node.fontName) fontStyle = node.fontName.style;
        }
      }

      // Create a safe representation of the text node with only serializable properties
      const safeTextNode = {
        id: node.id,
        name: node.name || "Text",
        type: node.type,
        characters: node.characters,
        fontSize: typeof node.fontSize === "number" ? node.fontSize : 0,
        fontFamily: fontFamily,
        fontStyle: fontStyle,
        x: typeof node.x === "number" ? node.x : 0,
        y: typeof node.y === "number" ? node.y : 0,
        width: typeof node.width === "number" ? node.width : 0,
        height: typeof node.height === "number" ? node.height : 0,
        path: nodePath.join(" > "),
        depth: depth,
      };

      // Only highlight the node if it's not being done via API
      try {
        // Safe way to create a temporary highlight without causing serialization issues
        const originalFills = JSON.parse(JSON.stringify(node.fills));
        node.fills = [
          {
            type: "SOLID",
            color: { r: 1, g: 0.5, b: 0 },
            opacity: 0.3,
          },
        ];

        // Promise-based delay instead of setTimeout
        await delay(500);

        try {
          node.fills = originalFills;
        } catch (err) {
          Log.error("Error resetting fills:", err);
        }
      } catch (highlightErr) {
        Log.error("Error highlighting text node:", highlightErr);
        // Continue anyway, highlighting is just visual feedback
      }

      textNodes.push(safeTextNode);
    } catch (nodeErr) {
      Log.error("Error processing text node:", nodeErr);
      // Skip this node but continue with others
    }
  }

  // Recursively process children of container nodes
  if ("children" in node) {
    for (const child of node.children) {
      await findTextNodes(child, nodePath, depth + 1, textNodes);
    }
  }
}

// Replace text in a specific node
async function setMultipleTextContents(params) {
  const { nodeId, text } = params || {};
  const commandId = params.commandId || generateCommandId();

  if (!nodeId || !text || !Array.isArray(text)) {
    const errorMsg = "Missing required parameters: nodeId and text array";

    // Send error progress update
    sendProgressUpdate(
      commandId,
      "set_multiple_text_contents",
      "error",
      0,
      0,
      0,
      errorMsg,
      { error: errorMsg }
    );

    throw new Error(errorMsg);
  }

  Log.info(
    `Starting text replacement for node: ${nodeId} with ${text.length} text replacements`
  );

  // Send started progress update
  sendProgressUpdate(
    commandId,
    "set_multiple_text_contents",
    "started",
    0,
    text.length,
    0,
    `Starting text replacement for ${text.length} nodes`,
    { totalReplacements: text.length }
  );

  // Define the results array and counters
  const results = [];
  let successCount = 0;
  let failureCount = 0;

  // Split text replacements into chunks of 5
  const CHUNK_SIZE = 5;
  const chunks = [];

  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    chunks.push(text.slice(i, i + CHUNK_SIZE));
  }

  Log.info(`Split ${text.length} replacements into ${chunks.length} chunks`);

  // Send chunking info update
  sendProgressUpdate(
    commandId,
    "set_multiple_text_contents",
    "in_progress",
    5, // 5% progress for planning phase
    text.length,
    0,
    `Preparing to replace text in ${text.length} nodes using ${chunks.length} chunks`,
    {
      totalReplacements: text.length,
      chunks: chunks.length,
      chunkSize: CHUNK_SIZE,
    }
  );

  // Process each chunk sequentially
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    // Best-effort cancellation (CONTRACT item D): stop between chunks and
    // return the partial results gathered so far.
    if (isCancelled(commandId)) break;

    const chunk = chunks[chunkIndex];
    Log.info(
      `Processing chunk ${chunkIndex + 1}/${chunks.length} with ${chunk.length
      } replacements`
    );

    // Send chunk processing start update
    sendProgressUpdate(
      commandId,
      "set_multiple_text_contents",
      "in_progress",
      Math.round(5 + (chunkIndex / chunks.length) * 90), // 5-95% for processing
      text.length,
      successCount + failureCount,
      `Processing text replacements chunk ${chunkIndex + 1}/${chunks.length}`,
      {
        currentChunk: chunkIndex + 1,
        totalChunks: chunks.length,
        successCount,
        failureCount,
      }
    );

    // Process replacements within a chunk in parallel
    const chunkPromises = chunk.map(async (replacement) => {
      if (!replacement.nodeId || replacement.text === undefined) {
        Log.error(`Missing nodeId or text for replacement`);
        return {
          success: false,
          nodeId: replacement.nodeId || "unknown",
          error: "Missing nodeId or text in replacement entry",
        };
      }

      try {
        Log.info(
          `Attempting to replace text in node: ${replacement.nodeId}`
        );

        // Get the text node to update (just to check it exists and get original text)
        const textNode = await figma.getNodeByIdAsync(replacement.nodeId);

        if (!textNode) {
          Log.error(`Text node not found: ${replacement.nodeId}`);
          return {
            success: false,
            nodeId: replacement.nodeId,
            error: `Node not found: ${replacement.nodeId}`,
          };
        }

        if (textNode.type !== "TEXT") {
          Log.error(
            `Node is not a text node: ${replacement.nodeId} (type: ${textNode.type})`
          );
          return {
            success: false,
            nodeId: replacement.nodeId,
            error: `Node is not a text node: ${replacement.nodeId} (type: ${textNode.type})`,
          };
        }

        // Save original text for the result
        const originalText = textNode.characters;
        Log.info(`Original text: "${originalText}"`);
        Log.info(`Will translate to: "${replacement.text}"`);

        // Highlight the node before changing text
        let originalFills;
        try {
          // Save original fills for restoration later
          originalFills = JSON.parse(JSON.stringify(textNode.fills));
          // Apply highlight color (orange with 30% opacity)
          textNode.fills = [
            {
              type: "SOLID",
              color: { r: 1, g: 0.5, b: 0 },
              opacity: 0.3,
            },
          ];
        } catch (highlightErr) {
          Log.error(
            `Error highlighting text node: ${highlightErr.message}`
          );
          // Continue anyway, highlighting is just visual feedback
        }

        // Use the existing setTextContent function to handle font loading and text setting
        await setTextContent({
          nodeId: replacement.nodeId,
          text: replacement.text,
        });

        // Keep highlight for a moment after text change, then restore original fills
        if (originalFills) {
          try {
            // Use delay function for consistent timing
            await delay(500);
            textNode.fills = originalFills;
          } catch (restoreErr) {
            Log.error(`Error restoring fills: ${restoreErr.message}`);
          }
        }

        Log.info(
          `Successfully replaced text in node: ${replacement.nodeId}`
        );
        return {
          success: true,
          nodeId: replacement.nodeId,
          originalText: originalText,
          translatedText: replacement.text,
        };
      } catch (error) {
        Log.error(
          `Error replacing text in node ${replacement.nodeId}: ${error.message}`
        );
        return {
          success: false,
          nodeId: replacement.nodeId,
          error: `Error applying replacement: ${error.message}`,
        };
      }
    });

    // Wait for all replacements in this chunk to complete
    const chunkResults = await Promise.all(chunkPromises);

    // Process results for this chunk
    chunkResults.forEach((result) => {
      if (result.success) {
        successCount++;
      } else {
        failureCount++;
      }
      results.push(result);
    });

    // Send chunk processing complete update with partial results
    sendProgressUpdate(
      commandId,
      "set_multiple_text_contents",
      "in_progress",
      Math.round(5 + ((chunkIndex + 1) / chunks.length) * 90), // 5-95% for processing
      text.length,
      successCount + failureCount,
      `Completed chunk ${chunkIndex + 1}/${chunks.length
      }. ${successCount} successful, ${failureCount} failed so far.`,
      {
        currentChunk: chunkIndex + 1,
        totalChunks: chunks.length,
        successCount,
        failureCount,
        chunkResults: chunkResults,
      }
    );

    // Add a small delay between chunks to avoid overloading Figma
    if (chunkIndex < chunks.length - 1) {
      Log.info("Pausing between chunks to avoid overloading Figma...");
      await delay(1000); // 1 second delay between chunks
    }
  }

  Log.info(
    `Replacement complete: ${successCount} successful, ${failureCount} failed`
  );

  // Send completed progress update
  sendProgressUpdate(
    commandId,
    "set_multiple_text_contents",
    "completed",
    100,
    text.length,
    successCount + failureCount,
    `Text replacement complete: ${successCount} successful, ${failureCount} failed`,
    {
      totalReplacements: text.length,
      replacementsApplied: successCount,
      replacementsFailed: failureCount,
      completedInChunks: chunks.length,
      results: results,
    }
  );

  return {
    success: successCount > 0,
    nodeId: nodeId,
    replacementsApplied: successCount,
    replacementsFailed: failureCount,
    totalReplacements: text.length,
    results: results,
    completedInChunks: chunks.length,
    commandId,
  };
}

// Function to generate simple UUIDs for command IDs
function generateCommandId() {
  return (
    "cmd_" +
    Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 15)
  );
}

// ---- Cancellation (CONTRACT item D, plugin half) ------------------
// The server fires a best-effort "cancel_command" (with params.cancelId set
// to a timed-out request's id) when it gives up waiting. Long/chunked
// handlers check isCancelled(commandId) between chunks/items and stop early.
var cancelledCommandIds = {};
function isCancelled(id) { return !!id && cancelledCommandIds[id] === true; }
function markCancelled(id) { if (id) cancelledCommandIds[id] = true; }
function clearCancelled(id) { if (id) delete cancelledCommandIds[id]; }

// ---- Batch commands (server registers the tool; handler lives here) ----
// Deep-walk params replacing any "$ref:<name>" string with the id captured
// earlier in the batch (entry.ref -> created node id). ES-safe: no spread,
// no ??, no Object.fromEntries — plain for-loops and Object.assign only.
function resolveRefs(value, refs) {
  if (typeof value === "string") {
    if (value.indexOf("$ref:") === 0) {
      var k = value.slice(5);
      return refs[k] != null ? refs[k] : value;
    }
    return value;
  }
  if (Array.isArray(value)) {
    var arr = [];
    for (var i = 0; i < value.length; i++) {
      arr.push(resolveRefs(value[i], refs));
    }
    return arr;
  }
  if (value && typeof value === "object") {
    var out = {};
    for (var kk in value) {
      if (Object.prototype.hasOwnProperty.call(value, kk)) {
        out[kk] = resolveRefs(value[kk], refs);
      }
    }
    return out;
  }
  return value;
}

// Run a list of commands sequentially inside a single queue entry. Each op may
// name a "ref"; its created node id is stored so later ops can reference it via
// "$ref:<name>" in any param value. handleCommand is called directly (NOT via
// the serialization queue) so the batch never deadlocks on itself.
async function executeBatch(params) {
  var cmds = (params && params.commands) || [];
  var stopOnError = !!(params && params.stopOnError);
  var commandId = (params && params.commandId) || generateCommandId();
  var refs = {};       // ref-name -> created node id
  var results = [];    // per-op {index, success, result|error, ref?}
  for (var i = 0; i < cmds.length; i++) {
    // Best-effort cancellation (CONTRACT item D): stop between ops.
    if (isCancelled(commandId)) break;
    var entry = cmds[i] || {};
    if (entry.command === "batch_commands") {
      results.push({ index: i, success: false, error: "nested batch_commands not allowed" });
      continue;
    }
    try {
      var resolvedParams = resolveRefs(entry.params || {}, refs);
      // Stamp the batch's commandId so a long/chunked sub-op (scan_text_nodes,
      // set_multiple_text_contents, …) emits progress tagged with the batch's
      // server request id, re-arming the batch's inactivity timer. Without this
      // the sub-op falls back to a random generateCommandId() the server can't
      // match, and a single slow inner op could time the whole batch out.
      resolvedParams = Object.assign({}, resolvedParams, { commandId: commandId });
      var result = await handleCommand(entry.command, resolvedParams);
      if (entry.ref && result && result.id) refs[entry.ref] = result.id;
      results.push({ index: i, success: true, ref: entry.ref, result: result });
    } catch (e) {
      results.push({ index: i, success: false, error: (e && e.message) || String(e) });
      if (stopOnError) break;
    }
    if (i % 5 === 4 || i === cmds.length - 1) {
      await sendProgressUpdate(
        commandId,
        "batch_commands",
        "in_progress",
        Math.round(((i + 1) / cmds.length) * 100),
        cmds.length,
        i + 1,
        "Executed " + (i + 1) + "/" + cmds.length,
        null
      );
    }
  }
  clearCancelled(commandId);
  return { opsTotal: cmds.length, refs: refs, results: results };
}

async function getAnnotations(params) {
  try {
    const { nodeId, includeCategories = true } = params;

    // Get categories first if needed
    let categoriesMap = {};
    if (includeCategories) {
      const categories = await figma.annotations.getAnnotationCategoriesAsync();
      categoriesMap = categories.reduce((map, category) => {
        map[category.id] = {
          id: category.id,
          label: category.label,
          color: category.color,
          isPreset: category.isPreset,
        };
        return map;
      }, {});
    }

    if (nodeId) {
      // Get annotations for a specific node
      const node = await figma.getNodeByIdAsync(nodeId);
      if (!node) {
        throw new Error(`Node not found: ${nodeId}`);
      }

      if (!("annotations" in node)) {
        throw new Error(`Node type ${node.type} does not support annotations`);
      }

      // Collect annotations from this node and all its descendants
      const mergedAnnotations = [];
      const collect = async (n) => {
        if ("annotations" in n && n.annotations && n.annotations.length > 0) {
          for (const a of n.annotations) {
            mergedAnnotations.push({ nodeId: n.id, annotation: a });
          }
        }
        if ("children" in n) {
          for (const child of n.children) {
            await collect(child);
          }
        }
      };
      await collect(node);

      const result = {
        nodeId: node.id,
        name: node.name,
        annotations: mergedAnnotations,
      };

      if (includeCategories) {
        result.categories = Object.values(categoriesMap);
      }

      return result;
    } else {
      // Get all annotations in the current page
      const annotations = [];
      const processNode = async (node) => {
        if (
          "annotations" in node &&
          node.annotations &&
          node.annotations.length > 0
        ) {
          annotations.push({
            nodeId: node.id,
            name: node.name,
            annotations: node.annotations,
          });
        }
        if ("children" in node) {
          for (const child of node.children) {
            await processNode(child);
          }
        }
      };

      // Start from current page
      await processNode(figma.currentPage);

      const result = {
        annotatedNodes: annotations,
      };

      if (includeCategories) {
        result.categories = Object.values(categoriesMap);
      }

      return result;
    }
  } catch (error) {
    Log.error("Error in getAnnotations:", error);
    throw error;
  }
}

async function setAnnotation(params) {
  try {
    Log.info("=== setAnnotation Debug Start ===");
    Log.info("Input params:", JSON.stringify(params, null, 2));

    const { nodeId, annotationId, labelMarkdown, categoryId, properties } =
      params;

    // Validate required parameters
    if (!nodeId) {
      Log.error("Validation failed: Missing nodeId");
      return { success: false, error: "Missing nodeId" };
    }

    if (!labelMarkdown) {
      Log.error("Validation failed: Missing labelMarkdown");
      return { success: false, error: "Missing labelMarkdown" };
    }

    Log.info("Attempting to get node:", nodeId);
    // Get and validate node
    const node = await figma.getNodeByIdAsync(nodeId);
    Log.info("Node lookup result:", {
      id: nodeId,
      found: !!node,
      type: node ? node.type : undefined,
      name: node ? node.name : undefined,
      hasAnnotations: node ? "annotations" in node : false,
    });

    if (!node) {
      Log.error("Node lookup failed:", nodeId);
      return { success: false, error: `Node not found: ${nodeId}` };
    }

    // Validate node supports annotations
    if (!("annotations" in node)) {
      Log.error("Node annotation support check failed:", {
        nodeType: node.type,
        nodeId: node.id,
      });
      return {
        success: false,
        error: `Node type ${node.type} does not support annotations`,
      };
    }

    // Create the annotation object
    const newAnnotation = {
      labelMarkdown,
    };

    // Validate and add categoryId if provided
    if (categoryId) {
      Log.info("Adding categoryId to annotation:", categoryId);
      newAnnotation.categoryId = categoryId;
    }

    // Validate and add properties if provided
    if (properties && Array.isArray(properties) && properties.length > 0) {
      Log.info(
        "Adding properties to annotation:",
        JSON.stringify(properties, null, 2)
      );
      newAnnotation.properties = properties;
    }

    // Log current annotations before update
    Log.info("Current node annotations:", node.annotations);

    // Overwrite annotations
    Log.info(
      "Setting new annotation:",
      JSON.stringify(newAnnotation, null, 2)
    );
    node.annotations = [newAnnotation];

    // Verify the update
    Log.info("Updated node annotations:", node.annotations);
    Log.info("=== setAnnotation Debug End ===");

    return {
      success: true,
      nodeId: node.id,
      name: node.name,
      annotations: node.annotations,
    };
  } catch (error) {
    Log.error("=== setAnnotation Error ===");
    Log.error("Error details:", {
      message: error.message,
      stack: error.stack,
      params: JSON.stringify(params, null, 2),
    });
    return { success: false, error: error.message };
  }
}

/**
 * Scan for nodes with specific types within a node
 * @param {Object} params - Parameters object
 * @param {string} params.nodeId - ID of the node to scan within
 * @param {Array<string>} params.types - Array of node types to find (e.g. ['COMPONENT', 'FRAME'])
 * @returns {Object} - Object containing found nodes
 */
async function scanNodesByTypes(params) {
  Log.info(`Starting to scan nodes by types from node ID: ${params.nodeId}`);
  const { nodeId, types = [] } = params || {};

  if (!types || types.length === 0) {
    throw new Error("No types specified to search for");
  }

  const node = await figma.getNodeByIdAsync(nodeId);

  if (!node) {
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // Simple implementation without chunking
  const matchingNodes = [];

  // Send a single progress update to notify start
  const commandId = (params && params.commandId) || generateCommandId();
  sendProgressUpdate(
    commandId,
    "scan_nodes_by_types",
    "started",
    0,
    1,
    0,
    `Starting scan of node "${node.name || nodeId}" for types: ${types.join(
      ", "
    )}`,
    null
  );

  // Recursively find nodes with specified types.
  // visited Set guards against pathological trees that could cause re-entry
  // (e.g. instance↔main swap, future API changes that expose cycles).
  await findNodesByTypes(node, types, matchingNodes, new Set(), commandId);

  // Send completion update
  sendProgressUpdate(
    commandId,
    "scan_nodes_by_types",
    "completed",
    100,
    matchingNodes.length,
    matchingNodes.length,
    `Scan complete. Found ${matchingNodes.length} matching nodes.`,
    { matchingNodes }
  );

  return {
    success: true,
    message: `Found ${matchingNodes.length} matching nodes.`,
    count: matchingNodes.length,
    matchingNodes: matchingNodes,
    searchedTypes: types,
  };
}

/**
 * Helper function to recursively find nodes with specific types
 * @param {SceneNode} node - The root node to start searching from
 * @param {Array<string>} types - Array of node types to find
 * @param {Array} matchingNodes - Array to store found nodes
 * @param {Set<string>} visited - Visited node IDs (cycle guard)
 */
async function findNodesByTypes(node, types, matchingNodes = [], visited = new Set(), commandId) {
  // Best-effort cancellation (CONTRACT item D): stop descending once cancelled.
  if (isCancelled(commandId)) return;

  // Skip invisible nodes
  if (node.visible === false) return;

  // Cycle guard: if we've already walked this node id, stop.
  // Prevents infinite recursion if any container ever exposes a back-edge.
  if (node.id && visited.has(node.id)) return;
  if (node.id) visited.add(node.id);

  // Check if this node is one of the specified types
  if (types.includes(node.type)) {
    // Create a minimal representation with just ID, type and bbox
    matchingNodes.push({
      id: node.id,
      name: node.name || `Unnamed ${node.type}`,
      type: node.type,
      // Basic bounding box info
      bbox: {
        x: typeof node.x === "number" ? node.x : 0,
        y: typeof node.y === "number" ? node.y : 0,
        width: typeof node.width === "number" ? node.width : 0,
        height: typeof node.height === "number" ? node.height : 0,
      },
    });
  }

  // Recursively process children of container nodes
  if ("children" in node) {
    for (const child of node.children) {
      if (isCancelled(commandId)) break;
      await findNodesByTypes(child, types, matchingNodes, visited, commandId);
    }
  }
}

// ===== BL-069: Node search by name / criteria =====

/**
 * Build a name-matching predicate.
 * @param {string|undefined} namePattern
 * @param {boolean} useRegex - treat namePattern as a regular expression
 * @returns {(name: string) => boolean}
 */
function makeNameMatcher(namePattern, useRegex) {
  if (namePattern == null || namePattern === "") {
    return function () { return true; };
  }
  if (useRegex) {
    const re = new RegExp(namePattern);
    return function (name) { return re.test(name || ""); };
  }
  const needle = namePattern.toLowerCase();
  return function (name) {
    return (name || "").toLowerCase().indexOf(needle) !== -1;
  };
}

/**
 * Walk the parent chain up to (but excluding) the search root, checking the
 * `visible` flag. Returns false if the node or any ancestor below the root is
 * hidden — mirrors scan_nodes_by_types' "skip hidden subtrees" behavior.
 * @param {SceneNode} node
 * @param {string} rootId
 */
function isEffectivelyVisible(node, rootId) {
  let cur = node;
  while (cur && cur.id !== rootId) {
    if (cur.visible === false) return false;
    cur = cur.parent;
  }
  return true;
}

/** Minimal node representation: id, name, type, bbox. */
function nodeSummary(node) {
  return {
    id: node.id,
    name: node.name || `Unnamed ${node.type}`,
    type: node.type,
    bbox: {
      x: typeof node.x === "number" ? node.x : 0,
      y: typeof node.y === "number" ? node.y : 0,
      width: typeof node.width === "number" ? node.width : 0,
      height: typeof node.height === "number" ? node.height : 0,
    },
  };
}

/**
 * Resolve the search root: a node by id, or the current page when no id given.
 * @param {string|undefined} rootId
 */
async function resolveSearchRoot(rootId) {
  if (rootId) {
    const node = await figma.getNodeByIdAsync(rootId);
    if (!node) throw new Error(`Node with ID ${rootId} not found`);
    return node;
  }
  return figma.currentPage;
}

async function findNodesByCriteria(params) {
  const p = params || {};
  const rootId = p.rootId;
  const types = p.types;
  const namePattern = p.namePattern;
  const useRegex = p.regex === true;
  const includeHidden = p.includeHidden === true;

  const hasTypes = types && types.length > 0;
  const hasName = namePattern != null && namePattern !== "";
  if (!hasTypes && !hasName) {
    throw new Error("Specify at least one of `types` or `namePattern`");
  }

  Log.info(`find_nodes_by_criteria: root=${rootId || "currentPage"}`);
  const root = await resolveSearchRoot(rootId);

  if (!("findAll" in root)) {
    return {
      success: true,
      message: `Node "${root.name || root.id}" has no children to search`,
      count: 0,
      matchingNodes: [],
      rootId: root.id,
      searchedTypes: hasTypes ? types : null,
    };
  }

  let matchName;
  try {
    matchName = makeNameMatcher(namePattern, useRegex);
  } catch (e) {
    throw new Error(`Invalid regex pattern: ${e && e.message ? e.message : String(e)}`);
  }

  // findAllWithCriteria is a fast native type filter; findAll walks everything
  // when no type constraint is given. Name + visibility filtered in JS.
  const candidates = hasTypes
    ? root.findAllWithCriteria({ types: types })
    : root.findAll(function () { return true; });

  const matchingNodes = [];
  for (let i = 0; i < candidates.length; i++) {
    const n = candidates[i];
    if (!matchName(n.name)) continue;
    if (!includeHidden && !isEffectivelyVisible(n, root.id)) continue;
    matchingNodes.push(nodeSummary(n));
  }

  return {
    success: true,
    message: `Found ${matchingNodes.length} matching nodes.`,
    count: matchingNodes.length,
    matchingNodes: matchingNodes,
    rootId: root.id,
    searchedTypes: hasTypes ? types : null,
  };
}

async function findNodeByName(params) {
  const p = params || {};
  const rootId = p.rootId;
  const name = p.name;
  const exact = p.exact === true;

  if (name == null || name === "") {
    throw new Error("`name` is required");
  }

  Log.info(`find_node_by_name: "${name}" root=${rootId || "currentPage"}`);
  const root = await resolveSearchRoot(rootId);

  if (!("findOne" in root)) {
    return { found: false, rootId: root.id };
  }

  // findOne stops at the first match, so it is cheaper than findAll + [0].
  const needle = exact ? name : name.toLowerCase();
  const found = root.findOne(function (n) {
    if (exact) return n.name === name;
    return (n.name || "").toLowerCase().indexOf(needle) !== -1;
  });

  if (!found) {
    return { found: false, rootId: root.id };
  }
  return { found: true, rootId: root.id, node: nodeSummary(found) };
}

// ===== BL-072: Font availability =====

/**
 * List available fonts, grouped by family. The host font catalog (Figma-bundled
 * Google Fonts) is 1000+ families, so we group by family AND cap the number of
 * families returned (default 50) to keep the response — and the relay payload —
 * bounded. `truncated` signals there are more; narrow with searchPattern or
 * raise `limit`. Optional searchPattern filters families by case-insensitive
 * substring.
 */
async function listAvailableFonts(params) {
  const p = params || {};
  const searchPattern = p.searchPattern;
  const hasPattern = searchPattern != null && searchPattern !== "";
  const needle = hasPattern ? String(searchPattern).toLowerCase() : "";
  const limit = typeof p.limit === "number" && p.limit > 0 ? Math.floor(p.limit) : 50;

  Log.info(`list_available_fonts: pattern=${hasPattern ? searchPattern : "(all)"} limit=${limit}`);

  const available = await figma.listAvailableFontsAsync();

  // Null-proto map so font family names that collide with Object.prototype keys
  // (e.g. "constructor", "toString") are handled correctly.
  const byFamily = Object.create(null);
  const order = [];
  let totalFonts = 0;

  for (let i = 0; i < available.length; i++) {
    const entry = available[i];
    const fn = entry && entry.fontName;
    if (!fn) continue;
    const family = fn.family;
    const style = fn.style;
    if (hasPattern && (family || "").toLowerCase().indexOf(needle) === -1) continue;

    if (!(family in byFamily)) {
      byFamily[family] = [];
      order.push(family);
    }
    byFamily[family].push(style);
    totalFonts++;
  }

  const totalFamilies = order.length;
  const truncated = totalFamilies > limit;
  const shown = truncated ? order.slice(0, limit) : order;

  const fonts = [];
  for (let i = 0; i < shown.length; i++) {
    const family = shown[i];
    fonts.push({ family: family, styles: byFamily[family] });
  }

  return {
    success: true,
    count: fonts.length,
    totalFamilies: totalFamilies,
    totalFonts: totalFonts,
    truncated: truncated,
    fonts: fonts,
  };
}

/**
 * Explicitly prefetch a single font. Text tools load fonts on demand, but
 * prefetching is useful before batch operations. Throws if unavailable.
 */
async function loadFont(params) {
  const p = params || {};
  const family = p.family;
  const style = p.style;

  if (!family || !style) {
    throw new Error("`family` and `style` are required");
  }

  Log.info(`load_font: ${family} / ${style}`);
  await figma.loadFontAsync({ family: family, style: style });

  return {
    success: true,
    family: family,
    style: style,
    message: `Loaded font "${family} ${style}".`,
  };
}

// ===== BL-070: Align / distribute / tidy =====

/** Walk the parent chain to the owning PageNode (or null if detached). */
function getOwningPage(node) {
  let a = node.parent;
  while (a && a.type !== "PAGE") a = a.parent;
  return a;
}

/**
 * True when the node's parent frame applies any rotation/scale/skew (its
 * absoluteTransform linear 2x2 part is not the identity). In that case the
 * "shift local x/y by an absolute delta" trick is invalid, so we skip the node.
 * A PAGE parent (no absoluteTransform) counts as identity — page coords are
 * already absolute.
 */
function parentHasNonIdentityLinear(node) {
  const parent = node.parent;
  if (!parent || !("absoluteTransform" in parent)) return false;
  const t = parent.absoluteTransform;
  if (!t || !t[0] || !t[1]) return false;
  const a = t[0][0], c = t[0][1], b = t[1][0], d = t[1][1];
  const EPS = 1e-4;
  return Math.abs(a - 1) > EPS || Math.abs(d - 1) > EPS
    || Math.abs(b) > EPS || Math.abs(c) > EPS;
}

/** Format a skipped[] list for inclusion in error messages. */
function describeSkipped(skipped) {
  if (!skipped || skipped.length === 0) return "";
  const parts = [];
  for (let i = 0; i < skipped.length; i++) {
    parts.push(skipped[i].id + " (" + skipped[i].reason + ")");
  }
  return "; skipped: " + parts.join(", ");
}

/**
 * Resolve nodeIds into positionable scene nodes, snapshotting each node's
 * absolute bounding box up front (so later moves never read stale geometry).
 * Skips nodes that are missing, removed, non-positionable, bbox-less, managed
 * by a parent auto-layout (x/y owned by the layout), not on the current page
 * (cross-page absolute coords are unrelated), or under a rotated/scaled parent
 * (the delta-move trick only holds for axis-aligned parents).
 * Returns { nodes: [{node, bbox}], skipped: [{id, reason}] }.
 */
async function resolvePositionableNodes(nodeIds) {
  if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
    throw new Error("`nodeIds` must be a non-empty array");
  }
  const nodes = [];
  const skipped = [];
  for (let i = 0; i < nodeIds.length; i++) {
    const id = nodeIds[i];
    const node = await figma.getNodeByIdAsync(id);
    if (!node) { skipped.push({ id: id, reason: "not found" }); continue; }
    if (node.removed) { skipped.push({ id: id, reason: "removed" }); continue; }
    if (!("x" in node) || !("absoluteBoundingBox" in node)) {
      skipped.push({ id: id, reason: `type ${node.type} is not positionable` });
      continue;
    }
    const bbox = node.absoluteBoundingBox;
    if (!bbox) { skipped.push({ id: id, reason: "no bounding box" }); continue; }
    // Auto-layout managed children can't be freely repositioned via x/y.
    const parent = node.parent;
    const managed = parent && "layoutMode" in parent && parent.layoutMode !== "NONE"
      && node.layoutPositioning !== "ABSOLUTE";
    if (managed) {
      skipped.push({ id: id, reason: "managed by parent auto-layout (set layoutPositioning=ABSOLUTE to move)" });
      continue;
    }
    // Cross-page nodes live in unrelated coordinate frames — combining their
    // absolute bboxes would silently scramble positions. Restrict to current page.
    const ownPage = getOwningPage(node);
    if (!ownPage || ownPage.id !== figma.currentPage.id) {
      skipped.push({ id: id, reason: "not on the current page" });
      continue;
    }
    // The delta-move trick is only valid when the parent frame is axis-aligned.
    if (parentHasNonIdentityLinear(node)) {
      skipped.push({ id: id, reason: "parent is rotated/scaled (unsupported)" });
      continue;
    }
    nodes.push({ node: node, bbox: bbox });
  }
  return { nodes: nodes, skipped: skipped };
}

/**
 * Move a node so its absolute bounding box top-left lands at (targetAbsX,
 * targetAbsY). The absolute→local delta equals the absolute delta as long as
 * the parent isn't rotated/scaled (the ~universal case), so we just shift x/y.
 */
function shiftNodeTo(node, bbox, targetAbsX, targetAbsY) {
  node.x = node.x + (targetAbsX - bbox.x);
  node.y = node.y + (targetAbsY - bbox.y);
}

async function alignNodes(params) {
  const p = params || {};
  const axis = p.axis;
  const VALID = ["left", "right", "top", "bottom", "center-h", "center-v"];
  if (VALID.indexOf(axis) === -1) {
    throw new Error(`axis must be one of: ${VALID.join(", ")}`);
  }

  const resolved = await resolvePositionableNodes(p.nodeIds);
  const items = resolved.nodes;
  if (items.length < 2) {
    throw new Error(`align needs at least 2 positionable nodes, got ${items.length}` + describeSkipped(resolved.skipped));
  }

  // Combined bounding box in absolute space.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < items.length; i++) {
    const b = items[i].bbox;
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.width > maxX) maxX = b.x + b.width;
    if (b.y + b.height > maxY) maxY = b.y + b.height;
  }
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  const moved = [];
  for (let i = 0; i < items.length; i++) {
    const node = items[i].node;
    const b = items[i].bbox;
    // Default targets = current position (zero delta on the untouched axis).
    let targetX = b.x, targetY = b.y;
    if (axis === "left") targetX = minX;
    else if (axis === "right") targetX = maxX - b.width;
    else if (axis === "center-h") targetX = centerX - b.width / 2;
    else if (axis === "top") targetY = minY;
    else if (axis === "bottom") targetY = maxY - b.height;
    else if (axis === "center-v") targetY = centerY - b.height / 2;

    shiftNodeTo(node, b, targetX, targetY);
    moved.push(node.id);
  }

  return {
    success: true,
    axis: axis,
    alignedCount: moved.length,
    movedNodeIds: moved,
    skipped: resolved.skipped,
  };
}

async function distributeNodes(params) {
  const p = params || {};
  const direction = p.direction;
  if (direction !== "horizontal" && direction !== "vertical") {
    throw new Error('direction must be "horizontal" or "vertical"');
  }

  const resolved = await resolvePositionableNodes(p.nodeIds);
  const items = resolved.nodes;
  if (items.length < 3) {
    throw new Error(`distribute needs at least 3 positionable nodes, got ${items.length}` + describeSkipped(resolved.skipped));
  }

  const horizontal = direction === "horizontal";
  // Order by leading edge along the axis.
  items.sort(function (a, b) {
    return horizontal ? a.bbox.x - b.bbox.x : a.bbox.y - b.bbox.y;
  });

  // Equal-gap distribution: first & last stay put, inner gaps equalized.
  const first = items[0].bbox;
  const last = items[items.length - 1].bbox;
  let sizeSum = 0;
  for (let i = 0; i < items.length; i++) {
    sizeSum += horizontal ? items[i].bbox.width : items[i].bbox.height;
  }
  const startEdge = horizontal ? first.x : first.y;
  const endEdge = horizontal ? last.x + last.width : last.y + last.height;
  const gap = (endEdge - startEdge - sizeSum) / (items.length - 1);

  const moved = [];
  let cursor = startEdge;
  for (let i = 0; i < items.length; i++) {
    const node = items[i].node;
    const b = items[i].bbox;
    if (horizontal) {
      shiftNodeTo(node, b, cursor, b.y);
      cursor += b.width + gap;
    } else {
      shiftNodeTo(node, b, b.x, cursor);
      cursor += b.height + gap;
    }
    moved.push(node.id);
  }

  return {
    success: true,
    direction: direction,
    distributedCount: moved.length,
    gap: gap,
    movedNodeIds: moved,
    skipped: resolved.skipped,
  };
}

async function tidyUp(params) {
  const p = params || {};
  const axis = p.axis;
  if (axis !== "horizontal" && axis !== "vertical") {
    throw new Error('axis must be "horizontal" or "vertical"');
  }
  const spacing = typeof p.spacing === "number" ? p.spacing : 0;

  const resolved = await resolvePositionableNodes(p.nodeIds);
  const items = resolved.nodes;
  if (items.length < 2) {
    throw new Error(`tidy_up needs at least 2 positionable nodes, got ${items.length}` + describeSkipped(resolved.skipped));
  }

  const horizontal = axis === "horizontal";
  // Pack into a row (horizontal) or column (vertical) ordered by current
  // position, aligned on the cross-axis to the group's min edge, with uniform
  // spacing. Group origin (first node's leading edge) stays stable.
  items.sort(function (a, b) {
    return horizontal ? a.bbox.x - b.bbox.x : a.bbox.y - b.bbox.y;
  });

  let crossMin = Infinity;
  for (let i = 0; i < items.length; i++) {
    const c = horizontal ? items[i].bbox.y : items[i].bbox.x;
    if (c < crossMin) crossMin = c;
  }
  const mainStart = horizontal ? items[0].bbox.x : items[0].bbox.y;

  const moved = [];
  let cursor = mainStart;
  for (let i = 0; i < items.length; i++) {
    const node = items[i].node;
    const b = items[i].bbox;
    if (horizontal) {
      shiftNodeTo(node, b, cursor, crossMin);
      cursor += b.width + spacing;
    } else {
      shiftNodeTo(node, b, crossMin, cursor);
      cursor += b.height + spacing;
    }
    moved.push(node.id);
  }

  return {
    success: true,
    axis: axis,
    spacing: spacing,
    tidiedCount: moved.length,
    movedNodeIds: moved,
    skipped: resolved.skipped,
  };
}

// Set multiple annotations with async progress updates
async function setMultipleAnnotations(params) {
  Log.info("=== setMultipleAnnotations Debug Start ===");
  Log.info("Input params:", JSON.stringify(params, null, 2));

  const { nodeId, annotations } = params;

  if (!annotations || annotations.length === 0) {
    Log.error("Validation failed: No annotations provided");
    return { success: false, error: "No annotations provided" };
  }

  Log.info(
    `Processing ${annotations.length} annotations for node ${nodeId}`
  );

  const results = [];
  let successCount = 0;
  let failureCount = 0;

  // Process annotations sequentially
  for (let i = 0; i < annotations.length; i++) {
    const annotation = annotations[i];
    Log.info(
      `\nProcessing annotation ${i + 1}/${annotations.length}:`,
      JSON.stringify(annotation, null, 2)
    );

    try {
      Log.info("Calling setAnnotation with params:", {
        nodeId: annotation.nodeId,
        labelMarkdown: annotation.labelMarkdown,
        categoryId: annotation.categoryId,
        properties: annotation.properties,
      });

      const result = await setAnnotation({
        nodeId: annotation.nodeId,
        labelMarkdown: annotation.labelMarkdown,
        categoryId: annotation.categoryId,
        properties: annotation.properties,
      });

      Log.info("setAnnotation result:", JSON.stringify(result, null, 2));

      if (result.success) {
        successCount++;
        results.push({ success: true, nodeId: annotation.nodeId });
        Log.info(`✓ Annotation ${i + 1} applied successfully`);
      } else {
        failureCount++;
        results.push({
          success: false,
          nodeId: annotation.nodeId,
          error: result.error,
        });
        Log.error(`✗ Annotation ${i + 1} failed:`, result.error);
      }
    } catch (error) {
      failureCount++;
      const errorResult = {
        success: false,
        nodeId: annotation.nodeId,
        error: error.message,
      };
      results.push(errorResult);
      Log.error(`✗ Annotation ${i + 1} failed with error:`, error);
      Log.error("Error details:", {
        message: error.message,
        stack: error.stack,
      });
    }
  }

  const summary = {
    success: successCount > 0,
    annotationsApplied: successCount,
    annotationsFailed: failureCount,
    totalAnnotations: annotations.length,
    results: results,
  };

  Log.info("\n=== setMultipleAnnotations Summary ===");
  Log.info(JSON.stringify(summary, null, 2));
  Log.info("=== setMultipleAnnotations Debug End ===");

  return summary;
}

async function deleteMultipleNodes(params) {
  const { nodeIds } = params || {};
  const commandId = (params && params.commandId) || generateCommandId();

  if (!nodeIds || !Array.isArray(nodeIds) || nodeIds.length === 0) {
    const errorMsg = "Missing or invalid nodeIds parameter";
    sendProgressUpdate(
      commandId,
      "delete_multiple_nodes",
      "error",
      0,
      0,
      0,
      errorMsg,
      { error: errorMsg }
    );
    throw new Error(errorMsg);
  }

  Log.info(`Starting deletion of ${nodeIds.length} nodes`);

  // Send started progress update
  sendProgressUpdate(
    commandId,
    "delete_multiple_nodes",
    "started",
    0,
    nodeIds.length,
    0,
    `Starting deletion of ${nodeIds.length} nodes`,
    { totalNodes: nodeIds.length }
  );

  const results = [];
  let successCount = 0;
  let failureCount = 0;

  // Process nodes in chunks of 5 to avoid overwhelming Figma
  const CHUNK_SIZE = 5;
  const chunks = [];

  for (let i = 0; i < nodeIds.length; i += CHUNK_SIZE) {
    chunks.push(nodeIds.slice(i, i + CHUNK_SIZE));
  }

  Log.info(`Split ${nodeIds.length} deletions into ${chunks.length} chunks`);

  // Send chunking info update
  sendProgressUpdate(
    commandId,
    "delete_multiple_nodes",
    "in_progress",
    5,
    nodeIds.length,
    0,
    `Preparing to delete ${nodeIds.length} nodes using ${chunks.length} chunks`,
    {
      totalNodes: nodeIds.length,
      chunks: chunks.length,
      chunkSize: CHUNK_SIZE,
    }
  );

  // Process each chunk sequentially
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    // Best-effort cancellation (CONTRACT item D): stop between chunks and
    // return the partial results gathered so far.
    if (isCancelled(commandId)) break;

    const chunk = chunks[chunkIndex];
    Log.info(
      `Processing chunk ${chunkIndex + 1}/${chunks.length} with ${chunk.length
      } nodes`
    );

    // Send chunk processing start update
    sendProgressUpdate(
      commandId,
      "delete_multiple_nodes",
      "in_progress",
      Math.round(5 + (chunkIndex / chunks.length) * 90),
      nodeIds.length,
      successCount + failureCount,
      `Processing deletion chunk ${chunkIndex + 1}/${chunks.length}`,
      {
        currentChunk: chunkIndex + 1,
        totalChunks: chunks.length,
        successCount,
        failureCount,
      }
    );

    // Process deletions within a chunk in parallel
    const chunkPromises = chunk.map(async (nodeId) => {
      try {
        const node = await figma.getNodeByIdAsync(nodeId);

        if (!node) {
          Log.error(`Node not found: ${nodeId}`);
          return {
            success: false,
            nodeId: nodeId,
            error: `Node not found: ${nodeId}`,
          };
        }

        // Save node info before deleting
        const nodeInfo = {
          id: node.id,
          name: node.name,
          type: node.type,
        };

        // Delete the node
        node.remove();

        Log.info(`Successfully deleted node: ${nodeId}`);
        return {
          success: true,
          nodeId: nodeId,
          nodeInfo: nodeInfo,
        };
      } catch (error) {
        Log.error(`Error deleting node ${nodeId}: ${error.message}`);
        return {
          success: false,
          nodeId: nodeId,
          error: error.message,
        };
      }
    });

    // Wait for all deletions in this chunk to complete
    const chunkResults = await Promise.all(chunkPromises);

    // Process results for this chunk
    chunkResults.forEach((result) => {
      if (result.success) {
        successCount++;
      } else {
        failureCount++;
      }
      results.push(result);
    });

    // Send chunk processing complete update
    sendProgressUpdate(
      commandId,
      "delete_multiple_nodes",
      "in_progress",
      Math.round(5 + ((chunkIndex + 1) / chunks.length) * 90),
      nodeIds.length,
      successCount + failureCount,
      `Completed chunk ${chunkIndex + 1}/${chunks.length
      }. ${successCount} successful, ${failureCount} failed so far.`,
      {
        currentChunk: chunkIndex + 1,
        totalChunks: chunks.length,
        successCount,
        failureCount,
        chunkResults: chunkResults,
      }
    );

    // Add a small delay between chunks
    if (chunkIndex < chunks.length - 1) {
      Log.info("Pausing between chunks...");
      await delay(1000);
    }
  }

  Log.info(
    `Deletion complete: ${successCount} successful, ${failureCount} failed`
  );

  // Send completed progress update
  sendProgressUpdate(
    commandId,
    "delete_multiple_nodes",
    "completed",
    100,
    nodeIds.length,
    successCount + failureCount,
    `Node deletion complete: ${successCount} successful, ${failureCount} failed`,
    {
      totalNodes: nodeIds.length,
      nodesDeleted: successCount,
      nodesFailed: failureCount,
      completedInChunks: chunks.length,
      results: results,
    }
  );

  return {
    success: successCount > 0,
    nodesDeleted: successCount,
    nodesFailed: failureCount,
    totalNodes: nodeIds.length,
    results: results,
    completedInChunks: chunks.length,
    commandId,
  };
}

// Implementation for getInstanceOverrides function
async function getInstanceOverrides(instanceNode = null) {
  Log.info("=== getInstanceOverrides called ===");

  let sourceInstance = null;

  // Check if an instance node was passed directly
  if (instanceNode) {
    Log.info("Using provided instance node");

    // Validate that the provided node is an instance
    if (instanceNode.type !== "INSTANCE") {
      Log.error("Provided node is not an instance");
      figma.notify("Provided node is not a component instance");
      return { success: false, message: "Provided node is not a component instance" };
    }

    sourceInstance = instanceNode;
  } else {
    // No node provided, use selection
    Log.info("No node provided, using current selection");

    // Get the current selection
    const selection = figma.currentPage.selection;

    // Check if there's anything selected
    if (selection.length === 0) {
      Log.info("No nodes selected");
      figma.notify("Please select at least one instance");
      return { success: false, message: "No nodes selected" };
    }

    // Filter for instances in the selection
    const instances = selection.filter(node => node.type === "INSTANCE");

    if (instances.length === 0) {
      Log.info("No instances found in selection");
      figma.notify("Please select at least one component instance");
      return { success: false, message: "No instances found in selection" };
    }

    // Take the first instance from the selection
    sourceInstance = instances[0];
  }

  try {
    Log.info(`Getting instance information:`);
    Log.info(sourceInstance);

    // Get component overrides and main component
    const overrides = sourceInstance.overrides || [];
    Log.info(`  Raw Overrides:`, overrides);

    // Get main component
    const mainComponent = await sourceInstance.getMainComponentAsync();
    if (!mainComponent) {
      Log.error("Failed to get main component");
      figma.notify("Failed to get main component");
      return { success: false, message: "Failed to get main component" };
    }

    // return data to MCP server
    const returnData = {
      success: true,
      message: `Got component information from "${sourceInstance.name}" for overrides.length: ${overrides.length}`,
      sourceInstanceId: sourceInstance.id,
      mainComponentId: mainComponent.id,
      overridesCount: overrides.length
    };

    Log.info("Data to return to MCP server:", returnData);
    figma.notify(`Got component information from "${sourceInstance.name}"`);

    return returnData;
  } catch (error) {
    Log.error("Error in getInstanceOverrides:", error);
    figma.notify(`Error: ${error.message}`);
    return {
      success: false,
      message: `Error: ${error.message}`
    };
  }
}

/**
 * Helper function to validate and get target instances
 * @param {string[]} targetNodeIds - Array of instance node IDs
 * @returns {instanceNode[]} targetInstances - Array of target instances
 */
async function getValidTargetInstances(targetNodeIds) {
  let targetInstances = [];

  // Handle array of instances or single instance
  if (Array.isArray(targetNodeIds)) {
    if (targetNodeIds.length === 0) {
      return { success: false, message: "No instances provided" };
    }
    for (const targetNodeId of targetNodeIds) {
      const targetNode = await figma.getNodeByIdAsync(targetNodeId);
      if (targetNode && targetNode.type === "INSTANCE") {
        targetInstances.push(targetNode);
      }
    }
    if (targetInstances.length === 0) {
      return { success: false, message: "No valid instances provided" };
    }
  } else {
    return { success: false, message: "Invalid target node IDs provided" };
  }


  return { success: true, message: "Valid target instances provided", targetInstances };
}

/**
 * Helper function to validate and get saved override data
 * @param {string} sourceInstanceId - Source instance ID
 * @returns {Promise<Object>} - Validation result with source instance data or error
 */
async function getSourceInstanceData(sourceInstanceId) {
  if (!sourceInstanceId) {
    return { success: false, message: "Missing source instance ID" };
  }

  // Get source instance by ID
  const sourceInstance = await figma.getNodeByIdAsync(sourceInstanceId);
  if (!sourceInstance) {
    return {
      success: false,
      message: "Source instance not found. The original instance may have been deleted."
    };
  }

  // Verify it's an instance
  if (sourceInstance.type !== "INSTANCE") {
    return {
      success: false,
      message: "Source node is not a component instance."
    };
  }

  // Get main component
  const mainComponent = await sourceInstance.getMainComponentAsync();
  if (!mainComponent) {
    return {
      success: false,
      message: "Failed to get main component from source instance."
    };
  }

  return {
    success: true,
    sourceInstance,
    mainComponent,
    overrides: sourceInstance.overrides || []
  };
}

/**
 * Sets saved overrides to the selected component instance(s)
 * @param {InstanceNode[] | null} targetInstances - Array of instance nodes to set overrides to
 * @param {Object} sourceResult - Source instance data from getSourceInstanceData
 * @returns {Promise<Object>} - Result of the set operation
 */
async function setInstanceOverrides(targetInstances, sourceResult) {
  try {


    const { sourceInstance, mainComponent, overrides } = sourceResult;

    Log.info(`Processing ${targetInstances.length} instances with ${overrides.length} overrides`);
    Log.info(`Source instance: ${sourceInstance.id}, Main component: ${mainComponent.id}`);
    Log.info(`Overrides:`, overrides);

    // Process all instances
    const results = [];
    let totalAppliedCount = 0;

    for (const targetInstance of targetInstances) {
      try {
        // // Skip if trying to apply to the source instance itself
        // if (targetInstance.id === sourceInstance.id) {
        //   Log.info(`Skipping source instance itself: ${targetInstance.id}`);
        //   results.push({
        //     success: false,
        //     instanceId: targetInstance.id,
        //     instanceName: targetInstance.name,
        //     message: "This is the source instance itself, skipping"
        //   });
        //   continue;
        // }

        // Swap component
        try {
          targetInstance.swapComponent(mainComponent);
          Log.info(`Swapped component for instance "${targetInstance.name}"`);
        } catch (error) {
          Log.error(`Error swapping component for instance "${targetInstance.name}":`, error);
          results.push({
            success: false,
            instanceId: targetInstance.id,
            instanceName: targetInstance.name,
            message: `Error: ${error.message}`
          });
        }

        // Prepare overrides by replacing node IDs
        let appliedCount = 0;

        // Apply each override
        for (const override of overrides) {
          // Skip if no ID or overriddenFields
          if (!override.id || !override.overriddenFields || override.overriddenFields.length === 0) {
            continue;
          }

          // Replace source instance ID with target instance ID in the node path
          const overrideNodeId = override.id.replace(sourceInstance.id, targetInstance.id);
          const overrideNode = await figma.getNodeByIdAsync(overrideNodeId);

          if (!overrideNode) {
            Log.info(`Override node not found: ${overrideNodeId}`);
            continue;
          }

          // Get source node to copy properties from
          const sourceNode = await figma.getNodeByIdAsync(override.id);
          if (!sourceNode) {
            Log.info(`Source node not found: ${override.id}`);
            continue;
          }

          // Apply each overridden field
          let fieldApplied = false;
          for (const field of override.overriddenFields) {
            try {
              if (field === "componentProperties") {
                // Apply component properties
                if (sourceNode.componentProperties && overrideNode.componentProperties) {
                  const properties = {};
                  for (const key in sourceNode.componentProperties) {
                    // if INSTANCE_SWAP use id, otherwise use value
                    if (sourceNode.componentProperties[key].type === 'INSTANCE_SWAP') {
                      properties[key] = sourceNode.componentProperties[key].value;
                    
                    } else {
                      properties[key] = sourceNode.componentProperties[key].value;
                    }
                  }
                  overrideNode.setProperties(properties);
                  fieldApplied = true;
                }
              } else if (field === "characters" && overrideNode.type === "TEXT") {
                // For text nodes, need to load fonts first
                await figma.loadFontAsync(overrideNode.fontName);
                overrideNode.characters = sourceNode.characters;
                fieldApplied = true;
              } else if (field in overrideNode) {
                // Direct property assignment
                overrideNode[field] = sourceNode[field];
                fieldApplied = true;
              }
            } catch (fieldError) {
              Log.error(`Error applying field ${field}:`, fieldError);
            }
          }

          if (fieldApplied) {
            appliedCount++;
          }
        }

        if (appliedCount > 0) {
          totalAppliedCount += appliedCount;
          results.push({
            success: true,
            instanceId: targetInstance.id,
            instanceName: targetInstance.name,
            appliedCount
          });
          Log.info(`Applied ${appliedCount} overrides to "${targetInstance.name}"`);
        } else {
          results.push({
            success: false,
            instanceId: targetInstance.id,
            instanceName: targetInstance.name,
            message: "No overrides were applied"
          });
        }
      } catch (instanceError) {
        Log.error(`Error processing instance "${targetInstance.name}":`, instanceError);
        results.push({
          success: false,
          instanceId: targetInstance.id,
          instanceName: targetInstance.name,
          message: `Error: ${instanceError.message}`
        });
      }
    }

    // Return results
    if (totalAppliedCount > 0) {
      const instanceCount = results.filter(r => r.success).length;
      const message = `Applied ${totalAppliedCount} overrides to ${instanceCount} instances`;
      figma.notify(message);
      return {
        success: true,
        message,
        totalCount: totalAppliedCount,
        results
      };
    } else {
      const message = "No overrides applied to any instance";
      figma.notify(message);
      return { success: false, message, results };
    }

  } catch (error) {
    Log.error("Error in setInstanceOverrides:", error);
    const message = `Error: ${error.message}`;
    figma.notify(message);
    return { success: false, message };
  }
}

async function setLayoutMode(params) {
  const { nodeId, layoutMode = "NONE", layoutWrap = "NO_WRAP" } = params || {};

  // Get the target node
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // Check if node is a frame or component that supports layoutMode
  if (
    node.type !== "FRAME" &&
    node.type !== "COMPONENT" &&
    node.type !== "COMPONENT_SET" &&
    node.type !== "INSTANCE"
  ) {
    throw new Error(`Node type ${node.type} does not support layoutMode`);
  }

  // Set layout mode
  node.layoutMode = layoutMode;

  // Set layoutWrap if applicable
  if (layoutMode !== "NONE") {
    node.layoutWrap = layoutWrap;
  }

  return {
    id: node.id,
    name: node.name,
    layoutMode: node.layoutMode,
    layoutWrap: node.layoutWrap,
  };
}

async function setPadding(params) {
  const { nodeId, paddingTop, paddingRight, paddingBottom, paddingLeft } =
    params || {};

  // Get the target node
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // Check if node is a frame or component that supports padding
  if (
    node.type !== "FRAME" &&
    node.type !== "COMPONENT" &&
    node.type !== "COMPONENT_SET" &&
    node.type !== "INSTANCE"
  ) {
    throw new Error(`Node type ${node.type} does not support padding`);
  }

  // Check if the node has auto-layout enabled
  if (node.layoutMode === "NONE") {
    throw new Error(
      "Padding can only be set on auto-layout frames (layoutMode must not be NONE)"
    );
  }

  // Set padding values if provided
  if (paddingTop !== undefined) node.paddingTop = paddingTop;
  if (paddingRight !== undefined) node.paddingRight = paddingRight;
  if (paddingBottom !== undefined) node.paddingBottom = paddingBottom;
  if (paddingLeft !== undefined) node.paddingLeft = paddingLeft;

  return {
    id: node.id,
    name: node.name,
    paddingTop: node.paddingTop,
    paddingRight: node.paddingRight,
    paddingBottom: node.paddingBottom,
    paddingLeft: node.paddingLeft,
  };
}

async function setAxisAlign(params) {
  const { nodeId, primaryAxisAlignItems, counterAxisAlignItems } = params || {};

  // Get the target node
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // Check if node is a frame or component that supports axis alignment
  if (
    node.type !== "FRAME" &&
    node.type !== "COMPONENT" &&
    node.type !== "COMPONENT_SET" &&
    node.type !== "INSTANCE"
  ) {
    throw new Error(`Node type ${node.type} does not support axis alignment`);
  }

  // Check if the node has auto-layout enabled
  if (node.layoutMode === "NONE") {
    throw new Error(
      "Axis alignment can only be set on auto-layout frames (layoutMode must not be NONE)"
    );
  }

  // Validate and set primaryAxisAlignItems if provided
  if (primaryAxisAlignItems !== undefined) {
    if (
      !["MIN", "MAX", "CENTER", "SPACE_BETWEEN"].includes(primaryAxisAlignItems)
    ) {
      throw new Error(
        "Invalid primaryAxisAlignItems value. Must be one of: MIN, MAX, CENTER, SPACE_BETWEEN"
      );
    }
    node.primaryAxisAlignItems = primaryAxisAlignItems;
  }

  // Validate and set counterAxisAlignItems if provided
  if (counterAxisAlignItems !== undefined) {
    if (!["MIN", "MAX", "CENTER", "BASELINE"].includes(counterAxisAlignItems)) {
      throw new Error(
        "Invalid counterAxisAlignItems value. Must be one of: MIN, MAX, CENTER, BASELINE"
      );
    }
    // BASELINE is only valid for horizontal layout
    if (
      counterAxisAlignItems === "BASELINE" &&
      node.layoutMode !== "HORIZONTAL"
    ) {
      throw new Error(
        "BASELINE alignment is only valid for horizontal auto-layout frames"
      );
    }
    node.counterAxisAlignItems = counterAxisAlignItems;
  }

  return {
    id: node.id,
    name: node.name,
    primaryAxisAlignItems: node.primaryAxisAlignItems,
    counterAxisAlignItems: node.counterAxisAlignItems,
    layoutMode: node.layoutMode,
  };
}

async function setLayoutSizing(params) {
  const { nodeId, layoutSizingHorizontal, layoutSizingVertical } = params || {};

  // Get the target node
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // Check if node is a frame or component that supports layout sizing
  if (
    node.type !== "FRAME" &&
    node.type !== "COMPONENT" &&
    node.type !== "COMPONENT_SET" &&
    node.type !== "INSTANCE"
  ) {
    throw new Error(`Node type ${node.type} does not support layout sizing`);
  }

  // Check if the node has auto-layout enabled
  if (node.layoutMode === "NONE") {
    throw new Error(
      "Layout sizing can only be set on auto-layout frames (layoutMode must not be NONE)"
    );
  }

  // Validate and set layoutSizingHorizontal if provided
  if (layoutSizingHorizontal !== undefined) {
    if (!["FIXED", "HUG", "FILL"].includes(layoutSizingHorizontal)) {
      throw new Error(
        "Invalid layoutSizingHorizontal value. Must be one of: FIXED, HUG, FILL"
      );
    }
    // HUG is only valid on auto-layout frames and text nodes
    if (
      layoutSizingHorizontal === "HUG" &&
      !["FRAME", "TEXT"].includes(node.type)
    ) {
      throw new Error(
        "HUG sizing is only valid on auto-layout frames and text nodes"
      );
    }
    // FILL is only valid on auto-layout children
    if (
      layoutSizingHorizontal === "FILL" &&
      (!node.parent || node.parent.layoutMode === "NONE")
    ) {
      throw new Error("FILL sizing is only valid on auto-layout children");
    }
    node.layoutSizingHorizontal = layoutSizingHorizontal;
  }

  // Validate and set layoutSizingVertical if provided
  if (layoutSizingVertical !== undefined) {
    if (!["FIXED", "HUG", "FILL"].includes(layoutSizingVertical)) {
      throw new Error(
        "Invalid layoutSizingVertical value. Must be one of: FIXED, HUG, FILL"
      );
    }
    // HUG is only valid on auto-layout frames and text nodes
    if (
      layoutSizingVertical === "HUG" &&
      !["FRAME", "TEXT"].includes(node.type)
    ) {
      throw new Error(
        "HUG sizing is only valid on auto-layout frames and text nodes"
      );
    }
    // FILL is only valid on auto-layout children
    if (
      layoutSizingVertical === "FILL" &&
      (!node.parent || node.parent.layoutMode === "NONE")
    ) {
      throw new Error("FILL sizing is only valid on auto-layout children");
    }
    node.layoutSizingVertical = layoutSizingVertical;
  }

  return {
    id: node.id,
    name: node.name,
    layoutSizingHorizontal: node.layoutSizingHorizontal,
    layoutSizingVertical: node.layoutSizingVertical,
    layoutMode: node.layoutMode,
  };
}

async function setItemSpacing(params) {
  const { nodeId, itemSpacing, counterAxisSpacing } = params || {};

  // Validate that at least one spacing parameter is provided
  if (itemSpacing === undefined && counterAxisSpacing === undefined) {
    throw new Error("At least one of itemSpacing or counterAxisSpacing must be provided");
  }

  // Get the target node
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // Check if node is a frame or component that supports item spacing
  if (
    node.type !== "FRAME" &&
    node.type !== "COMPONENT" &&
    node.type !== "COMPONENT_SET" &&
    node.type !== "INSTANCE"
  ) {
    throw new Error(`Node type ${node.type} does not support item spacing`);
  }

  // Check if the node has auto-layout enabled
  if (node.layoutMode === "NONE") {
    throw new Error(
      "Item spacing can only be set on auto-layout frames (layoutMode must not be NONE)"
    );
  }

  // Set item spacing if provided
  if (itemSpacing !== undefined) {
    if (typeof itemSpacing !== "number") {
      throw new Error("Item spacing must be a number");
    }
    node.itemSpacing = itemSpacing;
  }

  // Set counter axis spacing if provided
  if (counterAxisSpacing !== undefined) {
    if (typeof counterAxisSpacing !== "number") {
      throw new Error("Counter axis spacing must be a number");
    }
    // counterAxisSpacing only applies when layoutWrap is WRAP
    if (node.layoutWrap !== "WRAP") {
      throw new Error(
        "Counter axis spacing can only be set on frames with layoutWrap set to WRAP"
      );
    }
    node.counterAxisSpacing = counterAxisSpacing;
  }

  return {
    id: node.id,
    name: node.name,
    itemSpacing: node.itemSpacing || undefined,
    counterAxisSpacing: node.counterAxisSpacing || undefined,
    layoutMode: node.layoutMode,
    layoutWrap: node.layoutWrap,
  };
}

async function setDefaultConnector(params) {
  const { connectorId } = params || {};
  
  // If connectorId is provided, search and set by that ID (do not check existing storage)
  if (connectorId) {
    // Get node by specified ID
    const node = await figma.getNodeByIdAsync(connectorId);
    if (!node) {
      throw new Error(`Connector node not found with ID: ${connectorId}`);
    }
    
    // Check node type
    if (node.type !== 'CONNECTOR') {
      throw new Error(`Node is not a connector: ${connectorId}`);
    }
    
    // Set the found connector as the default connector
    await figma.clientStorage.setAsync('defaultConnectorId', connectorId);
    
    return {
      success: true,
      message: `Default connector set to: ${connectorId}`,
      connectorId: connectorId
    };
  } 
  // If connectorId is not provided, check existing storage
  else {
    // Check if there is an existing default connector in client storage
    try {
      const existingConnectorId = await figma.clientStorage.getAsync('defaultConnectorId');
      
      // If there is an existing connector ID, check if the node is still valid
      if (existingConnectorId) {
        try {
          const existingConnector = await figma.getNodeByIdAsync(existingConnectorId);
          
          // If the stored connector still exists and is of type CONNECTOR
          if (existingConnector && existingConnector.type === 'CONNECTOR') {
            return {
              success: true,
              message: `Default connector is already set to: ${existingConnectorId}`,
              connectorId: existingConnectorId,
              exists: true
            };
          }
          // The stored connector is no longer valid - find a new connector
          else {
            Log.info(`Stored connector ID ${existingConnectorId} is no longer valid, finding a new connector...`);
          }
        } catch (error) {
          Log.info(`Error finding stored connector: ${error.message}. Will try to set a new one.`);
        }
      }
    } catch (error) {
      Log.info(`Error checking for existing connector: ${error.message}`);
    }
    
    // If there is no stored default connector or it is invalid, find one in the current page
    try {
      // Find CONNECTOR type nodes in the current page
      const currentPageConnectors = figma.currentPage.findAllWithCriteria({ types: ['CONNECTOR'] });
      
      if (currentPageConnectors && currentPageConnectors.length > 0) {
        // Use the first connector found
        const foundConnector = currentPageConnectors[0];
        const autoFoundId = foundConnector.id;
        
        // Set the found connector as the default connector
        await figma.clientStorage.setAsync('defaultConnectorId', autoFoundId);
        
        return {
          success: true,
          message: `Automatically found and set default connector to: ${autoFoundId}`,
          connectorId: autoFoundId,
          autoSelected: true
        };
      } else {
        // If no connector is found in the current page, show a guide message
        throw new Error('No connector found in the current page. Please create a connector in Figma first or specify a connector ID.');
      }
    } catch (error) {
      // Error occurred while running findAllWithCriteria
      throw new Error(`Failed to find a connector: ${error.message}`);
    }
  }
}

async function createCursorNode(targetNodeId) {
  const svgString = `<svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M16 8V35.2419L22 28.4315L27 39.7823C27 39.7823 28.3526 40.2722 29 39.7823C29.6474 39.2924 30.2913 38.3057 30 37.5121C28.6247 33.7654 25 26.1613 25 26.1613H32L16 8Z" fill="#202125" />
  </svg>`;
  try {
    const targetNode = await figma.getNodeByIdAsync(targetNodeId);
    if (!targetNode) throw new Error("Target node not found");

    // The targetNodeId has semicolons since it is a nested node.
    // So we need to get the parent node ID from the target node ID and check if we can appendChild to it or not.
    let parentNodeId = targetNodeId.includes(';') 
      ? targetNodeId.split(';')[0] 
      : targetNodeId;
    if (!parentNodeId) throw new Error("Could not determine parent node ID");

    // Find the parent node to append cursor node as child
    let parentNode = await figma.getNodeByIdAsync(parentNodeId);
    if (!parentNode) throw new Error("Parent node not found");

    // If the parent node is not eligible to appendChild, set the parentNode to the parent of the parentNode
    if (parentNode.type === 'INSTANCE' || parentNode.type === 'COMPONENT' || parentNode.type === 'COMPONENT_SET') {
      parentNode = parentNode.parent;
      if (!parentNode) throw new Error("Parent node not found");
    }

    // Create the cursor node
    const importedNode = await figma.createNodeFromSvg(svgString);
    if (!importedNode || !importedNode.id) {
      throw new Error("Failed to create imported cursor node");
    }
    importedNode.name = "TTF_Connector / Mouse Cursor";
    importedNode.resize(48, 48);

    const cursorNode = importedNode.findOne(node => node.type === 'VECTOR');
    if (cursorNode) {
      cursorNode.fills = [{
        type: 'SOLID',
        color: { r: 0, g: 0, b: 0 },
        opacity: 1
      }];
      cursorNode.strokes = [{
        type: 'SOLID',
        color: { r: 1, g: 1, b: 1 },
        opacity: 1
      }];
      cursorNode.strokeWeight = 2;
      cursorNode.strokeAlign = 'OUTSIDE';
      cursorNode.effects = [{
        type: "DROP_SHADOW",
        color: { r: 0, g: 0, b: 0, a: 0.3 },
        offset: { x: 1, y: 1 },
        radius: 2,
        spread: 0,
        visible: true,
        blendMode: "NORMAL"
      }];
    }

    // Append the cursor node to the parent node
    parentNode.appendChild(importedNode);

    // if the parentNode has auto-layout enabled, set the layoutPositioning to ABSOLUTE
    if ('layoutMode' in parentNode && parentNode.layoutMode !== 'NONE') {
      importedNode.layoutPositioning = 'ABSOLUTE';
    }

    // Adjust the importedNode's position to the targetNode's position
    if (
      targetNode.absoluteBoundingBox &&
      parentNode.absoluteBoundingBox
    ) {
      // if the targetNode has absoluteBoundingBox, set the importedNode's absoluteBoundingBox to the targetNode's absoluteBoundingBox
      Log.info('targetNode.absoluteBoundingBox', targetNode.absoluteBoundingBox);
      Log.info('parentNode.absoluteBoundingBox', parentNode.absoluteBoundingBox);
      importedNode.x = targetNode.absoluteBoundingBox.x - parentNode.absoluteBoundingBox.x  + targetNode.absoluteBoundingBox.width / 2 - 48 / 2
      importedNode.y = targetNode.absoluteBoundingBox.y - parentNode.absoluteBoundingBox.y + targetNode.absoluteBoundingBox.height / 2 - 48 / 2;
    } else if (
      'x' in targetNode && 'y' in targetNode && 'width' in targetNode && 'height' in targetNode) {
        // if the targetNode has x, y, width, height, calculate center based on relative position
        Log.info('targetNode.x/y/width/height', targetNode.x, targetNode.y, targetNode.width, targetNode.height);
        importedNode.x = targetNode.x + targetNode.width / 2 - 48 / 2;
        importedNode.y = targetNode.y + targetNode.height / 2 - 48 / 2;
    } else {
      // Fallback: Place at top-left of target if possible, otherwise at (0,0) relative to parent
      if ('x' in targetNode && 'y' in targetNode) {
        Log.info('Fallback to targetNode x/y');
        importedNode.x = targetNode.x;
        importedNode.y = targetNode.y;
      } else {
        Log.info('Fallback to (0,0)');
        importedNode.x = 0;
        importedNode.y = 0;
      }
    }

    // get the importedNode ID and the importedNode
    Log.info('importedNode', importedNode);


    return { id: importedNode.id, node: importedNode };
    
  } catch (error) {
    Log.error("Error creating cursor from SVG:", error);
    return { id: null, node: null, error: error.message };
  }
}

async function createConnections(params) {
  if (!params || !params.connections || !Array.isArray(params.connections)) {
    throw new Error('Missing or invalid connections parameter');
  }
  
  const { connections } = params;

  // Command ID for progress tracking
  const commandId = (params && params.commandId) || generateCommandId();
  sendProgressUpdate(
    commandId,
    "create_connections",
    "started",
    0,
    connections.length,
    0,
    `Starting to create ${connections.length} connections`
  );
  
  // Get default connector ID from client storage
  const defaultConnectorId = await figma.clientStorage.getAsync('defaultConnectorId');
  if (!defaultConnectorId) {
    throw new Error('No default connector set. Please try one of the following options to create connections:\n1. Create a connector in FigJam and copy/paste it to your current page, then run the "set_default_connector" command.\n2. Select an existing connector on the current page, then run the "set_default_connector" command.');
  }
  
  // Get the default connector
  const defaultConnector = await figma.getNodeByIdAsync(defaultConnectorId);
  if (!defaultConnector) {
    throw new Error(`Default connector not found with ID: ${defaultConnectorId}`);
  }
  if (defaultConnector.type !== 'CONNECTOR') {
    throw new Error(`Node is not a connector: ${defaultConnectorId}`);
  }
  
  // Results array for connection creation
  const results = [];
  let processedCount = 0;
  const totalCount = connections.length;
  
  // Preload fonts (used for text if provided)
  let fontLoaded = false;
  
  for (let i = 0; i < connections.length; i++) {
    try {
      const { startNodeId: originalStartId, endNodeId: originalEndId, text } = connections[i];
      let startId = originalStartId;
      let endId = originalEndId;

      // Check and potentially replace start node ID
      if (startId.includes(';')) {
        Log.info(`Nested start node detected: ${startId}. Creating cursor node.`);
        const cursorResult = await createCursorNode(startId);
        if (!cursorResult || !cursorResult.id) {
          throw new Error(`Failed to create cursor node for nested start node: ${startId}`);
        }
        startId = cursorResult.id; 
      }  
      
      const startNode = await figma.getNodeByIdAsync(startId);
      if (!startNode) throw new Error(`Start node not found with ID: ${startId}`);

      // Check and potentially replace end node ID
      if (endId.includes(';')) {
        Log.info(`Nested end node detected: ${endId}. Creating cursor node.`);
        const cursorResult = await createCursorNode(endId);
        if (!cursorResult || !cursorResult.id) {
          throw new Error(`Failed to create cursor node for nested end node: ${endId}`);
        }
        endId = cursorResult.id;
      }
      const endNode = await figma.getNodeByIdAsync(endId);
      if (!endNode) throw new Error(`End node not found with ID: ${endId}`);

      
      // Clone the default connector
      const clonedConnector = defaultConnector.clone();
      
      // Update connector name using potentially replaced node names
      clonedConnector.name = `TTF_Connector/${startNode.id}/${endNode.id}`;
      
      // Set start and end points using potentially replaced IDs
      clonedConnector.connectorStart = {
        endpointNodeId: startId,
        magnet: 'AUTO'
      };
      
      clonedConnector.connectorEnd = {
        endpointNodeId: endId,
        magnet: 'AUTO'
      };
      
      // Add text (if provided)
      if (text) {
        try {
          // Try to load the necessary fonts
          try {
            // First check if default connector has font and use the same
            if (defaultConnector.text && defaultConnector.text.fontName) {
              const fontName = defaultConnector.text.fontName;
              await figma.loadFontAsync(fontName);
              clonedConnector.text.fontName = fontName;
            } else {
              // Try default Inter font
              await figma.loadFontAsync({ family: "Inter", style: "Regular" });
            }
          } catch (fontError) {
            // If first font load fails, try another font style
            try {
              await figma.loadFontAsync({ family: "Inter", style: "Medium" });
            } catch (mediumFontError) {
              // If second font fails, try system font
              try {
                await figma.loadFontAsync({ family: "System", style: "Regular" });
              } catch (systemFontError) {
                // If all font loading attempts fail, throw error
                throw new Error(`Failed to load any font: ${fontError.message}`);
              }
            }
          }
          
          // Set the text
          clonedConnector.text.characters = text;
        } catch (textError) {
          Log.error("Error setting text:", textError);
          // Continue with connection even if text setting fails
          results.push({
            id: clonedConnector.id,
            originalStartNodeId: originalStartId,
            originalEndNodeId: originalEndId,
            usedStartNodeId: startId,
            usedEndNodeId: endId,
            text: "",
            textError: textError.message
          });
          
          // Continue to next connection
          continue;
        }
      }
      
      // Add to results (using the *original* IDs for reference if needed)
      results.push({
        id: clonedConnector.id,
        originalStartNodeId: originalStartId,
        originalEndNodeId: originalEndId,
        usedStartNodeId: startId, // ID actually used for connection
        usedEndNodeId: endId,     // ID actually used for connection
        text: text || ""
      });
      
      // Update progress
      processedCount++;
      sendProgressUpdate(
        commandId,
        "create_connections",
        "in_progress",
        processedCount / totalCount,
        totalCount,
        processedCount,
        `Created connection ${processedCount}/${totalCount}`
      );
      
    } catch (error) {
      Log.error("Error creating connection", error);
      // Continue processing remaining connections even if an error occurs
      processedCount++;
      sendProgressUpdate(
        commandId,
        "create_connections",
        "in_progress",
        processedCount / totalCount,
        totalCount,
        processedCount,
        `Error creating connection: ${error.message}`
      );
      
      results.push({
        error: error.message,
        connectionInfo: connections[i]
      });
    }
  }
  
  // Completion update
  sendProgressUpdate(
    commandId,
    "create_connections",
    "completed",
    1,
    totalCount,
    totalCount,
    `Completed creating ${results.length} connections`
  );
  
  return {
    success: true,
    count: results.length,
    connections: results
  };
}

// Set focus on a specific node
async function setFocus(params) {
  if (!params || !params.nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(params.nodeId);
  if (!node) {
    throw new Error(`Node with ID ${params.nodeId} not found`);
  }

  // Set selection to the node
  figma.currentPage.selection = [node];
  
  // Scroll and zoom to show the node in viewport
  figma.viewport.scrollAndZoomIntoView([node]);

  return {
    success: true,
    name: node.name,
    id: node.id,
    message: `Focused on node "${node.name}"`
  };
}

// Set selection to multiple nodes
async function setSelections(params) {
  if (!params || !params.nodeIds || !Array.isArray(params.nodeIds)) {
    throw new Error("Missing or invalid nodeIds parameter");
  }

  if (params.nodeIds.length === 0) {
    throw new Error("nodeIds array cannot be empty");
  }

  // Get all valid nodes
  const nodes = [];
  const notFoundIds = [];
  
  for (const nodeId of params.nodeIds) {
    const node = await figma.getNodeByIdAsync(nodeId);
    if (node) {
      nodes.push(node);
    } else {
      notFoundIds.push(nodeId);
    }
  }

  if (nodes.length === 0) {
    throw new Error(`No valid nodes found for the provided IDs: ${params.nodeIds.join(', ')}`);
  }

  // Set selection to the nodes
  figma.currentPage.selection = nodes;
  
  // Scroll and zoom to show all nodes in viewport
  figma.viewport.scrollAndZoomIntoView(nodes);

  const selectedNodes = nodes.map(node => ({
    name: node.name,
    id: node.id
  }));

  return {
    success: true,
    count: nodes.length,
    selectedNodes: selectedNodes,
    notFoundIds: notFoundIds,
    message: `Selected ${nodes.length} nodes${notFoundIds.length > 0 ? ` (${notFoundIds.length} not found)` : ''}`
  };
}

// ---- Dev Mode (BL-034) --------------------------------------------
//
// Wraps `node.addDevResourceAsync`, `node.devResources`, and
// `node.devStatus`. These APIs live on FrameNode-like containers
// (FRAME, COMPONENT, COMPONENT_SET, INSTANCE, SECTION). Calls on
// unsupported nodes throw a clear "does not support" error so the
// MCP client doesn't get a confusing TypeError from the plugin host.

var DEV_STATUS_TYPES = ["READY_FOR_DEV", "COMPLETED", "NONE"];

async function setDevResource(params) {
  const p = params || {};
  const nodeId = p.nodeId;
  const name = p.name;
  const url = p.url;
  if (!nodeId) throw new Error("Missing nodeId");
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Missing name");
  }
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("Missing url");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);
  if (typeof node.addDevResourceAsync !== "function") {
    throw new Error("Node does not support dev resources: " + node.type);
  }

  // Figma dedupes by URL — calling addDevResourceAsync with an
  // existing URL returns the existing resource rather than throwing,
  // so the operation is idempotent for repeat calls. Some plugin host
  // versions return `undefined` on dedup; fall back to scanning the
  // node.devResources list to recover the matching entry.
  let resource = await node.addDevResourceAsync(url, name);
  if (!resource) {
    const list = node.devResources || [];
    for (let i = 0; i < list.length; i++) {
      if (list[i] && list[i].url === url) {
        resource = list[i];
        break;
      }
    }
  }

  const resourceId = resource && resource.id ? resource.id : null;
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    resourceId: resourceId,
    resource: resource
      ? { id: resource.id, name: resource.name, url: resource.url }
      : { name: name, url: url },
  };
}

async function getDevResources(params) {
  const p = params || {};
  const nodeId = p.nodeId;
  if (!nodeId) throw new Error("Missing nodeId");

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);
  if (!("devResources" in node)) {
    throw new Error("Node does not support dev resources: " + node.type);
  }

  const list = node.devResources || [];
  const resources = [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!r) continue;
    resources.push({
      id: r.id,
      name: r.name,
      url: r.url,
    });
  }

  return {
    id: node.id,
    name: node.name,
    type: node.type,
    resources: resources,
  };
}

async function setDevStatus(params) {
  const p = params || {};
  const nodeId = p.nodeId;
  const type = p.type;
  const description = p.description;
  if (!nodeId) throw new Error("Missing nodeId");
  if (DEV_STATUS_TYPES.indexOf(type) === -1) {
    throw new Error(
      "type must be one of: " + DEV_STATUS_TYPES.join(", ")
    );
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);
  if (!("devStatus" in node)) {
    throw new Error("Node does not support devStatus: " + node.type);
  }

  if (type === "NONE") {
    // Figma's API uses null to clear devStatus.
    node.devStatus = null;
  } else {
    const status = { type: type };
    if (typeof description === "string") {
      status.description = description;
    }
    node.devStatus = status;
  }

  const current = node.devStatus;
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    devStatus: current
      ? {
          type: current.type,
          description: current.description == null ? "" : current.description,
        }
      : null,
  };
}
// ---- Corner / Geometry (BL-022) -----------------------------------
//
// Granular corner-radius, rotation, flip, and vector-shape operations.
// The plugin runtime forbids ES2018+ object spread, optional chaining,
// and nullish coalescing — we use Object.assign / explicit guards.

async function setIndividualCornerRadii(params) {
  const p = params || {};
  const nodeId = p.nodeId;
  if (!nodeId) throw new Error("Missing nodeId");

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);
  if (!("topLeftRadius" in node)) {
    throw new Error("Node does not support per-corner radii: " + node.type);
  }

  const tl = p.topLeft;
  const tr = p.topRight;
  const bl = p.bottomLeft;
  const br = p.bottomRight;
  if (tl == null && tr == null && bl == null && br == null) {
    throw new Error("Provide at least one of topLeft / topRight / bottomLeft / bottomRight");
  }

  if (tl != null) node.topLeftRadius = tl;
  if (tr != null) node.topRightRadius = tr;
  if (bl != null) node.bottomLeftRadius = bl;
  if (br != null) node.bottomRightRadius = br;

  return {
    id: node.id,
    name: node.name,
    topLeftRadius: node.topLeftRadius,
    topRightRadius: node.topRightRadius,
    bottomLeftRadius: node.bottomLeftRadius,
    bottomRightRadius: node.bottomRightRadius,
  };
}

async function setCornerSmoothing(params) {
  const p = params || {};
  const nodeId = p.nodeId;
  const smoothing = p.smoothing;
  if (!nodeId) throw new Error("Missing nodeId");
  if (typeof smoothing !== "number" || !isFinite(smoothing)) {
    throw new Error("smoothing must be a number 0..1");
  }
  if (smoothing < 0 || smoothing > 1) {
    throw new Error("smoothing must be in range 0..1 (got " + smoothing + ")");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);
  if (!("cornerSmoothing" in node)) {
    throw new Error("Node does not support cornerSmoothing: " + node.type);
  }

  node.cornerSmoothing = smoothing;
  return { id: node.id, name: node.name, cornerSmoothing: node.cornerSmoothing };
}

async function setRotation(params) {
  const p = params || {};
  const nodeId = p.nodeId;
  const degrees = p.degrees;
  if (!nodeId) throw new Error("Missing nodeId");
  if (typeof degrees !== "number" || !isFinite(degrees)) {
    throw new Error("degrees must be a finite number");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);
  if (!("rotation" in node)) {
    throw new Error("Node does not support rotation: " + node.type);
  }

  node.rotation = degrees;
  return { id: node.id, name: node.name, rotation: node.rotation };
}

async function setFlip(params) {
  const p = params || {};
  const nodeId = p.nodeId;
  const horizontal = p.horizontal === true;
  const vertical = p.vertical === true;
  if (!nodeId) throw new Error("Missing nodeId");
  if (!horizontal && !vertical) {
    throw new Error("Provide horizontal=true and/or vertical=true");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);
  if (!("relativeTransform" in node)) {
    throw new Error("Node does not support relativeTransform: " + node.type);
  }

  // relativeTransform shape: [[a, b, tx], [c, d, ty]]
  // Horizontal flip: negate the X column (a, c) and shift tx by width so the
  // node visually stays anchored at its top-left bounding box. Vertical:
  // negate the Y column (b, d) and shift ty by height. Calling twice
  // restores the original transform — the (-1)*(-1)=1 cancels and the
  // double translate sums to zero (since the post-flip width/height match
  // the pre-flip values for an axis-aligned box).
  const t = node.relativeTransform;
  let a = t[0][0], b = t[0][1], tx = t[0][2];
  let c = t[1][0], d = t[1][1], ty = t[1][2];
  const width = node.width;
  const height = node.height;

  if (horizontal) {
    a = -a;
    c = -c;
    tx = tx + width;
  }
  if (vertical) {
    b = -b;
    d = -d;
    ty = ty + height;
  }

  node.relativeTransform = [[a, b, tx], [c, d, ty]];

  return {
    id: node.id,
    name: node.name,
    horizontal: horizontal,
    vertical: vertical,
    relativeTransform: node.relativeTransform,
  };
}

async function flattenNodes(params) {
  const p = params || {};
  const nodeIds = p.nodeIds;
  if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
    throw new Error("nodeIds must be a non-empty array");
  }

  const nodes = [];
  const notFound = [];
  for (let i = 0; i < nodeIds.length; i++) {
    const n = await figma.getNodeByIdAsync(nodeIds[i]);
    if (n) nodes.push(n);
    else notFound.push(nodeIds[i]);
  }
  if (nodes.length === 0) {
    throw new Error("No nodes found for IDs: " + nodeIds.join(", "));
  }

  let parent = null;
  if (p.parentId) {
    parent = await figma.getNodeByIdAsync(p.parentId);
    if (!parent) throw new Error("Parent not found: " + p.parentId);
  }

  const result = parent
    ? figma.flatten(nodes, parent)
    : figma.flatten(nodes);

  return {
    id: result.id,
    name: result.name,
    type: result.type,
    parentId: result.parent ? result.parent.id : null,
    notFoundIds: notFound,
  };
}

async function outlineStroke(params) {
  const p = params || {};
  const nodeId = p.nodeId;
  if (!nodeId) throw new Error("Missing nodeId");

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);
  if (typeof node.outlineStroke !== "function") {
    throw new Error("Node does not support outlineStroke: " + node.type);
  }

  const result = node.outlineStroke();
  if (!result) {
    return {
      id: null,
      sourceId: node.id,
      sourceName: node.name,
      message: "Node has no stroke to outline (outlineStroke returned null)",
    };
  }

  return {
    id: result.id,
    name: result.name,
    type: result.type,
    sourceId: node.id,
    sourceName: node.name,
  };
}

async function booleanOperation(params) {
  const p = params || {};
  const nodeIds = p.nodeIds;
  const operation = p.operation;
  if (!Array.isArray(nodeIds) || nodeIds.length < 2) {
    throw new Error("nodeIds must be an array of at least 2 ids");
  }
  if (operation !== "union" && operation !== "subtract" && operation !== "intersect" && operation !== "exclude") {
    throw new Error("operation must be one of: union | subtract | intersect | exclude");
  }

  const nodes = [];
  const notFound = [];
  for (let i = 0; i < nodeIds.length; i++) {
    const n = await figma.getNodeByIdAsync(nodeIds[i]);
    if (n) nodes.push(n);
    else notFound.push(nodeIds[i]);
  }
  if (nodes.length < 2) {
    throw new Error("Need at least 2 valid nodes; got " + nodes.length);
  }

  let parent = null;
  if (p.parentId) {
    parent = await figma.getNodeByIdAsync(p.parentId);
    if (!parent) throw new Error("Parent not found: " + p.parentId);
  }

  let result;
  if (operation === "union") {
    result = parent ? figma.union(nodes, parent) : figma.union(nodes, nodes[0].parent);
  } else if (operation === "subtract") {
    result = parent ? figma.subtract(nodes, parent) : figma.subtract(nodes, nodes[0].parent);
  } else if (operation === "intersect") {
    result = parent ? figma.intersect(nodes, parent) : figma.intersect(nodes, nodes[0].parent);
  } else {
    result = parent ? figma.exclude(nodes, parent) : figma.exclude(nodes, nodes[0].parent);
  }

  return {
    id: result.id,
    name: result.name,
    type: result.type,
    operation: operation,
    parentId: result.parent ? result.parent.id : null,
    notFoundIds: notFound,
  };
}

// ---- Auto-layout advanced (BL-021) --------------------------------

async function setLayoutWrap(params) {
  const p = params || {};
  if (!p.nodeId) throw new Error("Missing nodeId");
  if (p.wrap !== "NO_WRAP" && p.wrap !== "WRAP") {
    throw new Error("wrap must be 'NO_WRAP' or 'WRAP'");
  }
  const node = await figma.getNodeByIdAsync(p.nodeId);
  if (!node) throw new Error("Node not found: " + p.nodeId);
  if (!("layoutMode" in node) || node.layoutMode === "NONE") {
    throw new Error("Node is not an auto-layout frame: " + node.type);
  }
  node.layoutWrap = p.wrap;
  return { id: node.id, name: node.name, layoutWrap: node.layoutWrap };
}

async function setMinMaxSize(params) {
  const p = params || {};
  if (!p.nodeId) throw new Error("Missing nodeId");
  const keys = ["minWidth", "maxWidth", "minHeight", "maxHeight"];
  let any = false;
  for (let i = 0; i < keys.length; i++) {
    const v = p[keys[i]];
    if (v !== undefined) {
      any = true;
      if (v !== null && (typeof v !== "number" || v < 0)) {
        throw new Error(keys[i] + " must be a non-negative number or null");
      }
    }
  }
  if (!any) throw new Error("Provide at least one of minWidth/maxWidth/minHeight/maxHeight");

  const node = await figma.getNodeByIdAsync(p.nodeId);
  if (!node) throw new Error("Node not found: " + p.nodeId);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (p[k] !== undefined && k in node) {
      node[k] = p[k];
    }
  }
  return {
    id: node.id, name: node.name,
    minWidth: node.minWidth, maxWidth: node.maxWidth,
    minHeight: node.minHeight, maxHeight: node.maxHeight,
  };
}

async function setLayoutAlign(params) {
  const p = params || {};
  if (!p.nodeId) throw new Error("Missing nodeId");
  const valid = ["MIN", "CENTER", "MAX", "STRETCH", "INHERIT"];
  if (valid.indexOf(p.align) === -1) {
    throw new Error("align must be one of: " + valid.join(" | "));
  }
  const node = await figma.getNodeByIdAsync(p.nodeId);
  if (!node) throw new Error("Node not found: " + p.nodeId);
  if (!("layoutAlign" in node)) {
    throw new Error("Node does not support layoutAlign: " + node.type);
  }
  node.layoutAlign = p.align;
  return { id: node.id, name: node.name, layoutAlign: node.layoutAlign };
}

async function setLayoutGrow(params) {
  const p = params || {};
  if (!p.nodeId) throw new Error("Missing nodeId");
  if (p.grow !== 0 && p.grow !== 1) {
    throw new Error("grow must be 0 or 1");
  }
  const node = await figma.getNodeByIdAsync(p.nodeId);
  if (!node) throw new Error("Node not found: " + p.nodeId);
  if (!("layoutGrow" in node)) {
    throw new Error("Node does not support layoutGrow: " + node.type);
  }
  node.layoutGrow = p.grow;
  return { id: node.id, name: node.name, layoutGrow: node.layoutGrow };
}

async function setCounterAxisSpacing(params) {
  const p = params || {};
  if (!p.nodeId) throw new Error("Missing nodeId");
  if (typeof p.spacing !== "number" || !isFinite(p.spacing)) {
    throw new Error("spacing must be a finite number");
  }
  const node = await figma.getNodeByIdAsync(p.nodeId);
  if (!node) throw new Error("Node not found: " + p.nodeId);
  if (!("layoutMode" in node) || node.layoutMode === "NONE") {
    throw new Error("Node is not an auto-layout frame: " + node.type);
  }
  node.counterAxisSpacing = p.spacing;
  return { id: node.id, name: node.name, counterAxisSpacing: node.counterAxisSpacing };
}

// ---- Page management (BL-012) -------------------------------------

async function getPages(_params) {
  const pages = figma.root.children;
  const currentId = figma.currentPage.id;
  const list = [];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    list.push({
      id: p.id,
      name: p.name,
      childCount: p.children.length,
      isCurrent: p.id === currentId,
      index: i,
    });
  }
  return { count: list.length, currentPageId: currentId, pages: list };
}

async function createPage(params) {
  const p = params || {};
  if (!p.name || typeof p.name !== "string") throw new Error("Missing name");
  const page = figma.createPage();
  page.name = p.name;
  if (typeof p.index === "number") {
    const total = figma.root.children.length;
    const idx = Math.max(0, Math.min(p.index, total - 1));
    figma.root.insertChild(idx, page);
  }
  return { id: page.id, name: page.name, index: figma.root.children.indexOf(page) };
}

async function deletePage(params) {
  const p = params || {};
  if (!p.pageId) throw new Error("Missing pageId");
  if (figma.root.children.length <= 1) {
    throw new Error("Cannot delete the last remaining page");
  }
  const page = await figma.getNodeByIdAsync(p.pageId);
  if (!page) throw new Error("Page not found: " + p.pageId);
  if (page.type !== "PAGE") throw new Error("Not a page: " + page.type);
  if (page.id === figma.currentPage.id) {
    // Switch away first; Figma rejects deleting the current page.
    const others = figma.root.children.filter(function (c) { return c.id !== page.id; });
    await figma.setCurrentPageAsync(others[0]);
  }
  page.remove();
  return { deletedId: p.pageId, remaining: figma.root.children.length };
}

async function renamePage(params) {
  const p = params || {};
  if (!p.pageId) throw new Error("Missing pageId");
  if (!p.name || typeof p.name !== "string") throw new Error("Missing name");
  const page = await figma.getNodeByIdAsync(p.pageId);
  if (!page) throw new Error("Page not found: " + p.pageId);
  if (page.type !== "PAGE") throw new Error("Not a page: " + page.type);
  page.name = p.name;
  return { id: page.id, name: page.name };
}

async function setCurrentPage(params) {
  const p = params || {};
  if (!p.pageId) throw new Error("Missing pageId");
  const page = await figma.getNodeByIdAsync(p.pageId);
  if (!page) throw new Error("Page not found: " + p.pageId);
  if (page.type !== "PAGE") throw new Error("Not a page: " + page.type);
  await figma.setCurrentPageAsync(page);
  return { currentPageId: figma.currentPage.id, name: figma.currentPage.name };
}

async function reorderPages(params) {
  const p = params || {};
  if (!Array.isArray(p.orderedIds) || p.orderedIds.length === 0) {
    throw new Error("orderedIds must be a non-empty array");
  }
  // Validate all ids exist + are PageNodes before mutating.
  const pages = [];
  for (let i = 0; i < p.orderedIds.length; i++) {
    const node = await figma.getNodeByIdAsync(p.orderedIds[i]);
    if (!node) throw new Error("Page not found: " + p.orderedIds[i]);
    if (node.type !== "PAGE") throw new Error("Not a page: " + p.orderedIds[i]);
    pages.push(node);
  }
  for (let i = 0; i < pages.length; i++) {
    figma.root.insertChild(i, pages[i]);
  }
  return {
    pages: figma.root.children.map(function (c, i) {
      return { id: c.id, name: c.name, index: i };
    }),
  };
}

// ---- Node creation expansion (BL-011) -----------------------------

async function placeAtSimple(node, x, y, parentId) {
  if (typeof x === "number") node.x = x;
  if (typeof y === "number") node.y = y;
  if (parentId) {
    const parent = await figma.getNodeByIdAsync(parentId);
    if (!parent) throw new Error("Parent not found: " + parentId);
    if (typeof parent.appendChild !== "function") {
      throw new Error("Target is not a container: " + parentId);
    }
    parent.appendChild(node);
  }
}

function ensureSize(node, w, h) {
  if (typeof w === "number" && typeof h === "number") {
    if (w <= 0 || h <= 0) throw new Error("width/height must be positive");
    node.resize(w, h);
  }
}

async function createEllipse(params) {
  const p = params || {};
  const node = figma.createEllipse();
  if (p.name) node.name = p.name;
  ensureSize(node, p.width, p.height);

  // Set fill color if provided
  if (p.fillColor) {
    node.fills = [{
      type: "SOLID",
      color: {
        r: parseFloat(p.fillColor.r) || 0,
        g: parseFloat(p.fillColor.g) || 0,
        b: parseFloat(p.fillColor.b) || 0,
      },
      opacity: (p.fillColor.a == null || isNaN(parseFloat(p.fillColor.a))) ? 1 : parseFloat(p.fillColor.a),
    }];
  }

  // Set stroke color if provided
  if (p.strokeColor) {
    node.strokes = [{
      type: "SOLID",
      color: {
        r: parseFloat(p.strokeColor.r) || 0,
        g: parseFloat(p.strokeColor.g) || 0,
        b: parseFloat(p.strokeColor.b) || 0,
      },
      opacity: (p.strokeColor.a == null || isNaN(parseFloat(p.strokeColor.a))) ? 1 : parseFloat(p.strokeColor.a),
    }];
  }

  // Set stroke weight if provided
  if (p.strokeWeight !== undefined) {
    node.strokeWeight = p.strokeWeight;
  }

  await placeAtSimple(node, p.x, p.y, p.parentId);
  return { id: node.id, name: node.name, type: node.type, x: node.x, y: node.y };
}

async function createLine(params) {
  const p = params || {};
  if (typeof p.x1 !== "number" || typeof p.y1 !== "number" || typeof p.x2 !== "number" || typeof p.y2 !== "number") {
    throw new Error("createLine requires numeric x1, y1, x2, y2");
  }
  const node = figma.createLine();
  if (p.name) node.name = p.name;
  // Length + rotation derived from endpoints. Figma's LineNode is a
  // horizontal segment of `width` px with rotation in degrees.
  const dx = p.x2 - p.x1;
  const dy = p.y2 - p.y1;
  const length = Math.sqrt(dx * dx + dy * dy);
  node.resize(length, 0);
  // Rotation in degrees, CCW; atan2 returns CCW radians from +X.
  const rad = Math.atan2(dy, dx);
  node.rotation = rad * (180 / Math.PI);
  // Anchor at start point.
  node.x = p.x1;
  node.y = p.y1;
  if (p.parentId) {
    const parent = await figma.getNodeByIdAsync(p.parentId);
    if (!parent) throw new Error("Parent not found: " + p.parentId);
    parent.appendChild(node);
  }
  if (p.strokeColor && typeof p.strokeColor === "object") {
    const c = p.strokeColor;
    node.strokes = [{
      type: "SOLID",
      color: {
        r: Math.max(0, Math.min(1, Number(c.r) || 0)),
        g: Math.max(0, Math.min(1, Number(c.g) || 0)),
        b: Math.max(0, Math.min(1, Number(c.b) || 0)),
      },
      opacity: c.a == null ? 1 : Math.max(0, Math.min(1, Number(c.a))),
    }];
  }
  if (typeof p.strokeWeight === "number") node.strokeWeight = p.strokeWeight;
  return { id: node.id, name: node.name, type: node.type, x: node.x, y: node.y, length: length, rotation: node.rotation };
}

async function createPolygon(params) {
  const p = params || {};
  const node = figma.createPolygon();
  if (p.name) node.name = p.name;
  if (typeof p.pointCount === "number") {
    if (p.pointCount < 3) throw new Error("polygon pointCount must be >= 3");
    node.pointCount = p.pointCount;
  }
  ensureSize(node, p.width, p.height);
  await placeAtSimple(node, p.x, p.y, p.parentId);
  return { id: node.id, name: node.name, type: node.type, pointCount: node.pointCount };
}

async function createStar(params) {
  const p = params || {};
  const node = figma.createStar();
  if (p.name) node.name = p.name;
  if (typeof p.pointCount === "number") {
    if (p.pointCount < 3) throw new Error("star pointCount must be >= 3");
    node.pointCount = p.pointCount;
  }
  if (typeof p.innerRadius === "number") {
    if (p.innerRadius < 0 || p.innerRadius > 1) {
      throw new Error("innerRadius must be 0..1");
    }
    node.innerRadius = p.innerRadius;
  }
  ensureSize(node, p.width, p.height);
  await placeAtSimple(node, p.x, p.y, p.parentId);
  return { id: node.id, name: node.name, type: node.type, pointCount: node.pointCount, innerRadius: node.innerRadius };
}

async function createVector(params) {
  const p = params || {};
  if (!Array.isArray(p.paths) || p.paths.length === 0) {
    throw new Error("paths must be a non-empty array of { data, windingRule? }");
  }
  const vectorPaths = [];
  for (let i = 0; i < p.paths.length; i++) {
    const path = p.paths[i];
    if (!path || typeof path.data !== "string" || path.data.length === 0) {
      throw new Error("paths[" + i + "].data must be a non-empty SVG path string");
    }
    const winding = path.windingRule;
    if (winding != null && winding !== "NONZERO" && winding !== "EVENODD") {
      throw new Error("windingRule must be 'NONZERO' or 'EVENODD'");
    }
    vectorPaths.push({
      windingRule: winding == null ? "NONZERO" : winding,
      data: path.data,
    });
  }
  const node = figma.createVector();
  if (p.name) node.name = p.name;
  node.vectorPaths = vectorPaths;
  await placeAtSimple(node, p.x, p.y, p.parentId);
  return { id: node.id, name: node.name, type: node.type, pathCount: vectorPaths.length };
}

async function createSection(params) {
  const p = params || {};
  if (typeof figma.createSection !== "function") {
    throw new Error("figma.createSection is not available in this runtime");
  }
  const node = figma.createSection();
  if (p.name) node.name = p.name;
  ensureSize(node, p.width, p.height);
  await placeAtSimple(node, p.x, p.y, p.parentId);
  return { id: node.id, name: node.name, type: node.type, x: node.x, y: node.y };
}

async function createEmptyComponent(params) {
  const p = params || {};
  const node = figma.createComponent();
  if (p.name) node.name = p.name;
  ensureSize(node, p.width, p.height);
  await placeAtSimple(node, p.x, p.y, p.parentId);
  return { id: node.id, name: node.name, type: node.type, key: node.key };
}

async function combineAsVariantsTool(params) {
  const p = params || {};
  if (!Array.isArray(p.componentIds) || p.componentIds.length === 0) {
    throw new Error("componentIds must be a non-empty array");
  }
  const components = [];
  for (let i = 0; i < p.componentIds.length; i++) {
    const c = await figma.getNodeByIdAsync(p.componentIds[i]);
    if (!c) throw new Error("Component not found: " + p.componentIds[i]);
    if (c.type !== "COMPONENT") {
      throw new Error("Not a COMPONENT: " + p.componentIds[i] + " (" + c.type + ")");
    }
    components.push(c);
  }
  let parent = null;
  if (p.parentId) {
    parent = await figma.getNodeByIdAsync(p.parentId);
    if (!parent) throw new Error("Parent not found: " + p.parentId);
  } else {
    parent = components[0].parent || figma.currentPage;
  }
  const set = figma.combineAsVariants(components, parent);
  if (p.name && typeof p.name === "string") set.name = p.name;
  return { id: set.id, name: set.name, type: set.type, variantCount: components.length };
}

// ---- Text advanced (BL-023) ---------------------------------------

async function getTextNodeOrThrow(nodeId) {
  if (!nodeId) throw new Error("Missing nodeId");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error("Node not found: " + nodeId);
  if (node.type !== "TEXT") throw new Error("Not a text node: " + node.type);
  return node;
}

function checkRange(node, start, end) {
  const len = node.characters.length;
  if (typeof start !== "number" || typeof end !== "number") {
    throw new Error("start and end must be numeric");
  }
  if (start < 0 || end > len || start >= end) {
    throw new Error("Bad range [" + start + ", " + end + "); text length=" + len);
  }
}

async function loadFontsForRange(node, start, end) {
  const fonts = node.getRangeAllFontNames(start, end);
  for (let i = 0; i < fonts.length; i++) {
    await figma.loadFontAsync(fonts[i]);
  }
}

async function setTextRangeStyle(params) {
  const p = params || {};
  const node = await getTextNodeOrThrow(p.nodeId);
  checkRange(node, p.start, p.end);
  const style = p.style || {};

  await loadFontsForRange(node, p.start, p.end);

  // Font change requires the new font loaded too.
  if (style.fontFamily || style.fontStyle) {
    const baseRange = node.getRangeFontName(p.start, p.start + 1);
    const family = style.fontFamily || baseRange.family;
    const fstyle = style.fontStyle || baseRange.style;
    const next = { family: family, style: fstyle };
    await figma.loadFontAsync(next);
    node.setRangeFontName(p.start, p.end, next);
  }

  if (typeof style.fontSize === "number") {
    node.setRangeFontSize(p.start, p.end, style.fontSize);
  }
  if (style.letterSpacing !== undefined) {
    const v = typeof style.letterSpacing === "number"
      ? { value: style.letterSpacing, unit: "PIXELS" }
      : style.letterSpacing;
    node.setRangeLetterSpacing(p.start, p.end, v);
  }
  if (style.lineHeight !== undefined) {
    let v;
    if (style.lineHeight === "AUTO") v = { unit: "AUTO" };
    else if (typeof style.lineHeight === "number") v = { value: style.lineHeight, unit: "PIXELS" };
    else v = style.lineHeight;
    node.setRangeLineHeight(p.start, p.end, v);
  }
  if (style.textCase) node.setRangeTextCase(p.start, p.end, style.textCase);
  if (style.textDecoration) node.setRangeTextDecoration(p.start, p.end, style.textDecoration);
  if (Array.isArray(style.fills)) node.setRangeFills(p.start, p.end, style.fills);

  return {
    id: node.id,
    name: node.name,
    start: p.start,
    end: p.end,
    applied: Object.keys(style),
  };
}

async function setHyperlink(params) {
  const p = params || {};
  const node = await getTextNodeOrThrow(p.nodeId);
  checkRange(node, p.start, p.end);
  await loadFontsForRange(node, p.start, p.end);
  if (p.href === null || p.href === undefined) {
    node.setRangeHyperlink(p.start, p.end, null);
    return { id: node.id, start: p.start, end: p.end, cleared: true };
  }
  if (typeof p.href !== "string" || p.href.length === 0) {
    throw new Error("href must be a non-empty string or null to clear");
  }
  node.setRangeHyperlink(p.start, p.end, { type: "URL", value: p.href });
  return { id: node.id, start: p.start, end: p.end, href: p.href };
}

const TEXT_AUTO_RESIZE_VALUES = new Set(["WIDTH_AND_HEIGHT", "HEIGHT", "NONE", "TRUNCATE"]);

async function setTextAutoResize(params) {
  const p = params || {};
  const node = await getTextNodeOrThrow(p.nodeId);
  if (!TEXT_AUTO_RESIZE_VALUES.has(p.mode)) {
    throw new Error("mode must be one of: WIDTH_AND_HEIGHT | HEIGHT | NONE | TRUNCATE");
  }
  await figma.loadFontAsync(node.fontName === figma.mixed ? { family: "Inter", style: "Regular" } : node.fontName);
  node.textAutoResize = p.mode;
  return { id: node.id, name: node.name, textAutoResize: node.textAutoResize };
}

async function setTextTruncation(params) {
  const p = params || {};
  const node = await getTextNodeOrThrow(p.nodeId);
  if (p.truncation !== "DISABLED" && p.truncation !== "ENDING") {
    throw new Error("truncation must be 'DISABLED' or 'ENDING'");
  }
  node.textTruncation = p.truncation;
  if (typeof p.maxLines === "number") {
    if (p.maxLines < 1) throw new Error("maxLines must be >= 1");
    node.maxLines = p.maxLines;
  }
  return { id: node.id, name: node.name, textTruncation: node.textTruncation, maxLines: node.maxLines };
}

const LIST_TYPES = new Set(["ORDERED", "UNORDERED", "NONE"]);

async function setListOptions(params) {
  const p = params || {};
  const node = await getTextNodeOrThrow(p.nodeId);
  checkRange(node, p.start, p.end);
  if (!LIST_TYPES.has(p.listType)) {
    throw new Error("listType must be 'ORDERED' | 'UNORDERED' | 'NONE'");
  }
  await loadFontsForRange(node, p.start, p.end);
  node.setRangeListOptions(p.start, p.end, { type: p.listType });
  if (typeof p.indentLevel === "number") {
    if (p.indentLevel < 0) throw new Error("indentLevel must be >= 0");
    node.setRangeIndentation(p.start, p.end, p.indentLevel);
  }
  return { id: node.id, start: p.start, end: p.end, listType: p.listType, indentLevel: p.indentLevel };
}

// ---- Gradient & image paints (BL-009, BL-010) ---------------------

const GRADIENT_TYPES = new Set([
  "GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND",
]);

function buildGradientPaint(p) {
  if (!GRADIENT_TYPES.has(p.gradientType)) {
    throw new Error("Invalid gradientType: " + p.gradientType);
  }
  if (!Array.isArray(p.gradientStops) || p.gradientStops.length < 2) {
    throw new Error("gradientStops must be an array with at least 2 stops");
  }
  const stops = [];
  for (let i = 0; i < p.gradientStops.length; i++) {
    const s = p.gradientStops[i];
    if (typeof s.position !== "number" || s.position < 0 || s.position > 1) {
      throw new Error("Stop[" + i + "].position must be 0..1");
    }
    if (!s.color || typeof s.color !== "object") {
      throw new Error("Stop[" + i + "].color is required");
    }
    const c = s.color;
    stops.push({
      position: s.position,
      color: {
        r: Math.max(0, Math.min(1, Number(c.r) || 0)),
        g: Math.max(0, Math.min(1, Number(c.g) || 0)),
        b: Math.max(0, Math.min(1, Number(c.b) || 0)),
        a: c.a == null ? 1 : Math.max(0, Math.min(1, Number(c.a))),
      },
    });
  }
  // Default transform = identity for LINEAR (left→right). Caller can override.
  const transform = p.gradientTransform || [[1, 0, 0], [0, 1, 0]];
  return {
    type: p.gradientType,
    gradientStops: stops,
    gradientTransform: transform,
    opacity: p.opacity == null ? 1 : Math.max(0, Math.min(1, p.opacity)),
    visible: p.visible !== false,
  };
}

async function applyPaintTo(target, paintArrayKey, paint, replace) {
  const node = await figma.getNodeByIdAsync(target.nodeId);
  if (!node) throw new Error("Node not found: " + target.nodeId);
  if (!(paintArrayKey in node)) {
    throw new Error("Node does not support " + paintArrayKey + ": " + node.type);
  }
  const existing = replace === false && Array.isArray(node[paintArrayKey])
    ? node[paintArrayKey].slice()
    : [];
  node[paintArrayKey] = existing.concat([paint]);
  return { id: node.id, name: node.name, paint: paint, paints: node[paintArrayKey] };
}

async function setGradientFill(params) {
  const p = params || {};
  if (!p.nodeId) throw new Error("Missing nodeId");
  const paint = buildGradientPaint(p);
  return await applyPaintTo({ nodeId: p.nodeId }, "fills", paint, p.replace !== false);
}

async function setGradientStroke(params) {
  const p = params || {};
  if (!p.nodeId) throw new Error("Missing nodeId");
  const paint = buildGradientPaint(p);
  return await applyPaintTo({ nodeId: p.nodeId }, "strokes", paint, p.replace !== false);
}

async function setImageStroke(params) {
  const p = params || {};
  if (!p.nodeId) throw new Error("Missing nodeId");
  // Reuse the imageHash/imageBytes resolver from set_image_fill (BL-044).
  const hash = await resolveImageHash({ imageHash: p.imageHash, imageBytes: p.imageBytes });
  const scale = p.scaleMode || "FILL";
  if (!VALID_SCALE_MODES.has(scale)) {
    throw new Error("Invalid scaleMode: " + scale);
  }
  const paint = {
    type: "IMAGE",
    imageHash: hash,
    scaleMode: scale,
    opacity: p.opacity == null ? 1 : Math.max(0, Math.min(1, p.opacity)),
    rotation: typeof p.rotation === "number" ? p.rotation : 0,
    visible: p.visible !== false,
  };
  return await applyPaintTo({ nodeId: p.nodeId }, "strokes", paint, p.replace !== false);
}

// ---- Stroke properties full set (BL-013) --------------------------

const STROKE_ALIGN_VALUES = new Set(["CENTER", "INSIDE", "OUTSIDE"]);
const STROKE_CAP_VALUES = new Set(["NONE", "ROUND", "SQUARE", "ARROW_LINES", "ARROW_EQUILATERAL"]);
const STROKE_JOIN_VALUES = new Set(["MITER", "BEVEL", "ROUND"]);

async function setStrokeWeight(params) {
  const p = params || {};
  if (!p.nodeId) throw new Error("Missing nodeId");
  if (typeof p.weight !== "number" || p.weight < 0) {
    throw new Error("weight must be a non-negative number");
  }
  const node = await figma.getNodeByIdAsync(p.nodeId);
  if (!node) throw new Error("Node not found");
  if (!("strokeWeight" in node)) throw new Error("Node does not support strokes: " + node.type);
  node.strokeWeight = p.weight;
  return { id: node.id, name: node.name, strokeWeight: node.strokeWeight };
}

async function setStrokeAlign(params) {
  const p = params || {};
  if (!p.nodeId) throw new Error("Missing nodeId");
  if (!STROKE_ALIGN_VALUES.has(p.align)) throw new Error("align must be CENTER | INSIDE | OUTSIDE");
  const node = await figma.getNodeByIdAsync(p.nodeId);
  if (!node) throw new Error("Node not found");
  if (!("strokeAlign" in node)) throw new Error("Node does not support strokeAlign: " + node.type);
  node.strokeAlign = p.align;
  return { id: node.id, name: node.name, strokeAlign: node.strokeAlign };
}

async function setStrokeCap(params) {
  const p = params || {};
  if (!p.nodeId) throw new Error("Missing nodeId");
  if (!STROKE_CAP_VALUES.has(p.cap)) throw new Error("Invalid cap: " + p.cap);
  const node = await figma.getNodeByIdAsync(p.nodeId);
  if (!node) throw new Error("Node not found");
  if (!("strokeCap" in node)) throw new Error("Node does not support strokeCap: " + node.type);
  node.strokeCap = p.cap;
  return { id: node.id, name: node.name, strokeCap: node.strokeCap };
}

async function setStrokeJoin(params) {
  const p = params || {};
  if (!p.nodeId) throw new Error("Missing nodeId");
  if (!STROKE_JOIN_VALUES.has(p.join)) throw new Error("Invalid join: " + p.join);
  const node = await figma.getNodeByIdAsync(p.nodeId);
  if (!node) throw new Error("Node not found");
  if (!("strokeJoin" in node)) throw new Error("Node does not support strokeJoin: " + node.type);
  node.strokeJoin = p.join;
  return { id: node.id, name: node.name, strokeJoin: node.strokeJoin };
}

async function setDashPattern(params) {
  const p = params || {};
  if (!p.nodeId) throw new Error("Missing nodeId");
  if (!Array.isArray(p.pattern)) throw new Error("pattern must be an array of numbers");
  for (let i = 0; i < p.pattern.length; i++) {
    if (typeof p.pattern[i] !== "number" || p.pattern[i] < 0) {
      throw new Error("pattern[" + i + "] must be a non-negative number");
    }
  }
  const node = await figma.getNodeByIdAsync(p.nodeId);
  if (!node) throw new Error("Node not found");
  if (!("dashPattern" in node)) throw new Error("Node does not support dashPattern: " + node.type);
  node.dashPattern = p.pattern;
  return { id: node.id, name: node.name, dashPattern: node.dashPattern };
}

async function setIndividualStrokeWeights(params) {
  const p = params || {};
  if (!p.nodeId) throw new Error("Missing nodeId");
  const sides = ["top", "right", "bottom", "left"];
  let any = false;
  for (let i = 0; i < sides.length; i++) {
    if (p[sides[i]] !== undefined) {
      any = true;
      if (typeof p[sides[i]] !== "number" || p[sides[i]] < 0) {
        throw new Error(sides[i] + " must be a non-negative number");
      }
    }
  }
  if (!any) throw new Error("Provide at least one of top/right/bottom/left");

  const node = await figma.getNodeByIdAsync(p.nodeId);
  if (!node) throw new Error("Node not found");
  // Setter signature: node.strokeTopWeight = n, etc.
  if (p.top !== undefined) node.strokeTopWeight = p.top;
  if (p.right !== undefined) node.strokeRightWeight = p.right;
  if (p.bottom !== undefined) node.strokeBottomWeight = p.bottom;
  if (p.left !== undefined) node.strokeLeftWeight = p.left;
  return {
    id: node.id, name: node.name,
    strokeTopWeight: node.strokeTopWeight,
    strokeRightWeight: node.strokeRightWeight,
    strokeBottomWeight: node.strokeBottomWeight,
    strokeLeftWeight: node.strokeLeftWeight,
  };
}

// ---- Z-order / grouping (BL-017) ----------------------------------

async function reorderNode(params) {
  const p = params || {};
  if (!p.nodeId) throw new Error("Missing nodeId");
  if (typeof p.index !== "number" || p.index < 0) {
    throw new Error("index must be a non-negative integer");
  }
  const node = await figma.getNodeByIdAsync(p.nodeId);
  if (!node) throw new Error("Node not found");
  if (!node.parent) throw new Error("Node has no parent (page or removed)");
  if (typeof node.parent.insertChild !== "function") {
    throw new Error("Parent does not support reordering");
  }
  const total = node.parent.children.length;
  const idx = Math.max(0, Math.min(p.index, total - 1));
  node.parent.insertChild(idx, node);
  return {
    id: node.id, name: node.name,
    parentId: node.parent.id,
    index: node.parent.children.indexOf(node),
  };
}

async function groupNodes(params) {
  const p = params || {};
  if (!Array.isArray(p.nodeIds) || p.nodeIds.length === 0) {
    throw new Error("nodeIds must be a non-empty array");
  }
  const nodes = [];
  for (let i = 0; i < p.nodeIds.length; i++) {
    const n = await figma.getNodeByIdAsync(p.nodeIds[i]);
    if (!n) throw new Error("Node not found: " + p.nodeIds[i]);
    nodes.push(n);
  }
  let parent = null;
  if (p.parentId) {
    parent = await figma.getNodeByIdAsync(p.parentId);
    if (!parent) throw new Error("Parent not found: " + p.parentId);
  } else {
    parent = nodes[0].parent || figma.currentPage;
  }
  const group = figma.group(nodes, parent);
  if (p.name) group.name = p.name;
  return { id: group.id, name: group.name, type: group.type, childCount: group.children.length };
}

async function ungroupNode(params) {
  const p = params || {};
  if (!p.nodeId) throw new Error("Missing nodeId");
  const node = await figma.getNodeByIdAsync(p.nodeId);
  if (!node) throw new Error("Node not found");
  if (node.type !== "GROUP") {
    throw new Error("Not a GROUP: " + node.type);
  }
  const children = figma.ungroup(node);
  return {
    ungroupedFrom: p.nodeId,
    children: children.map(function (c) {
      return { id: c.id, name: c.name, type: c.type };
    }),
  };
}

async function bringToFront(params) {
  const p = params || {};
  if (!p.nodeId) throw new Error("Missing nodeId");
  const node = await figma.getNodeByIdAsync(p.nodeId);
  if (!node) throw new Error("Node not found");
  if (!node.parent) throw new Error("Node has no parent");
  node.parent.appendChild(node); // appendChild moves to end (front)
  return { id: node.id, parentId: node.parent.id, index: node.parent.children.indexOf(node) };
}

async function sendToBack(params) {
  const p = params || {};
  if (!p.nodeId) throw new Error("Missing nodeId");
  const node = await figma.getNodeByIdAsync(p.nodeId);
  if (!node) throw new Error("Node not found");
  if (!node.parent) throw new Error("Node has no parent");
  node.parent.insertChild(0, node);
  return { id: node.id, parentId: node.parent.id, index: 0 };
}
