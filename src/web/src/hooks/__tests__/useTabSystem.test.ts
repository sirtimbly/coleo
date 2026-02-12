import type { GridTab, GridItemType } from "../types/grid";

describe("useTabSystem types", () => {
	it("should have correct tab structure", () => {
		const mockTab: GridTab = {
			id: "task" as GridItemType,
			label: "Tasks",
			columns: [
				{ key: "subject", title: "Subject", width: 300, sortable: true },
			],
			defaultSort: [{ field: "updatedAt", direction: "desc" }],
		};

		expect(mockTab.id).toBe("task");
		expect(mockTab.label).toBe("Tasks");
		expect(mockTab.columns).toHaveLength(1);
	});

	it("should support all item types", () => {
		const types: GridItemType[] = ["task", "plan", "discovery"];
		expect(types).toContain("task");
		expect(types).toContain("plan");
		expect(types).toContain("discovery");
	});
});
