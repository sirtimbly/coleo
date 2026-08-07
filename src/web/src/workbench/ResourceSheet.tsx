/**
 * Generic Tabulator-backed resource projection.
 *
 * Task, bug, plan-item, discovery, and future structured lists use this stable
 * boundary for spreadsheet editing, between-row insertion, manual ordering,
 * saved columns/sorts, selection and formatting, undo/redo, and Golden Layout
 * detail navigation. Coleo owns data and history; Tabulator owns rendering.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { TabulatorFull as Tabulator } from "tabulator-tables";

import { cn } from "@/lib";
import type { RowFormattingValue } from "@/design-system/row-formatting";

import {
	projectResourceRows,
	resolveResourceColumns,
	updateResourceColumnPreference,
	type ResourceSheetDataRow,
} from "./resource-sheet-model";
import {
	createResourceSheetRowMenu,
	normalizeRowColor,
	readResourceSheetRow,
	recordResourceSheetHistory,
	resourceColumnConfigurationKey,
	resourceFormattingConfigurationKey,
	resourceSheetMovePayload,
	sameResourceSheetValue,
	toTabulatorColumn,
	toTabulatorSort,
	type EditHistoryAction,
	type MoveHistoryAction,
	type ResourceSheetColumn,
	type ResourceSheetHistory,
	type ResourceSheetRowMove,
	type ResourceSheetRuntime,
} from "./resource-sheet-tabulator";
import { useResourceSheetSynchronization } from "./use-resource-sheet-synchronization";

import type { ProjectionSort, ViewPreferences } from "./types";
import type { CellComponent, ColumnComponent, RowComponent, SorterFromTable } from "tabulator-tables";

import "tabulator-tables/dist/css/tabulator.min.css";
import "./sheet-theme.css";

export type { ResourceSheetColumn, ResourceSheetRowMove } from "./resource-sheet-tabulator";

export function ResourceSheet<T extends { id: string }>({
	rows,
	columns,
	preferences,
	onPreferencesChange,
	onChange,
	onCreateRowAt,
	onDeleteRows,
	onRowsMove,
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
	onRowsMove?: (moves: ResourceSheetRowMove<T>[]) => void | Promise<void>;
	onOpenRow?: (row: T) => void;
	onNearEnd?: () => void;
	onRowSelectionChange?: (row: T | undefined) => void;
	getRowFormatting?: (row: T) => Partial<RowFormattingValue> | undefined;
	selectedRowId?: string;
	className?: string;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const tableRef = useRef<Tabulator | null>(null);
	const tableReadyRef = useRef(false);
	const resizeFrameRef = useRef<number | undefined>(undefined);
	const nearEndRowCountRef = useRef<number | undefined>(undefined);
	const rowMoveStartRef = useRef<{ id: string; order: string[] } | undefined>(undefined);
	const replayingHistoryRef = useRef(false);
	const syncingColumnsRef = useRef(false);
	const syncingSortRef = useRef(false);
	const historyRef = useRef<ResourceSheetHistory>({ actions: [], index: -1 });
	const configurationDeferredRef = useRef(false);
	const [synchronizationRevision, setSynchronizationRevision] = useState(0);
	const visibleColumns = useMemo(
		() => resolveResourceColumns(columns, preferences.columns),
		[columns, preferences.columns],
	);
	const { filteredRows, sheetRows, rowsById } = useMemo(
		() => projectResourceRows(rows, columns, preferences.filters),
		[columns, preferences.filters, rows],
	);
	const rowHeight = preferences.density === "comfortable" ? 38 : 30;
	const canMoveRows = Boolean(onRowsMove) && (preferences.sort ?? []).length === 0;
	const tabulatorColumns = useMemo(
		() => visibleColumns.map((column) => toTabulatorColumn(column, preferences.columns)),
		[preferences.columns, visibleColumns],
	);
	const columnConfigurationKey = useMemo(
		() => resourceColumnConfigurationKey(visibleColumns, preferences.columns),
		[preferences.columns, visibleColumns],
	);
	const formattingConfigurationKey = useMemo(
		() => resourceFormattingConfigurationKey(filteredRows, getRowFormatting),
		[filteredRows, getRowFormatting],
	);
	const appliedColumnConfigurationRef = useRef(columnConfigurationKey);
	const sortConfigurationKey = JSON.stringify(preferences.sort ?? []);
	const appliedSortConfigurationRef = useRef(sortConfigurationKey);
	const runtimeRef = useRef<ResourceSheetRuntime<T>>({
		sheetRows,
		rowsById,
		filteredRows,
		visibleColumns,
		columns,
		rowHeight,
		canMoveRows,
		preferences,
		onPreferencesChange,
		onChange,
		onCreateRowAt,
		onDeleteRows,
		onRowsMove,
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
		rowHeight,
		canMoveRows,
		preferences,
		onPreferencesChange,
		onChange,
		onCreateRowAt,
		onDeleteRows,
		onRowsMove,
		onOpenRow,
		onNearEnd,
		onRowSelectionChange,
		getRowFormatting,
		selectedRowId,
	};

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		let disposed = false;
		let table: Tabulator | null = null;
		let resizeObserver: ResizeObserver | null = null;

		const orderedIds = (instance: Tabulator): string[] => (
			instance
				.getRows("active")
				.map((row) => readResourceSheetRow(row)?.__resourceId)
				.filter((id): id is string => Boolean(id))
		);
		const publishMove = (
			resourceId: string,
			fromOrder: readonly string[],
			toOrder: readonly string[],
		) => {
			const runtime = runtimeRef.current;
			const move = resourceSheetMovePayload(runtime, resourceId, fromOrder, toOrder);
			if (move) void runtime.onRowsMove?.([move]);
		};
		const replayMove = async (
			instance: Tabulator,
			action: MoveHistoryAction,
			direction: "undo" | "redo",
		) => {
			const currentOrder = orderedIds(instance);
			const targetOrder = direction === "undo" ? action.previousOrder : action.nextOrder;
			const rowData = new Map(
				instance.getData().map((row) => [String(row.__resourceId), row]),
			);
			const nextData = targetOrder
				.map((id) => rowData.get(id))
				.filter((row): row is ResourceSheetDataRow => Boolean(row));
			await instance.replaceData(nextData);
			publishMove(action.resourceId, currentOrder, targetOrder);
		};
		const replayEdit = (
			instance: Tabulator,
			action: EditHistoryAction,
			direction: "undo" | "redo",
		) => {
			const row = runtimeRef.current.rowsById.get(action.resourceId);
			const cell = instance.getRow(action.resourceId)?.getCell(action.columnId);
			if (!row || !cell) return;
			const value = direction === "undo" ? action.previousValue : action.nextValue;
			const previousValue = direction === "undo" ? action.nextValue : action.previousValue;
			replayingHistoryRef.current = true;
			cell.setValue(value);
			replayingHistoryRef.current = false;
			runtimeRef.current.onChange?.(
				row,
				action.columnId,
				value,
				previousValue,
			);
		};
		const undo = () => {
			const history = historyRef.current;
			if (history.index < 0 || !tableRef.current) return;
			const action = history.actions[history.index];
			history.index -= 1;
			if (action.kind === "edit") replayEdit(tableRef.current, action, "undo");
			else void replayMove(tableRef.current, action, "undo");
		};
		const redo = () => {
			const history = historyRef.current;
			if (history.index >= history.actions.length - 1 || !tableRef.current) return;
			history.index += 1;
			const action = history.actions[history.index];
			if (action.kind === "edit") replayEdit(tableRef.current, action, "redo");
			else void replayMove(tableRef.current, action, "redo");
		};
		const rowMenu = (_event: MouseEvent, row: RowComponent) =>
			createResourceSheetRowMenu({
				row,
				runtime: runtimeRef.current,
				table: tableRef.current,
				history: historyRef.current,
				undo,
				redo,
			});
		const onKeyDown = (event: KeyboardEvent) => {
			if (!(event.metaKey || event.ctrlKey)) return;
			const target = event.target;
			if (
				target instanceof HTMLInputElement ||
				target instanceof HTMLTextAreaElement ||
				(target instanceof HTMLElement && target.isContentEditable)
			) return;
			if (
				tableRef.current?.getSelectedRows().length === 0 &&
				!(target instanceof Node && container.contains(target))
			) return;
			const key = event.key.toLocaleLowerCase();
			if (key === "z" && event.shiftKey) {
				event.preventDefault();
				redo();
			} else if (key === "z") {
				event.preventDefault();
				undo();
			} else if (key === "y") {
				event.preventDefault();
				redo();
			}
		};
		document.addEventListener("keydown", onKeyDown);

		queueMicrotask(() => {
			if (disposed) return;
			const instance = new Tabulator(container, {
				index: "__resourceId",
				data: runtimeRef.current.sheetRows,
				columns: runtimeRef.current.visibleColumns.map((column) =>
					toTabulatorColumn(column, runtimeRef.current.preferences.columns)
				),
				height: "100%",
				layout: "fitDataStretch",
				renderVertical: "virtual",
				renderVerticalBuffer: 320,
				rowHeight: runtimeRef.current.rowHeight,
				selectableRows: 1,
				selectableRowsPersistence: true,
				movableRows: Boolean(runtimeRef.current.onRowsMove),
				movableColumns: true,
				history: false,
				clipboard: true,
				validationMode: "blocking",
				popupContainer: container,
				rowContextMenu: rowMenu,
				initialSort: toTabulatorSort(runtimeRef.current.preferences.sort),
				rowHeader: runtimeRef.current.onRowsMove
					? {
						formatter: "rownum",
						field: "__order",
						headerSort: false,
						hozAlign: "center",
						headerHozAlign: "center",
						resizable: false,
						frozen: true,
						width: 62,
						minWidth: 62,
						rowHandle: false,
					}
					: false,
				columnDefaults: {
					resizable: true,
					vertAlign: "middle",
				},
				rowFormatter: (row) => {
					const data = readResourceSheetRow(row);
					if (!data) return;
					const runtime = runtimeRef.current;
					const resource = runtime.rowsById.get(data.__resourceId);
					const formatting = resource
						? runtime.getRowFormatting?.(resource)
						: undefined;
					const element = row.getElement();
					element.dataset.resourceId = data.__resourceId;
					const color = normalizeRowColor(formatting?.color);
					element.dataset.rowColor = color;
					element.classList.toggle("coleo-sheet-row-bold", formatting?.bold === true);
					for (const option of ["blue", "green", "orange", "purple"]) {
						element.classList.toggle(`coleo-sheet-row-color-${option}`, color === option);
					}
					element.classList.toggle(
						"coleo-sheet-selected-row",
						data.__resourceId === runtime.selectedRowId,
					);
					for (const cell of row.getCells()) {
						const cellElement = cell.getElement();
						cellElement.classList.toggle("coleo-sheet-row-bold", formatting?.bold === true);
						for (const option of ["blue", "green", "orange", "purple"]) {
							cellElement.classList.toggle(`coleo-sheet-row-color-${option}`, color === option);
						}
					}
					const rowHeader = element.querySelector<HTMLElement>(".tabulator-row-header");
					if (rowHeader) {
						rowHeader.setAttribute("role", "rowheader");
						rowHeader.setAttribute("aria-label", rowHeader.textContent?.trim() ?? "");
					}
				},
			});
			table = instance;
			tableRef.current = instance;

			instance.on("tableBuilt", () => {
				if (disposed) return;
				tableReadyRef.current = true;
				appliedColumnConfigurationRef.current = resourceColumnConfigurationKey(
					runtimeRef.current.visibleColumns,
					runtimeRef.current.preferences.columns,
				);
				appliedSortConfigurationRef.current = JSON.stringify(
					runtimeRef.current.preferences.sort ?? [],
				);
				const [orderHeader] = container.querySelectorAll<HTMLElement>(
					".tabulator-header .tabulator-col-content",
				);
				if (orderHeader) {
					orderHeader.replaceChildren(Object.assign(document.createElement("span"), {
						textContent: "Order",
					}));
				}
				container.dataset.manualOrder = runtimeRef.current.canMoveRows ? "enabled" : "disabled";
				const selected = runtimeRef.current.selectedRowId;
				if (selected) instance.selectRow(selected);
			});
			instance.on("cellEdited", (cell: CellComponent) => {
				if (replayingHistoryRef.current) return;
				const data = readResourceSheetRow(cell.getRow());
				const resourceId = data?.__resourceId;
				const resource = resourceId
					? runtimeRef.current.rowsById.get(resourceId)
					: undefined;
				const columnId = cell.getField();
				const previousValue = cell.getOldValue();
				const nextValue = cell.getValue();
				if (
					!resourceId ||
					!resource ||
					!columnId ||
					sameResourceSheetValue(previousValue, nextValue)
				) return;
				recordResourceSheetHistory(historyRef.current, {
					kind: "edit",
					resourceId,
					columnId,
					previousValue,
					nextValue,
				});
				runtimeRef.current.onChange?.(
					resource,
					columnId,
					nextValue,
					previousValue,
				);
				queueMicrotask(() => {
					if (!configurationDeferredRef.current) return;
					configurationDeferredRef.current = false;
					setSynchronizationRevision((revision) => revision + 1);
				});
			});
			instance.on("cellEditCancelled", () => {
				queueMicrotask(() => {
					if (!configurationDeferredRef.current) return;
					configurationDeferredRef.current = false;
					setSynchronizationRevision((revision) => revision + 1);
				});
			});
			instance.on("rowClick", (_event, row) => {
				const resourceId = readResourceSheetRow(row)?.__resourceId;
				const resource = resourceId
					? runtimeRef.current.rowsById.get(resourceId)
					: undefined;
				runtimeRef.current.onRowSelectionChange?.(resource);
			});
			instance.on("rowSelectionChanged", (_data, selectedRows) => {
				if (selectedRows.length > 0) return;
				runtimeRef.current.onRowSelectionChange?.(undefined);
			});
			instance.on("cellDblClick", (_event, cell) => {
				const column = runtimeRef.current.visibleColumns.find(
					(item) => item.id === cell.getField(),
				);
				if (!column?.readOnly) return;
				const resourceId = readResourceSheetRow(cell.getRow())?.__resourceId;
				const resource = resourceId
					? runtimeRef.current.rowsById.get(resourceId)
					: undefined;
				if (resource) runtimeRef.current.onOpenRow?.(resource);
			});
			instance.on("rowMoving", (row) => {
				if (!runtimeRef.current.canMoveRows) return;
				const id = readResourceSheetRow(row)?.__resourceId;
				if (id) rowMoveStartRef.current = { id, order: orderedIds(instance) };
			});
			instance.on("rowMoved", (row) => {
				const start = rowMoveStartRef.current;
				rowMoveStartRef.current = undefined;
				if (!start || !runtimeRef.current.canMoveRows) {
					void instance.replaceData(runtimeRef.current.sheetRows);
					return;
				}
				const id = readResourceSheetRow(row)?.__resourceId;
				const nextOrder = orderedIds(instance);
				if (!id || id !== start.id || start.order.every((value, index) => value === nextOrder[index])) {
					return;
				}
				recordResourceSheetHistory(historyRef.current, {
					kind: "move",
					resourceId: id,
					previousOrder: start.order,
					nextOrder,
				});
				publishMove(id, start.order, nextOrder);
			});
			instance.on("columnMoved", (_column: ColumnComponent, renderedColumns: ColumnComponent[]) => {
				if (syncingColumnsRef.current) return;
				const runtime = runtimeRef.current;
				const visibleIds = renderedColumns
					.map((column) => column.getField())
					.filter((id): id is string => Boolean(id) && id !== "__order");
				if (visibleIds.length !== runtime.visibleColumns.length) return;
				const hiddenIds = runtime.columns
					.map((column) => column.id)
					.filter((id) => !visibleIds.includes(id));
				const orderedIds = [...visibleIds, ...hiddenIds];
				const existing = new Map(
					runtime.preferences.columns?.map((column) => [column.id, column]),
				);
				runtime.onPreferencesChange({
					...runtime.preferences,
					columns: orderedIds.map((id, order) => ({
						id,
						order,
						visible: existing.get(id)?.visible ?? true,
						width: existing.get(id)?.width ??
							runtime.columns.find((column) => column.id === id)?.width,
					})),
				});
			});
			instance.on("columnResized", (column: ColumnComponent) => {
				if (syncingColumnsRef.current) return;
				const id = column.getField();
				if (!id || id === "__order") return;
				const runtime = runtimeRef.current;
				runtime.onPreferencesChange(updateResourceColumnPreference(
					runtime.columns,
					runtime.preferences,
					id,
					{ width: column.getWidth() },
				));
			});
			instance.on("dataSorted", (sorters: SorterFromTable[]) => {
				if (syncingSortRef.current) return;
				const runtime = runtimeRef.current;
				const sort: ProjectionSort[] = sorters.flatMap((sorter) => (
					sorter.field && (sorter.dir === "asc" || sorter.dir === "desc")
						? [{ field: sorter.field, direction: sorter.dir }]
						: []
				));
				runtime.onPreferencesChange({ ...runtime.preferences, sort });
			});
			instance.on("scrollVertical", (top) => {
				const runtime = runtimeRef.current;
				if (!runtime.onNearEnd) return;
				const holder = container.querySelector<HTMLElement>(".tabulator-tableholder");
				if (!holder || holder.scrollHeight <= holder.clientHeight) return;
				const threshold = Math.max(runtime.rowHeight * 5, 120);
				if (
					holder.scrollHeight - holder.clientHeight - top <= threshold &&
					nearEndRowCountRef.current !== runtime.sheetRows.length
				) {
					nearEndRowCountRef.current = runtime.sheetRows.length;
					runtime.onNearEnd();
				}
			});

			resizeObserver = new ResizeObserver(() => {
				if (
					disposed ||
					!tableReadyRef.current ||
					tableRef.current !== instance
				) return;
				if (resizeFrameRef.current !== undefined) {
					window.cancelAnimationFrame(resizeFrameRef.current);
				}
				resizeFrameRef.current = window.requestAnimationFrame(() => {
					resizeFrameRef.current = undefined;
					if (
						disposed ||
						!tableReadyRef.current ||
						tableRef.current !== instance
					) return;
					instance.redraw(true);
				});
			});
			resizeObserver.observe(container);
		});

		return () => {
			disposed = true;
			tableReadyRef.current = false;
			document.removeEventListener("keydown", onKeyDown);
			resizeObserver?.disconnect();
			if (resizeFrameRef.current !== undefined) {
				window.cancelAnimationFrame(resizeFrameRef.current);
				resizeFrameRef.current = undefined;
			}
			for (const row of table?.getRows() ?? []) {
				for (const cell of row.getCells()) {
					if (cell.getElement().classList.contains("tabulator-editing")) {
						cell.cancelEdit();
					}
				}
			}
			if (tableRef.current === table) tableRef.current = null;
			table?.destroy();
		};
		// The imperative instance is intentionally stable. Live data, handlers,
		// selections, and saved preferences flow through refs and focused effects.
	}, []);

	useResourceSheetSynchronization({
		tableRef,
		tableReadyRef,
		configurationDeferredRef,
		syncingColumnsRef,
		syncingSortRef,
		appliedColumnConfigurationRef,
		appliedSortConfigurationRef,
		sheetRows,
		selectedRowId,
		synchronizationRevision,
		columnConfigurationKey,
		tabulatorColumns,
		sortConfigurationKey,
		sort: preferences.sort,
		canMoveRows,
		formattingConfigurationKey,
		containerRef,
	});

	return (
		<div
			ref={containerRef}
			className={cn(
				"coleo-resource-sheet coleo-tabulator-resource-sheet h-full min-h-0 overflow-hidden",
				className,
			)}
			role="region"
			aria-label="Resource spreadsheet"
			tabIndex={0}
		/>
	);
}
