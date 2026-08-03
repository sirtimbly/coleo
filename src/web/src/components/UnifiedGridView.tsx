/**
 * Consolidated sheet workspace.
 *
 * This compatibility route composes the same persisted Tabulator
 * projections as the task and bug pages. It intentionally contains no grid
 * implementation of its own, so new resource sheets inherit one interaction
 * model and one profile-backed configuration system.
 */

import {
	lazy,
	Suspense,
	type ChangeEvent,
	useCallback,
	useDeferredValue,
	useMemo,
	useState,
} from "react";
import { Button, Chip, Tabs } from "@heroui/react";
import { Grid3x3, Lightbulb, ListTodo, ListTree, RefreshCw, Search } from "lucide-react";

import { useDiscoveries, useInfiniteDiscoveries } from "@/hooks/useDiscoveries";
import { useTasks } from "@/hooks/useTasks";
import { cn } from "@/lib";
import { useWorkspaceOpenRoute } from "@/workspace/route-context";

import type { Task } from "@/lib";
import type { ResourceSheetRowMove } from "@/workbench/ResourceSheet";
import type { TaskUpdate } from "@/workbench/resource-updates";

const TaskSheet = lazy(() =>
	import("@/workbench/TaskSheet").then((module) => ({ default: module.TaskSheet }))
);
const DiscoverySheet = lazy(() =>
	import("@/workbench/DiscoverySheet").then((module) => ({ default: module.DiscoverySheet }))
);

type TabType = "plan-items" | "tasks" | "discoveries";

function SheetLoading({ label }: { label: string }) {
	return (
		<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
			Loading {label}…
		</div>
	);
}

