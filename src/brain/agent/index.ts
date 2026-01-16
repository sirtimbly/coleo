/**
 * Brain Agent - Agentic Brain Implementation
 * 
 * Uses LangChain.js patterns (adapted for Bun/TypeScript)
 */

import { BrainTool } from "./tools/base";
import { ReadPlanTool } from "./tools/plans";
import { GetTaskHistoryTool } from "./tools/tasks";
import { GetDiscoveriesTool } from "./tools/discoveries";
import { GetArmStatusTool } from "./tools/arm";
import { GetStatusReportsTool } from "./tools/status-reports";
import { DetermineNextTaskTool } from "./tools/determine-next-task";
import type { ToolContext } from "./tools/base";
import type { BrainAgentInput, BrainAgentOutput, PlanDocument, TaskHistoryItem, DiscoveryItem, ArmStatusItem, NextTaskResult, StatusReportItem } from "./types";
import { BRAIN_AGENT_SYSTEM_PROMPT, TOOL_DESCRIPTIONS } from "./prompts";

export class BrainAgent {
  private tools: Map<string, BrainTool>;
  private systemPrompt: string;

  constructor(context: ToolContext) {
    this.tools = new Map();
    this.systemPrompt = BRAIN_AGENT_SYSTEM_PROMPT;
    
    // Register tools
    this.registerTool(new ReadPlanTool(context));
    this.registerTool(new GetTaskHistoryTool(context));
    this.registerTool(new GetDiscoveriesTool(context));
    this.registerTool(new GetArmStatusTool(context));
    this.registerTool(new GetStatusReportsTool(context));
    this.registerTool(new DetermineNextTaskTool(context));
  }

  private registerTool(tool: BrainTool): void {
    this.tools.set(tool.name, tool);
  }

  async invoke(input: BrainAgentInput): Promise<BrainAgentOutput> {
    const messages = [
      { role: "system" as const, content: this.systemPrompt + "\n\n" + TOOL_DESCRIPTIONS },
      ...input.messages,
    ];

    // Simple reasoning: parse user intent and call appropriate tools
    if (messages.length === 0) {
      return {
        actions: [],
        response: "No messages to process",
      };
    }
    
    const lastMessage: { role: string; content: string } = messages[messages.length - 1] ?? { role: "", content: "" };
    
    if (lastMessage.role === "user") {
      const response = await this.processUserMessage(lastMessage.content, messages);
      return response;
    }

    return {
      actions: [],
      response: "No action taken",
    };
  }

  private async processUserMessage(content: string, messages: Array<{ role: string; content: string }>): Promise<BrainAgentOutput> {
    const contentLower = content.toLowerCase();
    const actions: BrainAgentOutput["actions"] = [];
    let response = "";

    // Determine what the user is asking for
    if (messages.length === 0) {
      return { actions, response: "No messages to process" };
    }
    
    const lastMessage = messages[messages.length - 1];
    if (contentLower.includes("what should") && contentLower.includes("do next")) {
      // Determine next task
      actions.push({ tool: "readPlan", input: {} });
      actions.push({ tool: "getTaskHistory", input: { status: "completed", limit: 10 } });
      actions.push({ tool: "getDiscoveries", input: {} });
      
      response = "Let me check the current plan, what's been done, and any open discoveries to determine the next task.";
    } else if (contentLower.includes("status") || contentLower.includes("how are") || contentLower.includes("arm")) {
      // Get arm status
      actions.push({ tool: "getArmStatus", input: {} });
      
      response = "Let me check the status of all arms.";
    } else if (contentLower.includes("discovery") || contentLower.includes("found")) {
      // Get discoveries
      actions.push({ tool: "getDiscoveries", input: {} });
      
      response = "Let me retrieve the current discoveries.";
    } else if (contentLower.includes("plan") || contentLower.includes("what needs")) {
      // Read plan
      actions.push({ tool: "readPlan", input: {} });
      
      response = "Let me read the current plan to see what needs to be done.";
    } else if (contentLower.includes("task") || contentLower.includes("done") || contentLower.includes("completed")) {
      // Get task history
      actions.push({ tool: "getTaskHistory", input: { status: "completed", limit: 10 } });
      
      response = "Let me check what's been completed recently.";
    } else {
      response = "I understand you're asking about: " + content.substring(0, 100) + "...\n\nI'm not sure what specific action you need. I can help with:\n- Determining next tasks\n- Checking arm status\n- Reviewing discoveries\n- Reading plan documents\n- Checking task history";
    }

    return { actions, response };
  }

  async executeAction(toolName: string, input: Record<string, unknown>): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const tool = this.tools.get(toolName);
    
    if (!tool) {
      return { success: false, error: `Unknown tool: ${toolName}` };
    }

    return tool.execute(input);
  }

  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }
}
