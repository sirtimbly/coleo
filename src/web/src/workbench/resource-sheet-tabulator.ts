/**
 * Tabulator definitions for the shared ResourceSheet React adapter.
 *
 * Vendor column mapping, status formatting, history records, and context-menu
 * construction live here so the component file stays focused on lifecycle and
 * reconciliation.
 */

import { normalizeRowColor, type RowFormattingValue } from "@/design-system/row-formatting";
import { getResourceStatusStyle } from "@/design-system/resource-status-styles";

import { resolveResourceRowMove, type ResourceSheetDataRow } from "./resource-sheet-model";
import {
	createTabulatorMultiSelectEditor,
	tabulatorMultiSelectFormatter,
} from "./tabulator-multiselect";

import type { ColumnPreference, ProjectionSort, ViewPreferences } from "./types";
import type { StatusSeriesEntity } from "@/lib";
import type {
	ColumnDefinition,
	Formatter,
	MenuObject,
	MenuSeparator,
	RowComponent,
	Tabulator,
	Validator,
} from "tabulator-tables";

export interface ResourceSheetColumn<T> {
	id: string;
	header: string;
	read: (row: T) => unknown;
	type?: "text" | "numeric" | "checkbox" | "date" | "dropdown" | "multiselect";
	options?: string[];
	allowCreateOptions?: boolean;
	optionLabel?: string;
	statusEntity?: StatusSeriesEntity;
	readOnly?: boolean;
	width?: number;
	className?: string;
	validator?: Validator;
}

export interface ResourceSheetRowMove<T> {
	row: T;
	fromIndex: number;
	toIndex: number;
	previousRow?: T;
	nextRow?: T;
}

export interface EditHistoryAction {
	kind: "edit";
	resourceId: string;
	columnId: string;
	previousValue: unknown;
	nextValue: unknown;
}

export interface MoveHistoryAction {
	kind: "move";
	resourceId: string;
	previousOrder: string[];
	nextOrder: string[];
}

export type ResourceSheetHistoryAction = EditHistoryAction | MoveHistoryAction;

export interface ResourceSheetHistory {
	actions: ResourceSheetHistoryAction[];
	index: number;
}

export interface ResourceSheetRuntime<T extends { id: string }> {
	sheetRows: ResourceSheetDataRow[];
	rowsById: Map<string, T>;
	filteredRows: T[];
	visibleColumns: ResourceSheetColumn<T>[];
	columns: ResourceSheetColumn<T>[];
	rowHeight: number;
	canMoveRows: boolean;
	preferences: ViewPreferences;
	onPreferencesChange: (preferences: ViewPreferences) => void;
	onChange?: (row: T, columnId: string, value: unknown, previousValue: unknown) => void;
	onCreateRowAt?: (index: number) => void;
	onDeleteRows?: (rows: T[]) => void;
	onRowsMove?: (moves: ResourceSheetRowMove<T>[]) => void | Promise<void>;
	onOpenRow?: (row: T) => void;
	onNearEnd?: () => void;
	onRowSelectionChange?: (row: T | undefined) => void;
	getRowFormatting?: (row: T) => Partial<RowFormattingValue> | undefined;
	selectedRowId?: string;
}

export function readResourceSheetRow(
	component: RowComponent,
): ResourceSheetDataRow | undefined {
	const data = component.getData();
	return data && typeof data === "object" && typeof data.__resourceId === "string"
		? data as ResourceSheetDataRow
		: undefined;
}

export function sameResourceSheetValue(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length &&
			left.every((value, index) => Object.is(value, right[index]));
	}
	return false;
}

function statusFormatter(entity: StatusSeriesEntity): Formatter {
	return (cell) => {
		const value = String(cell.getValue());
		const style = getResourceStatusStyle(entity, value);
		if (!style) return value;
		cell.getElement().style.color = style.color;
		const badge = document.createElement("span");
		badge.className = "coleo-sheet-status";
		badge.textContent = style.label;
		badge.setAttribute("aria-label", `${style.label} status`);
		badge.style.setProperty("--coleo-sheet-status-color", style.color);
		return badge;
	};
}

function columnEditor<T>(column: ResourceSheetColumn<T>): ColumnDefinition["editor"] {
	if (column.readOnly) return undefined;
	switch (column.type) {
		case "numeric":
			return "number";
		case "checkbox":
			return "tickCross";
		case "date":
			return "date";
		case "dropdown":
			return "list";
		case "multiselect":
			return createTabulatorMultiSelectEditor({
				options: column.options,
				optionLabel: column.optionLabel,
				allowCreate: column.allowCreateOptions,
			});
		default:
			return "input";
	}
}

