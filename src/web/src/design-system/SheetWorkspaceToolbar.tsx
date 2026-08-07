/**
 * Shared toolbar and optional-insight framing for spreadsheet workspaces.
 *
 * Task, bug, and future resource sheets use this component so search, counts,
 * Burndown/Activity selectors, and primary actions stay visually and
 * behaviorally consistent.
 */

import type { ReactNode } from "react";
import { Activity, ChartNoAxesCombined, Plus, RefreshCw } from "lucide-react";
import { Button } from "@heroui/react";

import { ProjectionSearch } from "./ProjectionControls";
import { WorkbenchToolbar } from "./WorkbenchSurface";

export type SheetInsight = "burndown" | "activity" | null;

function insightPanelId(resourceKey: string, insight: Exclude<SheetInsight, null>): string {
	return `${resourceKey}-${insight}-panel`;
}

export function SheetWorkspaceToolbar({
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
	secondaryControls,
	actionControls,
}: {
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
	secondaryControls?: ReactNode;
	actionControls?: ReactNode;
}) {
	return (
		<WorkbenchToolbar className="min-h-12 shrink-0 flex-nowrap overflow-x-auto">
			<ProjectionSearch
				value={searchText}
				onChange={onSearchTextChange}
				placeholder={searchPlaceholder}
				className="min-w-48 max-w-xl"
			/>
			<span className="shrink-0 text-xs tabular-nums text-muted-foreground">
				{visible} of {total}
			</span>
			<div className="h-5 w-px shrink-0 bg-border" aria-hidden="true" />
			<div
				role="group"
				aria-label={`${resourceName} insights`}
				className="flex shrink-0 items-center border border-border bg-surface p-0.5"
			>
				<Button
					size="sm"
					variant={activeInsight === "burndown" ? "secondary" : "ghost"}
					aria-pressed={activeInsight === "burndown"}
					aria-controls={insightPanelId(resourceKey, "burndown")}
					onPress={() => onInsightChange(
						activeInsight === "burndown" ? null : "burndown",
					)}
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
					onPress={() => onInsightChange(
						activeInsight === "activity" ? null : "activity",
					)}
					className="h-7 min-w-0 touch-manipulation px-2"
				>
					<Activity className="h-3.5 w-3.5" aria-hidden="true" />
					Activity
				</Button>
			</div>
			{secondaryControls}
			<div className="ml-auto flex shrink-0 items-center gap-1">
				{actionControls}
				<Button
					isIconOnly
					size="sm"
					variant="ghost"
					onPress={onRefresh}
					aria-label={`Refresh ${resourceName}`}
				>
					<RefreshCw className="h-4 w-4" aria-hidden="true" />
				</Button>
				<Button size="sm" variant="primary" onPress={onNew}>
					<Plus className="h-4 w-4" aria-hidden="true" />
					New
				</Button>
			</div>
		</WorkbenchToolbar>
	);
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
