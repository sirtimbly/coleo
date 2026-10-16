import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createActivityRoutes } from "../routes/activity";
import { InMemoryEventStore } from "../../nats/in-memory-event-store";
import type { EventData } from "../../nats/jetstream-types";

interface TranscriptPage {
  transcript: Array<{ sequence: number; timestamp: string; text: string; armId: string }>;
  pagination: {
    cursorMode?: string;
    nextCursor: number;
    highWatermark: number;
    hasMore: boolean;
    truncated: boolean | null;
    truncationReason: string | null;
    scannedSequences: number;
    missingSequences: number;
    gap: string | null;
    order: string;
  };
}

let db: Database;
let store: InMemoryEventStore;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("CREATE TABLE arms (id TEXT PRIMARY KEY, host TEXT, config TEXT)");
  db.run("INSERT INTO arms VALUES (?, ?, ?)", ["a", "host-a", JSON.stringify({ workdir: "/remote/project-a" })]);
  db.run("INSERT INTO arms VALUES (?, ?, ?)", ["b", "host-b", JSON.stringify({ workdir: "/remote/project-b" })]);
  store = new InMemoryEventStore();
  store.initialize();
});

afterEach(() => db.close());

function app(fixture = store) {
  const router = new Hono<{ Variables: { db: Database } }>();
  router.use("*", async (c, next) => { c.set("db", db); await next(); });
  router.route("/api/activity", createActivityRoutes(fixture));
  return router;
}

async function publish(armId: string | undefined = "a", timestamp = "2026-01-01T00:00:00.000Z"): Promise<void> {
  await store.publishEvent(armId ? `coleo.events.arm.${armId}.message` : "coleo.events.api.poll", {
    type: "message", armId, timestamp, data: { message: "identical text" },
  });
}

async function page(query: string): Promise<TranscriptPage> {
  const response = await app().request(`/api/activity/transcript?${query}`);
  expect(response.status).toBe(200);
  return await response.json() as TranscriptPage;
}

