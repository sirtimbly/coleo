import { buildMailThreadDefinitions } from "../../src/workbench/mail-thread-model";
import { formatBrainActivity, BRAIN_ACTIVITY_CATEGORY_LABELS } from "../../src/workbench/brain-activity";
import { projectMessagingItems, messagingSourcesForQuery } from "../../src/workbench/messaging-collection";
import { messagingQueryIdentity, normalizeMessagingQuery } from "../../src/workbench/messaging-query";

import type { MessagingItem, MessagingCollectionPage } from "../../src/workbench/messaging-collection";
import type { MailThreadProjection, MailThreadMessageInput } from "../../src/workbench/mail-thread-model";
import type { ActivityEntry } from "../../src/workbench/messaging-data";

export interface FixtureMail {
	id: string; from: string; to: string; subject: string; body: string; date: string;
	headers: Record<string, string>; flags: { seen: boolean };
}
export interface MessagingFixtureOptions {
	inbox?: unknown[]; sent?: unknown[]; archive?: unknown[]; activity?: unknown[]; recentEvents?: unknown[];
	workbenchInbox?: unknown[];
}

export function fixtureThreads(options: MessagingFixtureOptions, mailbox: "inbox" | "sent" | "archive"): MailThreadProjection[] {
	const messages: MailThreadMessageInput[] = (["inbox", "sent", "archive"] as const).flatMap((box) =>
		(options[box] ?? []).map((raw) => { const message = raw as FixtureMail;
			return { id: message.id, mailbox: box, from: message.from, subject: message.subject, body: message.body,
				timestamp: message.date, headers: message.headers, seen: message.flags.seen };
		}));
	return buildMailThreadDefinitions(messages, mailbox).map((thread) => ({ ...thread, revision: `fixture:${JSON.stringify(thread)}` }));
}

export function fixtureMessagingPage(options: MessagingFixtureOptions, queryValue: unknown,
	attention: Array<Record<string, unknown>> = []): MessagingCollectionPage {
	const query = normalizeMessagingQuery(queryValue);
	const items: MessagingItem[] = fixtureThreads(options, query.mailbox).map((thread) => ({
		id: thread.hierarchy.rootIds[0]!, revision: thread.revision, sourceId: "mail", representation: "thread", kind: "project",
		title: thread.subject, summary: thread.hierarchy.nodes[0]!.data.summary, timestamp: thread.lastMessageAt, source: `${query.mailbox} · ${thread.messageCount} messages`,
		unread: thread.unreadCount > 0, requiresAction: query.mailbox === "inbox" && thread.unreadCount > 0, severity: "info",
		thread, detail: { kind: "thread", threadId: thread.id, mailbox: query.mailbox },
	}));
	for (const raw of options.activity ?? []) {
		const entry = raw as ActivityEntry;
		const formatted = entry.actor === "brain" ? formatBrainActivity(entry) : null;
		const action = /blocked|failed|error|approval|question/.test(entry.action);
		items.push({ id: `activity:${entry.id}`, revision: JSON.stringify(entry), sourceId: "activity", representation: "event",
			kind: formatted ? "brain" : "system", title: formatted?.title ?? entry.action.replaceAll("_", " "),
			summary: formatted?.summary ?? entry.actor, timestamp: entry.timestamp, source: formatted ? `Brain · ${BRAIN_ACTIVITY_CATEGORY_LABELS[formatted.category]}` : entry.actor,
			unread: action, requiresAction: action, severity: "info", ...(formatted ? { brainCategory: formatted.category } : {}),
			detail: { kind: "activity", activityId: entry.id, sequence: entry.sequence },
		});
	}
	for (const raw of options.recentEvents ?? []) {
		const event = raw as { type: string; timestamp: string; armId?: string; sequence?: number; data: { taskId?: string; bugId?: string; status?: string } };
		const target = event.data.taskId ? `Task ${event.data.taskId}` : event.armId ? `Arm ${event.armId}` : "";
		const label = event.type.split(".").join(" ").replace(/^./, (character) => character.toUpperCase());
		const id = `event:${event.type}:${event.timestamp}:${event.armId ?? event.sequence ?? 0}${event.armId && event.sequence ? `:${event.sequence}` : ""}`;
		const required = /blocked|failed|error/.test(event.type);
		items.push({ id, revision: JSON.stringify(event), sourceId: "events", representation: "event", kind: event.armId ? "arm" : "system",
			title: `${label}${target ? `: ${target}` : ""}`, summary: target, timestamp: event.timestamp, source: "Event stream",
			unread: required, requiresAction: required, severity: required ? "warning" : "info",
			...(event.data.taskId ? { resource: { kind: "task", id: event.data.taskId } } : {}),
			detail: { kind: "event", itemKey: id, sequence: event.sequence ?? 1 },
		});
	}
	for (const raw of options.workbenchInbox ?? []) {
		const record = raw as { itemKey: string; source: string; kind: string; title: string; summary: string; timestamp: string;
			resource: { kind: string; id: string }; requiresAction: boolean; severity: MessagingItem["severity"] };
		items.push({ id: record.itemKey, revision: JSON.stringify(record), sourceId: "records", representation: "resource",
			kind: record.kind === "brain" ? "brain" : "status", title: record.title, summary: record.summary, timestamp: record.timestamp,
			source: record.source, resource: record.resource, unread: true, requiresAction: record.requiresAction, severity: record.severity,
			...(record.source === "swarm-recommendation" ? { brainCategory: "decisions" as const } : {}), detail: { kind: "record", itemKey: record.itemKey },
		});
	}
	const requested = messagingSourcesForQuery(query);
	const stateful = items.filter((item) => requested.includes(item.sourceId)).map((item) => {
		const state = attention.find((entry) => entry.itemKey === item.id);
		return state ? { ...item, unread: state.readAt ? false : item.unread,
			requiresAction: state.resolvedAt ? false : item.requiresAction } : item;
	});
	const projected = projectMessagingItems(stateful, query);
	return { schemaVersion: 1, query, queryId: messagingQueryIdentity(query), cursor: null, nextCursor: null,
		items: projected.slice(0, query.limit), sources: requested.map((id) => ({ id, status: "fresh", revision: "fixture", asOf: "2026-10-01T12:00:00Z", complete: true })),
		summaries: { scope: "query", total: projected.length, unread: projected.filter((item) => item.unread).length,
			requiresAction: projected.filter((item) => item.requiresAction).length, complete: true } };
}
