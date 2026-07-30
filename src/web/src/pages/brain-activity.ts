import { isJsonObject, type ActivityEntry, type JsonObject, type JsonValue } from "../lib/api";

export type BrainActivityCategory = "operations" | "tasks" | "arms" | "decisions" | "planning" | "alerts";
export type BrainActivityTone = "default" | "success" | "warning" | "danger" | "accent";

export interface BrainActivityItem extends ActivityEntry {
	category: BrainActivityCategory;
	tone: BrainActivityTone;
	title: string;
	summary: string;
}

export function parseBrainActivityEntry(value: JsonValue | undefined): ActivityEntry | null {
	if (!isJsonObject(value) || typeof value.id !== "string" || typeof value.timestamp !== "string") return null;
	if (typeof value.actor !== "string" || typeof value.action !== "string" || !isJsonObject(value.details)) return null;
	if (value.target !== null && typeof value.target !== "string") return null;
	if (value.sequence !== null && typeof value.sequence !== "number") return null;

	return {
		id: value.id,
		sequence: value.sequence,
		timestamp: value.timestamp,
		actor: value.actor,
		action: value.action,
		target: value.target,
		details: value.details,
	};
}

function stringDetail(details: JsonObject, key: string): string | null {
	return typeof details[key] === "string" ? details[key] : null;
}

function numberDetail(details: JsonObject, key: string): number | null {
	return typeof details[key] === "number" ? details[key] : null;
}

function booleanDetail(details: JsonObject, key: string): boolean | null {
	return typeof details[key] === "boolean" ? details[key] : null;
}

