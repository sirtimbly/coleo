import { escapeHtml as html } from "./report-charts";

import type { MessagingItem } from "../../../workbench/messaging-collection";
import type { HierarchySelectionSummary, ResourceHierarchyIndex, ResourceHierarchyRow } from "../../../workbench/resource-hierarchy";

export interface ThreadPreview {
	readonly index: ResourceHierarchyIndex<MessagingItem>;
	readonly rows: readonly ResourceHierarchyRow<MessagingItem>[];
	readonly expandedIds: ReadonlySet<string>;
	readonly selectedIds: ReadonlySet<string>;
	readonly summaries: ReadonlyMap<string, HierarchySelectionSummary>;
}

export function treeControls(row: ResourceHierarchyRow<MessagingItem>, tree: ThreadPreview): string {
	const summary = tree.summaries.get(row.node.id)!;
	return `<span class="tree-controls">${row.hasChildren
		? `<button class="tree-toggle" type="button" data-tree-toggle="${html(row.node.id)}" aria-expanded="${row.expanded}" aria-label="${row.expanded ? "Collapse" : "Expand"} ${html(row.node.data.title)}">${row.expanded ? "▾" : "▸"}</button>`
		: '<span class="tree-leaf" aria-hidden="true">·</span>'}
		<input class="tree-select" type="checkbox" data-select-branch="${html(row.node.id)}" data-state="${summary.state}" ${summary.state === "all" ? "checked" : ""}
			aria-label="Select ${summary.selectable} loaded ${summary.selectable === 1 ? "resource" : "resources"} in ${row.node.kind === "group" ? "thread" : "branch"} ${html(row.node.data.title)}" ${summary.selectable === 0 ? "disabled" : ""}>
	</span>`;
}

export function treeDescription(row: ResourceHierarchyRow<MessagingItem>, tree: ThreadPreview): string {
	const summary = tree.summaries.get(row.node.id)!;
	const sent = row.node.data.locations?.length && row.node.data.locations.every((location) => location.mailbox === "sent");
	if (row.hasChildren) return `${summary.selectable} loaded ${row.node.kind === "group" ? "messages" : "members"}${row.expanded ? "" : " · collapsed"}${summary.complete ? "" : " · incomplete"}${sent ? " · sent context, read-only" : ""}`;
	return row.depth ? sent ? "Sent context, read-only" : tree.index.byId.get(row.node.parentId!)?.kind === "group" ? "Root message" : "Reply message" : "Resource";
}

export function hierarchySnapshot(tree: ThreadPreview, fields: readonly string[]): object {
	const visible = new Set(tree.rows.map((row) => row.node.id));
	return {
		schemaVersion: 1, rootIds: tree.index.hierarchy.rootIds, complete: tree.index.hierarchy.complete,
		nodes: tree.index.hierarchy.nodes.map((node) => ({ id: node.id, parentId: node.parentId,
			kind: node.kind, selectable: node.selectable, childrenComplete: node.childrenComplete,
			data: Object.fromEntries(fields.map((field) => [field, node.data[field as keyof MessagingItem]])),
		})),
		visibility: { expandedIds: [...tree.expandedIds], visibleIds: [...visible] },
		selection: { scope: "loaded-descendants", memberIds: [...tree.selectedIds],
			hiddenSelected: [...tree.selectedIds].filter((id) => !visible.has(id)).length },
	};
}

export function terminalTreeLines(tree: ThreadPreview, fields: readonly string[], focusId: string | null): string[] {
	return tree.rows.map((row) => {
		const selected = tree.summaries.get(row.node.id)!.state;
		const check = selected === "all" ? "[x]" : selected === "mixed" ? "[~]" : "[ ]";
		const arrow = row.hasChildren ? row.expanded ? "▾" : "▸" : "·";
		const path: string[] = [];
		let ancestor = row.node.parentId;
		while (ancestor !== null) { path.unshift(ancestor); ancestor = tree.index.byId.get(ancestor)!.parentId; }
		const isLast = (id: string): boolean => {
			const parent = tree.index.byId.get(id)!.parentId;
			return (parent === null ? tree.index.hierarchy.rootIds : tree.index.children.get(parent)!).at(-1) === id;
		};
		const indent = path.slice(1).map((id) => isLast(id) ? "   " : "│  ").join("") +
			(row.depth ? isLast(row.node.id) ? "└─ " : "├─ " : "");
		const detail = fields.filter((field) => field !== "title").map((field) => {
			const value = row.node.data[field as keyof MessagingItem];
			return `${field}: ${typeof value === "boolean" ? value ? "yes" : "no" : String(value ?? "")}`;
		}).join(" · ");
		return `${row.node.id === focusId ? "›" : " "} ${indent}${arrow} ${check} ${row.node.data.title}\n` +
			`  ${"  ".repeat(row.depth)}   ${treeDescription(row, tree)} · ${row.node.id}\n` +
			(detail ? `  ${"  ".repeat(row.depth)}   ${detail}` : "");
	});
}
