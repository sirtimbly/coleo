import { describe, it, beforeEach, expect } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { createTaskDiffsRoutes } from "../routes/task-diffs";
import { HttpError } from "../middleware/error";

interface DiffResponse {
  diff: {
    id: string;
    taskId: string;
    title?: string;
    filePath?: string;
    diff: string;
    additions: number;
    deletions: number;
    authorType: string;
    authorId: string;
    createdAt: string;
    updatedAt: string;
  };
}

interface DiffsListResponse {
  diffs: DiffResponse["diff"][];
  totalCount: number;
}

const SAMPLE_DIFF = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 line one
+added line
-removed line
 line three
`;

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

    CREATE TABLE task_diffs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      title TEXT,
      file_path TEXT,
      diff TEXT NOT NULL,
      additions INTEGER NOT NULL DEFAULT 0,
      deletions INTEGER NOT NULL DEFAULT 0,
      author_type TEXT NOT NULL CHECK (author_type IN ('arm', 'brain', 'human')),
      author_id TEXT NOT NULL,
      author_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_task_diffs_task ON task_diffs(task_id, created_at DESC);

    CREATE TABLE task_diff_views (
      task_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      last_viewed_diff_id TEXT,
      viewed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (task_id, user_id),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
  `);

  const now = new Date("2026-01-16T00:00:00Z").toISOString();
  db.run(
    `INSERT INTO tasks (id, subject, description, status, priority, created_at, updated_at)
     VALUES ('task-1', 'Sample Task', 'desc', 'pending', 'normal', ?, ?)`,
    [now, now]
  );

  return db;
}

describe("Task Diffs API", () => {
  let db: Database;
  let app: Hono<{ Variables: { db: Database } }>;

  beforeEach(() => {
    db = createTestDb();
    const diffsApp = createTaskDiffsRoutes();
    app = new Hono<{ Variables: { db: Database } }>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      return next();
    });
    app.route("/api/tasks/:id/diffs", diffsApp);
    app.onError((err, c) => {
      if (err instanceof HttpError) {
        return c.json({ error: err.message }, err.status as 400 | 401 | 403 | 404 | 500);
      }
      console.error("Unexpected error:", err);
      return c.json({ error: "Internal server error" }, 500);
    });
  });

  describe("POST /api/tasks/:id/diffs", () => {
    it("creates a new diff entry and auto-computes stats", async () => {
      const res = await app.request("/api/tasks/task-1/diffs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Fix status consumer filter",
          filePath: "src/foo.ts",
          diff: SAMPLE_DIFF,
          authorType: "arm",
          authorId: "arm-1",
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as DiffResponse;
      expect(body.diff.title).toBe("Fix status consumer filter");
      expect(body.diff.filePath).toBe("src/foo.ts");
      expect(body.diff.additions).toBe(1);
      expect(body.diff.deletions).toBe(1);
      expect(body.diff.authorId).toBe("arm-1");
    });

    it("uses explicit additions/deletions when provided", async () => {
      const res = await app.request("/api/tasks/task-1/diffs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          diff: SAMPLE_DIFF,
          additions: 10,
          deletions: 2,
          authorType: "brain",
          authorId: "brain-1",
        }),
      });

      const body = (await res.json()) as DiffResponse;
      expect(body.diff.additions).toBe(10);
      expect(body.diff.deletions).toBe(2);
    });

    it("rejects missing diff content", async () => {
      const res = await app.request("/api/tasks/task-1/diffs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authorType: "arm", authorId: "arm-1" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid authorType", async () => {
      const res = await app.request("/api/tasks/task-1/diffs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diff: SAMPLE_DIFF, authorType: "robot", authorId: "arm-1" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for a non-existent task", async () => {
      const res = await app.request("/api/tasks/nope/diffs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diff: SAMPLE_DIFF, authorType: "arm", authorId: "arm-1" }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/tasks/:id/diffs", () => {
    it("lists diffs newest first", async () => {
      await app.request("/api/tasks/task-1/diffs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diff: SAMPLE_DIFF, title: "first", authorType: "arm", authorId: "arm-1" }),
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await app.request("/api/tasks/task-1/diffs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diff: SAMPLE_DIFF, title: "second", authorType: "arm", authorId: "arm-1" }),
      });

      const res = await app.request("/api/tasks/task-1/diffs");
      const body = (await res.json()) as DiffsListResponse;

      expect(body.totalCount).toBe(2);
      expect(body.diffs[0]?.title).toBe("second");
    });
  });

  describe("GET /api/tasks/:id/diffs/:diffId", () => {
    it("returns a single diff's full content", async () => {
      const createRes = await app.request("/api/tasks/task-1/diffs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diff: SAMPLE_DIFF, authorType: "arm", authorId: "arm-1" }),
      });
      const created = (await createRes.json()) as DiffResponse;

      const res = await app.request(`/api/tasks/task-1/diffs/${created.diff.id}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as DiffResponse;
      expect(body.diff.diff).toBe(SAMPLE_DIFF);
    });

    it("returns 404 for a non-existent diff", async () => {
      const res = await app.request("/api/tasks/task-1/diffs/nope");
      expect(res.status).toBe(404);
    });
  });

  describe("viewing tracking", () => {
    it("reports full unviewed count before any view is recorded", async () => {
      await app.request("/api/tasks/task-1/diffs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diff: SAMPLE_DIFF, authorType: "arm", authorId: "arm-1" }),
      });
      await app.request("/api/tasks/task-1/diffs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diff: SAMPLE_DIFF, authorType: "arm", authorId: "arm-1" }),
      });

      const res = await app.request("/api/tasks/task-1/diffs/unviewed?userId=user-1");
      const body = (await res.json()) as { unviewedCount: number };
      expect(body.unviewedCount).toBe(2);
    });

    it("marks diffs viewed and reduces unviewed count for subsequent diffs only", async () => {
      const first = await app.request("/api/tasks/task-1/diffs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diff: SAMPLE_DIFF, authorType: "arm", authorId: "arm-1" }),
      });
      const firstDiff = (await first.json()) as DiffResponse;

      await new Promise((resolve) => setTimeout(resolve, 5));

      await app.request("/api/tasks/task-1/diffs/mark-viewed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user-1", lastViewedDiffId: firstDiff.diff.id }),
      });

      await new Promise((resolve) => setTimeout(resolve, 5));

      await app.request("/api/tasks/task-1/diffs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diff: SAMPLE_DIFF, authorType: "arm", authorId: "arm-1" }),
      });

      const res = await app.request("/api/tasks/task-1/diffs/unviewed?userId=user-1");
      const body = (await res.json()) as { unviewedCount: number };
      expect(body.unviewedCount).toBe(1);
    });

    it("requires userId for unviewed count", async () => {
      const res = await app.request("/api/tasks/task-1/diffs/unviewed");
      expect(res.status).toBe(400);
    });

    it("rejects marking viewed with an unknown diff id", async () => {
      const res = await app.request("/api/tasks/task-1/diffs/mark-viewed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user-1", lastViewedDiffId: "nope" }),
      });
      expect(res.status).toBe(400);
    });
  });
});
