/**
 * Generic Handsontable-backed resource projection.
 *
 * Task, bug, plan-item, and future structured lists all use this component for
 * spreadsheet editing, between-row insertion, sorting, column movement,
 * resizing, visibility, row selection/formatting, and opening resources in
 * separate workbench panels.
 */

import { useEffect, useMemo, useRef } from "react";
import Handsontable from "handsontable";
import { registerAllModules } from "handsontable/registry";
import type { ColumnSortingConfig } from "handsontable/plugins/columnSorting";

import {
	normalizeRowColor,
	type RowFormattingValue,
} from "@/design-system/RowFormattingToolbar";
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

interface ResourceSheetRuntime<T> {
	sheetRows: SheetRow[];
	rowsById: Map<string, T>;
	filteredRows: T[];
	visibleColumns: ResourceSheetColumn<T>[];
	columns: ResourceSheetColumn<T>[];
	hotColumns: ColumnSettings[];
	columnHeaders: string[];
	rowHeight: number;
	contextMenuItems: string[];
	sortConfig: ColumnSortingConfig[];
	preferences: ViewPreferences;
	onPreferencesChange: (preferences: ViewPreferences) => void;
	onChange?: (row: T, columnId: string, value: unknown, previousValue: unknown) => void;
	onCreateRowAt?: (index: number) => void;
	onDeleteRows?: (rows: T[]) => void;
	onOpenRow?: (row: T) => void;
	onNearEnd?: () => void;
	onRowSelectionChange?: (row: T | undefined) => void;
	getRowFormatting?: (row: T) => Partial<RowFormattingValue> | undefined;
	selectedRowId?: string;
}

