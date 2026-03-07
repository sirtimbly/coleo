import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { createArmsRoutes } from "../routes/arms";
import * as serverModule from "../server";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE arms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      domain TEXT NOT NULL,
      harness TEXT NOT NULL,
      status TEXT NOT NULL,
      context_budget INTEGER NOT NULL,
      current_context_used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_activity_at TEXT,
      last_heartbeat TEXT,
      current_task_id TEXT,
      pid INTEGER,
      port INTEGER,
      provider TEXT,
      model TEXT,
      total_tokens INTEGER,
      total_cost REAL,
      current_task_subject TEXT,
      current_bug_id TEXT,
      current_bug_title TEXT,
      agent_id TEXT,
      host TEXT,
      session_id TEXT,
      config TEXT
    );
  `);
  return db;
}

describe("arms spawn route auto-creation", () => {
  let db: Database;
  let app: Hono<{ Variables: { db: Database } }>;
  let tempDir: string;
  let originalColeoDir: string | undefined;
  let originalHome: string | undefined;
  let originalPath: string | undefined;
  let getArmClientSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    db = createTestDb();
    tempDir = await mkdtemp(join(tmpdir(), "coleo-arms-spawn-test-"));
    originalColeoDir = process.env.COLEO_DIR;
    originalHome = process.env.HOME;
    originalPath = process.env.PATH;
    process.env.COLEO_DIR = tempDir;
    process.env.HOME = tempDir;

    app = new Hono<{ Variables: { db: Database } }>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      return next();
    });
    app.route("/api/arms", createArmsRoutes());
  });

  afterEach(async () => {
    getArmClientSpy?.mockRestore();
    db.close();
    if (originalColeoDir === undefined) {
      delete process.env.COLEO_DIR;
    } else {
      process.env.COLEO_DIR = originalColeoDir;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates a missing arm record with provided name and domain before agent spawn", async () => {
    await mkdir(join(tempDir, ".local", "share", "opencode"), { recursive: true });
    await writeFile(
      join(tempDir, ".local", "share", "opencode", "auth.json"),
      JSON.stringify({
        opencode: { type: "api", key: "test" },
      }),
      "utf-8",
    );
    const binDir = join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const scriptPath = join(binDir, "opencode");
    await writeFile(
      scriptPath,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"models\" ]; then",
        "  printf '%s\\n' 'opencode/gpt-5.1-codex-mini' 'opencode/claude-opus-4'",
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
      "utf-8",
    );
    await chmod(scriptPath, 0o755);
    process.env.PATH = `${binDir}:${originalPath || ""}`;

    await mkdir(join(tempDir, "templates"), { recursive: true });
    await writeFile(
      join(tempDir, "templates", "frontend-review.yml"),
      [
        "name: Frontend Review",
        "description: UI specialist",
        "arm:",
        "  domain: design",
        "  harness: opencode-api",
        "model:",
        "  provider: opencode",
        "  model: gpt-5.1-codex-mini",
        "context:",
        "  budget: 222000",
        "",
      ].join("\n"),
      "utf-8",
    );

    const templatesResponse = await app.request("http://coleo.test/api/arms/templates");
    expect(templatesResponse.status).toBe(200);

    const templatesBody = (await templatesResponse.json()) as {
      templates: Array<{
        id: string;
        filename: string;
        harness: string;
        provider?: string;
        model?: string;
        domain: string;
      }>;
    };

    expect(templatesBody.templates).toHaveLength(1);
    expect(templatesBody.templates[0]).toMatchObject({
      id: "frontend-review",
      filename: "frontend-review.yml",
      harness: "opencode-api",
      provider: "opencode",
      model: "gpt-5.1-codex-mini",
      domain: "design",
    });

    const response = await app.request("http://coleo.test/api/arms/remote-builder/spawn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Remote Builder",
        template: "frontend-review",
        preferAgent: true,
      }),
    });

    expect(response.status).toBe(500);

    const created = db
      .query("SELECT id, name, domain, harness, status, provider, model, context_budget FROM arms WHERE id = ?")
      .get("remote-builder") as {
        id: string;
        name: string;
        domain: string;
        harness: string;
        status: string;
        provider: string;
        model: string;
        context_budget: number;
      } | null;

    expect(created).not.toBeNull();
    expect(created?.id).toBe("remote-builder");
    expect(created?.name).toBe("Remote Builder");
    expect(created?.domain).toBe("design");
    expect(created?.harness).toBe("opencode-api");
    expect(created?.provider).toBe("opencode");
    expect(created?.model).toBe("gpt-5.1-codex-mini");
    expect(created?.context_budget).toBe(222000);
    expect(created?.status).toBe("starting");

    const cacheContents = JSON.parse(
      await readFile(join(tempDir, "cache", "opencode-models.json"), "utf-8"),
    ) as {
      providers: Array<{ id: string; models: Array<{ id: string }> }>;
    };
    expect(cacheContents.providers.map((provider) => provider.id)).toEqual(["opencode"]);
    expect(
      cacheContents.providers[0]?.models.map((model) => model.id),
    ).toEqual(["claude-opus-4", "gpt-5.1-codex-mini"]);
  });

  it("retries on a stale daemon agent before failing over to a healthy one", async () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO arms (
        id, name, domain, harness, status, context_budget, current_context_used,
        created_at, updated_at, pid, provider, model, config
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "retry-arm",
        "Retry Arm",
        "development",
        "opencode-api",
        "starting",
        100000,
        0,
        now,
        now,
        null,
        "opencode",
        "gpt-5.1-codex-mini",
        JSON.stringify({}),
      ],
    );

    let activeAgentId = "stale-agent";
    const spawnCalls: string[] = [];
    const unreachableAgents = new Set<string>(["stale-agent"]);

    const mockArmClient = {
      findBestAgent: () => ({
        agentId: activeAgentId,
        hostname: activeAgentId === "stale-agent" ? "stale-host" : "healthy-host",
        capabilities: ["opencode-api"],
        maxArms: 10,
      }),
      getAgent: (agentId: string) => ({
        agentId,
        hostname: agentId === "stale-agent" ? "stale-host" : "healthy-host",
      }),
      spawnArm: async (agentId: string) => {
        spawnCalls.push(agentId);
        if (agentId === "stale-agent") {
          return {
            requestId: "req-stale",
            success: false,
            error: "TIMEOUT",
          };
        }

        return {
          requestId: "req-healthy",
          success: true,
          data: {
            armId: "retry-arm",
            pid: 4242,
            port: 19300,
            sessionId: "ses_retry",
          },
        };
      },
      listArmsOnAgent: async (agentId: string) => ({
        requestId: `probe-${agentId}`,
        success: !unreachableAgents.has(agentId),
      }),
      markAgentUnavailable: (agentId: string) => {
        unreachableAgents.add(agentId);
        if (activeAgentId === agentId) {
          activeAgentId = "healthy-agent";
        }
      },
    };

    getArmClientSpy = spyOn(serverModule, "getArmClient").mockImplementation(
      () => mockArmClient as never,
    );

    const response = await app.request("http://coleo.test/api/arms/retry-arm/spawn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workdir: tempDir,
      }),
    });

    expect(response.status).toBe(200);
    expect(spawnCalls).toEqual(["stale-agent", "healthy-agent"]);

    const body = (await response.json()) as {
      distributed: boolean;
      agentId: string;
      host: string;
      pid: number;
      port: number;
      sessionId: string;
    };

    expect(body.distributed).toBe(true);
    expect(body.agentId).toBe("healthy-agent");
    expect(body.host).toBe("healthy-host");
    expect(body.pid).toBe(4242);
    expect(body.port).toBe(19300);
    expect(body.sessionId).toBe("ses_retry");

    const updated = db
      .query("SELECT status, agent_id, host, pid, port, session_id FROM arms WHERE id = ?")
      .get("retry-arm") as {
        status: string;
        agent_id: string | null;
        host: string | null;
        pid: number | null;
        port: number | null;
        session_id: string | null;
      } | null;

    expect(updated?.status).toBe("idle");
    expect(updated?.agent_id).toBe("healthy-agent");
    expect(updated?.host).toBe("healthy-host");
    expect(updated?.pid).toBe(4242);
    expect(updated?.port).toBe(19300);
    expect(updated?.session_id).toBe("ses_retry");
  });
});
