import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { __promptTestables, generateTaskDetermination } from "../prompt-generator";
import { createSqliteBrainDb } from "../../db/brain-db-adapter";

const NOW = new Date("2026-01-16T00:00:00Z").toISOString();

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      domain TEXT,
      phase TEXT,
      assigned_arms TEXT DEFAULT '[]',
      consensus_status TEXT,
      dependency_blocked INTEGER DEFAULT 0,
      source_type TEXT,
      source_ref TEXT,
      order_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE task_dependencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL,
      dependency_type TEXT,
      auto_detected INTEGER,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function insertTask(db: Database, options: {
  id: string;
  subject: string;
  status?: string;
  priority?: string;
  domain?: string | null;
  phase?: string | null;
  consensus_status?: string | null;
  source_ref?: string | null;
  order_key?: string | null;
}) {
  db.run(
    `INSERT INTO tasks (id, subject, description, status, priority, domain, phase, assigned_arms, consensus_status, dependency_blocked, source_type, source_ref, order_key, created_at, updated_at)
     VALUES (?, ?, 'desc', ?, ?, ?, ?, '[]', ?, 0, 'plan', ?, ?, ?, ?)`,
    [
      options.id,
      options.subject,
      options.status ?? "pending",
      options.priority ?? "normal",
      options.domain ?? null,
      options.phase ?? null,
      options.consensus_status ?? null,
      options.source_ref ?? "test",
      options.order_key ?? null,
      NOW,
      NOW,
    ]
  );
}

