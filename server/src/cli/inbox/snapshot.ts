import { messagingSourcesForQuery } from "../../workbench/messaging-collection";
import { indexResourceHierarchy, visibleHierarchyRows } from "../../workbench/resource-hierarchy";
import { messagingMetadata } from "../../workbench/messaging-metadata";

import type { InboxApi } from "./api";
import type { InboxOptions } from "./options";
import type { MessagingCollectionPage, MessagingItem } from "../../workbench/messaging-collection";
import type { ResolvedNamedResourceView } from "../../workbench/named-resource-views";

export { terminalText } from "./terminal-text";
export { formatInboxSnapshot } from "./table";

export interface InboxSnapshotRow {
	readonly id: string;
	readonly parentId: string | null;
	readonly depth: number;
	readonly selectable: boolean;
	readonly values: Readonly<Record<string, string | number | boolean | null>>;
}
export interface InboxSnapshot {
	readonly schemaVersion: 1;
	readonly kind: "inbox.snapshot";
	readonly view: ResolvedNamedResourceView;
	readonly query: InboxOptions["query"];
	readonly presentation: { readonly id: string; readonly implementation: string | null; readonly fields: readonly string[] };
	readonly pages: readonly MessagingCollectionPage[];
	readonly items: readonly MessagingItem[];
	readonly rows: readonly InboxSnapshotRow[];
	readonly metadata: ReturnType<typeof messagingMetadata>;
	readonly metadataPanelId: string | null;
	readonly diagnostics: readonly string[];
	readonly complete: boolean;
	readonly traversal: { readonly loadedPages: number; readonly requestedPages: number; readonly nextCursor: string | null; readonly retryCursor: string | null; readonly exhausted: boolean };
}

/** Project declared fields into JSON-safe scalar row values. */
function values(data: object, fields: readonly string[]): InboxSnapshotRow["values"] {
	const source = data as Record<string, unknown>;
	return Object.fromEntries(fields.map((field) => {
		const value = source[field];
		return [field, typeof value === "string" || typeof value === "boolean" || typeof value === "number" ? value : null];
	}));
}

/** Load a bounded, validated page window and project its items, hierarchy, metadata, and coverage. */
export async function loadInboxSnapshot(api: InboxApi, view: ResolvedNamedResourceView, options: InboxOptions): Promise<InboxSnapshot> {
	const pages: MessagingCollectionPage[] = [];
	const diagnostics: string[] = [];
	const items = new Map<string, MessagingItem>();
	const cursors = new Set<string>();
	let cursor = options.cursor;
	let complete = true;
	for (let index = 0; index < options.pages; index++) {
		if (cursor) {
			if (cursors.has(cursor)) throw new Error("Inbox API returned a repeated continuation cursor");
			cursors.add(cursor);
		}
		const page = await api.page(options.query, cursor);
		if (page.nextCursor && (page.nextCursor === cursor || cursors.has(page.nextCursor))) throw new Error("Inbox API returned a repeated continuation cursor");
		pages.push(page);
		for (const item of page.items) {
			if (items.has(item.id)) { complete = false; diagnostics.push(`Repeated item across pages: ${item.id}; traversal stopped`); }
			else items.set(item.id, item);
		}
		const missing = messagingSourcesForQuery(options.query).filter((id) => !page.sources.some((source) => source.id === id));
		for (const id of missing) diagnostics.push(`Source ${id} did not report freshness/completeness`);
		const unhealthy = page.sources.filter((source) => source.status !== "fresh" || !source.complete);
		for (const source of unhealthy) diagnostics.push(`${source.id}: ${source.status}${source.complete ? "" : " / incomplete"}${source.error ? ` (${source.error.message})` : ""}`);
		if (missing.length || unhealthy.length || !page.summaries.complete) complete = false;
		if (!page.summaries.complete) diagnostics.push("Query-wide counts are incomplete");
		if (!complete || !page.nextCursor) break;
		cursor = page.nextCursor;
	}
	const presentation = view.definition.presentation.renderers.find((renderer) => renderer.id === options.presentationId)!;
	const feature = view.features.presentation.find((feature) => feature.id === presentation.id);
	if (feature?.diagnostic) diagnostics.push(feature.diagnostic);
	if (!feature?.implementation || !["collection.grid", "collection.list"].includes(feature.implementation)) {
		diagnostics.push(`No CLI renderer for ${feature?.implementation ?? presentation.renderer}; showing the declared fields as text`);
	}
	const rows: InboxSnapshotRow[] = [];
	for (const item of items.values()) {
		rows.push({ id: item.id, parentId: null, depth: 0, selectable: !item.thread, values: values(item, presentation.fields) });
		if (!item.thread || !options.tree) continue;
		const hierarchy = indexResourceHierarchy(item.thread.hierarchy);
		const expansion = options.expansion;
		const expanded = new Set(expansion === "collapsed" ? [] : expansion === "roots" ? hierarchy.hierarchy.rootIds : hierarchy.preorder);
		for (const row of visibleHierarchyRows(hierarchy, expanded)) {
			if (row.node.id === item.id) continue;
			rows.push({ id: row.node.id, parentId: row.node.parentId, depth: row.depth, selectable: row.node.selectable, values: values(row.node.data, presentation.fields) });
		}
		for (const diagnostic of item.thread.diagnostics) diagnostics.push(`${item.id}: ${diagnostic.message}`);
	}
	const first = pages[0]!;
	const activeMetadata = options.metadataId;
	const metadataFields = view.definition.insights?.panels.find((panel) => panel.id === activeMetadata)?.fields ?? [];
	if (activeMetadata) {
		const metadataFeature = view.features.insights.find((feature) => feature.id === activeMetadata);
		if (metadataFeature?.diagnostic) diagnostics.push(metadataFeature.diagnostic);
	}
	return { schemaVersion: 1, kind: "inbox.snapshot", view, query: options.query,
		presentation: { id: presentation.id, implementation: feature?.implementation ?? null, fields: presentation.fields },
		pages, items: [...items.values()], rows,
		metadata: messagingMetadata({ ...first, items: [...items.values()] }, metadataFields),
		metadataPanelId: activeMetadata,
		diagnostics: [...new Set(diagnostics)], complete,
		traversal: { loadedPages: pages.length, requestedPages: options.pages, nextCursor: complete ? pages.at(-1)!.nextCursor : null,
			retryCursor: complete ? null : pages.at(-1)!.cursor,
			exhausted: complete && pages.at(-1)!.nextCursor === null },
	};
}
