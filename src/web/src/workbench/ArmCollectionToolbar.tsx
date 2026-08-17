import type { ReactNode } from "react";
import { Button } from "@heroui/react";
import { RefreshCw } from "lucide-react";

import {
	ProjectionFilterMenu,
	ProjectionSearch,
	type ProjectionFilterOption,
} from "@/design-system/ProjectionControls";
import { WorkbenchToolbar } from "@/design-system/WorkbenchSurface";
import { cn } from "@/lib";

import type { ArmCollectionScope } from "./arm-collection-model";

export function ArmCollectionToolbar({
	searchText,
	onSearchTextChange,
	scope,
	onScopeChange,
	scopeOptions,
	visible,
	total,
	onRefresh,
	refreshing = false,
	secondaryControls,
	primaryAction,
	className,
}: {
	searchText: string;
	onSearchTextChange: (value: string) => void;
	scope: ArmCollectionScope;
	onScopeChange: (scope: ArmCollectionScope) => void;
	scopeOptions: readonly ProjectionFilterOption[];
	visible: number;
	total: number;
	onRefresh: () => void;
	refreshing?: boolean;
	secondaryControls?: ReactNode;
	primaryAction?: ReactNode;
	className?: string;
}) {
	return (
		<WorkbenchToolbar className={cn("min-h-12 shrink-0 flex-nowrap overflow-x-auto", className)}>
			<ProjectionSearch
				value={searchText}
				onChange={onSearchTextChange}
				placeholder="Search arms…"
				className="min-w-48 max-w-xl"
			/>
			<ProjectionFilterMenu
				label="View"
				value={scope}
				options={scopeOptions}
				onChange={(value) => onScopeChange(value as ArmCollectionScope)}
			/>
			<span className="inline-flex shrink-0 self-center items-center text-xs tabular-nums text-muted-foreground">
				{visible} of {total}
			</span>
			{secondaryControls ? (
				<>
					<div className="h-5 w-px shrink-0 bg-border" aria-hidden="true" />
					{secondaryControls}
				</>
			) : null}
			<div className="ml-auto flex shrink-0 items-center gap-1">
				<Button
					isIconOnly
					size="sm"
					variant="ghost"
					onPress={onRefresh}
					aria-label="Refresh arms"
				>
					<RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} aria-hidden="true" />
				</Button>
				{primaryAction}
			</div>
		</WorkbenchToolbar>
	);
}
