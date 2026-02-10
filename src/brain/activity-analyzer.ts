/**
 * ArmActivityAnalyzer - Classifies arm states based on event windows
 *
 * Uses BrainEventWindow data to classify each arm as:
 * - productive: actively doing useful work
 * - idle: waiting for work
 * - waiting_permission: blocked on a permission request
 * - looping: stuck in a repetitive pattern
 * - silent: no events for an extended period
 * - error: encountered an error state
 * 
 * @module brain/activity-analyzer
 */

import type { ArmEventWindow } from "./event-window";
import type { EventData } from "../nats/jetstream";
import {
	type ArmActivityState,
	type ArmAnalysis,
	type AnalyzerConfig,
	DEFAULT_CONFIG,
	PRODUCTIVE_EVENT_TYPES,
	ACTIVE_EVENT_TYPES,
	ERROR_EVENT_TYPES,
	resolveLogFn,
	getLatestEvent,
	arraysEqual,
} from "./activity-types";

export {
	type ArmActivityState,
	type ArmAnalysis,
	type AnalyzerConfig,
	type StuckAnalysis,
} from "./activity-types";
export { StuckArmAnalyzer } from "./stuck-arm-analyzer";

/**
 * ArmActivityAnalyzer classifies arm states based on event windows
 */
export class ArmActivityAnalyzer {
	private config: AnalyzerConfig;
	private logFn: (msg: string) => void;

	// Track when arms were first seen (for grace period)
	private armFirstSeen: Map<string, Date> = new Map();

	// Track previous states for trend detection
	private previousStates: Map<string, ArmActivityState[]> = new Map();

	constructor(options?: {
		config?: Partial<AnalyzerConfig>;
		log?: (msg: string) => void;
	}) {
		this.config = { ...DEFAULT_CONFIG, ...options?.config };
		this.logFn = resolveLogFn(options?.log);
	}

	/**
	 * Analyze an arm's activity based on its event window
	 */
	analyze(window: ArmEventWindow): ArmAnalysis {
		const armId = window.armId;

		// Track first seen for grace period
		if (!this.armFirstSeen.has(armId)) {
			this.armFirstSeen.set(armId, new Date());
		}

		// Calculate basic metrics
		const metrics = this.calculateMetrics(window);

		// Check for unknown event types and log warnings
		const unknownEventTypes = window.unknownEventTypes;
		for (const eventType of unknownEventTypes) {
			this.logFn(
				`[Analyzer] Unknown event type "${eventType}" for arm ${armId}. ` +
					`Add classification to improve analysis accuracy.`,
			);
		}

		// Determine state through a priority-based decision tree
		const analysis = this.classifyState(window, metrics);

		// Track state history
		const history = this.previousStates.get(armId) || [];
		history.push(analysis.state);
		if (history.length > 10) history.shift();
		this.previousStates.set(armId, history);

		return {
			...analysis,
			armId,
			metrics,
			unknownEventTypes,
		};
	}

	/**
	 * Analyze multiple arms at once
	 */
	analyzeAll(windows: Map<string, ArmEventWindow>): Map<string, ArmAnalysis> {
		const results = new Map<string, ArmAnalysis>();

		for (const [armId, window] of windows) {
			results.set(armId, this.analyze(window));
		}

		return results;
	}

	/**
	 * Calculate metrics from an event window
	 */
	private calculateMetrics(window: ArmEventWindow): ArmAnalysis["metrics"] {
		const recentMessageCount =
			(window.byType.get("message.updated")?.length || 0) +
			(window.byType.get("message.part.updated")?.length || 0);

		const recentToolCount = window.events.filter(
			(e) =>
				e.type === "message.part.updated" &&
				(e.data as Record<string, unknown>)?.partType === "tool-invocation",
		).length;

		const recentFileEditCount = window.byType.get("file.edited")?.length || 0;

		return {
			eventCount: window.events.length,
			silentDurationMs: window.silentDurationMs,
			lastEventAt: window.lastEventAt,
			recentMessageCount,
			recentToolCount,
			recentFileEditCount,
		};
	}

