import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";

import { createStatusSeriesRoutes } from "../routes/status-series";
import { formatErrorResponse } from "../middleware/error";
import { initDatabase } from "../../db";

import type { Database } from "bun:sqlite";

interface TestContext {
  Variables: {
    db: Database;
  };
}

describe("status series API", () => {
  let db: Database;
  let app: Hono<TestContext>;

  beforeEach(async () => {
    db = await initDatabase(":memory:");
    app = new Hono<TestContext>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      await next();
    });
    app.onError((error, c) => formatErrorResponse(c, error));
    app.route("/", createStatusSeriesRoutes());
  });

  afterEach(() => db.close());

  it("returns task status snapshots for every bucket", async () => {
    db.run(
      `INSERT INTO tasks (id, subject, description, status, priority, source_type, created_at, updated_at)
       VALUES ('task-1', 'Task', 'Description', 'pending', 'normal', 'manual', ?, ?)`,
      ["2026-07-28T00:00:00.000Z", "2026-07-28T00:00:00.000Z"],
    );
    db.run("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = 'task-1'", [
      "2026-07-28T00:30:00.000Z",
    ]);
    db.run("UPDATE tasks SET status = 'completed', updated_at = ? WHERE id = 'task-1'", [
      "2026-07-28T01:30:00.000Z",
    ]);

    const response = await app.request(
      "http://coleo.test/?entity=task&resolution=hour&start=2026-07-28T00%3A00%3A00.000Z&end=2026-07-28T03%3A00%3A00.000Z",
    );
    expect(response.status).toBe(200);
    const body = await response.json() as {
      buckets: Array<{ counts: Record<string, number>; total: number }>;
    };
    expect(body.buckets).toHaveLength(3);
    expect(body.buckets[0]).toMatchObject({ counts: { in_progress: 1 }, total: 1 });
    expect(body.buckets[1]).toMatchObject({ counts: { completed: 1 }, total: 1 });
    expect(body.buckets[2]).toMatchObject({ counts: { completed: 1 }, total: 1 });
  });

  it("supports bug status snapshots and excludes archived bugs", async () => {
    db.run(
      `INSERT INTO bugs (id, title, description, source, status, priority, created_at, updated_at)
       VALUES ('bug-1', 'Bug', 'Description', 'human_reported', 'open', 'medium', ?, ?)`,
      ["2026-07-28T00:00:00.000Z", "2026-07-28T00:00:00.000Z"],
    );
    db.run("UPDATE bugs SET status = 'fixing', updated_at = ? WHERE id = 'bug-1'", [
      "2026-07-28T00:30:00.000Z",
    ]);

    const visible = await app.request(
      "http://coleo.test/?entity=bug&resolution=hour&start=2026-07-28T00%3A00%3A00.000Z&end=2026-07-28T02%3A00%3A00.000Z",
    );
    const visibleBody = await visible.json() as { buckets: Array<{ counts: Record<string, number> }> };
    expect(visibleBody.buckets[0]?.counts.fixing).toBe(1);

    db.run("UPDATE bugs SET archived = 1 WHERE id = 'bug-1'");
    const archived = await app.request(
      "http://coleo.test/?entity=bug&resolution=hour&start=2026-07-28T00%3A00%3A00.000Z&end=2026-07-28T02%3A00%3A00.000Z",
    );
    const archivedBody = await archived.json() as { buckets: Array<{ total: number }> };
    expect(archivedBody.buckets.every((bucket) => bucket.total === 0)).toBe(true);
  });

  it("validates entity, resolution, and range", async () => {
    expect((await app.request("http://coleo.test/?entity=other&start=x&end=y")).status).toBe(400);
    expect((await app.request(
      "http://coleo.test/?entity=task&resolution=month&start=2026-01-01&end=2026-02-01",
    )).status).toBe(400);
  });
});
