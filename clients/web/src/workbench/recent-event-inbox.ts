/**
 * Projects high-signal server events into the unified Inbox.
 *
 * This preserves the former dashboard feed's readable labels, severity, and
 * task, bug, or Arm target navigation without maintaining a second event list.
 */

import type { InboxProjectionItem } from "@/workbench/ProjectionInbox";
import type { JsonObject, RecentEventsResponse } from "@/lib";

export type RecentEvent = RecentEventsResponse["events"][number];

export interface RecentEventInboxProjection {
	item: InboxProjectionItem;
	recentEvent: RecentEvent;
	targetRoute?: { pathname: string; search: string };
}

const NOTABLE_TASK_EVENTS = new Set([
	"task.completed",
	"task.failed",
	"task.blocked",
	"task.validated",
	"task.status_reported",
	"task.discovery_reported",
	"task.dependency_reported",
	"task.context_compressed",
]);

const NOTABLE_OTHER_EVENTS = new Set([
	"arm.status_changed",
	"system.status",
	"session.error",
]);

const EVENT_LABELS: Record<string, string> = {
	"task.completed": "Task completed",
	"task.failed": "Task failed",
	"task.blocked": "Task blocked",
	"task.validated": "Task validated",
	"task.status_reported": "Status report submitted",
	"task.discovery_reported": "Discovery reported",
	"task.dependency_reported": "Dependency reported",
	"task.context_compressed": "Context compressed",
	"arm.status_changed": "Arm status changed",
	"system.status": "System status update",
	"session.error": "Session error",
};

function dataString(data: JsonObject | undefined, keys: string[]): string | undefined {
	if (!data) return undefined;
	for (const key of keys) {
		const value = data[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function eventTitle(event: RecentEvent): string {
	const label = EVENT_LABELS[event.type] ??
		event.type.replace(/\./g, " ").replace(/_/g, " ");
	const taskId = dataString(event.data, ["taskId", "task_id", "target"]);
	const bugId = dataString(event.data, ["bugId", "bug_id"]);
	const armId = event.armId || dataString(event.data, ["armId", "arm_id", "actor"]);
	const summary = dataString(event.data, ["summary", "title", "content"]);

	if (event.type === "arm.status_changed" && armId) {
		const status = dataString(event.data, ["to", "newStatus", "status"]);
		return status ? `Arm ${armId} is ${status}` : `${label}: ${armId}`;
	}
	if (event.type === "task.status_reported" && summary) {
		const status = dataString(event.data, ["status", "newStatus"]);
		const prefix = status ? status.replace(/_/g, " ") : "status";
		return `${prefix}: ${summary.slice(0, 80)}${summary.length > 80 ? "…" : ""}`;
	}

	const subject = taskId
		? `Task ${taskId}`
		: bugId
			? `Bug ${bugId}`
			: armId
				? `Arm ${armId}`
				: null;
	return subject ? `${label}: ${subject}` : label;
}

function eventSeverity(event: RecentEvent): InboxProjectionItem["severity"] {
	if (event.type.includes("failed") || event.type.includes("error")) return "danger";
	if (event.type.includes("blocked")) return "warning";
	if (event.type.includes("completed") || event.type.includes("validated")) return "success";
	return "info";
}

export function isNotableEvent(event: RecentEvent): boolean {
	return NOTABLE_TASK_EVENTS.has(event.type) || NOTABLE_OTHER_EVENTS.has(event.type);
}

export function projectRecentEvent(
	event: RecentEvent,
	index: number,
): RecentEventInboxProjection {
	const taskId = dataString(event.data, ["taskId", "task_id", "target"]);
	const bugId = dataString(event.data, ["bugId", "bug_id"]);
	const armId = event.armId || dataString(event.data, ["armId", "arm_id", "actor"]);
	const status = dataString(event.data, ["status", "newStatus", "to"]);
	const requiresAction = event.type.includes("blocked") ||
		event.type.includes("failed") ||
		event.type.includes("error") ||
		status === "issues_found" ||
		status === "needs_review";
	const targetRoute = taskId
		? { pathname: "/tasks", search: `?task=${encodeURIComponent(taskId)}&view=details` }
		: bugId
			? { pathname: "/bugs", search: `?bug=${encodeURIComponent(bugId)}` }
			: armId
				? { pathname: "/viewer", search: `?arm=${encodeURIComponent(armId)}` }
				: undefined;
	const meta = [
		taskId ? `Task ${taskId}` : null,
		bugId ? `Bug ${bugId}` : null,
		armId ? `Arm ${armId}` : null,
		status ? `Status ${status}` : null,
	].filter((value): value is string => Boolean(value));

	return {
		item: {
			id: `event:${event.type}:${event.timestamp}:${event.armId ?? index}`,
			kind: armId ? "arm" : event.type === "task.status_reported" ? "status" : "system",
			title: eventTitle(event),
			summary: meta.join(" · ") || "Server event",
			timestamp: event.timestamp,
			source: "Event stream",
			resourceId: taskId ?? bugId ?? armId,
			unread: requiresAction,
			requiresAction,
			severity: eventSeverity(event),
		},
		recentEvent: event,
		targetRoute,
	};
}
