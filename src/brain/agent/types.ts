/**
 * Agentic Brain Types
 */

export interface BrainAgentInput {
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: string;
  }>;
}

export interface BrainAgentOutput {
  actions: Array<{
    tool: string;
    input: Record<string, unknown>;
  }>;
  response: string;
}

export interface PlanDocument {
  id: string;
  title: string;
  content: string;
  phase?: string;
  goals: string[];
  bullets: Array<{
    text: string;
    status: "pending" | "in_progress" | "completed";
    dependencies?: string[];
  }>;
}

export interface TaskHistoryItem {
  id: string;
  subject: string;
  status: string;
  completedAt?: string;
  domain?: string;
}

export interface DiscoveryItem {
  id: string;
  kind: string;
  title: string;
  details: string;
  severity: string;
  filePath?: string;
}

export interface ArmStatusItem {
  id: string;
  name: string;
  status: string;
  currentTask?: string;
  lastActivity?: string;
}

export interface NextTaskResult {
  task: {
    subject: string;
    description: string;
    classification: string;
    domain?: string;
    priority: string;
  };
  context: {
    planExcerpt?: string;
    discoveries?: string[];
    history?: string[];
  };
  reasoning: string;
}

export interface TaskAssignmentResult {
  success: boolean;
  taskId: string;
  armId: string;
}

export interface HumanMessageResult {
  success: boolean;
  subject: string;
  body: string;
}
