import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { initDatabase } from "../../db";
import { createApp } from "../server";
import { loadApiConfig, type ApiConfig } from "../config";
import { createTestEventStore, resetEventStore, setEventStore } from "../../nats/jetstream";

let db: Database;
let app: ReturnType<typeof createApp>;
const apiKey = "test-api-key-activity-transcript";

beforeEach(async () => {
  db = await initDatabase(":memory:");
  const config: ApiConfig = {
    ...loadApiConfig(),
    apiKey,
  };

  setEventStore(createTestEventStore());
  app = createApp(db, config);

  const now = new Date().toISOString();
  db.run(
    `INSERT INTO arms (id, name, domain, harness, status, context_budget, current_context_used, created_at, updated_at, config, host)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
            (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "arm-a",
      "Arm A",
      "development",
      "opencode-api",
      "idle",
      100000,
      0,
      now,
      now,
      JSON.stringify({ workdir: "/Users/tim/developer/coleo" }),
      "host-a",
      "arm-b",
      "Arm B",
      "development",
      "opencode-api",
      "idle",
      100000,
      0,
      now,
      now,
      JSON.stringify({ workdir: "/Users/tim/developer/other-project" }),
      "host-b",
    ],
  );
});

afterEach(() => {
  resetEventStore();
  db.close();
});

describe("Activity transcript route", () => {
  it("returns oldest-first transcript entries across selected arms", async () => {
    const store = createTestEventStore();
    setEventStore(store);

    await store.publishEvent("coleo.events.arm.arm-b.message", {
      type: "message.received",
      armId: "arm-b",
      data: { message: "third" },
      timestamp: "2026-02-13T00:00:03.000Z",
    });
    await store.publishEvent("coleo.events.arm.arm-a.prompt", {
      type: "prompt.sent",
      armId: "arm-a",
      data: { prompt: "second" },
      timestamp: "2026-02-13T00:00:02.000Z",
    });
    await store.publishEvent("coleo.events.arm.arm-a.message", {
      type: "message.received",
      armId: "arm-a",
      data: { message: "first" },
      timestamp: "2026-02-13T00:00:01.000Z",
    });

    const response = await app.request(
      new Request("http://localhost/api/activity/transcript?armId=arm-a,arm-b&limit=10", {
        headers: { "X-API-Key": apiKey },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      transcript: Array<{ armId: string; timestamp: string; text: string; partitions: { project: string | null } }>;
      pagination: { order: string; returned: number };
    };

    expect(body.pagination.order).toBe("asc");
    expect(body.pagination.returned).toBe(3);
    expect(body.transcript.map((entry) => entry.timestamp)).toEqual([
      "2026-02-13T00:00:01.000Z",
      "2026-02-13T00:00:02.000Z",
      "2026-02-13T00:00:03.000Z",
    ]);
    expect(body.transcript[0]?.armId).toBe("arm-a");
    expect(body.transcript[0]?.text).toContain("first");
    expect(body.transcript[0]?.partitions.project).toBe("coleo");
  });

  it("filters transcript by host and project partitions", async () => {
    const store = createTestEventStore();
    setEventStore(store);

    await store.publishEvent("coleo.events.arm.arm-a.message", {
      type: "message.received",
      armId: "arm-a",
      data: { message: "from coleo" },
      timestamp: "2026-02-13T00:00:01.000Z",
    });
    await store.publishEvent("coleo.events.arm.arm-b.message", {
      type: "message.received",
      armId: "arm-b",
      data: { message: "from other project" },
      timestamp: "2026-02-13T00:00:02.000Z",
    });

    const response = await app.request(
      new Request("http://localhost/api/activity/transcript?host=host-a&project=coleo&limit=10", {
        headers: { "X-API-Key": apiKey },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      transcript: Array<{ armId: string; partitions: { host: string | null; project: string | null } }>;
    };

    expect(body.transcript).toHaveLength(1);
    expect(body.transcript[0]?.armId).toBe("arm-a");
    expect(body.transcript[0]?.partitions.host).toBe("host-a");
    expect(body.transcript[0]?.partitions.project).toBe("coleo");
  });

  it("returns unavailable indexer health when NATS is not connected", async () => {
    const response = await app.request(
      new Request("http://localhost/api/activity/indexer-health", {
        headers: { "X-API-Key": apiKey },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      consumerFound: boolean;
      message?: string;
    };

    expect(body.status).toBe("unavailable");
    expect(body.consumerFound).toBe(false);
    expect(typeof body.message).toBe("string");
  });
});
