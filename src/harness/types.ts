/**
 * Harness Types
 * 
 * Types for the agent harness system that controls AI agents via PTY.
 */

import type { IPty } from "bun-pty";

/**
 * Capabilities that a harness may support
 */
export interface HarnessCapabilities {
  mcp: boolean;              // Supports MCP protocol
  streaming: boolean;        // Can stream responses
  interrupt: boolean;        // Can interrupt mid-response
  compact: boolean;          // Can compact/summarize context
  multiTurn: boolean;        // Maintains conversation context
  fileEditing: boolean;      // Can edit files directly
  commandExecution: boolean; // Can run shell commands
}

/**
 * Configuration for spawning an agent
 */
export interface SpawnConfig {
  workdir: string;
  env: Record<string, string>;
  headless: boolean;
  mcpServers?: string[];
  /** Provider for the AI model */
  provider?: string;
  /** Model name */
  model?: string;
}

/**
 * State of an agent
 */
export type AgentState =
  | "initializing"    // Starting up
  | "idle"            // Waiting for input
  | "processing"      // Thinking/generating
  | "executing"       // Running tools/commands
  | "waiting_approval" // Asking user for confirmation
  | "error"
  | "dead";

/**
 * A PTY session for terminal interaction
 */
export interface PTYSession {
  pty: IPty;
  buffer: string;            // Accumulated output
  lineBuffer: string[];      // Line-by-line history
  lastActivity: Date;
  onData?: (data: string) => void;
  onExit?: (code: number) => void;
}

/**
 * A harness session - combines harness reference with PTY session
 */
export interface HarnessSession {
  id: string;
  pty: PTYSession;
  harnessName: string;
  spawnedAt: Date;
  lastHeartbeat: Date;
}

/**
 * Options for sending a prompt to an agent
 */
export interface SendPromptOptions {
  /** Send escape key twice before the prompt to interrupt/cancel current work */
  interrupt?: boolean;
  /** Override the model to use for this prompt */
  model?: string;
}

/**
 * Interface that all harnesses must implement
 */
export interface AgentHarness {
  // Metadata
  name: string;
  version: string;
  capabilities: HarnessCapabilities;

  // Lifecycle
  spawn(config: SpawnConfig): Promise<HarnessSession>;
  kill(session: HarnessSession): Promise<void>;

  // Communication
  sendPrompt(session: HarnessSession, prompt: string, options?: SendPromptOptions): Promise<void>;
  waitForResponse(session: HarnessSession, timeout?: number): Promise<string>;
  waitForIdle(session: HarnessSession, timeout?: number): Promise<void>;

  // State detection
  getState(session: HarnessSession): Promise<AgentState>;
  isProcessing(session: HarnessSession): Promise<boolean>;

  // Special actions
  interrupt(session: HarnessSession): Promise<void>;
  compact?(session: HarnessSession): Promise<void>;
  getPid?(session: HarnessSession): number;
  
  /**
   * Reset the session by creating a new OpenCode session.
   * This clears the conversation context, removing any stale task references.
   * Called by the brain after an arm completes a task and needs a fresh context
   * for the next task.
   * 
   * @returns The new session ID, or undefined if reset is not supported
   */
  resetSession?(session: HarnessSession): Promise<string | undefined>;

  // MCP (if supported)
  hasMCP(): boolean;
  getMCPEndpoint?(session: HarnessSession): string;
}

/**
 * UI patterns for detecting agent state from terminal output
 */
export interface UIPatterns {
  prompt: RegExp;            // Input prompt (indicates idle)
  thinking: RegExp;          // Processing indicator
  approval: RegExp;          // Confirmation request
  error: RegExp;             // Error message
  success: RegExp;           // Success message
}

/**
 * Terminal key sequences
 */
export const KEY_SEQUENCES = {
  ENTER: "\r",  // Carriage return
  TAB: "\t",
  ESCAPE: "\x1b",
  CTRL_C: "\x03",
  CTRL_D: "\x04",
  CTRL_L: "\x0c",
  CTRL_Z: "\x1a",
  UP: "\x1b[A",
  DOWN: "\x1b[B",
  RIGHT: "\x1b[C",
  LEFT: "\x1b[D",
  BACKSPACE: "\x7f",
} as const;

export type TerminalKey = keyof typeof KEY_SEQUENCES;
