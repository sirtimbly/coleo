import { compareMessagingPositions } from "./messaging-query";

import type { MessagingMailbox } from "./messaging-query";
import type { ResourceHierarchy, ResourceHierarchyNode } from "./resource-hierarchy";

export interface MailThreadMessageInput {
	readonly id: string;
	readonly mailbox: MessagingMailbox;
	readonly from: string;
	readonly subject: string;
	readonly timestamp: string;
	readonly body: string;
	readonly seen: boolean;
	readonly headers: Readonly<Record<string, string>>;
}

export interface MailThreadLocation {
	readonly mailbox: MessagingMailbox;
	readonly messageId: string;
	readonly seen: boolean;
}

export interface MailThreadNodeData {
	readonly title: string;
	readonly summary: string;
	readonly timestamp: string;
	readonly source: string;
	readonly unread: boolean;
	readonly requiresAction: boolean;
	readonly from?: string;
	readonly mailbox?: MessagingMailbox;
	readonly messageId?: string;
	readonly locations: readonly MailThreadLocation[];
	readonly missingParent?: string;
}

export interface MailThreadDefinition {
	readonly id: string;
	readonly mailbox: MessagingMailbox;
	readonly subject: string;
	readonly messageCount: number;
	readonly mailboxMessageCount: number;
	readonly unreadCount: number;
	readonly lastMessageAt: string;
	readonly hierarchy: ResourceHierarchy<MailThreadNodeData>;
	readonly diagnostics: readonly { readonly code: string; readonly nodeId: string; readonly message: string }[];
}

export interface MailThreadProjection extends MailThreadDefinition {
	readonly revision: string;
}

function header(message: MailThreadMessageInput, name: string): string | undefined {
	return Object.entries(message.headers).find(([key]) => key.toLowerCase() === name)?.[1]?.trim() || undefined;
}

function references(value: string | undefined): string[] {
	return (value?.match(/<[^<>]+>|[^\s<>]+/g) ?? []).map((token) => token.startsWith("<") ? token : `<${token}>`);
}

function explicitThread(message: MailThreadMessageInput): string | undefined {
	return ["x-coleo-thread-id", "x-coleo-task-id", "x-coleo-bug-id", "x-coleo-request-id"]
		.map((key) => header(message, key)).find(Boolean);
}

interface CanonicalMessage {
	id: string;
	rfcId: string;
	message: MailThreadMessageInput;
	locations: MailThreadLocation[];
	tag?: string;
	parentReference?: string;
	references: string[];
}

