import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { Brain } from "../brain";
import { initDatabase, type Database } from "../../db";
import type { QueueMessage } from "../../types";

function nowIso() {
  return new Date().toISOString();
}

describe("Task Deletion Handler", () => {
  let testDir: string;
  let db: Database;
  let brain: Brain;
  let logActivityCalls: Array<{
    actor: string;
    action: string;
    target?: string;
    details?: Record<string, unknown>;
  }>;
  let publishEventCalls: Array<{
    subject: string;
    type: string;
    data?: Record<string, unknown>;
  }>;

  beforeEach(async () => {
    testDir = join("/tmp", `coleo-task-deletion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

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

    // Ensure templates are available
    await (brain as any).templates.ensureTemplatesExist();

    // Mock logging and event publishing
    logActivityCalls = [];
    publishEventCalls = [];
    
    (brain as any).logActivity = (
      actor: string,
      action: string,
      target?: string,
      details?: Record<string, unknown>,
    ) => {
      logActivityCalls.push({ actor, action, target, details });
    };
    
    (brain as any).publishEventViaApi = async (event: {
      subject: string;
      type: string;
      data?: Record<string, unknown>;
    }) => {
      publishEventCalls.push(event);
    };

    (brain as any).isApiServerAvailable = async () => true;
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
      return undefined as T;
    };
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("handleTaskDeletion", () => {
    it("should process task deletion and log activity", async () => {
      const payload = {
        taskId: "task-123",
        projectId: "/path/to/plan.md:42",
        featureId: "abcd1234",
        deletedBy: "user",
        timestamp: nowIso(),
      };

      // Access private method for testing
      const handleTaskDeletion = (brain as any).handleTaskDeletion.bind(brain);
      await handleTaskDeletion(payload);

      // Should log deletion activity
      const deletionLog = logActivityCalls.find(
        (call) => call.action === "task_deleted"
      );
      expect(deletionLog).toBeDefined();
      expect(deletionLog?.target).toBe("task-123");
      expect(deletionLog?.details).toMatchObject({
        projectId: "/path/to/plan.md:42",
        featureId: "abcd1234",
        deletedBy: "user",
      });

      // Should publish deletion event
      const deletionEvent = publishEventCalls.find(
        (call) => call.type === "task.deleted"
      );
      expect(deletionEvent).toBeDefined();
      expect(deletionEvent?.subject).toBe("coleo.events.task.task-123.deleted");
      expect(deletionEvent?.data).toMatchObject({
        taskId: "task-123",
        projectId: "/path/to/plan.md:42",
        featureId: "abcd1234",
        deletedBy: "user",
      });
    });

    it("should handle deletion with default projectId", async () => {
      const payload = {
        taskId: "task-456",
        projectId: "default",
        featureId: "efgh5678",
        deletedBy: "system",
        timestamp: nowIso(),
      };

      const handleTaskDeletion = (brain as any).handleTaskDeletion.bind(brain);
      await handleTaskDeletion(payload);

      // Should still log and publish event
      const deletionLog = logActivityCalls.find(
        (call) => call.action === "task_deleted"
      );
      expect(deletionLog).toBeDefined();
      expect(deletionLog?.details?.planCleanupNeeded).toBe(false);
    });

    it("should handle errors gracefully", async () => {
      const payload = {
        taskId: "task-789",
        projectId: "/path/to/plan.md:100",
        featureId: "ijkl9012",
        deletedBy: "user",
        timestamp: nowIso(),
      };

      // Mock publishEventViaApi to throw
      let publishCallCount = 0;
      (brain as any).publishEventViaApi = async () => {
        publishCallCount++;
        throw new Error("Network error");
      };

      const handleTaskDeletion = (brain as any).handleTaskDeletion.bind(brain);
      
      // Should not throw even if event publishing fails
      await handleTaskDeletion(payload);

      // Verify the publish was attempted
      expect(publishCallCount).toBe(1);

      // Should log the failure
      const failureLog = logActivityCalls.find(
        (call) => call.action === "task_deletion_failed"
      );
      expect(failureLog).toBeDefined();
      expect(failureLog?.target).toBe("task-789");
    });
  });

  describe("verifyAndCleanupPlanFeature", () => {
    it("should remove feature from plan file if present", async () => {
      const planDir = join(testDir, ".project");
      await mkdir(planDir, { recursive: true });
      const planPath = join(planDir, "plan.md");

      // Create a plan file with a feature
      const planContent = `## Phase 1: Test

### Deliverables

- [ ] Task with feature <!--octopai:feature123-->
- [ ] Another task <!--octopai:feature456-->
`;
      await writeFile(planPath, planContent, "utf-8");

      // Access private method for testing
      const verifyAndCleanup = (brain as any).verifyAndCleanupPlanFeature.bind(brain);
      const result = await verifyAndCleanup(planPath, "feature123");

      expect(result).toBe(true);

      // Verify the line was removed
      const updatedContent = await readFile(planPath, "utf-8");
      expect(updatedContent).not.toContain("feature123");
      expect(updatedContent).toContain("feature456"); // Other feature should remain
    });

    it("should return false if feature not found (idempotent)", async () => {
      const planDir = join(testDir, ".project");
      await mkdir(planDir, { recursive: true });
      const planPath = join(planDir, "plan.md");

      const planContent = `## Phase 1: Test

### Deliverables

- [ ] Task with feature <!--octopai:feature123-->
`;
      await writeFile(planPath, planContent, "utf-8");

      const verifyAndCleanup = (brain as any).verifyAndCleanupPlanFeature.bind(brain);
      
      // Try to remove non-existent feature
      const result = await verifyAndCleanup(planPath, "nonexistent");

      expect(result).toBe(false);

      // Content should be unchanged
      const updatedContent = await readFile(planPath, "utf-8");
      expect(updatedContent).toBe(planContent);
    });

    it("should handle source_ref format with line numbers", async () => {
      const planDir = join(testDir, ".project");
      await mkdir(planDir, { recursive: true });
      const planPath = join(planDir, "plan.md");

      const planContent = `## Phase 1: Test

### Deliverables

- [ ] Task with feature <!--octopai:feature789-->
`;
      await writeFile(planPath, planContent, "utf-8");

      const verifyAndCleanup = (brain as any).verifyAndCleanupPlanFeature.bind(brain);
      
      // Pass projectId in source_ref format (path:lineNumber)
      const result = await verifyAndCleanup(`${planPath}:42`, "feature789");

      expect(result).toBe(true);

      // Verify the line was removed
      const updatedContent = await readFile(planPath, "utf-8");
      expect(updatedContent).not.toContain("feature789");
    });

    it("should handle missing plan file gracefully", async () => {
      const verifyAndCleanup = (brain as any).verifyAndCleanupPlanFeature.bind(brain);
      
      // Try to cleanup from non-existent file
      const result = await verifyAndCleanup("/nonexistent/plan.md", "feature123");

      expect(result).toBe(false);
    });

    it("should return false for default projectId", async () => {
      const verifyAndCleanup = (brain as any).verifyAndCleanupPlanFeature.bind(brain);
      
      const result = await verifyAndCleanup("default", "feature123");

      expect(result).toBe(false);
    });
  });

  describe("handleArmMessage integration", () => {
    it("should route task_deleted messages to handler", async () => {
      const planDir = join(testDir, ".project");
      await mkdir(planDir, { recursive: true });
      const planPath = join(planDir, "plan.md");

      const planContent = `## Phase 1: Test

### Deliverables

- [ ] Task to delete <!--octopai:delete123-->
`;
      await writeFile(planPath, planContent, "utf-8");

      const message: QueueMessage = {
        id: "msg-123",
        from: "api",
        to: "brain",
        type: "task_deleted",
        timestamp: new Date(),
        payload: {
          taskId: "task-to-delete",
          projectId: `${planPath}:10`,
          featureId: "delete123",
          deletedBy: "api",
          timestamp: nowIso(),
        },
      };

      const handleArmMessage = (brain as any).handleArmMessage.bind(brain);
      await handleArmMessage(message);

      // Should have logged the deletion
      const deletionLog = logActivityCalls.find(
        (call) => call.action === "task_deleted"
      );
      expect(deletionLog).toBeDefined();
      expect(deletionLog?.target).toBe("task-to-delete");

      // Should have published event
      const deletionEvent = publishEventCalls.find(
        (call) => call.type === "task.deleted"
      );
      expect(deletionEvent).toBeDefined();

      // Verify the feature was removed from plan
      const updatedContent = await readFile(planPath, "utf-8");
      expect(updatedContent).not.toContain("delete123");
    });

    it("should ignore unsupported message types", async () => {
      const message: QueueMessage = {
        id: "msg-456",
        from: "api",
        to: "brain",
        type: "unknown_type" as any,
        timestamp: new Date(),
        payload: {},
      };

      const handleArmMessage = (brain as any).handleArmMessage.bind(brain);
      
      // Should not throw for unsupported types
      await handleArmMessage(message);

      // Should not log any deletion activity
      const deletionLog = logActivityCalls.find(
        (call) => call.action === "task_deleted"
      );
      expect(deletionLog).toBeUndefined();
    });
  });
});
