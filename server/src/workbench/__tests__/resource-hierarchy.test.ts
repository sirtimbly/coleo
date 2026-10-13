import { describe, expect, it } from "bun:test";

import { hierarchySelectionSummaries, indexResourceHierarchy, toggleHierarchySelection, visibleHierarchyRows } from "../resource-hierarchy";

import type { ResourceHierarchy } from "../resource-hierarchy";

const tree: ResourceHierarchy<string> = { schemaVersion: 1, complete: true, rootIds: ["thread"], nodes: [
	{ id: "thread", parentId: null, kind: "group", selectable: false, childrenComplete: true, data: "Conversation" },
	{ id: "root", parentId: "thread", kind: "resource", selectable: true, childrenComplete: true, data: "Root message" },
	{ id: "api", parentId: "root", kind: "resource", selectable: true, childrenComplete: true, data: "API branch" },
	{ id: "check", parentId: "api", kind: "resource", selectable: true, childrenComplete: true, data: "API check" },
	{ id: "terminal", parentId: "root", kind: "resource", selectable: true, childrenComplete: true, data: "Terminal branch" },
] };

describe("portable nested resource state", () => {
	it("uses parent-first source order, folds at any depth, and retains filtered ancestor context", () => {
		const index = indexResourceHierarchy(tree);
		expect(visibleHierarchyRows(index, new Set(["thread", "root"])).map((row) => [row.node.id, row.depth]))
			.toEqual([["thread", 0], ["root", 1], ["api", 2], ["terminal", 2]]);
		expect(visibleHierarchyRows(index, new Set(index.preorder), new Set(["check"])).map((row) => [row.node.id, row.contextOnly]))
			.toEqual([["thread", true], ["root", true], ["api", true], ["check", false]]);
		expect(visibleHierarchyRows(index, new Set(), new Set(["check"])).map((row) => row.node.id)).toEqual(["thread"]);
	});

	it("selects exact loaded branch members including collapsed descendants, with tri-state ancestors", () => {
		const index = indexResourceHierarchy(tree);
		const selected = toggleHierarchySelection(index, new Set(), "api");
		expect([...selected]).toEqual(["api", "check"]);
		expect(hierarchySelectionSummaries(index, selected).get("api")?.state).toBe("all");
		expect(hierarchySelectionSummaries(index, selected).get("thread")?.state).toBe("mixed");
		expect(visibleHierarchyRows(index, new Set())).toHaveLength(1);
		expect([...selected]).toEqual(["api", "check"]);
		expect([...toggleHierarchySelection(index, selected, "api")]).toEqual([]);
	});

	it("does not auto-select arrivals and distinguishes incomplete membership from an entire known group", () => {
		const index = indexResourceHierarchy(tree);
		const selected = toggleHierarchySelection(index, new Set(), "api");
		const next = indexResourceHierarchy({ ...tree, nodes: [...tree.nodes,
			{ id: "new", parentId: "api", kind: "resource", selectable: true, childrenComplete: false, data: "New reply" },
		] });
		expect(selected.has("new")).toBe(false);
		expect(hierarchySelectionSummaries(next, selected).get("api"))
			.toMatchObject({ state: "mixed", selected: 2, selectable: 3, complete: false });
	});

	it("keeps individual selection independent from branch selection and rejects malformed graphs", () => {
		const index = indexResourceHierarchy(tree);
		expect([...toggleHierarchySelection(index, new Set(), "api", "node")]).toEqual(["api"]);
		for (const invalid of [
			{ ...tree, nodes: [...tree.nodes, tree.nodes[1]!] },
			{ ...tree, nodes: tree.nodes.map((node) => node.id === "api" ? { ...node, parentId: "missing" } : node) },
			{ ...tree, nodes: tree.nodes.map((node) => node.id === "api" ? { ...node, parentId: "check" } : node) },
		]) expect(() => indexResourceHierarchy(invalid)).toThrow();
	});

	it("indexes and summarizes a deep hierarchy without recursive stack overflow", () => {
		const nodes = Array.from({ length: 10000 }, (_, index) => ({ id: String(index), parentId: index ? String(index - 1) : null,
			kind: "resource" as const, selectable: true, childrenComplete: true, data: index }));
		const index = indexResourceHierarchy({ schemaVersion: 1, complete: true, rootIds: ["0"], nodes });
		expect(visibleHierarchyRows(index, new Set(index.preorder))).toHaveLength(10000);
		expect(hierarchySelectionSummaries(index, new Set(["9999"])).get("0")?.selected).toBe(1);
	});
});
