/**
 * Agentic Brain Types
 */

import type { StatusReportStatus, StatusReportTestsStatus } from "../../types";

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

export interface DependencyReport {
  taskId: string;
  dependsOnTaskId: string;
  dependencyType?: 'finish_to_start' | 'start_to_start' | 'finish_to_finish' | 'start_to_finish';
  reason: string;
}

export interface ArmStatusItem {
  id: string;
  name: string;
  status: string;
  currentTask?: string;
  lastActivity?: string;
}

/**
 * Status report from an arm during or after task execution.
 * Used by brain to re-evaluate plans and determine next tasks.
 */
export interface StatusReportItem {
  id: string;
  taskId: string;
  taskSubject?: string;
  armId: string;
  status: StatusReportStatus;
  summary: string;
  issues: string[];
  blockers: string[];
  nextSteps?: string;
  filesChanged: string[];
  testsStatus?: StatusReportTestsStatus;
  createdAt: string;
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
