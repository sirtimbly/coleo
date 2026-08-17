/**
 * Task workbench projection and dedicated task detail views.
 *
 * The list surface switches between a shared Tabulator sheet and Adaptive Card
 * collection; richer task views still open as separate workspace panels.
 */
import React, { useMemo, useState, useCallback, useDeferredValue, useEffect, useRef } from "react";
import {
	Clock,
	CheckCircle2,
	XCircle,
	AlertTriangle,
	Pause,
	ChevronUp,
	ChevronDown,
	Sparkles,
	X,
	FileText,
	MessageSquare,
	ScrollText,
	GitCommitHorizontal,
	MoreHorizontal,
	Pencil,
	RotateCcw,
	Ban,
	ExternalLink,
} from "lucide-react";
import { Button, Chip, Card, Dropdown, Label, Separator } from "@heroui/react";
import { AdaptiveCardView, DeferredAdaptiveCardView } from "@/adaptive-cards/AdaptiveCardView";
import {
	BRAIN_CARD_CREATOR,
	USER_CARD_CREATOR,
} from "@/adaptive-cards/card-creators";
import { presentTaskCard } from "@/adaptive-cards/task-presenter";
import {
	type Task,
	type TaskLlmMetadata,
	type TaskMetadata,
	type TaskUiMetadata,
	api,
	cn,
	isJsonObject,
} from "@/lib";
import { StatusBurndownChart, TaskModal, TaskDiscussionPanel, TaskSummaryPanel, TaskDiffPanel, TaskWorkflowHelp } from "@/components";
import { useWebSocket, type WebSocketMessage } from "@/hooks/useWebSocket";
import type { TaskUpdate } from "@/workbench/resource-updates";
import type { ResourceSheetRowMove } from "@/workbench/ResourceSheet";
import { useTasks, type TaskListQueryData } from "@/hooks/useTasks";
import { usePageTitle } from '@/hooks/usePageTitle';
import { useQueryClient } from "@tanstack/react-query";
import { tasksKeys } from "@/lib/queryKeys";
import { patchTaskInQueryData } from "@/lib/task-query-cache";
import { formatTimelineTime, selectTaskTimeline } from "./task-timeline";
import {
	useIsWorkspacePanel,
	useWorkspaceCloseRoute,
	useWorkspaceOpenRoute,
	useWorkspaceSearchParams,
} from '@/workspace/route-context';
import {
	SheetInsightPanel,
	SheetWorkspaceToolbar,
	type SheetInsight,
} from "@/design-system/SheetWorkspaceToolbar";
import { normalizeRowColor, RowFormattingToolbar } from "@/design-system/RowFormattingToolbar";
import { AdaptiveCardCollection } from "@/workbench/AdaptiveCardCollection";
import { useCollectionDisplayPreferences } from "@/workbench/collection-display";
import { projectResourceCollection } from "@/workbench/resource-sheet-model";
import { useViewPreferences } from "@/workbench/use-view-preferences";
import { ViewConfigurator, type ConfigurableColumn } from "@/workbench/ViewConfigurator";
import type { CardActionRequest } from "../../../types/adaptive-cards";

type SidebarTab = "details" | "summary" | "diff" | "discussions";

const TASK_VIEW_COLUMNS: ConfigurableColumn[] = [
	{ id: "subject", header: "Subject", defaultWidth: 360, hideable: false },
	{ id: "status", header: "Status", defaultWidth: 128 },
	{ id: "priority", header: "Priority", defaultWidth: 104 },
	{ id: "phase", header: "Phase", defaultWidth: 130 },
	{ id: "domain", header: "Domain", defaultWidth: 120 },
	{ id: "assignedArm", header: "Arm", defaultWidth: 140 },
	{ id: "progress", header: "Progress", defaultWidth: 92 },
	{ id: "sourceType", header: "Source", defaultWidth: 104 },
	{ id: "tags", header: "Tags", defaultWidth: 180 },
	{ id: "updatedAt", header: "Updated", defaultWidth: 170 },
];

const TASK_COLLECTION_COLUMNS = [
	{ id: "subject", read: (task: Task) => task.subject },
	{ id: "status", read: (task: Task) => task.status },
	{ id: "priority", read: (task: Task) => task.priority },
	{ id: "phase", read: (task: Task) => task.phase ?? "" },
	{ id: "domain", read: (task: Task) => task.domain ?? "" },
	{ id: "assignedArm", read: (task: Task) => task.assignedArmName ?? task.assignedTo ?? "" },
	{ id: "progress", read: (task: Task) => task.progress ?? 0 },
	{ id: "sourceType", read: (task: Task) => task.sourceType },
	{ id: "tags", read: (task: Task) => task.metadata.ui?.tags ?? [] },
	{ id: "updatedAt", read: (task: Task) => task.updatedAt },
];

const TaskSheet = React.lazy(() =>
	import("@/workbench/TaskSheet").then((module) => ({ default: module.TaskSheet }))
);

function taskCardCreator(task: Task) {
	return task.sourceType === "manual" ? USER_CARD_CREATOR : BRAIN_CARD_CREATOR;
}

// Status configuration
const STATUS_CONFIG: Record<
	Task["status"],
	{
		color: string;
		bgColor: string;
		icon: React.ComponentType<{ className?: string }>;
		label: string;
	}
> = {
	draft: {
		color: "text-cyan-500",
		bgColor: "bg-cyan-500/10",
		icon: Pencil,
		label: "Draft",
	},
	in_progress: {
		color: "text-yellow-500",
		bgColor: "bg-yellow-500/10",
		icon: Clock,
		label: "In Progress",
	},
	completing: {
		color: "text-violet-500",
		bgColor: "bg-violet-500/10",
		icon: Clock,
		label: "Completing",
	},
	claimed: {
		color: "text-blue-500",
		bgColor: "bg-blue-500/10",
		icon: Clock,
		label: "Claimed",
	},
	pending: {
		color: "text-gray-500",
		bgColor: "bg-gray-500/10",
		icon: Clock,
		label: "Pending",
	},
	blocked: {
		color: "text-orange-500",
		bgColor: "bg-orange-500/10",
		icon: Pause,
		label: "Blocked",
	},
	completed: {
		color: "text-green-500",
		bgColor: "bg-green-500/10",
		icon: CheckCircle2,
		label: "Completed",
	},
	failed: {
		color: "text-red-500",
		bgColor: "bg-red-500/10",
		icon: XCircle,
		label: "Failed",
	},
	cancelled: {
		color: "text-gray-400",
		bgColor: "bg-gray-400/10",
		icon: XCircle,
		label: "Cancelled",
	},
};

