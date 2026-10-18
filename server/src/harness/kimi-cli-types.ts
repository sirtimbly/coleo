/**
 * Kimi CLI Harness Types and Constants
 * 
 * Shared types, interfaces, and constants for the Kimi CLI harness.
 */

import type {
	HarnessSession,
	UIPatterns,
} from "./types";

// Import shared callback types
import type { ArmEventCallback } from "./opencode-api";
import type { ArmDeathCallback } from "./opencode-tui";

/**
 * UI patterns for detecting Kimi CLI state
 * These patterns are based on Kimi CLI's TUI output
 */
export const KIMI_CLI_PATTERNS: UIPatterns = {
	// Kimi shows input prompt when ready (typically ">" or similar)
	// The prompt appears after the model name and context indicators
	prompt: /(^>[\s]*$|Input:|❯|➜|kimi>[\s]*$)/m,

	// Processing/thinking indicators
	thinking:
		/(Thinking|thinking|Processing|processing|Generating|generating|█|▌|▀|▄|Loading|loading|\.\.\.)/i,

	// Approval/confirmation prompts
	approval:
		/\[Y\/n\]|\[y\/N\]|\(yes\/no\)|Do you want to|Proceed\?|Allow\?|Confirm\?/i,

	// Error indicators
	error: /(^Error:|^Failed:|^Exception:|error:|failed:|Traceback)/im,

	// Success indicators
	success: /(^Done|^Completed|successfully|Finished)/im,
};

/**
 * Extended harness session for Kimi CLI
 */
export interface KimiCliHarnessSession extends HarnessSession {
	armId: string;
	workdir: string;
	provider?: string;
	model?: string;
	eventCallbacks?: Set<ArmEventCallback>;
	consecutiveFailures: number;
	healthCheckInterval?: ReturnType<typeof setInterval>;
}

/**
 * Health check configuration
 */
export const HEALTH_CHECK_CONFIG = {
	/** How often to check session health (ms) */
	intervalMs: 5000,
	/** Maximum consecutive failures before marking as dead */
	maxFailures: 3,
} as const;

/**
 * Event types that can be emitted by the Kimi CLI harness
 */
export const KIMI_EVENT_TYPES = {
	PERMISSION_ASKED: "permission.asked",
	PERMISSION_REPLIED: "permission.replied",
	SESSION_ERROR: "session.error",
	PROCESS_DIED: "process.died",
	SPAWNED: "spawned",
	STOPPED: "stopped",
	TASK_STARTED: "task_started",
	TASK_COMPLETED: "task_completed",
	INTERRUPTED: "interrupted",
	SESSION_COMPACTED: "session.compacted",
	SESSION_RESET: "session.reset",
} as const;

/**
 * Type for event callback functions
 */
export type EventCallback = (armId: string, event: string, data: unknown) => void;

/**
 * Type for death callback functions
 */
export type DeathCallback = (armId: string, reason: string) => void;
