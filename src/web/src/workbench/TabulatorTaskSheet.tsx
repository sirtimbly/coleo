/**
 * Opt-in Tabulator projection used to validate the Handsontable migration.
 *
 * The component deliberately proves only the first migration gate: realistic
 * Tasks data in Golden Layout, dark theming, resize handling, row selection,
 * inline subject/status editing, whole-row dragging, and the Details action.
 * Handsontable remains the default ResourceSheet runtime while this comparison
 * surface is evaluated.
 */

import { useEffect, useMemo, useRef } from "react";
import { TabulatorFull as Tabulator } from "tabulator-tables";

import { getResourceStatusStyle } from "@/design-system/resource-status-styles";
import { normalizeRowColor } from "@/design-system/row-formatting";

import {
	createTabulatorTaskUpdate,
	resolveTabulatorTaskMove,
	TABULATOR_TASK_STATUSES,
	toTabulatorTaskRows,
	type TabulatorTaskRow,
} from "./tabulator-task-model";

import type { Task } from "@/lib";
import type { TaskUpdate } from "./resource-updates";
import type { ResourceSheetRowMove } from "./ResourceSheet";
import type {
	CellComponent,
	ColumnDefinition,
	MenuObject,
	RowComponent,
} from "tabulator-tables";

import "tabulator-tables/dist/css/tabulator.min.css";
import "./tabulator-task-sheet.css";

interface TabulatorTaskSheetHandlers {
	onOpenDetails?: (task: Task) => void;
	onUpdateTask?: (taskId: string, updates: TaskUpdate) => void;
	onRowsMove?: (moves: ResourceSheetRowMove<Task>[]) => void | Promise<void>;
	onLoadMore?: () => void;
}

export interface TabulatorTaskSheetProps extends TabulatorTaskSheetHandlers {
	tasks: Task[];
	selectedTaskId?: string;
	hasNextPage?: boolean;
	draftFilterToggleRequest?: number;
	onDraftsOnlyChange?: (active: boolean) => void;
}

function readTaskRow(component: RowComponent): TabulatorTaskRow | undefined {
	const data = component.getData();
	if (!data || typeof data !== "object" || typeof data.id !== "string") {
		return undefined;
	}
	return data as TabulatorTaskRow;
}

function taskFromRow(component: RowComponent, tasks: readonly Task[]): Task | undefined {
	const row = readTaskRow(component);
	return row ? tasks.find((task) => task.id === row.id) : undefined;
}

function statusFormatter(cell: CellComponent): HTMLElement {
	const status = String(cell.getValue()) as Task["status"];
	const style = getResourceStatusStyle("task", status);
	const badge = document.createElement("span");
	badge.className = "coleo-tabulator-status";
	badge.textContent = style?.label ?? status;
	if (style) badge.style.setProperty("--coleo-tabulator-status", style.color);
	return badge;
}

function progressFormatter(cell: CellComponent): HTMLElement {
	const progress = Number(cell.getValue());
	const value = Number.isFinite(progress)
		? Math.max(0, Math.min(100, progress))
		: 0;
	const wrapper = document.createElement("span");
	wrapper.className = "coleo-tabulator-progress";
	wrapper.setAttribute("aria-label", `${value}% complete`);
	const bar = document.createElement("span");
	bar.style.width = `${value}%`;
	const label = document.createElement("span");
	label.textContent = `${value}%`;
	wrapper.append(bar, label);
	return wrapper;
}

const STATUS_EDITOR_VALUES = Object.fromEntries(
	TABULATOR_TASK_STATUSES.map((status) => [
		status,
		getResourceStatusStyle("task", status)?.label ?? status,
	]),
);

