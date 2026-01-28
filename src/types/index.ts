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
  /**
   * Logical classification of the work to be done
   * (architect, development, qa, documentation, etc.).
   */
  classification?: string;
  /**
   * Legacy field for preferred arm domain. New code should
   * prefer `classification` + task configuration templates.
   */
  domain?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  artifacts?: string[]; // commit hashes, file paths, etc.
  mailThreadId?: string; // link back to mail conversation
  context?: {
    discoveries?: Array<{
      id: string;
      kind: string;
      title: string;
      details: string;
      filePath?: string;
      lineNumber?: number;
      severity: string;
    }>;
    notes?: string;
  };
}

// Task configuration templates
export interface TaskConfigurationTemplate {
  /**
   * Primary classification this template is for
   * (architect, development, qa, documentation, etc.).
   */
  classification: string;
  /** Optional subtype for flavors like "project-management". */
  subtype?: string;
  /** Human-readable description of the template's intent. */
  description: string;
  /**
   * Recommended tools or tool families this task should use.
   * These are logical names ("fs", "git", "mcp:guidance"), not
   * provider-specific IDs.
   */
  allowedTools?: string[];
  /**
   * Paths or logical labels for context bundles that should
   * be loaded for this task type (e.g., ".project/*", "docs/",
   * "recentDiscoveries").
   */
  contextBundles?: string[];
  /**
   * Governance expectations for this task type – when to
   * create proposals, when to request human input, etc.
   */
  governance?: {
    /**
     * Whether significant changes under this template should
     * generally go through the proposal system.
     */
    requiresProposal?: boolean;
    /**
     * Proposal types commonly used for this task
     * (e.g., "refactor", "breaking_change").
     */
    typicalProposalTypes?: string[];
    /**
     * When true, tasks of this type are expected to
     * produce status reports and/or human-facing summaries.
     */
    emphasizeStatusReports?: boolean;
  };
  /**
   * Additional hints the brain or harness may use when
   * preparing prompts or routing work.
   */
  hints?: {
    /**
     * Short instruction to prepend to the task prompt,
     * explaining how this classification should behave.
     */
    systemHint?: string;
  };
}

/**
 * Registry of built-in task configuration templates keyed by
 * `${classification}:${subtype ?? "default"}`. This acts as a
 * starting point; arms can still adapt behavior at runtime.
 */
export const TASK_CONFIGURATION_TEMPLATES: Record<string, TaskConfigurationTemplate> = {
  "architect:project-management": {
    classification: "architect",
    subtype: "project-management",
    description: "Project management tasks that coordinate work, plans, and status via .project/ and docs/.",
    allowedTools: [
      "fs",
      "git",
      "mcp:guidance",
      "mcp:status",
    ],
    contextBundles: [
      ".project/*",
      "docs/",
      "recentActivity",
      "statusReports",
    ],
    governance: {
      requiresProposal: false,
      typicalProposalTypes: ["claim", "refactor"],
      emphasizeStatusReports: true,
    },
    hints: {
      systemHint:
        "You are acting in a project-management architect role. Focus on plans, status, and documentation, not implementing product features.",
    },
  },
  "development:default": {
    classification: "development",
    description: "Implement or modify code according to tasks and plans.",
    allowedTools: [
      "fs",
      "git",
      "mcp:guidance",
      "mcp:tests",
    ],
    contextBundles: [
      "planExcerpt",
      "relatedFiles",
      "discoveries",
      "decisions",
    ],
    governance: {
      requiresProposal: true,
      typicalProposalTypes: ["refactor", "breaking_change", "dependency"],
      emphasizeStatusReports: true,
    },
    hints: {
      systemHint:
        "You are working on a development task. Follow existing architecture, keep changes scoped, and surface proposals for risky refactors or breaking changes.",
    },
  },
  "qa:default": {
    classification: "qa",
    description: "Testing and verification work for existing or new behavior.",
    allowedTools: [
      "fs",
      "git",
      "mcp:tests",
    ],
    contextBundles: [
      "changedFiles",
      "testResults",
      "planExcerpt",
    ],
    governance: {
      requiresProposal: false,
      typicalProposalTypes: ["deploy"],
      emphasizeStatusReports: true,
    },
    hints: {
      systemHint:
        "You are acting in a QA role. Focus on tests, verification, and clear status reports about risk and coverage.",
    },
  },
  "documentation:default": {
    classification: "documentation",
    description: "Update feature and capability documentation to reflect current implementation.",
    allowedTools: [
      "fs",
      "git",
    ],
    contextBundles: [
      "changedFiles",
      "featureDocs",
      "planExcerpt",
    ],
    governance: {
      requiresProposal: false,
      emphasizeStatusReports: true,
    },
    hints: {
      systemHint:
        "You are updating documentation. Ensure docs match implementation and note future work where code is incomplete.",
    },
  },
};

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
  | "dependency_discovery"
  | "approval_request"
  | "approval_response"
  | "share_note"
  | "tool_discovery"
  | "status_update"
  | "heartbeat"
  | "human_message"
  | "doc_update"
  | "file_subscription"
  | "file_change"
  | "claim_transfer"
  | "dev_server_restart_request"
  | "context_compression"
  | "status_report"
  | "bug_report"
  | "bug_assignment";

