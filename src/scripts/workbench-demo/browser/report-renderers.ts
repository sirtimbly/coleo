import { RESOURCE_VIEW_SLOTS } from "../../../workbench/resource-view-definition";
import { escapeHtml as html } from "./report-charts";
import { hierarchySnapshot, terminalTreeLines, treeControls, treeDescription } from "./report-tree";

import type { MessagingCollectionPage, MessagingItem } from "../../../workbench/messaging-collection";
import type { ResourceViewControl, ResourceViewDefinition, ResourceViewRenderer } from "../../../workbench/resource-view-definition";
import type { DemoClient, DemoSourceMode } from "../types";
import type { ThreadPreview } from "./report-tree";

export interface PreviewContext {
	readonly view: ResourceViewDefinition;
	readonly page: MessagingCollectionPage;
	readonly client: DemoClient;
	readonly mode: DemoSourceMode;
	readonly selectedId: string | null;
	readonly showDetails: boolean;
	readonly metadata: boolean;
	readonly format: "text" | "json";
	readonly searchText: string;
	readonly tree: ThreadPreview;
	readonly targetId: string | null;
}

const FACETS = [
	["attention", "Needs attention"], ["all", "All resources"], ["messages", "Messages"],
	["brain", "Brain"], ["arms", "Arms"], ["history", "History"],
];
const FIELD_LABELS: Record<string, string> = {
	title: "Resource", summary: "Summary", source: "Source", timestamp: "Time (UTC)", unread: "Unread", requiresAction: "Action",
};

export function currentRenderer(context: PreviewContext): ResourceViewRenderer {
	return context.view.presentation.renderers.find((renderer) => renderer.id === context.view.presentation.active)!;
}

export function snapshotRows(context: PreviewContext): Array<Record<string, string | boolean>> {
	return context.page.items.map((item) => ({
		id: item.id,
		...Object.fromEntries(currentRenderer(context).fields.map((field) => [field, item[field as keyof MessagingItem]])),
	})) as Array<Record<string, string | boolean>>;
}

function fieldValue(item: MessagingItem, field: string): string {
	if (field === "timestamp") return `${item.timestamp.slice(11, 16)} UTC`;
	const value = item[field as keyof MessagingItem];
	if (typeof value === "boolean") return value ? "Yes" : "No";
	return String(value ?? "");
}

function widget(control: ResourceViewControl, context: PreviewContext): string {
	const targets = context.tree.selectedIds.size ? [...context.tree.selectedIds] : context.selectedId ? [context.selectedId] : [];
	const selected = targets.map((id) => context.tree.index.byId.get(id)).filter((node) => node?.selectable);
	const disabled = !selected.some((node) => node!.data.unread && (node!.data.sourceId !== "mail" ||
		node!.data.locations?.some((location) => location.mailbox === "inbox" && !location.seen))) ||
		selected.some((node) => node!.data.sourceId === "mail" && context.mode === "unavailable");
	const label = html(control.label);
	switch (control.widget) {
		case "resource.identity": return `<div class="toolbar-identity"><strong>${label}</strong><small>${html(context.view.id)}</small></div>`;
		case "inbox.facet": return `<label class="toolbar-field">${label}<select data-control="facet" aria-label="View facet">${(context.page.query.scope === "mail" ? FACETS.filter(([id]) => id === "messages") : FACETS).map(([id, name]) => `<option value="${id}"${context.page.query.facet === id ? " selected" : ""}>${name}</option>`).join("")}</select></label>`;
		case "collection.search": return `<label class="search-control"><span class="sr-only">Search resources</span><input data-control="search" type="search" placeholder="Search resources…" aria-label="Search resources" value="${html(context.searchText)}"></label>`;
		case "inbox.mark-read": return `<button class="toolbar-action" data-command="inbox.mark-read" type="button"${disabled ? " disabled" : ""}>${context.tree.selectedIds.size ? "Mark selected read" : label}</button>`;
		case "collection.refresh": return `<button class="toolbar-action" data-command="inbox.refresh" type="button">${label} ↻</button>`;
		case "collection.freshness": return `<span class="source-health ${context.page.summaries.complete ? "" : "partial"}"><span class="status-light"></span>${context.page.summaries.complete ? "Snapshot complete" : "Incomplete snapshot"}</span>`;
		case "collection.sort": return `<label class="toolbar-field">${label}<select data-control="sort" aria-label="Sort resources"><option value="desc"${context.page.query.sort.direction === "desc" ? " selected" : ""}>Newest first</option><option value="asc"${context.page.query.sort.direction === "asc" ? " selected" : ""}>Oldest first</option></select></label>`;
		case "collection.presentation": return `<label class="toolbar-field">${label}<select data-control="presentation" aria-label="Resource presentation">${context.view.presentation.renderers.map((renderer) => `<option value="${html(renderer.id)}"${renderer.id === context.view.presentation.active ? " selected" : ""}>${html(renderer.label)}</option>`).join("")}</select></label>`;
		case "collection.selection": {
			const visible = new Set(context.tree.rows.map((row) => row.node.id));
			const hidden = [...context.tree.selectedIds].filter((id) => !visible.has(id)).length;
			return `<span class="selection-label">${context.tree.selectedIds.size} selected${hidden ? ` · ${hidden} hidden` : ""}</span><button class="toolbar-action" data-control="clear-selection" type="button" ${context.tree.selectedIds.size ? "" : "disabled"}>Clear</button>`;
		}
		case "collection.hierarchy": return `<span class="hierarchy-tools"><button class="toolbar-action" data-control="expand-all" type="button">Expand all</button><button class="toolbar-action" data-control="collapse-all" type="button">Collapse all</button><button class="toolbar-action" data-control="add-reply" type="button"${context.mode !== "healthy" || !context.page.items.some((item) => item.thread?.id === "review") ? " disabled" : ""}>Add reply</button></span>`;
		case "collection.insights": return `<button class="toolbar-action" data-control="metadata" aria-pressed="${context.metadata}" type="button">${label} ${context.metadata ? "−" : "+"}</button>`;
		default: return `<span class="selection-label">${label}: no report adapter</span>`;
	}
}