	/**
	 * Classify the arm state based on event window and metrics
	 */
	private classifyState(
		window: ArmEventWindow,
		metrics: ArmAnalysis["metrics"],
	): Omit<ArmAnalysis, "armId" | "metrics" | "unknownEventTypes"> {
		const armId = window.armId;

		// Check 1: Is this a newly started arm in grace period?
		const firstSeen = this.armFirstSeen.get(armId);
		if (firstSeen) {
			const timeSinceFirstSeen = Date.now() - firstSeen.getTime();
			if (timeSinceFirstSeen < this.config.startupGracePeriodMs) {
				return {
					state: "starting",
					confidence: "high",
					reason: "Arm is in startup grace period",
					recommendedAction: "none",
				};
			}
		}

		// Check 2: Is the arm completely silent?
		if (
			window.events.length === 0 ||
			window.silentDurationMs > this.config.silentThresholdMs
		) {
			return {
				state: "silent",
				confidence: "high",
				reason: `No events for ${Math.round(window.silentDurationMs / 1000)}s`,
				recommendedAction: "prompt",
			};
		}

		// Check 3: Is there an error state?
		const hasError = window.events.some((e) => ERROR_EVENT_TYPES.has(e.type));
		if (hasError) {
			const errorEvent = window.events.find((e) =>
				ERROR_EVENT_TYPES.has(e.type),
			);
			return {
				state: "error",
				confidence: "high",
				reason: `Error event detected: ${errorEvent?.type}`,
				recommendedAction: "escalate",
			};
		}

		// Check 4: Is the arm waiting for permission?
		const permissionCheck = this.checkPendingPermission(window);
		if (permissionCheck.pending) {
			const waitingMs = permissionCheck.waitingMs || 0;
			const shouldEscalate = waitingMs > this.config.permissionEscalationMs;

			return {
				state: "waiting_permission",
				confidence: "high",
				reason: `Waiting for permission for ${Math.round(waitingMs / 1000)}s`,
				recommendedAction: shouldEscalate ? "escalate" : "none",
				pendingPermission: {
					requestedAt: permissionCheck.requestedAt!,
					action: permissionCheck.action || "unknown",
					context: permissionCheck.context,
				},
			};
		}

		// Check 5: Is the arm stuck in a loop?
		const loopCheck = this.detectLoop(window);
		if (loopCheck.detected && loopCheck.pattern && loopCheck.repetitions) {
			return {
				state: "looping",
				confidence: loopCheck.confidence,
				reason: `Detected ${loopCheck.repetitions} repetitions of pattern`,
				recommendedAction: loopCheck.repetitions > 6 ? "interrupt" : "prompt",
				loopPattern: {
					pattern: loopCheck.pattern,
					repetitions: loopCheck.repetitions,
				},
			};
		}

		// Check 6: Is the arm actively producing work?
		const productiveEvents = window.events.filter((e) =>
			PRODUCTIVE_EVENT_TYPES.has(e.type),
		);

		if (productiveEvents.length >= this.config.productiveEventThreshold) {
			return {
				state: "productive",
				confidence: "high",
				reason: `${productiveEvents.length} productive events in window`,
				recommendedAction: "none",
			};
		}

		// Check 7: Is the arm showing any activity at all?
		const activeEvents = window.events.filter(
			(e) =>
				ACTIVE_EVENT_TYPES.has(e.type) || PRODUCTIVE_EVENT_TYPES.has(e.type),
		);

		if (activeEvents.length > 0) {
			return {
				state: "productive",
				confidence: "medium",
				reason: `${activeEvents.length} active events (processing)`,
				recommendedAction: "none",
			};
		}

		// Default: Idle
		return {
			state: "idle",
			confidence: "medium",
			reason: "No productive activity detected",
			recommendedAction: "prompt",
		};
	}

