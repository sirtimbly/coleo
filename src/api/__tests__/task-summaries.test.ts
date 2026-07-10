import { describe, it, beforeEach, expect } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { createTaskSummariesRoutes } from "../routes/task-summaries";
import { HttpError } from "../middleware/error";

interface SummaryResponse {
  summary: {
    id: string;
    taskId: string;
    content: string;
    authorType: string;
    authorId: string;
    authorName?: string;
    createdAt: string;
    updatedAt: string;
  };
}

interface SummariesListResponse {
  summaries: SummaryResponse["summary"][];
  latest: SummaryResponse["summary"] | null;
}

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE task_summaries (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      content TEXT NOT NULL,
      author_type TEXT NOT NULL CHECK (author_type IN ('arm', 'brain', 'human')),
      author_id TEXT NOT NULL,
      author_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_task_summaries_task ON task_summaries(task_id, created_at DESC);
  `);

  const now = new Date("2026-01-16T00:00:00Z").toISOString();
  db.run(
    `INSERT INTO tasks (id, subject, description, status, priority, created_at, updated_at)
     VALUES ('task-1', 'Sample Task', 'desc', 'pending', 'normal', ?, ?)`,
    [now, now]
  );

  return db;
}

describe("Task Summaries API", () => {
  let db: Database;
  let app: Hono<{ Variables: { db: Database } }>;

  beforeEach(() => {
    db = createTestDb();
    const summariesApp = createTaskSummariesRoutes();
    app = new Hono<{ Variables: { db: Database } }>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      return next();
    });
    app.route("/api/tasks/:id/summaries", summariesApp);
    app.onError((err, c) => {
      if (err instanceof HttpError) {
        return c.json({ error: err.message }, err.status as 400 | 401 | 403 | 404 | 500);
      }
      console.error("Unexpected error:", err);
      return c.json({ error: "Internal server error" }, 500);
    });
  });

  describe("POST /api/tasks/:id/summaries", () => {
    it("creates a new summary entry", async () => {
      const res = await app.request("/api/tasks/task-1/summaries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "Investigated the bug and reproduced it locally.",
          authorType: "arm",
          authorId: "arm-1",
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as SummaryResponse;
      expect(body.summary.content).toBe("Investigated the bug and reproduced it locally.");
      expect(body.summary.authorType).toBe("arm");
      expect(body.summary.authorId).toBe("arm-1");
      expect(body.summary.taskId).toBe("task-1");
    });

    it("rejects missing content", async () => {
      const res = await app.request("/api/tasks/task-1/summaries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authorType: "arm", authorId: "arm-1" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid authorType", async () => {
      const res = await app.request("/api/tasks/task-1/summaries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "x", authorType: "robot", authorId: "arm-1" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for a non-existent task", async () => {
      const res = await app.request("/api/tasks/nope/summaries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "x", authorType: "arm", authorId: "arm-1" }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/tasks/:id/summaries", () => {
    it("lists summaries newest first and exposes latest", async () => {
      await app.request("/api/tasks/task-1/summaries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "First pass", authorType: "arm", authorId: "arm-1" }),
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await app.request("/api/tasks/task-1/summaries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Second pass", authorType: "arm", authorId: "arm-1" }),
      });

      const res = await app.request("/api/tasks/task-1/summaries");
      const body = (await res.json()) as SummariesListResponse;

      expect(body.summaries).toHaveLength(2);
      expect(body.summaries[0]?.content).toBe("Second pass");
      expect(body.latest?.content).toBe("Second pass");
    });
  });

  describe("GET /api/tasks/:id/summaries/latest", () => {
    it("returns null when no summary exists", async () => {
      const res = await app.request("/api/tasks/task-1/summaries/latest");
      const body = (await res.json()) as { summary: null };
      expect(body.summary).toBeNull();
    });

    it("returns the most recent summary", async () => {
      await app.request("/api/tasks/task-1/summaries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Working on it", authorType: "brain", authorId: "brain-1" }),
      });

      const res = await app.request("/api/tasks/task-1/summaries/latest");
      const body = (await res.json()) as SummaryResponse;
      expect(body.summary.content).toBe("Working on it");
      expect(body.summary.authorType).toBe("brain");
    });
  });

  describe("PATCH /api/tasks/:id/summaries/:summaryId", () => {
    it("edits a summary's content", async () => {
      const createRes = await app.request("/api/tasks/task-1/summaries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Draft", authorType: "arm", authorId: "arm-1" }),
      });
      const created = (await createRes.json()) as SummaryResponse;

      const patchRes = await app.request(`/api/tasks/task-1/summaries/${created.summary.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Revised summary" }),
      });

      expect(patchRes.status).toBe(200);
      const patched = (await patchRes.json()) as SummaryResponse;
      expect(patched.summary.content).toBe("Revised summary");
    });

    it("returns 404 for a non-existent summary", async () => {
      const res = await app.request("/api/tasks/task-1/summaries/nope", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "x" }),
      });
      expect(res.status).toBe(404);
    });
  });
});
