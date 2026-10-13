import type { Arm } from "../types";
import type { ApiClientOptions } from "./brain-api-client";

export interface StuckArmState {
	armId: string;
	stuckType: "no_progress" | "loop_detected" | "heartbeat_missing" | "unresponsive";
	detectedAt: Date;
	lastActivityAt: Date | null;
	escalationLevel: number;
	details: string;
}

export interface IdleArmTracker {
	promptCount: number;
	lastPromptAt: Date;
	lastProductiveAt: Date | null;
	escalationLevel: number;
}

export interface ArmHealthOptions extends ApiClientOptions {
	gracePeriodMs?: number;
	stuckThresholdMs?: number;
	maxPromptsBeforeStuck?: number;
}

export const DEFAULT_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes
export const DEFAULT_STUCK_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
export const DEFAULT_MAX_PROMPTS_BEFORE_STUCK = 3;

export function isArmInStartupGracePeriod(
	detectionTime: Date | undefined,
	gracePeriodMs = DEFAULT_GRACE_PERIOD_MS,
): boolean {
	if (!detectionTime) return false;
	return Date.now() - detectionTime.getTime() < gracePeriodMs;
}

export function checkArmStuckState(
	armId: string,
	lastActivityAt: Date | null,
	lastPromptAt: Date | null,
	promptCount: number,
	lastProductiveAt: Date | null,
	escalationLevel: number,
	options?: Partial<ArmHealthOptions>,
): StuckArmState | null {
	const gracePeriodMs = options?.gracePeriodMs || DEFAULT_GRACE_PERIOD_MS;
	const stuckThresholdMs = options?.stuckThresholdMs || DEFAULT_STUCK_THRESHOLD_MS;
	const maxPrompts = options?.maxPromptsBeforeStuck || DEFAULT_MAX_PROMPTS_BEFORE_STUCK;

	// Check if in grace period
	if (lastPromptAt && Date.now() - lastPromptAt.getTime() < gracePeriodMs) {
		return null;
	}

	// No activity ever
	if (lastActivityAt === null && promptCount >= maxPrompts) {
		return {
			armId,
			stuckType: "no_progress",
			detectedAt: new Date(),
			lastActivityAt: null,
			escalationLevel,
			details: `No productive activity after ${promptCount} prompts`,
		};
	}

	// No recent activity
	if (lastActivityAt) {
		const timeSinceActivity = Date.now() - lastActivityAt.getTime();
		if (timeSinceActivity > stuckThresholdMs && promptCount >= 2) {
			return {
				armId,
				stuckType: "no_progress",
				detectedAt: new Date(),
				lastActivityAt,
				escalationLevel,
				details: `No productive activity for ${Math.floor(timeSinceActivity / 60000)} minutes`,
			};
		}
	}

	// High prompt count without productivity
	if (lastProductiveAt === null && promptCount >= maxPrompts) {
		return {
			armId,
			stuckType: "loop_detected",
			detectedAt: new Date(),
			lastActivityAt: lastActivityAt,
			escalationLevel,
			details: `Loop detected: ${promptCount} prompts without productive response`,
		};
	}

	return null;
}

export function determineStuckAction(
	escalationLevel: number,
): "wait" | "interrupt" | "compact" | "kill" | "escalate_to_human" {
	if (escalationLevel === 0) return "interrupt";
	if (escalationLevel === 1) return "compact";
	if (escalationLevel === 2) return "kill";
	return "escalate_to_human";
}

export function shouldKillZombieArm(
	arm: Arm,
	lastHeartbeatAt: Date | null,
	lastActivityAt: Date | null,
	thresholdMs = 30 * 60 * 1000, // 30 minutes
): boolean {
	if (arm.status === "stopped" || arm.status === "error") {
		return false;
	}

	if (lastHeartbeatAt === null) {
		return true;
	}

	const timeSinceHeartbeat = Date.now() - lastHeartbeatAt.getTime();
	if (timeSinceHeartbeat > thresholdMs) {
		return true;
	}

	if (lastActivityAt) {
		const timeSinceActivity = Date.now() - lastActivityAt.getTime();
		if (timeSinceActivity > thresholdMs * 2) {
			return true;
		}
	}

	return false;
}

export function categorizeArmHealth(arm: Arm, stuckState: StuckArmState | null): string {
	if (arm.status === "error") return "error";
	if (arm.status === "stopped") return "stopped";
	if (stuckState) return "stuck";
	if (arm.status === "busy") return "busy";
	if (arm.status === "idle") return "idle";
	return "unknown";
}

export interface ArmActivitySignal {
	armId: string;
	timestamp: Date;
	type: "message" | "event" | "heartbeat" | "status_report";
}

export function getMostRecentActivitySignal(
	signals: ArmActivitySignal[],
): Date | null {
	if (signals.length === 0) return null;

	const sorted = [...signals].sort(
		(a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
	);

	return sorted[0]?.timestamp || null;
}

export function formatStuckArmReport(state: StuckArmState, armName: string): string {
	const timeSinceActivity = state.lastActivityAt
		? Math.floor((Date.now() - state.lastActivityAt.getTime()) / 60000)
		: "N/A";

	return `**Stuck Arm Alert: ${armName}**

- **Type**: ${state.stuckType}
- **Detected**: ${state.detectedAt.toISOString()}
- **Last Activity**: ${state.lastActivityAt?.toISOString() || "Never"}
- **Minutes Since Activity**: ${timeSinceActivity}
- **Escalation Level**: ${state.escalationLevel}
- **Details**: ${state.details}

**Recommended Action**: ${determineStuckAction(state.escalationLevel)}`;
}
