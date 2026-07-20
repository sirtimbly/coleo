import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { join } from "path";

import { initDatabase, type Database } from "../../db";
import type { Arm, Task } from "../../types";
import { Brain } from "../brain";

function nowIso(): string {
  return new Date().toISOString();
}

interface TaskRow {
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
  blocked_at: string | null;
  blocked_reason: string | null;
  blocked_category: string | null;
  blocked_recheck_at: string | null;
  blocked_last_checked_at: string | null;
  blocked_review_count: number | null;
  blocked_needs_human: number | null;
  blocked_human_notified_at: string | null;
  blocked_review_arm_id: string | null;
  blocked_review_started_at: string | null;
  artifacts: string | null;
  mail_thread_id: string | null;
  context: string | null;
}

function mapTaskRow(row: TaskRow): Task {
  return {
    id: row.id,
    subject: row.subject,
    description: row.description,
    status: row.status as Task["status"],
    priority: row.priority as Task["priority"],
    domain: row.domain || undefined,
    classification: row.classification || undefined,
    assignedTo: row.assigned_to || undefined,
    dependencyBlocked: row.dependency_blocked === 1,
    sortOrder: row.sort_order ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    blockedAt: row.blocked_at ? new Date(row.blocked_at) : undefined,
    blockedReason: row.blocked_reason || undefined,
    blockedCategory: (row.blocked_category as Task["blockedCategory"]) || undefined,
    blockedRecheckAt: row.blocked_recheck_at ? new Date(row.blocked_recheck_at) : undefined,
    blockedLastCheckedAt: row.blocked_last_checked_at ? new Date(row.blocked_last_checked_at) : undefined,
    blockedReviewCount: row.blocked_review_count ?? 0,
    blockedNeedsHuman: row.blocked_needs_human === 1,
    blockedHumanNotifiedAt: row.blocked_human_notified_at ? new Date(row.blocked_human_notified_at) : undefined,
    blockedReviewArmId: row.blocked_review_arm_id || undefined,
    blockedReviewStartedAt: row.blocked_review_started_at ? new Date(row.blocked_review_started_at) : undefined,
    artifacts: row.artifacts ? JSON.parse(row.artifacts) : [],
    mailThreadId: row.mail_thread_id || undefined,
    context: row.context ? JSON.parse(row.context) : {},
  };
}

