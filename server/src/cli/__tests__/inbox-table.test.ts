import { describe, expect, it } from "bun:test";
import { fitInboxCell, formatInboxSnapshot } from "../inbox/table";
import { inboxReference, resolveInboxReference } from "../inbox/references";
import { getNamedResourceView } from "../../workbench/named-resource-views";
import { normalizeMessagingQuery, messagingQueryIdentity } from "../../workbench/messaging-query";
import { inboxColorEnabled } from "../inbox/ink";
import { terminalText } from "../inbox/terminal-text";
import { formatInboxDetail } from "../inbox/detail";

import type { InboxSnapshot } from "../inbox/snapshot";
import type { MessagingItem } from "../../workbench/messaging-collection";

const query = normalizeMessagingQuery({ facet: "messages" });
const now = Date.parse("2026-10-08T12:00:00Z");
const rootId = `thread:inbox:${"long-useless-id-".repeat(12)}`;
const title = "Can we review the delivery blueprint and all of the very long implementation details?";
const item: MessagingItem = { id: rootId, revision: "revision", sourceId: "mail", representation: "thread", kind: "project", title,
	summary: "Preview\nwith\ttabs", timestamp: "2026-10-08T11:58:00Z", source: "Inbox · 5 messages", unread: true,
	requiresAction: true, severity: "info", detail: { kind: "thread", threadId: rootId, mailbox: "inbox" } };

function fixture(): InboxSnapshot {
	return { schemaVersion: 1, kind: "inbox.snapshot", view: getNamedResourceView("inbox-triage", "cli")!, query,
		presentation: { id: "grid", implementation: "collection.grid", fields: ["title", "source", "timestamp", "unread", "requiresAction"] },
		pages: [{ schemaVersion: 1, query, queryId: messagingQueryIdentity(query), cursor: null, nextCursor: "opaque-token-".repeat(60),
			items: [item], sources: [{ id: "mail", status: "fresh", revision: "1", asOf: item.timestamp, complete: true }],
			summaries: { scope: "query", total: 1000, unread: 30, requiresAction: 5, complete: true } }],
		items: [item], rows: [{ id: rootId, parentId: null, depth: 0, selectable: false, values: { title, source: item.source, timestamp: item.timestamp, unread: true, requiresAction: true } },
			{ id: "message:<child@example.test>", parentId: rootId, depth: 1, selectable: true, values: { title: "API branch", source: "Tim <long-email@example.test>", timestamp: item.timestamp, unread: false, requiresAction: false } },
			{ id: "message:<grandchild@example.test>", parentId: "message:<child@example.test>", depth: 2, selectable: true,
				values: { title: "家族 👨‍👩‍👧‍👦 and e\u0301 with a long Unicode reply", source: "Reviewer", timestamp: item.timestamp, unread: true, requiresAction: false } }],
		metadata: [], metadataPanelId: null, diagnostics: [], complete: true,
		traversal: { loadedPages: 1, requestedPages: 1, nextCursor: "opaque-token-".repeat(60), retryCursor: null, exhausted: false },
	};
}

