/**
 * Core types for Octopai
 */

// Tentacle identity and state
export interface Tentacle {
  id: string;
  name: string;
  agent: "opencode" | "claude-code" | string;
  status: "starting" | "running" | "idle" | "busy" | "stopped" | "error";
  pid?: number;
  startedAt: Date;
  lastActivity?: Date;
  currentTask?: string;
}

// Task representation
export interface Task {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "claimed" | "in_progress" | "completed" | "failed" | "blocked";
  priority: "critical" | "high" | "normal" | "low";
  assignedTo?: string; // tentacle id
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  artifacts?: string[]; // commit hashes, file paths, etc.
  mailThreadId?: string; // link back to mail conversation
}

// Message between agents (in queue)
export interface QueueMessage {
  id: string;
  from: string; // tentacle id or "brain" or "human"
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
  | "human_message";

// Discovery report from a tentacle
export interface Discovery {
  kind: "test_failure" | "unused_code" | "security_issue" | "performance" | "pattern" | "other";
  title: string;
  details: string;
  file?: string;
  line?: number;
  severity?: "info" | "warning" | "error";
}

// Shared note between tentacles
export interface Note {
  id: string;
  author: string; // tentacle id
  title: string;
  content: string;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

// Tool discovered by a tentacle
export interface DiscoveredTool {
  name: string;
  command: string;
  description: string;
  context?: string;
  discoveredBy: string; // tentacle id
  discoveredAt: Date;
}

// Brain state
export interface BrainState {
  status: "stopped" | "running" | "paused";
  lastPollAt?: Date;
  pollIntervalMs: number;
  activeTentacles: string[];
  pendingTasks: number;
  completedToday: number;
}

// Config file structure
export interface OctopaiConfig {
  version: number;
  octopaiDir: string;
  brain: {
    pollIntervalMs: number;
    maxTentacles: number;
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
}

// Default config
export const DEFAULT_CONFIG: OctopaiConfig = {
  version: 1,
  octopaiDir: "~/.octopai",
  brain: {
    pollIntervalMs: 30000,
    maxTentacles: 8,
  },
  mail: {
    fromAddress: "brain@octopai.local",
    digestSchedule: "immediate",
  },
  terminal: {
    emulator: "auto",
  },
};
