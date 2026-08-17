import { useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
	DndContext,
	DragOverlay,
	KeyboardSensor,
	MeasuringStrategy,
	PointerSensor,
	closestCenter,
	useDroppable,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	SortableContext,
	horizontalListSortingStrategy,
	sortableKeyboardCoordinates,
	useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
	Eye,
	EyeOff,
	GripVertical,
	MoveHorizontal,
	Trash2,
} from "lucide-react";

import { WorkbenchSurface } from "@/design-system/WorkbenchSurface";
import { cn } from "@/lib";
import { ToolbarVisualPalette } from "./ToolbarVisualPalette";
import {
	createToolbarStructureItem,
	createToolbarWidgetItem,
	insertToolbarItem,
	moveToolbarItem,
	removeToolbarItem,
	replaceToolbarItem,
	updateToolbarRow,
} from "./toolbar-visual-editor-utils";
import { formatToolbarWidgetLabel } from "./toolbars-page-utils";

import type {
	Announcements,
	DragCancelEvent,
	DragEndEvent,
	DragOverEvent,
	DragStartEvent,
} from "@dnd-kit/core";
import type {
	ToolbarRowTemplate,
	ToolbarTemplateItem,
	ToolbarWidgetItem,
	WorkbenchToolbarTemplate,
} from "../../../workbench/toolbar-templates";
import type {
	ToolbarRowIndex,
	ToolbarStructureKind,
} from "./toolbar-visual-editor-utils";
import type {
	ToolbarPaletteStructureDragData,
	ToolbarPaletteWidgetDragData,
} from "./ToolbarVisualPalette";

interface ToolbarVisualEditorProps {
	template: WorkbenchToolbarTemplate;
	widgetIds: readonly string[];
	disabled: boolean;
	header: ReactNode;
	footer: ReactNode;
	onChange: (template: WorkbenchToolbarTemplate) => void;
}

interface ItemDragData {
	type: "item";
	rowIndex: ToolbarRowIndex;
	itemIndex: number;
	label: string;
	rowLabel: string;
}

interface RowDragData {
	type: "row";
	rowIndex: ToolbarRowIndex;
	label: string;
}

type ToolbarDragData =
	| ItemDragData
	| RowDragData
	| ToolbarPaletteWidgetDragData
	| ToolbarPaletteStructureDragData;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDragData(value: unknown): ToolbarDragData | null {
	if (!isRecord(value) || typeof value.type !== "string") return null;
	if (value.type === "item"
		&& (value.rowIndex === 0 || value.rowIndex === 1)
		&& typeof value.itemIndex === "number"
		&& typeof value.label === "string"
		&& typeof value.rowLabel === "string") {
		return value as unknown as ItemDragData;
	}
	if (value.type === "row"
		&& (value.rowIndex === 0 || value.rowIndex === 1)
		&& typeof value.label === "string") {
		return value as unknown as RowDragData;
	}
	if (value.type === "palette-widget"
		&& typeof value.widgetId === "string"
		&& typeof value.label === "string") {
		return value as unknown as ToolbarPaletteWidgetDragData;
	}
	if (value.type === "palette-structure"
		&& (value.kind === "label" || value.kind === "divider" || value.kind === "spacer")
		&& typeof value.label === "string") {
		return value as unknown as ToolbarPaletteStructureDragData;
	}
	return null;
}

function itemLabel(item: ToolbarTemplateItem): string {
	if (item.kind === "widget") return formatToolbarWidgetLabel(item.widget);
	if (item.kind === "label") return `Label: ${item.text}`;
	if (item.kind === "divider") return "Divider";
	return "Flexible space";
}

function itemEditorId(rowIndex: ToolbarRowIndex, item: ToolbarTemplateItem): string {
	return `toolbar-item:${rowIndex}:${item.id}`;
}

function rowEditorId(rowIndex: ToolbarRowIndex): string {
	return `toolbar-row:${rowIndex}`;
}

function withoutWidgetLabel(item: ToolbarWidgetItem): ToolbarWidgetItem {
	const next = { ...item };
	delete next.label;
	return next;
}

function blurOnEnter(event: KeyboardEvent<HTMLInputElement>): void {
	if (event.key === "Enter") event.currentTarget.blur();
}

