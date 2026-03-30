import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";

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
      workdir TEXT,
      last_output_at TEXT,
      config TEXT
    );

    CREATE TABLE arm_stuck_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      arm_id TEXT NOT NULL,
      reason TEXT,
      requested_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      handled_at TEXT,
      handled_by TEXT,
      outcome TEXT
    );
  `);
  return db;
}

describe("arm control routes", () => {
  let db: Database;
  let app: Hono<{ Variables: { db: Database } }>;

  beforeEach(() => {
    db = createTestDb();
    app = new Hono<{ Variables: { db: Database } }>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      return next();
    });
    app.route("/api/arms", createArmsRoutes());
  });

  afterEach(() => {
    serverModule.setArmClient({} as never);
    db.close();
  });

  it("creates, lists, fetches, and resolves manual stuck requests", async () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO arms (
        id, name, domain, harness, status, context_budget, current_context_used,
        created_at, updated_at, config
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["arm-alpha", "arm-alpha", "general", "opencode-api", "busy", 100000, 0, now, now, "{}"],
    );

    const createResponse = await app.request("http://coleo.test/api/arms/arm-alpha/stuck", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "No visible progress", requestedBy: "watch" }),
    });
    expect(createResponse.status).toBe(200);
    const createdBody = await createResponse.json() as {
      success: boolean;
      alreadyPending: boolean;
      request: { id: number; reason: string; requestedBy: string };
    };
    expect(createdBody.success).toBe(true);
    expect(createdBody.alreadyPending).toBe(false);
    expect(createdBody.request.reason).toBe("No visible progress");
    expect(createdBody.request.requestedBy).toBe("watch");

    const getResponse = await app.request("http://coleo.test/api/arms/arm-alpha/stuck");
    expect(getResponse.status).toBe(200);
    const getBody = await getResponse.json() as {
      request: { id: number; reason: string; requestedBy: string };
    };
    expect(getBody.request.reason).toBe("No visible progress");

    const listResponse = await app.request("http://coleo.test/api/arms/stuck-requests");
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json() as {
      requests: Array<{ id: number; armId: string }>;
    };
    expect(listBody.requests).toHaveLength(1);
    expect(listBody.requests[0]).toMatchObject({ armId: "arm-alpha" });

    const resolveResponse = await app.request(
      `http://coleo.test/api/arms/stuck-requests/${createdBody.request.id}/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handledBy: "brain", outcome: "handled:prompt" }),
      },
    );
    expect(resolveResponse.status).toBe(200);

    const activeAfterResolve = await app.request("http://coleo.test/api/arms/stuck-requests");
    const activeAfterResolveBody = await activeAfterResolve.json() as {
      requests: Array<unknown>;
    };
    expect(activeAfterResolveBody.requests).toHaveLength(0);
  });

  it("forwards interrupt=true when prompting a distributed arm", async () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO arms (
        id, name, domain, harness, status, context_budget, current_context_used,
        created_at, updated_at, agent_id, host, config
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["arm-remote", "arm-remote", "general", "opencode-api", "idle", 100000, 0, now, now, "agent-1", "remote-host", "{}"],
    );

    const calls: Array<{
      armId: string;
      prompt: string;
      attachments: unknown;
      interrupt: boolean | undefined;
    }> = [];

    serverModule.setArmClient({
      getAgentForArm: () => undefined,
      getAgent: (agentId: string) =>
        agentId === "agent-1"
          ? { agentId: "agent-1", hostname: "remote-host", capabilities: ["opencode-api"] }
          : undefined,
      getArmState: async () => ({
        requestId: "state-1",
        success: true,
        data: {
          armId: "arm-remote",
          agentId: "agent-1",
          name: "arm-remote",
          domain: "general",
          harness: "opencode-api",
          status: "idle",
          pid: 123,
          port: 456,
          provider: null,
          model: null,
          sessionId: "session-1",
          startedAt: now,
          lastActivityAt: now,
          error: null,
        },
      }),
      sendPrompt: async (
        armId: string,
        prompt: string,
        attachments?: unknown,
        interrupt?: boolean,
      ) => {
        calls.push({ armId, prompt, attachments, interrupt });
        return { requestId: "prompt-1", success: true };
      },
    } as never);

    const response = await app.request("http://coleo.test/api/arms/arm-remote/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Please summarize your blocker.", interrupt: true }),
    });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      armId: "arm-remote",
      prompt: "Please summarize your blocker.",
      interrupt: true,
    });
  });

  it("forwards fullText=true when fetching distributed arm messages", async () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO arms (
        id, name, domain, harness, status, context_budget, current_context_used,
        created_at, updated_at, agent_id, host, config
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["arm-remote", "arm-remote", "general", "opencode-api", "busy", 100000, 0, now, now, "agent-1", "remote-host", "{}"],
    );

    const calls: Array<{ armId: string; options?: { limit?: number; truncateText?: boolean } }> = [];

    serverModule.setArmClient({
      getAgentForArm: () => undefined,
      getAgent: (agentId: string) =>
        agentId === "agent-1"
          ? { agentId: "agent-1", hostname: "remote-host", capabilities: ["opencode-api"] }
          : undefined,
      getMessages: async (armId: string, options?: { limit?: number; truncateText?: boolean }) => {
        calls.push({ armId, options });
        return {
          requestId: "messages-1",
          success: true,
          data: { messages: [], sessionId: "session-1" },
        };
      },
    } as never);

    const response = await app.request("http://coleo.test/api/arms/arm-remote/messages?limit=10&fullText=true");

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      armId: "arm-remote",
      options: { limit: 10, truncateText: false },
    });
  });
});
