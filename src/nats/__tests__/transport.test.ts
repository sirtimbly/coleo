import { describe, expect, it } from "bun:test";
import { usesWebSocketTransport } from "../transport";

describe("NATS transport selection", () => {
  it("uses native TCP for nats URLs", () => {
    expect(usesWebSocketTransport("nats://127.0.0.1:4222")).toBe(false);
    expect(usesWebSocketTransport(["nats://one:4222", "tls://two:4222"])).toBe(false);
  });

  it("uses WebSocket transport for ws and wss URLs", () => {
    expect(usesWebSocketTransport("wss://workspace.coleo.app/.reef/nats")).toBe(true);
    expect(usesWebSocketTransport("ws://127.0.0.1:9222")).toBe(true);
  });
});
