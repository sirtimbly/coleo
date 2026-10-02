import type { MessagingItem } from "../../workbench/messaging-collection";

/** A local fixture arrival exercises snapshot selection; it is deliberately not a live mail write. */
export function addReviewReply(items: readonly MessagingItem[], sequence: number): MessagingItem[] {
	return items.map((item) => {
		if (item.thread?.id !== "review") return item;
		const timestamp = `2026-10-02T13:${String(sequence % 60).padStart(2, "0")}:00.000Z`;
		const thread = item.thread;
		const nodes = [...thread.hierarchy.nodes, {
			id: `message:<review-arrival-${sequence}@example.test>`, parentId: "message:<review-api@example.test>",
			kind: "resource" as const, selectable: true, childrenComplete: true,
			data: { title: `Incoming reply ${sequence}: API branch`, summary: "I arrived after the branch was selected. My identity is loaded, but I am not automatically selected.",
				timestamp, source: "North <north@example.test>", from: "North <north@example.test>",
				messageId: `<review-arrival-${sequence}@example.test>`, unread: true, requiresAction: true,
				locations: [{ mailbox: "inbox" as const, messageId: `review-arrival-${sequence}`, seen: false }],
			},
		}].map((node) => node.parentId === null ? { ...node, data: { ...node.data, timestamp, unread: true, requiresAction: true } } : node);
		return { ...item, timestamp, unread: true, requiresAction: true, revision: `${item.revision}-arrival-${sequence}`,
			source: `${thread.mailbox} · ${thread.messageCount + 1} messages (${thread.mailboxMessageCount + 1} in mailbox)`,
			thread: { ...thread, lastMessageAt: timestamp, messageCount: thread.messageCount + 1,
				mailboxMessageCount: thread.mailboxMessageCount + 1, unreadCount: thread.unreadCount + 1,
				revision: `${thread.revision}-arrival-${sequence}`, hierarchy: { ...thread.hierarchy, nodes } },
		};
	});
}