// Discovery report from an arm
export interface Discovery {
  kind: "test_failure" | "unused_code" | "security_issue" | "performance" | "pattern" | "missing_context" | "ambiguous_requirement" | "potential_blocker" | "related_code" | "suggested_approach" | "other";
  title: string;
  details: string;
  file?: string;
  line?: number;
  severity?: "info" | "warning" | "error";
  /** Task ID this discovery is related to */
  taskId?: string;
  /** Phase when discovery was made: exploration (before changes) or implementation (during changes) */
  phase?: "exploration" | "implementation" | "verification";
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

// Context compression event for budget tracking
export interface ContextCompression {
  armId: string;
  taskId: string;
  originalTokens: number;
  compressedTokens: number;
  compressionRatio: number;
  removedContent: Array<{
    type: "history" | "artifacts" | "notes" | "tools" | "context";
    description: string;
    tokenCount: number;
  }>;
  workInProgress?: string;
  timestamp: string;
}

// Status report from arm during or after task execution
export type StatusReportStatus =
  | "on_track"
  | "blocked"
  | "issues_found"
  | "needs_review"
  | "completed_with_issues";

export interface StatusReport {
  id: string;
  taskId: string;
  armId: string;
  status: StatusReportStatus;
  summary: string;
  issues?: string[];
  blockers?: string[];
  nextSteps?: string;
  filesChanged?: string[];
  testsStatus?: "passing" | "failing" | "not_run";
  createdAt: string;
  updatedAt?: string;
  resolvedAt?: string;
  resolution?: string;
}

// Brain state
export interface BrainState {
  status: "stopped" | "running" | "paused";
  lastPollAt?: string;
  pollIntervalMs: number;
  activeArms: string[];
  pendingTasks: number;
  completedToday: number;
  startedAt?: string;
}

// Config file structure
export interface OctopaiConfig {
  version: number;
  octopaiDir: string;
  brain: {
    pollIntervalMs: number;
    maxArms: number;
    armGracePeriodMinutes: number;
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
// Note: octopaiDir is set dynamically by loadConfig() based on cwd or OCTOPAI_DIR env var
export const DEFAULT_CONFIG: OctopaiConfig = {
  version: 1,
  octopaiDir: ".octopai", // Placeholder - always overwritten by loadConfig()
  brain: {
    pollIntervalMs: 30000,
    maxArms: 8,
    armGracePeriodMinutes: 5,
  },
  mail: {
    fromAddress: "brain@octopai.local",
    digestSchedule: "immediate",
  },
  terminal: {
    emulator: "auto",
  },
  defaults: {
    harness: "opencode-api",
    provider: "opencode",
    model: "claude-sonnet-4",
    contextBudget: 100000,
  },
};

// Arm configuration file structure (from .octopai/arms/*.toml)
export interface ArmConfig {
  arm: {
    name: string;
    domain: string;
    harness: string;
  };
  context?: {
    budget?: number;
    priority_files?: string[];
  };
  personality?: {
    traits?: string;
  };
  convictions?: {
    core?: string[];
  };
  specializations?: string[];
  tools?: {
    requires_browser?: boolean;
  };
}

// Bug tracking
export interface Bug {
  id: string;
  title: string;
  description: string;
  source: "arm_reported" | "human_reported" | "system_detected";
  sourceArmId?: string;
  sourceTaskId?: string;
  status: "open" | "investigating" | "fixing" | "verifying" | "resolved" | "closed";
  priority: "low" | "medium" | "high" | "critical";
  assigneeArmId?: string;
  blockers: string[]; // Array of blocking task IDs
  errorDetails?: string; // JSON with stack traces, logs, etc.
  resolution?: string;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt?: Date;
  humanNotified: boolean;
}

// Summary of arm config for listing
export interface ArmConfigSummary {
  filename: string;
  name: string;
  domain: string;
  harness: string;
  budget?: number;
}

// Task comment/discussion
export interface TaskComment {
  id: string;
  taskId: string;
  parentId?: string;
  content: string;
  authorType: "human" | "arm" | "brain";
  authorId: string;
  authorName?: string;
  client: "web" | "mail" | "mcp" | "cli";
  edited: boolean;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
}
