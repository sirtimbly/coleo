import { describe, it, expect } from "bun:test";
import {
  OpenCodeEventStream,
  truncateLargeFields,
  filterEvent,
  shouldPersistEvent,
} from "../event-stream";

const makeEvent = (type: string, properties: Record<string, unknown> = {}) => ({
  type,
  properties,
});

describe("event-stream utilities", () => {
  it("truncateLargeFields truncates strings and removes internal fields", () => {
    const input = {
      short: "ok",
      long: "a".repeat(30),
      nested: {
        items: ["b".repeat(40)],
        _fullEvent: "ignored",
      },
      _rawResponse: "ignored",
    };

    const result = truncateLargeFields(input, 10) as Record<string, unknown>;
    expect(result.short).toBe("ok");
    expect(result.long).toContain("truncated");
    const nested = result.nested as Record<string, unknown>;
    expect(nested._fullEvent).toBeUndefined();
    expect(result._rawResponse).toBeUndefined();
  });

  it("filterEvent ignores server.connected", () => {
    const result = filterEvent(makeEvent("server.connected"));
    expect(result.shouldBroadcast).toBe(false);
  });

  it("filterEvent maps session updates to status", () => {
    const result = filterEvent(makeEvent("session.updated", { status: "idle", id: "s1" }));
    expect(result.shouldBroadcast).toBe(true);
    expect(result.eventName).toBe("status");
    expect(result.data.status).toBe("idle");
  });

  it("filterEvent maps message events", () => {
    const result = filterEvent(makeEvent("message.created", { id: "m1", role: "assistant" }));
    expect(result.eventName).toBe("message-created");
    expect(result.data.role).toBe("assistant");
  });

  it("filterEvent maps part events", () => {
    const result = filterEvent(makeEvent("part.updated", { id: "p1", type: "tool", name: "run" }));
    expect(result.eventName).toBe("part-tool");
    expect(result.data.toolName).toBe("run");
  });

  it("filterEvent maps todo and file events", () => {
    const todo = filterEvent(makeEvent("todo.updated", { items: [] }));
    expect(todo.eventName).toBe("todo.updated");

    const file = filterEvent(makeEvent("file.edited", { path: "src/index.ts" }));
    expect(file.eventName).toBe("file.edited");
    expect(file.data.path).toBe("src/index.ts");
  });

  it("filterEvent defaults to kebabbed event name", () => {
    const result = filterEvent(makeEvent("custom.event", { foo: "bar" }));
    expect(result.eventName).toBe("custom-event");
  });
});

describe("OpenCodeEventStream internals", () => {
  it("parseAndEmitEvent emits parsed JSON events", () => {
    const events: Array<{ type: string; properties: Record<string, unknown> }> = [];
    const stream = new OpenCodeEventStream({
      serverUrl: "http://example.test",
      armId: "arm-1",
      sessionId: "session-1",
      onEvent: event => events.push(event),
    });

    const payload = JSON.stringify({ type: "message.created", properties: { id: "m1" } });
    (stream as unknown as { parseAndEmitEvent: (value: string) => void }).parseAndEmitEvent(
      `event: message\ndata: ${payload}`
    );

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("message.created");
    expect(events[0].properties.armId).toBe("arm-1");
    expect(events[0].properties.sessionId).toBe("session-1");
  });

  it("parseAndEmitEvent wraps non-JSON data", () => {
    const events: Array<{ type: string; properties: Record<string, unknown> }> = [];
    const stream = new OpenCodeEventStream({
      serverUrl: "http://example.test",
      armId: "arm-2",
      sessionId: "session-2",
      onEvent: event => events.push(event),
    });

    (stream as unknown as { parseAndEmitEvent: (value: string) => void }).parseAndEmitEvent(
      "event: custom\ndata: not-json"
    );

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("custom");
    expect(events[0].properties.raw).toBe("not-json");
  });

  it("connects and processes an SSE stream", async () => {
    const originalFetch = globalThis.fetch;
    const events: Array<{ type: string; properties: Record<string, unknown> }> = [];
    const stream = new OpenCodeEventStream({
      serverUrl: "http://example.test",
      armId: "arm-3",
      sessionId: "session-3",
      onEvent: event => events.push(event),
    });

    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            "event: message\n" +
              "data: {\"type\":\"message.created\",\"properties\":{\"id\":\"m2\"}}\n\n"
          )
        );
        controller.close();
      },
    });

    globalThis.fetch = async () =>
      ({ ok: true, status: 200, statusText: "OK", body } as Response);

    try {
      await (stream as unknown as { connect: () => Promise<void> }).connect();
    } finally {
      stream.stop();
      globalThis.fetch = originalFetch;
    }

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("message.created");
  });
});

