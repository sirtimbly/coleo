import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createBrainRoutes } from "../routes/brain";
import { HttpError } from "../middleware/error";
import { setNatsManager } from "../../nats/server";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      processed_at TEXT,
      error TEXT,
      source TEXT,
      stream_name TEXT,
      stream_seq INTEGER,
      dedupe_id TEXT
    );
    CREATE UNIQUE INDEX idx_messages_dedupe_id ON messages(dedupe_id) WHERE dedupe_id IS NOT NULL;
  `);
  return db;
}

describe("brain internal messages API", () => {
  let db: Database;
  let app: Hono<{ Variables: { db: Database } }>;

  beforeEach(() => {
    const connection = createMockNatsConnection();
    setNatsManager({
      getConnection: () => connection,
      ready: () => true,
    } as unknown as Parameters<typeof setNatsManager>[0]);

    db = createTestDb();
    app = new Hono<{ Variables: { db: Database } }>();

    app.use("*", async (c, next) => {
      c.set("db", db);
      await next();
    });

    app.route("/api/brain", createBrainRoutes());
    app.onError((err, c) => {
      if (err instanceof HttpError) {
        return c.json({ error: err.message }, err.status as 400 | 401 | 403 | 404 | 500);
      }
      return c.json({ error: "Internal server error" }, 500);
    });
  });

  afterEach(() => {
    setNatsManager({
      getConnection: () => null,
      ready: () => false,
    } as unknown as Parameters<typeof setNatsManager>[0]);
    db.close();
  });

  it("rejects unsupported brain message types and records dead-letter", async () => {
    const response = await app.request("/api/brain/internal/messages/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "msg-unsupported",
        from: "arm-1",
        to: "brain",
        type: "claim_transfer",
        payload: { filePath: "src/brain/brain.ts" },
      }),
    });

    expect(response.status).toBe(400);

    const row = db
      .query("SELECT from_id, to_id, message_type, status, error FROM messages LIMIT 1")
      .get() as
      | {
          from_id: string;
          to_id: string;
          message_type: string;
          status: string;
          error: string | null;
        }
      | null;

    expect(row).toBeTruthy();
    expect(row?.from_id).toBe("arm-1");
    expect(row?.to_id).toBe("brain.deadletter");
    expect(row?.message_type).toBe("claim_transfer");
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("unsupported brain message type");
  });

  it("rejects invalid brain payloads and records dead-letter", async () => {
    const response = await app.request("/api/brain/internal/messages/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "msg-invalid-payload",
        from: "arm-2",
        to: "brain",
        type: "status_update",
        payload: { taskId: "task-1" },
      }),
    });

    expect(response.status).toBe(400);

    const row = db
      .query("SELECT from_id, to_id, message_type, status, error FROM messages LIMIT 1")
      .get() as
      | {
          from_id: string;
          to_id: string;
          message_type: string;
          status: string;
          error: string | null;
        }
      | null;

    expect(row).toBeTruthy();
    expect(row?.from_id).toBe("arm-2");
    expect(row?.to_id).toBe("brain.deadletter");
    expect(row?.message_type).toBe("status_update");
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("status_update requires payload.status");
  });

  it("queues valid brain messages", async () => {
    const response = await app.request("/api/brain/internal/messages/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "msg-valid",
        from: "arm-3",
        to: "brain",
        type: "status_update",
        payload: { taskId: "task-2", status: "in_progress" },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      queued: true,
      id: "msg-valid",
    });

    const queuedCount = db
      .query("SELECT COUNT(*) AS count FROM messages WHERE id = ?")
      .get("msg-valid") as { count: number };
    expect(queuedCount.count).toBe(0);

    const deadLetters = db
      .query("SELECT COUNT(*) AS count FROM messages WHERE to_id = 'brain.deadletter'")
      .get() as { count: number };
    expect(deadLetters.count).toBe(0);
  });

  it("accepts command publish endpoint", async () => {
    const response = await app.request("/api/brain/internal/commands/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "cmd-publish-valid",
        from: "arm-9",
        to: "brain",
        type: "status_update",
        payload: { taskId: "task-9", status: "in_progress" },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accepted: true,
      id: "cmd-publish-valid",
    });

    const deadLetters = db
      .query("SELECT COUNT(*) AS count FROM messages WHERE to_id = 'brain.deadletter'")
      .get() as { count: number };
    expect(deadLetters.count).toBe(0);
  });

  it("leases pending messages once for processing", async () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO messages (id, from_id, to_id, message_type, payload, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "msg-lease",
        "arm-lease",
        "brain",
        "status_update",
        JSON.stringify({ taskId: "task-3", status: "in_progress" }),
        "pending",
        now,
      ],
    );

    const first = await app.request("/api/brain/internal/messages/msg-lease/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "processing" }),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ success: true });

    const second = await app.request("/api/brain/internal/messages/msg-lease/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "processing" }),
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ success: false });
  });

  it("re-leases stale processing messages and only exposes stale processing in pending endpoint", async () => {
    const now = new Date();
    const staleProcessedAt = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
    const freshProcessedAt = new Date(now.getTime() - 60 * 1000).toISOString();
    const createdAt = now.toISOString();

    db.run(
      `INSERT INTO messages (id, from_id, to_id, message_type, payload, status, created_at, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)` ,
      [
        "msg-stale",
        "arm-stale",
        "brain",
        "status_update",
        JSON.stringify({ taskId: "task-stale", status: "in_progress" }),
        "processing",
        createdAt,
        staleProcessedAt,
      ],
    );

    db.run(
      `INSERT INTO messages (id, from_id, to_id, message_type, payload, status, created_at, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)` ,
      [
        "msg-fresh",
        "arm-fresh",
        "brain",
        "status_update",
        JSON.stringify({ taskId: "task-fresh", status: "in_progress" }),
        "processing",
        createdAt,
        freshProcessedAt,
      ],
    );

    const pendingBeforeLeaseResponse = await app.request("/api/brain/internal/messages/pending?to=brain");
    expect(pendingBeforeLeaseResponse.status).toBe(200);

    const pendingBeforeLease = await pendingBeforeLeaseResponse.json() as {
      messages: Array<{ id: string }>;
    };
    const idsBeforeLease = pendingBeforeLease.messages.map((message) => message.id);

    expect(idsBeforeLease).toContain("msg-stale");
    expect(idsBeforeLease).not.toContain("msg-fresh");

    const lease = await app.request("/api/brain/internal/messages/msg-stale/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "processing" }),
    });
    expect(lease.status).toBe(200);
    expect(await lease.json()).toEqual({ success: true });

    const pendingAfterLeaseResponse = await app.request("/api/brain/internal/messages/pending?to=brain");
    expect(pendingAfterLeaseResponse.status).toBe(200);

    const pendingAfterLease = await pendingAfterLeaseResponse.json() as {
      messages: Array<{ id: string }>;
    };
    const idsAfterLease = pendingAfterLease.messages.map((message) => message.id);
    expect(idsAfterLease).not.toContain("msg-stale");
  });

  it("lists dead-letter messages and can requeue a valid dead-letter", async () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO messages (id, from_id, to_id, message_type, payload, status, created_at, processed_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "deadletter-1",
        "arm-dl",
        "brain.deadletter",
        "status_update",
        JSON.stringify({
          payload: { taskId: "task-dl", status: "blocked", message: "waiting" },
          source: "api_queue",
          reason: "test",
        }),
        "failed",
        now,
        now,
        "test",
      ],
    );

    const deadLetterResponse = await app.request("/api/brain/internal/messages/deadletter?limit=10");
    expect(deadLetterResponse.status).toBe(200);
    const deadLetterBody = await deadLetterResponse.json() as {
      messages: Array<{ id: string; reason?: string; payload: unknown }>;
    };
    expect(deadLetterBody.messages).toHaveLength(1);
    expect(deadLetterBody.messages[0]?.id).toBe("deadletter-1");
    expect(deadLetterBody.messages[0]?.reason).toBe("test");

    const requeueResponse = await app.request(
      "/api/brain/internal/messages/deadletter/deadletter-1/requeue",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "msg-requeued" }),
      },
    );
    expect(requeueResponse.status).toBe(200);
    expect(await requeueResponse.json()).toEqual({
      queued: true,
      id: "msg-requeued",
      sourceDeadLetterId: "deadletter-1",
    });

    const queued = db.query(
      "SELECT to_id, message_type, payload, status FROM messages WHERE id = ?",
    ).get("msg-requeued") as
      | { to_id: string; message_type: string; payload: string; status: string }
      | null;
    expect(queued).toBeTruthy();
    expect(queued?.to_id).toBe("brain");
    expect(queued?.message_type).toBe("status_update");
    expect(queued?.status).toBe("pending");
    expect(JSON.parse(queued?.payload || "{}")).toEqual({
      taskId: "task-dl",
      status: "blocked",
      message: "waiting",
    });
  });

  it("rejects dead-letter requeue when payload no longer matches inbox schema", async () => {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO messages (id, from_id, to_id, message_type, payload, status, created_at, processed_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "deadletter-invalid",
        "arm-dl",
        "brain.deadletter",
        "status_update",
        JSON.stringify({
          payload: { taskId: "task-invalid" },
          source: "api_queue",
          reason: "bad payload",
        }),
        "failed",
        now,
        now,
        "bad payload",
      ],
    );

    const requeueResponse = await app.request(
      "/api/brain/internal/messages/deadletter/deadletter-invalid/requeue",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "msg-should-not-exist" }),
      },
    );
    expect(requeueResponse.status).toBe(400);
    const body = await requeueResponse.json() as { error: string };
    expect(body.error).toContain("cannot requeue invalid payload");

    const missing = db.query("SELECT id FROM messages WHERE id = ?").get("msg-should-not-exist");
    expect(missing).toBeNull();
  });
});

function createMockNatsConnection(): {
  info: { max_payload: number };
  jetstreamManager: () => Promise<{
    streams: {
      info: (name: string) => Promise<{ config: { subjects: string[] } }>;
      add: (config: { name: string; subjects?: string[] }) => Promise<void>;
      update: (name: string, config: { subjects?: string[] }) => Promise<void>;
    };
  }>;
  jetstream: () => {
    publish: (
      subject: string,
      payload: Uint8Array,
      options?: { msgID?: string },
    ) => Promise<{ stream: string; seq: number; duplicate: boolean }>;
  };
} {
  const streams = new Map<string, { subjects: string[] }>();
  let seq = 0;

  return {
    info: { max_payload: 2_000_000 },
    jetstreamManager: async () => ({
      streams: {
        info: async (name: string) => {
          const stream = streams.get(name);
          if (!stream) {
            throw new Error(`stream not found: ${name}`);
          }
          return { config: { subjects: stream.subjects } };
        },
        add: async (config: { name: string; subjects?: string[] }) => {
          streams.set(config.name, { subjects: config.subjects || [] });
        },
        update: async (name: string, config: { subjects?: string[] }) => {
          streams.set(name, { subjects: config.subjects || [] });
        },
      },
    }),
    jetstream: () => ({
      publish: async (_subject: string, _payload: Uint8Array, _options?: { msgID?: string }) => {
        seq += 1;
        return { stream: "coleo-commands", seq, duplicate: false };
      },
    }),
  };
}
