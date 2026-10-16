import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { initDatabase } from "../../db";
import { HttpError } from "../middleware/error";
import { createTasksRoutes } from "../routes/tasks";
import type { Database } from "bun:sqlite";
import type { Task } from "../routes/tasks";

describe("task list sort contract", () => {
  let db: Database;
  let app: Hono<{ Variables: { db: Database } }>;

  beforeEach(async () => {
    db = await initDatabase(":memory:");
    app = new Hono<{ Variables: { db: Database } }>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      await next();
    });
    app.onError((error, c) => {
      if (error instanceof HttpError) return c.json({ error: error.message }, 400);
      throw error;
    });
    app.route("/api/tasks", createTasksRoutes());

    // Workspace rank deliberately conflicts with creation dates. Within the
    // shared key, status and priority deliberately conflict with creation too.
    const rows = [
      ["old-key", "pending", "low", "a0", "2026-01-01"],
      ["old-draft", "draft", "low", "a1", "2026-01-02"],
      ["old-high", "pending", "high", "a1", "2026-01-03"],
      ["new-a", "pending", "low", "a1", "2026-01-05"],
      ["new-b", "pending", "low", "a1", "2026-01-05"],
      ["middle", "pending", "low", "a1", "2026-01-04"],
    ];
    for (const [id, status, priority, orderKey, createdAt] of rows) {
      db.run(`INSERT INTO tasks
        (id, subject, description, status, priority, order_key, created_at, updated_at)
        VALUES (?, '日本語 task', '', ?, ?, ?, ?, ?)`,
      [id!, status!, priority!, orderKey!, createdAt!, createdAt!]);
    }
  });

  afterEach(() => db.close());

  async function list(query = "") {
    const response = await app.request(`/api/tasks${query}`);
    expect(response.status).toBe(200);
    return await response.json() as { tasks: Task[]; pagination: { total: number } };
  }

  it("preserves default workspace, status, priority, and creation ordering", async () => {
    const result = await list();
    const ids = result.tasks.map((task) => task.id);
    expect(ids.slice(0, 3)).toEqual(["old-key", "old-draft", "old-high"]);
    expect(new Set(ids.slice(3, 5))).toEqual(new Set(["new-a", "new-b"]));
    expect(ids[5]).toBe("middle");
    expect(result.pagination.total).toBe(6);
  });

  it("sorts in SQL before limiting with a stable ID tie-breaker", async () => {
    const first = await list("?sort=created-desc&limit=2");
    const second = await list("?sort=created-desc&limit=2&offset=2");
    expect(first.tasks.map((task) => task.id)).toEqual(["new-a", "new-b"]);
    expect(second.tasks.map((task) => task.id)).toEqual(["middle", "old-high"]);
    expect(first.pagination.total).toBe(6);
    expect(second.pagination.total).toBe(6);
  });

  it("preserves filtering and Unicode fallback pagination in newest-first order", async () => {
    for (const search of ["task", "日本語"]) {
      const query = new URLSearchParams({ sort: "created-desc", status: "pending", search, limit: "2", offset: "2" });
      const result = await list(`?${query}`);
      expect(result.tasks.map((task) => task.id)).toEqual(["middle", "old-high"]);
      expect(result.pagination.total).toBe(5);
    }
  });

  it("rejects unsupported sort values instead of interpolating client SQL", async () => {
    for (const sort of ["", "created-asc", "t.created_at; DROP TABLE tasks"]) {
      const response = await app.request(`/api/tasks?${new URLSearchParams({ sort })}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "sort must be created-desc when supplied" });
    }
    expect((await list()).pagination.total).toBe(6);
  });
});
