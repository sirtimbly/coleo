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

const ACTIVE_ARM_STATUSES = new Set([
	"busy",
	"running",
	"starting",
	"processing",
	"executing",
	"working",
	"in_progress",
]);
const PASSIVE_TELEMETRY_EVENT_TYPES = new Set([
	"arm.heartbeat",
	"server-heartbeat",
	"server.heartbeat",
]);

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
		const currentWindow = this.scopeToLatestLifecycle(window);

		// Calculate basic metrics
		const metrics = this.calculateMetrics(currentWindow);

		// Check for unknown event types and log warnings
		const unknownEventTypes = window.unknownEventTypes;
		for (const eventType of unknownEventTypes) {
			this.logFn(
				`[Analyzer] Unknown event type "${eventType}" for arm ${armId}. ` +
					`Add classification to improve analysis accuracy.`,
			);
		}

		// Determine state through a priority-based decision tree
		const analysis = this.classifyState(currentWindow, metrics);

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
		const activityEvents = window.events.filter(
			(event) => !PASSIVE_TELEMETRY_EVENT_TYPES.has(event.type),
		);
		const recentMessageCount =
			activityEvents.filter(
				(event) => event.type === "message.updated" || event.type === "message.part.updated",
			).length;

		const recentToolCount = activityEvents.filter(
			(e) => {
				if (e.type !== "message.part.updated") return false;
				const data = e.data as Record<string, unknown>;
				const part = data.part;
				const partType =
					typeof data.partType === "string"
						? data.partType
						: part && typeof part === "object"
							? (part as Record<string, unknown>).type
							: null;
				return partType === "tool" || partType === "tool-invocation";
			},
		).length;

		const recentFileEditCount = activityEvents.filter(
			(event) => event.type === "file.edited",
		).length;
		const lastActivityEvent = activityEvents.reduce<EventData | null>((latest, event) => {
			if (!latest) return event;
			return new Date(event.timestamp) > new Date(latest.timestamp) ? event : latest;
		}, null);
		const lastEventAt = lastActivityEvent ? new Date(lastActivityEvent.timestamp) : null;

		return {
			eventCount: activityEvents.length,
			silentDurationMs: lastEventAt ? Date.now() - lastEventAt.getTime() : Infinity,
			lastEventAt,
			recentMessageCount,
			recentToolCount,
			recentFileEditCount,
		};
	}

	private getLifecycleStatus(event: EventData): string | null {
		if (event.type === "arm.spawned") return "starting";
		if (event.type === "session.idle") return "idle";
		if (event.type === "session.error") return "error";
		if (event.type === "arm.killed" || event.type === "arm.stopped") return "stopped";
		if (
			event.type !== "session.status" &&
			event.type !== "session.updated" &&
			event.type !== "status_changed" &&
			event.type !== "arm.status_changed" &&
			event.type !== "arm_status_synced"
		) {
			return null;
		}

		const data = event.data as Record<string, unknown>;
		const rawStatus = data.newStatus ?? data.to ?? data.status;
		const status =
			rawStatus && typeof rawStatus === "object"
				? (rawStatus as Record<string, unknown>).type
				: rawStatus;
		return typeof status === "string" ? status.toLowerCase() : null;
	}

	private getLatestLifecycleEvent(window: ArmEventWindow): EventData | null {
		return window.events.reduce<EventData | null>((latest, event) => {
			if (!this.getLifecycleStatus(event)) return latest;
			if (!latest) return event;
			return new Date(event.timestamp) >= new Date(latest.timestamp) ? event : latest;
		}, null);
	}

	private scopeToLatestLifecycle(window: ArmEventWindow): ArmEventWindow {
		const latestLifecycle = this.getLatestLifecycleEvent(window);
		if (!latestLifecycle) return window;

		const cutoff = new Date(latestLifecycle.timestamp).getTime();
		const events = window.events.filter(
			(event) => new Date(event.timestamp).getTime() >= cutoff,
		);
		const byType = new Map<string, EventData[]>();
		const latestByType = new Map<string, EventData>();
		let lastEventAt: Date | null = null;

		for (const event of events) {
			const grouped = byType.get(event.type) ?? [];
			grouped.push(event);
			byType.set(event.type, grouped);
			const existing = latestByType.get(event.type);
			if (!existing || new Date(event.timestamp) >= new Date(existing.timestamp)) {
				latestByType.set(event.type, event);
			}
			const eventAt = new Date(event.timestamp);
			if (!lastEventAt || eventAt > lastEventAt) lastEventAt = eventAt;
		}

		return {
			...window,
			events,
			byType,
			latestByType,
			lastEventAt,
			silentDurationMs: lastEventAt ? Date.now() - lastEventAt.getTime() : Infinity,
		};
	}

	/**
	 * Classify the arm state based on event window and metrics
	 */
	private classifyState(
		window: ArmEventWindow,
		metrics: ArmAnalysis["metrics"],
	): Omit<ArmAnalysis, "armId" | "metrics" | "unknownEventTypes"> {
		// Check 1: Is the latest lifecycle transition a recent startup?
		const latestLifecycle = this.getLatestLifecycleEvent(window);
		const lifecycleStatus = latestLifecycle
			? this.getLifecycleStatus(latestLifecycle)
			: null;
		if (latestLifecycle && lifecycleStatus === "starting") {
			const timeSinceStartup = Date.now() - new Date(latestLifecycle.timestamp).getTime();
			if (timeSinceStartup < this.config.startupGracePeriodMs) {
				return {
					state: "starting",
					confidence: "high",
					reason: "Arm is in startup grace period",
					recommendedAction: "none",
				};
			}
		}

		if (latestLifecycle && (lifecycleStatus === "idle" || lifecycleStatus === "stopped")) {
			const transitionAt = new Date(latestLifecycle.timestamp).getTime();
			const hasNewerActivity = window.events.some(
				(event) =>
					new Date(event.timestamp).getTime() > transitionAt &&
					!PASSIVE_TELEMETRY_EVENT_TYPES.has(event.type),
			);
			if (!hasNewerActivity) {
				return {
					state: "idle",
					confidence: "high",
					reason: `Latest lifecycle status is ${lifecycleStatus}`,
					recommendedAction: "none",
				};
			}
		}

		// Check 2: Is the arm completely silent?
		if (metrics.eventCount === 0) {
			return {
				state: "silent",
				confidence: "low",
				reason: "No event telemetry was received in the analysis window",
				recommendedAction: "none",
			};
		}

		if (metrics.silentDurationMs > this.config.silentThresholdMs) {
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
		const statusChangedActiveEvents = window.events.filter((e) =>
			this.isActiveStatusChangeEvent(e),
		);
		const activeEvents = window.events.filter(
			(e) =>
				(e.type === "session.status" || e.type === "session.updated"
					? this.isActiveStatusChangeEvent(e)
					: ACTIVE_EVENT_TYPES.has(e.type) || PRODUCTIVE_EVENT_TYPES.has(e.type)),
		);
		const totalActiveEvents =
			activeEvents.length + statusChangedActiveEvents.length;

		if (totalActiveEvents > 0) {
			return {
				state: "productive",
				confidence: "medium",
				reason: `${totalActiveEvents} active events (processing)`,
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

	private isActiveStatusChangeEvent(event: EventData): boolean {
		if (
			event.type !== "session.status" &&
			event.type !== "session.updated" &&
			event.type !== "status_changed" &&
			event.type !== "arm.status_changed" &&
			event.type !== "arm_status_synced"
		) {
			return false;
		}

		const nextStatus = this.getLifecycleStatus(event);

		if (!nextStatus) {
			return false;
		}

		return ACTIVE_ARM_STATUSES.has(nextStatus.toLowerCase());
	}

	/**
	 * Detect stuck loops in event patterns
	 *
	 * A "loop" is only a problem if the arm is not making productive progress.
	 * Productive work (file edits, task completions, etc.) breaks the loop.
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

		// Count productive events in the window - if there's productive work,
		// the arm is not "stuck" even if patterns repeat
		const productiveEventCount = window.events.filter((e) =>
			PRODUCTIVE_EVENT_TYPES.has(e.type),
		).length;

		// If arm has made productive progress, it's not looping
		// Productive work naturally involves repetitive thinking patterns
		if (productiveEventCount >= 2) {
			return { detected: false, confidence: "low" };
		}

		// Look at recent event types, filtering out benign diagnostic events
		const recentTypes = window.events
			.slice(-30)
			.map((e) => e.type)
			.filter((x) =>
				!x.startsWith("lsp-") &&
				x !== "session.updated" &&
				x !== "arm.heartbeat" &&
				x !== "server-heartbeat" &&
				x !== "server.heartbeat"
			);

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
				// Require more repetitions for higher confidence
				// Also consider if there are ANY productive events at all
				const baseConfidence =
					repetitions >= 8 ? "high" : repetitions >= 6 ? "medium" : "low";

				// If there are some productive events (but less than 2), reduce confidence
				const confidence = productiveEventCount > 0
					? (baseConfidence === "high" ? "medium" : "low")
					: baseConfidence;

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
