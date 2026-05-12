#!/usr/bin/env bun

import { Server, ServerWebSocket } from "bun";

// Store clients by channel
const channels = new Map<string, Set<ServerWebSocket<any>>>();

// Channel name allow-list. Anything else is rejected to prevent stuffing
// the channel map with arbitrary strings (memory + log noise) and to
// reduce the chance of accidental cross-channel collisions.
const CHANNEL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function rejectChannelName(ws: ServerWebSocket<any>, reason: string): void {
  ws.send(JSON.stringify({
    type: "error",
    message: reason,
  }));
}

// Returns true if the channel name passes validation, false (and replies
// with an error) otherwise.
function validateChannelName(ws: ServerWebSocket<any>, name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0) {
    rejectChannelName(ws, "Channel name is required");
    return false;
  }
  if (!CHANNEL_NAME_RE.test(name)) {
    rejectChannelName(
      ws,
      "Invalid channel name (allowed: 1-64 chars, [a-zA-Z0-9_-])"
    );
    return false;
  }
  return true;
}

function handleConnection(ws: ServerWebSocket<any>) {
  // Don't add to clients immediately - wait for channel join
  console.log("New client connected");

  // Send welcome message to the new client
  ws.send(JSON.stringify({
    type: "system",
    message: "Please join a channel to start chatting",
  }));
}

function handleDisconnect(ws: ServerWebSocket<any>) {
  console.log("Client disconnected");

  channels.forEach((clients, channelName) => {
    if (!clients.has(ws)) return;
    clients.delete(ws);

    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: "system",
          message: "A user has left the channel",
          channel: channelName
        }));
      }
    });
  });
}

const server = Bun.serve({
  port: 3055,
  // uncomment this to allow connections in windows wsl
  // hostname: "0.0.0.0",
  fetch(req: Request, server: Server) {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // Handle WebSocket upgrade
    const success = server.upgrade(req, {
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    });

    if (success) {
      return; // Upgraded to WebSocket
    }

    // Return response for non-WebSocket requests
    return new Response("WebSocket server running", {
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
  websocket: {
    open: handleConnection,
    message(ws: ServerWebSocket<any>, message: string | Buffer) {
      try {
        // Bun delivers either string or Buffer depending on the frame opcode.
        // Coerce to string explicitly; rejecting binary outright would break
        // browsers that send TextEncoder-encoded payloads.
        const text = typeof message === "string" ? message : message.toString("utf8");
        const data = JSON.parse(text);
        console.log(`\n=== Received message from client ===`);
        console.log(`Type: ${data.type}, Channel: ${data.channel || 'N/A'}`);
        if (data.message?.command) {
          console.log(`Command: ${data.message.command}, ID: ${data.id}`);
        } else if (data.message?.result) {
          console.log(`Response: ID: ${data.id}, Has Result: ${!!data.message.result}`);
        }
        console.log(`Full message:`, JSON.stringify(data, null, 2));

        if (data.type === "join") {
          const channelName = data.channel;
          if (!validateChannelName(ws, channelName)) return;

          // Create channel if it doesn't exist
          if (!channels.has(channelName)) {
            channels.set(channelName, new Set());
          }

          // Add client to channel
          const channelClients = channels.get(channelName)!;
          channelClients.add(ws);

          console.log(`\n✓ Client joined channel "${channelName}" (${channelClients.size} total clients)`);

          // Notify client they joined successfully
          ws.send(JSON.stringify({
            type: "system",
            message: `Joined channel: ${channelName}`,
            channel: channelName
          }));

          ws.send(JSON.stringify({
            type: "system",
            message: {
              id: data.id,
              result: "Connected to channel: " + channelName,
            },
            channel: channelName
          }));

          // Notify other clients in channel
          channelClients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: "system",
                message: "A new user has joined the channel",
                channel: channelName
              }));
            }
          });
          return;
        }

        // Handle regular messages
        if (data.type === "message") {
          const channelName = data.channel;
          if (!validateChannelName(ws, channelName)) return;

          const channelClients = channels.get(channelName);
          if (!channelClients || !channelClients.has(ws)) {
            ws.send(JSON.stringify({
              type: "error",
              message: "You must join the channel first"
            }));
            return;
          }

          // Broadcast to all OTHER clients in the channel (not the sender)
          // This prevents echo and ensures proper request-response flow
          let broadcastCount = 0;
          channelClients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              broadcastCount++;
              const broadcastMessage = {
                type: "broadcast",
                message: data.message,
                sender: "peer",
                channel: channelName
              };
              console.log(`\n=== Broadcasting to peer #${broadcastCount} ===`);
              console.log(JSON.stringify(broadcastMessage, null, 2));
              client.send(JSON.stringify(broadcastMessage));
            }
          });
          
          if (broadcastCount === 0) {
            console.log(`⚠️  No other clients in channel "${channelName}" to receive message!`);
          } else {
            console.log(`✓ Broadcast to ${broadcastCount} peer(s) in channel "${channelName}"`);
          }
        }

        // Forward progress_update messages to the MCP server so it can reset
        if (data.type === "progress_update") {
          const channelName = data.channel;
          if (!channelName) return;

          const channelClients = channels.get(channelName);
          if (!channelClients || !channelClients.has(ws)) return;

          channelClients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify(data));
            }
          });
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error("Error handling message:", reason);
        // Reply to sender so they don't wait forever for a malformed message.
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: "error",
              message: `Bad message: ${reason}`,
            }));
          }
        } catch (sendErr) {
          console.error("Failed to send error reply:", sendErr);
        }
      }
    },
    close(ws: ServerWebSocket<any>) {
      handleDisconnect(ws);
    }
  }
});

console.log(`WebSocket server running on port ${server.port}`);
