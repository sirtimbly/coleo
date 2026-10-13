import { createHash } from "node:crypto";

import { BRAIN_ACTIVITY_CATEGORY_LABELS, formatBrainActivity } from "../workbench/brain-activity";
import { inboxActivityId } from "./routes/inbox-event-record";
import { sanitizeEventData } from "./routes/events";

import type { EventData } from "../nats/jetstream-types";
import type { MessagingItem } from "../workbench/messaging-collection";
import type { ActivityEntry, JsonObject } from "../workbench/messaging-data";
import type { MailThreadProjection } from "../workbench/mail-thread-model";
import type { WorkbenchInboxRecord } from "../types/adaptive-cards";

const NOTABLE = new Set(["task.completed", "task.failed", "task.blocked", "task.validated", "task.status_reported",
	"task.discovery_reported", "task.dependency_reported", "task.context_compressed", "arm.status_changed", "system.status", "session.error"]);
const LABELS: Record<string, string> = { "task.completed": "Task completed", "task.failed": "Task failed",
	"task.blocked": "Task blocked", "task.validated": "Task validated", "task.status_reported": "Status report submitted",
	"task.discovery_reported": "Discovery reported", "task.dependency_reported": "Dependency reported",
	"task.context_compressed": "Context compressed", "arm.status_changed": "Arm status changed",
	"system.status": "System status update", "session.error": "Session error" };