const isTaskStatus = (value: string): value is Task["status"] =>
	value in STATUS_CONFIG;

// Priority configuration
const PRIORITY_CONFIG: Record<
	Task["priority"],
	{ color: string; bgColor: string; label: string }
> = {
	critical: {
		color: "text-red-500",
		bgColor: "bg-red-500/20",
		label: "Critical",
	},
	high: {
		color: "text-orange-500",
		bgColor: "bg-orange-500/20",
		label: "High",
	},
	normal: {
		color: "text-blue-500",
		bgColor: "bg-blue-500/20",
		label: "Normal",
	},
	low: { color: "text-gray-500", bgColor: "bg-gray-500/20", label: "Low" },
};

function TaskActivity({ tasks, onOpenTask }: { tasks: Task[]; onOpenTask: (task: Task) => void }) {
	const { current, upcoming, completed } = useMemo(() => selectTaskTimeline(tasks), [tasks]);

	return (
		<div className="grid gap-3 bg-surface-secondary/40 p-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(16rem,1.3fr)]">
			<ActivityTaskCard label="Current" task={current} timestamp={current?.startedAt ?? current?.claimedAt ?? current?.updatedAt} empty="No task is currently active." tone="accent" onOpenTask={onOpenTask} />
			<ActivityTaskCard label="Up next" task={upcoming} timestamp={upcoming?.dueDate ?? upcoming?.createdAt} empty="No runnable task is queued." tone="default" onOpenTask={onOpenTask} />
			<div className="rounded-lg border border-border bg-background/70 p-3"><div className="mb-2 flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-success" /><span className="text-sm font-medium">Recently completed</span></div>{completed.length ? <div className="space-y-1">{completed.map((task) => <button key={task.id} type="button" onClick={() => onOpenTask(task)} className="flex w-full items-center gap-2 rounded px-1 py-1.5 text-left hover:bg-success/10"><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" /><span className="min-w-0 flex-1 truncate text-sm">{task.subject}</span><time className="shrink-0 text-xs text-muted-foreground">{formatTimelineTime(task.completedAt)}</time></button>)}</div> : <p className="text-sm text-muted-foreground">No completed tasks in the loaded timeline.</p>}</div>
		</div>
	);
}

function TaskInsightPanel({
	activeInsight,
	tasks,
	burndownRefresh,
	onOpenTask,
}: {
	activeInsight: SheetInsight;
	tasks: Task[];
	burndownRefresh: number;
	onOpenTask: (task: Task) => void;
}) {
	if (activeInsight === null) return null;

	return (
		<SheetInsightPanel
			resourceKey="task"
			resourceName="Task"
			activeInsight={activeInsight}
		>
			{activeInsight === "burndown" ? (
				<StatusBurndownChart
					entity="task"
					refreshKey={burndownRefresh}
					embedded
					className="rounded-none border-0"
				/>
			) : (
				<TaskActivity tasks={tasks} onOpenTask={onOpenTask} />
			)}
		</SheetInsightPanel>
	);
}

function ActivityTaskCard({ label, task, timestamp, empty, tone, onOpenTask }: { label: string; task: Task | undefined; timestamp: string | null | undefined; empty: string; tone: "accent" | "default"; onOpenTask: (task: Task) => void }) {
	return <div className="rounded-lg border border-border bg-background/70 p-3"><div className="mb-2 flex items-center gap-2"><Clock className={`h-4 w-4 ${tone === "accent" ? "text-accent" : "text-muted-foreground"}`} /><span className="text-sm font-medium">{label}</span></div>{task ? <button type="button" onClick={() => onOpenTask(task)} className="block w-full rounded text-left hover:bg-accent/5"><p className="truncate text-sm font-medium">{task.subject}</p><div className="mt-1 flex items-center justify-between gap-2"><Chip size="sm" variant="secondary">{STATUS_CONFIG[task.status].label}</Chip><time className="truncate text-xs text-muted-foreground">{formatTimelineTime(timestamp)}</time></div></button> : <p className="text-sm text-muted-foreground">{empty}</p>}</div>;
}

function TaskPriorityBadge({
	priority,
	taskId,
	onPriorityChange,
}: {
	priority: Task["priority"];
	taskId: string;
	onPriorityChange: (taskId: string, newPriority: Task["priority"]) => void;
}) {
	const config = PRIORITY_CONFIG[priority];

	const priorityOrder: Task["priority"][] = [
		"low",
		"normal",
		"high",
		"critical",
	];
	const currentIndex = priorityOrder.indexOf(priority);
	const canIncrease = currentIndex < priorityOrder.length - 1;
	const canDecrease = currentIndex > 0;

	const handleIncrease = () => {
		if (canIncrease) {
			onPriorityChange(taskId, priorityOrder[currentIndex + 1]);
		}
	};

	const handleDecrease = () => {
		if (canDecrease) {
			onPriorityChange(taskId, priorityOrder[currentIndex - 1]);
		}
	};

	return (
		<div className="inline-flex items-center gap-0.5 group">
			{canIncrease && (
				<Button
					isIconOnly
					size="sm"
					variant="ghost"
					onPress={handleIncrease}
					className="opacity-0 group-hover:opacity-100 min-w-unit-6 w-unit-6 h-unit-6"
					aria-label="Increase priority"
				>
					<ChevronUp className="h-3 w-3" />
				</Button>
			)}
			<Chip size="sm" variant="soft" className={cn(config.color)}>
				{config.label}
			</Chip>
			{canDecrease && (
				<Button
					isIconOnly
					size="sm"
					variant="ghost"
					onPress={handleDecrease}
					className="opacity-0 group-hover:opacity-100 min-w-unit-6 w-unit-6 h-unit-6"
					aria-label="Decrease priority"
				>
					<ChevronDown className="h-3 w-3" />
				</Button>
			)}
		</div>
	);
}

const TASK_DETAILS_TABS: ReadonlyArray<{
	id: SidebarTab;
	label: string;
	icon: React.ComponentType<{ className?: string }>;
}> = [
	{ id: "details", label: "Details", icon: FileText },
	{ id: "summary", label: "Summary", icon: ScrollText },
	{ id: "diff", label: "Diff", icon: GitCommitHorizontal },
	{ id: "discussions", label: "Discussions", icon: MessageSquare },
];

function TaskDetailsToolbar({
	activeTab,
	onTabChange,
	discussionCount,
	priority,
	taskId,
	onPriorityChange,
	task,
	onEdit,
	cardEditing,
	onCardEditToggle,
	onStatusChange,
	onClose,
}: {
	activeTab: SidebarTab;
	onTabChange: (tab: SidebarTab) => void;
	discussionCount: number;
	priority: Task["priority"];
	taskId: string;
	onPriorityChange: (taskId: string, priority: Task["priority"]) => void;
	task: Task;
	onEdit: (status?: Task["status"]) => void;
	cardEditing: boolean;
	onCardEditToggle: () => void;
	onStatusChange: (status: Task["status"]) => void;
	onClose?: () => void;
}) {
	return (
		<header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-3">
			<div className="min-w-0 flex-1 overflow-x-auto">
				<div className="flex items-stretch" role="tablist" aria-label="Task details">
					{TASK_DETAILS_TABS.map((tab) => {
						const Icon = tab.icon;
						return (
							<button
								key={tab.id}
								type="button"
								role="tab"
								aria-selected={activeTab === tab.id}
								onClick={() => onTabChange(tab.id)}
								className={cn(
									"inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
									activeTab === tab.id
										? "border-accent font-medium text-foreground"
										: "border-transparent text-muted-foreground hover:bg-surface-secondary hover:text-foreground",
								)}
							>
								<Icon className="h-3.5 w-3.5" />
								<span>{tab.label}</span>
								{tab.id === "discussions" && discussionCount > 0 ? (
									<Chip color="accent" size="sm" variant="soft">
										{discussionCount}
									</Chip>
								) : null}
							</button>
						);
					})}
				</div>
			</div>
			<div className="h-5 w-px shrink-0 bg-border" aria-hidden="true" />
			<TaskPriorityBadge
				priority={priority}
				taskId={taskId}
				onPriorityChange={onPriorityChange}
			/>
			<TaskWorkflowHelp />
			<Dropdown>
				<Button isIconOnly size="sm" variant="ghost" aria-label="Edit task or change status">
					<MoreHorizontal className="h-4 w-4" />
				</Button>
				<Dropdown.Popover placement="bottom end" className="min-w-[220px]">
					<Dropdown.Menu
					onAction={(key) => {
						if (key === "card-edit") {
							onCardEditToggle();
							return;
						}
						if (key === "blocked") onEdit("blocked");
						if (typeof key === "string" && key.startsWith("status:")) {
								const status = key.slice("status:".length);
								if (isTaskStatus(status)) onStatusChange(status);
							}
						}}
					>
					<Dropdown.Item
						id="card-edit"
						textValue={cardEditing ? "Cancel task card editing" : "Edit task card"}
					>
						<FileText className="h-4 w-4 text-muted-foreground" />
						<Label>{cardEditing ? "Cancel card editing" : "Edit task card"}</Label>
					</Dropdown.Item>
						<Separator />
						<Dropdown.Item id="status:draft" textValue="Move to draft">
							<Pencil className="h-4 w-4 text-cyan-500" />
							<Label>Move to draft</Label>
						</Dropdown.Item>
						<Dropdown.Item id="status:pending" textValue="Move to pending">
							<RotateCcw className="h-4 w-4 text-muted-foreground" />
							<Label>{task.status === "blocked" ? "Unblock to pending" : "Move to pending"}</Label>
						</Dropdown.Item>
						<Dropdown.Item id="blocked" textValue="Mark blocked">
							<Pause className="h-4 w-4 text-amber-500" />
							<Label>Mark blocked...</Label>
						</Dropdown.Item>
						<Dropdown.Item id="status:completed" textValue="Mark completed">
							<CheckCircle2 className="h-4 w-4 text-success" />
							<Label>Mark completed</Label>
						</Dropdown.Item>
						<Dropdown.Item id="status:failed" textValue="Mark failed">
							<AlertTriangle className="h-4 w-4 text-danger" />
							<Label>Mark failed</Label>
						</Dropdown.Item>
						<Dropdown.Item id="status:cancelled" textValue="Cancel task" variant="danger">
							<Ban className="h-4 w-4 text-danger" />
							<Label>Cancel task</Label>
						</Dropdown.Item>
					</Dropdown.Menu>
				</Dropdown.Popover>
			</Dropdown>
			{onClose ? (
				<Button
					isIconOnly
					size="sm"
					variant="ghost"
					onPress={onClose}
					aria-label="Close task details"
				>
					<X className="h-4 w-4" />
				</Button>
			) : null}
		</header>
	);
}

export function TasksPage() {
	const queryClient = useQueryClient();
	const isWorkspacePanel = useIsWorkspacePanel();
	const openWorkspaceRoute = useWorkspaceOpenRoute();
	const closeWorkspaceRoute = useWorkspaceCloseRoute('/tasks');
	const [searchParams] = useWorkspaceSearchParams();
	const isNewTaskPage = searchParams.get("new") === "1";
	usePageTitle(isNewTaskPage ? 'Coleo Observatory - New Task' : 'Coleo Observatory - Tasks');

	const [searchText, setSearchText] = useState("");
	const [isModalOpen, setIsModalOpen] = useState(false);
	const [editingTask, setEditingTask] = useState<Task | undefined>(undefined);
	const [editingStatus, setEditingStatus] = useState<Task["status"] | undefined>(undefined);
	const [selectedTask, setSelectedTask] = useState<Task | null>(null);
	const [cardEditTaskId, setCardEditTaskId] = useState<string | null>(null);
	const [sidebarTab, setSidebarTab] = useState<SidebarTab>("details");
	const [discussionCount, setDiscussionCount] = useState(0);
	const [activeInsight, setActiveInsight] = useState<SheetInsight>(null);
	const [deleteConfirm, setDeleteConfirm] = useState<{
		show: boolean;
		task: Task | null;
	}>({ show: false, task: null });
	const [burndownRefresh, setBurndownRefresh] = useState(0);
	const [configuringView, setConfiguringView] = useState(false);
	const [formattingTask, setFormattingTask] = useState<Task>();
	const { display, updateDisplay } = useCollectionDisplayPreferences({
		viewId: "tasks-display",
		name: "Tasks",
		resourceKind: "task",
	});
	const taskView = useViewPreferences("tasks-sheet", {
		id: "tasks-sheet",
		name: "Tasks",
		kind: "sheet",
		resourceKind: "task",
		description: "Task collection filters, sorting, and grid columns",
		query: { resourceKinds: ["task"] },
		preferences: { density: "compact", sort: [] },
		shared: false,
	});
	const taskViewPreferences = useMemo(
		() => taskView.preferences.density === display.density
			? taskView.preferences
			: { ...taskView.preferences, density: display.density },
		[display.density, taskView.preferences],
	);
	const draftsOnly = (taskViewPreferences.filters ?? []).some((filter) =>
		filter.field === "status" && filter.operator === "equals" && filter.value === "draft"
	);
	const deferredSearchText = useDeferredValue(searchText);
	const taskRefreshTimerRef = useRef<number | null>(null);
	const pendingBurndownRefreshRef = useRef(false);
	const detailsTabId: SidebarTab = "details";
	const summaryTabId: SidebarTab = "summary";
	const diffTabId: SidebarTab = "diff";
	const discussionsTabId: SidebarTab = "discussions";
	const taskModal = (
		<TaskModal
			isOpen={isModalOpen}
			onClose={() => {
				setIsModalOpen(false);
				setEditingTask(undefined);
				setEditingStatus(undefined);
			}}
			onSaved={(savedTask) => {
				setSelectedTask(savedTask);
				refetch();
			}}
			task={editingTask}
			initialStatus={editingStatus}
		/>
	);
	// Use React Query hook for tasks
	const {
		tasks,
		pagination,
		counts,
		isLoading,
		isError,
		error,
		refetch,
		updateTask,
		createTaskAsync,
		reorderTaskAsync,
		deleteTask,
		removeFromPlan,
		hasNextPage,
		fetchNextPage,
	} = useTasks(draftsOnly ? { status: "draft" } : undefined, !isNewTaskPage);
	const tasksRef = useRef(tasks);
	tasksRef.current = tasks;

	const getTaskUiMeta = useCallback((task: Task): TaskUiMetadata => {
		const ui = task.metadata.ui;
		return {
			tags: ui?.tags ?? [],
			color: ui?.color ?? "slate",
			bold: ui?.bold ?? false,
			llm: ui?.llm,
		};
	}, []);

	const searchedTasks = useMemo(() => {
		let result = tasks;

		if (deferredSearchText.trim()) {
			const search = deferredSearchText.toLowerCase();
			result = result.filter(
				(task) =>
					task.subject.toLowerCase().includes(search) ||
					task.description.toLowerCase().includes(search) ||
					task.phase?.toLowerCase().includes(search),
			);
		}

		return result;
	}, [deferredSearchText, tasks]);
	const filteredTasks = useMemo(
		() => projectResourceCollection(searchedTasks, TASK_COLLECTION_COLUMNS, taskViewPreferences),
		[searchedTasks, taskViewPreferences],
	);
	const visibleTaskCount = filteredTasks.length;
	const toggleDraftsOnly = useCallback(() => {
		const filters = taskView.preferences.filters ?? [];
		taskView.updatePreferences({
			...taskView.preferences,
			filters: draftsOnly
				? filters.filter((filter) => !(filter.field === "status" && filter.operator === "equals" && filter.value === "draft"))
				: [...filters.filter((filter) => filter.field !== "status"), { field: "status", operator: "equals", value: "draft" }],
		});
	}, [draftsOnly, taskView]);
	const openNewTaskPanel = useCallback(() => {
		openWorkspaceRoute(
			{
				pathname: "/tasks",
				search: draftsOnly ? "?new=1&draft=1" : "?new=1",
				title: "New Task",
			},
			"action",
		);
	}, [draftsOnly, openWorkspaceRoute]);
	const draftFilterControl = (
		<Button
			size="sm"
			variant={draftsOnly ? "secondary" : "ghost"}
			aria-pressed={draftsOnly}
			onPress={toggleDraftsOnly}
			className="h-8 shrink-0"
		>
			<Pencil className="h-3.5 w-3.5" aria-hidden="true" />
			Drafts Only
		</Button>
	);
	useEffect(() => {
		const taskId = searchParams.get("task");
		const view = searchParams.get("view");
		setSidebarTab(view === "discussions" ? "discussions" : "details");

		if (!taskId) {
			setSelectedTask(null);
			return;
		}

		setSelectedTask(tasks.find((task) => task.id === taskId) || null);
	}, [searchParams, tasks]);

	const handleUpdateTask = useCallback(
		async (taskId: string, updates: TaskUpdate) => {
			// Optimistic update is handled by the mutation
			updateTask({ id: taskId, updates });
		},
		[updateTask],
	);

	const handleEditSelectedTask = useCallback((status?: Task["status"]) => {
		if (!selectedTask) return;
		setEditingTask(selectedTask);
		setEditingStatus(status);
		setIsModalOpen(true);
	}, [selectedTask]);
	const handleToggleTaskCardEditor = useCallback(() => {
		if (!selectedTask) return;
		setCardEditTaskId((current) => current === selectedTask.id ? null : selectedTask.id);
	}, [selectedTask]);
	const handleTaskCardAction = useCallback(async (request: CardActionRequest) => {
		await api.executeWorkbenchCardAction(request);
		setCardEditTaskId(null);
		await queryClient.invalidateQueries({
			queryKey: tasksKeys.all(),
			refetchType: "active",
		});
	}, [queryClient]);

	const handleStatusChange = useCallback(
		(status: Task["status"]) => {
			if (!selectedTask || status === selectedTask.status) return;
			if (status === "blocked") {
				setEditingTask(selectedTask);
				setEditingStatus("blocked");
				setIsModalOpen(true);
				return;
			}
			if (status === "cancelled" && !window.confirm("Cancel this task? It will be removed from the runnable queue.")) {
				return;
			}
			updateTask({ id: selectedTask.id, updates: { status } });
		},
		[selectedTask, updateTask],
	);

	const handleUpdateUi = useCallback(
		async (taskId: string, updates: TaskUiMetadata) => {
			const target = tasksRef.current.find((task) => task.id === taskId);
			if (!target) return;
			const currentUi = getTaskUiMeta(target);
			const nextUi: TaskUiMetadata = {
				...currentUi,
				...updates,
				tags: updates.tags ?? currentUi.tags,
				llm: updates.llm ? { ...currentUi.llm, ...updates.llm } : currentUi.llm,
			};
			const nextMetadata: TaskMetadata = {
				...target.metadata,
				ui: nextUi,
			};

			updateTask({ id: taskId, updates: { metadata: nextMetadata } });
		},
		[getTaskUiMeta, updateTask],
	);

	const handleDeleteTask = useCallback(
		(task: Task) => {
			if (task.planLineUid) {
				setDeleteConfirm({ show: true, task });
			} else {
				if (confirm("Are you sure you want to delete this task?")) {
					deleteTask(task.id);
				}
			}
		},
		[deleteTask],
	);

	const confirmDeleteFromPlan = useCallback(async () => {
		if (!deleteConfirm.task) return;
		try {
			await removeFromPlan(deleteConfirm.task.id);
		} catch {
			// Error is handled by the mutation
		} finally {
			setDeleteConfirm({ show: false, task: null });
		}
	}, [deleteConfirm, removeFromPlan]);

	const confirmDeleteOnly = useCallback(async () => {
		if (!deleteConfirm.task) return;
		try {
			await deleteTask(deleteConfirm.task.id);
		} catch {
			// Error is handled by the mutation
		} finally {
			setDeleteConfirm({ show: false, task: null });
		}
	}, [deleteConfirm, deleteTask]);

	const handleCreateTaskAt = useCallback(
		async (index: number, subject: string) => {
			const now = new Date().toISOString();
			const llmMeta: TaskLlmMetadata = {
				originalPrompt: subject,
				history: [{ role: "user", content: subject, at: now }],
			};
			try {
				const created = await createTaskAsync({
					subject,
					description: subject,
					status: "draft",
					priority: "normal",
					metadata: {
						ui: { tags: [], bold: false, color: "slate", llm: llmMeta },
					},
					sortOrder: index,
				});
				await reorderTaskAsync({
					taskId: created.id,
					fromSortOrder: created.sortOrder ?? tasksRef.current.length,
					toSortOrder: index,
					prevTaskId: tasksRef.current[index - 1]?.id ?? null,
					nextTaskId: tasksRef.current[index]?.id ?? null,
				});
			} catch {
				// Error is handled by the mutation
			}
		},
		[createTaskAsync, reorderTaskAsync],
	);

	const handleRowsMove = useCallback(
		async (moves: ResourceSheetRowMove<Task>[]) => {
			for (const move of moves) {
				await reorderTaskAsync({
					taskId: move.row.id,
					fromSortOrder: move.row.sortOrder ?? move.fromIndex,
					toSortOrder: move.toIndex,
					prevTaskId: move.previousRow?.id ?? null,
					nextTaskId: move.nextRow?.id ?? null,
				});
			}
		},
		[reorderTaskAsync],
	);

  const handleOpenDetails = useCallback((task: Task) => {
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.set("task", task.id);
    nextSearchParams.set("view", "details");
    openWorkspaceRoute(
      {
        pathname: "/tasks",
        search: `?${nextSearchParams.toString()}`,
        title: task.subject,
      },
      "split",
    );
  }, [openWorkspaceRoute, searchParams]);
	const taskCardCollection = (
		<AdaptiveCardCollection
			items={filteredTasks}
			columns={display.cardColumns}
			presentation={display.cardPresentation}
			getKey={(task) => task.id}
			renderCard={(task, presentation) => (
				<DeferredAdaptiveCardView
					envelope={presentTaskCard(
						task,
						cardEditTaskId === task.id,
						taskCardCreator(task),
					)}
					onAction={handleTaskCardAction}
					presentationMode={presentation}
					headerActions={(
						<Button
							isIconOnly
							size="sm"
							variant={cardEditTaskId === task.id ? "secondary" : "ghost"}
							aria-label={cardEditTaskId === task.id ? `Cancel editing ${task.subject}` : `Edit ${task.subject}`}
							aria-pressed={cardEditTaskId === task.id}
							onPress={() => setCardEditTaskId((current) => current === task.id ? null : task.id)}
							className="h-7 min-h-7 w-7 min-w-7"
						>
							<Pencil className="h-3.5 w-3.5" aria-hidden="true" />
						</Button>
					)}
					footerActions={cardEditTaskId === task.id ? undefined : (
						<>
							<Button size="sm" variant="ghost" onPress={() => handleOpenDetails(task)}>
								<ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
								View Task
							</Button>
							{task.sourceType === "plan" || task.planLineUid ? (
								<Button
									size="sm"
									variant="ghost"
									onPress={() => openWorkspaceRoute(
										{ pathname: "/setup", search: "", title: "Plan & Documents" },
										"split",
									)}
								>
									<FileText className="h-3.5 w-3.5" aria-hidden="true" />
									View Plan
								</Button>
							) : null}
						</>
					)}
				/>
			)}
		/>
	);
	const selectedTaskCardEditAction = selectedTask ? (
		<Button
			isIconOnly
			size="sm"
			variant={cardEditTaskId === selectedTask.id ? "secondary" : "ghost"}
			aria-label={cardEditTaskId === selectedTask.id ? "Cancel task card editing" : "Edit task card"}
			aria-pressed={cardEditTaskId === selectedTask.id}
			onPress={handleToggleTaskCardEditor}
			className="h-7 min-h-7 w-7 min-w-7"
		>
			<Pencil className="h-3.5 w-3.5" aria-hidden="true" />
		</Button>
	) : undefined;
	const taskSort = taskViewPreferences.sort?.[0];
	const taskSortLabel = taskSort
		? `${TASK_VIEW_COLUMNS.find((column) => column.id === taskSort.field)?.header ?? taskSort.field} ${taskSort.direction === "desc" ? "↓" : "↑"}`
		: undefined;
	const taskGridControls = formattingTask ? (
		<RowFormattingToolbar
			label={formattingTask.subject}
			value={{
				bold: formattingTask.metadata.ui?.bold ?? false,
				color: normalizeRowColor(formattingTask.metadata.ui?.color),
			}}
			onChange={(updates) => handleUpdateTask(formattingTask.id, {
				metadata: {
					...formattingTask.metadata,
					ui: { ...formattingTask.metadata.ui, ...updates },
				},
			})}
		/>
	) : undefined;
	const taskViewConfigurator = (
		<ViewConfigurator
			open={configuringView}
			columns={TASK_VIEW_COLUMNS}
			preferences={taskViewPreferences}
			shared={taskView.view.shared}
			onChange={taskView.updatePreferences}
			onSharedChange={(shared) => void taskView.updateShared(shared)}
			onClose={() => setConfiguringView(false)}
		/>
	);

	const handleRemoveTagFromTask = useCallback(
		(taskId: string, tagToRemove: string) => {
			const target = tasksRef.current.find((task) => task.id === taskId);
			if (!target) return;
			const currentTags = getTaskUiMeta(target).tags ?? [];
			const nextTags = currentTags.filter((tag) => tag !== tagToRemove);
			handleUpdateUi(taskId, { tags: nextTags });
		},
		[getTaskUiMeta, handleUpdateUi],
	);

	// Update selected task when tasks change
	React.useEffect(() => {
		setSelectedTask((current) => {
			if (!current) return current;
			const latest = tasks.find((task) => task.id === current.id) || null;
			return latest === current ? current : latest;
		});
	}, [tasks]);

	// Reset discussion count when selected task changes
	React.useEffect(() => {
		if (selectedTask?.id === undefined) {
			setDiscussionCount(0);
			return;
		}
		setDiscussionCount(0);
	}, [selectedTask?.id]);

	const scheduleTaskRefresh = useCallback((refreshBurndown: boolean) => {
		pendingBurndownRefreshRef.current ||= refreshBurndown;
		if (taskRefreshTimerRef.current !== null) return;

		taskRefreshTimerRef.current = window.setTimeout(() => {
			taskRefreshTimerRef.current = null;
			void queryClient.invalidateQueries(
				{ queryKey: tasksKeys.all(), refetchType: "active" },
				{ cancelRefetch: false },
			);
			if (pendingBurndownRefreshRef.current) {
				pendingBurndownRefreshRef.current = false;
				setBurndownRefresh((current) => current + 1);
			}
		}, 250);
	}, [queryClient]);

	useEffect(() => () => {
		if (taskRefreshTimerRef.current !== null) window.clearTimeout(taskRefreshTimerRef.current);
	}, []);

	// Handle WebSocket messages for real-time updates
	const handleWSMessage = useCallback(
		(msg: WebSocketMessage) => {
			if (msg.channel !== "tasks" || !msg.event) return;

			// WebSocket data can be used for more granular updates if needed
			// const data = msg.data as TaskEventData;

			switch (msg.event) {
				case "task.created":
				case "task.deleted":
				case "tasks.regenerated":
					scheduleTaskRefresh(true);
					break;
				case "task.updated": {
					if (!isJsonObject(msg.data) || typeof msg.data.taskId !== "string" || !isJsonObject(msg.data.changes)) {
						break;
					}
					const status = typeof msg.data.changes.status === "string" && isTaskStatus(msg.data.changes.status)
						? msg.data.changes.status
						: undefined;
					const previousStatus = typeof msg.data.previousStatus === "string" && isTaskStatus(msg.data.previousStatus)
						? msg.data.previousStatus
						: undefined;
					const taskId = msg.data.taskId;
					const changes = {
						...msg.data.changes,
						...(status ? { status } : {}),
					} as Partial<Task>;
					queryClient.setQueriesData<TaskListQueryData>(
						{ queryKey: tasksKeys.lists() },
						(current) => patchTaskInQueryData(current, taskId, changes, previousStatus),
					);
					if (status) setBurndownRefresh((current) => current + 1);
					break;
				}
			}
		},
		[queryClient, scheduleTaskRefresh],
	);

	// Subscribe to tasks channel
	useWebSocket({
		channels: ["tasks"],
		onMessage: handleWSMessage,
		autoConnect: !isNewTaskPage && (!isWorkspacePanel || !searchParams.has("task")),
	});

	if (isNewTaskPage) {
		return (
			<TaskModal
				isOpen
				presentation="panel"
				initialStatus={searchParams.get("draft") === "1" || (searchParams.get("draft") === null && draftsOnly)
					? "draft"
					: "pending"}
				onClose={closeWorkspaceRoute}
				onSaved={() => {
					void queryClient.invalidateQueries({
						queryKey: tasksKeys.all(),
						refetchType: "active",
					});
				}}
			/>
		);
	}

	const handlePriorityChange = async (
		taskId: string,
		newPriority: Task["priority"],
	) => {
		updateTask({ id: taskId, updates: { priority: newPriority } });
	};

	if (isWorkspacePanel || searchParams.has("task")) {
		if (!selectedTask) {
			return (
				<>
					<div className="flex h-full min-h-0 flex-col bg-background">
						<SheetWorkspaceToolbar
							screenId="tasks"
							resourceKey="task"
							resourceName="Tasks"
							searchText={searchText}
							onSearchTextChange={setSearchText}
							searchPlaceholder="Search tasks…"
							total={counts?.total ?? pagination?.total ?? filteredTasks.length}
							visible={visibleTaskCount}
							activeInsight={activeInsight}
							onInsightChange={setActiveInsight}
							onRefresh={() => {
								void refetch();
							}}
							onNew={openNewTaskPanel}
							display={display}
							onDisplayChange={updateDisplay}
							onConfigure={() => setConfiguringView(true)}
							filterCount={taskViewPreferences.filters?.length ?? 0}
							sortLabel={taskSortLabel}
							extensionWidgets={{
								"tasks.drafts-only": draftFilterControl,
								"tasks.workflow-help": <TaskWorkflowHelp />,
								"tasks.row-formatting": display.mode === "grid" ? taskGridControls : null,
							}}
						/>
						{isError && error ? (
							<div className="flex shrink-0 items-center gap-2 border-b border-danger/20 bg-danger/10 px-4 py-2 text-sm text-danger">
								<AlertTriangle className="h-4 w-4" aria-hidden="true" />
								<span>{error.message}</span>
							</div>
						) : null}
						<TaskInsightPanel
							activeInsight={activeInsight}
							tasks={tasks}
							burndownRefresh={burndownRefresh}
							onOpenTask={handleOpenDetails}
						/>
						<div className="min-h-0 flex-1 overflow-hidden">
							{display.mode === "cards" ? taskCardCollection : <React.Suspense fallback={<div className="p-5 text-sm text-muted-foreground">Loading spreadsheet…</div>}>
								<TaskSheet
									tasks={filteredTasks}
									selectedTaskId={undefined}
									onOpenDetails={handleOpenDetails}
									onUpdateTask={handleUpdateTask}
									onDelete={handleDeleteTask}
									onCreateTaskAt={handleCreateTaskAt}
									onRowsMove={handleRowsMove}
									hasNextPage={hasNextPage}
										onLoadMore={fetchNextPage}
										density={display.density}
										viewPreferences={taskViewPreferences}
										onViewPreferencesChange={taskView.updatePreferences}
										onSelectedTaskChange={setFormattingTask}
									/>
							</React.Suspense>}
						</div>
					</div>
					{taskViewConfigurator}
					{taskModal}
				</>
			);
		}

		return (
			<>
				<div className="flex h-full min-h-0 flex-col bg-background">
					<TaskDetailsToolbar
						activeTab={sidebarTab}
						onTabChange={setSidebarTab}
						discussionCount={discussionCount}
						priority={selectedTask.priority}
						taskId={selectedTask.id}
						onPriorityChange={handlePriorityChange}
						task={selectedTask}
						onEdit={handleEditSelectedTask}
						cardEditing={cardEditTaskId === selectedTask.id}
						onCardEditToggle={handleToggleTaskCardEditor}
						onStatusChange={handleStatusChange}
						onClose={isWorkspacePanel ? undefined : closeWorkspaceRoute}
					/>

					{sidebarTab === detailsTabId ? (
						<div className="flex-1 overflow-auto p-3" role="tabpanel">
							<div className="mx-auto max-w-4xl">
								<AdaptiveCardView
									envelope={presentTaskCard(
										selectedTask,
										cardEditTaskId === selectedTask.id,
										taskCardCreator(selectedTask),
									)}
									onAction={handleTaskCardAction}
									headerActions={selectedTaskCardEditAction}
								/>
							</div>
						</div>
					) : null}

					{sidebarTab === summaryTabId ? (
						<div className="flex-1 p-0" role="tabpanel">
							<TaskSummaryPanel taskId={selectedTask.id} className="h-full" />
						</div>
					) : null}

					{sidebarTab === diffTabId ? (
						<div className="flex-1 p-0" role="tabpanel">
							<TaskDiffPanel taskId={selectedTask.id} className="h-full" />
						</div>
					) : null}

					{sidebarTab === discussionsTabId ? (
						<div className="flex-1 p-0" role="tabpanel">
							<TaskDiscussionPanel
								taskId={selectedTask.id}
								onCommentCountChange={setDiscussionCount}
								className="h-full"
							/>
						</div>
					) : null}
				</div>
				{taskModal}
			</>
		);
	}

	return (
		<div className="relative flex h-full min-h-0 flex-col">
			<SheetWorkspaceToolbar
				screenId="tasks"
				resourceKey="task"
				resourceName="Tasks"
				searchText={searchText}
				onSearchTextChange={setSearchText}
				searchPlaceholder="Search tasks…"
				total={counts?.total ?? pagination?.total ?? filteredTasks.length}
				visible={visibleTaskCount}
				activeInsight={activeInsight}
				onInsightChange={setActiveInsight}
				onRefresh={() => {
					void refetch();
				}}
				onNew={openNewTaskPanel}
				display={display}
				onDisplayChange={updateDisplay}
				onConfigure={() => setConfiguringView(true)}
				filterCount={taskViewPreferences.filters?.length ?? 0}
				sortLabel={taskSortLabel}
				extensionWidgets={{
					"tasks.drafts-only": draftFilterControl,
					"tasks.workflow-help": <TaskWorkflowHelp />,
					"tasks.row-formatting": display.mode === "grid" ? taskGridControls : null,
				}}
			/>

			{isError && error ? (
				<div className="p-4 bg-danger/10 text-danger border-b border-danger/20">
					<div className="flex items-center gap-2">
						<AlertTriangle className="h-4 w-4" aria-hidden="true" />
						<span className="text-sm">{error.message}</span>
					</div>
				</div>
			) : null}

			<TaskInsightPanel
				activeInsight={activeInsight}
				tasks={tasks}
				burndownRefresh={burndownRefresh}
				onOpenTask={handleOpenDetails}
			/>

			<div className="flex min-h-0 flex-1">
				{/* Task list */}
				<div className="min-w-0 flex-1 overflow-hidden">
					{isLoading ? (
						<div className="p-4 space-y-4">
							{[1, 2, 3].map((i) => (
								<Card key={i} className="h-24">
									<Card.Content className="animate-pulse bg-default-100" />
								</Card>
							))}
						</div>
					) : display.mode === "cards" ? (
						taskCardCollection
					) : (
						<div className="h-full">
							<React.Suspense fallback={<div className="p-5 text-sm text-muted-foreground">Loading spreadsheet…</div>}>
								<TaskSheet
									tasks={filteredTasks}
									selectedTaskId={selectedTask?.id}
									onOpenDetails={handleOpenDetails}
									onUpdateTask={handleUpdateTask}
									onDelete={handleDeleteTask}
									onCreateTaskAt={handleCreateTaskAt}
									onRowsMove={handleRowsMove}
									hasNextPage={hasNextPage}
									onLoadMore={fetchNextPage}
									density={display.density}
									viewPreferences={taskViewPreferences}
									onViewPreferencesChange={taskView.updatePreferences}
									onSelectedTaskChange={setFormattingTask}
								/>
							</React.Suspense>
						</div>
					)}
				</div>

				{/* Task details sidebar */}
				{selectedTask && (
					<Card className="w-128 overflow-hidden border-l rounded-none shadow-none flex flex-col">
						<TaskDetailsToolbar
							activeTab={sidebarTab}
							onTabChange={setSidebarTab}
							discussionCount={discussionCount}
							priority={selectedTask.priority}
							taskId={selectedTask.id}
							onPriorityChange={handlePriorityChange}
							task={selectedTask}
							onEdit={handleEditSelectedTask}
							cardEditing={cardEditTaskId === selectedTask.id}
							onCardEditToggle={handleToggleTaskCardEditor}
							onStatusChange={handleStatusChange}
							onClose={() => setSelectedTask(null)}
						/>

						{sidebarTab === detailsTabId ? (
							<div className="flex-1 p-0" role="tabpanel">
								<div className="p-3 overflow-auto h-full">
									<div className="space-y-3">
										<AdaptiveCardView
											envelope={presentTaskCard(
												selectedTask,
												cardEditTaskId === selectedTask.id,
												taskCardCreator(selectedTask),
											)}
											onAction={handleTaskCardAction}
											headerActions={selectedTaskCardEditAction}
										/>

										<div>
											<h5 className="text-sm font-medium text-foreground-500 mb-1">
												Tags
											</h5>
											<div className="flex flex-wrap gap-1">
												{(getTaskUiMeta(selectedTask).tags ?? []).length ===
												0 ? (
													<span className="text-xs text-foreground-500">
														No tags
													</span>
												) : (
													(getTaskUiMeta(selectedTask).tags ?? []).map(
														(tag) => (
															<Chip
																key={tag}
																size="sm"
																variant="soft"
																className="pr-1 gap-1 group hover:bg-default-200 transition-colors cursor-default"
															>
																{tag}
																<Button
																	variant="ghost"
																	size="sm"
																	isIconOnly
																	onPress={() =>
																		handleRemoveTagFromTask(
																			selectedTask.id,
																			tag,
																		)
																	}
																	aria-label={`Remove tag ${tag}`}
																	className="ml-0.5 p-0.5 h-auto rounded-full hover:bg-danger-100 hover:text-danger transition-colors cursor-pointer opacity-60 group-hover:opacity-100"
																>
																	<X className="h-3 w-3" />
																</Button>
															</Chip>
														),
													)
												)}
											</div>
										</div>

										{getTaskUiMeta(selectedTask).llm?.originalPrompt && (
											<div>
												<h5 className="text-sm font-medium text-foreground-500 mb-1">
													Original one-liner
												</h5>
												<p className="readable-copy">
													{getTaskUiMeta(selectedTask).llm?.originalPrompt}
												</p>
											</div>
										)}

										{getTaskUiMeta(selectedTask).llm?.generatedDescription && (
											<div>
												<h5 className="text-sm font-medium text-foreground-500 mb-1 flex items-center gap-1">
													<Sparkles className="h-3.5 w-3.5" />
													LLM-generated description
												</h5>
												<p className="readable-copy whitespace-pre-wrap">
													{
														getTaskUiMeta(selectedTask).llm
															?.generatedDescription
													}
												</p>
											</div>
										)}
									</div>
								</div>
								</div>
						) : null}

						{sidebarTab === summaryTabId ? (
							<div className="flex-1 p-0" role="tabpanel">
								<TaskSummaryPanel taskId={selectedTask.id} className="h-full" />
							</div>
						) : null}

						{sidebarTab === diffTabId ? (
							<div className="flex-1 p-0" role="tabpanel">
								<TaskDiffPanel taskId={selectedTask.id} className="h-full" />
							</div>
						) : null}

						{sidebarTab === discussionsTabId ? (
							<div className="flex-1 p-0" role="tabpanel">
								<TaskDiscussionPanel
									taskId={selectedTask.id}
									onCommentCountChange={setDiscussionCount}
									className="h-full"
								/>
							</div>
						) : null}
					</Card>
				)}
			</div>

			{taskViewConfigurator}

				{taskModal}

				{/* Delete Confirmation Dialog */}
				{deleteConfirm.show &&
					deleteConfirm.task &&
					(() => {
						const task = deleteConfirm.task;
						const taskId = task.id;
						const lineNumber = task.sourceRef?.split(":").pop();
						return (
							<div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
								<div className="bg-white dark:bg-zinc-800 rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
									<h3 className="text-lg font-semibold mb-2">Delete Task</h3>
									<p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
										This task is linked to plan.md
										{lineNumber ? ` at line ${lineNumber}` : ""}.
									</p>
									<div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-md p-3 mb-4">
										<p className="text-sm text-amber-800 dark:text-amber-200">
											<strong>Warning:</strong> Removing the task from plan.md
											will also delete its corresponding plan entry. This action
											cannot be undone.
										</p>
									</div>
									<div className="space-y-3 mb-4">
										<div className="flex items-center gap-2 text-sm">
											<input
												type="radio"
												name={`deleteOption-${taskId}`}
												id={`deleteOnly-${taskId}`}
												defaultChecked
											/>
											<label htmlFor={`deleteOnly-${taskId}`}>
												<span className="font-medium">Delete task only</span>
												<span className="text-gray-500 ml-1">
													- removes it from the task list and keeps plan.md
												</span>
											</label>
										</div>
										<div className="flex items-center gap-2 text-sm">
											<input
												type="radio"
												name={`deleteOption-${taskId}`}
												id={`removeFromPlan-${taskId}`}
											/>
											<label htmlFor={`removeFromPlan-${taskId}`}>
												<span className="font-medium">
													Remove from plan.md and delete
												</span>
												<span className="text-gray-500 ml-1">
													- removes the plan entry and deletes the task
												</span>
											</label>
										</div>
									</div>
									<div className="flex gap-3 justify-end">
										<Button
											variant="ghost"
											onPress={() =>
												setDeleteConfirm({ show: false, task: null })
											}
										>
											Cancel
										</Button>
										<Button
											variant="danger"
											onPress={() => {
												const radio = document.querySelector<HTMLInputElement>(
													`input[name="deleteOption-${taskId}"]:checked`,
												);
												if (radio?.id?.includes("removeFromPlan")) {
													confirmDeleteFromPlan();
												} else {
													confirmDeleteOnly();
												}
											}}
										>
											Delete
										</Button>
									</div>
								</div>
							</div>
						);
					})()}
			</div>
		);
}
