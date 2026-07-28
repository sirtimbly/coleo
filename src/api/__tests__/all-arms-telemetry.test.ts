import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";

import { createEventsRoutes } from "../routes/events";

interface TestContext {
  Variables: {
    db: Database;
  };
}

function createTestApp(): { app: Hono<TestContext>; db: Database } {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE arms (id TEXT PRIMARY KEY);
    CREATE TABLE arm_metric_history (
      arm_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      context_used INTEGER NOT NULL,
      context_budget INTEGER NOT NULL
    );
    CREATE TABLE arm_message_metrics (
      arm_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      cost REAL NOT NULL,
      message_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      reasoning_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL
    );
    INSERT INTO arms (id) VALUES ('arm-a'), ('arm-b');
    INSERT INTO arm_metric_history VALUES
      ('arm-a', '2026-07-28T10:00:00.000Z', 100, 1000),
      ('arm-b', '2026-07-28T10:01:00.000Z', 200, 2000),
      ('arm-a', '2026-07-28T11:00:00.000Z', 999, 1000);
    INSERT INTO arm_message_metrics VALUES
      ('arm-a', '2026-07-28T10:02:00.000Z', 0.25, 'message-1', 10, 20, 30, 40, 50),
      ('arm-b', '2026-07-28T11:00:00.000Z', 1.00, 'message-2', 1, 2, 3, 4, 5);
  `);

  const app = new Hono<TestContext>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/", createEventsRoutes());
  return { app, db };
}

describe("all-arm telemetry endpoint", () => {
  let database: Database | null = null;

  afterEach(() => {
    database?.close();
    database = null;
  });

  it("returns persisted telemetry for every arm within the exact bounds", async () => {
    const { app, db } = createTestApp();
    database = db;
    const response = await app.request(
      "http://coleo.test/telemetry?start=2026-07-28T09%3A59%3A00.000Z&end=2026-07-28T10%3A30%3A00.000Z",
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      armCount: number;
      contextSamples: Array<{ armId: string }>;
      costSamples: Array<{ armId: string; inputTokens: number; outputTokens: number }>;
    };
    expect(body.armCount).toBe(2);
    expect(body.contextSamples.map((sample) => sample.armId)).toEqual(["arm-a", "arm-b"]);
    expect(body.costSamples).toEqual([
      expect.objectContaining({ armId: "arm-a", inputTokens: 10, outputTokens: 20 }),
    ]);
  });
});