export function toolbar(tier: "primary" | "secondary", context: PreviewContext): string {
	const controls = RESOURCE_VIEW_SLOTS.filter((slot) => slot.startsWith(`toolbar.${tier}.`))
		.flatMap((slot) => context.view.slots[slot] ?? []);
	return `<div class="view-toolbar ${tier}" role="toolbar" aria-label="${tier === "primary" ? "Primary" : "Secondary"} resource toolbar">${controls.map((control) => widget(control, context)).join("")}</div>`;
}

export function metadataPanel(context: PreviewContext): string {
	if (!context.metadata || !context.view.insights?.panels.length) return "";
	const items = context.page.items;
	const unread = items.filter((item) => item.unread).length;
	const attention = items.filter((item) => item.requiresAction).length;
	const fields = context.view.insights.panels.find((panel) => panel.id === context.view.insights?.active)?.fields ?? [];
	const metrics = [
		...(fields.includes("unread") ? [["Unread", unread] as const] : []),
		...(fields.includes("requiresAction") ? [["Needs action", attention] as const] : []),
	];
	const summary = `${items.length} resources · ${metrics.map(([name, count]) => `${count} ${name.toLowerCase()}`).join(" · ")} · ${context.page.summaries.complete ? "complete" : "incomplete counts"}`;
	if (context.client !== "web") return `<div class="view-metadata" role="region" aria-label="Resource metadata summary"><div class="metadata-text">METADATA / ${html(summary)}<br>Fields: ${html(fields.join(" · "))}</div></div>`;
	return `<div class="view-metadata" role="region" aria-label="Resource metadata overview"><div class="metadata-top"><strong>Metadata overview · ${items.length} resources</strong><span>${context.page.summaries.complete ? "Current query" : "Includes retained source data"}</span></div><div class="metadata-metrics">${metrics.map(([label, count]) => `<div class="metadata-metric"><span>${label}<strong>${count}/${items.length}</strong></span><div class="metric-track"><i style="width:${items.length ? count / items.length * 100 : 0}%"></i></div></div>`).join("")}${fields.includes("timestamp") ? `<span class="metadata-date">Latest: ${items[0] ? html(items[0].timestamp.slice(11, 16)) : "—"} UTC</span>` : ""}</div></div>`;
}

function retainedMarker(item: MessagingItem, context: PreviewContext): string {
	return context.page.sources.some((source) => source.id === item.sourceId && (source.status !== "fresh" || !source.complete))
		? '<span class="retained-label">Retained snapshot</span>' : "";
}

