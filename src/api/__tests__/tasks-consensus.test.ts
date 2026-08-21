import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { createTasksRoutes } from "../routes/tasks";
import { HttpError } from "../middleware/error";

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
    app.onError((err, c) => {
      if (err instanceof HttpError) {
        return c.json({ error: err.message }, err.status as 400 | 401 | 403 | 404 | 500);
      }
      console.error("Unexpected error:", err);
      return c.json({ error: "Internal server error" }, 500);
    });
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

  it("stays in_progress until every arm has approved", async () => {
    await app.request("/api/tasks/task-1/consensus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        armId: "arm-1",
        role: "primary",
        status: "working",
      }),
    });

    await app.request("/api/tasks/task-1/consensus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        armId: "arm-2",
        role: "watcher",
        status: "watching",
      }),
    });

    const partialRes = await app.request("/api/tasks/task-1/consensus");
    const partialBody = (await partialRes.json()) as ConsensusResponse;
    expect(partialBody.consensusStatus).toBe("in_progress");

    await app.request("/api/tasks/task-1/consensus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        armId: "arm-2",
        role: "watcher",
        status: "approved",
        approval: "approved",
      }),
    });

    await app.request("/api/tasks/task-1/consensus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        armId: "arm-1",
        status: "approved",
        approval: "approved",
      }),
    });

    const finalRes = await app.request("/api/tasks/task-1/consensus");
    const finalBody = (await finalRes.json()) as ConsensusResponse;
    expect(finalBody.consensusStatus).toBe("reached");
    expect(finalBody.entries.length).toBe(2);
  });

  it("rejects consensus updates for unknown tasks", async () => {
    const res = await app.request("/api/tasks/unknown-task/consensus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        armId: "arm-1",
        status: "approved",
        approval: "approved",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects consensus updates for unknown arms", async () => {
    const res = await app.request("/api/tasks/task-1/consensus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        armId: "arm-unknown",
        status: "approved",
        approval: "approved",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid consensus status, role, and approval values", async () => {
    const missingArm = await app.request("/api/tasks/task-1/consensus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(missingArm.status).toBe(400);

    const invalidStatus = await app.request("/api/tasks/task-1/consensus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ armId: "arm-1", status: "completed" }),
    });
    expect(invalidStatus.status).toBe(400);

    const invalidRole = await app.request("/api/tasks/task-1/consensus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        armId: "arm-1",
        role: "observer",
        status: "working",
      }),
    });
    expect(invalidRole.status).toBe(400);

    const invalidApproval = await app.request("/api/tasks/task-1/consensus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        armId: "arm-1",
        status: "approved",
        approval: "maybe",
      }),
    });
    expect(invalidApproval.status).toBe(400);
  });

  it("persists report text and timestamps on consensus entries", async () => {
    const res = await app.request("/api/tasks/task-1/consensus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        armId: "arm-1",
        role: "primary",
        status: "working",
        report: "Started implementation",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConsensusResponse;
    const entry = body.entries[0]!;
    expect(entry.lastReport).toBe("Started implementation");
    expect(entry.lastReportAt).not.toBeNull();

    const row = db
      .query(
        "SELECT last_report, last_report_at FROM task_arm_consensus WHERE task_id = ? AND arm_id = ?",
      )
      .get("task-1", "arm-1") as {
      last_report: string | null;
      last_report_at: string | null;
    };
    expect(row.last_report).toBe("Started implementation");
    expect(row.last_report_at).not.toBeNull();
  });

  it("updates an existing consensus entry while preserving its role", async () => {
    await app.request("/api/tasks/task-1/consensus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        armId: "arm-1",
        role: "primary",
        status: "working",
      }),
    });

    const updateRes = await app.request("/api/tasks/task-1/consensus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        armId: "arm-1",
        status: "approved",
        approval: "approved",
      }),
    });
    expect(updateRes.status).toBe(200);
    const updateBody = (await updateRes.json()) as ConsensusResponse;
    expect(updateBody.entries[0]!.role).toBe("primary");
    expect(updateBody.entries[0]!.status).toBe("approved");

    const count = db
      .query(
        "SELECT COUNT(*) as count FROM task_arm_consensus WHERE task_id = ? AND arm_id = ?",
      )
      .get("task-1", "arm-1") as { count: number };
    expect(count.count).toBe(1);
  });

  it("only updates task row when consensus status actually changes", async () => {
    const before = db
      .query("SELECT consensus_status FROM tasks WHERE id = ?")
      .get("task-1") as { consensus_status: string };
    expect(before.consensus_status).toBe("pending");

    await app.request("/api/tasks/task-1/consensus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        armId: "arm-1",
        role: "primary",
        status: "working",
      }),
    });

    const afterWorking = db
      .query("SELECT consensus_status FROM tasks WHERE id = ?")
      .get("task-1") as { consensus_status: string };
    expect(afterWorking.consensus_status).toBe("in_progress");

    await app.request("/api/tasks/task-1/consensus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        armId: "arm-1",
        status: "approved",
        approval: "approved",
      }),
    });

    const afterApproved = db
      .query("SELECT consensus_status FROM tasks WHERE id = ?")
      .get("task-1") as { consensus_status: string };
    expect(afterApproved.consensus_status).toBe("reached");
  });
});
