/**
 * Arm Status Tool
 */

import { BrainTool } from "./base";
import type { ToolResult } from "./base";
import type { ArmStatusItem } from "../types";

export class GetArmStatusTool extends BrainTool {
  name = "getArmStatus";
  description = "Check the status of arms, detect stuck loops";
  
  inputSchema = {
    type: "object",
    properties: {
      armId: { type: "string", description: "Specific arm ID to check" },
    },
    required: [],
  };

  async execute(input: { armId?: string }): Promise<ToolResult<ArmStatusItem[]>> {
    try {
      let query = `
        SELECT id, name, status, current_task_subject, last_activity_at
        FROM arms
        WHERE status != 'stopped'
      `;
      
      const params: string[] = [];
      
      if (input.armId) {
        query += " AND id = ?";
        params.push(input.armId);
      }
      
      query += " ORDER BY last_activity_at DESC";
      
      const results = this.context.db.query(query).all(...params) as Array<{
        id: string;
        name: string;
        status: string;
        current_task_subject: string | null;
        last_activity_at: string | null;
      }>;
      
      const arms: ArmStatusItem[] = results.map(r => ({
        id: r.id,
        name: r.name,
        status: r.status,
        currentTask: r.current_task_subject || undefined,
        lastActivity: r.last_activity_at || undefined,
      }));
      
      return { success: true, data: arms };
    } catch (error) {
      return { success: false, error: `Failed to get arm status: ${error}` };
    }
  }
}
