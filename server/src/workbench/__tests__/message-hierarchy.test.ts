import { describe, expect, it } from "bun:test";

import { THREADED_MAIL_FIXTURE } from "../examples/threaded-mail";
import { buildMailThreadDefinitions } from "../mail-thread-model";
import { indexMessagingHierarchy, markHierarchyMessagesRead, matchingMessageHierarchyIds } from "../message-hierarchy";
import { projectMessagingItems, reconcileMessagingPage } from "../messaging-collection";
import { normalizeMessagingQuery } from "../messaging-query";
import { visibleHierarchyRows } from "../resource-hierarchy";
import { fixtureSnapshot } from "../../scripts/workbench-demo/snapshots";

import type { MessagingItem } from "../messaging-collection";

const items: readonly MessagingItem[] = buildMailThreadDefinitions(THREADED_MAIL_FIXTURE, "inbox").map((thread) => ({
	id: thread.hierarchy.rootIds[0]!, revision: "fixture-r1", sourceId: "mail", representation: "thread", kind: "project",
	title: thread.subject, summary: thread.hierarchy.nodes[0]!.data.summary, timestamp: thread.lastMessageAt,
	source: "Inbox", unread: thread.unreadCount > 0, requiresAction: thread.unreadCount > 0, severity: "info",
	detail: { kind: "thread", threadId: thread.id, mailbox: "inbox" }, thread: { ...thread, revision: "fixture-r1" },
}));

describe("threaded Messaging projections", () => {
	it("keeps roots separate from related messages while preserving matching descendant ancestry", () => {
		const query = normalizeMessagingQuery({ facet: "messages", search: "continuation" });
		const projected = projectMessagingItems(items, query);
		expect(projected).toHaveLength(1);
		const index = indexMessagingHierarchy(projected);
		const rows = visibleHierarchyRows(index, new Set(index.preorder), matchingMessageHierarchyIds(index, query.search));
		expect(rows.map((row) => row.node.id)).toEqual([
			"thread:inbox:review", "message:<review-root@example.test>", "message:<review-api@example.test>",
		]);
		expect(rows[0]?.contextOnly).toBe(true);
	});

	it("updates only selected Inbox messages and recomputes thread unread state without changing parent links", () => {
		const selected = new Set(["message:<review-api@example.test>", "message:<review-api-check@example.test>"]);
		const updated = markHierarchyMessagesRead(items, selected);
		const before = items.find((item) => item.thread?.id === "review")!.thread!;
		const after = updated.find((item) => item.thread?.id === "review")!.thread!;
		expect(after.unreadCount).toBe(before.unreadCount - 2);
		expect(after.hierarchy.nodes.map((node) => [node.id, node.parentId]))
			.toEqual(before.hierarchy.nodes.map((node) => [node.id, node.parentId]));
		expect(updated.find((item) => item.thread?.id === "handoff")).toBe(items.find((item) => item.thread?.id === "handoff"));
	});

	it("retains the entire nested snapshot during a source outage and removes it only on authoritative replacement", () => {
		const query = normalizeMessagingQuery({ facet: "messages" });
		const previous = fixtureSnapshot(items, query, "healthy");
		const stale = reconcileMessagingPage(previous, fixtureSnapshot(items, query, "unavailable"));
		expect(indexMessagingHierarchy(stale.items).byId.size).toBe(10);
		expect(stale.summaries.complete).toBe(false);
		expect(reconcileMessagingPage(stale, fixtureSnapshot(items, query, "empty")).items).toEqual([]);
	});
});
