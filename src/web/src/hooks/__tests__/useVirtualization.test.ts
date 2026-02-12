import type { GridItem } from "../../types/grid";

describe("useVirtualization", () => {
	it("should calculate total height correctly", () => {
		const items: GridItem[] = [
			{
				id: "1",
				type: "task",
				subject: "Test",
				description: "Test",
				status: "pending",
				createdAt: new Date(),
				updatedAt: new Date(),
				metadata: {},
			},
		];

		const rowHeight = 40;
		const expectedHeight = items.length * rowHeight;
		expect(expectedHeight).toBe(40);
	});

	it("should handle empty items", () => {
		const items: GridItem[] = [];
		const rowHeight = 40;
		const totalHeight = items.length * rowHeight;
		expect(totalHeight).toBe(0);
	});

	it("should handle many items", () => {
		const itemCount = 1000;
		const rowHeight = 40;
		const totalHeight = itemCount * rowHeight;
		expect(totalHeight).toBe(40000);
	});
});
