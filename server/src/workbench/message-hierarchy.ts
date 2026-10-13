import { indexResourceHierarchy } from "./resource-hierarchy";

import type { MessagingItem } from "./messaging-collection";
import type { ResourceHierarchy, ResourceHierarchyIndex, ResourceHierarchyNode } from "./resource-hierarchy";

/** The collection pages roots; thread members remain attached context, never independently paged list entries. */
export function messagingHierarchy(items: readonly MessagingItem[]): ResourceHierarchy<MessagingItem> {
	const nodes: ResourceHierarchyNode<MessagingItem>[] = [];
	for (const item of items) {
		if (!item.thread) {
			nodes.push({ id: item.id, parentId: null, kind: "resource", selectable: true, childrenComplete: true, data: item });
			continue;
		}
		for (const node of item.thread.hierarchy.nodes) {
			if (node.parentId === null) {
				nodes.push({ ...node, id: item.id, data: item });
				continue;
			}
			const mailbox = node.data.locations.some((location) => location.mailbox === item.thread!.mailbox)
				? item.thread.mailbox : node.data.locations[0]?.mailbox ?? item.thread.mailbox;
			nodes.push({ ...node, parentId: node.parentId === item.thread.hierarchy.rootIds[0] ? item.id : node.parentId,
				data: { id: node.id, revision: item.thread.revision, sourceId: "mail", representation: "message", kind: "project",
					...node.data, severity: node.data.unread ? "warning" : "info",
					resource: { kind: "message", id: node.data.messageId ?? node.id },
					detail: { kind: "message", threadId: item.thread.id, messageId: node.data.messageId ?? node.id, mailbox },
				} });
		}
	}
	return { schemaVersion: 1, rootIds: items.map((item) => item.id), nodes,
		complete: items.every((item) => item.thread?.hierarchy.complete ?? true) };
}

export function matchingMessageHierarchyIds(index: ResourceHierarchyIndex<MessagingItem>, search: string): ReadonlySet<string> | undefined {
	if (!search) return undefined;
	const matches = new Set<string>();
	for (const node of index.hierarchy.nodes) {
		if (`${node.data.title} ${node.data.summary} ${node.data.source}`.toLowerCase().includes(search)) matches.add(node.id);
	}
	return matches;
}

/** Local-demo mutation: update message flags and aggregate thread state, without rewriting relationships or identity. */
export function markHierarchyMessagesRead(items: readonly MessagingItem[], selectedIds: ReadonlySet<string>): MessagingItem[] {
	return items.map((item) => {
		if (!item.thread) return selectedIds.has(item.id) && item.unread ? { ...item, unread: false, revision: `${item.revision}-read` } : item;
		const thread = item.thread;
		if (!thread.hierarchy.nodes.some((node) => selectedIds.has(node.id) &&
			node.data.locations.some((location) => location.mailbox === "inbox" && !location.seen))) return item;
		const nodes = thread.hierarchy.nodes.map((node) => {
			if (!node.selectable || !selectedIds.has(node.id)) return node;
			const locations = node.data.locations.map((location) => location.mailbox === "inbox" ? { ...location, seen: true } : location);
			return { ...node, data: { ...node.data, locations,
				unread: locations.some((location) => location.mailbox === (node.data.mailbox ?? thread.mailbox) && !location.seen),
				requiresAction: locations.some((location) => location.mailbox === "inbox" && !location.seen),
			} };
		});
		const unreadCount = nodes.filter((node) => node.selectable &&
			node.data.locations.some((location) => location.mailbox === thread.mailbox && !location.seen)).length;
		const requiresAction = thread.mailbox === "inbox" && unreadCount > 0;
		const hierarchy = { ...thread.hierarchy, nodes: nodes.map((node) => node.parentId === null
			? { ...node, data: { ...node.data, unread: unreadCount > 0, requiresAction } } : node) };
		return { ...item, unread: unreadCount > 0, requiresAction, revision: `${item.revision}-read`,
			thread: { ...thread, unreadCount, hierarchy, revision: `${thread.revision}-read` } };
	});
}

export function indexMessagingHierarchy(items: readonly MessagingItem[]): ResourceHierarchyIndex<MessagingItem> {
	return indexResourceHierarchy(messagingHierarchy(items));
}
