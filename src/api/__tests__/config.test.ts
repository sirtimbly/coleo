import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { createConfigRoutes } from "../routes/config";

describe("Config API", () => {
  let app: Hono<{ Variables: { db: Database } }>;
  let db: Database;
  let tempDir: string;
  let originalColeoDir: string | undefined;

  beforeEach(async () => {
    originalColeoDir = process.env.COLEO_DIR;
    tempDir = await mkdtemp(join(tmpdir(), "coleo-config-api-"));
    process.env.COLEO_DIR = tempDir;

    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE infrastructure_health (
        component TEXT PRIMARY KEY,
        healthy INTEGER NOT NULL,
        optional INTEGER NOT NULL,
        error TEXT,
        last_check TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    app = new Hono<{ Variables: { db: Database } }>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      await next();
    });
    app.route("/api/config", createConfigRoutes());
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
    if (originalColeoDir === undefined) {
      delete process.env.COLEO_DIR;
    } else {
      process.env.COLEO_DIR = originalColeoDir;
    }
  });

  it("invalidates stale model access status when model credentials change", async () => {
    db.run(`
      INSERT INTO infrastructure_health
        (component, healthy, optional, error, last_check, updated_at)
      VALUES ('brain_model_api', 0, 0, 'stale access issue', datetime('now'), datetime('now'))
    `);

    const response = await app.request("/api/config/brain", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", apiKey: "funded-key" }),
    });

    expect(response.status).toBe(200);
    expect(db.query(
      "SELECT component FROM infrastructure_health WHERE component = 'brain_model_api'",
    ).get()).toBeNull();
  });
});