/** Header-first grouping and actual reply ancestry, independent of input enumeration order or renderer. */
export function buildMailThreadDefinitions(
	input: readonly MailThreadMessageInput[], mailbox: MessagingMailbox,
): MailThreadDefinition[] {
	const canonical = new Map<string, CanonicalMessage>();
	const normalized = input.map((message) => {
		if (!Number.isFinite(Date.parse(message.timestamp))) throw new Error(`Invalid mail timestamp: ${message.id}`);
		return { ...message, timestamp: new Date(message.timestamp).toISOString() };
	}).sort((left, right) => compareMessagingPositions(left, right, "asc") ||
		(left.mailbox < right.mailbox ? -1 : left.mailbox > right.mailbox ? 1 : 0));
	for (const message of normalized) {
		const rfcId = references(header(message, "message-id"))[0] ?? `storage:${message.id}`;
		const existing = canonical.get(rfcId);
		const location = { mailbox: message.mailbox, messageId: message.id, seen: message.seen };
		if (existing) {
			if (!existing.locations.some((entry) => entry.mailbox === location.mailbox && entry.messageId === location.messageId)) {
				existing.locations.push(location);
			}
			continue;
		}
		canonical.set(rfcId, { id: `message:${rfcId}`, rfcId, message, locations: [location],
			tag: explicitThread(message), parentReference: references(header(message, "in-reply-to"))[0],
			references: references(header(message, "references")),
		});
	}
	const messages = [...canonical.values()];
	const owners = new Map(messages.map((message) => [message.rfcId, message.rfcId]));
	const tags = new Map(messages.filter((message) => message.tag).map((message) => [message.rfcId, message.tag!]));
	const find = (id: string): string => {
		let owner = id;
		while (owners.get(owner) !== owner) owner = owners.get(owner)!;
		let current = id;
		while (owners.get(current) !== owner) { const next = owners.get(current)!; owners.set(current, owner); current = next; }
		return owner;
	};
	const join = (left: string, right: string): void => {
		const first = find(left), second = find(right);
		if (first === second || tags.get(first) && tags.get(second) && tags.get(first) !== tags.get(second)) return;
		owners.set(second, first);
		if (!tags.has(first) && tags.has(second)) tags.set(first, tags.get(second)!);
	};
	const byTag = new Map<string, string>();
	for (const message of messages) {
		if (message.tag) {
			const previous = byTag.get(message.tag);
			if (previous) join(previous, message.rfcId); else byTag.set(message.tag, message.rfcId);
		}
	}
	const byReference = new Map<string, string>();
	for (const message of messages) {
		for (const reference of [message.parentReference, ...message.references]) {
			if (!reference) continue;
			if (canonical.has(reference)) join(message.rfcId, reference);
			const previous = byReference.get(reference);
			if (previous) join(message.rfcId, previous); else byReference.set(reference, message.rfcId);
		}
	}
	const groups = new Map<string, CanonicalMessage[]>();
	for (const message of messages) {
		const owner = find(message.rfcId);
		const group = groups.get(owner);
		if (group) group.push(message); else groups.set(owner, [message]);
	}
	const threads: MailThreadDefinition[] = [];
	for (const group of groups.values()) {
		if (!group.some((message) => message.locations.some((location) => location.mailbox === mailbox))) continue;
		const groupIds = new Set(group.map((message) => message.rfcId));
		const tag = group.find((message) => message.tag)?.tag;
		const first = group[0]!;
		const diagnostics: Array<{ code: string; nodeId: string; message: string }> = [];
		const parents = new Map<string, string | null>();
		for (const message of group) {
			const parent = [message.parentReference, ...message.references.slice().reverse()]
				.find((reference) => reference && reference !== message.rfcId && groupIds.has(reference));
			parents.set(message.id, parent ? canonical.get(parent)!.id : null);
			if (message.parentReference && !groupIds.has(message.parentReference)) {
				diagnostics.push({ code: "MISSING_REPLY_PARENT", nodeId: message.id,
					message: `Direct reply parent ${message.parentReference} is not loaded in this thread` });
			}
		}
		// Break malformed header cycles deterministically; never invent a reply relationship from array adjacency.
		const complete = new Set<string>();
		for (const message of group) {
			let current: string | null = message.id;
			const path = new Set<string>();
			while (current && !complete.has(current)) {
				if (path.has(current)) {
					parents.set(current, null);
					diagnostics.push({ code: "REPLY_CYCLE", nodeId: current, message: "Cyclic reply header was detached" });
					break;
				}
				path.add(current); current = parents.get(current) ?? null;
			}
			for (const id of path) complete.add(id);
		}
		const unreadCount = group.filter((message) => message.locations.some((location) => location.mailbox === mailbox && !location.seen)).length;
		const lastMessageAt = new Date(group.at(-1)!.message.timestamp).toISOString();
		const anchor = group.find((message) => parents.get(message.id) === null) ?? first;
		const threadId = tag ?? anchor.references[0] ?? anchor.parentReference ?? anchor.rfcId;
		const rootId = `thread:${mailbox}:${threadId}`;
		const subject = anchor.message.subject.replace(/^(?:(?:re|fwd?):\s*)+/i, "").trim() || "(No subject)";
		const nodes: ResourceHierarchyNode<MailThreadNodeData>[] = [{
			id: rootId, parentId: null, kind: "group", selectable: false, childrenComplete: true,
			data: { title: subject, summary: group.at(-1)!.message.body.slice(0, 180), timestamp: lastMessageAt,
				source: `${mailbox} · ${group.length} messages`, unread: unreadCount > 0, requiresAction: mailbox === "inbox" && unreadCount > 0,
				locations: [] },
		}];
		for (const message of group) {
			const messageMailbox = message.locations.some((location) => location.mailbox === mailbox)
				? mailbox : message.locations[0]!.mailbox;
			nodes.push({ id: message.id, parentId: parents.get(message.id) ?? rootId, kind: "resource", selectable: true,
				childrenComplete: true, data: {
					title: message.message.subject, summary: message.message.body.slice(0, 240),
					timestamp: new Date(message.message.timestamp).toISOString(), source: message.message.from,
					from: message.message.from, mailbox: messageMailbox, messageId: message.rfcId, locations: message.locations,
					unread: message.locations.some((location) => location.mailbox === messageMailbox && !location.seen),
					requiresAction: message.locations.some((location) => location.mailbox === "inbox" && !location.seen),
					...(message.parentReference && !groupIds.has(message.parentReference) ? { missingParent: message.parentReference } : {}),
				} });
		}
		threads.push({ id: threadId, mailbox, subject, messageCount: group.length,
			mailboxMessageCount: group.filter((message) => message.locations.some((location) => location.mailbox === mailbox)).length,
			unreadCount, lastMessageAt, hierarchy: { schemaVersion: 1, rootIds: [rootId], nodes, complete: true }, diagnostics });
	}
	return threads.sort((left, right) => compareMessagingPositions(
		{ id: left.id, timestamp: left.lastMessageAt }, { id: right.id, timestamp: right.lastMessageAt }));
}