export function UnifiedGridView({ className }: { className?: string }) {
	const [activeTab, setActiveTab] = useState<TabType>("plan-items");
	const [searchText, setSearchText] = useState("");
	const deferredSearchText = useDeferredValue(searchText);
	const openWorkspaceRoute = useWorkspaceOpenRoute();

	const tasksResult = useTasks();
	const planItems = useTasks({ sourceType: "plan" });
	const discoveriesResult = useInfiniteDiscoveries({ status: "all" });
	const discoveriesMutation = useDiscoveries({ status: "all" });
	const updateTaskMutation = tasksResult.updateTask;
	const reorderTaskMutation = tasksResult.reorderTaskAsync;
	const updatePlanItemMutation = planItems.updateTask;
	const reorderPlanItemMutation = planItems.reorderTaskAsync;

	const filterTasks = useCallback((tasks: Task[]) => {
		if (!deferredSearchText.trim()) return tasks;
		const search = deferredSearchText.toLocaleLowerCase();
		return tasks.filter((task) =>
			task.subject.toLocaleLowerCase().includes(search)
			|| task.description.toLocaleLowerCase().includes(search)
			|| task.phase?.toLocaleLowerCase().includes(search)
		);
	}, [deferredSearchText]);
	const filteredTasks = useMemo(
		() => filterTasks(tasksResult.tasks),
		[filterTasks, tasksResult.tasks],
	);
	const filteredPlanItems = useMemo(
		() => filterTasks(planItems.tasks),
		[filterTasks, planItems.tasks],
	);
	const filteredDiscoveries = useMemo(() => {
		if (!deferredSearchText.trim()) return discoveriesResult.discoveries;
		const search = deferredSearchText.toLocaleLowerCase();
		return discoveriesResult.discoveries.filter((discovery) =>
			discovery.title.toLocaleLowerCase().includes(search)
			|| discovery.details.toLocaleLowerCase().includes(search)
		);
	}, [deferredSearchText, discoveriesResult.discoveries]);

	const openTask = useCallback((task: Task) => {
		openWorkspaceRoute(
			{ pathname: "/tasks", search: `?task=${encodeURIComponent(task.id)}`, title: task.subject },
			"split",
		);
	}, [openWorkspaceRoute]);

	const refresh = useCallback(() => {
		if (activeTab === "plan-items") void planItems.refetch();
		if (activeTab === "tasks") void tasksResult.refetch();
		if (activeTab === "discoveries") void discoveriesResult.refetch();
	}, [activeTab, discoveriesResult, planItems, tasksResult]);

	const updateTask = useCallback((taskId: string, updates: TaskUpdate) => {
		updateTaskMutation({ id: taskId, updates });
	}, [updateTaskMutation]);
	const updatePlanItem = useCallback((taskId: string, updates: TaskUpdate) => {
		updatePlanItemMutation({ id: taskId, updates });
	}, [updatePlanItemMutation]);
	const reorderTasks = useCallback(async (moves: ResourceSheetRowMove<Task>[]) => {
		for (const move of moves) {
			await reorderTaskMutation({
				taskId: move.row.id,
				fromSortOrder: move.row.sortOrder ?? move.fromIndex,
				toSortOrder: move.toIndex,
				prevTaskId: move.previousRow?.id ?? null,
				nextTaskId: move.nextRow?.id ?? null,
			});
		}
	}, [reorderTaskMutation]);
	const reorderPlanItems = useCallback(async (moves: ResourceSheetRowMove<Task>[]) => {
		for (const move of moves) {
			await reorderPlanItemMutation({
				taskId: move.row.id,
				fromSortOrder: move.row.sortOrder ?? move.fromIndex,
				toSortOrder: move.toIndex,
				prevTaskId: move.previousRow?.id ?? null,
				nextTaskId: move.nextRow?.id ?? null,
			});
		}
	}, [reorderPlanItemMutation]);

	return (
		<div className={cn("flex h-full min-h-0 flex-col bg-background", className)}>
			<header className="shrink-0 border-b border-border bg-surface px-4 py-3">
				<div className="flex items-center justify-between gap-3">
					<div className="flex items-center gap-2">
						<Grid3x3 className="h-5 w-5 text-accent" />
						<div>
							<h1 className="text-sm font-semibold">Resource sheets</h1>
							<p className="text-xs text-muted-foreground">
								One spreadsheet interaction model for structured work
							</p>
						</div>
					</div>
					<Button isIconOnly size="sm" variant="ghost" onPress={refresh} aria-label="Refresh">
						<RefreshCw className="h-4 w-4" />
					</Button>
				</div>
				<div className="relative mt-3 max-w-xl">
					<Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
					<input
						type="search"
						placeholder="Search the current resources"
						value={searchText}
						onChange={(event: ChangeEvent<HTMLInputElement>) => setSearchText(event.target.value)}
						className="h-9 w-full border border-border bg-surface-secondary pl-8 pr-3 text-sm outline-none focus:border-accent"
					/>
				</div>
			</header>

			<Tabs
				selectedKey={activeTab}
				onSelectionChange={(key) => setActiveTab(key as TabType)}
				className="flex min-h-0 flex-1 flex-col"
			>
				<Tabs.ListContainer className="shrink-0 border-b border-border bg-surface">
					<Tabs.List aria-label="Resource sheet tabs" className="w-full">
						<Tabs.Tab id="plan-items" className="flex-1">
							<ListTree className="h-4 w-4" />
							Plan items
							<Chip size="sm" variant="soft">{planItems.pagination?.total ?? planItems.tasks.length}</Chip>
							<Tabs.Indicator />
						</Tabs.Tab>
						<Tabs.Tab id="tasks" className="flex-1">
							<ListTodo className="h-4 w-4" />
							Tasks
							<Chip size="sm" variant="soft">{tasksResult.pagination?.total ?? tasksResult.tasks.length}</Chip>
							<Tabs.Indicator />
						</Tabs.Tab>
						<Tabs.Tab id="discoveries" className="flex-1">
							<Lightbulb className="h-4 w-4" />
							Discoveries
							<Chip size="sm" variant="soft">{discoveriesResult.discoveries.length}</Chip>
							<Tabs.Indicator />
						</Tabs.Tab>
					</Tabs.List>
				</Tabs.ListContainer>

				<Tabs.Panel id="plan-items" className="min-h-0 flex-1 p-0">
					<Suspense fallback={<SheetLoading label="plan items" />}>
						{planItems.isLoading ? <SheetLoading label="plan items" /> : (
							<TaskSheet
								tasks={filteredPlanItems}
								viewId="plan-items-sheet"
								onOpenDetails={openTask}
								onUpdateTask={updatePlanItem}
								onRowsMove={reorderPlanItems}
								onCreateTaskAt={(index, subject) => {
									void planItems.createTaskAsync({
										subject,
										description: subject,
										sourceType: "plan",
										sortOrder: index,
									}).then((created) => planItems.reorderTaskAsync({
										taskId: created.id,
										fromSortOrder: created.sortOrder ?? filteredPlanItems.length,
										toSortOrder: index,
										prevTaskId: filteredPlanItems[index - 1]?.id ?? null,
										nextTaskId: filteredPlanItems[index]?.id ?? null,
									})).catch(() => {
										// Mutation hooks surface the error through the shared toast.
									});
								}}
								onDelete={(task) => planItems.deleteTask(task.id)}
								hasNextPage={planItems.hasNextPage}
								onLoadMore={() => {
									void planItems.fetchNextPage();
								}}
							/>
						)}
					</Suspense>
				</Tabs.Panel>

				<Tabs.Panel id="tasks" className="min-h-0 flex-1 p-0">
					<Suspense fallback={<SheetLoading label="tasks" />}>
						{tasksResult.isLoading ? <SheetLoading label="tasks" /> : (
							<TaskSheet
								tasks={filteredTasks}
								onOpenDetails={openTask}
								onUpdateTask={updateTask}
								onRowsMove={reorderTasks}
								onCreateTaskAt={(index, subject) => {
									void tasksResult.createTaskAsync({
										subject,
										description: subject,
										status: "draft",
										sortOrder: index,
									}).then((created) => tasksResult.reorderTaskAsync({
										taskId: created.id,
										fromSortOrder: created.sortOrder ?? filteredTasks.length,
										toSortOrder: index,
										prevTaskId: filteredTasks[index - 1]?.id ?? null,
										nextTaskId: filteredTasks[index]?.id ?? null,
									})).catch(() => {
										// Mutation hooks surface the error through the shared toast.
									});
								}}
								onDelete={(task) => tasksResult.deleteTask(task.id)}
								hasNextPage={tasksResult.hasNextPage}
								onLoadMore={() => {
									void tasksResult.fetchNextPage();
								}}
							/>
						)}
					</Suspense>
				</Tabs.Panel>

				<Tabs.Panel id="discoveries" className="min-h-0 flex-1 p-0">
					<Suspense fallback={<SheetLoading label="discoveries" />}>
						{discoveriesResult.isLoading ? <SheetLoading label="discoveries" /> : (
							<DiscoverySheet
								discoveries={filteredDiscoveries}
								onUpdateStatus={(id, status) => discoveriesMutation.updateDiscovery({
									id,
									updates: { status },
								})}
								hasNextPage={discoveriesResult.hasNextPage}
								onLoadMore={() => {
									void discoveriesResult.fetchNextPage();
								}}
							/>
						)}
					</Suspense>
				</Tabs.Panel>
			</Tabs>
		</div>
	);
}
