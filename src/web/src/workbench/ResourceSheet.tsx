/**
 * Generic Handsontable-backed resource projection.
 *
 * Task, bug, plan-item, and future structured lists all use this component for
 * spreadsheet editing, between-row insertion, sorting, column movement,
 * resizing, visibility, and opening resources in separate workbench panels.
 */

import { useEffect, useMemo, useRef } from "react";
import { HotTable, type HotTableRef } from "@handsontable/react-wrapper";
import { registerAllModules } from "handsontable/registry";
import type { ColumnSortingConfig } from "handsontable/plugins/columnSorting";

import { cn } from "@/lib";
import type {
	CellChange,
	ChangeSource,
	ColumnSettings,
} from "handsontable/settings";

import type {
	ColumnPreference,
	ProjectionFilter,
	ProjectionSort,
	ViewPreferences,
} from "./types";

import "handsontable/styles/handsontable.css";
import "handsontable/styles/ht-theme-main.css";
import "./sheet-theme.css";

registerAllModules();

const COLUMN_MENU_ITEMS = [
	"filter_by_condition",
	"filter_by_value",
	"filter_action_bar",
];
const EDITABLE_ROW_MENU_ITEMS = [
	"row_above",
	"row_below",
	"remove_row",
	"---------",
	"undo",
	"redo",
	"copy",
];
const READ_ONLY_ROW_MENU_ITEMS = ["copy"];

export interface ResourceSheetColumn<T> {
	id: string;
	header: string;
	read: (row: T) => unknown;
	type?: "text" | "numeric" | "checkbox" | "date" | "dropdown";
	options?: string[];
	readOnly?: boolean;
	width?: number;
	className?: string;
	validator?: ColumnSettings["validator"];
}

interface SheetRow {
	__resourceId: string;
	[columnId: string]: unknown;
}

function resolveColumns<T>(
	columns: ResourceSheetColumn<T>[],
	preferences: ViewPreferences,
): ResourceSheetColumn<T>[] {
	const saved = new Map(preferences.columns?.map((column) => [column.id, column]));
	return columns
		.filter((column) => saved.get(column.id)?.visible !== false)
		.sort((left: ResourceSheetColumn<T>, right: ResourceSheetColumn<T>) => {
			const leftIndex = saved.get(left.id)?.order ?? columns.indexOf(left);
			const rightIndex = saved.get(right.id)?.order ?? columns.indexOf(right);
			return leftIndex - rightIndex;
		});
}

