/**
 * Bug Escalation Engine
 *
 * Detects when bugs block tasks and applies escalation policies
 * with automatic actions based on time blocked and bug priority.
 */

export interface EscalationRule {
	minHoursBlocked: number;
	maxBugPriority: "critical" | "high" | "medium" | "low";
	action: EscalationAction;
	notifyHuman: boolean;
}

export type EscalationAction =
	| "log"
	| "notify_human"
	| "auto_assign_bug"
	| "bump_priority"
	| "create_investigation_task";

export interface EscalationTier {
	level: number;
	name: string;
	minMinutesBlocked: number;
	action: EscalationAction;
	notifyHuman: boolean;
}

/**
 * Default escalation tiers for blocked tasks
 * Escalation increases as task remains blocked
 */
export const DEFAULT_ESCALATION_TIERS: EscalationTier[] = [
	{
		level: 0,
		name: "notice",
		minMinutesBlocked: 0,
		action: "log",
		notifyHuman: false,
	},
	{
		level: 1,
		name: "warning",
		minMinutesBlocked: 15,
		action: "notify_human",
		notifyHuman: true,
	},
	{
		level: 2,
		name: "urgent",
		minMinutesBlocked: 60,
		action: "auto_assign_bug",
		notifyHuman: true,
	},
	{
		level: 3,
		name: "critical",
		minMinutesBlocked: 240,
		action: "bump_priority",
		notifyHuman: true,
	},
];

/**
 * Priority-based escalation thresholds (in hours)
 * Higher priority bugs escalate faster
 */
export const PRIORITY_ESCALATION_MULTIPLIERS: Record<string, number> = {
	critical: 0.25, // 15 min = 1 hour
	high: 0.5, // 30 min = 1 hour
	medium: 1.0, // 1 hour = 1 hour
	low: 2.0, // 2 hours = 1 hour
};

export interface BlockedTaskInfo {
	taskId: string;
	taskSubject: string;
	blockedAt: Date;
	blockingBugs: Array<{
		id: string;
		title: string;
		priority: string;
		status: string;
		assigneeArmId?: string;
	}>;
}

export interface EscalationResult {
	taskId: string;
	bugId: string;
	escalationLevel: number;
	action: EscalationAction;
	notifyHuman: boolean;
	minutesBlocked: number;
	reason: string;
}

/**
 * Calculate the current escalation tier for a blocked task
 */
export function calculateEscalationTier(
	blockedTask: BlockedTaskInfo,
	tiers: EscalationTier[] = DEFAULT_ESCALATION_TIERS,
): EscalationTier | null {
	const now = Date.now();
	const blockedAt = blockedTask.blockedAt.getTime();
	const minutesBlocked = (now - blockedAt) / 1000 / 60;

	// Get highest priority bug multiplier
	const highestPriorityBug = blockedTask.blockingBugs.length > 0
		? blockedTask.blockingBugs.reduce((highest: NonNullable<typeof blockedTask.blockingBugs[0]>, bug) => {
				const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
				return priorityOrder[bug.priority as keyof typeof priorityOrder] <
					priorityOrder[highest.priority as keyof typeof priorityOrder]
					? bug
					: highest;
			}, blockedTask.blockingBugs[0]!)
		: null;

	const multiplier =
		PRIORITY_ESCALATION_MULTIPLIERS[highestPriorityBug?.priority || "medium"] || 1.0;

	// Find the highest applicable tier
	let currentTier: EscalationTier | null = null;
	for (const tier of tiers) {
		const adjustedThreshold = tier.minMinutesBlocked * multiplier;
		if (minutesBlocked >= adjustedThreshold) {
			currentTier = tier;
		}
	}

	return currentTier;
}

/**
 * Evaluate all blocked tasks and determine which need escalation
 */
export function evaluateEscalations(
	blockedTasks: BlockedTaskInfo[],
	previousEscalations: Map<string, number>, // taskId:bugId -> escalationLevel
	tiers: EscalationTier[] = DEFAULT_ESCALATION_TIERS,
): EscalationResult[] {
	const results: EscalationResult[] = [];

	for (const task of blockedTasks) {
		for (const bug of task.blockingBugs) {
			const tier = calculateEscalationTier(task, tiers);
			if (!tier) continue;

			const previousLevel =
				previousEscalations.get(`${task.taskId}:${bug.id}`) ?? -1;
			if (tier.level <= previousLevel) continue; // Already escalated to this level

			const minutesBlocked = (Date.now() - task.blockedAt.getTime()) / 1000 / 60;

			results.push({
				taskId: task.taskId,
				bugId: bug.id,
				escalationLevel: tier.level,
				action: tier.action,
				notifyHuman: tier.notifyHuman,
				minutesBlocked: Math.round(minutesBlocked),
				reason: `Task blocked for ${Math.round(minutesBlocked)} minutes by ${bug.priority} priority bug "${bug.title}"`,
			});
		}
	}

	return results;
}

/**
 * Check if a bug should be auto-assigned based on escalation
 */
export function shouldAutoAssignBug(
	bug: { priority: string; status: string; assigneeArmId?: string },
	minutesBlocked: number,
): boolean {
	return (
		(bug.priority === "critical" || bug.priority === "high") &&
		bug.status === "open" &&
		!bug.assigneeArmId &&
		minutesBlocked >= 60
	);
}

/**
 * Check if a bug priority should be bumped
 */
export function shouldBumpPriority(
	bug: { priority: string; status: string },
	minutesBlocked: number,
): boolean {
	return (
		bug.priority !== "critical" &&
		bug.status !== "resolved" &&
		bug.status !== "closed" &&
		minutesBlocked >= 240
	);
}

/**
 * Get next priority level
 */
export function bumpPriority(
	current: string,
): "critical" | "high" | "medium" | "low" {
	const order = ["low", "medium", "high", "critical"];
	const idx = order.indexOf(current);
	return (order[Math.min(idx + 1, order.length - 1)] || "medium") as
		| "critical"
		| "high"
		| "medium"
		| "low";
}

/**
 * Format escalation for human notification
 */
export function formatEscalationMessage(result: EscalationResult): string {
	const actionLabels: Record<EscalationAction, string> = {
		log: "Logged for review",
		notify_human: "Human notified",
		auto_assign_bug: "Bug auto-assigned",
		bump_priority: "Bug priority bumped",
		create_investigation_task: "Investigation task created",
	};

	return `**Escalation Level ${result.escalationLevel}**: ${actionLabels[result.action]}\n${result.reason}\n\nMinutes blocked: ${result.minutesBlocked}`;
}
