/**
 * Harness Contracts
 * 
 * Shared interfaces that define the contract between harnesses and the brain.
 * These types ensure type safety when:
 * 1. Brain reads arm state from harnesses
 * 2. Brain sends events to arms
 * 3. Arms send events back to brain
 * 4. Tests verify harness behavior
 */

// ============================================================================
// Harness State Contract
// ============================================================================

/**
 * The state reported by a harness to the brain.
 * This is what the brain uses to determine arm status.
 */
export type HarnessReportedState =
  | "initializing"    // Starting up, not yet ready
  | "idle"            // Ready and waiting for work
  | "processing"      // Actively working on a response
  | "executing"       // Running a tool/command
  | "waiting_approval" // Waiting for human approval
  | "error"           // In an error state
  | "dead";           // Process no longer running

/**
 * Full state information from a harness.
 * Used by brain to make scheduling decisions.
 */
export interface HarnessStateInfo {
  /** Current state of the harness */
  state: HarnessReportedState;
  
  /** Whether the harness has an active session */
  hasSession: boolean;
  
  /** Session ID if available */
  sessionId?: string;
  
  /** Last heartbeat timestamp (ISO string) */
  lastHeartbeat?: string;
  
  /** Current task being worked on, if any */
  currentTask?: string;
  
  /** Whether the harness is healthy */
  healthy: boolean;
  
  /** Error message if in error state */
  error?: string;
  
  /** Version of the underlying agent (e.g., OpenCode version) */
  version?: string;
  
  /** Port the agent server is running on */
  port?: number;
}

// ============================================================================
// Arm Events (Harness -> Brain)
// ============================================================================

/**
 * Events that harnesses emit and the brain listens to.
 * These are broadcast via NATS or the event stream.
 */
export type ArmEventType =
  // Lifecycle events
  | "spawned"              // Arm process started
  | "ready"                // Arm is ready to accept work
  | "stopped"              // Arm process stopped
  | "died"                 // Arm process died unexpectedly
  | "recovered"            // Arm reconnected after disconnect
  
  // Status events
  | "status_changed"       // Arm status changed (idle/busy/etc)
  | "heartbeat"            // Periodic heartbeat
  | "health_check_failed"  // Health check failed
  
  // Task events
  | "task_started"         // Started working on a task
  | "task_progress"        // Progress update on a task
  | "task_completed"       // Finished a task
  | "task_failed"          // Task failed
  | "task_blocked"         // Task is blocked on something
  
  // Session events (from OpenCode SSE)
  | "session.created"      // New session created
  | "session.updated"      // Session state changed (includes title, summary updates)
  | "session.deleted"      // Session deleted
  | "session.status"       // Session status changed (idle/busy/retry)
  | "session.idle"         // Session became idle
  | "session.compacted"    // Session was compacted
  | "session.diff"         // Session diff available
  | "session.error"        // Session error occurred
  
  // Message events (from OpenCode SSE)
  // Note: OpenCode uses "message.updated" for both new and updated messages
  | "message.updated"      // Message created or updated (streaming)
  | "message.removed"      // Message was removed
  | "message.part.updated" // Message part (text, tool, etc.) created or updated
  | "message.part.removed" // Message part was removed
  
  // Permission events (from OpenCode SSE)
  | "permission.asked"     // Permission request (user must approve/reject)
  | "permission.replied"   // Permission was responded to
  
  // Todo events (from OpenCode SSE)
  | "todo.updated"         // Todo list updated
  
  // File events (from OpenCode SSE)
  | "file.edited"          // File was edited
  | "file.watcher.updated" // File watcher detected change
  
  // Command events (from OpenCode SSE)
  | "command.executed"     // Slash command was executed
  
  // Server events (from OpenCode SSE)
  | "server.connected"     // SSE connection established (keepalive)
  | "server.instance.disposed"; // Server instance disposed

/**
 * Base event structure for arm events
 */
export interface ArmEvent {
  /** Type of the event */
  type: ArmEventType | string;  // string allows for extension
  
  /** ID of the arm that emitted this event */
  armId: string;
  
  /** Session ID if applicable */
  sessionId?: string;
  
  /** Timestamp when event was emitted */
  timestamp: string;
  
  /** Event-specific data */
  data: Record<string, unknown>;
}

// ============================================================================
// Specific Event Payloads
// ============================================================================

/**
 * Payload for spawned event
 */
export interface SpawnedEventData {
  pid: number;
  port?: number;
  harness: string;
  workdir: string;
  provider?: string;
  model?: string;
}

/**
 * Payload for status_changed event
 */
export interface StatusChangedEventData {
  previousStatus?: string;
  newStatus: string;
  reason?: string;
}

/**
 * Payload for task_started event
 */
export interface TaskStartedEventData {
  taskId: string;
  taskSubject: string;
}

/**
 * Payload for task_completed event
 */
export interface TaskCompletedEventData {
  taskId: string;
  summary?: string;
  artifacts?: string[];
  duration?: number;  // milliseconds
}

/**
 * Payload for task_failed event
 */
export interface TaskFailedEventData {
  taskId: string;
  error: string;
  recoverable?: boolean;
}

/**
 * Payload for heartbeat event
 */
export interface HeartbeatEventData {
  status: HarnessReportedState;
  sessionId?: string;
  currentTask?: string;
  uptimeSeconds?: number;
}

/**
 * Payload for message events
 */
export interface MessageEventData {
  messageId: string;
  role: "user" | "assistant" | "system";
  content?: string;
  parts?: Array<{
    type: string;
    content?: string;
    toolName?: string;
    toolId?: string;
  }>;
}

