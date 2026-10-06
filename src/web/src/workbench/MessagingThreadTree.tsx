import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { indexResourceHierarchy, hierarchySelectionSummaries, toggleHierarchySelection, visibleHierarchyRows } from "../../../workbench/resource-hierarchy";

import type { MailThreadProjection } from "../../../workbench/mail-thread-model";

export function MessagingThreadTree({ thread, selectedIds, onSelectionChange, onOpenMessage }: {
	thread: MailThreadProjection;
	selectedIds: ReadonlySet<string>;
	onSelectionChange: (ids: ReadonlySet<string>) => void;
	onOpenMessage: (messageId: string) => void;
}) {
	const index = useMemo(() => indexResourceHierarchy(thread.hierarchy), [thread.hierarchy]);
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
	const expanded = new Set(index.preorder.filter((id) => !collapsed.has(id)));
	const rows = visibleHierarchyRows(index, expanded).filter((row) => row.node.selectable);
	const summaries = hierarchySelectionSummaries(index, selectedIds);
	const visibleIds = new Set(rows.map((row) => row.node.id));
	const selected = index.preorder.filter((id) => selectedIds.has(id));
	const hidden = selected.filter((id) => !visibleIds.has(id)).length;
	return <div className="border-t border-border bg-surface-secondary/20 p-3" role="tree" aria-label={`Replies in ${thread.subject}`} aria-multiselectable="true">
		{selected.length > 0 && <p role="status" className="mb-2 text-[0.65rem] text-muted-foreground">{selected.length} selected in this conversation{hidden ? ` · ${hidden} hidden` : ""}</p>}
		{rows.map((row) => {
			const state = summaries.get(row.node.id)!;
			return <div key={row.node.id} role="treeitem" aria-level={row.depth} aria-selected={selectedIds.has(row.node.id)}
				aria-expanded={row.hasChildren ? row.expanded : undefined} data-message-node-id={row.node.id}
				className="mb-2 border-l border-border py-2 pl-3" style={{ marginLeft: `${Math.max(0, row.depth - 1) * 16}px` }}>
				<div className="flex items-center gap-2">
					{row.hasChildren ? <button type="button" aria-label={`${row.expanded ? "Collapse" : "Expand"} replies to ${row.node.data.title}`}
						aria-expanded={row.expanded} className="rounded p-1 text-muted-foreground hover:bg-surface-secondary"
						onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(row.node.id)) next.delete(row.node.id); else next.add(row.node.id); return next; })}>
						{row.expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
					</button> : <span className="w-5" />}
					<input type="checkbox" aria-label={`Select loaded branch ${row.node.data.title}`} checked={state.state === "all"}
						ref={(input) => { if (input) input.indeterminate = state.state === "mixed"; }}
						onChange={() => onSelectionChange(toggleHierarchySelection(index, selectedIds, row.node.id))} />
					<button type="button" onClick={() => onOpenMessage(row.node.data.messageId!)} className="min-w-0 text-left text-xs font-medium text-foreground hover:text-accent">
						{row.node.data.title}
					</button>
					<span className="ml-auto shrink-0 text-[0.65rem] text-muted-foreground">{row.node.data.unread ? "Unread" : "Read"}</span>
				</div>
				<p className="mt-1 pl-8 text-[0.7rem] text-muted-foreground">{row.node.data.source} · {row.node.data.summary}</p>
			</div>;
		})}
	</div>;
}
