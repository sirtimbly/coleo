import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";

import {
  detectBrainModelAccessIssue,
  serializeBrainModelAccessIssue,
} from "../../brain/model-access";
import { createBrainRoutes } from "../routes/brain";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE brain_state (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      poll_interval_ms INTEGER NOT NULL,
      started_at TEXT,
      last_poll_at TEXT,
      pending_tasks INTEGER NOT NULL DEFAULT 0,
      completed_today INTEGER NOT NULL DEFAULT 0,
      completed_task_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    INSERT INTO brain_state (id, status, poll_interval_ms, updated_at)
    VALUES (1, 'running', 30000, datetime('now'));

    CREATE TABLE arms (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      planning_blocked INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      source_type TEXT,
      blocked_category TEXT,
      blocked_reason TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE infrastructure_health (
      component TEXT PRIMARY KEY,
      healthy INTEGER NOT NULL,
      optional INTEGER NOT NULL,
      error TEXT,
      last_check TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

describe("brain status API", () => {
  let db: Database;
  let app: Hono<{ Variables: { db: Database } }>;

  beforeEach(() => {
    db = createTestDb();
    app = new Hono<{ Variables: { db: Database } }>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      await next();
    });
    app.route("/api/brain", createBrainRoutes());
  });

  afterEach(() => {
    db.close();
  });

  it("reports blocked, healthy, and pending project plan states", async () => {
    let response = await app.request("/api/brain/status");
    let body = await response.json() as { brain: { plan: { status: string; detail: string } } };
    expect(body.brain.plan.status).toBe("pending");

    db.run(
      "INSERT INTO tasks (id, status, source_type, updated_at) VALUES (?, ?, ?, ?)",
      ["plan-task", "pending", "plan", new Date().toISOString()],
    );
    response = await app.request("/api/brain/status");
    body = await response.json() as { brain: { plan: { status: string; detail: string } } };
    expect(body.brain.plan.status).toBe("healthy");
    expect(body.brain.plan.detail).toContain("1 plan task is synchronized");

    db.run(
      `UPDATE tasks SET status = 'blocked', blocked_category = 'planning', blocked_reason = ?, updated_at = ? WHERE id = ?`,
      [
        "Project planning must succeed before work can resume: Plan formatter returned 500: overloaded [planning-state:abc]",
        new Date().toISOString(),
        "plan-task",
      ],
    );
    response = await app.request("/api/brain/status");
    body = await response.json() as { brain: { plan: { status: string; detail: string } } };
    expect(body.brain.plan.status).toBe("blocked");
    expect(body.brain.plan.detail).toBe("Plan formatter returned 500: overloaded");
  });

  it("reports insufficient credits without changing runtime status", async () => {
    const issue = detectBrainModelAccessIssue(
      429,
      '{"error":{"message":"You have no credits remaining. Add credits to continue."}}',
      "openai",
    );
    expect(issue).not.toBeNull();
    if (!issue) return;

    db.run(
      `INSERT INTO infrastructure_health
        (component, healthy, optional, error, last_check, updated_at)
       VALUES (?, 0, 0, ?, ?, ?)`,
      [
        "brain_model_api",
        serializeBrainModelAccessIssue(issue),
        "2026-08-04T12:27:26.000Z",
        "2026-08-04T12:27:26.000Z",
      ],
    );

    const response = await app.request("/api/brain/status");
    const body = await response.json() as {
      brain: {
        status: string;
        modelAccess: {
          status: string;
          issueCode: string;
          actionUrl: string;
        };
      };
    };

    expect(response.status).toBe(200);
    expect(body.brain.status).toBe("running");
    expect(body.brain.modelAccess).toMatchObject({
      status: "blocked",
      issueCode: "insufficient_credits",
    });
    expect(body.brain.modelAccess.actionUrl).toContain("platform.openai.com");

    const recovered = await app.request("/api/brain/internal/infrastructure-health", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        components: [
          {
            component: "brain_model_api",
            healthy: true,
            optional: false,
          },
        ],
      }),
    });
    expect(recovered.status).toBe(200);

    const recoveredStatus = await app.request("/api/brain/status");
    const recoveredBody = await recoveredStatus.json() as {
      brain: { status: string; modelAccess: { status: string; issueCode: string | null } };
    };
    expect(recoveredBody.brain.modelAccess).toMatchObject({
      status: "available",
      issueCode: null,
    });
  });
});
