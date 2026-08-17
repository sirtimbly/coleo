/**
 * Arm process monitor.
 *
 * A run appears only after an Arm claims a task or bug. This view deliberately
 * has no "start run" button; users launch Arms and Brain assigns work through
 * the existing claim flow.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@heroui/react";
import { Activity, ExternalLink, RefreshCw } from "lucide-react";

import { DeferredAdaptiveCardView } from "@/adaptive-cards/AdaptiveCardView";
import { createArmCardCreator } from "@/adaptive-cards/card-creators";
import { presentResourceDetail } from "@/adaptive-cards/presenters";
import { useCollectionViewToolbarWidgets } from "@/design-system/CollectionViewToolbar";
import { ToolbarTemplateRows } from "@/design-system/toolbar-template";
import { WorkbenchEmptyState } from "@/design-system/WorkbenchSurface";
import { api } from "@/lib";
import { usePageTitle } from "@/hooks/usePageTitle";
import { useProjectionSignal } from "@/workbench/live-projections";
import { AdaptiveCardCollection } from "@/workbench/AdaptiveCardCollection";
import { useCollectionDisplayPreferences } from "@/workbench/collection-display";
import { useToolbarTemplate } from "@/workbench/toolbar-template-context";
import { useWorkspaceOpenRoute } from "@/workspace/route-context";

import type { ArmRun } from "@/workbench/types";

type ProcessFilter = "active" | "blocked" | "completed" | "all";

const ProcessSheet = lazy(() =>
	import("@/workbench/ProcessSheet").then((module) => ({ default: module.ProcessSheet }))
);

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
	const toolbarTemplate = useToolbarTemplate("processes");
	const { display, updateDisplay } = useCollectionDisplayPreferences({
		viewId: "processes-display",
		name: "Processes",
		resourceKind: "run",
	});
	const collectionToolbarWidgets = useCollectionViewToolbarWidgets({
		resourceName: "processes",
		display,
		onChange: updateDisplay,
	});

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
			<ToolbarTemplateRows
				template={toolbarTemplate}
				widgets={{
					"processes.identity": (
						<div className="flex min-w-44 shrink-0 items-center gap-2">
							<span className="flex h-7 w-7 shrink-0 items-center justify-center border border-border bg-surface-secondary text-muted-foreground">
								<Activity className="h-3.5 w-3.5" aria-hidden="true" />
							</span>
							<div className="min-w-0">
								<h1 className="truncate text-sm font-semibold tracking-tight text-foreground">Processes</h1>
								<p className="truncate text-[0.68rem] text-muted-foreground">Arm task and bug runs</p>
							</div>
						</div>
					),
					"processes.status-filter": (["active", "blocked", "completed", "all"] as const).map((value) => (
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
					)),
					"processes.status-summary": (
						<span className="inline-flex shrink-0 self-center items-center text-xs text-muted-foreground">
							{runs.filter((run) => !run.endedAt).length} active · {runs.filter((run) => run.status === "blocked").length} blocked
						</span>
					),
					"processes.refresh": (
						<Button isIconOnly size="sm" variant="ghost" onPress={() => void load()} aria-label="Refresh processes">
							<RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
						</Button>
					),
					...collectionToolbarWidgets,
				}}
			/>
			<div className="min-h-0 flex-1 overflow-hidden">
				{visible.length === 0 ? (
					<WorkbenchEmptyState
						title={loading ? "Loading processes" : "No matching runs"}
						description="Launch an Arm; a run will appear after it asks Brain for work and claims a task or bug."
					/>
				) : display.mode === "grid" ? (
					<Suspense fallback={<WorkbenchEmptyState title="Preparing process grid" />}>
						<ProcessSheet runs={visible} density={display.density} onOpenDetails={openWork} />
					</Suspense>
				) : (
					<AdaptiveCardCollection
						items={visible}
						columns={display.cardColumns}
						presentation={display.cardPresentation}
						getKey={(run) => run.id}
						renderCard={(run, presentation) => (
							<DeferredAdaptiveCardView
								envelope={presentResourceDetail({
									id: run.id,
									kind: "process",
									title: run.workTitle,
									description: `${run.armName} is working on this ${run.workKind}.`,
									creator: createArmCardCreator(run.armId, run.armName),
									facts: [
										{ label: "Status", value: run.status.replaceAll("_", " ") },
										{ label: "Duration", value: duration(run) },
									],
									technicalFacts: [
										{ label: "Run ID", value: run.id },
										{ label: "Work ID", value: run.workId },
										{ label: "Started", value: new Date(run.startedAt).toLocaleString() },
										...(run.endedAt ? [{ label: "Ended", value: new Date(run.endedAt).toLocaleString() }] : []),
									],
									stateLabel: run.status.replaceAll("_", " "),
									stateColor: run.status === "failed" || run.status === "blocked"
										? "Attention"
										: run.status === "completed" ? "Good" : "Accent",
								})}
								presentationMode={presentation}
								footerActions={(
									<Button size="sm" variant="ghost" onPress={() => openWork(run)}>
										<ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
										View {run.workKind === "task" ? "Task" : "Bug"}
									</Button>
								)}
							/>
						)}
					/>
				)}
			</div>
		</div>
	);
}