/**
 * Payload for part events (tool invocations)
 */
export interface PartEventData {
  partId: string;
  messageId: string;
  type: "text" | "tool-invocation" | "tool-result" | "step";
  toolName?: string;
  toolId?: string;
  status?: "pending" | "running" | "completed" | "error";
  input?: unknown;
  output?: unknown;
}

// ============================================================================
// Brain -> Arm Messages
// ============================================================================

/**
 * Types of messages the brain can send to arms
 */
export type BrainToArmMessageType =
  | "task_assignment"      // Assign a new task to the arm
  | "interrupt"            // Interrupt current work
  | "compact"              // Compact/summarize context
  | "prompt"               // Send a prompt/instruction
  | "status_request"       // Request current status
  | "shutdown";            // Request graceful shutdown

/**
 * Message from brain to an arm
 */
export interface BrainToArmMessage {
  type: BrainToArmMessageType;
  armId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

// ============================================================================
// Harness Capability Contract
// ============================================================================

/**
 * Capabilities that a harness must declare.
 * Brain uses these to decide what operations are supported.
 */
export interface HarnessCapabilityContract {
  /** Harness identifier (e.g., "opencode-tui", "opencode-api") */
  name: string;
  
  /** Version of the harness implementation */
  version: string;
  
  /** Supported capabilities */
  capabilities: {
    /** Can report state via API */
    stateReporting: boolean;
    
    /** Can stream events via SSE */
    eventStreaming: boolean;
    
    /** Can accept prompts programmatically */
    promptAccept: boolean;
    
    /** Can be interrupted mid-work */
    interruptible: boolean;
    
    /** Can compact context on demand */
    compactable: boolean;
    
    /** Has MCP support */
    mcp: boolean;
    
    /** Can execute shell commands */
    shellExecution: boolean;
    
    /** Can edit files directly */
    fileEditing: boolean;
    
    /** Maintains conversation history */
    multiTurn: boolean;
  };
  
  /** State transition map - what states can transition to what */
  stateTransitions: {
    [K in HarnessReportedState]?: HarnessReportedState[];
  };
}

// ============================================================================
// Test Expectations
// ============================================================================

/**
 * Expected event for test assertions
 */
export interface ExpectedEvent {
  /** Expected event type */
  type: ArmEventType | string;
  
  /** Expected properties (partial match) */
  properties?: Record<string, unknown>;
  
  /** Timeout to wait for this event (ms) */
  timeout?: number;
  
  /** Whether this event is optional */
  optional?: boolean;
}

/**
 * Expected state for test assertions
 */
export interface ExpectedState {
  /** Expected harness state */
  state: HarnessReportedState;
  
  /** Expected session existence */
  hasSession?: boolean;
  
  /** Expected health status */
  healthy?: boolean;
  
  /** Additional properties to check */
  properties?: Record<string, unknown>;
}

/**
 * Test scenario definition
 */
export interface HarnessTestScenario {
  /** Name of the test scenario */
  name: string;
  
  /** Description of what is being tested */
  description: string;
  
  /** Harness types this test applies to */
  harnesses: string[];
  
  /** Steps to execute */
  steps: Array<{
    /** Action to perform */
    action: "spawn" | "prompt" | "prompt_and_wait" | "wait" | "wait_for_processing" | "wait_for_idle" | "interrupt" | "compact" | "kill" | "check_state" | "wait_for_event" | "wait_for_control" | "respond_to_control" | "respond_to_permission";
    
    /** Action-specific parameters */
    params?: Record<string, unknown>;
    
    /** Expected events after this action */
    expectedEvents?: ExpectedEvent[];
    
    /** Expected state after this action */
    expectedState?: ExpectedState;
  }>;
}

// ============================================================================
// Default Harness Capabilities
// ============================================================================

/**
 * Default capability declaration for opencode-tui harness
 */
export const OPENCODE_TUI_CAPABILITIES: HarnessCapabilityContract = {
  name: "opencode-tui",
  version: "1.0.0",
  capabilities: {
    stateReporting: true,
    eventStreaming: true,
    promptAccept: true,
    interruptible: true,
    compactable: true,
    mcp: true,
    shellExecution: true,
    fileEditing: true,
    multiTurn: true,
  },
  stateTransitions: {
    initializing: ["idle", "error", "dead"],
    idle: ["processing", "error", "dead"],
    processing: ["idle", "executing", "waiting_approval", "error", "dead"],
    executing: ["processing", "idle", "error", "dead"],
    waiting_approval: ["processing", "idle", "error", "dead"],
    error: ["idle", "dead"],
    dead: [],  // Terminal state
  },
};

/**
 * Default capability declaration for opencode-api harness
 */
export const OPENCODE_API_CAPABILITIES: HarnessCapabilityContract = {
  name: "opencode-api",
  version: "1.0.0",
  capabilities: {
    stateReporting: true,
    eventStreaming: true,
    promptAccept: true,
    interruptible: true,
    compactable: true,
    mcp: true,
    shellExecution: true,
    fileEditing: true,
    multiTurn: true,
  },
  stateTransitions: {
    initializing: ["idle", "error", "dead"],
    idle: ["processing", "error", "dead"],
    processing: ["idle", "executing", "waiting_approval", "error", "dead"],
    executing: ["processing", "idle", "error", "dead"],
    waiting_approval: ["processing", "idle", "error", "dead"],
    error: ["idle", "dead"],
    dead: [],
  },
};