describe("shouldPersistEvent", () => {
  it("skips keepalive events", () => {
    const result = shouldPersistEvent(makeEvent("server.connected"));
    expect(result.shouldPersist).toBe(false);
    expect(result.reason).toContain("keepalive");
  });

  it("always persists session status changes", () => {
    expect(shouldPersistEvent(makeEvent("session.status")).shouldPersist).toBe(true);
    expect(shouldPersistEvent(makeEvent("session.idle")).shouldPersist).toBe(true);
    expect(shouldPersistEvent(makeEvent("session.error")).shouldPersist).toBe(true);
    expect(shouldPersistEvent(makeEvent("session.updated")).shouldPersist).toBe(true);
  });

  it("persists session.diff only when files exist", () => {
    const empty = shouldPersistEvent(makeEvent("session.diff", { diff: [] }));
    expect(empty.shouldPersist).toBe(false);

    const withFiles = shouldPersistEvent(
      makeEvent("session.diff", { diff: [{ file: "src/app.ts" }, { file: "" }] })
    );
    expect(withFiles.shouldPersist).toBe(true);
    expect(withFiles.fileChanges).toEqual(["src/app.ts"]);
  });

  it("persists completed message.updated events", () => {
    const noInfo = shouldPersistEvent(makeEvent("message.updated"));
    expect(noInfo.shouldPersist).toBe(false);

    const streaming = shouldPersistEvent(
      makeEvent("message.updated", { info: { id: "m1", role: "assistant", time: { created: 1 } } })
    );
    expect(streaming.shouldPersist).toBe(false);

    const completed = shouldPersistEvent(
      makeEvent("message.updated", {
        info: { id: "m1", role: "assistant", time: { completed: 10 }, modelID: "gpt-4o" },
      })
    );
    expect(completed.shouldPersist).toBe(true);
    expect(completed.messageData?.messageId).toBe("m1");
  });

  it("persists message.part.updated only for step-finish", () => {
    const noPart = shouldPersistEvent(makeEvent("message.part.updated"));
    expect(noPart.shouldPersist).toBe(false);

    const streaming = shouldPersistEvent(
      makeEvent("message.part.updated", { part: { type: "text-delta" } })
    );
    expect(streaming.shouldPersist).toBe(false);

    const stepFinish = shouldPersistEvent(
      makeEvent("message.part.updated", {
        part: {
          type: "step-finish",
          tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
          cost: 0.12,
        },
      })
    );
    expect(stepFinish.shouldPersist).toBe(true);
    expect(stepFinish.tokenData?.input).toBe(1);
    expect(stepFinish.tokenData?.cacheRead).toBe(4);
  });

  it("persists key events and ignores noisy ones", () => {
    expect(shouldPersistEvent(makeEvent("message.removed")).shouldPersist).toBe(true);
    expect(shouldPersistEvent(makeEvent("message.part.removed")).shouldPersist).toBe(true);
    expect(shouldPersistEvent(makeEvent("permission.asked")).shouldPersist).toBe(true);
    expect(shouldPersistEvent(makeEvent("permission.replied")).shouldPersist).toBe(true);
    expect(shouldPersistEvent(makeEvent("todo.updated")).shouldPersist).toBe(true);
    expect(shouldPersistEvent(makeEvent("file.edited", { file: "src/index.ts" })).shouldPersist).toBe(true);
    expect(shouldPersistEvent(makeEvent("file.watcher.updated")).shouldPersist).toBe(false);
    expect(shouldPersistEvent(makeEvent("command.executed")).shouldPersist).toBe(true);
  });

  it("defaults to non-persistent for unknown events", () => {
    const result = shouldPersistEvent(makeEvent("mystery.event"));
    expect(result.shouldPersist).toBe(false);
    expect(result.reason).toContain("unknown event type");
  });
});