describe("Transcript sequence cursor", () => {
  it("pages identical timestamps/text exactly once, independent of timestamp order", async () => {
    for (let i = 0; i < 35; i++) {
      await publish("a", i === 34 ? "2025-12-01T00:00:00.000Z" : undefined);
    }
    const sequences: number[] = [];
    let cursor = 0;
    for (let i = 0; i < 12; i++) {
      const result = await page(`afterSequence=${cursor}&limit=3&scanLimit=20`);
      expect(result.pagination.cursorMode).toBe("sequence-v1");
      expect(result.pagination.order).toBe("sequence-asc");
      sequences.push(...result.transcript.map(entry => entry.sequence));
      cursor = result.pagination.nextCursor;
      if (!result.pagination.hasMore) break;
      expect(result.pagination.truncated).toBe(true);
      expect(result.pagination.truncationReason).toBe("result-limit");
    }
    expect(sequences).toEqual(Array.from({ length: 35 }, (_, i) => i + 1));
    expect(cursor).toBe(35);
    const empty = await page("afterSequence=35");
    expect(empty.transcript).toEqual([]);
    expect(empty.pagination.nextCursor).toBe(35);
    expect(empty.pagination.truncated).toBe(false);
    await publish();
    expect((await page("afterSequence=35")).transcript.map(entry => entry.sequence)).toEqual([36]);
  });

  it("advances through filtered positions and truthfully reports scan truncation", async () => {
    await publish("b");
    await publish("b");
    await publish("a");
    await publish("b");
    const first = await page("afterSequence=0&armId=a&scanLimit=2&limit=10");
    expect(first.transcript).toEqual([]);
    expect(first.pagination).toMatchObject({
      nextCursor: 2, highWatermark: 4, scannedSequences: 2,
      hasMore: true, truncated: true, truncationReason: "scan-limit",
    });
    const second = await page("afterSequence=2&armId=a&scanLimit=2&limit=10");
    expect(second.transcript.map(entry => entry.sequence)).toEqual([3]);
    expect(second.pagination).toMatchObject({ nextCursor: 4, hasMore: false, truncated: false });
  });

  it("preserves all partition/time/project filters while scanning forward", async () => {
    await publish("a", "2025-01-01T00:00:00.000Z");
    await publish("b");
    await publish("a");
    await publish("a");
    const foreign = await store.getEvent(4);
    foreign!.projectKey = "foreign-project";
    await publish("a", "2027-01-01T00:00:00.000Z");
    const result = await page("afterSequence=0&armId=a,b&host=host-a&project=project-a"
      + "&since=2026-01-01T00:00:00Z&until=2026-12-31T00:00:00Z");
    expect(result.transcript.map(entry => entry.sequence)).toEqual([3]);
    expect(result.pagination.nextCursor).toBe(5);
    const noArms = await page("afterSequence=0&host=no-such-host");
    expect(noArms.transcript).toEqual([]);
    expect(noArms.pagination.nextCursor).toBe(5);
  });

  it("does not emit events without an arm ID", async () => {
    await store.publishEvent("coleo.events.api.poll", {
      type: "poll", timestamp: "2026-01-01T00:00:00Z", data: {},
    });
    await publish();
    const result = await page("afterSequence=0");
    expect(result.transcript.map(entry => entry.sequence)).toEqual([2]);
    expect(result.pagination.nextCursor).toBe(2);
  });

  it("keeps legacy timestamp ordering and explicitly marks unknown scan exhaustion", async () => {
    await publish("a", "2026-01-02T00:00:00Z");
    await publish("a", "2026-01-01T00:00:00Z");
    const legacy = await page("limit=10");
    expect(legacy.pagination.order).toBe("asc");
    expect(legacy.pagination.cursorMode).toBeUndefined();
    expect(legacy.transcript.map(entry => entry.sequence)).toEqual([2, 1]);
    expect(legacy.pagination.truncated).toBeNull();
    const limited = await page("limit=1");
    expect(limited.pagination.truncated).toBe(true);
  });

  it("handles an empty stream and rejects invalid cursors before any stream reads", async () => {
    const empty = await page("afterSequence=0");
    expect(empty.pagination).toMatchObject({ nextCursor: 0, highWatermark: 0, truncated: false });
    for (const value of ["-1", "1.5", "", "NaN", "9007199254740992"]) {
      const response = await app().request(`/api/activity/transcript?afterSequence=${value}`);
      expect(response.status).toBe(400);
    }
  });

  it("reports a stream-reset/ahead cursor instead of silently rewinding", async () => {
    await publish();
    const result = await page("afterSequence=99");
    expect(result.pagination).toMatchObject({ gap: "cursor-ahead-of-stream", nextCursor: 99 });
    expect(result.transcript).toEqual([]);
  });

  it("reports retention/deleted positions using the store's real position contract", async () => {
    class RetainedStore extends InMemoryEventStore {
      override async getStreamMetrics() {
        return { ...await super.getStreamMetrics(), firstSequence: 3 };
      }
      override async getEvent(sequence: number): Promise<EventData | null> {
        return sequence === 4 ? null : super.getEvent(sequence);
      }
    }
    const retained = new RetainedStore();
    retained.initialize();
    for (let i = 0; i < 5; i++) {
      await retained.publishEvent("coleo.events.arm.a.message", {
        type: "message", armId: "a", timestamp: "2026-01-01T00:00:00Z", data: {},
      });
    }
    const route = app(retained);
    const lost = await (await route.request("/api/activity/transcript?afterSequence=1")).json() as TranscriptPage;
    expect(lost.pagination.gap).toBe("retention");
    const fresh = await (await route.request("/api/activity/transcript?afterSequence=0")).json() as TranscriptPage;
    expect(fresh.transcript.map(entry => entry.sequence)).toEqual([3, 5]);
    expect(fresh.pagination).toMatchObject({ nextCursor: 5, gap: "missing-sequences", missingSequences: 1 });
  });

  it("does not turn failed direct reads into an empty successful page", async () => {
    class FailingStore extends InMemoryEventStore {
      override async getEvent(): Promise<EventData | null> { throw new Error("fixture read failed"); }
    }
    const failed = new FailingStore();
    failed.initialize();
    await failed.publishEvent("coleo.events.arm.a.message", {
      type: "message", armId: "a", timestamp: "2026-01-01T00:00:00Z", data: {},
    });
    const response = await app(failed).request("/api/activity/transcript?afterSequence=0");
    expect(response.status).toBe(500);
  });
});
