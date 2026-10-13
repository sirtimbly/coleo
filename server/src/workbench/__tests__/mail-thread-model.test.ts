import { describe, expect, it } from "bun:test";

import { THREADED_MAIL_FIXTURE } from "../examples/threaded-mail";
import { buildMailThreadDefinitions } from "../mail-thread-model";
import { indexResourceHierarchy } from "../resource-hierarchy";

describe("mail reply relationships", () => {
	it("builds branching replies from headers independently of enumeration order, keeping sent context", () => {
		const threads = buildMailThreadDefinitions(THREADED_MAIL_FIXTURE, "inbox");
		expect(buildMailThreadDefinitions([...THREADED_MAIL_FIXTURE].reverse(), "inbox")).toEqual(threads);
		const review = threads.find((thread) => thread.id === "review")!;
		expect(review.messageCount).toBe(5);
		expect(review.mailboxMessageCount).toBe(4);
		expect(review.hierarchy.nodes.find((node) => node.id === "message:<review-tui@example.test>")?.parentId)
			.toBe("message:<review-terminal@example.test>");
		expect(indexResourceHierarchy(review.hierarchy).preorder).toHaveLength(6);
		const sent = buildMailThreadDefinitions(THREADED_MAIL_FIXTURE, "sent").find((thread) => thread.id === "review")!;
		expect(sent.unreadCount).toBe(0);
		expect(sent.hierarchy.nodes.find((node) => node.id === "message:<review-api@example.test>")?.data.unread).toBe(true);
	});

	it("deduplicates copies but never merges unrelated conversations just because their subjects match", () => {
		const first = THREADED_MAIL_FIXTURE[0]!;
		const duplicate = { ...first, id: "copy", mailbox: "sent" as const };
		const unrelated = { ...first, id: "other", headers: { "Message-ID": "<other@example.test>" } };
		const threads = buildMailThreadDefinitions([first, duplicate, unrelated], "inbox");
		expect(threads).toHaveLength(2);
		expect(threads.find((thread) => thread.id === "review")?.messageCount).toBe(1);
		expect(threads.find((thread) => thread.id === "review")?.hierarchy.nodes[1]?.data.locations).toHaveLength(2);
	});

	it("shows orphan replies explicitly and detaches malformed cycles without infinite traversal", () => {
		const first = THREADED_MAIL_FIXTURE[0]!;
		const orphan = { ...first, headers: { "Message-ID": "<orphan>", "In-Reply-To": "<missing>" } };
		const orphanThread = buildMailThreadDefinitions([orphan], "inbox")[0]!;
		expect(orphanThread.diagnostics[0]?.code).toBe("MISSING_REPLY_PARENT");
		expect(orphanThread.hierarchy.nodes[1]?.data.missingParent).toBe("<missing>");
		const orphanSiblings = buildMailThreadDefinitions([orphan,
			{ ...orphan, id: "second", headers: { "Message-ID": "<orphan-two>", "In-Reply-To": "<missing>" } },
		], "inbox");
		expect(orphanSiblings).toHaveLength(1);
		expect(orphanSiblings[0]?.messageCount).toBe(2);
		const cycle = buildMailThreadDefinitions([
			{ ...first, id: "one", headers: { "Message-ID": "<one>", "In-Reply-To": "<two>" } },
			{ ...first, id: "two", headers: { "Message-ID": "<two>", "In-Reply-To": "<one>" } },
		], "inbox")[0]!;
		expect(cycle.diagnostics.some((diagnostic) => diagnostic.code === "REPLY_CYCLE")).toBe(true);
		expect(indexResourceHierarchy(cycle.hierarchy).preorder).toHaveLength(3);
	});
});
