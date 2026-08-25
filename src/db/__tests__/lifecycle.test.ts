import { afterEach, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { initDatabase } from "../index";
import {
  createTaskPass,
  getTaskPass,
  getTaskPasses,
  getActiveTaskPass,
  updateTaskPass,
  getNextPassNumber,
  createTaskLease,
  getTaskLease,
  getActiveTaskLease,
  releaseTaskLease,
  releaseActiveTaskLease,
  setTaskActiveLease,
  getTaskActiveLeaseId,
  createTaskDecision,
  getTaskDecisions,
  createTaskFileReference,
  getTaskFileReferences,
  recordDependencyEvent,
  getDependencyEvents,
  type TaskPassType,
} from "../lifecycle";

describe("task lifecycle persistence", () => {
  const testDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(testDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function createTestDb() {
    const dir = join(tmpdir(), `coleo-lifecycle-${crypto.randomUUID()}`);
    testDirs.push(dir);
    const db = await initDatabase(join(dir, "coleo.db"));
    return db;
  }

  function seedTaskAndArm(db: ReturnType<typeof createTestDb> extends Promise<infer T> ? T : never) {
    const armId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    db.run(
      `INSERT INTO arms (id, name, domain, harness, status) VALUES (?, ?, ?, ?, ?)`,
      [armId, "test-arm", "development", "kimi", "idle"],
    );
    db.run(
      `INSERT INTO tasks (id, subject, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [taskId, "Test task", "Description", "pending", new Date().toISOString(), new Date().toISOString()],
    );
    return { armId, taskId };
  }

  it("creates and retrieves task passes", async () => {
    const db = await createTestDb();
    const { taskId } = seedTaskAndArm(db);

    createTaskPass(db, {
      id: "pass-1",
      taskId,
      passNumber: 1,
      passType: "implement",
      branchName: "feature/task-1",
    });

    const pass = getTaskPass(db, "pass-1");
    expect(pass).toBeDefined();
    expect(pass?.taskId).toBe(taskId);
    expect(pass?.passType).toBe("implement");
    expect(pass?.status).toBe("active");
    expect(pass?.branchName).toBe("feature/task-1");

    db.close();
  });

  it("lists passes ordered by pass number and filters by status", async () => {
    const db = await createTestDb();
    const { taskId } = seedTaskAndArm(db);

    createTaskPass(db, { id: "p1", taskId, passNumber: 1, passType: "implement" });
    createTaskPass(db, { id: "p2", taskId, passNumber: 2, passType: "review" });
    updateTaskPass(db, "p1", { status: "completed" });

    const all = getTaskPasses(db, taskId);
    expect(all.map((p) => p.passNumber)).toEqual([2, 1]);

    const active = getTaskPasses(db, taskId, { status: "active" });
    expect(active.map((p) => p.id)).toEqual(["p2"]);

    db.close();
  });

  it("returns the active pass and computes the next pass number", async () => {
    const db = await createTestDb();
    const { taskId } = seedTaskAndArm(db);

    expect(getNextPassNumber(db, taskId)).toBe(1);
    createTaskPass(db, { id: "p1", taskId, passNumber: 1, passType: "implement" });
    expect(getNextPassNumber(db, taskId)).toBe(2);

    const active = getActiveTaskPass(db, taskId);
    expect(active?.id).toBe("p1");

    db.close();
  });

  it("ends a pass when status moves to terminal", async () => {
    const db = await createTestDb();
    const { taskId } = seedTaskAndArm(db);

    createTaskPass(db, { id: "p1", taskId, passNumber: 1, passType: "implement" });
    updateTaskPass(db, "p1", { status: "failed", resultSummary: "Tests failed" });

    const pass = getTaskPass(db, "p1");
    expect(pass?.status).toBe("failed");
    expect(pass?.endedAt).toBeDefined();
    expect(pass?.resultSummary).toBe("Tests failed");

    db.close();
  });

  it("creates and releases task leases", async () => {
    const db = await createTestDb();
    const { armId, taskId } = seedTaskAndArm(db);

    createTaskLease(db, { id: "lease-1", taskId, armId });

    const lease = getTaskLease(db, "lease-1");
    expect(lease?.status).toBe("active");

    const active = getActiveTaskLease(db, taskId);
    expect(active?.armId).toBe(armId);

    releaseTaskLease(db, "lease-1", "arm completed work");
    const released = getTaskLease(db, "lease-1");
    expect(released?.status).toBe("released");
    expect(released?.releaseReason).toBe("arm completed work");

    db.close();
  });

  it("tracks the active lease on the task row", async () => {
    const db = await createTestDb();
    const { armId, taskId } = seedTaskAndArm(db);

    createTaskLease(db, { id: "lease-1", taskId, armId });
    setTaskActiveLease(db, taskId, "lease-1");

    expect(getTaskActiveLeaseId(db, taskId)).toBe("lease-1");

    setTaskActiveLease(db, taskId, null);
    expect(getTaskActiveLeaseId(db, taskId)).toBeNull();

    db.close();
  });

  it("releases the active lease and clears the task row", async () => {
    const db = await createTestDb();
    const { armId, taskId } = seedTaskAndArm(db);

    createTaskLease(db, { id: "lease-1", taskId, armId });
    setTaskActiveLease(db, taskId, "lease-1");

    releaseActiveTaskLease(db, taskId, "manual release");

    expect(getTaskActiveLeaseId(db, taskId)).toBeNull();
    const lease = getTaskLease(db, "lease-1");
    expect(lease?.status).toBe("released");
    expect(lease?.releaseReason).toBe("manual release");

    db.close();
  });

  it("associates leases with passes", async () => {
    const db = await createTestDb();
    const { armId, taskId } = seedTaskAndArm(db);

    createTaskPass(db, { id: "p1", taskId, passNumber: 1, passType: "implement" });
    createTaskLease(db, { id: "lease-1", taskId, passId: "p1", armId });

    const lease = getTaskLease(db, "lease-1");
    expect(lease?.passId).toBe("p1");

    db.close();
  });

  it("records and retrieves decisions", async () => {
    const db = await createTestDb();
    const { taskId } = seedTaskAndArm(db);

    createTaskDecision(db, {
      id: "d1",
      taskId,
      decisionType: "approve",
      madeBy: "arm-a",
      madeByType: "arm",
      reason: "Looks good",
      confidence: 0.9,
    });

    const decisions = getTaskDecisions(db, taskId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decisionType).toBe("approve");
    expect(decisions[0]?.confidence).toBe(0.9);

    db.close();
  });

  it("records and retrieves file references by type", async () => {
    const db = await createTestDb();
    const { taskId } = seedTaskAndArm(db);

    createTaskFileReference(db, {
      id: "f1",
      taskId,
      filePath: ".project/plan.md",
      referenceType: "plan",
    });
    createTaskFileReference(db, {
      id: "f2",
      taskId,
      filePath: "src/index.ts",
      referenceType: "output",
    });

    const plans = getTaskFileReferences(db, taskId, { referenceType: "plan" });
    expect(plans).toHaveLength(1);
    expect(plans[0]?.filePath).toBe(".project/plan.md");

    db.close();
  });

  it("records and retrieves dependency events", async () => {
    const db = await createTestDb();
    const { taskId } = seedTaskAndArm(db);
    const depTaskId = crypto.randomUUID();
    db.run(
      `INSERT INTO tasks (id, subject, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [depTaskId, "Dep task", "Desc", "pending", new Date().toISOString(), new Date().toISOString()],
    );

    recordDependencyEvent(db, {
      taskId,
      dependsOnTaskId: depTaskId,
      eventType: "blocked",
      reason: "Prerequisite unfinished",
    });

    const events = getDependencyEvents(db, taskId);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("blocked");
    expect(events[0]?.dependsOnTaskId).toBe(depTaskId);

    db.close();
  });

  it("preserves existing task data when migration applies", async () => {
    const dir = join(tmpdir(), `coleo-lifecycle-migration-${crypto.randomUUID()}`);
    testDirs.push(dir);

    // Initialize with migrations up to 068, then insert data, then apply 069.
    const dbPath = join(dir, "coleo.db");
    const db = await initDatabase(dbPath);
    db.run(
      `INSERT INTO arms (id, name, domain, harness, status) VALUES (?, ?, ?, ?, ?)`,
      ["arm-1", "arm", "dev", "kimi", "idle"],
    );
    db.run(
      `INSERT INTO tasks (id, subject, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["task-1", "Subject", "Desc", "pending", new Date().toISOString(), new Date().toISOString()],
    );
    db.run(
      `INSERT INTO task_diffs (id, task_id, diff, author_type, author_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["diff-1", "task-1", "+line", "arm", "arm-1", new Date().toISOString(), new Date().toISOString()],
    );
    db.close();

    // Simulate migration 069 not yet applied by removing it from _migrations,
    // then reopening to apply it.
    const reopen = await initDatabase(dbPath);
    reopen.run("DELETE FROM _migrations WHERE name = '069_task_lifecycle'");
    reopen.close();

    const migrated = await initDatabase(dbPath);
    const diff = migrated.query("SELECT pass_id FROM task_diffs WHERE id = ?").get("diff-1") as {
      pass_id: string | null;
    };
    expect(diff.pass_id).toBeNull();

    const task = migrated.query("SELECT lease_id FROM tasks WHERE id = ?").get("task-1") as {
      lease_id: string | null;
    };
    expect(task.lease_id).toBeNull();

    const tables = migrated
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'task_%'")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("task_passes");
    expect(tableNames).toContain("task_leases");
    expect(tableNames).toContain("task_decisions");
    expect(tableNames).toContain("task_file_references");

    migrated.close();
  });

  it("enforces unique pass numbers per task", async () => {
    const db = await createTestDb();
    const { taskId } = seedTaskAndArm(db);

    createTaskPass(db, { id: "p1", taskId, passNumber: 1, passType: "implement" });

    expect(() =>
      createTaskPass(db, { id: "p2", taskId, passNumber: 1, passType: "review" }),
    ).toThrow();

    db.close();
  });
});
