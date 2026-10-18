import { describe, expect, it } from "bun:test";

import { projectMessagingItems } from "../messaging-collection";
import { normalizeMessagingQuery } from "../messaging-query";

import type { MessagingItem } from "../messaging-collection";

const timestamp = "2026-10-01T12:00:00.000Z";
const base: MessagingItem = {
	id: "status:one", revision: "r1", sourceId: "records", representation: "resource", kind: "status",
	title: "Review the release", summary: "Needs a decision", timestamp, source: "Status report",
	unread: true, requiresAction: true, severity: "warning", detail: { kind: "record", itemKey: "status:one" },
};
const items: MessagingItem[] = [
	base,
	{ ...base, id: "activity:one", sourceId: "activity", representation: "event", kind: "brain",
		brainCategory: "decisions", detail: { kind: "activity", activityId: "one", sequence: 3 } },
	{ ...base, id: "thread:inbox:one", sourceId: "mail", representation: "thread", kind: "project",
		detail: { kind: "thread", threadId: "one", mailbox: "inbox" } },
	{ ...base, id: "thread:archive:one", sourceId: "mail", representation: "thread", kind: "project",
		detail: { kind: "thread", threadId: "one", mailbox: "archive" } },
];

describe("renderer-independent Messaging projection", () => {
	it("preserves mailbox scopes, Brain categories, and operational facets", () => {
		const ids = (input: unknown) => projectMessagingItems(items, normalizeMessagingQuery(input)).map((item) => item.id);
		expect(ids({ scope: "mail" })).toEqual(["thread:inbox:one"]);
		expect(ids({ scope: "mail", mailbox: "archive" })).toEqual(["thread:archive:one"]);
		expect(ids({ facet: "brain", brainCategory: "decisions" })).toEqual(["activity:one"]);
		expect(ids({ facet: "brain", brainCategory: "operations" })).toEqual([]);
		expect(ids({ facet: "arms" })).toEqual(["status:one"]);
		expect(ids({ facet: "history" })).toEqual(["status:one", "activity:one"]);
		expect(ids({ facet: "all" })).not.toContain("thread:archive:one");
	});

	it("combines normalized search and typed AND filters before ordering", () => {
		const result = projectMessagingItems(items, normalizeMessagingQuery({
			facet: "all", search: "  RELEASE ", filters: [
				{ field: "kind", operator: "in", value: ["status"] },
				{ field: "unread", operator: "equals", value: true },
				{ field: "timestamp", operator: "before", value: "2026-10-01T13:00:00Z" },
			],
		}));
		expect(result).toEqual([base]);
	});

	it("keeps planning-gate focus specific to the attention facet", () => {
		const gate: MessagingItem = { ...base, id: "brain:planning-gate", kind: "brain" };
		expect(projectMessagingItems([...items, gate], normalizeMessagingQuery()).map((item) => item.id))
			.toEqual(["brain:planning-gate"]);
		expect(projectMessagingItems([...items, gate], normalizeMessagingQuery({ facet: "all" }))).toHaveLength(4);
	});

	it("changes display order without changing or mutating resource identities", () => {
		const snapshot = JSON.stringify(items);
		const descending = projectMessagingItems(items, normalizeMessagingQuery({ facet: "all" }));
		const ascending = projectMessagingItems(items, normalizeMessagingQuery({ facet: "all", sort: { field: "timestamp", direction: "asc" } }));
		expect(ascending.map((item) => item.id)).toEqual(descending.map((item) => item.id).reverse());
		expect(JSON.stringify(items)).toBe(snapshot);
	});
});
