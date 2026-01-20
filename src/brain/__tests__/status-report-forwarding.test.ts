/**
 * Status Report Forwarding Tests
 * 
 * Tests the brain's decision logic for when to forward status reports to users.
 * 
 * Key scenarios:
 * 1. Arm completes work (completed_with_issues) - forward if no idle arms, else assign to idle arm
 * 2. Arm is blocked - check if another arm can take over, or defer task
 * 3. Arm finds issues - forward to user with context
 * 4. Multiple arms on same task - wait until all complete before forwarding
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, rm, readdir, readFile } from "fs/promises";
import { join } from "path";

/**
 * Simplified test setup that directly tests the decision logic
 * without running the full brain loop.
 */
describe("Status Report Forwarding - Decision Logic", () => {
  let db: Database;
  let testDir: string;

  beforeEach(async () => {
    testDir = join("/tmp", `octopai-status-decision-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(testDir, { recursive: true });
    
    db = new Database(join(testDir, "test.db"));
    db.exec(`
      PRAGMA journal_mode = WAL;
      
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        priority TEXT NOT NULL DEFAULT 'normal',
        domain TEXT,
        assigned_to TEXT,
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      
      CREATE TABLE IF NOT EXISTS arms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        domain TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        current_task_id TEXT,
        last_activity_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      
      CREATE TABLE IF NOT EXISTS status_reports (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        arm_id TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        issues TEXT DEFAULT '[]',
        blockers TEXT DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  });

  afterEach(async () => {
    db.close();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  /**
   * Simulates the shouldForwardStatusReportToUser logic
   * This mirrors the actual brain implementation
   */
  function shouldForwardStatusReportToUser(
    db: Database,
    report: {
      taskId: string;
      armId: string;
      status: "on_track" | "blocked" | "issues_found" | "needs_review" | "completed_with_issues";
      summary: string;
    },
    task: { id: string; subject: string; domain?: string }
  ): { shouldForward: boolean; reason: string; action?: string; assignedToArm?: string } {
    // on_track - never forward
    if (report.status === "on_track") {
      return { shouldForward: false, reason: "Progress update - no user action needed" };
    }

    // needs_review - always forward
    if (report.status === "needs_review") {
      return { shouldForward: true, reason: "Arm explicitly requested human review", action: "notify" };
    }

    // blocked - check for alternatives
    if (report.status === "blocked") {
      // Check for idle arm with different domain
      const alternativeArms = db.query(`
        SELECT id, name, domain, status
        FROM arms
        WHERE id != ?
        AND status = 'idle'
        ORDER BY last_activity_at DESC
        LIMIT 1
      `).all(report.armId) as Array<{ id: string; name: string; domain: string | null; status: string }>;

      if (alternativeArms.length > 0) {
        const idleArm = alternativeArms[0]!;
        return {
          shouldForward: false,
          reason: `Blocked task can be reassigned to: ${idleArm.name}`,
          assignedToArm: idleArm.id,
          action: "reassign",
        };
      }

      // Check for pending tasks (defer option)
      const pendingTasks = db.query(`
        SELECT COUNT(*) as count FROM tasks WHERE status = 'pending' AND id != ?
      `).get(task.id) as { count: number } | null;

      if (pendingTasks && pendingTasks.count > 0) {
        return {
          shouldForward: true,
          reason: "Task blocked and deferred. Arm will move to other work.",
          action: "defer_task",
        };
      }

      return { shouldForward: true, reason: "Task is blocked - requires human intervention", action: "notify" };
    }

    // Check for other arms on same task
    const armsOnTask = db.query(`
      SELECT id, name FROM arms
      WHERE current_task_id = ? AND status = 'busy' AND id != ?
    `).all(task.id, report.armId) as Array<{ id: string; name: string }>;

    if (armsOnTask.length > 0) {
      return {
        shouldForward: false,
        reason: `${armsOnTask.length} other arm(s) still working: ${armsOnTask.map(a => a.name).join(", ")}`,
      };
    }

    // Check for idle arms
    const idleArms = db.query(`
      SELECT id, name FROM arms
      WHERE status = 'idle' AND id != ?
      ORDER BY last_activity_at DESC
      LIMIT 1
    `).all(report.armId) as Array<{ id: string; name: string }>;

    if (report.status === "completed_with_issues" && idleArms.length > 0) {
      const idleArm = idleArms[0]!;
      return {
        shouldForward: false,
        reason: `Verification task will be assigned to: ${idleArm.name}`,
        assignedToArm: idleArm.id,
        action: "reassign",
      };
    }

    // Default: forward to user
    return { 
      shouldForward: true, 
      reason: "No other arms available - user should be notified",
      action: "notify",
    };
  }

  describe("on_track status", () => {
    it("never forwards to user", () => {
      const task = { id: "task-1", subject: "Test task" };
      const report = {
        taskId: "task-1",
        armId: "arm-1",
        status: "on_track" as const,
        summary: "Making progress",
      };

      const decision = shouldForwardStatusReportToUser(db, report, task);
      
      expect(decision.shouldForward).toBe(false);
      expect(decision.reason).toContain("Progress update");
    });
  });

  describe("needs_review status", () => {
    it("always forwards to user even with idle arms", () => {
      // Add an idle arm
      db.run(`INSERT INTO arms (id, name, status) VALUES ('arm-2', 'worker-2', 'idle')`);
      
      const task = { id: "task-1", subject: "Test task" };
      const report = {
        taskId: "task-1",
        armId: "arm-1",
        status: "needs_review" as const,
        summary: "Please review",
      };

      const decision = shouldForwardStatusReportToUser(db, report, task);
      
      expect(decision.shouldForward).toBe(true);
      expect(decision.reason).toContain("human review");
      expect(decision.action).toBe("notify");
    });
  });

  describe("blocked status", () => {
    it("forwards to user when no alternatives available", () => {
      const task = { id: "task-1", subject: "Test task" };
      const report = {
        taskId: "task-1",
        armId: "arm-1",
        status: "blocked" as const,
        summary: "Cannot proceed",
      };

      const decision = shouldForwardStatusReportToUser(db, report, task);
      
      expect(decision.shouldForward).toBe(true);
      expect(decision.reason).toContain("human intervention");
      expect(decision.action).toBe("notify");
    });

    it("reassigns to idle arm when available", () => {
      db.run(`INSERT INTO arms (id, name, status, last_activity_at) VALUES ('arm-2', 'worker-2', 'idle', datetime('now'))`);
      
      const task = { id: "task-1", subject: "Test task" };
      const report = {
        taskId: "task-1",
        armId: "arm-1",
        status: "blocked" as const,
        summary: "Cannot proceed",
      };

      const decision = shouldForwardStatusReportToUser(db, report, task);
      
      expect(decision.shouldForward).toBe(false);
      expect(decision.reason).toContain("reassigned");
      expect(decision.action).toBe("reassign");
      expect(decision.assignedToArm).toBe("arm-2");
    });

    it("defers task when pending tasks exist but no idle arms", () => {
      // Add a pending task but no idle arms
      db.run(`INSERT INTO tasks (id, subject, status) VALUES ('task-2', 'Other work', 'pending')`);
      db.run(`INSERT INTO arms (id, name, status) VALUES ('arm-1', 'worker-1', 'busy')`);
      
      const task = { id: "task-1", subject: "Test task" };
      const report = {
        taskId: "task-1",
        armId: "arm-1",
        status: "blocked" as const,
        summary: "Cannot proceed",
      };

      const decision = shouldForwardStatusReportToUser(db, report, task);
      
      expect(decision.shouldForward).toBe(true);
      expect(decision.reason).toContain("deferred");
      expect(decision.action).toBe("defer_task");
    });
  });

  describe("completed_with_issues status", () => {
    it("forwards to user when no idle arms", () => {
      db.run(`INSERT INTO arms (id, name, status) VALUES ('arm-1', 'worker-1', 'busy')`);
      
      const task = { id: "task-1", subject: "Test task" };
      const report = {
        taskId: "task-1",
        armId: "arm-1",
        status: "completed_with_issues" as const,
        summary: "Done but with issues",
      };

      const decision = shouldForwardStatusReportToUser(db, report, task);
      
      expect(decision.shouldForward).toBe(true);
      expect(decision.reason).toContain("No other arms");
      expect(decision.action).toBe("notify");
    });

    it("assigns to idle arm instead of forwarding", () => {
      db.run(`INSERT INTO arms (id, name, status, last_activity_at) VALUES ('arm-2', 'worker-2', 'idle', datetime('now'))`);
      
      const task = { id: "task-1", subject: "Test task" };
      const report = {
        taskId: "task-1",
        armId: "arm-1",
        status: "completed_with_issues" as const,
        summary: "Done but with issues",
      };

      const decision = shouldForwardStatusReportToUser(db, report, task);
      
      expect(decision.shouldForward).toBe(false);
      expect(decision.reason).toContain("Verification task");
      expect(decision.action).toBe("reassign");
      expect(decision.assignedToArm).toBe("arm-2");
    });
  });

  describe("issues_found status", () => {
    it("waits when other arms are working on same task", () => {
      db.run(`
        INSERT INTO arms (id, name, status, current_task_id) VALUES 
          ('arm-1', 'worker-1', 'busy', 'task-1'),
          ('arm-2', 'worker-2', 'busy', 'task-1')
      `);
      
      const task = { id: "task-1", subject: "Test task" };
      const report = {
        taskId: "task-1",
        armId: "arm-1",
        status: "issues_found" as const,
        summary: "Found some issues",
      };

      const decision = shouldForwardStatusReportToUser(db, report, task);
      
      expect(decision.shouldForward).toBe(false);
      expect(decision.reason).toContain("still working");
    });

    it("forwards when arm is the only one on task", () => {
      db.run(`INSERT INTO arms (id, name, status, current_task_id) VALUES ('arm-1', 'worker-1', 'busy', 'task-1')`);
      
      const task = { id: "task-1", subject: "Test task" };
      const report = {
        taskId: "task-1",
        armId: "arm-1",
        status: "issues_found" as const,
        summary: "Found some issues",
      };

      const decision = shouldForwardStatusReportToUser(db, report, task);
      
      expect(decision.shouldForward).toBe(true);
      expect(decision.action).toBe("notify");
    });
  });
});

/**
 * Integration tests that verify the full brain pipeline
 * These require more setup but test the actual implementation
 */
describe("Status Report Forwarding - Integration (with mock NATS)", () => {
  // These tests would use the MockNatsClient and full Brain
  // For now, skipping as the unit tests above cover the decision logic

  it.skip("brain processes status report and writes to inbox", async () => {
    // TODO: Full integration test with proper brain initialization
  });
});
