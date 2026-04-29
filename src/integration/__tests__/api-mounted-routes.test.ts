import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { qdrantStore } from "../../qdrant";
import { eventStore } from "../../nats/jetstream";
import { createApp } from "../../api/server";
import { loadApiConfig, type ApiConfig } from "../../api/config";
import { initDatabase } from "../../db";
import * as daemonModule from "../../daemon";

describe("mounted API server routes", () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;
  let apiKey: string;
  let tempDir: string;
  let originalColeoDir: string | undefined;
  let qdrantSpy: ReturnType<typeof spyOn>;
  let serviceStatusSpy: ReturnType<typeof spyOn>;
  let eventStoreSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "coleo-api-server-test-"));
    await mkdir(join(tempDir, "mail", "inbox", "new"), { recursive: true });
    await mkdir(join(tempDir, "mail", "inbox", "cur"), { recursive: true });
    await mkdir(join(tempDir, "mail", "inbox", "tmp"), { recursive: true });

    originalColeoDir = process.env.COLEO_DIR;
    process.env.COLEO_DIR = tempDir;

    eventStoreSpy = spyOn(eventStore, "isInitialized").mockReturnValue(false);
    qdrantSpy = spyOn(qdrantStore, "listCollections").mockImplementation(async () => []);
    serviceStatusSpy = spyOn(daemonModule, "getServiceStatus").mockImplementation(async () => ({
      type: "indexer",
      running: false,
    }));

    db = await initDatabase(":memory:");
    apiKey = "test-api-key-mounted-server";

    const config: ApiConfig = {
      ...loadApiConfig(),
      apiKey,
    };

    app = createApp(db, config);
  });

  afterEach(async () => {
    eventStoreSpy.mockRestore();
    qdrantSpy.mockRestore();
    serviceStatusSpy.mockRestore();
    db.close();

    if (originalColeoDir === undefined) {
      delete process.env.COLEO_DIR;
    } else {
      process.env.COLEO_DIR = originalColeoDir;
    }

    await rm(tempDir, { recursive: true, force: true });
  });

  it("serves /api/health without auth", async () => {
    const response = await app.request(new Request("http://localhost/api/health"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
    });
  });

  it("reports mounted system status using live database counts", async () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO arms (
        id, name, domain, harness, status, context_budget, current_context_used,
        created_at, updated_at, config, host
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "arm-mounted",
        "Mounted Arm",
        "backend",
        "opencode-api",
        "idle",
        100000,
        0,
        now,
        now,
        JSON.stringify({ workdir: "/Users/tim/developer/coleo" }),
        "host-mounted",
      ],
    );

    const response = await app.request(new Request("http://localhost/api/status", {
      headers: { "X-API-Key": apiKey },
    }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      arms: { total: number };
      infrastructure: {
        qdrant: { healthy: boolean };
        indexer: { running: boolean };
      };
    };

    expect(body.status).toBe("ok");
    expect(body.arms.total).toBe(1);
    expect(body.infrastructure.qdrant.healthy).toBe(true);
    expect(body.infrastructure.indexer.running).toBe(false);
    expect(qdrantSpy).toHaveBeenCalledTimes(1);
    expect(serviceStatusSpy).toHaveBeenCalledWith("indexer");
  });

  it("lists mounted arm records through /api/arms", async () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO arms (
        id, name, domain, harness, status, context_budget, current_context_used,
        created_at, updated_at, config, host
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "arm-ui",
        "UI Arm",
        "design",
        "opencode-api",
        "busy",
        120000,
        4000,
        now,
        now,
        JSON.stringify({ workdir: "/Users/tim/developer/coleo" }),
        "host-ui",
      ],
    );

    const response = await app.request(new Request("http://localhost/api/arms", {
      headers: { "X-API-Key": apiKey },
    }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      arms: Array<{ id: string; name: string; status: string; domain: string }>;
    };

    expect(body.arms).toEqual([
      expect.objectContaining({
        id: "arm-ui",
        name: "UI Arm",
        status: "busy",
        domain: "design",
      }),
    ]);
  });

  it("returns the live fallback payload from the mounted activity route when JetStream is unavailable", async () => {
    const response = await app.request(new Request("http://localhost/api/activity", {
      headers: { "X-API-Key": apiKey },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      activity: [],
      message: "JetStream not available - start the API server with NATS",
    });
  });

  it("enforces auth on protected routes while leaving health public", async () => {
    const unauthorized = await app.request(new Request("http://localhost/api/arms"));
    expect(unauthorized.status).toBe(401);

    const invalid = await app.request(new Request("http://localhost/api/arms", {
      headers: { "X-API-Key": "invalid-key-12345" },
    }));
    expect(invalid.status).toBe(401);

    const health = await app.request(new Request("http://localhost/api/health"));
    expect(health.status).toBe(200);
  });
});
