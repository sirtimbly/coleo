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
      const results = this.context.db.listArms({
        armId: input.armId,
        includeStopped: false,
      });

      const arms: ArmStatusItem[] = results
        .sort((a, b) => (b.lastActivityAt || "").localeCompare(a.lastActivityAt || ""))
        .map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        currentTask: r.currentTaskSubject || undefined,
        lastActivity: r.lastActivityAt || undefined,
      }));
      
      return { success: true, data: arms };
    } catch (error) {
      return { success: false, error: `Failed to get arm status: ${error}` };
    }
  }
}
