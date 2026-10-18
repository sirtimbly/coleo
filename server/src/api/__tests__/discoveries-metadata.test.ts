import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { MIGRATION_015 } from "../../db/migrations/schema-01";
import { HttpError } from "../middleware/error";
import { createDiscoveriesRoutes } from "../routes/discoveries";

describe("Discovery resolution metadata API", () => {
  let db: Database;
  let app: Hono<{ Variables: { db: Database } }>;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(MIGRATION_015);
    db.exec("ALTER TABLE discoveries ADD COLUMN task_id TEXT; ALTER TABLE discoveries ADD COLUMN phase TEXT;");
    db.run(`INSERT INTO discoveries
      (id, arm_id, arm_name, kind, title, details, metadata, created_at, updated_at)
      VALUES ('disc-1', 'arm-1', 'Worker', 'test_failure', 'Failure report', 'Complete failure details', ?, ?, ?)`,
    [JSON.stringify({ source: { file: "test.ts" }, tags: ["retain"], resolution_reason: "previous" }),
      "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]);
    app = new Hono<{ Variables: { db: Database } }>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      await next();
    });
    app.route("/api/discoveries", createDiscoveriesRoutes());
    app.onError((error, c) => c.json({ error: error.message },
      error instanceof HttpError ? error.status as 400 | 404 | 500 : 500));
  });

  afterEach(() => db.close());

  function patch(body: unknown, id = "disc-1"): Promise<Response> {
    return Promise.resolve(app.request(`/api/discoveries/${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }));
  }

  function row(): { status: string; metadata: string; updated_at: string } {
    return db.query("SELECT status, metadata, updated_at FROM discoveries WHERE id = 'disc-1'").get() as {
      status: string; metadata: string; updated_at: string;
    };
  }

  it.each(["resolved", "dismissed"])("persists %s reason and attribution, visible in history and detail", async status => {
    const response = await patch({ status, reason: "Fixed the failure", resolvedBy: "cli" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    const saved = row();
    const metadata = JSON.parse(saved.metadata);
    expect(saved.status).toBe(status);
    expect(metadata).toEqual({
      source: { file: "test.ts" }, tags: ["retain"], resolution_reason: "Fixed the failure",
      resolved_by: "cli", resolved_at: saved.updated_at,
    });
    expect(saved.updated_at).not.toBe("2026-01-01T00:00:00.000Z");
    const history = await (await app.request(`/api/discoveries?status=${status}`)).json();
    expect(history.discoveries[0].metadata).toEqual(metadata);
    expect(history.pagination.total).toBe(1);
    const detail = await (await app.request("/api/discoveries/disc-1")).json();
    expect(detail.discovery.metadata).toEqual(metadata);
    expect(detail.discovery.details).toBe("Complete failure details");
    const open = await (await app.request("/api/discoveries")).json();
    expect(open.discoveries).toEqual([]);
  });

  it("keeps status-only callers compatible and leaves existing metadata untouched", async () => {
    const before = row().metadata;
    for (const status of ["acknowledged", "resolved", "open", "dismissed"]) {
      expect((await patch({ status })).status).toBe(200);
      expect(row().status).toBe(status);
      expect(row().metadata).toBe(before);
    }
  });

  it("defaults reason-only attribution to api and permits explicit attribution without replacing the reason", async () => {
    expect((await patch({ status: "resolved", reason: "fixed" })).status).toBe(200);
    expect(JSON.parse(row().metadata).resolved_by).toBe("api");
    expect((await patch({ status: "resolved", resolvedBy: "operator" })).status).toBe(200);
    expect(JSON.parse(row().metadata)).toMatchObject({ resolved_by: "operator", resolution_reason: "fixed" });
  });

  it.each([null, "null", "[]", "42"])("initializes object metadata from legacy %j on resolution", async metadata => {
    db.run("UPDATE discoveries SET metadata = ? WHERE id = 'disc-1'", [metadata]);
    expect((await patch({ status: "resolved", reason: "fixed", resolvedBy: "cli" })).status).toBe(200);
    expect(JSON.parse(row().metadata)).toMatchObject({ resolution_reason: "fixed", resolved_by: "cli" });
  });

  it.each([null, [], "text", {}, { status: null }, { status: "" }, { status: "invalid" },
    { status: "resolved", reason: "" }, { status: "resolved", reason: "  " },
    { status: "resolved", reason: 42 }, { status: "resolved", reason: null },
    { status: "resolved", resolvedBy: "" }, { status: "resolved", resolvedBy: [] },
    { status: "resolved", resolvedBy: null }, { status: "open", reason: "fixed" },
    { status: "acknowledged", resolvedBy: "cli" },
  ])("rejects malformed payload %j without modifying storage", async body => {
    const before = row();
    expect((await patch(body)).status).toBe(400);
    expect(row()).toEqual(before);
  });

  it("rejects malformed JSON without modifying storage", async () => {
    const before = row();
    const response = await app.request("/api/discoveries/disc-1", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{broken",
    });
    expect(response.status).toBe(400);
    expect(row()).toEqual(before);
  });

  it("returns 404 for missing detail and PATCH targets", async () => {
    expect((await app.request("/api/discoveries/missing")).status).toBe(404);
    expect((await patch({ status: "resolved" }, "missing")).status).toBe(404);
    expect((await patch({ status: "resolved", reason: "fixed" }, "missing")).status).toBe(404);
  });

  it("rolls back status and timestamp if stored JSON prevents resolution metadata update", async () => {
    db.run("UPDATE discoveries SET metadata = 'malformed' WHERE id = 'disc-1'");
    const before = row();
    expect((await patch({ status: "resolved", reason: "fixed" })).status).toBe(500);
    expect(row()).toEqual(before);
  });

  it.each([null, "null", "[]", "42", "malformed"])("returns object metadata for legacy value %j", async metadata => {
    db.run("UPDATE discoveries SET metadata = ? WHERE id = 'disc-1'", [metadata]);
    const list = await (await app.request("/api/discoveries")).json();
    const detail = await (await app.request("/api/discoveries/disc-1")).json();
    const search = await (await app.request("/api/discoveries/search?q=failure")).json();
    expect(list.discoveries[0].metadata).toEqual({});
    expect(detail.discovery.metadata).toEqual({});
    expect(search.discoveries[0].metadata).toEqual({});
  });

  it.each([true, false])("serves search metadata with FTS available=%s instead of treating search as an ID", async fts => {
    await patch({ status: "resolved", reason: "fixed", resolvedBy: "cli" });
    if (!fts) db.exec("DROP TABLE discoveries_fts");
    const response = await app.request("/api/discoveries/search?q=failure&severity=info");
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.discoveries).toHaveLength(1);
    expect(result.discoveries[0].metadata).toEqual(JSON.parse(row().metadata));
    expect((await app.request("/api/discoveries/search?q=x")).status).toBe(400);
  });

  it("serves stats rather than treating stats as an ID", async () => {
    const response = await app.request("/api/discoveries/stats");
    expect(response.status).toBe(200);
    expect((await response.json()).byStatus).toEqual({ open: 1 });
  });
});
