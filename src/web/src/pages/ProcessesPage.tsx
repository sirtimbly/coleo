/**
 * Arm process monitor.
 *
 * A run appears only after an Arm claims a task or bug. This view deliberately
 * has no "start run" button; users launch Arms and Brain assigns work through
 * the existing claim flow.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@heroui/react";
import { Activity, RefreshCw } from "lucide-react";

import { CollectionRow } from "@/design-system/CollectionRow";
import {
	WorkbenchEmptyState,
	WorkbenchHeader,
	WorkbenchToolbar,
} from "@/design-system/WorkbenchSurface";
import { api } from "@/lib";
import { usePageTitle } from "@/hooks/usePageTitle";
import { useProjectionSignal } from "@/workbench/live-projections";
import { useWorkspaceOpenRoute } from "@/workspace/route-context";

import type { ArmRun } from "@/workbench/types";

type ProcessFilter = "active" | "blocked" | "completed" | "all";

function duration(run: ArmRun): string {
	const milliseconds = new Date(run.endedAt ?? Date.now()).getTime() - new Date(run.startedAt).getTime();
	const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

export function ProcessesPage() {
	usePageTitle("Coleo Observatory - Processes");
	const openRoute = useWorkspaceOpenRoute();
	const [runs, setRuns] = useState<ArmRun[]>([]);
	const [filter, setFilter] = useState<ProcessFilter>("active");
	const [loading, setLoading] = useState(true);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			setRuns((await api.listRuns({ limit: 250 })).runs);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	useProjectionSignal((signal) => {
		if (["tasks", "bugs", "arms", "arm-events"].includes(signal.channel)) void load();
	});

	const visible = useMemo(() => runs.filter((run) => {
		if (filter === "all") return true;
		if (filter === "active") return !run.endedAt;
		if (filter === "blocked") return run.status === "blocked";
		return run.status === "completed";
	}), [filter, runs]);

	const openWork = (run: ArmRun) => {
		openRoute(
			{
				pathname: run.workKind === "task" ? "/tasks" : "/bugs",
				search: run.workKind === "task"
					? `?task=${encodeURIComponent(run.workId)}&view=details`
					: `?bug=${encodeURIComponent(run.workId)}`,
				title: run.workTitle,
			},
			"split",
		);
	};

	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			<WorkbenchHeader
				title="Processes"
				description="Runs begin when an Arm claims a task or bug"
				icon={<Activity className="h-4 w-4" />}
				actions={(
					<Button isIconOnly size="sm" variant="ghost" onPress={() => void load()} aria-label="Refresh processes">
						<RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
					</Button>
				)}
			/>
			<WorkbenchToolbar>
				{(["active", "blocked", "completed", "all"] as const).map((value) => (
					<button
						key={value}
						type="button"
						aria-pressed={filter === value}
						onClick={() => setFilter(value)}
						className={filter === value
							? "h-7 border border-accent/40 bg-accent/10 px-2.5 text-xs font-medium capitalize text-accent"
							: "h-7 border border-transparent px-2.5 text-xs font-medium capitalize text-muted-foreground hover:border-border"}
					>
						{value}
					</button>
				))}
				<span className="ml-auto text-xs text-muted-foreground">
					{runs.filter((run) => !run.endedAt).length} active · {runs.filter((run) => run.status === "blocked").length} blocked
				</span>
			</WorkbenchToolbar>
			<div className="min-h-0 flex-1 overflow-auto">
				{visible.length === 0 ? (
					<WorkbenchEmptyState
						title={loading ? "Loading processes" : "No matching runs"}
						description="Launch an Arm; a run will appear after it asks Brain for work and claims a task or bug."
					/>
				) : visible.map((run) => (
					<CollectionRow
						key={run.id}
						title={run.workTitle}
						description={`${run.armName} · ${run.workKind} · ${run.status}`}
						meta={`Started ${new Date(run.startedAt).toLocaleString()}`}
						onOpen={() => openWork(run)}
						leading={(
							<span className={
								run.status === "blocked"
									? "h-2 w-2 rounded-full bg-warning"
									: run.status === "failed"
										? "h-2 w-2 rounded-full bg-danger"
										: run.endedAt
											? "h-2 w-2 rounded-full bg-muted"
											: "h-2 w-2 animate-pulse rounded-full bg-success"
							} />
						)}
						trailing={<span className="tabular-nums">{duration(run)}</span>}
					/>
				))}
			</div>
		</div>
	);
}
