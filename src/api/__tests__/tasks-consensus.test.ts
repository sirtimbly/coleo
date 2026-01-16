import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { createTasksRoutes } from "../routes/tasks";

type ConsensusResponse = {
  taskId: string;
  consensusStatus: string;
  entries: Array<{
    armId: string;
    status: string;
    [key: string]: unknown;
  }>;
};

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      source_type TEXT,
      source_ref TEXT,
      phase TEXT,
      domain TEXT,
      assigned_to TEXT,
      consensus_status TEXT DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      claimed_at TEXT,
      started_at TEXT,
      due_date TEXT,
      artifacts TEXT DEFAULT '[]',
      metadata TEXT DEFAULT '{}'
    );

    CREATE TABLE arms (
      id TEXT PRIMARY KEY,
      name TEXT
    );

    CREATE TABLE activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      actor TEXT,
      action TEXT,
      target TEXT,
      details TEXT
    );

    CREATE TABLE task_arm_consensus (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      arm_id TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      approval TEXT,
      approval_reason TEXT,
      last_report TEXT,
      last_report_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const now = new Date("2026-01-16T00:00:00Z").toISOString();
  db.run(
    `INSERT INTO tasks (id, subject, description, status, priority, source_type, created_at, updated_at)
     VALUES (?, 'Sample Task', 'desc', 'pending', 'normal', 'manual', ?, ?)`,
    ["task-1", now, now]
  );

  db.run(`INSERT INTO arms (id, name) VALUES ('arm-1', 'Primary Arm'), ('arm-2', 'Watcher Arm')`);

  return db;
}

describe("tasks consensus API", () => {
  let db: Database;
  let app: Hono<{ Variables: { db: Database } }>;

  beforeEach(() => {
    db = createTestDb();
    const tasksApp = createTasksRoutes();
    app = new Hono<{ Variables: { db: Database } }>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      return next();
    });
    app.route("/api/tasks", tasksApp);
  });

  afterEach(() => {
    db.close();
  });

  it("returns pending consensus when no entries exist", async () => {
    const res = await app.request("/api/tasks/task-1/consensus");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConsensusResponse;
    expect(body.consensusStatus).toBe("pending");
    expect(body.entries).toEqual([]);
  });

  it("records updates and reaches consensus after approval", async () => {
    const workingRes = await app.request("/api/tasks/task-1/consensus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        armId: "arm-1",
        role: "primary",
        status: "working",
        report: "Implementation verified",
      }),
    });
    expect(workingRes.status).toBe(200);
    const workingBody = (await workingRes.json()) as ConsensusResponse;
    expect(workingBody.consensusStatus).toBe("in_progress");
    expect(workingBody.entries.length).toBe(1);
    const firstEntry = workingBody.entries[0]!;
    expect(firstEntry.armId).toBe("arm-1");
    expect(firstEntry.status).toBe("working");

    const approveRes = await app.request("/api/tasks/task-1/consensus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        armId: "arm-1",
        status: "approved",
        approval: "approved",
        approvalReason: "Tests passed",
      }),
    });
    expect(approveRes.status).toBe(200);
    const approveBody = (await approveRes.json()) as ConsensusResponse;
    expect(approveBody.consensusStatus).toBe("reached");

    const consensusRow = db
      .query("SELECT consensus_status FROM tasks WHERE id = ?")
      .get("task-1") as { consensus_status: string };
    expect(consensusRow.consensus_status).toBe("reached");
  });

  it("marks consensus failed when any arm rejects", async () => {
    await app.request("/api/tasks/task-1/consensus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        armId: "arm-1",
        role: "primary",
        status: "approved",
        approval: "approved",
      }),
    });

    const rejectRes = await app.request("/api/tasks/task-1/consensus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        armId: "arm-2",
        role: "watcher",
        status: "rejected",
        approval: "rejected",
        approvalReason: "Found regression",
      }),
    });
    expect(rejectRes.status).toBe(200);
    const rejectBody = (await rejectRes.json()) as ConsensusResponse;
    expect(rejectBody.consensusStatus).toBe("failed");

    const consensusRow = db
      .query("SELECT consensus_status FROM tasks WHERE id = ?")
      .get("task-1") as { consensus_status: string };
    expect(consensusRow.consensus_status).toBe("failed");
  });
});