function grid(context: PreviewContext): string {
	const fields = currentRenderer(context).fields;
	return `<table class="resource-table" role="treegrid" aria-label="Threaded resources" aria-multiselectable="true"><thead><tr><th scope="col">Group</th>${fields.map((field) => `<th scope="col">${html(FIELD_LABELS[field] ?? field)}</th>`).join("")}</tr></thead><tbody>${context.tree.rows.map((row) => {
		const item = row.node.data;
		return `<tr data-row-id="${html(row.node.id)}" aria-level="${row.depth + 1}" aria-selected="${context.tree.selectedIds.has(row.node.id)}" ${row.hasChildren ? `aria-expanded="${row.expanded}"` : ""} class="${row.node.id === context.selectedId ? "selected" : ""} ${row.node.kind === "group" ? "thread-group" : ""} ${context.tree.selectedIds.has(row.node.id) ? "member-selected" : ""}"><td>${treeControls(row, context.tree)}</td>${fields.map((field) => field === "title"
			? `<td class="title-cell" style="padding-left:${13 + Math.min(row.depth, 8) * 18}px"><button class="resource-title" type="button" data-resource="${html(item.id)}">${html(item.title)}</button>${retainedMarker(item, context)}<span class="tree-description">${html(treeDescription(row, context.tree))}${row.contextOnly ? " · ancestor context" : ""}</span><span class="resource-id">${html(item.id)}</span></td>`
			: `<td>${typeof item[field as keyof MessagingItem] === "boolean" ? `<span class="boolean-dot ${item[field as "unread" | "requiresAction"] ? "yes" : ""}"></span>` : ""}${html(fieldValue(item, field))}</td>`).join("")}</tr>`;
	}).join("")}</tbody></table>`;
}

function cards(context: PreviewContext): string {
	const fields = currentRenderer(context).fields;
	return `<div class="cards threaded-cards" role="tree" aria-label="Nested message cards" aria-multiselectable="true">${context.tree.rows.map((row) => {
		const item = row.node.data;
		return `<article data-row-id="${html(row.node.id)}" role="treeitem" aria-level="${row.depth + 1}" aria-selected="${context.tree.selectedIds.has(row.node.id)}" ${row.hasChildren ? `aria-expanded="${row.expanded}"` : ""} style="margin-left:${Math.min(row.depth, 8) * 18}px" class="resource-card ${item.id === context.selectedId ? "selected" : ""} ${row.node.kind === "group" ? "thread-group" : ""} ${context.tree.selectedIds.has(row.node.id) ? "member-selected" : ""}"><div class="card-top"><span>${treeControls(row, context.tree)} <i class="severity ${html(item.severity)}"></i> ${fields.includes("source") ? html(item.source) : html(item.kind)}</span><time datetime="${html(item.timestamp)}">${fields.includes("timestamp") ? html(item.timestamp.slice(11, 16)) : ""}</time></div><button class="resource-title" data-resource="${html(item.id)}" type="button">${fields.includes("title") ? html(item.title) : html(item.id)}</button>${fields.includes("summary") ? `<p>${html(item.summary)}</p>` : ""}${retainedMarker(item, context)}<span class="tree-description">${html(treeDescription(row, context.tree))}${row.contextOnly ? " · ancestor context" : ""}</span><span class="resource-id">${html(item.id)}</span></article>`;
	}).join("")}</div>`;
}

function timeline(context: PreviewContext): string {
	return `<div class="reply-tree">${cards(context)}</div>`;
}