function resolveColumns<T>(
	columns: ResourceSheetColumn<T>[],
	columnPreferences: ColumnPreference[] | undefined,
): ResourceSheetColumn<T>[] {
	const saved = new Map(columnPreferences?.map((column) => [column.id, column]));
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
	onRowSelectionChange,
	getRowFormatting,
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
	onRowSelectionChange?: (row: T | undefined) => void;
	getRowFormatting?: (row: T) => Partial<RowFormattingValue> | undefined;
	selectedRowId?: string;
	className?: string;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const hotRef = useRef<Handsontable | null>(null);
	const scrollFrameRef = useRef<number | null>(null);
	const lastNearEndRowCountRef = useRef<number | null>(null);
	const syncingSortRef = useRef(false);
	const visibleColumns = useMemo(
		() => resolveColumns(columns, preferences.columns),
		[columns, preferences.columns],
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
	const sortConfig = useMemo<ColumnSortingConfig[]>(
		() => (preferences.sort ?? []).flatMap((sort) => {
			const column = visibleColumns.findIndex((item) => item.id === sort.field);
			return column >= 0 ? [{ column, sortOrder: sort.direction }] : [];
		}),
		[preferences.sort, visibleColumns],
	);
	const columnHeaders = useMemo(
		() => visibleColumns.map((column) => column.header),
		[visibleColumns],
	);

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
	const runtimeRef = useRef<ResourceSheetRuntime<T>>({
		sheetRows,
		rowsById,
		filteredRows,
		visibleColumns,
		columns,
		hotColumns,
		columnHeaders,
		rowHeight,
		contextMenuItems,
		sortConfig,
		preferences,
		onPreferencesChange,
		onChange,
		onCreateRowAt,
		onDeleteRows,
		onOpenRow,
		onNearEnd,
		onRowSelectionChange,
		getRowFormatting,
		selectedRowId,
	});
	runtimeRef.current = {
		sheetRows,
		rowsById,
		filteredRows,
		visibleColumns,
		columns,
		hotColumns,
		columnHeaders,
		rowHeight,
		contextMenuItems,
		sortConfig,
		preferences,
		onPreferencesChange,
		onChange,
		onCreateRowAt,
		onDeleteRows,
		onOpenRow,
		onNearEnd,
		onRowSelectionChange,
		getRowFormatting,
		selectedRowId,
	};

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const runtime = runtimeRef.current;
		const hot: Handsontable = new Handsontable(container, {
			data: runtime.sheetRows,
			columns: runtime.hotColumns,
			colHeaders: runtime.columnHeaders,
			rowHeaders: true,
			width: "100%",
			height: "100%",
			stretchH: "last",
			rowHeights: runtime.rowHeight,
			columnHeaderHeight: 32,
			manualColumnMove: true,
			manualColumnResize: true,
			multiColumnSorting: true,
			undo: true,
			copyPaste: true,
			selectionMode: "multiple",
			outsideClickDeselects: false,
			autoColumnSize: false,
			autoRowSize: false,
			renderAllRows: false,
			viewportRowRenderingOffset: 8,
			filters: true,
			dropdownMenu: COLUMN_MENU_ITEMS,
			contextMenu: runtime.contextMenuItems,
			licenseKey: import.meta.env.VITE_HANDSONTABLE_LICENSE_KEY ?? "non-commercial-and-evaluation",
			afterChange: (changes: CellChange[] | null, source: ChangeSource) => {
				if (!changes || source === "loadData" || source === "updateData") return;
				const current = runtimeRef.current;
				for (const [rowIndex, property, previousValue, nextValue] of changes) {
					if (previousValue === nextValue || typeof property !== "string") continue;
					const physicalRow = hot.toPhysicalRow(rowIndex) ?? rowIndex;
					const id = current.sheetRows[physicalRow]?.__resourceId;
					const resource = id ? current.rowsById.get(id) : undefined;
					if (resource) current.onChange?.(resource, property, nextValue, previousValue);
				}
			},
			afterCreateRow: (index: number, amount: number) => {
				const current = runtimeRef.current;
				for (let offset = 0; offset < amount; offset += 1) {
					current.onCreateRowAt?.(index + offset);
				}
			},
			beforeRemoveRow: (_index: number, _amount: number, physicalRows: number[]) => {
				const current = runtimeRef.current;
				const removed = physicalRows
					.map((index: number) => current.filteredRows[index])
					.filter(Boolean);
				if (removed.length > 0) current.onDeleteRows?.(removed);
				// Domain mutations own deletion. Keep the immutable source in
				// place until its optimistic/server update reaches React.
				return false;
			},
			afterColumnMove: (
				movedColumns: number[],
				finalIndex: number,
				_dropIndex: number | undefined,
				movePossible: boolean,
				orderChanged: boolean,
			) => {
				if (!movePossible || !orderChanged || movedColumns.length === 0) return;
				const current = runtimeRef.current;
				const visibleIds = current.visibleColumns.map((column) => column.id);
				const movedIds = movedColumns.map((index) => visibleIds[index]).filter(Boolean);
				const remaining = visibleIds.filter((id) => !movedIds.includes(id));
				remaining.splice(finalIndex, 0, ...movedIds);
				const hiddenIds = current.columns
					.map((column) => column.id)
					.filter((id) => !remaining.includes(id));
				const orderedIds = [...remaining, ...hiddenIds];
				const existing = new Map(
					current.preferences.columns?.map((column) => [column.id, column]),
				);
				current.onPreferencesChange({
					...current.preferences,
					columns: orderedIds.map((id, order) => ({
						id,
						order,
						visible: existing.get(id)?.visible ?? true,
						width: existing.get(id)?.width ??
							current.columns.find((column) => column.id === id)?.width,
					})),
				});
			},
			afterColumnResize: (newSize: number, visualColumn: number) => {
				const current = runtimeRef.current;
				const id = current.visibleColumns[visualColumn]?.id;
				if (!id) return;
				current.onPreferencesChange(updateColumnPreference(
					current.columns as ResourceSheetColumn<unknown>[],
					current.preferences,
					id,
					{ width: newSize },
				));
			},
			afterColumnSort: (
				_current: ColumnSortingConfig[],
				destination: ColumnSortingConfig[],
			) => {
				if (syncingSortRef.current) return;
				const current = runtimeRef.current;
				const nextSort: ProjectionSort[] = destination.flatMap((item) => {
					const id = current.visibleColumns[item.column]?.id;
					return id && item.sortOrder !== "none"
						? [{ field: id, direction: item.sortOrder }]
						: [];
				});
				current.onPreferencesChange({ ...current.preferences, sort: nextSort });
			},
			afterOnCellMouseDown: (event, coords) => {
				if (event.detail < 2 || coords.row === null || coords.row < 0) return;
				const current = runtimeRef.current;
				const physicalRow = hot.toPhysicalRow(coords.row) ?? coords.row;
				const id = current.sheetRows[physicalRow]?.__resourceId;
				const resource = id ? current.rowsById.get(id) : undefined;
				if (resource) current.onOpenRow?.(resource);
			},
			afterSelectionEnd: (row: number, _column: number, row2: number) => {
				const current = runtimeRef.current;
				const visualRow = Math.min(row, row2);
				if (visualRow < 0) {
					current.onRowSelectionChange?.(undefined);
					return;
				}
				const physicalRow = hot.toPhysicalRow(visualRow) ?? visualRow;
				const id = current.sheetRows[physicalRow]?.__resourceId;
				current.onRowSelectionChange?.(id ? current.rowsById.get(id) : undefined);
			},
			afterDeselect: () => {
				runtimeRef.current.onRowSelectionChange?.(undefined);
			},
			afterScrollVertically: () => {
				if (scrollFrameRef.current !== null) return;
				scrollFrameRef.current = window.requestAnimationFrame(() => {
					scrollFrameRef.current = null;
					const current = runtimeRef.current;
					const holder = container.querySelector<HTMLElement>(".ht_master .wtHolder");
					if (!holder || !current.onNearEnd) return;
					const threshold = Math.max(current.rowHeight * 5, 120);
					const nearEnd =
						holder.scrollTop + holder.clientHeight >= holder.scrollHeight - threshold;
					if (
						nearEnd &&
						lastNearEndRowCountRef.current !== current.sheetRows.length
					) {
						lastNearEndRowCountRef.current = current.sheetRows.length;
						current.onNearEnd();
					}
				});
			},
			cells: (row: number, column: number): object => {
				const current = runtimeRef.current;
				// Handsontable asks for cell metadata while its constructor is
				// still running, before the instance can be assigned to hotRef.
				const physicalRow = hotRef.current?.toPhysicalRow(row) ?? row;
				const id = current.sheetRows[physicalRow]?.__resourceId;
				const resource = id ? current.rowsById.get(id) : undefined;
				const formatting = resource
					? current.getRowFormatting?.(resource)
					: undefined;
				const color = normalizeRowColor(formatting?.color);
				const classes: string = [
					current.visibleColumns[column]?.className,
					formatting?.bold ? "coleo-sheet-row-bold" : undefined,
					color !== "slate" ? `coleo-sheet-row-color-${color}` : undefined,
					id === current.selectedRowId ? "coleo-sheet-selected-row" : undefined,
				].filter(Boolean).join(" ");
				return classes ? { className: classes } : {};
			},
		});
		hotRef.current = hot;
		if (runtime.sortConfig.length > 0) {
			syncingSortRef.current = true;
			hot.getPlugin("multiColumnSorting").sort(runtime.sortConfig);
			syncingSortRef.current = false;
		}
		return () => {
			if (scrollFrameRef.current !== null) {
				window.cancelAnimationFrame(scrollFrameRef.current);
				scrollFrameRef.current = null;
			}
			hot.destroy();
			hotRef.current = null;
		};
	}, []);

	useEffect(() => {
		const hot = hotRef.current;
		if (!hot) return;
		hot.updateSettings({
			data: sheetRows,
			columns: hotColumns,
			colHeaders: columnHeaders,
			rowHeights: rowHeight,
		}, false);
		hot.render();
	}, [columnHeaders, hotColumns, rowHeight, selectedRowId, sheetRows]);

	useEffect(() => {
		const hot = hotRef.current;
		if (!hot) return;
		syncingSortRef.current = true;
		hot.getPlugin("multiColumnSorting").sort(sortConfig);
		syncingSortRef.current = false;
	}, [sortConfig]);

	return (
			<div
				ref={containerRef}
				className={cn(
					"coleo-resource-sheet ht-theme-main h-full min-h-0 overflow-hidden",
					className,
				)}
			/>
	);
}
