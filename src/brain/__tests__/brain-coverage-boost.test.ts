import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { Brain } from "../brain";
import { initDatabase, type Database } from "../../db";
import type { Task, Arm } from "../../types";

function nowIso() {
  return new Date().toISOString();
}

describe("Brain coverage boost", () => {
  let testDir: string;
  let db: Database;
  let brain: Brain;
  let sentToHuman: Array<{ subject: string; body: string }>; 

  beforeEach(async () => {
    testDir = join("/tmp", `coleo-brain-coverage-boost-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

    await mkdir(join(testDir, "mail", "inbox", "new"), { recursive: true });
    await mkdir(join(testDir, "mail", "inbox", "cur"), { recursive: true });
    await mkdir(join(testDir, "mail", "inbox", "tmp"), { recursive: true });

    db = await initDatabase(join(testDir, "coleo.db"));

    brain = new Brain({
      coleoDir: testDir,
      pollIntervalMs: 1000,
      verbose: false,
    });

    (brain as any).db = db;

    // Ensure templates are available for renderTemplate calls
    await (brain as any).templates.ensureTemplatesExist();

    sentToHuman = [];
    (brain as any).sendToHuman = async (message: { subject: string; body: string }) => {
      sentToHuman.push(message);
    };
    (brain as any).sendPromptToArm = async () => true;
    (brain as any).isApiServerAvailable = async () => true;
    (brain as any).apiRequest = async <T>(path: string, options: RequestInit = {}) => {
      const taskFromRow = (row: {
        id: string;
        subject: string;
        description: string;
        status: string;
        priority: string;
        domain: string | null;
        classification?: string | null;
        assigned_to: string | null;
        dependency_blocked?: number | null;
        sort_order?: number | null;
        created_at: string;
        updated_at: string;
        completed_at: string | null;
        artifacts: string | null;
        mail_thread_id?: string | null;
        context?: string | null;
      }) => ({
        id: row.id,
        subject: row.subject,
        description: row.description,
        status: row.status,
        priority: row.priority,
        domain: row.domain,
        classification: row.classification || null,
        assignedTo: row.assigned_to,
        dependencyBlocked: row.dependency_blocked === 1,
        sortOrder: row.sort_order ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
        artifacts: row.artifacts ? JSON.parse(row.artifacts) : [],
        mailThreadId: row.mail_thread_id || null,
        context: row.context ? JSON.parse(row.context) : {},
      });

      if (path === "/api/status") {
        return {
          infrastructure: {
            database: { healthy: true },
            nats: { healthy: true, optional: true },
            maildir: { healthy: true },
          },
        } as T;
      }

      if (
        path === "/api/brain/internal/infrastructure-health" &&
        options.method === "POST"
      ) {
        return {
          result: { success: true },
        } as T;
      }

      if (path.startsWith("/api/tasks?")) {
        const query = path.split("?")[1] || "";
        const params = new URLSearchParams(query);
        const statusFilter = params.get("status");
        const statuses = statusFilter
          ? statusFilter.split(",").map((s) => s.trim()).filter(Boolean)
          : [];
        const rows = (statuses.length > 0
          ? db
              .query(`
                SELECT id, subject, description, status, priority, domain, classification,
                       assigned_to, dependency_blocked, sort_order,
                       created_at, updated_at, completed_at, artifacts, mail_thread_id, context
                FROM tasks
                WHERE status IN (${statuses.map(() => "?").join(",")})
                ORDER BY created_at DESC
              `)
              .all(...statuses)
          : db
              .query(`
                SELECT id, subject, description, status, priority, domain, classification,
                       assigned_to, dependency_blocked, sort_order,
                       created_at, updated_at, completed_at, artifacts, mail_thread_id, context
                FROM tasks
                ORDER BY created_at DESC
              `)
              .all()) as Array<{
          id: string;
          subject: string;
          description: string;
          status: string;
          priority: string;
          domain: string | null;
          classification: string | null;
          assigned_to: string | null;
          dependency_blocked: number | null;
          sort_order: number | null;
          created_at: string;
          updated_at: string;
          completed_at: string | null;
          artifacts: string | null;
          mail_thread_id: string | null;
          context: string | null;
        }>;

        const statusRows = db
          .query("SELECT status, COUNT(*) as count FROM tasks GROUP BY status")
          .all() as Array<{ status: string; count: number }>;
        const byStatus = Object.fromEntries(statusRows.map((r) => [r.status, r.count]));

        return {
          tasks: rows.map(taskFromRow),
          counts: { byStatus },
        } as T;
      }

      if (path === "/api/tasks" && options.method === "POST") {
        const body = JSON.parse(String(options.body || "{}")) as {
          id?: string;
          subject: string;
          description: string;
          status?: string;
          priority?: string;
          domain?: string;
          classification?: string;
          mailThreadId?: string;
          context?: Record<string, unknown>;
        };
        const id = body.id || `task-${Date.now()}`;
        const now = nowIso();
        db.run(
          `INSERT INTO tasks (id, subject, description, status, priority, domain, classification, mail_thread_id, context, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            body.subject,
            body.description,
            body.status || "pending",
            body.priority || "normal",
            body.domain || null,
            body.classification || null,
            body.mailThreadId || null,
            JSON.stringify(body.context || {}),
            now,
            now,
          ],
        );
      }

      if (path === "/api/tasks/reorder" && options.method === "POST") {
        const body = JSON.parse(String(options.body || "{}")) as {
          taskId: string;
          toSortOrder: number;
        };
        const rows = db
          .query(
            "SELECT id FROM tasks ORDER BY sort_order ASC, created_at DESC"
          )
          .all() as Array<{ id: string }>;
        const ids = rows.map((row) => row.id);
        const fromIndex = ids.indexOf(body.taskId);
        if (fromIndex >= 0) {
          const [moved] = ids.splice(fromIndex, 1);
          if (moved) {
            const toIndex =
              body.toSortOrder < 0
                ? ids.length
                : Math.min(body.toSortOrder, ids.length);
            ids.splice(toIndex, 0, moved);
            ids.forEach((id, idx) => {
              db.run("UPDATE tasks SET sort_order = ? WHERE id = ?", [idx, id]);
            });
          }
        }
        return { success: true } as T;
      }

      if (path.startsWith("/api/tasks/")) {
        const taskId = decodeURIComponent(path.split("/").pop() || "");
        if (options.method === "PATCH") {
          const body = JSON.parse(String(options.body || "{}")) as {
            status?: string;
            assignedTo?: string | null;
            dependencyBlocked?: boolean;
            artifacts?: string[];
            context?: Record<string, unknown>;
          };
          const updates: string[] = [];
          const values: unknown[] = [];
          if (body.status !== undefined) {
            updates.push("status = ?");
            values.push(body.status);
            if (body.status === "completed") {
              updates.push("completed_at = ?");
              values.push(nowIso());
            }
          }
          if (body.assignedTo !== undefined) {
            updates.push("assigned_to = ?");
            values.push(body.assignedTo);
          }
          if (body.dependencyBlocked !== undefined) {
            updates.push("dependency_blocked = ?");
            values.push(body.dependencyBlocked ? 1 : 0);
          }
          if (body.artifacts !== undefined) {
            updates.push("artifacts = ?");
            values.push(JSON.stringify(body.artifacts));
          }
          if (body.context !== undefined) {
            updates.push("context = ?");
            values.push(JSON.stringify(body.context));
          }
          updates.push("updated_at = ?");
          values.push(nowIso());
          values.push(taskId);
          db.run(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`, values as (string | number | null)[]);
        }

        const row = db.query(`
          SELECT
            t.id, t.subject, t.description, t.status, t.priority, t.domain, t.classification,
            t.assigned_to, t.dependency_blocked, t.sort_order,
            t.created_at, t.updated_at, t.completed_at, t.artifacts, t.mail_thread_id, t.context
          FROM tasks t
          WHERE t.id = ?
        `).get(taskId) as {
          id: string;
          subject: string;
          description: string;
          status: string;
          priority: string;
          domain: string | null;
          classification: string | null;
          assigned_to: string | null;
          dependency_blocked: number | null;
          sort_order: number | null;
          created_at: string;
          updated_at: string;
          completed_at: string | null;
          artifacts: string | null;
          mail_thread_id: string | null;
          context: string | null;
        } | null;

        if (!row) return null;

        return {
          task: taskFromRow(row),
        } as T;
      }

      if (path.startsWith("/api/bugs")) {
        const rows = db.query(`
          SELECT id, title, status, priority, blockers
          FROM bugs
          ORDER BY created_at DESC
        `).all() as Array<{
          id: string;
          title: string;
          status: string;
          priority: string;
          blockers: string | null;
        }>;
        return {
          bugs: rows.map((row) => ({
            id: row.id,
            title: row.title,
            status: row.status,
            priority: row.priority,
            blockers: row.blockers ? JSON.parse(row.blockers) : [],
          })),
        } as T;
      }

      if (path.startsWith("/api/status-reports?")) {
        const query = path.split("?")[1] || "";
        const params = new URLSearchParams(query);
        const taskId = params.get("taskId");
        if (!taskId) {
          return { reports: [] } as T;
        }
        const rows = db
          .query(`
            SELECT id, status, summary, issues, next_steps, tests_status
            FROM status_reports
            WHERE task_id = ?
            ORDER BY created_at DESC
          `)
          .all(taskId) as Array<{
          id: string;
          status: string;
          summary: string;
          issues: string | null;
          next_steps: string | null;
          tests_status: string | null;
        }>;
        return {
          reports: rows.map((row) => ({
            id: row.id,
            status: row.status,
            summary: row.summary,
            issues: row.issues ? JSON.parse(row.issues) : [],
            nextSteps: row.next_steps || undefined,
            testsStatus: row.tests_status || undefined,
          })),
        } as T;
      }

      if (path === "/api/status-reports" && options.method === "POST") {
        const body = JSON.parse(String(options.body || "{}")) as {
          taskId: string;
          armId: string;
          status: string;
          summary: string;
          issues?: string[];
          blockers?: string[];
          nextSteps?: string;
          filesChanged?: string[];
          testsStatus?: string;
        };
        const id = `report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        db.run(
          `INSERT INTO status_reports (id, task_id, arm_id, status, summary, issues, blockers, next_steps, files_changed, tests_status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            body.taskId,
            body.armId,
            body.status,
            body.summary,
            JSON.stringify(body.issues || []),
            JSON.stringify(body.blockers || []),
            body.nextSteps || null,
            JSON.stringify(body.filesChanged || []),
            body.testsStatus || null,
            nowIso(),
          ],
        );
        return { report: { id } } as T;
      }

      if (path === "/api/brain/internal/assign-task" && options.method === "POST") {
        return {
          result: {
            success: true,
            data: { needsMoreArms: false },
          },
        } as T;
      }

      if (path.startsWith("/api/arms/") || path === "/api/arms") {
        if (path === "/api/arms" && options.method === "POST") {
          const body = JSON.parse(String(options.body || "{}")) as {
            name: string;
            domain?: string;
            harness?: string;
          };
          const now = nowIso();
          db.run(
            `INSERT OR IGNORE INTO arms (id, name, domain, harness, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [body.name, body.name, body.domain || "general", body.harness || "manual", "running", now, now],
          );
          return { arm: { id: body.name } } as T;
        }
        if (options.method === "PATCH" || options.method === "POST") {
          return { success: true } as T;
        }
      }

      return null;
    };

    // Avoid filesystem reads in health check
    (brain as any).inbox.list = async () => [];

    const now = nowIso();

    // Seed arms
    db.run(
      "INSERT INTO arms (id, name, domain, harness, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["arm-1", "ArmOne", "general", "opencode-api", "idle", now, now]
    );

    const arm: Arm = {
      id: "arm-1",
      name: "ArmOne",
      agent: "opencode",
      status: "idle",
      startedAt: new Date(),
    };

    (brain as any).arms = new Map([[arm.id, arm]]);

    // Seed tasks
    const tasks: Task[] = [
      {
        id: "task-blocked-defer",
        subject: "Blocked defer",
        description: "Blocked task",
        status: "pending",
        priority: "normal",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "task-blocked-standard",
        subject: "Blocked standard",
        description: "Blocked task",
        status: "pending",
        priority: "normal",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "task-issues",
        subject: "Issues found",
        description: "Issues task",
        status: "pending",
        priority: "normal",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "task-review",
        subject: "Needs review",
        description: "Review task",
        status: "pending",
        priority: "normal",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "task-completed-issues",
        subject: "Completed with issues",
        description: "Completed issues task",
        status: "pending",
        priority: "high",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "task-other-pending",
        subject: "Other pending",
        description: "Pending task",
        status: "pending",
        priority: "normal",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    (brain as any).tasks = [...tasks];

    for (const task of tasks) {
      db.run(
        "INSERT INTO tasks (id, subject, description, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [task.id, task.subject, task.description, task.status, task.priority, now, now]
      );
    }
  });

  afterEach(async () => {
    db.close();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("exercises infrastructure health and notifications", async () => {
    const health = await (brain as any).checkInfrastructureHealth();
    expect(health.healthy).toBe(true);

    await (brain as any).notifyInfrastructureIssues([
      "Database error: connection lost",
      "API Server unreachable",
    ]);

    expect(sentToHuman.length).toBeGreaterThan(0);
  });

  it("handles status reports across multiple branches", async () => {
    // Blocked with defer (other pending tasks exist)
    await (brain as any).handleStatusReport({
      id: "report-blocked-defer",
      taskId: "task-blocked-defer",
      armId: "arm-1",
      status: "blocked",
      summary: "Blocked on dependency",
      issues: [],
      blockers: ["Need access"],
      filesChanged: [],
      testsStatus: "not_run",
    });

    // Remove extra pending task so blocked standard triggers immediate notify
    db.run("UPDATE tasks SET status = 'completed' WHERE id = ?", ["task-other-pending"]);

    await (brain as any).handleStatusReport({
      id: "report-blocked-standard",
      taskId: "task-blocked-standard",
      armId: "arm-1",
      status: "blocked",
      summary: "Blocked again",
      issues: [],
      blockers: ["Waiting for clarification"],
      filesChanged: [],
      testsStatus: "not_run",
    });

    // Issues found
    await (brain as any).handleStatusReport({
      id: "report-issues",
      taskId: "task-issues",
      armId: "arm-1",
      status: "issues_found",
      summary: "Found issues",
      issues: ["Lint errors"],
      blockers: [],
      nextSteps: "Fix lint",
      filesChanged: ["src/a.ts"],
      testsStatus: "failing",
    });

    // Needs review
    await (brain as any).handleStatusReport({
      id: "report-review",
      taskId: "task-review",
      armId: "arm-1",
      status: "needs_review",
      summary: "Please review",
      issues: [],
      blockers: [],
      filesChanged: ["src/b.ts"],
      testsStatus: "passing",
    });

    // Completed with issues - set arm busy so no idle arms are found
    db.run("UPDATE arms SET status = 'busy' WHERE id = ?", ["arm-1"]);
    await (brain as any).handleStatusReport({
      id: "report-completed-issues",
      taskId: "task-completed-issues",
      armId: "arm-1",
      status: "completed_with_issues",
      summary: "Completed with issues",
      issues: ["Edge case not covered"],
      blockers: [],
      nextSteps: "Add tests",
      filesChanged: ["src/c.ts"],
      testsStatus: "not_run",
    });

    expect(sentToHuman.length).toBeGreaterThan(0);
  });

  it("handles bugs, discoveries, doc updates, file changes, and approvals", async () => {
    await (brain as any).handleBugReport("arm-1", {
      id: "bug-1",
      title: "Minor issue",
      description: "Something is off",
      source: "arm_reported",
    });

    await (brain as any).handleBugReport("arm-1", {
      id: "bug-2",
      title: "Crash on start",
      description: "App crash",
      source: "arm_reported",
    });

    await (brain as any).handleBugReport("arm-1", {
      id: "bug-3",
      title: "Task failure",
      description: "Task failed",
      source: "arm_reported",
      sourceTaskId: "task-issues",
    });

    await (brain as any).handleDiscovery("arm-1", {
      kind: "security_issue",
      title: "Potential secret",
      details: "API key committed",
      severity: "warning",
    });

    await (brain as any).handleDocUpdate("arm-1", {
      path: "docs/requirements.md",
      reason: "Update requirement",
      newContent: "Updated",
    });

    await (brain as any).handleFileChange("arm-1", {
      filePath: "docs/requirements.md",
      changeType: "modified",
      summary: "Updated requirements",
      impact: "high",
      detectedAt: new Date().toISOString(),
    });

    await (brain as any).sendApprovalRequest("arm-1", {
      action: "delete file",
      context: "Removing unused file",
      options: ["approve", "reject"],
    });

    expect(sentToHuman.length).toBeGreaterThan(0);
  });

  it("covers helper methods", async () => {
    const patterns = (brain as any).getDomainPatterns("frontend");
    expect(patterns.length).toBeGreaterThan(0);

    expect((brain as any).isProductiveAction("heartbeat")).toBe(true);
    expect((brain as any).isProductiveAction("unknown_action")).toBe(false);

    const pattern = (brain as any).analyzePromptResponsePattern("arm-1", [
      { timestamp: new Date().toISOString(), action: "prompt_received", details: "{}" },
    ]);
    expect(pattern.hasPrompt).toBe(true);
  });

  it("covers task creation and stuck handling flows", async () => {
    const created = await (brain as any).createTask("New task", "Do the thing");
    expect(created.subject).toBe("New task");

    const docTask = await (brain as any).createDocUpdateTask(
      "Update docs",
      "Please update the docs",
      "requirements.md"
    );
    expect(docTask.subject).toContain("Docs:");

    await (brain as any).createHumanBugReport("Bug title", "Bug description");

    const originalTask = (brain as any).tasks.find((t: Task) => t.id === "task-review") as Task;
    const verification = await (brain as any).createVerificationTask(
      originalTask,
      {
        id: "report-verification",
        summary: "Found issues",
        issues: ["Missing test"],
        nextSteps: "Add tests",
        testsStatus: "failing",
      },
      true
    );
    expect(verification.subject).toContain("Verify & Polish");

    const arm = (brain as any).arms.get("arm-1") as Arm;

    await (brain as any).handleStuckArm(arm, {
      isStuck: true,
      stuckType: "asking_question",
      reasoning: "Needs input",
      suggestedAction: "answer",
      suggestedResponse: "Here is the answer",
      confidence: 0.9,
    });

    await (brain as any).handleStuckArm(arm, {
      isStuck: true,
      stuckType: "waiting_approval",
      reasoning: "Needs approval",
      suggestedAction: "approve",
      suggestedResponse: "Yes, proceed.",
      confidence: 0.9,
    });

    await (brain as any).handleStuckArm(arm, {
      isStuck: true,
      stuckType: "looping",
      reasoning: "Loop detected",
      suggestedAction: "compact",
      confidence: 0.8,
    });

    await (brain as any).handleStuckArm(arm, {
      isStuck: true,
      stuckType: "idle_too_long",
      reasoning: "Idle",
      suggestedAction: "prompt",
      confidence: 0.6,
    });

    expect(sentToHuman.length).toBeGreaterThan(0);
  });

  it("completes tasks even when they are missing from in-memory cache", async () => {
    const now = nowIso();
    db.run(
      "INSERT INTO tasks (id, subject, description, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["task-db-only", "DB only task", "not cached in memory", "pending", "normal", now, now]
    );

    await (brain as any).completeTask("task-db-only", "Done", []);

    const row = db
      .query("SELECT status, completed_at FROM tasks WHERE id = ?")
      .get("task-db-only") as { status: string; completed_at: string | null };
    expect(row.status).toBe("completed");
    expect(row.completed_at).toBeTruthy();
  });

  it("creates verification tasks for db-only tasks that have issue reports", async () => {
    const now = nowIso();
    db.run(
      "INSERT INTO tasks (id, subject, description, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["task-db-issues", "DB only issues task", "not cached in memory", "pending", "high", now, now]
    );
    db.run(
      `INSERT INTO status_reports (
        id, task_id, arm_id, status, summary, issues, blockers, next_steps, files_changed, tests_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "sr-db-only-issues",
        "task-db-issues",
        "arm-1",
        "completed_with_issues",
        "Completed but found problems",
        JSON.stringify(["Missing edge case"]),
        JSON.stringify([]),
        "Add missing test coverage",
        JSON.stringify(["src/example.ts"]),
        "failing",
        now,
      ]
    );

    await (brain as any).completeTask("task-db-issues", "Done with issues", []);

    const original = db
      .query("SELECT status, completed_at FROM tasks WHERE id = ?")
      .get("task-db-issues") as { status: string; completed_at: string | null };
    expect(original.status).toBe("completed");
    expect(original.completed_at).toBeTruthy();

    const verification = db
      .query("SELECT id, subject, status FROM tasks WHERE subject LIKE 'Verify & Polish: DB only issues task' ORDER BY created_at DESC LIMIT 1")
      .get() as { id: string; subject: string; status: string } | undefined;
    expect(verification).toBeDefined();
    expect(verification?.status).toBe("pending");
  });

  it("re-evaluation only unblocks tasks marked dependency_blocked", async () => {
    const now = nowIso();
    db.run(
      `INSERT INTO tasks (
        id, subject, description, status, priority, dependency_blocked, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "task-blocked-non-dependency",
        "Blocked without dependency",
        "should remain blocked",
        "blocked",
        "normal",
        0,
        now,
        now,
      ],
    );
    db.run(
      `INSERT INTO tasks (
        id, subject, description, status, priority, dependency_blocked, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "task-blocked-dependency",
        "Blocked with dependency flag",
        "should be unblocked",
        "blocked",
        "normal",
        1,
        now,
        now,
      ],
    );

    await (brain as any).reEvaluatePlanProgress();

    const nonDependency = db
      .query(
        "SELECT status, dependency_blocked FROM tasks WHERE id = ?",
      )
      .get("task-blocked-non-dependency") as {
      status: string;
      dependency_blocked: number;
    };
    expect(nonDependency.status).toBe("blocked");
    expect(nonDependency.dependency_blocked).toBe(0);

    const dependencyBlocked = db
      .query(
        "SELECT status, dependency_blocked FROM tasks WHERE id = ?",
      )
      .get("task-blocked-dependency") as {
      status: string;
      dependency_blocked: number;
    };
    expect(dependencyBlocked.status).toBe("pending");
    expect(dependencyBlocked.dependency_blocked).toBe(0);
  });
});
