import type { MessagingItem } from "../../workbench/messaging-collection";

/** Explicitly illustrative product records, separate from the real 532-row SQLite paging fixture. */
export const DEMO_ITEMS: readonly MessagingItem[] = [
	{
		id: "task:release-check", revision: "fixture-r1", sourceId: "records", representation: "resource", kind: "status",
		title: "Release checklist needs a decision", summary: "Confirm the acceptance gates before the delivery branch can move forward.",
		timestamp: "2026-10-01T12:46:00.000Z", source: "Blocked task", resource: { kind: "task", id: "release-check" },
		unread: true, requiresAction: true, severity: "warning", detail: { kind: "record", itemKey: "task:release-check" },
	},
	{
		id: "activity:poll-42", revision: "fixture-r1", sourceId: "activity", representation: "event", kind: "brain",
		title: "Brain completed its latest poll", summary: "Three active Arms. The release review is waiting on a human decision.",
		timestamp: "2026-10-01T12:40:00.000Z", source: "Brain · Operations", brainCategory: "operations",
		unread: false, requiresAction: false, severity: "success", detail: { kind: "activity", activityId: "poll-42", sequence: 42 },
	},
	{
		id: "bug:socket-recovery", revision: "fixture-r1", sourceId: "records", representation: "resource", kind: "system",
		title: "Socket-only recovery needs verification", summary: "Exercise a reconnect without changing browser focus or network state.",
		timestamp: "2026-10-01T12:33:00.000Z", source: "High-priority bug", resource: { kind: "bug", id: "socket-recovery" },
		unread: true, requiresAction: true, severity: "danger", detail: { kind: "record", itemKey: "bug:socket-recovery" },
	},
	{
		id: "thread:inbox:review", revision: "fixture-r1", sourceId: "mail", representation: "thread", kind: "project",
		title: "Can we review the delivery blueprint?", summary: "A conversation stays a conversation, including replies and mailbox context.",
		timestamp: "2026-10-01T12:20:00.000Z", source: "Inbox · Tim · 3 messages", resource: { kind: "conversation", id: "review" },
		unread: true, requiresAction: true, severity: "warning", detail: { kind: "thread", threadId: "review", mailbox: "inbox" },
	},
	{
		id: "event:arm-question", revision: "fixture-r1", sourceId: "events", representation: "event", kind: "arm",
		title: "Arm asks which gate to verify first", summary: "A targeted question has its own identity and retained event sequence.",
		timestamp: "2026-10-01T12:11:00.000Z", source: "Arm · North", resource: { kind: "arm", id: "north" },
		unread: true, requiresAction: true, severity: "info", detail: { kind: "event", itemKey: "event:arm-question", sequence: 51 },
	},
	{
		id: "activity:review-43", revision: "fixture-r1", sourceId: "activity", representation: "event", kind: "brain",
		title: "Review the delivery acceptance gates", summary: "The next review should cover pagination, source outages, and direct resource links.",
		timestamp: "2026-10-01T12:02:00.000Z", source: "Brain · Decisions", brainCategory: "decisions",
		unread: true, requiresAction: true, severity: "warning", detail: { kind: "activity", activityId: "review-43", sequence: 43 },
	},
	{
		id: "status:checks-green", revision: "fixture-r1", sourceId: "records", representation: "resource", kind: "status",
		title: "The focused checks are green", summary: "The Arm reported completion with evidence attached to its task.",
		timestamp: "2026-10-01T11:58:00.000Z", source: "Status report · East", resource: { kind: "task", id: "paging-fix" },
		unread: false, requiresAction: false, severity: "success", detail: { kind: "record", itemKey: "status:checks-green" },
	},
	{
		id: "thread:inbox:handoff", revision: "fixture-r1", sourceId: "mail", representation: "thread", kind: "project",
		title: "Handoff notes for the terminal rewrite", summary: "Both clients should expose the named view's fields and semantic commands.",
		timestamp: "2026-10-01T11:35:00.000Z", source: "Inbox · East · 2 messages", resource: { kind: "conversation", id: "handoff" },
		unread: false, requiresAction: false, severity: "info", detail: { kind: "thread", threadId: "handoff", mailbox: "inbox" },
	},
];
