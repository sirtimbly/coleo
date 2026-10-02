import { compareMessagingPositions } from "./messaging-query";

import type { MessagingBrainCategory, MessagingItemKind, MessagingMailbox, MessagingQuery } from "./messaging-query";
import type { MailThreadLocation, MailThreadProjection } from "./mail-thread-model";

export type MessagingSourceId = "records" | "mail" | "activity" | "events";

export function messagingSourcesForQuery(query: MessagingQuery): readonly MessagingSourceId[] {
	if (query.scope === "mail" || query.facet === "messages") return ["mail"];
	if (query.facet === "attention" || query.facet === "all") return ["records", "mail", "activity", "events"];
	return ["records", "activity", "events"];
}

export interface MessagingItem {
	readonly id: string;
	/** Opaque data revision, including attention state; never a request generation. */
	readonly revision: string;
	readonly sourceId: MessagingSourceId;
	readonly representation: "resource" | "event" | "thread" | "message";
	readonly thread?: MailThreadProjection;
	readonly locations?: readonly MailThreadLocation[];
	readonly kind: MessagingItemKind;
	readonly title: string;
	readonly summary: string;
	readonly timestamp: string;
	readonly source: string;
	readonly resource?: { readonly kind: string; readonly id: string };
	readonly unread: boolean;
	readonly requiresAction: boolean;
	readonly severity: "info" | "success" | "warning" | "danger";
	readonly brainCategory?: Exclude<MessagingBrainCategory, "all">;
	/** Semantic detail handoff, resolved by each client rather than a browser route. */
	readonly detail:
		| { readonly kind: "record"; readonly itemKey: string }
		| { readonly kind: "thread"; readonly threadId: string; readonly mailbox: MessagingMailbox }
		| { readonly kind: "message"; readonly threadId: string; readonly messageId: string; readonly mailbox: MessagingMailbox }
		| { readonly kind: "activity"; readonly activityId: string; readonly sequence: number | null }
		| { readonly kind: "event"; readonly itemKey: string; readonly sequence: number };
}

/** Pure recipe projection for snapshot adapters. API adapters must apply it before paging, never after a short prefix. */
export function projectMessagingItems(items: readonly MessagingItem[], query: MessagingQuery): MessagingItem[] {
	const planningBlocked = query.facet === "attention" && items.some((item) =>
		item.id === "brain:planning-gate" && item.requiresAction);
	return items.filter((item) => {
		if (item.detail.kind === "thread" && item.detail.mailbox !== query.mailbox) return false;
		if (query.facet === "attention" && (planningBlocked ? item.id !== "brain:planning-gate" : !item.requiresAction)) {
			return false;
		}
		if (query.facet === "messages" && (item.kind !== "project" ||
			item.detail.kind !== "thread" || item.detail.mailbox !== query.mailbox)) return false;
		if (query.facet === "brain" && (item.kind !== "brain" ||
			(query.brainCategory !== "all" && item.brainCategory !== query.brainCategory))) return false;
		if (query.facet === "arms" && item.kind !== "arm" && item.kind !== "status") return false;
		if (query.facet === "history" && item.kind === "project") return false;
		if (query.search && !`${item.title} ${item.summary} ${item.source}`.toLowerCase().includes(query.search) &&
			!item.thread?.hierarchy.nodes.some((node) => `${node.data.title} ${node.data.summary} ${node.data.source}`
				.toLowerCase().includes(query.search))) return false;
		return query.filters.every((filter) => {
			if (filter.field === "kind") {
				return filter.operator === "in" ? filter.value.includes(item.kind) : !filter.value.includes(item.kind);
			}
			if (filter.field === "timestamp") {
				return filter.operator === "before"
					? Date.parse(item.timestamp) < Date.parse(filter.value)
					: Date.parse(item.timestamp) > Date.parse(filter.value);
			}
			return item[filter.field] === filter.value;
		});
	}).sort((left, right) => compareMessagingPositions(left, right, query.sort.direction));
}

export interface MessagingSourceState {
	readonly id: MessagingSourceId;
	readonly status: "fresh" | "stale" | "unavailable";
	readonly revision: string | null;
	readonly asOf: string | null;
	/** Authoritative coverage of this requested page, not exhaustion of all retained history. */
	readonly complete: boolean;
	readonly error?: { readonly code: string; readonly message: string };
}

export interface MessagingCollectionPage {
	readonly schemaVersion: 1;
	readonly query: MessagingQuery;
	readonly queryId: string;
	readonly cursor: string | null;
	readonly nextCursor: string | null;
	readonly items: readonly MessagingItem[];
	readonly sources: readonly MessagingSourceState[];
	readonly summaries: {
		/** Counts are for this query before paging, never unrequested/hidden facets. */
		readonly scope: "query";
		readonly total: number | null;
		readonly unread: number | null;
		readonly requiresAction: number | null;
		readonly complete: boolean;
	};
}

/**
 * Retain a previous source section only in the same query/page cache entry.
 * An authoritative empty section clears old rows. A partial page cannot advance
 * traversal: retry it rather than silently stepping past an unavailable source.
 */
export function reconcileMessagingPage(
	previous: MessagingCollectionPage | undefined,
	incoming: MessagingCollectionPage,
): MessagingCollectionPage {
	const canRetain = previous?.queryId === incoming.queryId && previous.cursor === incoming.cursor;
	const sources = [...incoming.sources];
	for (const id of messagingSourcesForQuery(incoming.query)) {
		if (!sources.some((source) => source.id === id)) sources.push({
			id, status: "unavailable", revision: null, asOf: null, complete: false,
			error: { code: "SOURCE_STATE_MISSING", message: `No source state was returned for ${id}` },
		});
	}
	const authoritative = new Set(sources
		.filter((source) => source.status === "fresh" && source.complete)
		.map((source) => source.id));
	const items = new Map(incoming.items.map((item) => [item.id, item]));
	if (canRetain) {
		for (const item of previous.items) {
			if (!authoritative.has(item.sourceId)) items.set(item.id, item);
		}
	}
	const complete = sources.every((source) => source.status === "fresh" && source.complete);
	return {
		...incoming,
		sources,
		items: [...items.values()].sort((left, right) => compareMessagingPositions(left, right, incoming.query.sort.direction)),
		nextCursor: complete ? incoming.nextCursor : null,
		summaries: { ...incoming.summaries, complete: incoming.summaries.complete && complete },
	};
}
