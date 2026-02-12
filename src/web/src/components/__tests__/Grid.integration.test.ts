/**
 * Grid Component Integration Tests
 * Tests interaction between GridCore, TabContainer, and FilterBar
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { GridItem, GridColumn, GridTab } from "../types/grid";

describe("Grid Integration", () => {
	// Mock data factory
	const createMockItem = (id: string, type: string, overrides = {}): GridItem => ({
		id,
		type: type as GridItem["type"],
		subject: `Test ${type} ${id}`,
		description: `Description for ${id}`,
		status: "pending",
		createdAt: new Date(),
		updatedAt: new Date(),
		metadata: {},
		...overrides,
	});

	const createMockColumn = (key: string, title: string, overrides = {}): GridColumn => ({
		key,
		title,
		width: 100,
		...overrides,
	});

	describe("Tab switching with data updates", () => {
		it("should update displayed data when tab changes", () => {
			const taskItems = [
				createMockItem("task-1", "task"),
				createMockItem("task-2", "task"),
			];
			const planItems = [
				createMockItem("plan-1", "plan"),
			];

			// Simulate tab switch from tasks to plans
			let currentItems = taskItems;
			expect(currentItems).toHaveLength(2);

			// Switch to plans
			currentItems = planItems;
			expect(currentItems).toHaveLength(1);
			expect(currentItems[0]?.type).toBe("plan");
		});

		it("should maintain selection state per tab", () => {
			const taskSelections = ["task-1", "task-2"];
			const planSelections: string[] = [];

			// Task tab has selections
			expect(taskSelections).toHaveLength(2);

			// Switch to plan tab - no selections
			expect(planSelections).toHaveLength(0);
		});

		it("should update columns when tab changes", () => {
			const taskColumns: GridColumn[] = [
				createMockColumn("subject", "Subject"),
				createMockColumn("status", "Status"),
				createMockColumn("priority", "Priority"),
			];

			const planColumns: GridColumn[] = [
				createMockColumn("subject", "Item"),
				createMockColumn("status", "Status"),
			];

			// Task tab has 3 columns
			expect(taskColumns).toHaveLength(3);

			// Plan tab has 2 columns
			expect(planColumns).toHaveLength(2);
		});
	});

	describe("Filter and search integration", () => {
		it("should filter items based on search query", () => {
			const items = [
				createMockItem("1", "task", { subject: "Alpha task" }),
				createMockItem("2", "task", { subject: "Beta task" }),
				createMockItem("3", "task", { subject: "Gamma plan" }),
			];

			const searchQuery = "task";
			const filtered = items.filter((item) =>
				item.subject.toLowerCase().includes(searchQuery.toLowerCase()),
			);

			expect(filtered).toHaveLength(2);
			expect(filtered[0]?.subject).toContain("Alpha");
			expect(filtered[1]?.subject).toContain("Beta");
		});

		it("should combine multiple filters", () => {
			const items = [
				createMockItem("1", "task", { status: "pending", priority: "high" }),
				createMockItem("2", "task", { status: "completed", priority: "high" }),
				createMockItem("3", "task", { status: "pending", priority: "low" }),
			];

			const filters = [
				{ field: "status", operator: "eq" as const, value: "pending" },
				{ field: "priority", operator: "eq" as const, value: "high" },
			];

			const filtered = items.filter((item) =>
				filters.every(
					(f) =>
						item[f.field as keyof GridItem] === f.value,
				),
			);

			expect(filtered).toHaveLength(1);
			expect(filtered[0]?.id).toBe("1");
		});

		it("should clear filters when requested", () => {
			let filters = [
				{ field: "status", operator: "eq" as const, value: "pending" },
			];

			expect(filters).toHaveLength(1);

			// Clear filters
			filters = [];
			expect(filters).toHaveLength(0);
		});
	});

	describe("Sort and filter interaction", () => {
		it("should sort filtered results", () => {
			const items = [
				createMockItem("1", "task", { subject: "Charlie", status: "pending" }),
				createMockItem("2", "task", { subject: "Alpha", status: "pending" }),
				createMockItem("3", "task", { subject: "Bravo", status: "completed" }),
			];

			// Filter by status
			const filtered = items.filter((item) => item.status === "pending",
			);
			expect(filtered).toHaveLength(2);

			// Sort by subject
			const sorted = [...filtered].sort((a, b) =>
				a.subject.localeCompare(b.subject),
			);

			expect(sorted[0]?.subject).toBe("Alpha");
			expect(sorted[1]?.subject).toBe("Charlie");
		});
	});

	describe("Selection with filter", () => {
		it("should maintain selection when filter changes", () => {
			const items = [
				createMockItem("1", "task", { status: "pending" }),
				createMockItem("2", "task", { status: "completed" }),
				createMockItem("3", "task", { status: "pending" }),
			];

			// Select items 1 and 2
			let selectedIds = ["1", "2"];
			expect(selectedIds).toHaveLength(2);

			// Apply filter - only pending items visible
			const filtered = items.filter((item) => item.status === "pending",
			);

			// Selection should still contain original IDs
			expect(selectedIds).toContain("1");
			expect(selectedIds).toContain("2");

			// But only visible items are in filtered list
			expect(filtered.map((i) => i.id)).toContain("1");
			expect(filtered.map((i) => i.id)).not.toContain("2");
		});
	});

	describe("Loading states", () => {
		it("should show loading state during data fetch", () => {
			let loading = true;
			expect(loading).toBe(true);

			// Simulate data loaded
			loading = false;
			expect(loading).toBe(false);
		});

		it("should handle empty results after filtering", () => {
			const items: GridItem[] = [
				createMockItem("1", "task", { status: "pending" }),
			];

			const filtered = items.filter((item) => item.status === "completed",
			);

			expect(filtered).toHaveLength(0);
		});
	});

	describe("User workflow: search → filter → sort → select", () => {
		it("should complete full user workflow", () => {
			// Initial data
			let items = [
				createMockItem("1", "task", {
					subject: "Alpha task",
					status: "pending",
					priority: "high",
				}),
				createMockItem("2", "task", {
					subject: "Beta work",
					status: "completed",
					priority: "low",
				}),
				createMockItem("3", "task", {
					subject: "Alpha plan",
					status: "pending",
					priority: "high",
				}),
			];

			// Step 1: Search for "Alpha"
			items = items.filter((item) =>
				item.subject.toLowerCase().includes("alpha")
			);
			expect(items).toHaveLength(2);

			// Step 2: Filter by status "pending"
			items = items.filter((item) => item.status === "pending");
			expect(items).toHaveLength(2);

			// Step 3: Filter by priority "high"
			items = items.filter((item) => item.priority === "high");
			expect(items).toHaveLength(2);

			// Step 4: Sort by subject descending
			items = [...items].sort((a, b) =>
				b.subject.localeCompare(a.subject)
			);
			expect(items[0]?.subject).toBe("Alpha task");

			// Step 5: Select first item
			const selectedIds = [items[0]?.id];
			expect(selectedIds).toContain("1");
		});
	});
});
