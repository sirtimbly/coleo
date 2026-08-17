import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Minus, MoveHorizontal, Plus, Type } from "lucide-react";

import { WorkbenchSurface } from "@/design-system/WorkbenchSurface";
import { cn } from "@/lib";
import { formatToolbarWidgetLabel } from "./toolbars-page-utils";

import type { ReactNode } from "react";
import type { ToolbarStructureKind } from "./toolbar-visual-editor-utils";

export interface ToolbarPaletteWidgetDragData {
	type: "palette-widget";
	widgetId: string;
	label: string;
}

export interface ToolbarPaletteStructureDragData {
	type: "palette-structure";
	kind: ToolbarStructureKind;
	label: string;
}

export type ToolbarPaletteDragData = ToolbarPaletteWidgetDragData | ToolbarPaletteStructureDragData;

interface ToolbarVisualPaletteProps {
	widgetIds: readonly string[];
	disabled: boolean;
}

const STRUCTURE_ITEMS = [
	{ kind: "label", label: "Label", description: "Short text that identifies a control group", icon: Type },
	{ kind: "divider", label: "Divider", description: "A vertical rule between related controls", icon: Minus },
	{ kind: "spacer", label: "Flexible space", description: "Pushes later controls toward the row edge", icon: MoveHorizontal },
] as const satisfies ReadonlyArray<{
	kind: ToolbarStructureKind;
	label: string;
	description: string;
	icon: typeof Type;
}>;

function PaletteItem({
	dragId,
	data,
	description,
	icon,
	disabled,
}: {
	dragId: string;
	data: ToolbarPaletteDragData;
	description: string;
	icon: ReactNode;
	disabled: boolean;
}) {
	const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
		id: dragId,
		data,
		disabled,
	});
	return (
		<button
			ref={setNodeRef}
			type="button"
			{...attributes}
			{...listeners}
			disabled={disabled}
			aria-label={`Drag ${data.label}`}
			title={`${data.label}: ${description}`}
			style={{ transform: CSS.Translate.toString(transform) }}
			className={cn(
				"flex h-9 w-full cursor-grab items-center border border-border bg-surface text-left outline-none hover:border-accent/50 hover:bg-accent/5 focus-visible:ring-2 focus-visible:ring-accent active:cursor-grabbing disabled:cursor-not-allowed",
				isDragging && "opacity-30",
			)}
		>
			<span className="inline-flex h-full w-7 shrink-0 items-center justify-center border-r border-border text-muted-foreground">
				<GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
			</span>
			<span className="mx-2 flex h-5 w-5 shrink-0 items-center justify-center border border-border bg-surface-secondary text-accent">
				{icon}
			</span>
			<span className="min-w-0 flex-1 truncate pr-2 text-xs font-medium text-foreground">{data.label}</span>
		</button>
	);
}

export function ToolbarVisualPalette({
	widgetIds,
	disabled,
}: ToolbarVisualPaletteProps) {
	return (
		<WorkbenchSurface className="min-w-0">
			<div className="border-b border-border px-3 py-2.5">
				<h2 className="text-sm font-semibold">Available controls</h2>
				<p className="mt-0.5 text-xs text-muted-foreground">Drag a control into either toolbar row.</p>
			</div>
			<div className="space-y-3 p-2">
				<section aria-labelledby="toolbar-widget-palette-heading" className="min-w-0">
					<h3 id="toolbar-widget-palette-heading" className="px-1 pb-1.5 text-[0.66rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
						Optional widgets
					</h3>
					<div className="space-y-1.5">
						{widgetIds.length > 0 ? widgetIds.map((widgetId) => {
							const label = formatToolbarWidgetLabel(widgetId);
							return (
								<PaletteItem
									key={widgetId}
									dragId={`palette-widget:${widgetId}`}
									data={{ type: "palette-widget", widgetId, label }}
									description={widgetId}
									icon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
									disabled={disabled}
								/>
							);
						}) : (
							<p className="border border-dashed border-border px-2 py-2 text-[0.68rem] leading-4 text-muted-foreground">
								All available widgets are already in this toolbar.
							</p>
						)}
					</div>
				</section>

				<section aria-labelledby="toolbar-structure-palette-heading">
					<h3 id="toolbar-structure-palette-heading" className="px-1 pb-1.5 text-[0.66rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
						Structure
					</h3>
					<div className="space-y-1.5">
						{STRUCTURE_ITEMS.map(({ kind, label, description, icon: Icon }) => (
							<PaletteItem
								key={kind}
								dragId={`palette-structure:${kind}`}
								data={{ type: "palette-structure", kind, label }}
								description={description}
								icon={<Icon className="h-3.5 w-3.5" aria-hidden="true" />}
								disabled={disabled}
							/>
						))}
					</div>
				</section>
			</div>
		</WorkbenchSurface>
	);
}
