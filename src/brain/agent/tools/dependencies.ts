/**
 * Dependency Reporting Tool
 */

import { BrainTool } from "./base";
import type { ToolResult } from "./base";

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
      const taskExists = this.context.db.query("SELECT 1 FROM tasks WHERE id = ?").get(input.taskId);
      if (!taskExists) {
        return { success: false, error: `Task ${input.taskId} not found` };
      }

      const dependsOnExists = this.context.db.query("SELECT 1 FROM tasks WHERE id = ?").get(input.dependsOnTaskId);
      if (!dependsOnExists) {
        return { success: false, error: `Dependency task ${input.dependsOnTaskId} not found` };
      }

      // Check if dependency already exists
      const existing = this.context.db.query(
        "SELECT id FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?"
      ).get(input.taskId, input.dependsOnTaskId);

      if (existing) {
        // Update existing dependency
        this.context.db.run(
          `UPDATE task_dependencies SET
           dependency_type = ?, reason = ?, auto_detected = 0
           WHERE task_id = ? AND depends_on_task_id = ?`,
          [
            input.dependencyType || 'finish_to_start',
            input.reason,
            input.taskId,
            input.dependsOnTaskId
          ]
        );
      } else {
        // Insert new dependency
        this.context.db.run(
          `INSERT INTO task_dependencies
           (task_id, depends_on_task_id, dependency_type, auto_detected, reason)
           VALUES (?, ?, ?, 0, ?)`,
          [
            input.taskId,
            input.dependsOnTaskId,
            input.dependencyType || 'finish_to_start',
            input.reason
          ]
        );
      }

      // Log the dependency report
      this.context.db.run(
        `INSERT INTO activity (timestamp, actor, action, target, details)
         VALUES (?, 'brain', 'dependency_reported', ?, ?)`,
        [
          new Date().toISOString(),
          input.taskId,
          JSON.stringify({
            dependsOnTaskId: input.dependsOnTaskId,
            dependencyType: input.dependencyType || 'finish_to_start',
            reason: input.reason,
            autoDetected: false
          })
        ]
      );

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