import { afterEach, describe, expect, it } from "bun:test";
import type { TaskDeterminationResult } from "../../brain/prompt-generator";

import {
  buildTaskDeterminationOptionsForArm,
  clearRecentCompletedTaskExclusion,
  getRecentCompletedTaskIdForExclusion,
  rememberRecentlyCompletedTask,
  updateCompletionExclusionAfterDetermination,
} from "../utils";

function makeDeterminationResult(taskId?: string): TaskDeterminationResult {
  if (!taskId) {
    return {} as TaskDeterminationResult;
  }
  return {
    task: { id: taskId },
  } as TaskDeterminationResult;
}

afterEach(() => {
  clearRecentCompletedTaskExclusion();
});

describe("MCP completion exclusion helpers", () => {
  it("tracks a recently completed task for subsequent determination calls", () => {
    rememberRecentlyCompletedTask("  task-123  ");

    expect(getRecentCompletedTaskIdForExclusion()).toBe("task-123");
    expect(buildTaskDeterminationOptionsForArm()).toEqual({
      excludeTaskIds: ["task-123"],
      excludeVerificationForTaskIds: ["task-123"],
    });
  });

  it("ignores blank task ids", () => {
    rememberRecentlyCompletedTask("   ");

    expect(getRecentCompletedTaskIdForExclusion()).toBeNull();
    expect(buildTaskDeterminationOptionsForArm()).toEqual({});
  });

  it("clears the exclusion once routing moves to a different task", () => {
    rememberRecentlyCompletedTask("task-123");

    updateCompletionExclusionAfterDetermination(makeDeterminationResult("task-456"));

    expect(getRecentCompletedTaskIdForExclusion()).toBeNull();
  });

  it("keeps the exclusion when the brain returns the same task again", () => {
    rememberRecentlyCompletedTask("task-123");

    updateCompletionExclusionAfterDetermination(makeDeterminationResult("task-123"));

    expect(getRecentCompletedTaskIdForExclusion()).toBe("task-123");
  });
});
