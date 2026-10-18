import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createListCsvRoutes } from "../routes/list-csv";
import { formatErrorResponse } from "../middleware/error";

describe("CSV HTTP round trips", () => {
  let db: Database;
  let app: Hono<{ Variables: { db: Database } }>;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, subject TEXT, description TEXT, status TEXT,
      order_key TEXT, claimed_at TEXT, started_at TEXT, completed_at TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE bugs (id TEXT PRIMARY KEY, title TEXT, description TEXT, status TEXT,
      sort_order INTEGER, resolved_at TEXT, archived INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
      INSERT INTO tasks VALUES ('t1','One','notes','pending','a',NULL,NULL,NULL,'2026','2026');
      INSERT INTO tasks VALUES ('t2','Two','notes','completed','b',NULL,NULL,NULL,'2026','2026');
      INSERT INTO bugs VALUES ('b1','One','notes','open',0,NULL,0,'2026','2026');
      INSERT INTO bugs VALUES ('b2','Two','notes','closed',1,NULL,0,'2026','2026');`);
    app = new Hono<{ Variables: { db: Database } }>();
    app.use("*", async (c, next) => { c.set("db", db); await next(); });
    app.onError((error, c) => formatErrorResponse(c, error));
    app.route("/tasks/csv", createListCsvRoutes("tasks"));
    app.route("/bugs/csv", createListCsvRoutes("bugs"));
  });
  afterEach(() => db.close());

  for (const kind of ["tasks", "bugs"] as const) {
    it(`${kind}: filters, updates, and conflicts preserve original semantics`, async () => {
      const response = await app.request(`/${kind}/csv/export?filter=pending`);
      const exported = await response.json();
      expect(exported.csv).toContain("One");
      expect(exported.csv).not.toContain("Two");
      const send = (csv: string) => app.request(`/${kind}/csv/import`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ csv }),
      });
      const edited = exported.csv.replace(",One,", ",Edited%2C title,");
      const imported = await (await send(edited)).json();
      expect(imported.changed).toBe(1);
      expect(imported.changes[0].fields).toEqual(["name"]);
      const conflict = await (await send(edited)).json();
      expect(conflict.changed).toBe(0);
      expect(conflict.conflicts).toHaveLength(1);
      const invalid = await (await send("wrong,header\n")).json();
      expect(invalid.invalid).toHaveLength(1);
      expect(invalid.changed).toBe(0);
      expect((await send('"unterminated')).status).toBe(400);
      expect((await app.request(`/${kind}/csv/export?filter=unknown`)).status).toBe(400);
    });
  }
});