function humanize(value: string): string {
	return value.replaceAll("_", " ").replaceAll(".", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDuration(durationMs: number | null): string | null {
	if (durationMs === null) return null;
	if (durationMs < 1000) return `${durationMs}ms`;
	return `${(durationMs / 1000).toFixed(durationMs < 10000 ? 1 : 0)}s`;
}

function getCategory(action: string): BrainActivityCategory {
	if (action.includes("failed") || action.includes("alert") || action.includes("critical_bug")) return "alerts";
	if (action.startsWith("poll_") || ["started", "stopped", "paused", "resumed"].includes(action)) return "operations";
	if (action.startsWith("arm_") || action.startsWith("silent_completion") || action.startsWith("idle_arm")) return "arms";
	if (action.includes("review") || action.includes("validation") || action.includes("forward_decision")) return "decisions";
	if (action.includes("task") || action.includes("verification") || action.includes("commit")) return "tasks";
	return "planning";
}

function getTone(action: string, details: JsonObject): BrainActivityTone {
	if (action.includes("failed") || action === "poll_failed" || action === "infrastructure_alert") return "danger";
	if (action.includes("stuck") || action === "paused" || action === "poll_skipped") return "warning";
	if (action.includes("completed") || action.includes("approved") || action === "resumed") return "success";
	if (booleanDetail(details, "shouldForward") === true) return "accent";
	return "default";
}

function summarize(entry: ActivityEntry): { title: string; summary: string } {
	const details = entry.details;
	const target = entry.target || "";
	const subject = stringDetail(details, "subject");
	const armId = stringDetail(details, "armId");
	const duration = formatDuration(numberDetail(details, "durationMs"));

	switch (entry.action) {
		case "started":
			return { title: "Brain started", summary: `Polling every ${formatDuration(numberDetail(details, "pollIntervalMs")) || "configured interval"}` };
		case "stopped":
			return { title: "Brain stopped", summary: "Coordinator processing stopped" };
		case "paused":
			return { title: "Brain paused", summary: stringDetail(details, "reason") || `Paused for ${target}` };
		case "resumed":
			return { title: "Brain resumed", summary: stringDetail(details, "reason") || "Coordinator processing resumed" };
		case "poll_completed": {
			const pending = numberDetail(details, "pendingTasks") ?? 0;
			const arms = numberDetail(details, "activeArms") ?? 0;
			return { title: "Poll completed", summary: `${pending} pending tasks, ${arms} active arms${duration ? ` in ${duration}` : ""}` };
		}
		case "poll_skipped":
			return { title: "Poll skipped", summary: `${stringDetail(details, "reason") || "Coordinator unavailable"}${duration ? ` after ${duration}` : ""}` };
		case "poll_failed":
			return { title: "Poll failed", summary: stringDetail(details, "error") || "Unexpected coordinator error" };
		case "task_created":
			return { title: "Task created", summary: `${subject || target}${stringDetail(details, "priority") ? ` (${stringDetail(details, "priority")} priority)` : ""}` };
		case "task_completed":
			return { title: "Task completed", summary: subject || target };
		case "task_status_update":
			return { title: "Task status updated", summary: `${target} marked ${stringDetail(details, "status") || "updated"}${armId ? ` by ${armId}` : ""}` };
		case "arm_stuck_detected":
			return { title: "Arm appears stuck", summary: `${target}: ${stringDetail(details, "reasoning") || stringDetail(details, "stuckType") || "No progress detected"}` };
		case "arm_unstuck":
			return { title: "Arm recovery applied", summary: `${target}: ${humanize(stringDetail(details, "action") || "recovered")}` };
		case "arm_prompted":
			return { title: "Arm prompted", summary: `${target}${stringDetail(details, "reason") ? `: ${stringDetail(details, "reason")}` : ""}` };
		case "arm_killed":
		case "arm_zombie_killed":
			return { title: "Arm stopped", summary: `${target}${stringDetail(details, "reason") ? `: ${stringDetail(details, "reason")}` : ""}` };
		case "arm_output_action":
			return { title: "Arm output handled", summary: `${target}: ${humanize(stringDetail(details, "action") || "action taken")}` };
		case "status_report_received":
			return { title: "Status report received", summary: `${armId || "Arm"} reported ${stringDetail(details, "status") || "an update"} for ${target}` };
		case "status_report_forward_decision": {
			const forwarded = booleanDetail(details, "shouldForward");
			return { title: forwarded ? "Status report forwarded" : "Status report held", summary: stringDetail(details, "reason") || target };
		}
		case "tasks_synced":
			return { title: "Plan tasks synchronized", summary: `${numberDetail(details, "newTasks") ?? 0} created, ${numberDetail(details, "updated") ?? 0} updated` };
		case "inbox_processed":
			return { title: "Project inbox processed", summary: `${numberDetail(details, "tasksCreated") ?? numberDetail(details, "created") ?? 0} tasks created` };
		case "infrastructure_alert": {
			const issues = Array.isArray(details.issues) ? details.issues.map(String).join(", ") : "Infrastructure health degraded";
			return { title: "Infrastructure alert", summary: issues };
		}
		default:
			return {
				title: humanize(entry.action),
				summary: subject || target || stringDetail(details, "reason") || stringDetail(details, "message") || "Brain activity recorded",
			};
	}
}

export function formatBrainActivity(entry: ActivityEntry): BrainActivityItem {
	const formatted = summarize(entry);
	return {
		...entry,
		category: getCategory(entry.action),
		tone: getTone(entry.action, entry.details),
		...formatted,
	};
}

export function mergeBrainActivity(
	existing: ActivityEntry[],
	incoming: ActivityEntry[],
): ActivityEntry[] {
	const entries = new Map(existing.map((entry) => [entry.id, entry]));
	for (const entry of incoming) {
		entries.set(entry.id, entry);
	}

	return Array.from(entries.values()).sort((left, right) => {
		if (left.sequence !== null && right.sequence !== null && left.sequence !== right.sequence) {
			return left.sequence - right.sequence;
		}
		const timestampOrder = new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime();
		if (timestampOrder !== 0) return timestampOrder;
		return left.id.localeCompare(right.id);
	});
}