export function messagingRevision(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function messagingRecordItem(record: WorkbenchInboxRecord): MessagingItem {
	let summary = record.summary;
	if (record.source === "planning-gate") {
		try { const data = JSON.parse(summary) as { detail?: unknown; nextStep?: unknown };
			summary = [data.detail, data.nextStep].filter((value): value is string => typeof value === "string").join(" Required action: ");
		} catch { /* Preserve legacy plain text. */ }
	}
	return { id: record.itemKey, revision: messagingRevision(record), sourceId: "records", representation: "resource",
		kind: record.kind === "brain" ? "brain" : record.kind === "bug" ? "system" : "status",
		title: record.title, summary, timestamp: record.timestamp, source: record.source === "swarm-recommendation"
			? "Brain · Swarm recommendations" : record.source.replaceAll("-", " "), resource: record.resource,
		unread: !record.attention?.readAt, requiresAction: record.requiresAction, severity: record.severity,
		...(record.source === "swarm-recommendation" ? { brainCategory: "decisions" as const } : {}),
		detail: { kind: "record", itemKey: record.itemKey },
	};
}

export function messagingThreadItem(thread: MailThreadProjection): MessagingItem {
	const root = thread.hierarchy.nodes[0]!;
	return { id: root.id, revision: thread.revision, sourceId: "mail", representation: "thread", kind: "project",
		title: thread.subject, summary: root.data.summary, timestamp: thread.lastMessageAt,
		source: `${thread.mailbox === "archive" ? "Archived" : thread.mailbox === "sent" ? "Sent" : "Inbox"} · ${thread.messageCount} messages`,
		resource: { kind: "conversation", id: thread.id }, unread: thread.mailbox === "inbox" && thread.unreadCount > 0,
		requiresAction: thread.mailbox === "inbox" && thread.unreadCount > 0, severity: thread.unreadCount ? "warning" : "info",
		thread, detail: { kind: "thread", threadId: thread.id, mailbox: thread.mailbox },
	};
}

function text(data: Record<string, unknown>, ...keys: string[]): string | undefined {
	return keys.map((key) => data[key]).find((value): value is string => typeof value === "string" && !!value.trim());
}

export function messagingEventItem(event: EventData): MessagingItem {
	const data = sanitizeEventData(event.data);
	const actor = text(data, "actor") ?? event.armId ?? "system";
	const brain = actor === "brain";
	const notable = !brain && NOTABLE.has(event.type);
	const taskId = text(data, "taskId", "task_id", "target");
	const bugId = text(data, "bugId", "bug_id");
	const armId = event.armId ?? text(data, "armId", "arm_id");
	const status = text(data, "status", "newStatus", "to");
	const requiresAction = /blocked|approval|question|error|failed/.test(event.type) || status === "issues_found" || status === "needs_review";
	const severity = /failed|error/.test(event.type) ? "danger" : /blocked|warning/.test(event.type) ? "warning"
		: /completed|resolved|validated/.test(event.type) ? "success" : "info";
	const entry: ActivityEntry = { id: inboxActivityId(event), sequence: event.sequence ?? null, timestamp: event.timestamp,
		actor, action: event.type, target: text(data, "target") ?? event.armId ?? null,
		details: JSON.parse(JSON.stringify(data)) as JsonObject };
	const formatted = brain ? formatBrainActivity(entry) : null;
	let title = notable ? LABELS[event.type] ?? event.type.replaceAll(".", " ") : event.type.replaceAll("_", " ").replaceAll(".", " ");
	if (notable) {
		const summary = text(data, "summary", "title", "content");
		if (event.type === "arm.status_changed" && armId) title = status ? `Arm ${armId} is ${status}` : `${title}: ${armId}`;
		else if (event.type === "task.status_reported" && summary) title = `${status?.replaceAll("_", " ") ?? "status"}: ${summary.slice(0, 80)}${summary.length > 80 ? "…" : ""}`;
		else title += taskId ? `: Task ${taskId}` : bugId ? `: Bug ${bugId}` : armId ? `: Arm ${armId}` : "";
	}
	const id = notable ? `event:${event.type}:${event.timestamp}:${event.armId ?? event.sequence ?? 0}${event.armId && event.sequence ? `:${event.sequence}` : ""}`
		: `activity:${entry.id}`;
	return { id, revision: messagingRevision(event), sourceId: notable ? "events" : "activity", representation: "event",
		kind: brain ? "brain" : notable ? armId ? "arm" : event.type === "task.status_reported" ? "status" : "system"
			: event.type.includes("proposal") ? "proposal" : actor.includes("arm") || event.type.startsWith("arm.") ? "arm" : "system",
		title: formatted?.title ?? title,
		summary: formatted?.summary ?? (notable ? [taskId ? `Task ${taskId}` : null, bugId ? `Bug ${bugId}` : null,
			armId ? `Arm ${armId}` : null, status ? `Status ${status}` : null].filter(Boolean).join(" · ") || "Server event"
			: entry.target ? `${actor} · ${entry.target}` : actor),
		timestamp: new Date(event.timestamp).toISOString(), source: brain ? `Brain · ${BRAIN_ACTIVITY_CATEGORY_LABELS[formatted!.category]}` : notable ? "Event stream" : actor,
		unread: requiresAction || formatted?.tone === "danger" || formatted?.tone === "warning",
		requiresAction: requiresAction || formatted?.tone === "danger" || formatted?.tone === "warning",
		severity: formatted ? formatted.tone === "danger" ? "danger" : formatted.tone === "warning" ? "warning" : formatted.tone === "success" ? "success" : "info" : severity,
		...(formatted ? { brainCategory: formatted.category } : {}),
		...(formatted?.target && formatted.category === "arms" ? { resource: { kind: "arm", id: formatted.target } }
			: taskId ? { resource: { kind: "task", id: taskId } } : bugId ? { resource: { kind: "bug", id: bugId } }
			: armId ? { resource: { kind: "arm", id: armId } } : {}),
		...(brain ? { actor: { kind: "brain" as const, id: "brain", displayName: "Brain" } } : armId
			? { actor: { kind: "arm" as const, id: armId, displayName: armId } } : {}),
		detail: notable && event.sequence ? { kind: "event", itemKey: id, sequence: event.sequence }
			: { kind: "activity", activityId: entry.id, sequence: event.sequence ?? null },
	};
}
