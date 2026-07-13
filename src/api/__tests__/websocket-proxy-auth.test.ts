import { describe, expect, it } from "bun:test";

import { createProxyAwareWebSocketHandlers } from "../server";
import { createWebSocketHandlers } from "../websocket";

function createSocket(
  handlers: ReturnType<typeof createProxyAwareWebSocketHandlers>,
  authenticated: boolean,
) {
  const sent: string[] = [];
  const socket = {
    data: {
      authenticated,
      subscriptions: new Set(),
      lastPing: Date.now(),
    },
    send(message: string) {
      sent.push(message);
      return message.length;
    },
  } as unknown as Parameters<typeof handlers.open>[0];

  return { socket, sent };
}

describe("WebSocket proxy authentication", () => {
  it("preserves upgrade authentication and acknowledges the hosted client", () => {
    const handlers = createProxyAwareWebSocketHandlers(
      createWebSocketHandlers("private-key"),
    );
    const { socket, sent } = createSocket(handlers, true);

    handlers.open(socket);

    expect(socket.data.authenticated).toBe(true);
    expect(sent.map((message) => JSON.parse(message))).toEqual([
      { type: "auth", success: true },
    ]);
    handlers.close(socket);
  });

  it("still supports in-band API-key authentication for direct clients", () => {
    const handlers = createProxyAwareWebSocketHandlers(
      createWebSocketHandlers("private-key"),
    );
    const { socket, sent } = createSocket(handlers, false);

    handlers.open(socket);
    handlers.message(socket, JSON.stringify({ type: "auth", apiKey: "private-key" }));

    expect(socket.data.authenticated).toBe(true);
    expect(sent.map((message) => JSON.parse(message))).toEqual([
      { type: "auth", success: true },
    ]);
    handlers.close(socket);
  });
});
