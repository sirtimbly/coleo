import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Brain } from "../brain";
import { join } from "path";
import { mkdir, writeFile, rm } from "fs/promises";
import type { Task } from "../../types";

describe("Brain claims integration", () => {
  const testDir = join("/tmp", `coleo-claims-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  let brain: Brain;

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    brain = new Brain({
      coleoDir: testDir,
      pollIntervalMs: 1000,
      verbose: false,
    });
  });

  afterEach(async () => {
    brain.stop();
    await rm(testDir, { recursive: true, force: true });
  });

  describe("extractFilePathsFromTask", () => {
    it("should extract file paths from task artifacts", () => {
      const task: Task = {
        id: "test-1",
        subject: "Test task",
        description: "Test description",
        status: "pending",
        priority: "normal",
        createdAt: new Date(),
        updatedAt: new Date(),
        artifacts: ["src/brain/brain.ts", "src/api/routes/tasks.ts", "commit-abc123"],
      };

      const files = (brain as any).extractFilePathsFromTask(task);

      expect(files).toContain("src/brain/brain.ts");
      expect(files).toContain("src/api/routes/tasks.ts");
      expect(files).not.toContain("commit-abc123"); // Not a file path
    });

    it("should extract file paths from task discoveries", () => {
      const task: Task = {
        id: "test-2",
        subject: "Test task",
        description: "Test description",
        status: "pending",
        priority: "normal",
        createdAt: new Date(),
        updatedAt: new Date(),
        context: {
          discoveries: [
            {
              id: "d1",
              kind: "related_code",
              title: "Test discovery",
              details: "Test details",
              filePath: "src/mcp/server.ts",
              severity: "info",
            },
            {
              id: "d2",
              kind: "missing_context",
              title: "Another discovery",
              details: "More details",
              filePath: "src/db/index.ts",
              severity: "warning",
            },
          ],
        },
      };

      const files = (brain as any).extractFilePathsFromTask(task);

      expect(files).toContain("src/mcp/server.ts");
      expect(files).toContain("src/db/index.ts");
    });

    it("should extract file paths from task description", () => {
      const task: Task = {
        id: "test-3",
        subject: "Test task",
        description: `Please update the following files:
- src/components/Button.tsx
- src/components/Card.tsx
- docs/readme.md

Also check src/utils/helpers.ts for reference.`,
        status: "pending",
        priority: "normal",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const files = (brain as any).extractFilePathsFromTask(task);

      expect(files).toContain("src/components/Button.ts");
      expect(files).toContain("src/components/Card.ts");
      expect(files).toContain("docs/readme.md");
      expect(files).toContain("src/utils/helpers.ts");
    });

    it("should remove duplicate file paths", () => {
      const task: Task = {
        id: "test-4",
        subject: "Test task",
        description: "Update src/brain/brain.ts",
        status: "pending",
        priority: "normal",
        createdAt: new Date(),
        updatedAt: new Date(),
        artifacts: ["src/brain/brain.ts"],
        context: {
          discoveries: [
            {
              id: "d1",
              kind: "related_code",
              title: "Test",
              details: "Test",
              filePath: "src/brain/brain.ts",
              severity: "info",
            },
          ],
        },
      };

      const files = (brain as any).extractFilePathsFromTask(task);

      // Should only appear once despite being in artifacts, description, and discoveries
      const occurrences = files.filter((f: string) => f === "src/brain/brain.ts");
      expect(occurrences.length).toBe(1);
    });
  });

  describe("findClaimConflicts", () => {
    it("should find exact file path conflicts", () => {
      const taskFiles = ["src/brain/brain.ts", "src/api/routes/tasks.ts"];
      const activeClaims = [
        { armId: "arm-1", filePath: "src/brain/brain.ts", claimType: "write", claimedAt: "2024-01-01" },
        { armId: "arm-2", filePath: "src/mcp/server.ts", claimType: "read", claimedAt: "2024-01-01" },
      ];

      const conflicts = (brain as any).findClaimConflicts(taskFiles, activeClaims);

      expect(conflicts.length).toBe(1);
      expect(conflicts[0].armId).toBe("arm-1");
      expect(conflicts[0].filePath).toBe("src/brain/brain.ts");
    });

    it("should find directory-level conflicts", () => {
      const taskFiles = ["src/brain/brain.ts", "src/brain/utils/helpers.ts"];
      const activeClaims = [
        { armId: "arm-1", filePath: "src/brain", claimType: "write", claimedAt: "2024-01-01" },
      ];

      const conflicts = (brain as any).findClaimConflicts(taskFiles, activeClaims);

      expect(conflicts.length).toBe(2);
      expect(conflicts.map((c: any) => c.filePath)).toContain("src/brain");
    });

    it("should return empty array when no conflicts exist", () => {
      const taskFiles = ["src/brain/brain.ts"];
      const activeClaims = [
        { armId: "arm-1", filePath: "src/mcp/server.ts", claimType: "write", claimedAt: "2024-01-01" },
      ];

      const conflicts = (brain as any).findClaimConflicts(taskFiles, activeClaims);

      expect(conflicts.length).toBe(0);
    });

    it("should handle normalized paths", () => {
      const taskFiles = ["./src/brain/brain.ts", "/src/api/routes.ts"];
      const activeClaims = [
        { armId: "arm-1", filePath: "src/brain/brain.ts", claimType: "write", claimedAt: "2024-01-01" },
        { armId: "arm-2", filePath: "./src/api/routes.ts", claimType: "read", claimedAt: "2024-01-01" },
      ];

      const conflicts = (brain as any).findClaimConflicts(taskFiles, activeClaims);

      expect(conflicts.length).toBe(2);
    });
  });

  describe("resolveClaimsActive flag", () => {
    it("should default to false (passive mode)", () => {
      expect((brain as any).resolveClaimsActive).toBe(false);
    });

    it("should not attempt resolution when flag is false", async () => {
      const task: Task = {
        id: "test-1",
        subject: "Test task",
        description: "Test",
        status: "pending",
        priority: "normal",
        createdAt: new Date(),
        updatedAt: new Date(),
        artifacts: ["src/brain/brain.ts"],
      };

      const conflicts = [
        { armId: "arm-1", filePath: "src/brain/brain.ts", claimType: "write", claimedAt: "2024-01-01" },
      ];

      // Mock the attemptClaimConflictResolution to track if it's called
      let resolutionAttempted = false;
      const originalMethod = (brain as any).attemptClaimConflictResolution;
      (brain as any).attemptClaimConflictResolution = async () => {
        resolutionAttempted = true;
      };

      (brain as any).resolveClaimsActive = false;
      await (brain as any).checkAndBlockTasksForClaimConflicts([task]);

      // Restore original method
      (brain as any).attemptClaimConflictResolution = originalMethod;

      // Resolution should not be attempted when flag is false
      expect(resolutionAttempted).toBe(false);
    });
  });
});
