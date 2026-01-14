/**
 * WebSocket Server for real-time updates
 * 
 * Supports channel subscriptions:
 * - arms: Arm status changes
 * - activity: New activity entries
 * - proposals: Proposal updates
 * - brain: Brain status changes
 */

import type { ServerWebSocket } from "bun";

export type Channel = "arms" | "activity" | "proposals" | "brain" | "all";

export interface WSMessage {
  type: "subscribe" | "unsubscribe" | "ping" | "auth";
  channel?: Channel;
  apiKey?: string;
}

export interface WSBroadcast {
  channel: Channel;
  event: string;
  data: unknown;
  timestamp: string;
}

interface WSData {
  authenticated: boolean;
  subscriptions: Set<Channel>;
  lastPing: number;
}

// Track all connected clients
const clients = new Set<ServerWebSocket<WSData>>();

let _apiKey: string = "";
let _heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let _heartbeatEnabled = false;

/**
 * Enable heartbeat cleanup (only when WebSocket server is running)
 */
export function enableHeartbeat() {
  _heartbeatEnabled = true;
  if (!_heartbeatInterval) {
    _heartbeatInterval = setInterval(() => {
      if (!_heartbeatEnabled) return;
      const now = Date.now();
      const staleThreshold = 60000;
      
      for (const client of clients) {
        if (now - client.data.lastPing > staleThreshold) {
          console.log("[WS] Closing stale connection");
          client.close();
        }
      }
    }, 30000);
  }
}

/**
 * Disable heartbeat cleanup (for CLI usage)
 */
export function disableHeartbeat() {
  _heartbeatEnabled = false;
}

/**
 * Create WebSocket handlers for Bun.serve
 */
export function createWebSocketHandlers(apiKey: string) {
  _apiKey = apiKey;
  return {
    open(ws: ServerWebSocket<WSData>) {
      ws.data = {
        authenticated: false,
        subscriptions: new Set(),
        lastPing: Date.now(),
      };
      clients.add(ws);
      console.log(`[WS] Client connected (${clients.size} total)`);
    },

    message(ws: ServerWebSocket<WSData>, message: string | Buffer) {
      try {
        const msg: WSMessage = JSON.parse(message.toString());
        
        switch (msg.type) {
          case "auth":
            if (msg.apiKey === apiKey) {
              ws.data.authenticated = true;
              ws.send(JSON.stringify({ type: "auth", success: true }));
            } else {
              ws.send(JSON.stringify({ type: "auth", success: false, error: "Invalid API key" }));
            }
            break;

          case "subscribe":
            if (!ws.data.authenticated) {
              ws.send(JSON.stringify({ type: "error", error: "Not authenticated" }));
              return;
            }
            if (msg.channel) {
              ws.data.subscriptions.add(msg.channel);
              ws.send(JSON.stringify({ type: "subscribed", channel: msg.channel }));
              console.log(`[WS] Client subscribed to ${msg.channel}`);
            }
            break;

          case "unsubscribe":
            if (msg.channel) {
              ws.data.subscriptions.delete(msg.channel);
              ws.send(JSON.stringify({ type: "unsubscribed", channel: msg.channel }));
            }
            break;

          case "ping":
            ws.data.lastPing = Date.now();
            ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
            break;

          default:
            ws.send(JSON.stringify({ type: "error", error: "Unknown message type" }));
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", error: "Invalid message format" }));
      }
    },

    close(ws: ServerWebSocket<WSData>) {
      clients.delete(ws);
      console.log(`[WS] Client disconnected (${clients.size} remaining)`);
    },
  };
}

/**
 * Broadcast a message to all subscribed clients
 */
export function broadcast(channel: Channel, event: string, data: unknown) {
  const message: WSBroadcast = {
    channel,
    event,
    data,
    timestamp: new Date().toISOString(),
  };
  
  const payload = JSON.stringify(message);
  let sent = 0;
  
  for (const client of clients) {
    if (client.data.authenticated && 
        (client.data.subscriptions.has(channel) || client.data.subscriptions.has("all"))) {
      client.send(payload);
      sent++;
    }
  }
  
  if (sent > 0) {
    console.log(`[WS] Broadcast ${event} to ${sent} clients on ${channel}`);
  }
}

/**
 * Broadcast brain status change events
 */
export function broadcastBrainEvent(event: "started" | "stopped" | "paused" | "resumed" | "poll" | "config_updated", data: {
  status: string;
  pollIntervalMs?: number;
  activeArmsCount?: number;
  pendingTasksCount?: number;
  completedToday?: number;
  uptime?: number;
}) {
  broadcast("brain", `brain.${event}`, data);
}

/**
 * Get connected client count
 */
export function getClientCount(): number {
  return clients.size;
}

/**
 * Get authenticated client count
 */
export function getAuthenticatedCount(): number {
  let count = 0;
  for (const client of clients) {
    if (client.data.authenticated) count++;
  }
  return count;
}
