import { expect, it } from "bun:test";
import { messagingMetadata } from "../messaging-metadata";
import { normalizeMessagingQuery } from "../messaging-query";

import type { MessagingCollectionPage } from "../messaging-collection";

it("metadata preserves unknown query counts and distinguishes loaded timestamps from query-wide counts", () => {
	const page: MessagingCollectionPage = {
		schemaVersion: 1, query: normalizeMessagingQuery(), queryId: "fixture", cursor: null, nextCursor: null,
		items: [], sources: [], summaries: { scope: "query", total: null, unread: null, requiresAction: null, complete: false },
	};
	expect(messagingMetadata(page, ["unread", "requiresAction", "timestamp"])).toEqual([
		{ field: "unread", label: "Unread", value: null, scope: "query" },
		{ field: "requiresAction", label: "Needs action", value: null, scope: "query" },
		{ field: "timestamp", label: "Latest loaded item", value: null, scope: "loaded-window" },
	]);
	expect(messagingMetadata({ ...page, summaries: { ...page.summaries, unread: 0, complete: true } }, ["unread"]))
		.toEqual([{ field: "unread", label: "Unread", value: 0, scope: "query" }]);
});
