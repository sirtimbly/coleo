import { describe, expect, it } from "bun:test";

import { messagingSourcesForQuery, reconcileMessagingPage } from "../messaging-collection";
import { compareMessagingPositions, messagingQueryIdentity, normalizeMessagingQuery } from "../messaging-query";

import type { MessagingCollectionPage, MessagingItem, MessagingSourceId } from "../messaging-collection";

const TIMESTAMP = "2026-10-01T12:00:00.000Z";

function item(id: string, sourceId: MessagingSourceId, revision = "r1"): MessagingItem {
	return {
		id, revision, sourceId, representation: "resource", kind: "status", title: id, summary: "Fixture",
		timestamp: TIMESTAMP, source: "Status report", unread: true, requiresAction: true, severity: "warning",
		detail: { kind: "record", itemKey: id },
	};
}

function page(items: readonly MessagingItem[], queryInput: unknown = { facet: "all" }): MessagingCollectionPage {
	const query = normalizeMessagingQuery(queryInput);
	return {
		schemaVersion: 1, query, queryId: messagingQueryIdentity(query), cursor: null, nextCursor: "next-page", items,
		sources: messagingSourcesForQuery(query).map((id) => ({
			id, status: "fresh", revision: "source-r1", asOf: TIMESTAMP, complete: true,
		})),
		summaries: { scope: "query", total: items.length, unread: items.length, requiresAction: items.length, complete: true },
	};
}

describe("portable Messaging query", () => {
	it("gives equivalent filters and irrelevant hidden controls the same cache/cursor identity", () => {
		const left = normalizeMessagingQuery({
			facet: "arms", search: "  REVIEW  ", mailbox: "archive", brainCategory: "alerts",
			filters: [
				{ field: "kind", operator: "in", value: ["status", "arm", "arm"] },
				{ field: "unread", operator: "equals", value: true },
			],
		});
		const right = normalizeMessagingQuery({
			facet: "arms", search: "review", filters: [
				{ field: "unread", operator: "equals", value: true },
				{ field: "kind", operator: "in", value: ["arm", "status"] },
				{ field: "unread", operator: "equals", value: true },
			],
		});
		expect(messagingQueryIdentity(left)).toBe(messagingQueryIdentity(right));
		expect(normalizeMessagingQuery(left)).toEqual(left);
	});

	it("keeps profiles, mailboxes, Brain categories, sort, and page size in identity", () => {
		for (const change of [
			{ profileId: "second" }, { facet: "messages", mailbox: "sent" },
			{ facet: "messages", mailbox: "archive" }, { facet: "brain", brainCategory: "decisions" },
			{ sort: { field: "timestamp", direction: "asc" } }, { limit: 20 },
		]) {
			expect(messagingQueryIdentity(normalizeMessagingQuery(change)))
				.not.toBe(messagingQueryIdentity(normalizeMessagingQuery()));
		}
		expect(normalizeMessagingQuery({ scope: "mail", mailbox: "archive" })).toMatchObject({
			scope: "mail", facet: "messages", mailbox: "archive",
		});
	});

	it("rejects unsupported schemas, executable/unknown fields, invalid limits, and incompatible mail scope", () => {
		for (const invalid of [
			{ schemaVersion: 2 }, { cursor: "not-a-setting" }, { limit: Number.NaN }, { limit: 0 }, { limit: 201 },
			{ scope: "mail", facet: "brain" }, { filters: [{ field: "unread", operator: "equals", value: "true" }] },
			{ sort: { field: "title", direction: "desc" } },
		]) expect(() => normalizeMessagingQuery(invalid)).toThrow();
	});

	it("normalizes date boundaries to UTC and orders tied IDs exactly as binary keyset comparisons", () => {
		expect(normalizeMessagingQuery({ filters: [
			{ field: "timestamp", operator: "before", value: "2026-10-01T14:00:00+02:00" },
		] }).filters).toEqual([{ field: "timestamp", operator: "before", value: TIMESTAMP }]);
		const positions = ["task:a-1", "task:a:1", "task:a_1", "task:aA"].map((id) => ({ id, timestamp: TIMESTAMP }));
		expect([...positions].sort(compareMessagingPositions).map((position) => position.id))
			.toEqual(["task:a_1", "task:aA", "task:a:1", "task:a-1"]);
	});

	it("selects requested sources instead of loading every hidden facet", () => {
		expect(messagingSourcesForQuery(normalizeMessagingQuery({ facet: "messages" }))).toEqual(["mail"]);
		expect(messagingSourcesForQuery(normalizeMessagingQuery({ scope: "mail" }))).toEqual(["mail"]);
		expect(messagingSourcesForQuery(normalizeMessagingQuery({ facet: "history" }))).not.toContain("mail");
	});
});

describe("Messaging source replacement", () => {
	it("preserves unavailable/stale source sections, accepts healthy replacements, and stops partial traversal", () => {
		const previous = page([item("thread:inbox:one", "mail"), item("status:one", "records")]);
		const incoming = {
			...page([item("status:one", "records", "r2")]),
			sources: previous.sources.map((source) => source.id === "mail"
				? { ...source, status: "unavailable" as const, complete: false, error: { code: "MAIL_UNAVAILABLE", message: "Maildir unavailable" } }
				: source),
		};
		for (const status of ["unavailable", "stale"] as const) {
			const result = reconcileMessagingPage(previous, {
				...incoming, sources: incoming.sources.map((source) => source.id === "mail" ? { ...source, status } : source),
			});
			expect(result.items.map((entry) => entry.id)).toContain("thread:inbox:one");
			expect(result.items.find((entry) => entry.id === "status:one")?.revision).toBe("r2");
			expect(result.sources.find((source) => source.id === "mail")?.status).toBe(status);
			expect(result.nextCursor).toBeNull();
			expect(result.summaries.complete).toBe(false);
		}
	});

	it("distinguishes an authoritative empty result from an outage", () => {
		const previous = page([item("thread:inbox:one", "mail")]);
		const result = reconcileMessagingPage(previous, page([]));
		expect(result.items).toEqual([]);
		expect(result.summaries).toMatchObject({ total: 0, complete: true });
	});

	it("never carries sections into another query or continuation page", () => {
		const previous = page([item("status:one", "records")]);
		const incoming = page([], { facet: "brain" });
		const unavailable = { ...incoming, sources: incoming.sources.map((source) => ({ ...source, complete: false })) };
		expect(reconcileMessagingPage(previous, unavailable).items).toEqual([]);
		expect(reconcileMessagingPage(previous, { ...previous, items: [], cursor: "page-two", sources: unavailable.sources }).items)
			.toEqual([]);
	});

	it("treats a missing requested source state as unavailable, never silently empty", () => {
		const previous = page([item("thread:inbox:one", "mail")]);
		const result = reconcileMessagingPage(previous, { ...page([]), sources: [] });
		expect(result.items).toHaveLength(1);
		expect(result.sources.every((source) => source.error?.code === "SOURCE_STATE_MISSING")).toBe(true);
		expect(result.summaries.complete).toBe(false);
	});
});
