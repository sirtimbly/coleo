/**
 * Core types for Octopai
 */

// Arm identity and state
export interface Arm {
  id: string;
  name: string;
  agent: "opencode" | "claude-code" | string;
  status: "starting" | "running" | "idle" | "busy" | "stopped" | "error";
  pid?: number;
  startedAt: Date;
  lastActivity?: Date;
  currentTask?: string;
  /** AI provider (e.g., "opencode", "github-copilot", "anthropic") */
  provider?: string;
  /** Model name (e.g., "claude-sonnet-4", "gpt-5.1-codex") */
  model?: string;
}

/** @deprecated Use Arm instead */
export type Tentacle = Arm;

// Task representation
export interface Task {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "claimed" | "in_progress" | "completed" | "failed" | "blocked";
  priority: "critical" | "high" | "normal" | "low";
  assignedTo?: string; // arm id
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  artifacts?: string[]; // commit hashes, file paths, etc.
  mailThreadId?: string; // link back to mail conversation
}

// Message between agents (in queue)
export interface QueueMessage {
  id: string;
  from: string; // arm id or "brain" or "human"
  to: string;
  timestamp: Date;
  type: MessageType;
  payload: unknown;
  processed?: boolean;
}

export type MessageType =
  | "task_assignment"
  | "task_complete"
  | "task_failed"
  | "discovery"
  | "approval_request"
  | "approval_response"
  | "share_note"
  | "tool_discovery"
  | "status_update"
  | "heartbeat"
  | "human_message";

// Discovery report from an arm
export interface Discovery {
  kind: "test_failure" | "unused_code" | "security_issue" | "performance" | "pattern" | "other";
  title: string;
  details: string;
  file?: string;
  line?: number;
  severity?: "info" | "warning" | "error";
}

// Shared note between arms
export interface Note {
  id: string;
  author: string; // arm id
  title: string;
  content: string;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

// Tool discovered by an arm
export interface DiscoveredTool {
  name: string;
  command: string;
  description: string;
  context?: string;
  discoveredBy: string; // arm id
  discoveredAt: Date;
}

// Brain state
export interface BrainState {
  status: "stopped" | "running" | "paused";
  lastPollAt?: Date;
  pollIntervalMs: number;
  activeArms: string[];
  pendingTasks: number;
  completedToday: number;
}

// Config file structure
export interface OctopaiConfig {
  version: number;
  octopaiDir: string;
  brain: {
    pollIntervalMs: number;
    maxArms: number;
  };
  mail: {
    fromAddress: string;
    digestSchedule: "immediate" | "hourly" | "daily";
  };
  gitea?: {
    url: string;
    token: string;
    defaultOrg: string;
    defaultRepo: string;
  };
  terminal: {
    emulator: "auto" | "ghostty" | "iterm2" | "terminal" | "wezterm";
  };
  defaults: {
    harness: string;
    provider: string;
    model: string;
    contextBudget: number;
  };
}

// Default config
export const DEFAULT_CONFIG: OctopaiConfig = {
  version: 1,
  octopaiDir: "~/.octopai",
  brain: {
    pollIntervalMs: 30000,
    maxArms: 8,
  },
  mail: {
    fromAddress: "brain@octopai.local",
    digestSchedule: "immediate",
  },
  terminal: {
    emulator: "auto",
  },
  defaults: {
    harness: "opencode",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    contextBudget: 100000,
  },
};