describe("Brain runtime flows", () => {
  let testDir: string;
  let db: Database;
  let brain: Brain;
  let sentToHuman: Array<{ subject: string; body: string }>;

  beforeEach(async () => {
    testDir = join(
      "/tmp",
      `coleo-brain-runtime-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );

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
    await (brain as any).templates.ensureTemplatesExist();

    sentToHuman = [];
    (brain as any).sendToHuman = async (message: { subject: string; body: string }) => {
      sentToHuman.push(message);
    };
    (brain as any).sendPromptToArm = async () => true;
    (brain as any).isApiServerAvailable = async () => true;
    (brain as any).inbox.list = async () => [];

    (brain as any).apiRequest = async <T>(path: string, options: RequestInit = {}) => {
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
        return { result: { success: true } } as T;
      }

      if (path.startsWith("/api/tasks?")) {
        const statuses =
          new URLSearchParams(path.split("?")[1] || "")
            .get("status")
            ?.split(",")
            .map((value) => value.trim())
            .filter(Boolean) || [];
        const rows = (statuses.length > 0
          ? db
              .query(
                `SELECT id, subject, description, status, priority, domain, classification,
                        assigned_to, dependency_blocked, sort_order,
                        created_at, updated_at, completed_at, blocked_at, blocked_reason,
                        blocked_category, blocked_recheck_at, blocked_last_checked_at,
                        blocked_review_count, blocked_needs_human, blocked_human_notified_at,
                        blocked_review_arm_id, blocked_review_started_at,
                        artifacts, mail_thread_id, context
                 FROM tasks
                 WHERE status IN (${statuses.map(() => "?").join(",")})
                 ORDER BY created_at DESC`,
              )
              .all(...statuses)
          : db
              .query(
                `SELECT id, subject, description, status, priority, domain, classification,
                        assigned_to, dependency_blocked, sort_order,
                        created_at, updated_at, completed_at, blocked_at, blocked_reason,
                        blocked_category, blocked_recheck_at, blocked_last_checked_at,
                        blocked_review_count, blocked_needs_human, blocked_human_notified_at,
                        blocked_review_arm_id, blocked_review_started_at,
                        artifacts, mail_thread_id, context
                 FROM tasks
                 ORDER BY created_at DESC`,
              )
              .all()) as TaskRow[];

        const counts = db
          .query("SELECT status, COUNT(*) AS count FROM tasks GROUP BY status")
          .all() as Array<{ status: string; count: number }>;

        return {
          tasks: rows.map(mapTaskRow),
          counts: { byStatus: Object.fromEntries(counts.map((row) => [row.status, row.count])) },
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
          mailThreadId?: string | null;
          context?: Record<string, unknown>;
        };
        const id = body.id || `task-${Date.now()}`;
        const now = nowIso();
        db.run(
          `INSERT INTO tasks (
             id, subject, description, status, priority, domain, classification, mail_thread_id, context, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

        const row = db
          .query(
            `SELECT id, subject, description, status, priority, domain, classification,
                    assigned_to, dependency_blocked, sort_order,
                    created_at, updated_at, completed_at, blocked_at, blocked_reason,
                    blocked_category, blocked_recheck_at, blocked_last_checked_at,
                    blocked_review_count, blocked_needs_human, blocked_human_notified_at,
                    blocked_review_arm_id, blocked_review_started_at,
                    artifacts, mail_thread_id, context
             FROM tasks WHERE id = ?`,
          )
          .get(id) as TaskRow;
        return { task: mapTaskRow(row) } as T;
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
            blockedReason?: string;
            blockedCategory?: string;
            blockedRecheckAt?: string | null;
            blockedLastCheckedAt?: string | null;
            blockedReviewCount?: number;
            blockedNeedsHuman?: boolean;
            blockedHumanNotifiedAt?: string | null;
            blockedReviewArmId?: string | null;
            blockedReviewStartedAt?: string | null;
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
            if (body.status !== "blocked") {
              updates.push(
                "blocked_at = NULL",
                "blocked_reason = NULL",
                "blocked_category = NULL",
                "blocked_recheck_at = NULL",
                "blocked_review_arm_id = NULL",
                "blocked_review_started_at = NULL",
              );
            } else {
              updates.push("blocked_at = COALESCE(blocked_at, ?)");
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
          const blockedFields: Array<[keyof typeof body, string, (value: unknown) => unknown]> = [
            ["blockedReason", "blocked_reason", (value) => value],
            ["blockedCategory", "blocked_category", (value) => value],
            ["blockedRecheckAt", "blocked_recheck_at", (value) => value],
            ["blockedLastCheckedAt", "blocked_last_checked_at", (value) => value],
            ["blockedReviewCount", "blocked_review_count", (value) => value],
            ["blockedNeedsHuman", "blocked_needs_human", (value) => value ? 1 : 0],
            ["blockedHumanNotifiedAt", "blocked_human_notified_at", (value) => value],
            ["blockedReviewArmId", "blocked_review_arm_id", (value) => value],
            ["blockedReviewStartedAt", "blocked_review_started_at", (value) => value],
          ];
          for (const [field, column, transform] of blockedFields) {
            if (body[field] !== undefined) {
              updates.push(`${column} = ?`);
              values.push(transform(body[field]));
            }
          }
          updates.push("updated_at = ?");
          values.push(nowIso());
          values.push(taskId);
          db.run(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`, values as string[]);
        }

        const row = db
          .query(
            `SELECT id, subject, description, status, priority, domain, classification,
                    assigned_to, dependency_blocked, sort_order,
                    created_at, updated_at, completed_at, blocked_at, blocked_reason,
                    blocked_category, blocked_recheck_at, blocked_last_checked_at,
                    blocked_review_count, blocked_needs_human, blocked_human_notified_at,
                    blocked_review_arm_id, blocked_review_started_at,
                    artifacts, mail_thread_id, context
             FROM tasks WHERE id = ?`,
          )
          .get(taskId) as TaskRow | null;
        return row ? ({ task: mapTaskRow(row) } as T) : (null as T);
      }

      if (path === "/api/bugs" && options.method === "POST") {
        const body = JSON.parse(String(options.body || "{}")) as {
          id?: string;
          title: string;
          status?: string;
          priority?: string;
          blockers?: string[];
          resolution?: string | null;
        };
        const id = body.id || `bug-${Date.now()}`;
        db.run(
          `INSERT OR REPLACE INTO bugs (
             id, title, status, priority, blockers, resolution, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            body.title,
            body.status || "open",
            body.priority || "medium",
            JSON.stringify(body.blockers || []),
            body.resolution || null,
            nowIso(),
            nowIso(),
          ],
        );
        return { bug: { id } } as T;
      }

      if (path.startsWith("/api/bugs?")) {
        const rows = db
          .query("SELECT id, title, status, priority, blockers FROM bugs ORDER BY created_at DESC")
          .all() as Array<{
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

      if (path === "/api/discoveries" && options.method === "POST") {
        const body = JSON.parse(String(options.body || "{}")) as {
          id: string;
          armId: string;
          armName: string;
          kind: string;
          title: string;
          details: string;
          filePath?: string | null;
          lineNumber?: number | null;
          severity: string;
          status?: string;
          taskId?: string | null;
          phase?: string | null;
        };
        db.run(
          `INSERT INTO discoveries (
             id, arm_id, arm_name, kind, title, details, file_path, line_number, severity, status, task_id, phase, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            body.id,
            body.armId,
            body.armName,
            body.kind,
            body.title,
            body.details,
            body.filePath || null,
            body.lineNumber || null,
            body.severity,
            body.status || "open",
            body.taskId || null,
            body.phase || null,
            nowIso(),
            nowIso(),
          ],
        );
        return { discovery: { id: body.id } } as T;
      }

      if (path.startsWith("/api/discoveries?")) {
        const rows = db
          .query(
            `SELECT id, arm_id, arm_name, kind, title, details, file_path, line_number, severity, status, task_id, phase, created_at, updated_at
             FROM discoveries
             ORDER BY created_at DESC`,
          )
          .all() as Array<{
          id: string;
          arm_id: string;
          arm_name: string;
          kind: string;
          title: string;
          details: string;
          file_path: string | null;
          line_number: number | null;
          severity: string;
          status: string;
          task_id: string | null;
          phase: string | null;
          created_at: string;
          updated_at: string;
        }>;
        return {
          discoveries: rows.map((row) => ({
            id: row.id,
            armId: row.arm_id,
            armName: row.arm_name,
            kind: row.kind,
            title: row.title,
            details: row.details,
            filePath: row.file_path,
            lineNumber: row.line_number,
            severity: row.severity,
            status: row.status,
            taskId: row.task_id,
            phase: row.phase,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
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
          `INSERT INTO status_reports (
             id, task_id, arm_id, status, summary, issues, blockers, next_steps, files_changed, tests_status, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

      if (path.startsWith("/api/status-reports?")) {
        const params = new URLSearchParams(path.split("?")[1] || "");
        const taskId = params.get("taskId");
        const since = params.get("since");
        const rows = (taskId
          ? db
              .query(
                `SELECT id, task_id, arm_id, status, summary, issues, blockers, next_steps, files_changed, tests_status, created_at
                 FROM status_reports
                 WHERE task_id = ?
                 ORDER BY created_at DESC`,
              )
              .all(taskId)
          : db
              .query(
                `SELECT id, task_id, arm_id, status, summary, issues, blockers, next_steps, files_changed, tests_status, created_at
                 FROM status_reports
                 ORDER BY created_at DESC`,
              )
              .all()) as Array<{
          id: string;
          task_id: string;
          arm_id: string;
          status: string;
          summary: string;
          issues: string | null;
          blockers: string | null;
          next_steps: string | null;
          files_changed: string | null;
          tests_status: string | null;
          created_at: string;
        }>;
        return {
          reports: rows
            .filter((row) => (since ? row.created_at > since : true))
            .map((row) => ({
              id: row.id,
              taskId: row.task_id,
              armId: row.arm_id,
              status: row.status,
              summary: row.summary,
              issues: row.issues ? JSON.parse(row.issues) : [],
              blockers: row.blockers ? JSON.parse(row.blockers) : [],
              nextSteps: row.next_steps || undefined,
              filesChanged: row.files_changed ? JSON.parse(row.files_changed) : [],
              testsStatus: row.tests_status || undefined,
              createdAt: row.created_at,
            })),
        } as T;
      }

      if (path === "/api/brain/internal/assign-task" && options.method === "POST") {
        return { result: { success: true, data: { needsMoreArms: false } } } as T;
      }

      if (path.startsWith("/api/arms/") || path === "/api/arms") {
        if (path === "/api/arms" && options.method === "POST") {
          const body = JSON.parse(String(options.body || "{}")) as {
            name: string;
            domain?: string;
            harness?: string;
          };
          db.run(
            `INSERT OR IGNORE INTO arms (id, name, domain, harness, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              body.name,
              body.name,
              body.domain || "general",
              body.harness || "manual",
              "running",
              nowIso(),
              nowIso(),
            ],
          );
          return { arm: { id: body.name } } as T;
        }
        return { success: true } as T;
      }

      return null as T;
    };

    const now = nowIso();
    db.run(
      "INSERT INTO arms (id, name, domain, harness, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["arm-1", "ArmOne", "general", "opencode-api", "idle", now, now],
    );
    (brain as any).arms = new Map<string, Arm>([
      [
        "arm-1",
        {
          id: "arm-1",
          name: "ArmOne",
          agent: "opencode",
          status: "idle",
          startedAt: new Date(),
        },
      ],
    ]);

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
        [task.id, task.subject, task.description, task.status, task.priority, now, now],
      );
    }
  });

  afterEach(async () => {
    db.close();
    await rm(testDir, { recursive: true, force: true });
  });

  it("raises a human-facing infrastructure alert for critical service failures", async () => {
    await (brain as any).notifyInfrastructureIssues([
      "Database error: connection lost",
      "API Server unreachable",
    ]);

    expect(sentToHuman.map((message) => message.subject)).toEqual([
      "[coleo] Infrastructure health issues detected",
    ]);
  });

  it("applies blocked, issues, review, and verification follow-up status report flows", async () => {
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

    expect(
      (db.query("SELECT status FROM tasks WHERE id = ?").get("task-blocked-defer") as { status: string }).status,
    ).toBe("blocked");
    expect(
      (db.query("SELECT status FROM tasks WHERE id = ?").get("task-blocked-standard") as { status: string }).status,
    ).toBe("blocked");
    expect(
      db
        .query(
          "SELECT subject, status FROM tasks WHERE subject = 'Verify & Polish: Completed with issues' ORDER BY created_at DESC LIMIT 1",
        )
        .get(),
    ).toEqual({
      subject: "Verify & Polish: Completed with issues",
      status: "pending",
    });

    const subjects = sentToHuman.map((message) => message.subject);
    expect(subjects).toEqual(
      expect.arrayContaining([
        "[coleo] Task deferred: Blocked defer",
        "[coleo] Issues found: Issues found",
        "[coleo] Review needed: Needs review",
        "[coleo] Verification needed: Completed with issues",
      ]),
    );
    expect(
      subjects.some(
        (subject) =>
          subject === "[coleo] Task blocked: Blocked standard" ||
          subject === "[coleo] Task deferred: Blocked standard",
      ),
    ).toBe(true);
  });

  it("notifies humans about discoveries, doc updates, file changes, and approvals", async () => {
    await (brain as any).handleBugReport("arm-1", {
      id: "bug-1",
      title: "Crash on start",
      description: "App crash",
      source: "arm_reported",
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

    expect(sentToHuman.map((message) => message.subject)).toEqual(
      expect.arrayContaining([
        "[coleo] Discovery: Potential secret",
        "[coleo] Documentation updated: docs/requirements.md",
        "[coleo] File change detected: docs/requirements.md",
        expect.stringContaining("Approval needed: delete file"),
      ]),
    );
  });

  it("creates follow-up tasks used by human mail and status-report workflows", async () => {
    const created = await (brain as any).createTask("New task", "Do the thing");
    const docTask = await (brain as any).createDocUpdateTask(
      "Update docs",
      "Please update the docs",
      "requirements.md",
    );
    const originalTask = (brain as any).tasks.find((task: Task) => task.id === "task-review") as Task;
    const verification = await (brain as any).createVerificationTask(
      originalTask,
      {
        id: "report-verification",
        summary: "Found issues",
        issues: ["Missing test"],
        nextSteps: "Add tests",
        testsStatus: "failing",
      },
      true,
    );

    expect(created.subject).toBe("New task");
    expect(docTask.subject).toContain("Docs:");
    expect(verification.subject).toContain("Verify & Polish");
  });

  it("auto-recovers stuck arms when it can and escalates when it cannot", async () => {
    const prompts: string[] = [];
    (brain as any).sendPromptToArm = async (_armName: string, message: string) => {
      prompts.push(message);
      return true;
    };

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
      stuckType: "error",
      reasoning: "Needs manual intervention",
      suggestedAction: "escalate",
      confidence: 0.4,
    });

    expect(prompts).toEqual(
      expect.arrayContaining(["Here is the answer", "Yes, proceed.", "/compact"]),
    );
    expect(
      sentToHuman.some((message) => message.subject === "[coleo] Arm ArmOne needs help (error)"),
    ).toBe(true);
  });

  it("moves uncached tasks to validation and does not recurse commit follow-up tasks", async () => {
    const now = nowIso();
    db.run(
      "INSERT INTO tasks (id, subject, description, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["task-db-only", "DB only task", "not cached in memory", "pending", "normal", now, now],
    );
    db.run(
      "INSERT INTO tasks (id, subject, description, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "task-commit-followup",
        "Commit changes for: Original task",
        "capture worktree changes",
        "pending",
        "high",
        now,
        now,
      ],
    );

    await (brain as any).completeTask("task-db-only", "Done", []);
    await (brain as any).completeTask("task-commit-followup", "Committed changes", []);

    expect(
      (db.query("SELECT status FROM tasks WHERE id = ?").get("task-db-only") as { status: string }).status,
    ).toBe("completing");
    expect(
      (db.query("SELECT COUNT(*) AS count FROM tasks WHERE subject LIKE 'Commit changes for: Commit changes for:%'").get() as { count: number }).count,
    ).toBe(0);
  });

  it("defense-in-depth: createCommitTask refuses to create commit tasks for follow-up tasks", async () => {
    const now = nowIso();
    db.run(
      "INSERT INTO tasks (id, subject, description, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["task-original-defense", "Original task", "do the thing", "completed", "normal", now, now],
    );

    // Directly calling createCommitTask with a commit task subject should be a no-op
    await (brain as any).createCommitTask(
      "task-original-defense",
      "Commit changes for: Original task",
      "Committed",
    );

    expect(
      (db.query("SELECT COUNT(*) AS count FROM tasks WHERE subject LIKE 'Commit changes for: Commit changes for:%'").get() as { count: number }).count,
    ).toBe(0);
  });

  it("hands completed work off to the next task and creates verification follow-ups for issue reports", async () => {
    const now = nowIso();
    db.run(
      "INSERT INTO tasks (id, subject, description, status, priority, assigned_to, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["task-auto-handoff", "Auto handoff task", "assigned to arm", "in_progress", "normal", "arm-1", now, now],
    );
    db.run(
      "INSERT INTO tasks (id, subject, description, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["task-db-issues", "DB only issues task", "not cached in memory", "pending", "high", now, now],
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
      ],
    );

    const prompts: string[] = [];
    let resetCount = 0;
    (brain as any).sendPromptToArm = async (_armId: string, message: string) => {
      prompts.push(message);
      return true;
    };
    (brain as any).resetArmSession = async () => {
      resetCount += 1;
      return true;
    };

    await (brain as any).completeTask("task-auto-handoff", "Done", []);
    await (brain as any).completeTask("task-db-issues", "Done with issues", []);

    expect(
      (db.query("SELECT status, assigned_to FROM tasks WHERE id = ?").get("task-auto-handoff") as { status: string; assigned_to: string | null }).status,
    ).toBe("completing");
    expect(
      db
        .query(
          "SELECT status FROM tasks WHERE subject = 'Verify & Polish: DB only issues task' ORDER BY created_at DESC LIMIT 1",
        )
        .get(),
    ).toEqual({ status: "pending" });
    expect(resetCount).toBe(1);
    expect(prompts.some((prompt) => prompt.includes("get_full_briefing"))).toBe(true);
  });

  it("re-evaluates blocked tasks conservatively and processes persisted status reports", async () => {
    const now = nowIso();
    db.run(
      `INSERT INTO tasks (
         id, subject, description, status, priority, dependency_blocked,
         blocked_reason, blocked_category, blocked_recheck_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "task-blocked-non-dependency",
        "Blocked without dependency",
        "should remain blocked",
        "blocked",
        "normal",
        0,
        "Blocked without a dependency reason",
        "unknown",
        now,
        now,
        now,
      ],
    );
    db.run(
      `INSERT INTO tasks (
         id, subject, description, status, priority, dependency_blocked,
         blocked_reason, blocked_category, blocked_recheck_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "task-blocked-dependency",
        "Blocked with dependency flag",
        "should be unblocked",
        "blocked",
        "normal",
        1,
        "Waiting for dependency",
        "dependency",
        now,
        now,
        now,
      ],
    );
    db.run(
      `INSERT INTO status_reports (
         id, task_id, arm_id, status, summary, issues, blockers, next_steps, files_changed, tests_status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "report-persisted-blocked",
        "task-blocked-standard",
        "arm-1",
        "blocked",
        "Waiting on clarification",
        JSON.stringify([]),
        JSON.stringify(["Need product decision"]),
        "Pause implementation until clarified",
        JSON.stringify([]),
        "not_run",
        now,
      ],
    );

    await (brain as any).reEvaluatePlanProgress();
    await (brain as any).processOperationalSignals(new Date(Date.now() - 60_000).toISOString());

    expect(
      (db.query("SELECT status FROM tasks WHERE id = ?").get("task-blocked-non-dependency") as { status: string }).status,
    ).toBe("blocked");
    expect(
      (db.query("SELECT status FROM tasks WHERE id = ?").get("task-blocked-dependency") as { status: string }).status,
    ).toBe("pending");
    expect(
      sentToHuman.some(
        (message) =>
          message.subject.includes("Blocked standard") &&
          (message.subject.includes("Task blocked") || message.subject.includes("Task deferred")),
      ),
    ).toBe(true);
  });

  it("finalizes completing work exactly once after human approval", async () => {
    const task = {
      id: "task-human-review",
      subject: "Human review task",
      description: "Awaiting approval",
      status: "completing",
      priority: "normal",
      createdAt: new Date(),
      updatedAt: new Date(),
      artifacts: ["abc123"],
      metadata: { humanReview: { status: "pending" } },
    } satisfies Task;
    const finalized: Array<{ taskId: string; summary: string; artifacts: string[] }> = [];

    (brain as any).getTaskFromApi = async () => task;
    (brain as any).patchTaskViaApi = async () => task;
    (brain as any).appendTaskComment = async () => undefined;
    (brain as any).finalizeTaskCompletion = async (
      taskId: string,
      summary: string,
      artifacts: string[],
    ) => finalized.push({ taskId, summary, artifacts });

    await (brain as any).handleApprovalResponse(task.id, true, "Looks good.");

    expect(finalized).toEqual([{
      taskId: task.id,
      summary: "Looks good.",
      artifacts: ["abc123"],
    }]);
  });

  it("returns human-rejected work to the claimable queue", async () => {
    const task = {
      id: "task-human-rejected",
      subject: "Rejected task",
      description: "Needs another pass",
      status: "completing",
      priority: "normal",
      createdAt: new Date(),
      updatedAt: new Date(),
      artifacts: [],
      metadata: { humanReview: { status: "pending" } },
    } satisfies Task;
    const patches: Array<Record<string, unknown>> = [];
    let finalized = false;

    (brain as any).getTaskFromApi = async () => task;
    (brain as any).patchTaskViaApi = async (_taskId: string, patch: Record<string, unknown>) => {
      patches.push(patch);
      return task;
    };
    (brain as any).appendTaskComment = async () => undefined;
    (brain as any).finalizeTaskCompletion = async () => {
      finalized = true;
    };

    await (brain as any).handleApprovalResponse(task.id, false, "Please revise it.");

    expect(patches[0]).toMatchObject({ status: "pending", assignedTo: null });
    expect(finalized).toBe(false);
  });
});
