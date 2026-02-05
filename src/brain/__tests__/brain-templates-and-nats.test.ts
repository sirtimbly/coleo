import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { Brain } from "../brain";
import { BrainTemplateManager } from "../template-manager";
import { EventStore, setEventStore, type EventData } from "../../nats/jetstream";

describe("Brain template rendering", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join("/tmp", `coleo-brain-template-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const templateDir = join(testDir, "src", "brain", "templates");
    await mkdir(templateDir, { recursive: true });
    await writeFile(join(templateDir, "test-template.jinja"), "Hello {{ name }}!", "utf-8");
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("renders a nunjucks template with context", async () => {
    const templates = new BrainTemplateManager(testDir, () => {});
    const result = await templates.renderTemplate("test-template.jinja", { name: "Octopai" });

    expect(result).toBe("Hello Octopai!");
  });
});

describe("Brain NATS event stream reads", () => {
  let testDir: string;
  let calls: Array<{ armId: string; limit: number }> = [];

  beforeEach(() => {
    testDir = join("/tmp", `coleo-brain-nats-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    calls = [];
  });

  afterEach(() => {
    // Restore the real event store to avoid leaking mocks
    setEventStore(new EventStore());
  });

  it("reads recent arm events from the event store and transforms them", async () => {
    const now = Date.now();
    const events: EventData[] = [
      { type: "heartbeat", armId: "arm-1", data: { ok: true }, timestamp: new Date(now - 2 * 60 * 1000).toISOString() },
      { type: "tool_call", armId: "arm-1", data: { tool: "rg" }, timestamp: new Date(now - 30 * 1000).toISOString() },
      { type: "file_changed", armId: "arm-1", data: { path: "src/a.ts" }, timestamp: new Date(now - 90 * 1000).toISOString() },
    ];

    setEventStore({
      publishEvent: async () => {},
      queryEvents: async () => [],
      getArmEvents: async (armId: string, limit: number = 50) => {
        calls.push({ armId, limit });
        return events;
      },
      getEventsByType: async () => [],
      getRecentEvents: async () => [],
      isInitialized: () => true,
    });

    const brain = new Brain({
      coleoDir: testDir,
      pollIntervalMs: 1000,
      verbose: false,
    });

    const result = await (brain as unknown as { getRecentArmActivity: (armId: string, minutes: number) => Promise<Array<{timestamp: string; action: string; details: string}> | null> })
      .getRecentArmActivity("arm-1", 5);

    expect(calls).toEqual([{ armId: "arm-1", limit: 100 }]);
    expect(result).toBeTruthy();
    expect(result!.length).toBe(3);

    // Sorted descending by timestamp
    expect(result![0]?.action).toBe("tool_call");
    expect(result![1]?.action).toBe("file_changed");
    expect(result![2]?.action).toBe("heartbeat");

    // Data serialized to details
    expect(result![0]?.details).toContain("\"tool\":\"rg\"");
  });
});
