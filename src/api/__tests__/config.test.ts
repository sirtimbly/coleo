import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { formatErrorResponse } from "../middleware/error";
import { loadConfig } from "../../config";

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
    app.onError((err, c) => formatErrorResponse(c, err));
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

  for (const harness of ["opencode", "opencode-tui", "custom", ""]) {
    it(`rejects unsupported harness ${JSON.stringify(harness)} in every config write format`, async () => {
      const requests = [
        { url: "/api/config/defaults", method: "PATCH", body: { harness } },
        { url: "/api/config", method: "PATCH", body: { defaults: { harness } } },
        { url: "/api/config/toml", method: "PUT", body: { toml: { defaults: { harness } } } },
        { url: "/api/config/arms/test", method: "PUT", body: { config: { arm: { harness } } } },
        { url: "/api/config/arms/test", method: "PUT", body: { raw: `[arm]\nharness = "${harness}"` } },
        { url: "/api/config/arms/test", method: "PUT", body: { raw: `harness = "${harness}"` } },
      ];
      for (const { url, method, body } of requests) {
        const response = await app.request(url, {
          method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: expect.stringContaining("opencode-api") });
      }
      expect((await loadConfig(tempDir)).defaults.harness).toBe("opencode-api");
    });
  }

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
  it("persists swarm controls across config reloads and rejects invalid changes", async () => {
    const patch = (body: unknown) => app.request("/api/config/brain", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const initial = await (await app.request("/api/config/brain")).json();
    expect(initial.brain.swarmEvaluationMode).toBe("off");
    expect(initial.brain.swarmWindowPolls).toBe(10);
    for (const mode of ["shadow", "execute", "off"] as const) {
      expect((await patch({ swarmEvaluationMode: mode, swarmWindowPolls: 20 })).status).toBe(200);
      const persisted = await loadConfig(tempDir);
      expect(persisted.brain.swarmEvaluationMode).toBe(mode);
      expect(persisted.brain.swarmWindowPolls).toBe(20);
    }
    for (const body of [{ swarmEvaluationMode: "invalid" }, { swarmEvaluationMode: null },
      { swarmWindowPolls: 0 }, { swarmWindowPolls: 101 }, { swarmWindowPolls: 1.5 }, { swarmWindowPolls: "10" }]) {
      expect((await patch(body)).status).toBe(400);
    }
    expect((await loadConfig(tempDir)).brain.swarmWindowPolls).toBe(20);
  });

  it("merges responsibility settings without resetting other choices and validates keys", async () => {
    const patch = (body: unknown) => app.request("/api/config/brain", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await patch({ responsibilityEnabled: { followups: false }, swarmActionModes: { prompt_arm: "shadow" } })).status).toBe(200);
    expect((await patch({ responsibilityEnabled: { "new-bugs": false }, swarmActionModes: { create_bug: "off" } })).status).toBe(200);
    const saved = (await loadConfig(tempDir)).brain;
    expect(saved.responsibilityEnabled).toEqual({ followups: false, "new-bugs": false });
    expect(saved.swarmActionModes).toEqual({ prompt_arm: "shadow", create_bug: "off" });
    for (const value of [{ responsibilityEnabled: { foundation: false } }, { responsibilityEnabled: { followups: "false" } },
      { swarmActionModes: { prompt_arm: "execute" } }, { swarmActionModes: null }]) {
      expect((await patch(value)).status).toBe(400);
    }
  });

  it("serves only known effective templates without exposing credentials", async () => {
    const response = await app.request("/api/config/brain/templates/jev-swarm-policy.jinja");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.content).toContain("Assess a time-bounded snapshot");
    expect(body.path).toBe(".coleo/src/brain/templates/jev-swarm-policy.jinja");
    expect((await app.request("/api/config/brain/templates/config.toml")).status).toBe(404);
  });

});