	/**
	 * Check for pending permission requests
	 */
	private checkPendingPermission(window: ArmEventWindow): {
		pending: boolean;
		requestedAt?: Date;
		waitingMs?: number;
		action?: string;
		context?: string;
	} {
		const askedEvents = window.byType.get("permission.asked") || [];
		const repliedEvents = window.byType.get("permission.replied") || [];

		if (askedEvents.length === 0) {
			return { pending: false };
		}

		// Get the most recent of each
		const latestAsked = getLatestEvent(askedEvents);
		const latestReplied = getLatestEvent(repliedEvents);

		if (!latestAsked) {
			return { pending: false };
		}

		const askedTime = new Date(latestAsked.timestamp);

		// If no reply or reply is older than ask, permission is pending
		if (!latestReplied || new Date(latestReplied.timestamp) < askedTime) {
			const data = latestAsked.data as Record<string, unknown>;
			return {
				pending: true,
				requestedAt: askedTime,
				waitingMs: Date.now() - askedTime.getTime(),
				action: (data.action as string) || (data.tool as string) || "unknown",
				context: data.context as string | undefined,
			};
		}

		return { pending: false };
	}

	/**
	 * Detect stuck loops in event patterns
	 */
	private detectLoop(window: ArmEventWindow): {
		detected: boolean;
		confidence: "high" | "medium" | "low";
		pattern?: string[];
		repetitions?: number;
	} {
		if (window.events.length < this.config.loopRepetitionThreshold * 2) {
			return { detected: false, confidence: "low" };
		}

		// Look at recent event types
		const recentTypes = window.events
			.slice(-30)
			.map((e) => e.type)
			.filter((x) => x !== "lsp-client-diagnostics");

		// Try to find repeating patterns of length 1-5
		for (let patternLength = 1; patternLength <= 5; patternLength++) {
			if (
				recentTypes.length <
				patternLength * this.config.loopRepetitionThreshold
			) {
				continue;
			}

			const pattern = recentTypes.slice(-patternLength);
			let repetitions = 0;

			for (
				let i = recentTypes.length - patternLength;
				i >= 0;
				i -= patternLength
			) {
				const slice = recentTypes.slice(i, i + patternLength);
				if (arraysEqual(slice, pattern)) {
					repetitions++;
				} else {
					break;
				}
			}

			if (repetitions >= this.config.loopRepetitionThreshold) {
				const confidence =
					repetitions >= 6 ? "high" : repetitions >= 4 ? "medium" : "low";
				return {
					detected: true,
					confidence,
					pattern,
					repetitions,
				};
			}
		}

		return { detected: false, confidence: "low" };
	}

	/**
	 * Get trend for an arm based on state history
	 */
	getStateTrend(armId: string): {
		improving: boolean;
		degrading: boolean;
		stable: boolean;
		history: ArmActivityState[];
	} {
		const history = this.previousStates.get(armId) || [];

		if (history.length < 3) {
			return { improving: false, degrading: false, stable: true, history };
		}

		// Simple trend: compare first half to second half
		const midpoint = Math.floor(history.length / 2);
		const firstHalf = history.slice(0, midpoint);
		const secondHalf = history.slice(midpoint);

		const stateScore = (state: ArmActivityState): number => {
			switch (state) {
				case "productive":
					return 3;
				case "idle":
					return 2;
				case "starting":
					return 2;
				case "waiting_permission":
					return 1;
				case "looping":
					return 0;
				case "silent":
					return -1;
				case "error":
					return -2;
			}
		};

		const avgFirst =
			firstHalf.reduce((sum, s) => sum + stateScore(s), 0) / firstHalf.length;
		const avgSecond =
			secondHalf.reduce((sum, s) => sum + stateScore(s), 0) / secondHalf.length;

		const improving = avgSecond > avgFirst + 0.5;
		const degrading = avgSecond < avgFirst - 0.5;

		return {
			improving,
			degrading,
			stable: !improving && !degrading,
			history,
		};
	}

	/**
	 * Reset tracking state for an arm
	 */
	resetArm(armId: string): void {
		this.armFirstSeen.delete(armId);
		this.previousStates.delete(armId);
	}

	/**
	 * Update configuration
	 */
	updateConfig(config: Partial<AnalyzerConfig>): void {
		this.config = { ...this.config, ...config };
	}

	/**
	 * Get current configuration
	 */
	getConfig(): AnalyzerConfig {
		return { ...this.config };
	}
}

// Export default instance
export const armActivityAnalyzer = new ArmActivityAnalyzer();
