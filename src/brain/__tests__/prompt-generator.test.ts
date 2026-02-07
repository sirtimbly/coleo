import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { __promptTestables, generateTaskDetermination } from "../prompt-generator";

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
}) {
  db.run(
    `INSERT INTO tasks (id, subject, description, status, priority, domain, phase, assigned_arms, consensus_status, dependency_blocked, source_type, source_ref, created_at, updated_at)
     VALUES (?, ?, 'desc', ?, ?, ?, ?, '[]', ?, 0, 'plan', 'test', ?, ?)`,
    [
      options.id,
      options.subject,
      options.status ?? "pending",
      options.priority ?? "normal",
      options.domain ?? null,
      options.phase ?? null,
      options.consensus_status ?? null,
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

    const plan = `## Phase 2: Progressive Planning\n- [ ] Build scheduling loop\n\n### Dependencies\n- Phase 1: Task Classification\n- Database migrations complete\n`;
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
    insertTask(db, {
      id: "phase1-db",
      subject: "Phase 1 Database Schema",
      status: "in_progress",
      phase: "Phase 1",
    });

    const result = __promptTestables.collectDependenciesForTask(db, {
      taskId: "phase2-api",
      subject: "Build API endpoints",
      phaseLabel: "Phase 2",
      planDependencies: ["Phase 1 Database Schema", "Missing feature X"],
    });

    expect(result.dependencies).toHaveLength(1);
    const dep = result.dependencies[0]!;
    expect(dep.taskId).toBe("phase1-db");
    expect(dep.blocking).toBe(true);
    expect(dep.reason).toContain("Plan dependency \"Phase 1 Database Schema\"");
    expect(dep.reason).toContain("API typically requires database schema");

    expect(result.planUpdateReasons.some(reason => reason.includes("Missing feature X"))).toBe(true);

    db.close();
  });

  it("blocks new tasks and records task_dependencies when prerequisites exist", () => {
    const db = createTestDb();
    insertTask(db, {
      id: "phase1-db",
      subject: "Phase 1 Database",
      status: "pending",
      phase: "Phase 1",
    });

    const planSection = `## Phase 2: Progressive Planning\n- [ ] Build API server\n\n### Dependencies\n- Phase 1 Database\n`;
    const result = __promptTestables.createPlanTaskDeliverable(
      db,
      {
        currentPhase: planSection,
        bullets: [],
        dependencies: ["Phase 1 Database"],
      },
      "Phase 2",
      NOW
    );

    expect(result).not.toBeNull();
    const taskId = result!.task!.id!;

    const inserted = db
      .query(`SELECT dependency_blocked FROM tasks WHERE id = ?`)
      .get(taskId) as { dependency_blocked: number };
    expect(inserted.dependency_blocked).toBe(1);

    const depRow = db
      .query(`SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?`)
      .get(taskId) as { depends_on_task_id: string };
    expect(depRow.depends_on_task_id).toBe("phase1-db");

    db.close();
  });

  it("creates plan-update tasks when dependencies cannot be resolved", () => {
    const db = createTestDb();

    const planSection = `## Phase 9: Observability\n- [ ] Implement WebSocket watchers\n`;
    __promptTestables.createPlanTaskDeliverable(
      db,
      {
        currentPhase: planSection,
        bullets: [],
        dependencies: [],
      },
      "Phase 9",
      NOW
    );

    const planUpdateTask = db
      .query(`SELECT subject, description FROM tasks WHERE subject LIKE 'Update plan dependencies%' ORDER BY created_at DESC LIMIT 1`)
      .get() as { subject: string; description: string } | undefined;

    expect(planUpdateTask).toBeDefined();
    expect(planUpdateTask!.subject).toBe("Update plan dependencies for Phase 9");
    expect(planUpdateTask!.description).toContain("Missing tracked dependency");

    db.close();
  });

  it("treats unassigned pending work as next pending task, not active task", async () => {
    const db = createTestDb();

    insertTask(db, {
      id: "pending-normal",
      subject: "Normal pending work",
      status: "pending",
      priority: "normal",
      phase: "Phase 1",
    });
    insertTask(db, {
      id: "pending-high",
      subject: "High priority pending work",
      status: "pending",
      priority: "high",
      phase: "Phase 1",
    });

    const result = await generateTaskDetermination({
      projectRoot: process.cwd(),
      coleoDir: process.cwd(),
      db,
    });

    expect(result.task?.id).toBe("pending-high");
    expect(result.reasoning).toContain("Returning next pending task from database");

    db.close();
  });
});
