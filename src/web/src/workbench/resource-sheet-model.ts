/**
 * Pure data model for Coleo's vendor-neutral resource sheet boundary.
 *
 * Tabulator owns rendering and interaction, while these helpers keep saved
 * columns, filters, row projection, and move payloads deterministic and easy
 * to benchmark without mounting a browser grid.
 */

import type {
	ColumnPreference,
	ProjectionFilter,
	ViewPreferences,
} from "./types";

export interface ResourceSheetColumnModel<T> {
	id: string;
	read: (row: T) => unknown;
	width?: number;
}

export interface ResourceSheetDataRow {
	__resourceId: string;
	[columnId: string]: unknown;
}

export interface ResourceSheetRowMoveModel<T> {
	row: T;
	fromIndex: number;
	toIndex: number;
	previousRow?: T;
	nextRow?: T;
}

function sameProjectedValue(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length &&
			left.every((value, index) => Object.is(value, right[index]));
	}
	return false;
}

export function areProjectedResourceRowsEqual(
	currentRows: readonly ResourceSheetDataRow[],
	nextRows: readonly ResourceSheetDataRow[],
): boolean {
	if (currentRows.length !== nextRows.length) return false;
	const currentById = new Map(currentRows.map((row) => [row.__resourceId, row]));
	return nextRows.every((nextRow) => {
		const currentRow = currentById.get(nextRow.__resourceId);
		return Boolean(currentRow) && Object.keys(nextRow).every((key) =>
			sameProjectedValue(currentRow?.[key], nextRow[key])
		);
	});
}

export function resolveResourceColumns<C extends { id: string; width?: number }>(
	columns: readonly C[],
	columnPreferences: readonly ColumnPreference[] | undefined,
): C[] {
	const saved = new Map(columnPreferences?.map((column) => [column.id, column]));
	return columns
		.filter((column) => saved.get(column.id)?.visible !== false)
		.sort((left, right) => {
			const leftIndex = saved.get(left.id)?.order ?? columns.indexOf(left);
			const rightIndex = saved.get(right.id)?.order ?? columns.indexOf(right);
			return leftIndex - rightIndex;
		});
}

export function updateResourceColumnPreference(
	columns: readonly { id: string; width?: number }[],
	preferences: ViewPreferences,
	columnId: string,
	update: Partial<ColumnPreference>,
): ViewPreferences {
	const saved = new Map(preferences.columns?.map((column) => [column.id, column]));
	const next = columns.map((column, index) => ({
		id: column.id,
		visible: saved.get(column.id)?.visible ?? true,
		order: saved.get(column.id)?.order ?? index,
		width: saved.get(column.id)?.width ?? column.width,
		...(column.id === columnId ? update : {}),
	}));
	return { ...preferences, columns: next };
}

function comparableValue(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "object") return JSON.stringify(value).toLocaleLowerCase();
	return String(value).toLocaleLowerCase();
}

export function matchesResourceFilter<T>(
	row: T,
	columns: readonly ResourceSheetColumnModel<T>[],
	filter: ProjectionFilter,
): boolean {
	const column = columns.find((item) => item.id === filter.field);
	if (!column) return true;
	const rawValue = column.read(row);
	const actual = comparableValue(rawValue);
	const expected = comparableValue(filter.value);
	const expectedValues = Array.isArray(filter.value)
		? filter.value.map(comparableValue)
		: expected.split(",").map((item) => item.trim()).filter(Boolean);

	switch (filter.operator) {
		case "equals":
			return actual === expected;
		case "notEquals":
			return actual !== expected;
		case "contains":
			return actual.includes(expected);
		case "in":
			return expectedValues.includes(actual);
		case "notIn":
			return !expectedValues.includes(actual);
		case "before":
			return new Date(actual).getTime() < new Date(expected).getTime();
		case "after":
			return new Date(actual).getTime() > new Date(expected).getTime();
		case "exists":
			return rawValue !== null && rawValue !== undefined && actual.length > 0;
		default:
			return true;
	}
}

export function projectResourceRows<T extends { id: string }>(
	rows: readonly T[],
	columns: readonly ResourceSheetColumnModel<T>[],
	filters: readonly ProjectionFilter[] | undefined,
): {
	filteredRows: T[];
	sheetRows: ResourceSheetDataRow[];
	rowsById: Map<string, T>;
} {
	const filteredRows: T[] = [];
	const sheetRows: ResourceSheetDataRow[] = [];
	const rowsById = new Map<string, T>();

	for (const row of rows) {
		if (!(filters ?? []).every((filter) => matchesResourceFilter(row, columns, filter))) {
			continue;
		}
		const sheetRow: ResourceSheetDataRow = { __resourceId: row.id };
		for (const column of columns) sheetRow[column.id] = column.read(row);
		filteredRows.push(row);
		sheetRows.push(sheetRow);
		rowsById.set(row.id, row);
	}

	return { filteredRows, sheetRows, rowsById };
}

export function resolveResourceRowMove<T extends { id: string }>(
	rowsById: ReadonlyMap<string, T>,
	movedResourceId: string,
	fromIndex: number,
	orderedResourceIds: readonly string[],
): ResourceSheetRowMoveModel<T> | undefined {
	const row = rowsById.get(movedResourceId);
	const toIndex = orderedResourceIds.indexOf(movedResourceId);
	if (!row || fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return undefined;
	return {
		row,
		fromIndex,
		toIndex,
		previousRow: rowsById.get(orderedResourceIds[toIndex - 1] ?? ""),
		nextRow: rowsById.get(orderedResourceIds[toIndex + 1] ?? ""),
	};
}
