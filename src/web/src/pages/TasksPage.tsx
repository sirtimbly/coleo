/**
 * Task workbench projection and dedicated task detail views.
 *
 * The list surface is a shared Tabulator sheet; task details, discussions,
 * summaries, and diffs still open as separate Golden Layout panels.
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
} from "lucide-react";
import { Button, Chip, Card, Dropdown, Label, Separator } from "@heroui/react";
import { AdaptiveCardView } from "@/adaptive-cards/AdaptiveCardView";
import { createCardRoute } from "@/adaptive-cards/card-route";
import {
	presentResourceDetail,
	presentResourceEditor,
} from "@/adaptive-cards/presenters";
import {
	type Task,
	type TaskLlmMetadata,
	type TaskMetadata,
	type TaskUiMetadata,
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
import {
	WorkbenchHeader,
	WorkbenchSurface,
} from "@/design-system/WorkbenchSurface";

type SidebarTab = "details" | "summary" | "diff" | "discussions";

const TaskSheet = React.lazy(() =>
	import("@/workbench/TaskSheet").then((module) => ({ default: module.TaskSheet }))
);

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
	onOpenCardEditor,
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
	onOpenCardEditor: () => void;
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
								onOpenCardEditor();
								return;
							}
							if (key === "edit" || key === "blocked") {
								onEdit(key === "blocked" ? "blocked" : undefined);
								return;
							}
							if (typeof key === "string" && key.startsWith("status:")) {
								const status = key.slice("status:".length);
								if (isTaskStatus(status)) onStatusChange(status);
							}
						}}
					>
						<Dropdown.Item id="edit" textValue="Edit task">
							<Pencil className="h-4 w-4 text-muted-foreground" />
							<Label>Edit task</Label>
						</Dropdown.Item>
						<Dropdown.Item id="card-edit" textValue="Edit as card">
							<FileText className="h-4 w-4 text-muted-foreground" />
							<Label>Edit as card</Label>
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

function formatAbsoluteDateTime(iso: string): string {
	return new Date(iso).toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

function formatRelativeAge(iso: string): string {
	const diffMs = Date.now() - new Date(iso).getTime();
	const diffSeconds = Math.floor(diffMs / 1000);
	if (diffSeconds < 60) return "just now";
	const diffMinutes = Math.floor(diffSeconds / 60);
	if (diffMinutes < 60) return `${diffMinutes}m ago`;
	const diffHours = Math.floor(diffMinutes / 60);
	if (diffHours < 24) return `${diffHours}h ago`;
	const diffDays = Math.floor(diffHours / 24);
	if (diffDays < 30) return `${diffDays}d ago`;
	const diffMonths = Math.floor(diffDays / 30);
	if (diffMonths < 12) return `${diffMonths}mo ago`;
	const diffYears = Math.floor(diffMonths / 12);
	return `${diffYears}y ago`;
}

function TaskCreatedAt({ createdAt }: { createdAt: string }) {
	return (
		<span
			className="inline-flex items-center gap-1 text-xs text-foreground-500"
			title={formatAbsoluteDateTime(createdAt)}
		>
			<Clock className="h-3 w-3" />
			Created {formatRelativeAge(createdAt)}
		</span>
	);
}

function BlockedTaskNotice({ task }: { task: Task }) {
	if (task.status !== "blocked") return null;

	return (
		<div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
			<div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
				<Pause className="h-3.5 w-3.5" />
				Current blocker
			</div>
			<p className="readable-copy mt-1.5 whitespace-pre-wrap">
				{task.blockedReason || "No reason was recorded. The next review must add one."}
			</p>
			<div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
				<span>Category: {(task.blockedCategory || "unknown").replace("_", " ")}</span>
				{task.blockedRecheckAt ? (
					<span>Next review: {formatAbsoluteDateTime(task.blockedRecheckAt)}</span>
				) : null}
				{task.blockedReviewCount ? <span>Reviews: {task.blockedReviewCount}</span> : null}
				{task.blockedNeedsHuman ? <span className="font-medium text-amber-700 dark:text-amber-300">Waiting for human input</span> : null}
			</div>
		</div>
	);
}

/**
 * Description field that shows an explicit empty state (instead of silently
 * rendering nothing) and lets you add/edit the description inline.
 */
