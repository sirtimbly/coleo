import { BRAIN_CARD_CREATOR, createArmCardCreator } from "@/adaptive-cards/card-creators";
import { BRAIN_ACTIVITY_CATEGORY_LABELS, formatBrainActivity } from "./brain-activity";
import type { BrainActivityCategory, BrainActivityTone } from "./brain-activity";
import type { ActivityEntry, StatusReport } from "@/lib/api";
import type { InboxProjectionItem } from "@/workbench/ProjectionInbox";
import type { RecentEvent } from "@/workbench/recent-event-inbox";
import type { MailThread, MailboxTab } from "./mail-page-utils";
import type { CardCreator, WorkbenchInboxRecord } from "../../../types/adaptive-cards";

export interface InboxItemData {
	item: InboxProjectionItem;
	thread?: MailThread;
	mailbox?: MailboxTab;
	statusReport?: StatusReport;
	activity?: ActivityEntry;
	recentEvent?: RecentEvent;
	brainCategory?: BrainActivityCategory;
	targetRoute?: { pathname: string; search: string };
}

function activityKind(entry: ActivityEntry): InboxProjectionItem["kind"] {
	const actor = entry.actor.toLowerCase();
	const action = entry.action.toLowerCase();
	if (action.includes("proposal")) return "proposal";
	if (actor.includes("brain")) return "brain";
	if (actor.includes("arm") || action.startsWith("arm.")) return "arm";
	return "system";
}

function activitySeverity(entry: ActivityEntry): InboxProjectionItem["severity"] {
	const action = entry.action.toLowerCase();
	if (action.includes("error") || action.includes("failed")) return "danger";
	if (action.includes("blocked") || action.includes("warning")) return "warning";
	if (action.includes("completed") || action.includes("resolved")) return "success";
	return "info";
}

function activityRequiresAction(entry: ActivityEntry): boolean {
	const action = entry.action.toLowerCase();
	return action.includes("blocked") ||
		action.includes("approval") ||
		action.includes("question") ||
		action.includes("error") ||
		action.includes("failed");
}

export function threadToItem(thread: MailThread, mailbox: MailboxTab): InboxItemData {
	const latest = thread.messages.at(-1)?.message;
	return {
		item: {
			id: `thread:${mailbox}:${thread.id}`,
			kind: "project",
			title: thread.subject || "(No subject)",
			summary: latest?.body.slice(0, 180) || `${thread.messages.length} messages`,
			timestamp: thread.lastMessageDate.toISOString(),
			source: `${mailbox === "archive" ? "Archived" : mailbox === "sent" ? "Sent" : "Inbox"} · ${latest?.from ?? "Unknown sender"} · ${thread.messages.length} ${thread.messages.length === 1 ? "message" : "messages"}`,
			resourceId: thread.id,
			unread: mailbox === "inbox" && thread.unreadCount > 0,
			requiresAction: mailbox === "inbox" && thread.unreadCount > 0,
			severity: thread.unreadCount > 0 ? "warning" : "info",
		},
		thread,
		mailbox,
	};
}

export function reportToItem(report: StatusReport): InboxItemData {
	const needsAttention = report.status === "blocked" ||
		report.status === "issues_found" ||
		report.status === "needs_review";
	return {
		item: {
			id: `status:${report.id}`,
			kind: "status",
			title: `${report.armId}: ${report.status.replaceAll("_", " ")}`,
			summary: report.summary,
			timestamp: report.createdAt,
			source: `Status report · task ${report.taskId}`,
			resourceId: report.id,
			unread: needsAttention,
			requiresAction: needsAttention,
			severity: report.status === "blocked"
				? "danger"
				: report.status === "on_track"
					? "success"
					: needsAttention
						? "warning"
						: "info",
		},
		statusReport: report,
	};
}

export function activityToItem(entry: ActivityEntry): InboxItemData {
	const requiresAction = activityRequiresAction(entry);
	return {
		item: {
			id: `activity:${entry.id}`,
			kind: activityKind(entry),
			title: entry.action.replaceAll("_", " ").replaceAll(".", " "),
			summary: entry.target ? `${entry.actor} · ${entry.target}` : entry.actor,
			timestamp: entry.timestamp,
			source: entry.actor,
			resourceId: entry.target ?? undefined,
			unread: requiresAction,
			requiresAction,
			severity: activitySeverity(entry),
		},
		activity: entry,
	};
}

function brainToneToSeverity(tone: BrainActivityTone): InboxProjectionItem["severity"] {
	if (tone === "danger") return "danger";
	if (tone === "warning") return "warning";
	if (tone === "success") return "success";
	return "info";
}

export function brainActivityToItem(entry: ActivityEntry): InboxItemData {
	const formatted = formatBrainActivity(entry);
	const requiresAction = formatted.tone === "danger" ||
		formatted.tone === "warning" ||
		activityRequiresAction(entry);
	const targetRoute = formatted.target && formatted.category === "arms"
		? {
				pathname: "/viewer",
				search: `?arm=${encodeURIComponent(formatted.target)}`,
			}
		: formatted.target && (formatted.category === "tasks" || formatted.category === "decisions")
			? {
					pathname: "/tasks",
					search: `?task=${encodeURIComponent(formatted.target)}&view=details`,
				}
			: undefined;
	return {
		item: {
			id: `activity:${formatted.id}`,
			kind: "brain",
			title: formatted.title,
			summary: formatted.summary,
			timestamp: formatted.timestamp,
			source: `Brain · ${BRAIN_ACTIVITY_CATEGORY_LABELS[formatted.category]}`,
			resourceId: formatted.target ?? undefined,
			unread: requiresAction,
			requiresAction,
			severity: brainToneToSeverity(formatted.tone),
		},
		activity: entry,
		brainCategory: formatted.category,
		targetRoute,
	};
}

export function workbenchInboxToItem(record: WorkbenchInboxRecord): InboxItemData {
	const targetRoute = record.resource.kind === "task"
		? {
				pathname: "/tasks",
				search: `?task=${encodeURIComponent(record.resource.id)}&view=details`,
			}
		: record.resource.kind === "bug"
			? {
					pathname: "/bugs",
					search: `?bug=${encodeURIComponent(record.resource.id)}`,
				}
			: undefined;
	const summary = record.source === "planning-gate"
		? (() => {
			try {
				const parsed = JSON.parse(record.summary) as { detail?: unknown; nextStep?: unknown };
				return [parsed.detail, parsed.nextStep]
					.filter((value): value is string => typeof value === "string")
					.join(" Required action: ");
			} catch {
				return record.summary;
			}
		})()
		: record.summary;
	return {
		item: {
			id: record.itemKey,
			kind: record.kind === "brain" ? "brain" : record.kind === "bug" ? "system" : "status",
			title: record.title,
			summary,
			timestamp: record.timestamp,
			source: record.source.replaceAll("-", " "),
			resourceId: record.resource.id,
			unread: !record.attention?.readAt,
			requiresAction: record.requiresAction,
			severity: record.severity,
		},
		targetRoute,
	};
}

export function creatorForInboxItem(source: InboxItemData): CardCreator {
	if (source.statusReport) return createArmCardCreator(source.statusReport.armId);
	if (source.recentEvent?.armId) return createArmCardCreator(source.recentEvent.armId);
	if (source.item.kind === "arm") {
		return createArmCardCreator(
			source.activity?.actor ?? source.item.resourceId ?? "unknown-arm",
			source.activity?.actor ?? source.item.resourceId,
		);
	}
	return BRAIN_CARD_CREATOR;
}
