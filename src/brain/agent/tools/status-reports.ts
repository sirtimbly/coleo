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
      let query = `
        SELECT 
          sr.id,
          sr.task_id,
          sr.arm_id,
          sr.status,
          sr.summary,
          sr.issues,
          sr.blockers,
          sr.next_steps,
          sr.files_changed,
          sr.tests_status,
          sr.created_at,
          t.subject as task_subject
        FROM status_reports sr
        LEFT JOIN tasks t ON sr.task_id = t.id
        WHERE 1=1
      `;
      
      const params: string[] = [];
      
      if (input.taskId) {
        query += " AND sr.task_id = ?";
        params.push(input.taskId);
      }
      
      if (input.armId) {
        query += " AND sr.arm_id = ?";
        params.push(input.armId);
      }
      
      if (input.status) {
        query += " AND sr.status = ?";
        params.push(input.status);
      }
      
      if (input.since) {
        query += " AND sr.created_at > ?";
        params.push(input.since);
      }
      
      query += ` ORDER BY sr.created_at DESC LIMIT ?`;
      params.push(limit.toString());
      
      const results = this.context.db.query(query).all(...params) as Array<{
        id: string;
        task_id: string;
        arm_id: string;
        status: string;
        summary: string;
        issues: string;
        blockers: string;
        next_steps: string | null;
        files_changed: string;
        tests_status: string | null;
        created_at: string;
        task_subject: string | null;
      }>;
      
      const reports: StatusReportItem[] = results.map(r => ({
        id: r.id,
        taskId: r.task_id,
        taskSubject: r.task_subject || undefined,
        armId: r.arm_id,
        status: r.status as StatusReportItem["status"],
        summary: r.summary,
        issues: JSON.parse(r.issues || "[]") as string[],
        blockers: JSON.parse(r.blockers || "[]") as string[],
        nextSteps: r.next_steps || undefined,
        filesChanged: JSON.parse(r.files_changed || "[]") as string[],
        testsStatus: r.tests_status as "passing" | "failing" | "not_run" | undefined,
        createdAt: r.created_at,
      }));
      
      return { success: true, data: reports };
    } catch (error) {
      return { success: false, error: `Failed to get status reports: ${error}` };
    }
  }
}