function TaskDescriptionField({
	taskId,
	description,
	onSave,
}: {
	taskId: string;
	description: string;
	onSave: (taskId: string, description: string) => void;
}) {
	const [isEditing, setIsEditing] = useState(false);
	const [draft, setDraft] = useState(description);

	useEffect(() => {
		if (!isEditing) setDraft(description);
	}, [description, isEditing]);

	const handleSave = () => {
		const trimmed = draft.trim();
		setIsEditing(false);
		if (trimmed !== description) {
			onSave(taskId, trimmed);
		}
	};

	const handleCancel = () => {
		setDraft(description);
		setIsEditing(false);
	};

	if (isEditing) {
		return (
			<div className="space-y-2">
				<textarea
					autoFocus
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.preventDefault();
							handleCancel();
						} else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
							event.preventDefault();
							handleSave();
						}
					}}
					placeholder="Add a description for this task..."
					rows={4}
					className="readable-copy w-full resize-none rounded-md border border-border/70 bg-content2 px-3 py-2 focus:outline-none focus:ring-1 focus:ring-accent"
				/>
				<div className="flex items-center gap-2">
					<Button size="sm" variant="primary" onPress={handleSave}>
						Save
					</Button>
					<Button size="sm" variant="ghost" onPress={handleCancel}>
						Cancel
					</Button>
					<span className="text-xs text-foreground-500">⌘⏎ to save · Esc to cancel</span>
				</div>
			</div>
		);
	}

	if (!description.trim()) {
		return (
			<button
				type="button"
				onClick={() => setIsEditing(true)}
				className="w-full rounded-md border border-dashed border-border/70 px-3 py-3 text-left text-sm text-foreground-500 transition-colors hover:border-accent hover:text-foreground"
			>
				No description yet — click to add one
			</button>
		);
	}

	return (
		<button
			type="button"
			onClick={() => setIsEditing(true)}
			className="w-full rounded-md px-3 py-2 -mx-3 text-left text-sm transition-colors hover:bg-content2"
			title="Click to edit"
		>
			<p className="readable-copy whitespace-pre-wrap">
				{description}
			</p>
		</button>
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
	const [sidebarTab, setSidebarTab] = useState<SidebarTab>("details");
	const [discussionCount, setDiscussionCount] = useState(0);
	const [activeInsight, setActiveInsight] = useState<SheetInsight>(null);
	const [draftsOnly, setDraftsOnly] = useState(false);
	const [draftFilterToggleRequest, setDraftFilterToggleRequest] = useState(0);
	const [deleteConfirm, setDeleteConfirm] = useState<{
		show: boolean;
		task: Task | null;
	}>({ show: false, task: null });
	const [burndownRefresh, setBurndownRefresh] = useState(0);
	const deferredSearchText = useDeferredValue(searchText);
	const taskRefreshTimerRef = useRef<number | null>(null);
	const pendingBurndownRefreshRef = useRef(false);
	const detailsTabId: SidebarTab = "details";
	const summaryTabId: SidebarTab = "summary";
	const diffTabId: SidebarTab = "diff";
	const discussionsTabId: SidebarTab = "discussions";
	const openNewTaskPanel = useCallback(() => {
		openWorkspaceRoute(
			{ pathname: "/tasks", search: "?new=1", title: "New Task" },
			"action",
		);
	}, [openWorkspaceRoute]);
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
	} = useTasks(undefined, !isNewTaskPage);
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

	const filteredTasks = useMemo(() => {
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
	const visibleTaskCount = useMemo(
		() => draftsOnly
			? filteredTasks.filter((task) => task.status === "draft").length
			: filteredTasks.length,
		[draftsOnly, filteredTasks],
	);
	const toggleDraftsOnly = useCallback(() => {
		setDraftFilterToggleRequest((current) => current + 1);
	}, []);
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
	const handleOpenTaskCardEditor = useCallback(() => {
		if (!selectedTask) return;
		openWorkspaceRoute(createCardRoute(presentResourceEditor({
			id: selectedTask.id,
			kind: "task",
			title: selectedTask.subject,
			description: selectedTask.description,
		})), "action");
	}, [openWorkspaceRoute, selectedTask]);

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
      },
      "split",
    );
  }, [openWorkspaceRoute, searchParams]);

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
				onClose={closeWorkspaceRoute}
				onSaved={() => {
					void refetch();
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
							secondaryControls={draftFilterControl}
							actionControls={<TaskWorkflowHelp />}
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
							<React.Suspense fallback={<div className="p-5 text-sm text-muted-foreground">Loading spreadsheet…</div>}>
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
									draftFilterToggleRequest={draftFilterToggleRequest}
									onDraftsOnlyChange={setDraftsOnly}
								/>
							</React.Suspense>
						</div>
					</div>
					{taskModal}
				</>
			);
		}

		return (
			<>
				<div className="flex h-full min-h-0 flex-col bg-background">
					<WorkbenchHeader
						title={selectedTask.subject}
						description={`Task ${selectedTask.id}`}
						icon={<ScrollText className="h-4 w-4" />}
						actions={
							<Button
								isIconOnly
								size="sm"
								variant="ghost"
								onPress={closeWorkspaceRoute}
								aria-label="Close task details"
							>
								<X className="h-4 w-4" />
							</Button>
						}
					/>
					<TaskDetailsToolbar
						activeTab={sidebarTab}
						onTabChange={setSidebarTab}
						discussionCount={discussionCount}
						priority={selectedTask.priority}
						taskId={selectedTask.id}
						onPriorityChange={handlePriorityChange}
						task={selectedTask}
						onEdit={handleEditSelectedTask}
						onOpenCardEditor={handleOpenTaskCardEditor}
						onStatusChange={handleStatusChange}
					/>

					{sidebarTab === detailsTabId ? (
						<div className="flex-1 overflow-auto p-3" role="tabpanel">
							<WorkbenchSurface className="mx-auto max-w-4xl p-4">
							<div className="space-y-3">
								<div className="flex items-center justify-between">
									<span className="text-xs text-muted-foreground font-mono">ID: {selectedTask.id}</span>
									<TaskCreatedAt createdAt={selectedTask.createdAt} />
								</div>
								<div>
									<h5 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-500">Description</h5>
									<p className="mb-1.5 text-sm font-medium text-foreground">{selectedTask.subject}</p>
									<TaskDescriptionField
										taskId={selectedTask.id}
										description={selectedTask.description}
										onSave={(taskId, description) => handleUpdateTask(taskId, { description })}
									/>
								</div>
								<div className="grid grid-cols-2 gap-3 text-sm">
									<div>
										<span className="text-foreground-500">Status</span>
										<div className="mt-1 flex items-center gap-1">
											{React.createElement(STATUS_CONFIG[selectedTask.status].icon, {
												className: "h-3 w-3",
											})}
											<span className={STATUS_CONFIG[selectedTask.status].color}>
												{STATUS_CONFIG[selectedTask.status].label}
											</span>
										</div>
									</div>
									<div>
										<span className="text-foreground-500">Assigned</span>
										<div className="mt-1 text-sm">
											{selectedTask.assignedArmName ?? "Unassigned"}
										</div>
									</div>
								</div>
								<BlockedTaskNotice task={selectedTask} />
								<AdaptiveCardView
									envelope={presentResourceDetail({
										id: selectedTask.id,
										kind: "task",
										title: selectedTask.subject,
										description: selectedTask.description,
										facts: [
											{ label: "Status", value: STATUS_CONFIG[selectedTask.status].label },
											{ label: "Priority", value: selectedTask.priority },
											{ label: "Assigned", value: selectedTask.assignedArmName ?? "Unassigned" },
										],
									})}
								/>
							</div>
							</WorkbenchSurface>
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
		<div className="flex h-full min-h-0 flex-col">
			<SheetWorkspaceToolbar
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
				secondaryControls={draftFilterControl}
				actionControls={<TaskWorkflowHelp />}
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
									draftFilterToggleRequest={draftFilterToggleRequest}
									onDraftsOnlyChange={setDraftsOnly}
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
							onOpenCardEditor={handleOpenTaskCardEditor}
							onStatusChange={handleStatusChange}
							onClose={() => setSelectedTask(null)}
						/>

						{sidebarTab === detailsTabId ? (
							<div className="flex-1 p-0" role="tabpanel">
								<div className="p-3 overflow-auto h-full">
									<div className="space-y-3">
										<div className="flex items-center justify-between">
											<span className="text-xs text-foreground-500 font-mono">
												ID: {selectedTask.id}
											</span>
											<TaskCreatedAt createdAt={selectedTask.createdAt} />
										</div>
										<BlockedTaskNotice task={selectedTask} />

										<AdaptiveCardView
											envelope={presentResourceDetail({
												id: selectedTask.id,
												kind: "task",
												title: selectedTask.subject,
												description: selectedTask.description,
												facts: [
													{ label: "Status", value: STATUS_CONFIG[selectedTask.status].label },
													{ label: "Priority", value: selectedTask.priority },
													{ label: "Assigned", value: selectedTask.assignedArmName ?? "Unassigned" },
												],
											})}
										/>

										<div>
											<h5 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-foreground-500">
												Description
											</h5>
											<p className="mb-1.5 text-sm font-medium text-foreground">
												{selectedTask.subject}
											</p>
											<TaskDescriptionField
												taskId={selectedTask.id}
												description={selectedTask.description}
												onSave={(taskId, description) => handleUpdateTask(taskId, { description })}
											/>
										</div>

										<div className="grid grid-cols-2 gap-3 text-sm">
											<div>
												<span className="text-foreground-500">Status:</span>
												<div className="flex items-center gap-1 mt-1">
													{React.createElement(
														STATUS_CONFIG[selectedTask.status].icon,
														{ className: "h-3 w-3" },
													)}
													<span
														className={STATUS_CONFIG[selectedTask.status].color}
													>
														{STATUS_CONFIG[selectedTask.status].label}
													</span>
												</div>
											</div>
											<div>
												<span className="text-foreground-500">Assigned</span>
												<div className="mt-1 text-sm">
													{selectedTask.assignedArmName ?? "Unassigned"}
												</div>
											</div>
										</div>

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

										{selectedTask.assignedArmName && (
											<div>
												<span className="text-sm text-foreground-500">
													Assigned to:
												</span>
												<p className="text-sm font-medium">
													{selectedTask.assignedArmName}
												</p>
											</div>
										)}

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
