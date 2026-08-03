/**
 * Contract and scale checks for the production Tabulator sheet data boundary.
 *
 * The thresholds intentionally cover Coleo's 1k, 10k, and 50k decision gate.
 * They measure the application-owned projection path; browser virtualization,
 * editing, resizing, and mount cycles remain protected by Playwright.
 */

import { describe, expect, it } from "bun:test";

import {
	areProjectedResourceRowsEqual,
	projectResourceRows,
	resolveResourceColumns,
	resolveResourceRowMove,
} from "../src/workbench/resource-sheet-model";

interface BenchmarkRow {
	id: string;
	subject: string;
	status: string;
	progress: number;
	tags: string[];
	updatedAt: string;
}

const COLUMNS = [
	{ id: "subject", read: (row: BenchmarkRow) => row.subject, width: 360 },
	{ id: "status", read: (row: BenchmarkRow) => row.status, width: 128 },
	{ id: "progress", read: (row: BenchmarkRow) => row.progress, width: 92 },
	{ id: "tags", read: (row: BenchmarkRow) => row.tags, width: 180 },
	{ id: "updatedAt", read: (row: BenchmarkRow) => row.updatedAt, width: 170 },
];

function rows(count: number): BenchmarkRow[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `row-${index}`,
		subject: `Benchmark task ${index}`,
		status: index % 5 === 0 ? "completed" : "pending",
		progress: index % 101,
		tags: [`batch-${index % 20}`, index % 2 === 0 ? "even" : "odd"],
		updatedAt: new Date(1_786_000_000_000 + index * 1_000).toISOString(),
	}));
}

describe("resource sheet model", () => {
	it("applies saved column visibility and order without mutating definitions", () => {
		const resolved = resolveResourceColumns(COLUMNS, [
			{ id: "status", order: 0, visible: true },
			{ id: "subject", order: 1, visible: true },
			{ id: "progress", order: 2, visible: false },
		]);

		expect(resolved.map((column) => column.id)).toEqual([
			"status",
			"subject",
			"tags",
			"updatedAt",
		]);
		expect(COLUMNS.map((column) => column.id)).toEqual([
			"subject",
			"status",
			"progress",
			"tags",
			"updatedAt",
		]);
	});

	it("projects filters and translates manual moves into the shared contract", () => {
		const source = rows(5);
		const projection = projectResourceRows(source, COLUMNS, [{
			field: "status",
			operator: "equals",
			value: "pending",
		}]);
		expect(projection.filteredRows).toHaveLength(4);
		expect(projection.sheetRows[0]).toMatchObject({
			__resourceId: "row-1",
			subject: "Benchmark task 1",
		});

		const move = resolveResourceRowMove(
			new Map(source.map((row) => [row.id, row])),
			"row-0",
			0,
			["row-1", "row-2", "row-0", "row-3", "row-4"],
		);
		expect(move).toMatchObject({
			row: source[0],
			fromIndex: 0,
			toIndex: 2,
			previousRow: source[2],
			nextRow: source[3],
		});
	});

	it("skips identical live reconciliations but detects changed cells", () => {
		const projection = projectResourceRows(rows(2), COLUMNS, []);
		const sameRows = projection.sheetRows.map((row) => ({
			...row,
			tags: [...(row.tags as string[])],
		}));
		expect(areProjectedResourceRowsEqual(projection.sheetRows, sameRows)).toBe(true);
		expect(areProjectedResourceRowsEqual(projection.sheetRows, [
			{ ...sameRows[0], subject: "Streamed subject update" },
			sameRows[1],
		])).toBe(false);
	});

	for (const benchmark of [
		{ count: 1_000, thresholdMs: 50 },
		{ count: 10_000, thresholdMs: 250 },
		{ count: 50_000, thresholdMs: 1_250 },
	]) {
		it(`projects ${benchmark.count.toLocaleString()} rows within ${benchmark.thresholdMs}ms`, () => {
			const source = rows(benchmark.count);
			const startedAt = performance.now();
			const projection = projectResourceRows(source, COLUMNS, []);
			const elapsed = performance.now() - startedAt;

			expect(projection.sheetRows).toHaveLength(benchmark.count);
			expect(projection.rowsById.size).toBe(benchmark.count);
			expect(elapsed).toBeLessThan(benchmark.thresholdMs);
		});
	}
});
