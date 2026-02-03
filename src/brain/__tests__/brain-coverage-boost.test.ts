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
});
