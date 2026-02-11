/**
 * Status Reports Tool
 * 
 * Allows the brain to query status reports from arms for progressive planning.
 * Status reports influence task assignment - issues lead to "verify & polish" tasks.
 */

import { BrainTool } from "./base";
import type { ToolResult } from "./base";
import type { StatusReportItem } from "../types";

export class GetStatusReportsTool extends BrainTool {
  name = "getStatusReports";
  description = "Get recent status reports from arms. Status reports contain progress updates, issues found, blockers, and test status. Used to influence task assignment - tasks with issues trigger 'verify & polish' follow-up tasks.";
  
  inputSchema = {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Filter by specific task ID" },
      armId: { type: "string", description: "Filter by specific arm ID" },
      status: { 
        type: "string", 
        enum: ["on_track", "blocked", "issues_found", "needs_review", "completed_with_issues"],
        description: "Filter by status report status"
      },
      since: { type: "string", description: "ISO timestamp - only return reports after this time" },
      limit: { type: "number", description: "Maximum number of reports to return", default: 20 },
    },
    required: [],
  };

  async execute(input: { 
    taskId?: string; 
    armId?: string; 
    status?: string;
    since?: string;
    limit?: number;
  }): Promise<ToolResult<StatusReportItem[]>> {
    try {
      const limit = input.limit ?? 20;

      const results = this.context.db.listStatusReports({
        taskId: input.taskId,
        armId: input.armId,
        status: input.status,
        since: input.since,
        limit,
      });

      const taskSubjectById = new Map<string, string>();
      if (results.some((r) => !!r.taskId)) {
        const taskIds = Array.from(new Set(results.map((r) => r.taskId)));
        for (const taskId of taskIds) {
          const task = this.context.db.getTask(taskId);
          if (task) {
            taskSubjectById.set(task.id, task.subject);
          }
        }
      }

      const reports: StatusReportItem[] = results.map((r) => ({
        id: r.id,
        taskId: r.taskId,
        taskSubject: taskSubjectById.get(r.taskId),
        armId: r.armId,
        status: r.status as StatusReportItem["status"],
        summary: r.summary,
        issues: r.issues,
        blockers: r.blockers,
        nextSteps: r.nextSteps || undefined,
        filesChanged: r.filesChanged,
        testsStatus: r.testsStatus as "passing" | "failing" | "not_run" | undefined,
        createdAt: r.createdAt,
      }));
      
      return { success: true, data: reports };
    } catch (error) {
      return { success: false, error: `Failed to get status reports: ${error}` };
    }
  }
}
