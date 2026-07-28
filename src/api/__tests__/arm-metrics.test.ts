import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";

import { recordMessageMetrics, recordMetricSnapshot } from "../arm-metrics";

function createDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE arms (
      id TEXT PRIMARY KEY,
      current_context_used INTEGER NOT NULL DEFAULT 0,
      context_budget INTEGER NOT NULL DEFAULT 100000,
      total_tokens INTEGER DEFAULT 0,
      total_cost REAL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE arm_metric_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      arm_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      context_used INTEGER NOT NULL,
      context_budget INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      total_cost REAL NOT NULL
    );
    CREATE TABLE arm_message_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      arm_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      session_id TEXT,
      timestamp TEXT NOT NULL,
      context_used INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      reasoning_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      cost REAL NOT NULL,
      UNIQUE (arm_id, message_id)
    );
    INSERT INTO arms (id, updated_at) VALUES ('arm-1', '2026-01-01T00:00:00.000Z');
  `);
  return db;
}

describe("arm message metrics", () => {
  it("updates context and cost idempotently from completed assistant messages", () => {
    const db = createDb();
    const data = {
      info: {
        id: "message-1",
        role: "assistant",
        sessionID: "session-1",
        time: { completed: "2026-07-28T10:00:00.000Z" },
        cost: 0.25,
        tokens: {
          input: 100,
          output: 20,
          reasoning: 5,
          cache: { read: 30, write: 2 },
        },
      },
    };

    recordMessageMetrics(db, "arm-1", "message.updated", data, "2026-07-28T10:00:00.000Z");
    recordMessageMetrics(db, "arm-1", "message.updated", data, "2026-07-28T10:00:01.000Z");

    const arm = db.query(
      "SELECT current_context_used as contextUsed, total_tokens as totalTokens, total_cost as totalCost FROM arms WHERE id = 'arm-1'",
    ).get() as { contextUsed: number; totalTokens: number; totalCost: number };
    expect(arm).toEqual({ contextUsed: 157, totalTokens: 157, totalCost: 0.25 });
    expect((db.query("SELECT COUNT(*) as count FROM arm_message_metrics").get() as { count: number }).count).toBe(1);
    expect((db.query("SELECT COUNT(*) as count FROM arm_metric_history").get() as { count: number }).count).toBe(1);
    db.close();
  });

  it("does not snapshot unchanged metrics", () => {
    const db = createDb();
    recordMetricSnapshot(db, "arm-1", "2026-07-28T10:00:00.000Z");
    recordMetricSnapshot(db, "arm-1", "2026-07-28T10:00:01.000Z");
    expect((db.query("SELECT COUNT(*) as count FROM arm_metric_history").get() as { count: number }).count).toBe(1);
    db.close();
  });
});
