/**
 * Shared toolbar and optional-insight framing for spreadsheet workspaces.
 *
 * Task, bug, and future resource sheets use this component so search, counts,
 * Burndown/Activity selectors, and primary actions stay visually and
 * behaviorally consistent.
 */

import type { ReactNode } from "react";
import { Activity, ChartNoAxesCombined, ListFilter, Plus, RefreshCw } from "lucide-react";
import { Button } from "@heroui/react";

import { useCollectionViewToolbarWidgets } from "./CollectionViewToolbar";
import { ProjectionSearch } from "./ProjectionControls";
import {
	ToolbarTemplateRows,
	type ToolbarWidgetRegistry,
} from "./toolbar-template";
import { useToolbarTemplate } from "@/workbench/toolbar-template-context";

import type { CollectionDisplayPreferences } from "@/workbench/collection-display";

export type SheetInsight = "burndown" | "activity" | null;

function insightPanelId(
	resourceKey: string,
	insight: Exclude<SheetInsight, null>,
): string {
	return `${resourceKey}-${insight}-panel`;
}

export function SheetWorkspaceToolbar({
	screenId,
	resourceKey,
	resourceName,
	searchText,
	onSearchTextChange,
	searchPlaceholder,
	total,
	visible,
	activeInsight,
	onInsightChange,
	onRefresh,
	onNew,
	display,
	onDisplayChange,
	onConfigure,
	filterCount,
	sortLabel,
	hiddenSearchMatches = 0,
	extensionWidgets,
}: {
	screenId: "tasks" | "bugs";
	resourceKey: string;
	resourceName: string;
	searchText: string;
	onSearchTextChange: (value: string) => void;
	searchPlaceholder: string;
	total: number;
	visible: number;
	activeInsight: SheetInsight;
	onInsightChange: (insight: SheetInsight) => void;
	onRefresh: () => void;
	onNew: () => void;
	display: CollectionDisplayPreferences;
	onDisplayChange: (updates: Partial<CollectionDisplayPreferences>) => void;
	onConfigure?: () => void;
	filterCount?: number;
	sortLabel?: string;
	hiddenSearchMatches?: number;
	extensionWidgets?: ToolbarWidgetRegistry;
}) {
	const template = useToolbarTemplate(screenId);
	const collectionWidgets = useCollectionViewToolbarWidgets({
		resourceName: resourceName.toLowerCase(),
		display,
		onChange: onDisplayChange,
		onConfigure,
		filterCount,
		sortLabel,
	});
	const widgets: ToolbarWidgetRegistry = {
		"sheet.search": (
			<ProjectionSearch
				value={searchText}
				onChange={onSearchTextChange}
				placeholder={searchPlaceholder}
				className="min-w-48 max-w-xl"
			/>
		),
		"sheet.result-count": (
			<div className="inline-flex shrink-0 self-center items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
				<span>{visible} of {total}</span>
				{hiddenSearchMatches > 0 ? (
					<Button
						size="sm"
						variant="ghost"
						onPress={onConfigure}
						isDisabled={!onConfigure}
						className="h-7 min-h-7 px-2 text-warning"
						aria-label={`${hiddenSearchMatches} search ${hiddenSearchMatches === 1 ? "match is" : "matches are"} hidden by view filters. Change view filters.`}
					>
						<ListFilter className="h-3.5 w-3.5" aria-hidden="true" />
						{hiddenSearchMatches} hidden by view filters
					</Button>
				) : null}
			</div>
		),
		"sheet.insights": (
			<div
				role="group"
				aria-label={`${resourceName} insights`}
				className="flex shrink-0 items-center p-0.5"
			>
				<Button
					size="sm"
					variant={activeInsight === "burndown" ? "secondary" : "ghost"}
					aria-pressed={activeInsight === "burndown"}
					aria-controls={insightPanelId(resourceKey, "burndown")}
					onPress={() =>
						onInsightChange(activeInsight === "burndown" ? null : "burndown")
					}
					className="h-7 min-w-0 touch-manipulation px-2"
				>
					<ChartNoAxesCombined className="h-3.5 w-3.5" aria-hidden="true" />
					Burndown
				</Button>
				<Button
					size="sm"
					variant={activeInsight === "activity" ? "secondary" : "ghost"}
					aria-pressed={activeInsight === "activity"}
					aria-controls={insightPanelId(resourceKey, "activity")}
					onPress={() =>
						onInsightChange(activeInsight === "activity" ? null : "activity")
					}
					className="h-7 min-w-0 touch-manipulation px-2"
				>
					<Activity className="h-3.5 w-3.5" aria-hidden="true" />
					Activity
				</Button>
			</div>
		),
		"sheet.refresh": (
			<Button
				isIconOnly
				size="sm"
				variant="ghost"
				onPress={onRefresh}
				aria-label={`Refresh ${resourceName}`}
			>
				<RefreshCw className="h-4 w-4" aria-hidden="true" />
			</Button>
		),
		"sheet.create": (
			<Button size="sm" variant="primary" onPress={onNew}>
				<Plus className="h-4 w-4" aria-hidden="true" />
				New
			</Button>
		),
		...collectionWidgets,
		...extensionWidgets,
	};

	return <ToolbarTemplateRows template={template} widgets={widgets} />;
}

export function SheetInsightPanel({
	resourceKey,
	resourceName,
	activeInsight,
	children,
}: {
	resourceKey: string;
	resourceName: string;
	activeInsight: Exclude<SheetInsight, null>;
	children: ReactNode;
}) {
	return (
		<div
			id={insightPanelId(resourceKey, activeInsight)}
			role="region"
			aria-label={`${resourceName} ${activeInsight === "burndown" ? "Burndown" : "Activity"}`}
			className="max-h-[min(48vh,30rem)] shrink-0 overflow-auto border-b border-border"
		>
			{children}
		</div>
	);
}