function SortableToolbarItem({
	item,
	rowIndex,
	itemIndex,
	rowLabel,
	rowSize,
	disabled,
	onChange,
	onRemove,
}: {
	item: ToolbarTemplateItem;
	rowIndex: ToolbarRowIndex;
	itemIndex: number;
	rowLabel: string;
	rowSize: "small" | "large";
	disabled: boolean;
	onChange: (item: ToolbarTemplateItem) => void;
	onRemove: () => void;
}) {
	const label = itemLabel(item);
	const {
		attributes,
		listeners,
		setActivatorNodeRef,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({
		id: itemEditorId(rowIndex, item),
		data: { type: "item", rowIndex, itemIndex, label, rowLabel } satisfies ItemDragData,
		disabled,
	});
	const style = {
		transform: CSS.Translate.toString(transform),
		transition,
		zIndex: isDragging ? 10 : 1,
	};

	return (
		<div
			ref={setNodeRef}
			style={style}
			role="listitem"
			title={item.kind === "widget" ? item.widget : label}
			className={cn(
				"group relative flex min-w-0 shrink-0 items-stretch border border-border bg-surface shadow-sm",
				rowSize === "small" ? "h-8" : "h-10",
				item.kind === "spacer" && "min-w-20 flex-1",
				item.hidden && "border-dashed opacity-60",
				isDragging && "opacity-35",
			)}
		>
			<button
				ref={setActivatorNodeRef}
				type="button"
				{...attributes}
				{...listeners}
				disabled={disabled}
				aria-label={`Move ${label}`}
				className="inline-flex w-6 shrink-0 cursor-grab items-center justify-center border-r border-border bg-surface-secondary/45 text-muted-foreground outline-none hover:bg-accent/10 hover:text-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent active:cursor-grabbing disabled:cursor-not-allowed"
			>
				<GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
			</button>

			<div className={cn("flex min-w-0 items-center", item.kind === "spacer" ? "flex-1 px-2" : "px-2")}>
				{item.kind === "widget" ? (
					<span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs font-medium text-foreground">
						{item.label ? (
							<span className="text-[0.62rem] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
								{item.label}
							</span>
						) : null}
						{formatToolbarWidgetLabel(item.widget)}
					</span>
				) : null}
				{item.kind === "label" ? (
					<input
						key={`${item.id}:${item.text}`}
						defaultValue={item.text}
						disabled={disabled}
						name={`toolbar-label-${rowIndex}-${item.id}`}
						autoComplete="off"
						aria-label="Label text"
						onKeyDown={blurOnEnter}
						onBlur={(event) => {
							const text = event.currentTarget.value.trim();
							if (text) onChange({ ...item, text });
							else event.currentTarget.value = item.text;
						}}
						className="h-6 w-24 bg-transparent px-1 text-[0.68rem] font-semibold uppercase tracking-[0.1em] text-muted-foreground outline-none focus:bg-background focus:ring-2 focus:ring-accent disabled:cursor-not-allowed"
					/>
				) : null}
				{item.kind === "divider" ? <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" /> : null}
				{item.kind === "spacer" ? (
					<span className="flex min-w-12 flex-1 items-center gap-1.5 text-muted-foreground" aria-hidden="true">
						<span className="h-px flex-1 border-t border-dashed border-accent/45" />
						<MoveHorizontal className="h-3.5 w-3.5" />
						<span className="h-px flex-1 border-t border-dashed border-accent/45" />
					</span>
				) : null}
			</div>

			<div className="flex shrink-0 items-center border-l border-border bg-surface-secondary/25 opacity-60 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
				{item.kind === "widget" ? (
					<button
						type="button"
						disabled={disabled}
						onClick={() => onChange(item.label
							? withoutWidgetLabel(item)
							: { ...item, label: formatToolbarWidgetLabel(item.widget) })}
						aria-label={item.label ? `Hide label for ${label}` : `Show label for ${label}`}
						title={item.label ? "Hide widget label" : "Show widget label"}
						className="inline-flex h-full w-6 items-center justify-center text-muted-foreground outline-none hover:bg-accent/10 hover:text-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent disabled:cursor-not-allowed"
					>
						{item.label
							? <Eye className="h-3 w-3" aria-hidden="true" />
							: <EyeOff className="h-3 w-3" aria-hidden="true" />}
					</button>
				) : null}
				<button
					type="button"
					disabled={disabled}
					onClick={onRemove}
					aria-label={`Remove ${label}`}
					title="Remove item"
					className="inline-flex h-full w-6 items-center justify-center text-muted-foreground outline-none hover:bg-danger/10 hover:text-danger focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-danger disabled:cursor-not-allowed"
				>
					<Trash2 className="h-3 w-3" aria-hidden="true" />
				</button>
			</div>
		</div>
	);
}

function ToolbarEditorRow({
	row,
	rowIndex,
	disabled,
	onRowChange,
	onItemChange,
	onItemRemove,
}: {
	row: ToolbarRowTemplate;
	rowIndex: ToolbarRowIndex;
	disabled: boolean;
	onRowChange: (updates: { size?: "small" | "large" }) => void;
	onItemChange: (itemIndex: number, item: ToolbarTemplateItem) => void;
	onItemRemove: (itemIndex: number) => void;
}) {
	const { setNodeRef, isOver } = useDroppable({
		id: rowEditorId(rowIndex),
		data: { type: "row", rowIndex, label: row.label } satisfies RowDragData,
		disabled,
	});
	const sortableIds = row.items.map((item) => itemEditorId(rowIndex, item));

	return (
		<section
			className={cn(
				"border border-border bg-background transition-colors",
				isOver && "border-accent bg-accent/5 ring-2 ring-inset ring-accent/30",
			)}
		>
			<div className="flex h-8 items-center gap-2 border-b border-border bg-surface-secondary/45 px-2.5">
				<span className="text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
					Row {rowIndex + 1}
				</span>
				<span className="text-[0.65rem] tabular-nums text-muted-foreground">
					{row.items.length} {row.items.length === 1 ? "item" : "items"}
				</span>
				<label className="ml-auto text-[0.62rem] font-medium uppercase tracking-[0.1em] text-muted-foreground">
					Density
					<select
						value={row.size}
						disabled={disabled}
						onChange={(event) => onRowChange({ size: event.currentTarget.value as "small" | "large" })}
						aria-label={`Row ${rowIndex + 1} density`}
						className="ml-2 h-6 border border-border bg-surface px-1.5 text-[0.68rem] normal-case tracking-normal text-foreground outline-none focus:border-accent disabled:cursor-not-allowed"
					>
						<option value="small">Compact</option>
						<option value="large">Comfortable</option>
					</select>
				</label>
			</div>

			<SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
				<div
					ref={setNodeRef}
					role="list"
					aria-label={`${row.label} editor items`}
					className={cn(
						"toolbar-visual-lane flex min-w-0 items-center gap-1 overflow-x-auto bg-surface-secondary/25 p-2",
						row.size === "small" ? "min-h-12" : "min-h-14",
					)}
				>
					{row.items.map((item, itemIndex) => (
						<SortableToolbarItem
							key={item.id}
							item={item}
							rowIndex={rowIndex}
							itemIndex={itemIndex}
							rowLabel={row.label}
							rowSize={row.size}
							disabled={disabled}
							onChange={(nextItem) => onItemChange(itemIndex, nextItem)}
							onRemove={() => onItemRemove(itemIndex)}
						/>
					))}
					{row.items.length === 0 ? (
						<div className="flex h-9 min-w-full items-center justify-center border border-dashed border-border px-4 text-center text-xs text-muted-foreground">
							Drop controls here
						</div>
					) : null}
				</div>
			</SortableContext>
		</section>
	);
}

function targetDescription(data: ToolbarDragData | null): string {
	if (!data) return "outside the toolbar rows";
	if (data.type === "row") return data.label;
	if (data.type === "item") return `${data.rowLabel}, near ${data.label}`;
	return data.label;
}

const ANNOUNCEMENTS: Announcements = {
	onDragStart({ active }: DragStartEvent) {
		const data = readDragData(active.data.current);
		return data ? `Picked up ${data.label}.` : "Picked up toolbar item.";
	},
	onDragOver({ over }: DragOverEvent) {
		return `Moving over ${targetDescription(readDragData(over?.data.current))}.`;
	},
	onDragEnd({ active, over }: DragEndEvent) {
		const activeData = readDragData(active.data.current);
		return `Placed ${activeData?.label ?? "toolbar item"} ${targetDescription(readDragData(over?.data.current))}.`;
	},
	onDragCancel({ active }: DragCancelEvent) {
		const data = readDragData(active.data.current);
		return `Cancelled moving ${data?.label ?? "toolbar item"}.`;
	},
};

export function ToolbarVisualEditor({
	template,
	widgetIds,
	disabled,
	header,
	footer,
	onChange,
}: ToolbarVisualEditorProps) {
	const [activeLabel, setActiveLabel] = useState<string | null>(null);
	const availableWidgetIds = widgetIds.filter((widgetId) => !template.rows.some((row) => (
		row.items.some((item) => item.kind === "widget" && item.widget === widgetId)
	)));
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);

	const addWidget = (widgetId: string, rowIndex: ToolbarRowIndex, itemIndex?: number) => {
		const item = createToolbarWidgetItem(template, widgetId);
		onChange(insertToolbarItem(
			template,
			rowIndex,
			itemIndex ?? template.rows[rowIndex].items.length,
			item,
		));
	};

	const addStructure = (kind: ToolbarStructureKind, rowIndex: ToolbarRowIndex, itemIndex?: number) => {
		const item = createToolbarStructureItem(template, kind);
		onChange(insertToolbarItem(
			template,
			rowIndex,
			itemIndex ?? template.rows[rowIndex].items.length,
			item,
		));
	};

	const handleDragStart = (event: DragStartEvent) => {
		setActiveLabel(readDragData(event.active.data.current)?.label ?? "Toolbar item");
	};

	const handleDragCancel = () => {
		setActiveLabel(null);
	};

	const handleDragEnd = (event: DragEndEvent) => {
		setActiveLabel(null);
		if (disabled || !event.over) return;
		const activeData = readDragData(event.active.data.current);
		const overData = readDragData(event.over.data.current);
		if (!activeData || !overData || (overData.type !== "row" && overData.type !== "item")) return;
		const targetRowIndex = overData.rowIndex;
		const targetItemIndex = overData.type === "item"
			? overData.itemIndex
			: template.rows[targetRowIndex].items.length;
		if (activeData.type === "item") {
			onChange(moveToolbarItem(
				template,
				activeData.rowIndex,
				activeData.itemIndex,
				targetRowIndex,
				targetItemIndex,
			));
		} else if (activeData.type === "palette-widget") {
			addWidget(activeData.widgetId, targetRowIndex, targetItemIndex);
		} else if (activeData.type === "palette-structure") {
			addStructure(activeData.kind, targetRowIndex, targetItemIndex);
		}
	};

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={closestCenter}
			measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
			onDragStart={handleDragStart}
			onDragCancel={handleDragCancel}
			onDragEnd={handleDragEnd}
			accessibility={{ announcements: ANNOUNCEMENTS }}
		>
			<div className="toolbar-visual-editor-grid grid min-w-0 gap-3">
				<ToolbarVisualPalette widgetIds={availableWidgetIds} disabled={disabled} />

				<WorkbenchSurface className="flex min-w-0 flex-col">
					{header}
					<div className="space-y-2 bg-surface p-3">
						<p className="text-xs text-muted-foreground">
							Drag controls into either row, or move existing controls into a new position.
						</p>
						{template.rows.map((row, index) => {
							const rowIndex = index as ToolbarRowIndex;
							return (
								<ToolbarEditorRow
									key={row.id}
									row={row}
									rowIndex={rowIndex}
									disabled={disabled}
									onRowChange={(updates) => onChange(updateToolbarRow(template, rowIndex, updates))}
									onItemChange={(itemIndex, item) => onChange(replaceToolbarItem(template, rowIndex, itemIndex, item))}
									onItemRemove={(itemIndex) => onChange(removeToolbarItem(template, rowIndex, itemIndex))}
								/>
							);
						})}
					</div>
					{footer}
				</WorkbenchSurface>
			</div>

			{typeof document === "undefined" ? null : createPortal(
				<DragOverlay dropAnimation={null}>
					{activeLabel ? (
						<div className="flex min-w-44 items-center gap-2 border border-accent bg-surface px-3 py-2 text-xs font-medium text-foreground shadow-lg">
							<GripVertical className="h-4 w-4 text-accent" aria-hidden="true" />
							{activeLabel}
						</div>
					) : null}
				</DragOverlay>,
				document.body,
			)}
		</DndContext>
	);
}