export function toTabulatorColumn<T>(
	column: ResourceSheetColumn<T>,
	columnPreferences: readonly ColumnPreference[] | undefined,
): ColumnDefinition {
	const savedWidth = columnPreferences?.find((item) => item.id === column.id)?.width;
	const definition: ColumnDefinition = {
		title: column.header,
		field: column.id,
		editor: columnEditor(column),
		headerSort: true,
		width: savedWidth ?? column.width,
		minWidth: Math.min(column.width ?? 100, 80),
		cssClass: column.className,
		validator: column.validator,
		vertAlign: "middle",
	};
	if (column.type === "dropdown") {
		definition.editorParams = {
			values: column.options ?? [],
			autocomplete: false,
			clearable: false,
		};
	}
	if (column.type === "checkbox") definition.formatter = "tickCross";
	if (column.type === "multiselect") definition.formatter = tabulatorMultiSelectFormatter;
	if (column.statusEntity) definition.formatter = statusFormatter(column.statusEntity);
	return definition;
}

export function resourceColumnConfigurationKey<T>(
	columns: readonly ResourceSheetColumn<T>[],
	columnPreferences: readonly ColumnPreference[] | undefined,
): string {
	return JSON.stringify(columns.map((column) => ({
		id: column.id,
		type: column.type,
		readOnly: column.readOnly,
		width: columnPreferences?.find((item) => item.id === column.id)?.width ?? column.width,
		options: column.options,
	})));
}

export function resourceFormattingConfigurationKey<T extends { id: string }>(
	rows: readonly T[],
	getFormatting: ((row: T) => Partial<RowFormattingValue> | undefined) | undefined,
): string {
	return JSON.stringify(rows.map((row) => {
		const formatting = getFormatting?.(row);
		return [row.id, formatting?.bold === true, normalizeRowColor(formatting?.color)];
	}));
}

export function toTabulatorSort(sort: readonly ProjectionSort[] | undefined): Array<{
	column: string;
	dir: "asc" | "desc";
}> {
	return (sort ?? []).map((item) => ({
		column: item.field,
		dir: item.direction,
	}));
}

export function recordResourceSheetHistory(
	history: ResourceSheetHistory,
	action: ResourceSheetHistoryAction,
): void {
	history.actions = history.actions.slice(0, history.index + 1);
	history.actions.push(action);
	history.index = history.actions.length - 1;
}

export function resourceSheetMovePayload<T extends { id: string }>(
	runtime: ResourceSheetRuntime<T>,
	resourceId: string,
	fromOrder: readonly string[],
	toOrder: readonly string[],
): ResourceSheetRowMove<T> | undefined {
	return resolveResourceRowMove(
		runtime.rowsById,
		resourceId,
		fromOrder.indexOf(resourceId),
		toOrder,
	);
}

export function createResourceSheetRowMenu<T extends { id: string }>({
	row,
	runtime,
	table,
	history,
	undo,
	redo,
}: {
	row: RowComponent;
	runtime: ResourceSheetRuntime<T>;
	table: Tabulator | null;
	history: ResourceSheetHistory;
	undo: () => void;
	redo: () => void;
}): Array<MenuObject<RowComponent> | MenuSeparator> {
	const position = table?.getRows("active").indexOf(row) ?? -1;
	const resourceId = readResourceSheetRow(row)?.__resourceId;
	const resource = resourceId ? runtime.rowsById.get(resourceId) : undefined;
	const items: Array<MenuObject<RowComponent> | MenuSeparator> = [];
	if (resource && runtime.onOpenRow) {
		items.push({
			label: "Details",
			action: () => runtime.onOpenRow?.(resource),
		});
	}
	if (runtime.onCreateRowAt) {
		if (items.length > 0) items.push({ separator: true });
		items.push(
			{
				label: "Insert row above",
				action: () => runtime.onCreateRowAt?.(Math.max(0, position)),
			},
			{
				label: "Insert row below",
				action: () => runtime.onCreateRowAt?.(Math.max(0, position + 1)),
			},
		);
	}
	if (resource && runtime.onDeleteRows) {
		items.push({
			label: "Delete row",
			action: () => runtime.onDeleteRows?.([resource]),
		});
	}
	items.push(
		{ separator: true },
		{
			label: "Undo",
			disabled: history.index < 0,
			action: undo,
		},
		{
			label: "Redo",
			disabled: history.index >= history.actions.length - 1,
			action: redo,
		},
		{ separator: true },
		{
			label: "Copy selected rows",
			action: () => table?.copyToClipboard("selected"),
		},
	);
	return items;
}

export { normalizeRowColor };