const TASK_COLUMNS: ColumnDefinition[] = [
	{
		title: "Subject",
		field: "subject",
		editor: "input",
		validator: (cell, value) => (
			typeof value === "string" &&
			value.trim().length > 0 &&
			value.trim() !== String(cell.getOldValue()).trim()
				? true
				: value === cell.getOldValue()
		),
		width: 360,
		minWidth: 220,
		widthGrow: 2,
		cssClass: "coleo-tabulator-primary-cell",
	},
	{
		title: "Status",
		field: "status",
		editor: "list",
		editorParams: {
			values: STATUS_EDITOR_VALUES,
			autocomplete: false,
			clearable: false,
		},
		formatter: statusFormatter,
		width: 140,
	},
	{ title: "Priority", field: "priority", width: 105 },
	{ title: "Phase", field: "phase", width: 140 },
	{ title: "Domain", field: "domain", width: 125 },
	{ title: "Arm", field: "arm", width: 145 },
	{
		title: "Progress",
		field: "progress",
		formatter: progressFormatter,
		hozAlign: "left",
		width: 110,
	},
	{ title: "Source", field: "source", width: 110 },
	{ title: "Updated", field: "updatedAt", width: 175 },
];

export function TabulatorTaskSheet({
	tasks,
	selectedTaskId,
	onOpenDetails,
	onUpdateTask,
	onRowsMove,
	onLoadMore,
	hasNextPage = false,
	draftFilterToggleRequest = 0,
	onDraftsOnlyChange,
}: TabulatorTaskSheetProps) {
	const rows = useMemo(() => toTabulatorTaskRows(tasks), [tasks]);
	const hostRef = useRef<HTMLDivElement>(null);
	const tableRef = useRef<Tabulator | null>(null);
	const tasksRef = useRef(tasks);
	const rowsRef = useRef(rows);
	const selectedTaskIdRef = useRef(selectedTaskId);
	const tableReadyRef = useRef(false);
	const handlersRef = useRef<TabulatorTaskSheetHandlers>({
		onOpenDetails,
		onUpdateTask,
		onRowsMove,
		onLoadMore,
	});
	const rowMoveStartRef = useRef<{ taskId: string; index: number } | undefined>(undefined);
	const hasNextPageRef = useRef(hasNextPage);
	const draftFilterRef = useRef({
		active: false,
		request: draftFilterToggleRequest,
	});
	const nearEndRequestedRef = useRef(false);

	tasksRef.current = tasks;
	rowsRef.current = rows;
	selectedTaskIdRef.current = selectedTaskId;
	hasNextPageRef.current = hasNextPage;
	handlersRef.current = {
		onOpenDetails,
		onUpdateTask,
		onRowsMove,
		onLoadMore,
	};

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;

		let disposed = false;
		let table: Tabulator | null = null;
		let resizeObserver: ResizeObserver | null = null;
		let redrawFrame: number | undefined;
		const detailsMenu: MenuObject<RowComponent>[] = [{
			label: "Details",
			action: (_event, row) => {
				const task = taskFromRow(row, tasksRef.current);
				if (task) handlersRef.current.onOpenDetails?.(task);
			},
		}];
		queueMicrotask(() => {
			if (disposed) return;
			const instance = new Tabulator(host, {
				index: "id",
				data: rowsRef.current,
				columns: TASK_COLUMNS,
				height: "100%",
				layout: "fitDataStretch",
				renderVertical: "virtual",
				renderVerticalBuffer: 320,
				rowHeight: 34,
				selectableRows: 1,
				selectableRowsPersistence: true,
				movableRows: true,
				movableColumns: true,
				resizableColumnFit: false,
				history: true,
				clipboard: true,
				validationMode: "blocking",
				popupContainer: host,
				rowContextMenu: detailsMenu,
				columnDefaults: {
					headerSort: false,
					resizable: true,
					vertAlign: "middle",
				},
				rowFormatter: (row) => {
					const data = readTaskRow(row);
					if (!data) return;
					const element = row.getElement();
					element.dataset.resourceId = data.id;
					element.classList.toggle("coleo-tabulator-row-bold", data.bold);
					element.dataset.rowColor = normalizeRowColor(data.color);
				},
			});
			table = instance;
			tableRef.current = instance;

			instance.on("tableBuilt", () => {
				if (disposed) return;
				tableReadyRef.current = true;
				void instance.replaceData(rowsRef.current).then(() => {
					const selectedId = selectedTaskIdRef.current;
					if (selectedId) instance.selectRow(selectedId);
				});
			});
			instance.on("cellEdited", (cell) => {
				const row = readTaskRow(cell.getRow());
				if (!row) return;
				const updates = createTabulatorTaskUpdate(cell.getField(), cell.getValue());
				if (!updates) {
					cell.restoreOldValue();
					return;
				}
				handlersRef.current.onUpdateTask?.(row.id, updates);
			});
			instance.on("rowMoving", (row) => {
				const data = readTaskRow(row);
				const index = data
					? instance.getRows("active").findIndex((candidate) => readTaskRow(candidate)?.id === data.id)
					: -1;
				if (data && index >= 0) rowMoveStartRef.current = { taskId: data.id, index };
			});
			instance.on("rowMoved", (row) => {
				const start = rowMoveStartRef.current;
				rowMoveStartRef.current = undefined;
				const data = readTaskRow(row);
				if (!start || !data || start.taskId !== data.id) return;
				const orderedTaskIds = instance
					.getRows("active")
					.map((candidate) => readTaskRow(candidate)?.id)
					.filter((id): id is string => Boolean(id));
				const move = resolveTabulatorTaskMove(
					tasksRef.current,
					data.id,
					start.index,
					orderedTaskIds,
				);
				if (move) void handlersRef.current.onRowsMove?.([move]);
			});
			instance.on("scrollVertical", (top) => {
				if (!hasNextPageRef.current || nearEndRequestedRef.current) return;
				const holder = host.querySelector<HTMLElement>(".tabulator-tableholder");
				if (!holder || holder.scrollHeight <= holder.clientHeight) return;
				const remaining = holder.scrollHeight - holder.clientHeight - top;
				if (remaining > holder.clientHeight) return;
				nearEndRequestedRef.current = true;
				handlersRef.current.onLoadMore?.();
			});

			resizeObserver = new ResizeObserver(() => {
				if (
					disposed ||
					!tableReadyRef.current ||
					tableRef.current !== instance
				) return;
				if (redrawFrame !== undefined) window.cancelAnimationFrame(redrawFrame);
				redrawFrame = window.requestAnimationFrame(() => {
					redrawFrame = undefined;
					if (
						disposed ||
						!tableReadyRef.current ||
						tableRef.current !== instance
					) return;
					instance.redraw(true);
				});
			});
			resizeObserver.observe(host);
		});

		return () => {
			disposed = true;
			tableReadyRef.current = false;
			resizeObserver?.disconnect();
			if (redrawFrame !== undefined) window.cancelAnimationFrame(redrawFrame);
			if (tableRef.current === table) tableRef.current = null;
			table?.destroy();
		};
		// The instance is intentionally stable; data and callbacks flow through
		// refs/effects so React Query updates do not rebuild the imperative grid.
	}, []);

	useEffect(() => {
		const table = tableRef.current;
		if (!table || !tableReadyRef.current) return;
		nearEndRequestedRef.current = false;
		void table.replaceData(rows).then(() => {
			if (selectedTaskId) table.selectRow(selectedTaskId);
		});
	}, [rows, selectedTaskId]);

	useEffect(() => {
		const table = tableRef.current;
		if (!table || !tableReadyRef.current) return;
		table.deselectRow();
		if (selectedTaskId) table.selectRow(selectedTaskId);
	}, [selectedTaskId]);

	useEffect(() => {
		const table = tableRef.current;
		const state = draftFilterRef.current;
		if (
			!table ||
			!tableReadyRef.current ||
			state.request === draftFilterToggleRequest
		) return;
		state.request = draftFilterToggleRequest;
		state.active = !state.active;
		if (state.active) table.setFilter("status", "=", "draft");
		else table.clearFilter(true);
		onDraftsOnlyChange?.(state.active);
	}, [draftFilterToggleRequest, onDraftsOnlyChange]);

	return (
		<div
			className="coleo-tabulator-task-sheet relative flex h-full min-h-0 flex-col"
			data-testid="tabulator-task-sheet"
		>
			<div className="coleo-tabulator-preview-note">
				<span>Tabulator migration preview</span>
				<span>Click a row · edit Subject or Status · drag any row · right-click for Details</span>
			</div>
			<div
				ref={hostRef}
				className="coleo-tabulator-host min-h-0 flex-1"
				role="region"
				aria-label="Tabulator Tasks migration preview"
			/>
		</div>
	);
}
