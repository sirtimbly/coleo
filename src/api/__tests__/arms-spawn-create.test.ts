import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { createArmsRoutes } from "../routes/arms";
import * as serverModule from "../server";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE arms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      domain TEXT NOT NULL,
      harness TEXT NOT NULL,
      status TEXT NOT NULL,
      planning_blocked INTEGER NOT NULL DEFAULT 0,
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
      workdir TEXT,
      last_output_at TEXT,
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
  let originalRemoteArmsOnly: string | undefined;
  let originalRemoteWorkdir: string | undefined;
  let originalAutoStartAgent: string | undefined;
  let getArmClientSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    db = createTestDb();
    tempDir = await mkdtemp(join(tmpdir(), "coleo-arms-spawn-test-"));
    originalColeoDir = process.env.COLEO_DIR;
    originalHome = process.env.HOME;
    originalPath = process.env.PATH;
    originalRemoteArmsOnly = process.env.COLEO_REMOTE_ARMS_ONLY;
    originalRemoteWorkdir = process.env.COLEO_REMOTE_WORKDIR;
    originalAutoStartAgent = process.env.COLEO_AUTO_START_AGENT;
    process.env.COLEO_DIR = tempDir;
    process.env.HOME = tempDir;
    const binDir = join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "opencode"),
      ["#!/bin/sh", "exit 1", ""].join("\n"),
      "utf-8",
    );
    await chmod(join(binDir, "opencode"), 0o755);
    process.env.PATH = `${binDir}:${originalPath || ""}`;

    app = new Hono<{ Variables: { db: Database } }>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      return next();
    });
    app.route("/api/arms", createArmsRoutes());
  });

  it("exposes planning-gated arms and rejects direct prompts until the gate opens", async () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO arms (
        id, name, domain, harness, status, planning_blocked, context_budget,
        created_at, updated_at, config
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["planning-arm", "Planning Arm", "general", "manual", "paused", 1, 100000, now, now, "{}"],
    );

    const statusResponse = await app.request("http://coleo.test/api/arms/planning-arm");
    const statusBody = await statusResponse.json() as { arm: { status: string } };
    expect(statusBody.arm.status).toBe("planning_blocked");

    const lateRuntimeResponse = await app.request("http://coleo.test/api/arms/planning-arm", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "busy" }),
    });
    const lateRuntimeBody = await lateRuntimeResponse.json() as { arm: { status: string } };
    expect(lateRuntimeBody.arm.status).toBe("planning_blocked");

    const promptResponse = await app.request("http://coleo.test/api/arms/planning-arm/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Start work" }),
    });
    expect(promptResponse.status).toBe(409);

    const resumeResponse = await app.request("http://coleo.test/api/arms/planning-arm", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "idle", planningBlocked: false }),
    });
    const resumeBody = await resumeResponse.json() as { arm: { status: string } };
    expect(resumeBody.arm.status).toBe("idle");
  });

  afterEach(async () => {
    getArmClientSpy?.mockRestore();
    serverModule.setArmClient({} as never);
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
    restoreEnv("COLEO_REMOTE_ARMS_ONLY", originalRemoteArmsOnly);
    restoreEnv("COLEO_REMOTE_WORKDIR", originalRemoteWorkdir);
    restoreEnv("COLEO_AUTO_START_AGENT", originalAutoStartAgent);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("marks an active arm busy with stale activity so the brain can recover it", async () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO arms (
        id, name, domain, harness, status, context_budget, current_context_used,
        created_at, updated_at, last_activity_at, config
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "recoverable-arm",
        "Recoverable arm",
        "development",
        "opencode-api",
        "idle",
        100000,
        0,
        now,
        now,
        now,
        "{}",
      ],
    );

    const response = await app.request(
      "http://coleo.test/api/arms/recoverable-arm/mark-stuck",
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    const row = db
      .query("SELECT status, last_activity_at, config FROM arms WHERE id = ?")
      .get("recoverable-arm") as {
        status: string;
        last_activity_at: string;
        config: string;
      };
    expect(row.status).toBe("busy");
    expect(Date.now() - new Date(row.last_activity_at).getTime()).toBeGreaterThanOrEqual(
      9 * 60 * 1000,
    );
    expect(JSON.parse(row.config)).toMatchObject({
      recoveryRequestedAt: expect.any(String),
    });
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
    serverModule.setArmClient(mockArmClient as never);

    const response = await app.request("http://coleo.test/api/arms/retry-arm/spawn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workdir: tempDir,
        allowLocalFallback: false,
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

  it("routes every harness to the remote agent and uses its configured workdir in hosted mode", async () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO arms (
        id, name, domain, harness, status, context_budget, current_context_used,
        created_at, updated_at, provider, model, config
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["remote-only", "Remote Only", "research", "kimi-cli", "starting", 100000, 0, now, now, "kimi", "default", JSON.stringify({})],
    );
    process.env.COLEO_REMOTE_ARMS_ONLY = "1";
    process.env.COLEO_REMOTE_WORKDIR = "/srv/tenant/workspace";
    process.env.COLEO_AUTO_START_AGENT = "0";

    const spawnCalls: Array<{ agentId: string; options: { workDir?: string; initialPrompt?: string } }> = [];
    const mockArmClient = {
      findBestAgent: () => ({ agentId: "remote-agent", hostname: "agent-host", capabilities: ["kimi-cli"], maxArms: 10 }),
      getAgent: () => ({ agentId: "remote-agent", hostname: "agent-host" }),
      spawnArm: async (agentId: string, _armId: string, options: { workDir?: string; initialPrompt?: string }) => {
        spawnCalls.push({ agentId, options });
        return { requestId: "req-remote", success: true, data: { armId: "remote-only", pid: 44, port: 18888, sessionId: "ses_remote" } };
      },
      listArmsOnAgent: async () => ({ requestId: "probe", success: true }),
      markAgentUnavailable: () => undefined,
    };
    getArmClientSpy = spyOn(serverModule, "getArmClient").mockImplementation(() => mockArmClient as never);
    serverModule.setArmClient(mockArmClient as never);

    const response = await app.request("http://coleo.test/api/arms/remote-only/spawn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allowLocalFallback: true, initialPrompt: "Review the deployment constraints." }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ distributed: true, agentId: "remote-agent" });
    expect(spawnCalls).toEqual([{ agentId: "remote-agent", options: expect.objectContaining({ workDir: "/srv/tenant/workspace" }) }]);
    expect(spawnCalls[0]?.options.initialPrompt).toBeUndefined();
    const deferredConfig = db.query("SELECT config FROM arms WHERE id = ?").get("remote-only") as { config: string };
    expect(JSON.parse(deferredConfig.config).deferredInitialPrompt).toContain("Review the deployment constraints.");
  });

  it("reattaches to an existing distributed runtime when recover is requested", async () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO arms (
        id, name, domain, harness, status, context_budget, current_context_used,
        created_at, updated_at, last_activity_at, last_heartbeat, pid, port,
        provider, model, agent_id, host, session_id, workdir, config
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "recover-arm",
        "Recover Arm",
        "development",
        "opencode-api",
        "busy",
        100000,
        0,
        now,
        now,
        now,
        now,
        5151,
        19310,
        "opencode",
        "gpt-5.1-codex-mini",
        "agent-1",
        "recover-host",
        "ses_old",
        tempDir,
        JSON.stringify({}),
      ],
    );

    const mockArmClient = {
      getAgent: (agentId: string) => ({
        agentId,
        hostname: "recover-host",
      }),
      getAgentForArm: () => "agent-1",
      getAgents: () => [],
      findBestAgent: () => ({
        agentId: "agent-1",
        hostname: "recover-host",
        capabilities: ["opencode-api"],
        maxArms: 10,
      }),
      getArmState: async () => ({
        requestId: "req-recover",
        success: true,
        data: {
          status: "idle",
          pid: 6161,
          port: 19311,
          sessionId: "ses_live",
          lastActivityAt: now,
        },
      }),
    };

    getArmClientSpy = spyOn(serverModule, "getArmClient").mockImplementation(
      () => mockArmClient as never,
    );
    serverModule.setArmClient(mockArmClient as never);

    const response = await app.request("http://coleo.test/api/arms/recover-arm/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      recovered: boolean;
      recoveryMode: string;
      distributed: boolean;
      host: string;
      pid: number;
      port: number;
      sessionId: string;
    };

    expect(body.recovered).toBe(true);
    expect(body.recoveryMode).toBe("reattached");
    expect(body.distributed).toBe(true);
    expect(body.host).toBe("recover-host");
    expect(body.pid).toBe(6161);
    expect(body.port).toBe(19311);
    expect(body.sessionId).toBe("ses_live");

    const updated = db
      .query("SELECT status, pid, port, session_id, agent_id, host FROM arms WHERE id = ?")
      .get("recover-arm") as {
        status: string;
        pid: number | null;
        port: number | null;
        session_id: string | null;
        agent_id: string | null;
        host: string | null;
      } | null;

    expect(updated?.status).toBe("idle");
    expect(updated?.pid).toBe(6161);
    expect(updated?.port).toBe(19311);
    expect(updated?.session_id).toBe("ses_live");
    expect(updated?.agent_id).toBe("agent-1");
    expect(updated?.host).toBe("recover-host");
  });

  it("restarts a distributed arm when recovery metadata is stale and no live runtime is confirmed", async () => {
    const now = new Date().toISOString();
    const spawnCalls: string[] = [];

    db.run(
      `INSERT INTO arms (
        id, name, domain, harness, status, context_budget, current_context_used,
        created_at, updated_at, last_activity_at, last_heartbeat, pid, port,
        provider, model, agent_id, host, session_id, workdir, config
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "stale-recover-arm",
        "Stale Recover Arm",
        "development",
        "opencode-api",
        "stopped",
        100000,
        0,
        now,
        now,
        now,
        now,
        5151,
        19310,
        "opencode",
        "gpt-5.1-codex-mini",
        "agent-1",
        "recover-host",
        "ses_old",
        tempDir,
        JSON.stringify({}),
      ],
    );

    const mockArmClient = {
      getAgent: (agentId: string) => ({
        agentId,
        hostname: "recover-host",
      }),
      getAgentForArm: () => "agent-1",
      getAgents: () => [],
      findBestAgent: () => ({
        agentId: "agent-1",
        hostname: "recover-host",
        capabilities: ["opencode-api"],
        maxArms: 10,
      }),
      getArmState: async () => ({
        requestId: "req-stale-recover",
        success: false,
        error: "not found",
      }),
      listArmsOnAgent: async () => ({
        requestId: "req-list-stale-recover",
        success: true,
        data: {
          arms: [],
        },
      }),
      spawnArm: async (agentId: string) => {
        spawnCalls.push(agentId);
        return {
          requestId: "req-spawn-stale-recover",
          success: true,
          data: {
            armId: "stale-recover-arm",
            pid: 7171,
            port: 19312,
            sessionId: "ses_restarted",
          },
        };
      },
    };

    getArmClientSpy = spyOn(serverModule, "getArmClient").mockImplementation(
      () => mockArmClient as never,
    );
    serverModule.setArmClient(mockArmClient as never);

    const response = await app.request("http://coleo.test/api/arms/stale-recover-arm/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    expect(spawnCalls).toEqual(["agent-1"]);

    const body = (await response.json()) as {
      recovered: boolean;
      recoveryMode: string;
      distributed: boolean;
      host: string;
      pid: number;
      port: number;
      sessionId: string;
    };

    expect(body.recovered).toBe(true);
    expect(body.recoveryMode).toBe("restarted");
    expect(body.distributed).toBe(true);
    expect(body.host).toBe("recover-host");
    expect(body.pid).toBe(7171);
    expect(body.port).toBe(19312);
    expect(body.sessionId).toBe("ses_restarted");

    const updated = db
      .query("SELECT status, pid, port, session_id, agent_id, host FROM arms WHERE id = ?")
      .get("stale-recover-arm") as {
        status: string;
        pid: number | null;
        port: number | null;
        session_id: string | null;
        agent_id: string | null;
        host: string | null;
      } | null;

    expect(updated?.status).toBe("idle");
    expect(updated?.pid).toBe(7171);
    expect(updated?.port).toBe(19312);
    expect(updated?.session_id).toBe("ses_restarted");
    expect(updated?.agent_id).toBe("agent-1");
    expect(updated?.host).toBe("recover-host");
  });

  it("recovers using the current live agent when the persisted agent id is stale", async () => {
    const now = new Date().toISOString();
    const spawnCalls: string[] = [];

    db.run(
      `INSERT INTO arms (
        id, name, domain, harness, status, context_budget, current_context_used,
        created_at, updated_at, last_activity_at, last_heartbeat, pid, port,
        provider, model, agent_id, host, session_id, workdir, config
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "stale-agent-arm",
        "Stale Agent Arm",
        "development",
        "opencode-api",
        "stopped",
        100000,
        0,
        now,
        now,
        now,
        now,
        5151,
        19310,
        "opencode",
        "gpt-5.1-codex-mini",
        "stale-agent",
        "recover-host",
        "ses_old",
        tempDir,
        JSON.stringify({}),
      ],
    );

    const mockArmClient = {
      getAgent: (agentId: string) =>
        agentId === "live-agent"
          ? {
              agentId,
              hostname: "recover-host",
            }
          : undefined,
      getAgentForArm: () => undefined,
      getAgents: () => [
        {
          agentId: "live-agent",
          hostname: "recover-host",
          capabilities: ["opencode-api"],
          maxArms: 10,
        },
      ],
      findBestAgent: () => ({
        agentId: "live-agent",
        hostname: "recover-host",
        capabilities: ["opencode-api"],
        maxArms: 10,
      }),
      getArmState: async () => ({
        requestId: "req-stale-agent-recover",
        success: false,
        error: "not found",
      }),
      listArmsOnAgent: async (agentId: string) => ({
        requestId: `req-list-${agentId}`,
        success: true,
        data: {
          arms: [],
        },
      }),
      spawnArm: async (agentId: string) => {
        spawnCalls.push(agentId);
        return {
          requestId: "req-spawn-live-agent",
          success: true,
          data: {
            armId: "stale-agent-arm",
            pid: 8181,
            port: 19313,
            sessionId: "ses_live_agent",
          },
        };
      },
    };

    getArmClientSpy = spyOn(serverModule, "getArmClient").mockImplementation(
      () => mockArmClient as never,
    );
    serverModule.setArmClient(mockArmClient as never);

    const response = await app.request("http://coleo.test/api/arms/stale-agent-arm/recover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    expect(spawnCalls).toEqual(["live-agent"]);

    const body = (await response.json()) as {
      recovered: boolean;
      recoveryMode: string;
      distributed: boolean;
      agentId: string;
      host: string;
      pid: number;
      port: number;
      sessionId: string;
    };

    expect(body.recovered).toBe(true);
    expect(body.recoveryMode).toBe("restarted");
    expect(body.distributed).toBe(true);
    expect(body.agentId).toBe("live-agent");
    expect(body.host).toBe("recover-host");
    expect(body.pid).toBe(8181);
    expect(body.port).toBe(19313);
    expect(body.sessionId).toBe("ses_live_agent");

    const updated = db
      .query("SELECT status, pid, port, session_id, agent_id, host FROM arms WHERE id = ?")
      .get("stale-agent-arm") as {
        status: string;
        pid: number | null;
        port: number | null;
        session_id: string | null;
        agent_id: string | null;
        host: string | null;
      } | null;

    expect(updated?.status).toBe("idle");
    expect(updated?.pid).toBe(8181);
    expect(updated?.port).toBe(19313);
    expect(updated?.session_id).toBe("ses_live_agent");
    expect(updated?.agent_id).toBe("live-agent");
    expect(updated?.host).toBe("recover-host");
  });

  it("forwards interrupt when prompting a distributed arm", async () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO arms (
        id, name, domain, harness, status, context_budget, current_context_used,
        created_at, updated_at, agent_id, host, session_id, config
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "distributed-arm",
        "Distributed Arm",
        "development",
        "opencode-api",
        "busy",
        100000,
        0,
        now,
        now,
        "agent-1",
        "agent-host",
        "ses_live",
        JSON.stringify({}),
      ],
    );

    const promptCalls: unknown[][] = [];
    const mockArmClient = {
      getAgentForArm: () => "agent-1",
      getAgent: () => ({
        agentId: "agent-1",
        hostname: "agent-host",
        capabilities: ["opencode-api"],
        maxArms: 10,
      }),
      getAgents: () => [],
      getArmState: async () => ({
        requestId: "req-state",
        success: true,
        data: { status: "busy", sessionId: "ses_live" },
      }),
      sendPrompt: async (...args: unknown[]) => {
        promptCalls.push(args);
        return { requestId: "req-prompt", success: true };
      },
    };
    getArmClientSpy = spyOn(serverModule, "getArmClient").mockImplementation(
      () => mockArmClient as never,
    );
    serverModule.setArmClient(mockArmClient as never);

    const response = await app.request(
      "http://coleo.test/api/arms/distributed-arm/prompt",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Replacement prompt", interrupt: true }),
      },
    );

    expect(response.status).toBe(200);
    expect(promptCalls).toEqual([
      ["distributed-arm", "Replacement prompt", undefined, true],
    ]);
  });
});
