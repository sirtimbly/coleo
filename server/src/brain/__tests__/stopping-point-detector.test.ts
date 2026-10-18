import { describe, it, expect } from "bun:test";
import {
  detectStoppingPoint,
  getRecommendedActions,
  DEFAULT_CRITERIA,
  type StoppingPointCriteria,
} from "../../brain/stopping-point-detector";
import type { Task } from "../../types";

const mockTask: Task = {
  id: "task-123",
  subject: "Test task",
  description: "Test description",
  status: "in_progress",
  priority: "high",
  createdAt: new Date(),
  updatedAt: new Date(),
  classification: "development",
};

describe("stopping-point-detector", () => {
  describe("detectStoppingPoint", () => {
    it("should return false for insufficient changes", async () => {
      const gitStatus = {
        branch: "master",
        ahead: 0,
        behind: 0,
        staged: [],
        unstaged: [],
        untracked: [],
        commitsSinceLastStop: 0,
      };

      const result = await detectStoppingPoint(
        mockTask,
        gitStatus,
        null,
        30,
        DEFAULT_CRITERIA
      );

      expect(result.isGoodStoppingPoint).toBe(false);
      expect(result.confidence).toBeLessThan(0.6);
    });

    it("should detect good stopping point with sufficient files changed", async () => {
      const gitStatus = {
        branch: "master",
        ahead: 5,
        behind: 0,
        staged: ["file1.ts", "file2.ts", "file3.ts"],
        unstaged: [],
        untracked: [],
        commitsSinceLastStop: 5,
      };

      const result = await detectStoppingPoint(
        mockTask,
        gitStatus,
        "passing",
        90,
        DEFAULT_CRITERIA
      );

      expect(result.isGoodStoppingPoint).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0.6);
      expect(result.metrics.filesChanged).toBe(3);
    });

    it("should consider test status when configured", async () => {
      const criteria: StoppingPointCriteria = {
        ...DEFAULT_CRITERIA,
        requireTestsPassing: true,
      };

      const gitStatus = {
        branch: "master",
        ahead: 5,
        behind: 0,
        staged: ["file1.ts", "file2.ts", "file3.ts", "file4.ts", "file5.ts"],
        unstaged: [],
        untracked: [],
        commitsSinceLastStop: 3,
      };

      // With passing tests
      const passingResult = await detectStoppingPoint(
        mockTask,
        gitStatus,
        "passing",
        60,
        criteria
      );
      expect(passingResult.confidence).toBeGreaterThan(0.5);

      // With failing tests
      const failingResult = await detectStoppingPoint(
        mockTask,
        gitStatus,
        "failing",
        60,
        criteria
      );
      expect(failingResult.confidence).toBeLessThan(passingResult.confidence);
      expect(failingResult.recommendations).toContain(
        "Fix failing tests before creating PR"
      );
    });

    it("should force stop after max duration", async () => {
      const gitStatus = {
        branch: "master",
        ahead: 2,
        behind: 0,
        staged: ["file1.ts"],
        unstaged: [],
        untracked: [],
        commitsSinceLastStop: 2,
      };

      const result = await detectStoppingPoint(
        mockTask,
        gitStatus,
        null,
        150, // 2.5 hours, exceeds 120 minute threshold
        DEFAULT_CRITERIA
      );

      expect(result.confidence).toBeGreaterThan(0.4);
      expect(result.recommendations).toContain(
        "Consider stopping - session duration is long"
      );
    });

    it("should consider refactoring tasks differently", async () => {
      const refactoringTask: Task = {
        ...mockTask,
        classification: "refactoring",
      };

      const gitStatus = {
        branch: "master",
        ahead: 8,
        behind: 0,
        staged: ["file1.ts", "file2.ts", "file3.ts", "file4.ts", "file5.ts", "file6.ts"],
        unstaged: [],
        untracked: [],
        commitsSinceLastStop: 6,
      };

      const result = await detectStoppingPoint(
        refactoringTask,
        gitStatus,
        "passing",
        90,
        DEFAULT_CRITERIA
      );

      expect(result.reasons).toContain(
        "Refactoring work with multiple files - good stopping point"
      );
    });

    it("should handle high complexity scores", async () => {
      const gitStatus = {
        branch: "master",
        ahead: 15,
        behind: 0,
        staged: ["file1.ts", "file2.ts"],
        unstaged: ["file3.ts", "file4.ts", "file5.ts", "file6.ts", "file7.ts"],
        untracked: ["file8.ts", "file9.ts", "file10.ts", "file11.ts", "file12.ts"],
        commitsSinceLastStop: 15,
      };

      const result = await detectStoppingPoint(
        mockTask,
        gitStatus,
        "passing",
        120,
        DEFAULT_CRITERIA
      );

      expect(result.metrics.complexityScore).toBeGreaterThan(50);
      expect(result.recommendations).toContain(
        "Consider breaking into smaller PRs"
      );
    });
  });

  describe("getRecommendedActions", () => {
    it("should suggest PR actions for good stopping point", () => {
      const analysis = {
        isGoodStoppingPoint: true,
        confidence: 0.75,
        reasons: ["Significant changes", "Tests passing"],
        recommendations: [],
        metrics: {
          filesChanged: 5,
          commits: 4,
          durationMinutes: 90,
          testsPassing: true,
          complexityScore: 30,
          linesAdded: 0,
          linesRemoved: 0,
        },
      };

      const actions = getRecommendedActions(analysis);

      expect(actions).toContain("Create feature branch");
      expect(actions).toContain("Organize and commit changes");
      expect(actions).toContain("Open PR draft");
    });

    it("should suggest continuing work for insufficient progress", () => {
      const analysis = {
        isGoodStoppingPoint: false,
        confidence: 0.3,
        reasons: [],
        recommendations: ["Wait until at least 3 files are changed"],
        metrics: {
          filesChanged: 1,
          commits: 1,
          durationMinutes: 15,
          testsPassing: null,
          complexityScore: 10,
          linesAdded: 0,
          linesRemoved: 0,
        },
      };

      const actions = getRecommendedActions(analysis);

      expect(actions).toContain("Continue current task");
      expect(actions).toContain("Continue working to reach minimum file threshold");
    });

    it("should suggest splitting for high complexity", () => {
      const analysis = {
        isGoodStoppingPoint: true,
        confidence: 0.8,
        reasons: ["Many files changed"],
        recommendations: [],
        metrics: {
          filesChanged: 20,
          commits: 8,
          durationMinutes: 120,
          testsPassing: true,
          complexityScore: 75,
          linesAdded: 0,
          linesRemoved: 0,
        },
      };

      const actions = getRecommendedActions(analysis);

      expect(actions).toContain("Consider splitting into multiple PRs");
    });
  });
});
