import { messagingSourcesForQuery, projectMessagingItems } from "../../workbench/messaging-collection";
import { messagingQueryIdentity } from "../../workbench/messaging-query";

import type { MessagingCollectionPage, MessagingItem } from "../../workbench/messaging-collection";
import type { MessagingQuery } from "../../workbench/messaging-query";
import type { DemoSourceMode } from "./types";

/** Fixture snapshot adapter for the report. Production sources will supply the same contract through HTTP. */
export function fixtureSnapshot(
	items: readonly MessagingItem[], query: MessagingQuery, mode: DemoSourceMode,
): MessagingCollectionPage {
	const projected = projectMessagingItems(items, query);
	const requestedSources = messagingSourcesForQuery(query);
	const selected = projected.filter((item) => requestedSources.includes(item.sourceId) &&
		(item.sourceId !== "mail" || mode === "healthy"));
	const sources = requestedSources.map((id) => ({
		id, status: id === "mail" && mode === "unavailable" ? "unavailable" as const : "fresh" as const,
		revision: id === "mail" && mode === "unavailable" ? null : "fixture-source-r1",
		asOf: id === "mail" && mode === "unavailable" ? null : "2026-10-01T13:00:00.000Z",
		complete: id !== "mail" || mode !== "unavailable",
		...(id === "mail" && mode === "unavailable" ? {
			error: { code: "DEMO_MAIL_UNAVAILABLE", message: "Mail source unavailable in the fixture scenario" },
		} : {}),
	}));
	return {
		schemaVersion: 1, query, queryId: messagingQueryIdentity(query), cursor: null, nextCursor: null,
		items: selected, sources,
		summaries: {
			scope: "query", total: selected.length, unread: selected.filter((item) => item.unread).length,
			requiresAction: selected.filter((item) => item.requiresAction).length,
			complete: sources.every((source) => source.complete),
		},
	};
}
