import type { GridFilter } from "../../types/grid";

describe("FilterBar types", () => {
	it("should handle search filter", () => {
		const searchFilter: GridFilter = {
			field: "search",
			operator: "contains",
			value: "test query",
		};

		expect(searchFilter.field).toBe("search");
		expect(searchFilter.operator).toBe("contains");
		expect(searchFilter.value).toBe("test query");
	});

	it("should handle status filter", () => {
		const statusFilter: GridFilter = {
			field: "status",
			operator: "eq",
			value: "pending",
		};

		expect(statusFilter.field).toBe("status");
		expect(statusFilter.operator).toBe("eq");
	});

	it("should handle numeric filter", () => {
		const priorityFilter: GridFilter = {
			field: "priority",
			operator: "gte",
			value: 3,
		};

		expect(priorityFilter.operator).toBe("gte");
		expect(priorityFilter.value).toBe(3);
	});
});
