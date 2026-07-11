import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { createStatusReportsRoutes } from "../routes/status-reports";
import { HttpError } from "../middleware/error";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE status_reports (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      arm_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('on_track', 'blocked', 'issues_found', 'needs_review', 'completed_with_issues')),
      summary TEXT NOT NULL,
      issues TEXT DEFAULT '[]',
      blockers TEXT DEFAULT '[]',
      next_steps TEXT,
      files_changed TEXT DEFAULT '[]',
      tests_status TEXT CHECK (tests_status IS NULL OR tests_status IN ('passing', 'failing', 'not_run')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
  `);

  const now = new Date("2026-01-16T00:00:00Z").toISOString();
  db.run(
    `INSERT INTO tasks (id, subject, description, status, priority, created_at, updated_at)
     VALUES ('task-1', 'Sample Task', 'desc', 'pending', 'normal', ?, ?)`,
    [now, now],
  );

  return db;
}

describe("Status Reports API", () => {
  let db: Database;
  let app: Hono<{ Variables: { db: Database } }>;

  beforeEach(() => {
    db = createTestDb();
    app = new Hono<{ Variables: { db: Database } }>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      return next();
    });
    app.route("/api/status-reports", createStatusReportsRoutes());
    app.onError((err, c) => {
      if (err instanceof HttpError) {
        return c.json({ error: err.message }, err.status as 400 | 401 | 403 | 404 | 500);
      }
      return c.json({ error: "Internal server error" }, 500);
    });
  });

  afterEach(() => {
    db.close();
  });

  describe("POST /api/status-reports", () => {
    it("creates a status report for an existing task", async () => {
      const res = await app.request("/api/status-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: "task-1",
          armId: "arm-1",
          status: "on_track",
          summary: "Making progress",
        }),
      });

      expect(res.status).toBe(201);
      const countRow = db.query("SELECT COUNT(*) as count FROM status_reports").get() as { count: number };
      expect(countRow.count).toBe(1);
    });

    it("returns 404 instead of 500 for a missing task", async () => {
      const res = await app.request("/api/status-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: "missing-task",
          armId: "arm-1",
          status: "on_track",
          summary: "This should not hit the FK constraint",
        }),
      });

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Task not found: missing-task");
    });
  });
});
