/**
 * Dependency Reporting Tool
 */

import { BrainTool } from "./base";
import type { ToolResult } from "./base";
import { eventStore } from "../../../nats/jetstream";

export interface DependencyReport {
  taskId: string;
  dependsOnTaskId: string;
  dependencyType?: 'finish_to_start' | 'start_to_start' | 'finish_to_finish' | 'start_to_finish';
  reason: string;
}

export class ReportDependencyTool extends BrainTool {
  name = "reportDependency";
  description = "Report a dependency relationship discovered during task execution";

  inputSchema = {
    type: "object",
    properties: {
      taskId: { type: "string", description: "The task that has the dependency" },
      dependsOnTaskId: { type: "string", description: "The task that must be completed first" },
      dependencyType: {
        type: "string",
        enum: ["finish_to_start", "start_to_start", "finish_to_finish", "start_to_finish"],
        description: "Type of dependency relationship",
        default: "finish_to_start"
      },
      reason: { type: "string", description: "Explanation of why this dependency exists" },
    },
    required: ["taskId", "dependsOnTaskId", "reason"],
  };

  async execute(input: {
    taskId: string;
    dependsOnTaskId: string;
    dependencyType?: 'finish_to_start' | 'start_to_start' | 'finish_to_finish' | 'start_to_finish';
    reason: string;
  }): Promise<ToolResult<DependencyReport>> {
    try {
      // Validate that both tasks exist
      const taskExists = this.context.db.getTask(input.taskId);
      if (!taskExists) {
        return { success: false, error: `Task ${input.taskId} not found` };
      }

      const dependsOnExists = this.context.db.getTask(input.dependsOnTaskId);
      if (!dependsOnExists) {
        return { success: false, error: `Dependency task ${input.dependsOnTaskId} not found` };
      }

      this.context.db.upsertTaskDependency({
        taskId: input.taskId,
        dependsOnTaskId: input.dependsOnTaskId,
        dependencyType: input.dependencyType || "finish_to_start",
        autoDetected: false,
        reason: input.reason,
      });

      // Log the dependency report to JetStream
      if (eventStore.isInitialized()) {
        eventStore.publishEvent(`coleo.events.brain.dependency_reported`, {
          type: "dependency_reported",
          armId: "brain",
          data: {
            taskId: input.taskId,
            dependsOnTaskId: input.dependsOnTaskId,
            dependencyType: input.dependencyType || 'finish_to_start',
            reason: input.reason,
            autoDetected: false
          },
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      }

      const result: DependencyReport = {
        taskId: input.taskId,
        dependsOnTaskId: input.dependsOnTaskId,
        dependencyType: input.dependencyType || 'finish_to_start',
        reason: input.reason,
      };

      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: `Failed to report dependency: ${error}` };
    }
  }
}
