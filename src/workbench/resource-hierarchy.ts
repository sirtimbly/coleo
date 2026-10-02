/** Serializable relationships; expansion/focus and selection are independent client-owned state. */
export interface ResourceHierarchyNode<T> {
	readonly id: string;
	readonly parentId: string | null;
	readonly kind: "group" | "resource";
	readonly selectable: boolean;
	readonly childrenComplete: boolean;
	readonly data: T;
}

export interface ResourceHierarchy<T> {
	readonly schemaVersion: 1;
	readonly rootIds: readonly string[];
	/** Node order establishes sibling order. Presentation never re-sorts replies into a flat timeline. */
	readonly nodes: readonly ResourceHierarchyNode<T>[];
	readonly complete: boolean;
}

export interface ResourceHierarchyIndex<T> {
	readonly hierarchy: ResourceHierarchy<T>;
	readonly byId: ReadonlyMap<string, ResourceHierarchyNode<T>>;
	readonly children: ReadonlyMap<string, readonly string[]>;
	readonly preorder: readonly string[];
}

export interface ResourceHierarchyRow<T> {
	readonly node: ResourceHierarchyNode<T>;
	readonly depth: number;
	readonly expanded: boolean;
	readonly hasChildren: boolean;
	readonly contextOnly: boolean;
}

export interface HierarchySelectionSummary {
	readonly state: "none" | "mixed" | "all";
	readonly selected: number;
	readonly selectable: number;
	readonly complete: boolean;
}

export function indexResourceHierarchy<T>(hierarchy: ResourceHierarchy<T>): ResourceHierarchyIndex<T> {
	if (hierarchy.schemaVersion !== 1) throw new Error("Unsupported hierarchy schema version");
	const byId = new Map<string, ResourceHierarchyNode<T>>();
	const children = new Map<string, string[]>();
	for (const node of hierarchy.nodes) {
		if (!node.id || byId.has(node.id)) throw new Error(`Duplicate or empty hierarchy ID: ${node.id}`);
		byId.set(node.id, node);
		children.set(node.id, []);
	}
	for (const node of hierarchy.nodes) {
		if (node.parentId !== null) {
			if (!byId.has(node.parentId)) throw new Error(`Missing parent ${node.parentId} for ${node.id}`);
			children.get(node.parentId)!.push(node.id);
		}
	}
	const rootSet = new Set(hierarchy.rootIds);
	if (rootSet.size !== hierarchy.rootIds.length || hierarchy.rootIds.some((id) => !byId.has(id))) {
		throw new Error("Hierarchy roots must be unique, known nodes");
	}
	if (hierarchy.nodes.some((node) => (node.parentId === null) !== rootSet.has(node.id))) {
		throw new Error("Hierarchy root IDs must match parentless nodes");
	}
	const preorder: string[] = [];
	const stack = [...hierarchy.rootIds].reverse();
	const visited = new Set<string>();
	while (stack.length) {
		const id = stack.pop()!;
		if (visited.has(id)) throw new Error(`Hierarchy cycle at ${id}`);
		visited.add(id);
		preorder.push(id);
		const childIds = children.get(id)!;
		for (let child = childIds.length - 1; child >= 0; child--) stack.push(childIds[child]!);
	}
	if (visited.size !== byId.size) throw new Error("Hierarchy contains a disconnected cycle");
	return { hierarchy, byId, children, preorder };
}

/** Filtering retains ancestor context; expansion is still explicit, including during search. */
export function visibleHierarchyRows<T>(
	index: ResourceHierarchyIndex<T>, expandedIds: ReadonlySet<string>, matches?: ReadonlySet<string>,
): ResourceHierarchyRow<T>[] {
	const included = matches ? new Set(matches) : undefined;
	if (included) {
		for (const id of index.preorder.slice().reverse()) {
			if (included.has(id)) {
				const parent = index.byId.get(id)!.parentId;
				if (parent !== null) included.add(parent);
			}
		}
	}
	const rows: ResourceHierarchyRow<T>[] = [];
	const stack = index.hierarchy.rootIds.slice().reverse().map((id) => ({ id, depth: 0 }));
	while (stack.length) {
		const { id, depth } = stack.pop()!;
		if (included && !included.has(id)) continue;
		const node = index.byId.get(id)!;
		const childIds = index.children.get(id)!;
		const expanded = expandedIds.has(id);
		rows.push({ node, depth, expanded, hasChildren: childIds.length > 0 || !node.childrenComplete,
			contextOnly: matches !== undefined && !matches.has(id) });
		if (expanded) for (let child = childIds.length - 1; child >= 0; child--) {
			stack.push({ id: childIds[child]!, depth: depth + 1 });
		}
	}
	return rows;
}

export function hierarchySelectionSummaries<T>(
	index: ResourceHierarchyIndex<T>, selectedIds: ReadonlySet<string>,
): ReadonlyMap<string, HierarchySelectionSummary> {
	const summaries = new Map<string, HierarchySelectionSummary>();
	for (const id of index.preorder.slice().reverse()) {
		const node = index.byId.get(id)!;
		const descendants = index.children.get(id)!.map((child) => summaries.get(child)!);
		const selectable = Number(node.selectable) + descendants.reduce((sum, child) => sum + child.selectable, 0);
		const selected = Number(node.selectable && selectedIds.has(id)) + descendants.reduce((sum, child) => sum + child.selected, 0);
		summaries.set(id, {
			selected, selectable, state: selected === 0 ? "none" : selected === selectable ? "all" : "mixed",
			complete: node.childrenComplete && descendants.every((child) => child.complete),
		});
	}
	return summaries;
}

export function hierarchySubtreeIds<T>(index: ResourceHierarchyIndex<T>, id: string): string[] {
	if (!index.byId.has(id)) throw new Error(`Unknown hierarchy node: ${id}`);
	const ids: string[] = [];
	const stack = [id];
	while (stack.length) {
		const current = stack.pop()!;
		ids.push(current);
		const childIds = index.children.get(current)!;
		for (let child = childIds.length - 1; child >= 0; child--) stack.push(childIds[child]!);
	}
	return ids;
}

/** A branch selection is a snapshot of explicit loaded resource IDs, not a predicate over future replies. */
export function toggleHierarchySelection<T>(
	index: ResourceHierarchyIndex<T>, selectedIds: ReadonlySet<string>, id: string, scope: "node" | "subtree" = "subtree",
): ReadonlySet<string> {
	const members = (scope === "subtree" ? hierarchySubtreeIds(index, id) : [id])
		.filter((member) => index.byId.get(member)?.selectable);
	const result = new Set(selectedIds);
	const clear = members.length > 0 && members.every((member) => result.has(member));
	for (const member of members) { if (clear) result.delete(member); else result.add(member); }
	return result;
}
