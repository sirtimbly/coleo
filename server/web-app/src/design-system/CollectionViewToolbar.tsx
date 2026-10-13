import { startTransition, useLayoutEffect, useRef, useState } from "react";
import { Button, ButtonGroup } from "@heroui/react";
import { AlignJustify, Grid2X2, LayoutGrid, Rows3, Table2 } from "lucide-react";

import { ProjectionMenuTrigger } from "./ProjectionControls";
import {
	ToolbarTemplateRow,
	type ToolbarWidgetRegistry,
} from "./toolbar-template";
import { useToolbarTemplate } from "@/workbench/toolbar-template-context";

import type {
	CardColumnCount,
	CollectionDisplayPreferences,
} from "@/workbench/collection-display";

type CollectionToolbarScreenId = "tasks" | "bugs" | "processes";

interface CollectionViewWidgetOptions {
	resourceName: string;
	display: CollectionDisplayPreferences;
	onChange: (updates: Partial<CollectionDisplayPreferences>) => void;
	onConfigure?: () => void;
	filterCount?: number;
	sortLabel?: string;
}

interface CollectionViewToolbarProps extends CollectionViewWidgetOptions {
	screenId: CollectionToolbarScreenId;
	extensionWidgets?: ToolbarWidgetRegistry;
}

export function CollectionViewToolbar({
	screenId,
	extensionWidgets,
	...options
}: CollectionViewToolbarProps) {
	const template = useToolbarTemplate(screenId);
	const widgets = useCollectionViewToolbarWidgets(options);

	return (
		<ToolbarTemplateRow
			row={template.rows[1]}
			widgets={{ ...widgets, ...extensionWidgets }}
		/>
	);
}

export function useCollectionViewToolbarWidgets({
	resourceName,
	display,
	onChange,
	onConfigure,
	filterCount = 0,
	sortLabel,
}: CollectionViewWidgetOptions): ToolbarWidgetRegistry {
	const markerRef = useRef<HTMLSpanElement>(null);
	const [availableCardColumns, setAvailableCardColumns] = useState<CardColumnCount>(1);
	const effectiveCardColumns = Math.min(
		display.cardColumns,
		availableCardColumns,
	) as CardColumnCount;
	const viewSummary = [
		filterCount > 0
			? `${filterCount} ${filterCount === 1 ? "filter" : "filters"}`
			: undefined,
		sortLabel,
	].filter(Boolean).join(" / ") || "Default";
	const update = (updates: Partial<CollectionDisplayPreferences>) => {
		startTransition(() => onChange(updates));
	};

	useLayoutEffect(() => {
		const toolbar = markerRef.current?.closest<HTMLElement>('[role="toolbar"]');
		if (!toolbar) return;
		const updateAvailableColumns = (width: number) => {
			// Card collections reserve 24px for horizontal padding around the grid.
			setAvailableCardColumns(width <= 568 ? 1 : width <= 856 ? 2 : 4);
		};
		updateAvailableColumns(toolbar.getBoundingClientRect().width);
		const observer = new ResizeObserver(([entry]) => {
			if (entry) updateAvailableColumns(entry.contentRect.width);
		});
		observer.observe(toolbar);
		return () => observer.disconnect();
	}, []);

	return {
		"collection.view-mode": (
			<>
				<span ref={markerRef} aria-hidden="true" className="hidden" />
				<ButtonGroup size="sm" variant="ghost" aria-label={`${resourceName} display`}>
					<Button
						aria-pressed={display.mode === "grid"}
						aria-label={`Show ${resourceName} as a data grid`}
						variant={display.mode === "grid" ? "secondary" : "ghost"}
						onPress={() => update({ mode: "grid" })}
						className="h-7 min-w-0 px-2"
					>
						<Table2 className="h-3.5 w-3.5" aria-hidden="true" />
						Grid
					</Button>
					<Button
						aria-pressed={display.mode === "cards"}
						aria-label={`Show ${resourceName} as cards`}
						variant={display.mode === "cards" ? "secondary" : "ghost"}
						onPress={() => update({ mode: "cards" })}
						className="h-7 min-w-0 px-2"
					>
						<LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" />
						Cards
					</Button>
				</ButtonGroup>
			</>
		),
		"collection.grid-density": display.mode === "grid" ? (
			<ButtonGroup size="sm" variant="ghost" aria-label={`${resourceName} row density`}>
				<Button
					isIconOnly
					aria-label="Use compact rows"
					aria-pressed={display.density === "compact"}
					variant={display.density === "compact" ? "secondary" : "ghost"}
					onPress={() => update({ density: "compact" })}
					className="h-7 min-h-7 w-7 min-w-7"
				>
					<Rows3 className="h-3.5 w-3.5" aria-hidden="true" />
				</Button>
				<Button
					isIconOnly
					aria-label="Use full rows"
					aria-pressed={display.density === "comfortable"}
					variant={display.density === "comfortable" ? "secondary" : "ghost"}
					onPress={() => update({ density: "comfortable" })}
					className="h-7 min-h-7 w-7 min-w-7"
				>
					<AlignJustify className="h-3.5 w-3.5" aria-hidden="true" />
				</Button>
			</ButtonGroup>
		) : null,
		"collection.card-presentation": display.mode === "cards" ? (
			<ButtonGroup size="sm" variant="ghost" aria-label={`${resourceName} card detail`}>
				<Button
					aria-pressed={display.cardPresentation === "compact"}
					variant={display.cardPresentation === "compact" ? "secondary" : "ghost"}
					onPress={() => update({ cardPresentation: "compact" })}
					className="h-7 min-w-0 px-2"
				>
					<Rows3 className="h-3.5 w-3.5" aria-hidden="true" />
					Compact
				</Button>
				<Button
					aria-pressed={display.cardPresentation === "detail"}
					variant={display.cardPresentation === "detail" ? "secondary" : "ghost"}
					onPress={() => update({ cardPresentation: "detail" })}
					className="h-7 min-w-0 px-2"
				>
					<AlignJustify className="h-3.5 w-3.5" aria-hidden="true" />
					Full
				</Button>
			</ButtonGroup>
		) : null,
		"collection.card-columns": display.mode === "cards" ? (
			<div className="flex shrink-0 items-center gap-1" role="group" aria-label={`${resourceName} cards per row`}>
				<Grid2X2 className="ml-1 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
				{([1, 2, 3, 4] as CardColumnCount[]).map((count) => (
					<Button
						key={count}
						isIconOnly
						size="sm"
						variant={effectiveCardColumns === count ? "secondary" : "ghost"}
						aria-label={`${count} ${count === 1 ? "card" : "cards"} per row`}
						aria-pressed={effectiveCardColumns === count}
						onPress={() => update({ cardColumns: count })}
						className="h-7 min-h-7 w-7 min-w-7 text-xs tabular-nums"
					>
						{count}
					</Button>
				))}
			</div>
		) : null,
		"collection.configure": onConfigure ? (
			<ProjectionMenuTrigger
				summary={viewSummary}
				onPress={onConfigure}
				ariaLabel={`Configure ${resourceName} view: ${viewSummary}`}
				className="h-7 min-h-7"
			/>
		) : null,
	};
}
