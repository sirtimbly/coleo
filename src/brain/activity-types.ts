/**
 * Activity Analyzer Types and Constants
 * 
 * Shared types, interfaces, and constants used by ArmActivityAnalyzer
 * and StuckArmAnalyzer.
 */

import type { EventData } from "../nats/jetstream";

/**
 * Classification of arm activity state
 */
export type ArmActivityState =
	| "productive"
	| "idle"
	| "waiting_permission"
	| "looping"
	| "silent"
	| "error"
	| "starting";

/**
 * Detailed analysis result for an arm
 */
export interface ArmAnalysis {
	armId: string;
	state: ArmActivityState;
	confidence: "high" | "medium" | "low";
	reason: string;

	/** Metrics used in the analysis */
	metrics: {
		eventCount: number;
		silentDurationMs: number;
		lastEventAt: Date | null;
		recentMessageCount: number;
		recentToolCount: number;
		recentFileEditCount: number;
	};

	/** If waiting for permission, details about the request */
	pendingPermission?: {
		requestedAt: Date;
		action: string;
		context?: string;
	};

	/** If looping, details about the pattern */
	loopPattern?: {
		pattern: string[];
		repetitions: number;
	};

	/** Recommended action for the brain */
	recommendedAction?: "none" | "prompt" | "interrupt" | "kill" | "escalate";

	/** Unknown event types encountered */
	unknownEventTypes: string[];
}

/**
 * Configuration for the analyzer
 */
export interface AnalyzerConfig {
	/** How long without events before arm is considered silent (ms) */
	silentThresholdMs: number;

	/** Minimum events to consider arm productive */
	productiveEventThreshold: number;

	/** How many repetitions before considering arm looping */
	loopRepetitionThreshold: number;

	/** How long to wait before escalating permission requests (ms) */
	permissionEscalationMs: number;

	/** Grace period for newly started arms (ms) */
	startupGracePeriodMs: number;
}

/**
 * Default analyzer configuration
 */
export const DEFAULT_CONFIG: AnalyzerConfig = {
	silentThresholdMs: 5 * 60 * 1000, // 5 minutes
	productiveEventThreshold: 3,
	loopRepetitionThreshold: 4,
	permissionEscalationMs: 2 * 60 * 1000, // 2 minutes
	startupGracePeriodMs: 60 * 1000, // 1 minute
};

/**
 * Stuck Arm Analysis Result
 */
export interface StuckAnalysis {
	isStuck: boolean;
	stuckType?:
		| "asking_question"
		| "waiting_approval"
		| "looping"
		| "error"
		| "idle_too_long"
		| "silent_completion"
		| "unknown";
	reasoning: string;
	suggestedAction?:
		| "answer"
		| "approve"
		| "restart"
		| "compact"
		| "escalate"
		| "prompt"
		| "prompt_complete_task";
	suggestedResponse?: string;
	confidence: number; // 0-1
	/** If stuckType is "silent_completion", details about the completion */
	silentCompletion?: {
		taskId: string;
		filesChanged: string[];
		testsStatus?: "passing" | "failing" | "not_run";
		isReadyForCompletion: boolean;
	};
}

/**
 * Event types that indicate productive work
 */
export const PRODUCTIVE_EVENT_TYPES = new Set([
	"file.edited",
	"message.updated",
	"command.executed",
	"todo.updated",
	"task.claimed",
	"task.completed",
	"session.diff",
]);

/**
 * Event types that indicate the arm is actively working (but may not have output yet)
 */
export const ACTIVE_EVENT_TYPES = new Set([
	"session.status",
	"session.updated",
	"message.part.updated",
	"arm.heartbeat",
	"file.read",
	"file.reads",
]);

/**
 * Event types that indicate errors
 */
export const ERROR_EVENT_TYPES = new Set(["session.error", "task.failed"]);

/**
 * Helper function to resolve logger
 */
export const resolveLogFn = (log?: (msg: string) => void): ((msg: string) => void) =>
	log ?? console.log;

/**
 * Get the latest event from an array
 */
export function getLatestEvent(events: EventData[]): EventData | null {
	if (events.length === 0) return null;

	let latest = events[0]!;
	for (const event of events) {
		if (new Date(event.timestamp) > new Date(latest.timestamp)) {
			latest = event;
		}
	}
	return latest;
}

/**
 * Check if two arrays are equal
 */
export function arraysEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}
