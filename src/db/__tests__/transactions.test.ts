import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";

import { assignTaskToArm } from "../transactions";

const NOW = "2026-01-16T00:00:00.000Z";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      domain TEXT,
      assigned_to TEXT,
      dependency_blocked INTEGER DEFAULT 0,
      order_key TEXT,
      claimed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE arms (
      id TEXT PRIMARY KEY,
      name TEXT,
      domain TEXT,
      status TEXT NOT NULL
    );

    CREATE TABLE config (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE task_arm_consensus (
      task_id TEXT NOT NULL,
      arm_id TEXT NOT NULL,
      role TEXT,
      status TEXT,
      created_at TEXT,
      updated_at TEXT,
      PRIMARY KEY (task_id, arm_id)
    );
  `);
  return db;
}

function insertTask(
  db: Database,
  id: string,
  options: {
    status?: string;
    assignedTo?: string | null;
    dependencyBlocked?: boolean;
    orderKey?: string | null;
    createdAt?: string;
  } = {},
): void {
  db.run(
    `INSERT INTO tasks (id, subject, status, assigned_to, dependency_blocked, order_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      `Task ${id}`,
      options.status ?? "pending",
      options.assignedTo ?? null,
      options.dependencyBlocked ? 1 : 0,
      options.orderKey ?? null,
      options.createdAt ?? NOW,
      NOW,
    ],
  );
}

function insertArm(db: Database, id: string, status = "idle"): void {
  db.run("INSERT INTO arms (id, name, domain, status) VALUES (?, ?, 'general', ?)", [
    id,
    id,
    status,
  ]);
}

describe("assignTaskToArm top-K claim guard", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("rejects claims beyond fixed claim_top_k and allows claims within it", async () => {
    db.run("INSERT INTO config (key, value) VALUES ('claim_top_k', '2')");
    insertTask(db, "task-a", { orderKey: "a" });
    insertTask(db, "task-b", { orderKey: "b" });
    insertTask(db, "task-c", { orderKey: "c" });
    insertArm(db, "arm-1");

    const rejected = await assignTaskToArm(db, "task-c", "arm-1", "primary", true);
    expect(rejected.success).toBe(false);
    expect(rejected.error).toContain("top 2");

    const rankOne = await assignTaskToArm(db, "task-a", "arm-1", "primary", true);
    expect(rankOne.success).toBe(true);

    // task-b is now rank 1 after task-a was claimed
    const rankTwo = await assignTaskToArm(db, "task-b", "arm-1", "primary", true);
    expect(rankTwo.success).toBe(true);
  });

  it("allows idempotent re-claim by the same arm", async () => {
    db.run("INSERT INTO config (key, value) VALUES ('claim_top_k', '1')");
    insertTask(db, "task-a", { orderKey: "a" });
    insertArm(db, "arm-1");

    const first = await assignTaskToArm(db, "task-a", "arm-1", "primary", true);
    expect(first.success).toBe(true);

    const again = await assignTaskToArm(db, "task-a", "arm-1", "primary", true);
    expect(again.success).toBe(true);
  });

  it("rejects a claim for a task already claimed by another arm", async () => {
    db.run("INSERT INTO config (key, value) VALUES ('claim_top_k', '5')");
    insertTask(db, "task-a", { orderKey: "a" });
    insertArm(db, "arm-1");
    insertArm(db, "arm-2");

    const first = await assignTaskToArm(db, "task-a", "arm-1", "primary", true);
    expect(first.success).toBe(true);

    const second = await assignTaskToArm(db, "task-a", "arm-2", "primary", true);
    expect(second.success).toBe(false);
    expect(second.error).toContain("not claimable");
  });

  it("rejects claims for non-pending tasks", async () => {
    insertTask(db, "task-done", { status: "completed", orderKey: "a" });
    insertArm(db, "arm-1");

    const result = await assignTaskToArm(db, "task-done", "arm-1", "primary", true);
    expect(result.success).toBe(false);
    expect(result.error).toContain("not claimable");
  });

  it("rejects claims for dependency-blocked tasks", async () => {
    insertTask(db, "task-blocked", { orderKey: "a", dependencyBlocked: true });
    insertArm(db, "arm-1");

    const result = await assignTaskToArm(db, "task-blocked", "arm-1", "primary", true);
    expect(result.success).toBe(false);
    expect(result.error).toContain("not claimable");
  });

  it("defaults K dynamically to the number of active arms", async () => {
    insertTask(db, "task-a", { orderKey: "a" });
    insertTask(db, "task-b", { orderKey: "b" });
    insertTask(db, "task-c", { orderKey: "c" });
    insertArm(db, "arm-1", "idle");
    insertArm(db, "arm-2", "running");
    insertArm(db, "arm-3", "stopped");

    // 2 active arms -> K=2; rank 3 claim is rejected
    const rankThree = await assignTaskToArm(db, "task-c", "arm-2", "primary", true);
    expect(rankThree.success).toBe(false);
    expect(rankThree.error).toContain("top 2");

    const rankTwo = await assignTaskToArm(db, "task-b", "arm-1", "primary", true);
    expect(rankTwo.success).toBe(true);

    // task-c shifts to rank 2 after task-b is claimed
    const shifted = await assignTaskToArm(db, "task-c", "arm-2", "primary", true);
    expect(shifted.success).toBe(true);
  });

  it("allows exactly one winner when two arms race to claim the same task", async () => {
    insertTask(db, "task-a", { orderKey: "a" });
    insertArm(db, "arm-1");
    insertArm(db, "arm-2");

    const [first, second] = await Promise.all([
      assignTaskToArm(db, "task-a", "arm-1", "primary", true),
      assignTaskToArm(db, "task-a", "arm-2", "primary", true),
    ]);

    const successes = [first, second].filter((result) => result.success);
    expect(successes).toHaveLength(1);

    const row = db
      .query("SELECT assigned_to, status FROM tasks WHERE id = 'task-a'")
      .get() as { assigned_to: string; status: string };
    expect(["arm-1", "arm-2"]).toContain(row.assigned_to);
    expect(row.status).toBe("claimed");
  });

  it("allows top-ranked concurrent claims for distinct tasks up to K", async () => {
    db.run("INSERT INTO config (key, value) VALUES ('claim_top_k', '2')");
    insertTask(db, "task-a", { orderKey: "a" });
    insertTask(db, "task-b", { orderKey: "b" });
    insertArm(db, "arm-1");
    insertArm(db, "arm-2");

    const [first, second] = await Promise.all([
      assignTaskToArm(db, "task-a", "arm-1", "primary", true),
      assignTaskToArm(db, "task-b", "arm-2", "primary", true),
    ]);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
  });

  it("does not enforce the guard for non-claim assignments", async () => {
    db.run("INSERT INTO config (key, value) VALUES ('claim_top_k', '1')");
    insertTask(db, "task-a", { orderKey: "a" });
    insertTask(db, "task-b", { orderKey: "b" });
    insertArm(db, "arm-1");

    const result = await assignTaskToArm(db, "task-b", "arm-1", "primary", false);
    expect(result.success).toBe(true);
  });
});