export function terminalContent(context: PreviewContext): string {
	const fields = currentRenderer(context).fields;
	const command = `coleo view ${context.view.id} --facet ${context.page.query.facet}` +
		(context.page.query.search ? ` --search ${JSON.stringify(context.page.query.search)}` : "") +
		` --sort timestamp:${context.page.query.sort.direction} --format ${context.format} --tree` +
		(context.tree.expandedIds.size ? ` --expand ${JSON.stringify([...context.tree.expandedIds].join(","))}` : " --collapsed") +
		(context.tree.selectedIds.size ? ` --selected-ids ${JSON.stringify([...context.tree.selectedIds].join(","))}` : "");
	const body = terminalTreeLines(context.tree, fields, context.selectedId).join("\n\n");
	const text = context.client === "cli" && context.format === "json" ? JSON.stringify({ view: context.view.id, query: context.page.query,
		complete: context.page.summaries.complete, sources: context.page.sources, items: snapshotRows(context),
		hierarchy: hierarchySnapshot(context.tree, fields) }, null, 2)
		: `${body}\n\n` +
			`${context.tree.rows.length} visible nodes · ${context.tree.selectedIds.size} selected members · ${context.page.summaries.complete ? "complete snapshot" : "incomplete · retained source rows visible"}`;
	const targets = context.tree.index.preorder.filter((id) => context.tree.index.children.get(id)!.length);
	const argumentsBar = context.client === "cli" ? `<div class="cli-arguments"><label>Group target<select data-control="group-target" aria-label="CLI group target">${targets.map((id) => `<option value="${html(id)}"${id === context.targetId ? " selected" : ""}>${html(context.tree.index.byId.get(id)!.data.title)} · ${html(id)}</option>`).join("")}</select></label><button type="button" data-control="toggle-target"${targets.length ? "" : " disabled"}>Toggle visibility</button><button type="button" data-control="select-target"${targets.length ? "" : " disabled"}>Toggle group selection</button></div>` : "";
	return `<div class="terminal-header"><span>${context.client === "cli" ? "CLI SNAPSHOT / PROPOSED COMMAND SYNTAX" : "TUI / HTML KEYBOARD PREVIEW"}</span><span>${context.client === "cli" ? `<button class="toolbar-action" data-format="${context.format === "json" ? "text" : "json"}" type="button">Show ${context.format === "json" ? "text" : "JSON"}</button>` : "j/k focus · ←/→ fold · space group"}</span></div>${argumentsBar}<pre class="terminal" tabindex="0" aria-label="${context.client === "cli" ? "CLI snapshot output" : "TUI resource list"}">${context.client === "cli" ? `<span class="terminal-command">$ ${html(command)}</span>\n\n` : ""}${html(text)}</pre>${context.client === "tui" ? `<div class="terminal-keys"><button type="button" data-command="inbox.open"><kbd>enter</kbd> inspect</button><button type="button" data-control="select-focused"><kbd>space</kbd> select branch</button><button type="button" data-control="select-node"><kbd>shift+space</kbd> select message</button><button type="button" data-command="inbox.mark-read"><kbd>m</kbd> mark read</button></div>` : ""}`;
}

export function resourceContent(context: PreviewContext): string {
	if (context.client !== "web") return terminalContent(context);
	if (context.page.items.length === 0) return `<div class="empty-view"><strong>${context.page.summaries.complete ? "No resources match this view" : "A requested source is unavailable"}</strong>${context.page.summaries.complete ? "Change the search or facet to explore another scope." : "No previous snapshot is loaded for this query. Recover the source to try again."}</div>`;
	const kind = context.view.presentation.renderers.find((renderer) => renderer.id === context.view.presentation.active)?.kind;
	return kind === "cards" ? cards(context) : kind === "custom" ? timeline(context) : grid(context);
}

export function sourceBar(context: PreviewContext): string {
	return `<div class="view-source-bar">${context.page.sources.map((source) => `<span class="source-chip ${source.status}"><i></i>${html(source.id)} / ${source.status}</span>`).join("")}<span class="source-bar-count">${context.page.items.length} roots · ${context.tree.rows.length}/${context.tree.index.byId.size} nodes visible${context.page.summaries.complete ? "" : " · counts incomplete"}</span></div>`;
}

export function detailPeek(context: PreviewContext): string {
	if (!context.showDetails) return "";
	const row = context.selectedId ? context.tree.index.byId.get(context.selectedId) : undefined;
	const item = row?.data;
	if (!item) return "";
	return `<div class="detail-peek" role="region" aria-label="Focused resource detail"><div class="detail-heading"><strong>${html(item.title)}</strong><button data-control="close-details" type="button">Close ×</button></div>${row?.selectable ? '<button class="toolbar-action" data-control="select-node" type="button">Toggle this message only</button>' : ""}<pre>${html(JSON.stringify({ id: item.id, parentId: row?.parentId, representation: item.representation, revision: item.revision, detail: item.detail }, null, 2))}</pre></div>`;
}
