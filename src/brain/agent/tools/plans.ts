/**
 * Plan Reading Tool
 */

import { readFile } from "fs/promises";
import { join } from "path";
import fg from "fast-glob";
import { BrainTool } from "./base";
import type { ToolResult } from "./base";
import type { PlanDocument } from "../types";

export class ReadPlanTool extends BrainTool {
  name = "readPlan";
  description = "Read plan documents from .project/plans/ directory";
  
  inputSchema = {
    type: "object",
    properties: {
      planId: { type: "string", description: "Specific plan ID to read (default: latest plan)" },
    },
    required: [],
  };

  async execute(input: { planId?: string }): Promise<ToolResult<PlanDocument>> {
    try {
      const plansDir = join(this.context.projectRoot, ".project", "plans");
      
      let planFiles = await fg("*.md", { cwd: plansDir });
      
      if (input.planId) {
        planFiles = planFiles.filter(f => f.includes(input.planId!));
      }
      
      if (planFiles.length === 0) {
        // Fall back to main plan.md
        const mainPlanPath = join(this.context.projectRoot, ".project", "plan.md");
        try {
          const content = await readFile(mainPlanPath, "utf-8");
          return {
            success: true,
            data: this.parsePlanContent("plan.md", content),
          };
        } catch {
          return {
            success: false,
            error: "No plan documents found",
          };
        }
      }

      // Sort by modification time, get latest
      planFiles.sort((a, b) => b.localeCompare(a));
      
      const latestPlan = planFiles[0] ?? "plan.md";
      const content = await readFile(join(plansDir, latestPlan), "utf-8");
      
      return {
        success: true,
        data: this.parsePlanContent(latestPlan, content),
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to read plan: ${error}`,
      };
    }
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