function updateColumnPreference(
	columns: ResourceSheetColumn<unknown>[],
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

function matchesFilter<T>(
	row: T,
	columns: ResourceSheetColumn<T>[],
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

export function ResourceSheet<T extends { id: string }>({
	rows,
	columns,
	preferences,
	onPreferencesChange,
	onChange,
	onCreateRowAt,
	onDeleteRows,
	onOpenRow,
	onNearEnd,
	selectedRowId,
	className,
}: {
	rows: T[];
	columns: ResourceSheetColumn<T>[];
	preferences: ViewPreferences;
	onPreferencesChange: (preferences: ViewPreferences) => void;
	onChange?: (row: T, columnId: string, value: unknown, previousValue: unknown) => void;
	onCreateRowAt?: (index: number) => void;
	onDeleteRows?: (rows: T[]) => void;
	onOpenRow?: (row: T) => void;
	onNearEnd?: () => void;
	selectedRowId?: string;
	className?: string;
}) {
	const hotRef = useRef<HotTableRef>(null);
	const visibleColumns = useMemo(
		() => resolveColumns(columns, preferences),
		[columns, preferences],
	);
	const filteredRows = useMemo(
		() => rows.filter((row) => (preferences.filters ?? []).every((filter) =>
			matchesFilter(row, columns, filter)
		)),
		[columns, preferences.filters, rows],
	);
	const sheetRows = useMemo<SheetRow[]>(() => filteredRows.map((row) => {
		const sheetRow: SheetRow = { __resourceId: row.id };
		for (const column of columns) sheetRow[column.id] = column.read(row);
		return sheetRow;
	}), [columns, filteredRows]);
	const rowsById = useMemo(
		() => new Map(filteredRows.map((row) => [row.id, row])),
		[filteredRows],
	);
	const rowHeight = preferences.density === "comfortable" ? 38 : 30;
	const sortConfig = (preferences.sort ?? []).flatMap((sort) => {
		const column = visibleColumns.findIndex((item) => item.id === sort.field);
		return column >= 0 ? [{ column, sortOrder: sort.direction }] : [];
	});

	const hotColumns = useMemo<ColumnSettings[]>(() => visibleColumns.map((column) => ({
		data: column.id,
		type: column.type ?? "text",
		source: column.options,
		strict: column.type === "dropdown",
		allowInvalid: false,
		readOnly: column.readOnly,
		width: preferences.columns?.find((item) => item.id === column.id)?.width ?? column.width,
		className: column.className,
		validator: column.validator,
	})), [preferences.columns, visibleColumns]);
	const contextMenuItems = onCreateRowAt || onDeleteRows
		? EDITABLE_ROW_MENU_ITEMS
		: READ_ONLY_ROW_MENU_ITEMS;

	useEffect(() => {
		const hot = hotRef.current?.hotInstance;
		if (!hot) return;

		// Keep transient menu plugins out of the React wrapper's update cycle.
		// Re-applying dropdownMenu during an unrelated parent render destroys
		// its open menu; the plugin configuration itself is static here.
		hot.updateSettings({
			filters: true,
			dropdownMenu: COLUMN_MENU_ITEMS,
			contextMenu: contextMenuItems,
		}, false);
	}, [contextMenuItems]);

	const handleChange = (changes: CellChange[] | null, source: ChangeSource) => {
		if (!changes || source === "loadData" || source === "updateData") return;
		for (const [rowIndex, property, previousValue, nextValue] of changes) {
			if (previousValue === nextValue || typeof property !== "string") continue;
			const physicalRow = hotRef.current?.hotInstance?.toPhysicalRow(rowIndex) ?? rowIndex;
			const id = sheetRows[physicalRow]?.__resourceId;
			const resource = id ? rowsById.get(id) : undefined;
			if (resource) onChange?.(resource, property, nextValue, previousValue);
		}
	};

	const handleColumnMove = (
		movedColumns: number[],
		finalIndex: number,
		_dropIndex: number | undefined,
		movePossible: boolean,
		orderChanged: boolean,
	) => {
		if (!movePossible || !orderChanged || movedColumns.length === 0) return;
		const visibleIds = visibleColumns.map((column) => column.id);
		const movedIds = movedColumns.map((index) => visibleIds[index]).filter(Boolean);
		const remaining = visibleIds.filter((id) => !movedIds.includes(id));
		remaining.splice(finalIndex, 0, ...movedIds);
		const hiddenIds = columns.map((column) => column.id).filter((id) => !remaining.includes(id));
		const orderedIds = [...remaining, ...hiddenIds];
		const existing = new Map(preferences.columns?.map((column) => [column.id, column]));
		onPreferencesChange({
			...preferences,
			columns: orderedIds.map((id, order) => ({
				id,
				order,
				visible: existing.get(id)?.visible ?? true,
				width: existing.get(id)?.width ?? columns.find((column) => column.id === id)?.width,
			})),
		});
	};

	return (
		<div className={cn("coleo-resource-sheet ht-theme-main h-full min-h-0", className)}>
			<HotTable
				ref={hotRef}
				data={sheetRows}
				columns={hotColumns}
				colHeaders={visibleColumns.map((column) => column.header)}
				rowHeaders
				width="100%"
				height="100%"
				stretchH="last"
				rowHeights={rowHeight}
				columnHeaderHeight={32}
					fixedColumnsStart={visibleColumns.length > 1 ? 1 : 0}
					manualColumnMove
					manualColumnResize
					multiColumnSorting={{ initialConfig: sortConfig }}
					undo
				copyPaste
				selectionMode="multiple"
				outsideClickDeselects={false}
				licenseKey={import.meta.env.VITE_HANDSONTABLE_LICENSE_KEY ?? "non-commercial-and-evaluation"}
				afterChange={handleChange}
				afterCreateRow={(index: number, amount: number) => {
					for (let offset = 0; offset < amount; offset += 1) onCreateRowAt?.(index + offset);
				}}
				beforeRemoveRow={(_index: number, _amount: number, physicalRows: number[]) => {
					const removed = physicalRows.map((index: number) => filteredRows[index]).filter(Boolean);
					if (removed.length > 0) onDeleteRows?.(removed);
					// Domain mutations own deletion. Keep the immutable source in
					// place until its optimistic/server update reaches React.
					return false;
				}}
				afterColumnMove={handleColumnMove}
				afterColumnResize={(newSize: number, visualColumn: number) => {
					const id = visibleColumns[visualColumn]?.id;
					if (!id) return;
					onPreferencesChange(updateColumnPreference(
						columns as ResourceSheetColumn<unknown>[],
						preferences,
						id,
						{ width: newSize },
					));
				}}
				afterColumnSort={(_current: ColumnSortingConfig[], destination: ColumnSortingConfig[]) => {
					const nextSort: ProjectionSort[] = destination.flatMap((item: ColumnSortingConfig) => {
						const id = visibleColumns[item.column]?.id;
						return id && item.sortOrder !== "none"
							? [{ field: id, direction: item.sortOrder }]
							: [];
					});
					onPreferencesChange({ ...preferences, sort: nextSort });
				}}
				afterOnCellMouseDown={(event: MouseEvent, coords: { row: number; col: number }) => {
					if (event.detail < 2 || coords.row < 0) return;
					const physicalRow = hotRef.current?.hotInstance?.toPhysicalRow(coords.row) ?? coords.row;
					const id = sheetRows[physicalRow]?.__resourceId;
					const resource = id ? rowsById.get(id) : undefined;
					if (resource) onOpenRow?.(resource);
				}}
				afterScrollVertically={() => {
					onNearEnd?.();
				}}
				cells={(row: number) => {
					const physicalRow = hotRef.current?.hotInstance?.toPhysicalRow(row) ?? row;
					const id = sheetRows[physicalRow]?.__resourceId;
					return id === selectedRowId ? { className: "coleo-sheet-selected-row" } : {};
				}}
			/>
		</div>
	);
}
