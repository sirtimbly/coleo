/**
 * Plan Reading Tool
 */

import { BrainTool } from "./base";
import type { ToolResult } from "./base";
import type { PlanDocument } from "../types";
import { LocalWorkspaceAccess, type WorkspaceAccess } from "../../../workspace";

export class ReadPlanTool extends BrainTool {
  name = "readPlan";
  description = "Read plan documents from .project/plan.md (main project plan only)";

  inputSchema = {
    type: "object",
    properties: {
      planId: { type: "string", description: "Specific plan ID to read (e.g., 'git-worktree-isolation')" },
    },
    required: [],
  };

  async execute(input: { planId?: string }): Promise<ToolResult<PlanDocument>> {
    try {
      const workspace = this.context.workspace
        ?? new LocalWorkspaceAccess(this.context.projectRoot);

      // If specific planId is requested, try to find it
      if (input.planId) {
        const planFiles = await this.listPlanFiles(workspace);
        const matchingPlan = planFiles.find((file) => file.includes(input.planId!));

        if (matchingPlan) {
          const file = await workspace.readText(matchingPlan);
          if (!file) throw new Error(`Plan disappeared while reading: ${matchingPlan}`);
          return {
            success: true,
            data: this.parsePlanContent(this.filename(matchingPlan), file.content),
          };
        }
      }

      // Otherwise, prioritize main plan.md
      const mainPlan = await workspace.readText(".project/plan.md");
      if (mainPlan) {
        return {
          success: true,
          data: this.parsePlanContent("plan.md", mainPlan.content),
        };
      }

      // Only fall back to .project/plans/ if plan.md doesn't exist
      const planFiles = await this.listPlanFiles(workspace);
      if (planFiles.length === 0) {
        return {
          success: false,
          error: "No plan documents found",
        };
      }

      const latestPlan = planFiles.sort((a, b) => b.localeCompare(a))[0]!;
      const file = await workspace.readText(latestPlan);
      if (!file) throw new Error(`Plan disappeared while reading: ${latestPlan}`);

      return {
        success: true,
        data: this.parsePlanContent(this.filename(latestPlan), file.content),
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to read plan: ${error}`,
      };
    }
  }

  private async listPlanFiles(workspace: WorkspaceAccess): Promise<string[]> {
    return (await workspace.scan([".project/plans/*.md"], { maxFiles: 500 }))
      .map((file) => file.path);
  }

  private filename(path: string): string {
    return path.split("/").at(-1) || path;
  }

  private parsePlanContent(filename: string, content: string): PlanDocument {
    const lines = content.split("\n");
    const goals: string[] = [];
    const bullets: PlanDocument["bullets"] = [];
    
    let currentSection = "";
    
    for (const line of lines) {
      if (line.startsWith("## Goal")) {
        currentSection = "goals";
      } else if (line.startsWith("## Approach") || line.startsWith("## Implementation")) {
        currentSection = "bullets";
      } else if (line.startsWith("## ") && currentSection !== "goals" && currentSection !== "bullets") {
        currentSection = "";
      }
      
      if (currentSection === "goals" && line.startsWith("- ")) {
        goals.push(line.slice(2).trim());
      } else if (currentSection === "bullets" && (line.startsWith("- ") || line.match(/^\d+\./))) {
        const text = line.replace(/^-\s*|^\d+\.\s*/, "").trim();
        bullets.push({
          text,
          status: text.startsWith("[x]") ? "completed" : "pending",
        });
      }
    }
    
    return {
      id: filename.replace(".md", ""),
      title: filename,
      content,
      goals,
      bullets,
    };
  }
}
