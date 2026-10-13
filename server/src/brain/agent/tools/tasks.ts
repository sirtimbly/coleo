/**
 * Task History Tool
 */

import { BrainTool } from "./base";
import type { ToolResult } from "./base";
import type { TaskHistoryItem } from "../types";

export class GetTaskHistoryTool extends BrainTool {
  name = "getTaskHistory";
  description = "Get history of completed and in-progress tasks from database";
  
  inputSchema = {
    type: "object",
    properties: {
      planId: { type: "string", description: "Filter by plan ID" },
      limit: { type: "number", description: "Maximum number of tasks to return", default: 20 },
      status: { type: "string", enum: ["completed", "in_progress"], description: "Filter by status" },
    },
    required: [],
  };

  async execute(input: { planId?: string; limit?: number; status?: string }): Promise<ToolResult<TaskHistoryItem[]>> {
    try {
      const limit = input.limit ?? 20;

      const results = this.context.db.listTasks({
        statuses: input.status ? [input.status] : undefined,
        limit,
        sort: "created_desc",
      });

      const tasks: TaskHistoryItem[] = results.map((r) => ({
        id: r.id,
        subject: r.subject,
        status: r.status,
        completedAt: r.completedAt || undefined,
        domain: r.domain || undefined,
      }));
      
      return { success: true, data: tasks };
    } catch (error) {
      return { success: false, error: `Failed to get task history: ${error}` };
    }
  }
}