describe("readable Inbox tables", () => {
	it("keeps each message on one terminal line, with no full IDs/cursor dumps or tabs", () => {
		const snapshot = fixture();
		const original = JSON.stringify(snapshot);
		for (const columns of [20, 40, 60, 80, 120]) {
			const output = formatInboxSnapshot(snapshot, { columns, now });
			for (const line of output.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns - 2);
			expect(output.split("\n").filter((line) => line.startsWith("@"))).toHaveLength(3);
			expect(output).not.toContain(rootId);
			expect(output).not.toContain("opaque-token-");
			expect(output).not.toContain("\t");
		}
		expect(JSON.stringify(snapshot)).toBe(original);
	});
	it("prioritizes the subject, merges state flags, and renders clear reply branches", () => {
		const output = formatInboxSnapshot(fixture(), { columns: 120, now });
		expect(output).toMatch(/Ref\s+State\s+Subject\s+Source\s+When/);
		expect(output).toContain("Action");
		expect(output).toContain("2m ago");
		expect(output).toContain("└─ API branch");
		expect(output).toContain("Inbox (5)");
		expect(output).not.toContain("long-email@example.test");
		expect(formatInboxSnapshot(fixture(), { columns: 40, now })).toContain("Hidden at this width");
	});
	it("truncates graphemes by display width instead of splitting emoji or combining marks", () => {
		expect(fitInboxCell("👨‍👩‍👧‍👦XYZ", 3)).toBe("👨‍👩‍👧‍👦…");
		expect(fitInboxCell("e\u0301XYZ", 2)).toBe("e\u0301…");
		expect(Bun.stringWidth(fitInboxCell("日本語ABC", 5))).toBeLessThanOrEqual(5);
	});
	it("stable references do not depend on row position or shared ID prefixes", () => {
		const first = `${rootId}one`, second = `${rootId}two`;
		expect(inboxReference(first)).not.toBe(inboxReference(second));
		expect(resolveInboxReference([second, first], inboxReference(first))).toBe(first);
		expect(resolveInboxReference([first], first)).toBe(first);
		expect(resolveInboxReference([second], inboxReference(first))).toBe(inboxReference(first));
	});
	it("dispatches grid, cards, and timeline fallback to distinct readable layouts without changing data", () => {
		const snapshot = fixture();
		const original = JSON.stringify(snapshot);
		const grid = formatInboxSnapshot(snapshot, { columns: 80, now });
		const options = [
			{ id: "cards", fields: ["title", "summary", "source", "timestamp"] },
			{ id: "timeline", fields: ["title", "summary", "timestamp"] },
		];
		for (const presentation of options) {
			const rows = snapshot.rows.map((row) => ({ ...row, values: { ...row.values, summary: "A readable preview that belongs to this entry." } }));
			const selected = { ...snapshot, presentation: { ...presentation, implementation: "collection.list" }, rows };
			for (const columns of [20, 40, 80, 120]) {
				const text = formatInboxSnapshot(selected, { columns, now });
				for (const line of text.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns - 2);
				expect(text).not.toMatch(/Ref\s+State\s+Subject/);
				expect(text).not.toBe(grid);
				if (presentation.id === "cards") expect(text).toContain("┌");
				else expect(text).not.toContain("┌");
			}
			expect(formatInboxSnapshot(selected, { columns: 80, now })).toContain("A readable preview");
		}
		expect(JSON.stringify(snapshot)).toBe(original);
	});
	it("draws colored title bars, state points, and a timeline spine with ANSI-independent alignment", () => {
		const snapshot = fixture();
		for (const id of ["cards", "timeline"]) {
			const selected = { ...snapshot, presentation: { id, implementation: "collection.list", fields: ["title", "summary", "timestamp"] } };
			for (const columns of [20, 40, 80, 120]) {
				const styled = formatInboxSnapshot(selected, { columns, now, color: true });
				expect(styled).toContain("\x1b[");
				expect(styled).toContain("48;2;22;78;99");
				expect(styled).toContain("◆");
				for (const line of styled.split("\n")) expect(Bun.stringWidth(terminalText(line))).toBeLessThanOrEqual(columns - 2);
				const plain = formatInboxSnapshot(selected, { columns, now, color: false });
				expect(plain).not.toContain("\x1b[");
				if (id === "timeline") { expect(plain).toContain("│"); expect(plain).toContain("── 2026-10-08"); }
			}
		}
	});
	it("honors TTY, NO_COLOR, FORCE_COLOR, and explicit color overrides", () => {
		expect(inboxColorEnabled("auto", { isTTY: true, env: {} })).toBe(true);
		expect(inboxColorEnabled("auto", { isTTY: false, env: {} })).toBe(false);
		expect(inboxColorEnabled("auto", { isTTY: true, env: { NO_COLOR: "" } })).toBe(false);
		expect(inboxColorEnabled("auto", { isTTY: false, env: { FORCE_COLOR: "1" } })).toBe(true);
		expect(inboxColorEnabled("auto", { isTTY: true, env: { FORCE_COLOR: "0" } })).toBe(false);
		expect(inboxColorEnabled("always", { env: { NO_COLOR: "1" } })).toBe(true);
		expect(inboxColorEnabled("never", { env: { FORCE_COLOR: "1" } })).toBe(false);
	});
	it("renders full detail bodies and paragraphs without mutating the JSON envelope", () => {
		const output = { id: rootId, complete: false, diagnostics: ["Mail source incomplete"],
			query: { facet: "messages", mailbox: "inbox", profileId: "local" },
			detail: { message: { id: "message:child", subject: "家族 👨‍👩‍👧‍👦 review", from: "Tim", to: "Team",
				timestamp: item.timestamp, body: `First paragraph.\n\n${"日本語👨‍👩‍👧‍👦".repeat(12)}\n\nFinal paragraph.\x1b[2J` } } };
		const original = JSON.stringify(output);
		for (const columns of [20, 40, 80, 120]) {
			const text = formatInboxDetail(output, { columns, color: false });
			expect(text).toContain(inboxReference(output.id));
			expect(text).not.toContain("\x1b[");
			expect(text.replace(/[│\n ]/g, "")).toContain("Firstparagraph.");
			expect(text.replace(/[│\n ]/g, "")).toContain("Finalparagraph.");
			expect(text.match(/👨‍👩‍👧‍👦/g)).toHaveLength(13);
			for (const line of text.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns - 2);
		}
		expect(JSON.stringify(output)).toBe(original);
	});
	it("retains requested custom fields, scoped metadata and partial-source diagnostics", () => {
		const snapshot: InboxSnapshot = { ...fixture(), complete: false, diagnostics: ["Mail unavailable"],
			metadata: [{ field: "unread", label: "Unread", value: 30, scope: "query" }] };
		for (const id of ["grid", "cards", "timeline"]) {
			const selected = { ...snapshot, presentation: { id, implementation: id === "grid" ? "collection.grid" : "collection.list", fields: ["title", "severity"] },
				rows: snapshot.rows.map((row) => ({ ...row, values: { ...row.values, severity: "critical" } })) };
			const text = formatInboxSnapshot(selected, { columns: 120, color: false });
			expect(text).toContain("critical");
			expect(text).toContain("Mail unavailable");
			expect(text).toContain("Sources: mail: fresh");
			expect(text).toContain("INCOMPLETE SOURCES");
			expect(text).toContain("Unread: 30 (query)");
			expect(text).not.toContain("2026-10-08");
		}
	});
	it("renders thread ancestry and non-mail detail records as labeled text", () => {
		const text = formatInboxDetail({ id: rootId, detail: { thread: { title: "Review", hierarchy: { nodes: [
			{ id: "message:child", parentId: "message:parent" },
		] } }, messages: [{ id: "message:child", subject: "Reply", body: "Complete body" }] } }, { columns: 80, color: false });
		expect(text).toContain(`Reply to: ${inboxReference("message:parent")}`);
		expect(text).toContain("Complete body");
		expect(formatInboxDetail({ id: "event:1", detail: { event: { summary: "Build failed", body: "Retry the build" } } },
			{ color: false })).toContain("event / summary\nBuild failed");
	});
});