describe("prompt-generator dependencies", () => {
  it("extracts dependencies from the current plan section", async () => {
    const root = await mkdtemp(join(tmpdir(), "coleo-plan-"));
    const projectDir = join(root, ".project");
    await mkdir(projectDir, { recursive: true });

    const plan = `## Phase 2: Progressive Planning
- [ ] Build scheduling loop

### Dependencies
- Phase 1: Task Classification
- Database migrations complete
`;
    await writeFile(join(projectDir, "plan.md"), plan, "utf-8");

    const result = await __promptTestables.readCurrentPlan(root);
    expect(result.dependencies).toEqual([
      "Phase 1: Task Classification",
      "Database migrations complete",
    ]);

    await rm(root, { recursive: true, force: true });
  });

  it("merges plan and keyword-based dependencies", () => {
    const db = createTestDb();
    const brainDb = createSqliteBrainDb(db);
    insertTask(db, {
      id: "phase1-db",
      subject: "Phase 1 Database Schema",
      status: "in_progress",
      phase: "Phase 1",
    });

    const result = __promptTestables.collectDependenciesForTask(brainDb, {
      taskId: "phase2-api",
      subject: "Build API endpoints",
      phaseLabel: "Phase 2",
      planDependencies: ["Phase 1 Database Schema", "Missing feature X"],
    });

    expect(result.dependencies).toHaveLength(1);
    const dep = result.dependencies[0]!;
    expect(dep.taskId).toBe("phase1-db");
    expect(dep.blocking).toBe(true);
    expect(dep.reason).toContain(`Plan dependency "Phase 1 Database Schema"`);
    expect(dep.reason).toContain("API typically requires database schema");

    expect(result.planUpdateReasons.some(reason => reason.includes("Missing feature X"))).toBe(true);

    db.close();
  });

  it("creates plan-update tasks when dependencies cannot be resolved", () => {
    const db = createTestDb();
    const brainDb = createSqliteBrainDb(db);

    __promptTestables.ensurePlanDependencyTask(brainDb, {
      phaseLabel: "Phase 9",
      reasons: ["Missing tracked dependency: Unknown Service"],
      now: NOW,
    });

    const planUpdateTask = db
      .query(`SELECT subject, description FROM tasks WHERE subject LIKE 'Update plan dependencies%' ORDER BY created_at DESC LIMIT 1`)
      .get() as { subject: string; description: string } | undefined;

    expect(planUpdateTask).toBeDefined();
    expect(planUpdateTask!.subject).toBe("Update plan dependencies for Phase 9");
    expect(planUpdateTask!.description).toContain("Missing tracked dependency");

    db.close();
  });

  it("does not create duplicate plan-update tasks", () => {
    const db = createTestDb();
    const brainDb = createSqliteBrainDb(db);

    __promptTestables.ensurePlanDependencyTask(brainDb, {
      phaseLabel: "Phase 9",
      reasons: ["Missing tracked dependency: X"],
      now: NOW,
    });
    __promptTestables.ensurePlanDependencyTask(brainDb, {
      phaseLabel: "Phase 9",
      reasons: ["Missing tracked dependency: Y"],
      now: NOW,
    });

    const count = db
      .query(`SELECT COUNT(*) as cnt FROM tasks WHERE subject = 'Update plan dependencies for Phase 9'`)
      .get() as { cnt: number };
    expect(count.cnt).toBe(1);

    db.close();
  });

  it("extracts dependencies with asterisks, multiline entries, and stops at the next section", async () => {
    const root = await mkdtemp(join(tmpdir(), "coleo-plan-"));
    const projectDir = join(root, ".project");
    await mkdir(projectDir, { recursive: true });

    const plan = `## Phase 3: Integration
- [ ] Wire services

### Dependencies
* Phase 1: Foundations
* Phase 2: Core API
  continued on next line
### Deliverables
- [ ] Integration tests
`;
    await writeFile(join(projectDir, "plan.md"), plan, "utf-8");

    const result = await __promptTestables.readCurrentPlan(root);
    expect(result.dependencies).toEqual([
      "Phase 1: Foundations",
      "Phase 2: Core API continued on next line",
    ]);

    await rm(root, { recursive: true, force: true });
  });

  it("returns empty dependencies when the section is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "coleo-plan-"));
    const projectDir = join(root, ".project");
    await mkdir(projectDir, { recursive: true });

    const plan = `## Phase 1: Basics
- [ ] One thing
`;
    await writeFile(join(projectDir, "plan.md"), plan, "utf-8");

    const result = await __promptTestables.readCurrentPlan(root);
    expect(result.dependencies).toEqual([]);

    await rm(root, { recursive: true, force: true });
  });

  it("treats completed plan dependencies as non-blocking", () => {
    const db = createTestDb();
    const brainDb = createSqliteBrainDb(db);
    insertTask(db, {
      id: "phase1-db",
      subject: "Phase 1 Database Schema",
      status: "completed",
      phase: "Phase 1",
    });

    const result = __promptTestables.collectDependenciesForTask(brainDb, {
      taskId: "phase2-api",
      subject: "Build API endpoints",
      phaseLabel: "Phase 2",
      planDependencies: ["Phase 1 Database Schema"],
    });

    const planDep = result.dependencies.find(
      (dep) => dep.taskId === "phase1-db" && dep.reason.includes("Plan dependency"),
    );
    expect(planDep).toBeDefined();
    expect(planDep!.blocking).toBe(false);
    expect(
      result.planUpdateReasons.some((reason) =>
        reason.includes("Phase 1 Database Schema"),
      ),
    ).toBe(false);

    db.close();
  });

  it("treats dependencies with reached consensus as non-blocking", () => {
    const db = createTestDb();
    const brainDb = createSqliteBrainDb(db);
    insertTask(db, {
      id: "phase1-db",
      subject: "Phase 1 Database Schema",
      status: "pending",
      consensus_status: "reached",
      phase: "Phase 1",
    });

    const result = __promptTestables.collectDependenciesForTask(brainDb, {
      taskId: "phase2-api",
      subject: "Build API endpoints",
      phaseLabel: "Phase 2",
      planDependencies: ["Phase 1 Database Schema"],
    });

    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]!.blocking).toBe(false);

    db.close();
  });

  it("matches plan dependencies against task phase as well as subject", () => {
    const db = createTestDb();
    const brainDb = createSqliteBrainDb(db);
    insertTask(db, {
      id: "phase1-task",
      subject: "Some unrelated subject",
      status: "in_progress",
      phase: "Phase 1",
    });

    const result = __promptTestables.collectDependenciesForTask(brainDb, {
      taskId: "phase2-api",
      subject: "Build API endpoints",
      phaseLabel: "Phase 2",
      planDependencies: ["Phase 1"],
    });

    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]!.taskId).toBe("phase1-task");
    expect(result.dependencies[0]!.blocking).toBe(true);

    db.close();
  });

  it("deduplicates dependencies discovered by both plan and keyword matching", () => {
    const db = createTestDb();
    const brainDb = createSqliteBrainDb(db);
    insertTask(db, {
      id: "phase1-db",
      subject: "Phase 1 Database Schema",
      status: "in_progress",
      phase: "Phase 1",
    });

    const result = __promptTestables.collectDependenciesForTask(brainDb, {
      taskId: "phase2-api",
      subject: "Build API endpoints",
      phaseLabel: "Phase 2",
      planDependencies: ["Phase 1 Database Schema"],
    });

    expect(result.dependencies).toHaveLength(1);
    expect(result.dependencies[0]!.reason).toContain(
      `Plan dependency "Phase 1 Database Schema"`,
    );
    expect(result.dependencies[0]!.reason).toContain("API typically requires database schema");

    db.close();
  });

  it("returns only plan-update reasons when every plan dependency is unresolved", () => {
    const db = createTestDb();
    const brainDb = createSqliteBrainDb(db);

    const result = __promptTestables.collectDependenciesForTask(brainDb, {
      taskId: "phase2-api",
      subject: "Build API endpoints",
      phaseLabel: "Phase 2",
      planDependencies: ["Missing Service A", "Missing Service B"],
    });

    expect(result.dependencies).toHaveLength(0);
    expect(
      result.planUpdateReasons.some((reason) => reason.includes("Missing Service A")),
    ).toBe(true);
    expect(
      result.planUpdateReasons.some((reason) => reason.includes("Missing Service B")),
    ).toBe(true);

    db.close();
  });

  it("creates plan-update tasks with the architect domain", () => {
    const db = createTestDb();
    const brainDb = createSqliteBrainDb(db);

    __promptTestables.ensurePlanDependencyTask(brainDb, {
      phaseLabel: "Phase 9",
      reasons: ["Missing tracked dependency: Unknown Service"],
      now: NOW,
    });

    const planUpdateTask = db
      .query(`SELECT domain FROM tasks WHERE subject = 'Update plan dependencies for Phase 9'`)
      .get() as { domain: string } | undefined;

    expect(planUpdateTask).toBeDefined();
    expect(planUpdateTask!.domain).toBe("architect");

    db.close();
  });

  it("blocks pending work with unfinished plan dependencies and falls back to prerequisite work", async () => {
    const root = await mkdtemp(join(tmpdir(), "coleo-plan-"));
    const projectDir = join(root, ".project");
    await mkdir(projectDir, { recursive: true });

    const plan = `## Phase 1: Foundations
- [x] Database schema

## Phase 2: API
- [ ] Build API endpoints

### Dependencies
- Phase 1 Database Schema
`;
    await writeFile(join(projectDir, "plan.md"), plan, "utf-8");

    const db = createTestDb();
    const brainDb = createSqliteBrainDb(db);

    insertTask(db, {
      id: "phase2-api",
      subject: "Build API endpoints",
      status: "pending",
      priority: "normal",
      phase: "Phase 2",
      order_key: "b",
    });
    insertTask(db, {
      id: "phase1-db",
      subject: "Phase 1 Database Schema",
      status: "pending",
      priority: "normal",
      phase: "Phase 1",
      order_key: "a",
    });

    const result = await generateTaskDetermination({
      projectRoot: root,
      coleoDir: root,
      db: brainDb,
    });

    expect(result.task?.id).toBe("phase1-db");
    expect(result.reasoning).toContain("outside dominant phase Phase 2");

    const blocked = db
      .query("SELECT dependency_blocked FROM tasks WHERE id = ?")
      .get("phase2-api") as { dependency_blocked: number };
    expect(blocked.dependency_blocked).toBe(1);

    const depRows = db
      .query("SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?")
      .all("phase2-api") as Array<{ depends_on_task_id: string }>;
    expect(depRows.map((row) => row.depends_on_task_id)).toContain("phase1-db");

    await rm(root, { recursive: true, force: true });
    db.close();
  });

  it("treats unassigned pending work as next pending task, not active task", async () => {
    const db = createTestDb();
    const brainDb = createSqliteBrainDb(db);

    insertTask(db, {
      id: "pending-high",
      subject: "High priority pending work",
      status: "pending",
      priority: "high",
      phase: "Phase 1",
      order_key: "b",
    });
    insertTask(db, {
      id: "pending-normal",
      subject: "Normal pending work",
      status: "pending",
      priority: "normal",
      phase: "Phase 1",
      order_key: "a",
    });

    const result = await generateTaskDetermination({
      projectRoot: process.cwd(),
      coleoDir: process.cwd(),
      db: brainDb,
    });

    expect(result.task?.id).toBe("pending-normal");
    expect(result.reasoning).toContain("Returning next pending task from database");

    db.close();
  });

  it("selects validation follow-ups instead of unassigned completing work", async () => {
    const db = createTestDb();
    const brainDb = createSqliteBrainDb(db);

    insertTask(db, {
      id: "original-task",
      subject: "Original task",
      status: "completing",
      phase: "Phase 1",
    });
    insertTask(db, {
      id: "validation-task",
      subject: "Validate completion: Original task",
      status: "pending",
      priority: "high",
      phase: "Phase 1",
      source_ref: "original-task",
      order_key: "a",
    });
    insertTask(db, {
      id: "next-task",
      subject: "Next implementation task",
      status: "pending",
      phase: "Phase 1",
      order_key: "b",
    });

    const validation = await generateTaskDetermination({
      projectRoot: process.cwd(),
      coleoDir: process.cwd(),
      db: brainDb,
    });
    expect(validation.task?.id).toBe("validation-task");
    expect(validation.reasoning).toContain("Returning next pending task");

    const sameWorker = await generateTaskDetermination(
      {
        projectRoot: process.cwd(),
        coleoDir: process.cwd(),
        db: brainDb,
      },
      { excludeVerificationForTaskIds: ["original-task"] },
    );
    expect(sameWorker.task?.id).toBe("next-task");

    db.close();
  });

  it("falls back across phases when dominant phase has no assignable work", async () => {
    const db = createTestDb();
    const brainDb = createSqliteBrainDb(db);

    insertTask(db, {
      id: "phase-stale-1",
      subject: "Completed stale 1",
      status: "completed",
      priority: "normal",
      phase: "Phase stale",
    });
    insertTask(db, {
      id: "phase-stale-2",
      subject: "Completed stale 2",
      status: "completed",
      priority: "normal",
      phase: "Phase stale",
    });
    insertTask(db, {
      id: "phase-stale-3",
      subject: "Completed stale 3",
      status: "completed",
      priority: "normal",
      phase: "Phase stale",
    });

    insertTask(db, {
      id: "phase-fresh-pending",
      subject: "Fresh pending work",
      status: "pending",
      priority: "high",
      phase: "Phase fresh",
    });

    const result = await generateTaskDetermination({
      projectRoot: process.cwd(),
      coleoDir: process.cwd(),
      db: brainDb,
    });

    expect(result.task?.id).toBe("phase-fresh-pending");
    expect(result.reasoning).toContain("outside dominant phase Phase stale");

    db.close();
  });

  it("skips the just-completed task and its verify follow-up when excluded", async () => {
    const db = createTestDb();
    const brainDb = createSqliteBrainDb(db);

    insertTask(db, {
      id: "task-old",
      subject: "Implement API endpoint",
      status: "claimed",
      priority: "high",
      phase: "Phase 1",
    });
    insertTask(db, {
      id: "verify-race1",
      subject: "Verify & Polish: Implement API endpoint",
      status: "pending",
      priority: "high",
      phase: "Phase 1",
      source_ref: "task-old",
    });
    insertTask(db, {
      id: "task-next",
      subject: "Update API docs",
      status: "pending",
      priority: "normal",
      phase: "Phase 1",
    });

    const result = await generateTaskDetermination(
      {
        projectRoot: process.cwd(),
        coleoDir: process.cwd(),
        db: brainDb,
      },
      {
        excludeTaskIds: ["task-old"],
        excludeVerificationForTaskIds: ["task-old"],
      },
    );

    expect(result.task?.id).toBe("task-next");
    expect(result.reasoning).toContain("Returning next pending task from database");

    db.close();
  });
});
