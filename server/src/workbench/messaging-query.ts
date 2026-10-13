/** Portable Messaging query semantics. Cursors and request generations are not query settings. */
import { z } from "zod";

export const MESSAGING_FACETS = ["attention", "messages", "brain", "arms", "history", "all"] as const;
export const MESSAGING_MAILBOXES = ["inbox", "sent", "archive"] as const;
export const MESSAGING_BRAIN_CATEGORIES = ["all", "operations", "tasks", "arms", "decisions", "planning", "alerts"] as const;
export const MESSAGING_ITEM_KINDS = ["brain", "arm", "project", "status", "proposal", "system"] as const;

export type MessagingFacet = typeof MESSAGING_FACETS[number];
export type MessagingMailbox = typeof MESSAGING_MAILBOXES[number];
export type MessagingBrainCategory = typeof MESSAGING_BRAIN_CATEGORIES[number];
export type MessagingItemKind = typeof MESSAGING_ITEM_KINDS[number];

export type MessagingFilter =
	| { readonly field: "kind"; readonly operator: "in" | "notIn"; readonly value: readonly MessagingItemKind[] }
	| { readonly field: "unread" | "requiresAction"; readonly operator: "equals"; readonly value: boolean }
	| { readonly field: "timestamp"; readonly operator: "before" | "after"; readonly value: string };

export interface MessagingQuery {
	readonly schemaVersion: 1;
	readonly scope: "inbox" | "mail";
	readonly profileId: string;
	readonly facet: MessagingFacet;
	readonly mailbox: MessagingMailbox;
	readonly brainCategory: MessagingBrainCategory;
	readonly search: string;
	readonly filters: readonly MessagingFilter[];
	readonly sort: { readonly field: "timestamp"; readonly direction: "asc" | "desc" };
	readonly limit: number;
}

const filterSchema = z.union([
	z.object({
		field: z.literal("kind"), operator: z.enum(["in", "notIn"]), value: z.array(z.enum(MESSAGING_ITEM_KINDS)),
	}).strict(),
	z.object({
		field: z.enum(["unread", "requiresAction"]), operator: z.literal("equals"), value: z.boolean(),
	}).strict(),
	z.object({
		field: z.literal("timestamp"), operator: z.enum(["before", "after"]), value: z.iso.datetime({ offset: true }),
	}).strict(),
]);

const querySchema = z.object({
	schemaVersion: z.literal(1).default(1),
	scope: z.enum(["inbox", "mail"]).default("inbox"),
	profileId: z.string().trim().min(1).default("local"),
	facet: z.enum(MESSAGING_FACETS).optional(),
	mailbox: z.enum(MESSAGING_MAILBOXES).default("inbox"),
	brainCategory: z.enum(MESSAGING_BRAIN_CATEGORIES).default("all"),
	search: z.string().default(""),
	filters: z.array(filterSchema).default([]),
	sort: z.object({ field: z.literal("timestamp"), direction: z.enum(["asc", "desc"]) }).strict()
		.default({ field: "timestamp", direction: "desc" }),
	limit: z.number().int().min(1).max(200).default(100),
}).strict();

/** AND filters commute; set-valued filters and duplicate clauses have one canonical identity. */
/** Validate query input and canonicalize defaults, filters, and facet-specific scope for every client. */
export function normalizeMessagingQuery(value: unknown = {}): MessagingQuery {
	const parsed = querySchema.parse(value);
	if (parsed.scope === "mail" && parsed.facet !== undefined && parsed.facet !== "messages") {
		throw new Error("Mail scope only supports the messages facet");
	}
	const facet = parsed.facet ?? (parsed.scope === "mail" ? "messages" : "attention");
	const filters = parsed.filters.map((filter): MessagingFilter => {
		if (filter.field === "kind") {
			return { ...filter, value: [...new Set(filter.value)].sort() };
		}
		if (filter.field === "timestamp") return { ...filter, value: new Date(filter.value).toISOString() };
		return filter;
	});
	const byIdentity = new Map(filters.map((filter) => [JSON.stringify(filter), filter]));
	return {
		schemaVersion: 1,
		scope: parsed.scope,
		profileId: parsed.profileId,
		facet,
		mailbox: facet === "messages" ? parsed.mailbox : "inbox",
		brainCategory: facet === "brain" ? parsed.brainCategory : "all",
		search: parsed.search.trim().toLowerCase(),
		filters: [...byIdentity.entries()].sort(([left], [right]) => compareText(left, right)).map(([, filter]) => filter),
		sort: { field: "timestamp", direction: parsed.sort.direction },
		limit: parsed.limit,
	};
}

/** Produce the canonical serialized identity used to bind collection pages and cursors to a query. */
export function messagingQueryIdentity(query: MessagingQuery): string {
	return JSON.stringify(normalizeMessagingQuery(query));
}

export interface MessagingPosition {
	readonly timestamp: string;
	readonly id: string;
}

function compareText(left: string, right: string): number {
	if (left === right) return 0;
	let leftIndex = 0;
	let rightIndex = 0;
	while (leftIndex < left.length && rightIndex < right.length) {
		const leftPoint = left.codePointAt(leftIndex)!;
		const rightPoint = right.codePointAt(rightIndex)!;
		if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
		leftIndex += leftPoint > 0xffff ? 2 : 1;
		rightIndex += rightPoint > 0xffff ? 2 : 1;
	}
	return leftIndex < left.length ? 1 : -1;
}

/** Canonical UTC timestamps and binary ID ordering match SQLite keyset predicates, independent of locale. */
export function compareMessagingPositions(
	left: MessagingPosition,
	right: MessagingPosition,
	direction: "asc" | "desc" = "desc",
): number {
	const comparison = compareText(left.timestamp, right.timestamp) || compareText(left.id, right.id);
	return direction === "asc" ? comparison : -comparison;
}
