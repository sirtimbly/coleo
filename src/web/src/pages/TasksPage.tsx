import React, { useMemo, useState, useCallback, useEffect, useRef } from "react";
import {
	Plus,
	Clock,
	CheckCircle2,
	XCircle,
	AlertTriangle,
	Pause,
	RefreshCw,
	ChevronUp,
	ChevronDown,
	Sparkles,
	Tag,
	X,
	Search,
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
import {
	type Task,
	type TaskLlmMetadata,
	type TaskMetadata,
	type TaskUiMetadata,
	cn,
} from "@/lib";
import { RegenerateTasksModal, TaskModal, TaskDiscussionPanel, TaskSummaryPanel, TaskDiffPanel, TaskWorkflowHelp } from "@/components";
import { useWebSocket, type WebSocketMessage } from "@/hooks/useWebSocket";
import { TaskGrid } from "@/components/TaskGrid";
import type { TaskUpdate } from "@/components/TaskGridRow";
import { useTasks } from "@/hooks/useTasks";
import { usePageTitle } from '@/hooks/usePageTitle';
import { useQueryClient } from "@tanstack/react-query";
import { tasksKeys } from "@/lib/queryKeys";
import { formatTimelineTime, selectTaskTimeline } from "./task-timeline";
import {
	useIsWorkspacePanel,
	useWorkspaceOpenRoute,
	useWorkspaceSearchParams,
} from '@/workspace/route-context';

type SidebarTab = "details" | "summary" | "diff" | "discussions";

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

const TASK_STATUS_FILTERS: readonly Task["status"][] = [
	"pending",
	"in_progress",
	"completing",
	"blocked",
	"completed",
	"claimed",
	"failed",
	"cancelled",
];

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

function TaskTimeline({ tasks, onOpenTask }: { tasks: Task[]; onOpenTask: (task: Task) => void }) {
	const { current, upcoming, completed } = useMemo(() => selectTaskTimeline(tasks), [tasks]);

	return (
		<section aria-label="Task timeline" className="border-b border-border bg-surface-secondary/40 px-4 py-3">
			<div className="mb-3 flex items-center justify-between gap-3">
				<div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">Live timeline</p><p className="mt-0.5 text-sm text-muted-foreground">What is active now, what the Brain can take next, and recent completed work.</p></div>
				<span className="shrink-0 text-xs text-muted-foreground">Updates live</span>
			</div>
			<div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(16rem,1.3fr)]">
				<TimelineTaskCard label="Current" task={current} timestamp={current?.startedAt ?? current?.claimedAt ?? current?.updatedAt} empty="No task is currently active." tone="accent" onOpenTask={onOpenTask} />
				<TimelineTaskCard label="Up next" task={upcoming} timestamp={upcoming?.dueDate ?? upcoming?.createdAt} empty="No runnable task is queued." tone="default" onOpenTask={onOpenTask} />
				<div className="rounded-lg border border-border bg-background/70 p-3"><div className="mb-2 flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-success" /><span className="text-sm font-medium">Recently completed</span></div>{completed.length ? <div className="space-y-1">{completed.map((task) => <button key={task.id} type="button" onClick={() => onOpenTask(task)} className="flex w-full items-center gap-2 rounded px-1 py-1.5 text-left hover:bg-success/10"><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" /><span className="min-w-0 flex-1 truncate text-sm">{task.subject}</span><time className="shrink-0 text-xs text-muted-foreground">{formatTimelineTime(task.completedAt)}</time></button>)}</div> : <p className="text-sm text-muted-foreground">No completed tasks in the loaded timeline.</p>}</div>
			</div>
		</section>
	);
}

function TimelineTaskCard({ label, task, timestamp, empty, tone, onOpenTask }: { label: string; task: Task | undefined; timestamp: string | null | undefined; empty: string; tone: "accent" | "default"; onOpenTask: (task: Task) => void }) {
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
						<Separator />
						<Dropdown.Item id="status:pending" textValue="Move to pending">
							<RotateCcw className="h-4 w-4 text-muted-foreground" />
							<Label>{task.status === "blocked" ? "Unblock to pending" : "Move to pending"}</Label>
						</Dropdown.Item>
						<Dropdown.Item id="blocked" textValue="Mark blocked">
							<Pause className="h-4 w-4 text-amber-500" />
							<Label>Mark blocked...</Label>
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
	usePageTitle('Coleo Observatory - Tasks');
	const queryClient = useQueryClient();
	const isWorkspacePanel = useIsWorkspacePanel();
	const openWorkspaceRoute = useWorkspaceOpenRoute();
	const [searchParams, setSearchParams] = useWorkspaceSearchParams();
	
	// Initialize filter from localStorage and URL (during component initialization, not in useEffect)
	const [filter, setFilter] = useState<{ status?: string; priority?: string }>(() => {
		const saved = localStorage.getItem("task-filter");
		const initialFilter = saved ? JSON.parse(saved) : {};
		
		// Check URL params and merge with localStorage
		const statusFromUrl = searchParams.get("status");
		if (statusFromUrl) {
			initialFilter.status = statusFromUrl;
		}
		
		return initialFilter;
	});
	
	const [tagFilter, setTagFilter] = useState<string[]>([]);
	
	// Track previous filter value to avoid unnecessary updates
	const prevFilterRef = useRef(filter);

	// Save filter to localStorage and URL when it changes (but not on initial mount)
	useEffect(() => {
		// Only save if filter has actually changed from previous value
		if (JSON.stringify(prevFilterRef.current) === JSON.stringify(filter)) {
			return;
		}
		
		prevFilterRef.current = filter;
		localStorage.setItem("task-filter", JSON.stringify(filter));

		if (filter.status) {
			setSearchParams((current) => {
				const next = new URLSearchParams(current);
				next.set("status", filter.status!);
				return next;
			});
		} else {
			setSearchParams((current) => {
				const next = new URLSearchParams(current);
				next.delete("status");
				return next;
			});
		}
	}, [filter, setSearchParams]);
	const [searchText, setSearchText] = useState("");
	const [isModalOpen, setIsModalOpen] = useState(false);
	const [isRegenerateModalOpen, setIsRegenerateModalOpen] = useState(false);
	const [editingTask, setEditingTask] = useState<Task | undefined>(undefined);
	const [editingStatus, setEditingStatus] = useState<Task["status"] | undefined>(undefined);
	const [selectedTask, setSelectedTask] = useState<Task | null>(null);
	const [sidebarTab, setSidebarTab] = useState<SidebarTab>("details");
	const [discussionCount, setDiscussionCount] = useState(0);
	const [deleteConfirm, setDeleteConfirm] = useState<{
		show: boolean;
		task: Task | null;
	}>({ show: false, task: null });
	const [newTaskId, setNewTaskId] = useState<string | null>(null);
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
	const regenerateTasksModal = (
		<RegenerateTasksModal
			isOpen={isRegenerateModalOpen}
			onClose={() => setIsRegenerateModalOpen(false)}
			onRegenerated={() => {
				setSelectedTask(null);
				queryClient.invalidateQueries({ queryKey: tasksKeys.all() });
			}}
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
		reorderTask,
		createTaskAsync,
		deleteTask,
		removeFromPlan,
		hasNextPage,
		isFetchingNextPage,
		fetchNextPage,
	} = useTasks(filter);

	const getTaskUiMeta = useCallback((task: Task): TaskUiMetadata => {
		const ui = task.metadata.ui;
		return {
			tags: ui?.tags ?? [],
			color: ui?.color ?? "slate",
			bold: ui?.bold ?? false,
			llm: ui?.llm,
		};
	}, []);

	const availableTags = useMemo(() => {
		const tagSet = new Set<string>();
		tasks.forEach((task) => {
			getTaskUiMeta(task).tags?.forEach((tag) => {
				tagSet.add(tag);
			});
		});
		return Array.from(tagSet).sort((a, b) => a.localeCompare(b));
	}, [tasks, getTaskUiMeta]);

	const filteredTasks = useMemo(() => {
		let result = tasks;

		if (searchText.trim()) {
			const search = searchText.toLowerCase();
			result = result.filter(
				(task) =>
					task.subject.toLowerCase().includes(search) ||
					task.description.toLowerCase().includes(search) ||
					task.phase?.toLowerCase().includes(search),
			);
		}

		if (tagFilter.length > 0) {
			result = result.filter((task) => {
				const tags = getTaskUiMeta(task).tags ?? [];
				return tagFilter.some((tag) => tags.includes(tag));
			});
		}

		return result;
	}, [tasks, tagFilter, searchText, getTaskUiMeta]);

	useEffect(() => {
		if (!isWorkspacePanel) return;

		const taskId = searchParams.get("task");
		const view = searchParams.get("view");
		setSidebarTab(view === "discussions" ? "discussions" : "details");

		if (!taskId) {
			setSelectedTask(null);
			return;
		}

		setSelectedTask(tasks.find((task) => task.id === taskId) || null);
	}, [isWorkspacePanel, searchParams, tasks]);

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
			const target = tasks.find((task) => task.id === taskId);
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
		[tasks, getTaskUiMeta, updateTask],
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
				const result = await createTaskAsync({
					subject,
					description: subject,
					priority: "normal",
					metadata: {
						ui: { tags: [], bold: false, color: "slate", llm: llmMeta },
					},
					sortOrder: index,
				});
				// Set the new task ID to trigger scroll
				if (result?.id) {
					setNewTaskId(result.id);
					// Clear after 3 seconds
					setTimeout(() => setNewTaskId(null), 3000);
				}
			} catch {
				// Error is handled by the mutation
			}
		},
		[createTaskAsync],
	);

	const handleReorder = useCallback(
		(taskId: string, fromSortOrder: number, toSortOrder: number, prevTaskId?: string | null, nextTaskId?: string | null) => {
			if (!taskId) return;
			reorderTask({ taskId, fromSortOrder, toSortOrder, prevTaskId, nextTaskId });
		},
		[reorderTask],
	);

  const handleOpenDetails = useCallback((task: Task) => {
    if (!isWorkspacePanel) {
      setSelectedTask(task);
      setSidebarTab("details");
      return;
    }

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
  }, [isWorkspacePanel, openWorkspaceRoute, searchParams]);

  const handleOpenDiscussions = useCallback((task: Task) => {
    if (!isWorkspacePanel) {
      setSelectedTask(task);
      setSidebarTab("discussions");
      return;
    }

    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.set("task", task.id);
    nextSearchParams.set("view", "discussions");
    openWorkspaceRoute(
      {
        pathname: "/tasks",
        search: `?${nextSearchParams.toString()}`,
      },
      "split",
    );
  }, [isWorkspacePanel, openWorkspaceRoute, searchParams]);

	const toggleTagFilter = useCallback((tag: string) => {
		setTagFilter((prev) =>
			prev.includes(tag) ? prev.filter((item) => item !== tag) : [...prev, tag],
		);
	}, []);

	const handleRemoveTagFromTask = useCallback(
		(taskId: string, tagToRemove: string) => {
			const target = tasks.find((task) => task.id === taskId);
			if (!target) return;
			const currentTags = getTaskUiMeta(target).tags ?? [];
			const nextTags = currentTags.filter((tag) => tag !== tagToRemove);
			handleUpdateUi(taskId, { tags: nextTags });
		},
		[tasks, getTaskUiMeta, handleUpdateUi],
	);

	// Update selected task when tasks change
	React.useEffect(() => {
		if (!selectedTask) return;
		const latest = tasks.find((task) => task.id === selectedTask.id) || null;
		setSelectedTask(latest);
	}, [tasks, selectedTask]);

	// Reset discussion count when selected task changes
	React.useEffect(() => {
		if (selectedTask?.id === undefined) {
			setDiscussionCount(0);
			return;
		}
		setDiscussionCount(0);
	}, [selectedTask?.id]);

	// Handle WebSocket messages for real-time updates
	const handleWSMessage = useCallback(
		(msg: WebSocketMessage) => {
			if (msg.channel !== "tasks" || !msg.event) return;

			// WebSocket data can be used for more granular updates if needed
			// const data = msg.data as TaskEventData;

			switch (msg.event) {
				case "task.created":
				case "task.updated":
				case "task.deleted":
				case "tasks.regenerated":
					// Invalidate queries to trigger refetch
					queryClient.invalidateQueries({ queryKey: tasksKeys.all() });
					break;
			}
		},
		[queryClient],
	);

	// Subscribe to tasks channel
	useWebSocket({
		channels: ["tasks"],
		onMessage: handleWSMessage,
	});

	const handlePriorityChange = async (
		taskId: string,
		newPriority: Task["priority"],
	) => {
		updateTask({ id: taskId, updates: { priority: newPriority } });
	};

	if (isWorkspacePanel) {
		const workspaceListHeader = (
			<header className="flex items-center gap-2 border-b border-border bg-background px-3 py-2">
				<div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
					<div className="relative w-48 shrink-0">
						<Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-default-400" />
						<input
							type="text"
							placeholder="Search tasks..."
							value={searchText}
							onChange={(e) => setSearchText(e.target.value)}
							className="h-9 w-full rounded-md border border-border bg-surface-secondary px-8 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
						/>
					</div>
					<div className="shrink-0 text-xs text-muted-foreground">
						{counts?.total ?? 0} total
					</div>
					<div className="h-4 w-px shrink-0 bg-border" />
					{TASK_STATUS_FILTERS.map((status) => (
						<button
							key={status}
							type="button"
							aria-pressed={filter.status === status}
							onClick={() =>
								setFilter((current) =>
									current.status === status ? {} : { ...current, status },
								)
							}
							className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
								filter.status === status
									? "border-accent/50 bg-accent/10 text-accent"
									: "border-transparent text-muted-foreground hover:bg-surface-secondary hover:text-foreground"
							}`}
						>
							<span>{STATUS_CONFIG[status].label}</span>
							<span>{counts?.byStatus?.[status] ?? 0}</span>
						</button>
					))}
					{availableTags.length > 0 ? <div className="h-4 w-px shrink-0 bg-border" /> : null}
					{availableTags.slice(0, 8).map((tag) => (
						<button
							key={tag}
							type="button"
							aria-pressed={tagFilter.includes(tag)}
							onClick={() => toggleTagFilter(tag)}
							className={`h-8 shrink-0 rounded-md border px-2.5 text-xs transition-colors ${
								tagFilter.includes(tag)
									? "border-accent/50 bg-accent/10 text-accent"
									: "border-border text-muted-foreground hover:bg-surface-secondary hover:text-foreground"
							}`}
						>
							{tag}
						</button>
					))}
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<TaskWorkflowHelp />
					<Button isIconOnly size="sm" variant="ghost" onPress={() => refetch()} aria-label="Refresh">
						<RefreshCw className="h-4 w-4" />
					</Button>
					<Button size="sm" variant="primary" onPress={() => setIsRegenerateModalOpen(true)}>
						<RefreshCw className="mr-1.5 h-4 w-4" />
						Regenerate All Tasks
					</Button>
					<Button
						size="sm"
						variant="primary"
						onPress={() => {
							setEditingTask(undefined);
							setEditingStatus(undefined);
							setIsModalOpen(true);
						}}
					>
						<Plus className="mr-1.5 h-4 w-4" />
						New
					</Button>
				</div>
			</header>
		);

		if (!selectedTask) {
			return (
				<>
					<div className="flex h-full min-h-0 flex-col bg-background">
						{workspaceListHeader}
						<TaskTimeline tasks={tasks} onOpenTask={handleOpenDetails} />
						<div className="min-h-0 flex-1 overflow-auto">
							<TaskGrid
								className="rounded-none border-0"
								tasks={filteredTasks}
								totalTasks={pagination?.total}
								availableTags={availableTags}
								selectedTaskId={undefined}
								newTaskId={newTaskId}
								onOpenDetails={handleOpenDetails}
								onOpenDiscussions={handleOpenDiscussions}
								onUpdateTask={handleUpdateTask}
								onUpdateUi={handleUpdateUi}
								onDelete={handleDeleteTask}
								onCreateTaskAt={handleCreateTaskAt}
								onReorder={handleReorder}
							/>
						</div>
					</div>
					{taskModal}
					{regenerateTasksModal}
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
						onStatusChange={handleStatusChange}
					/>

					{sidebarTab === detailsTabId ? (
						<div className="flex-1 overflow-auto p-3" role="tabpanel">
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
				{regenerateTasksModal}
			</>
		);
	}

	return (
		<div className="flex flex-col h-full">
			{/* Header with filters and actions */}
			<div className="border-b px-4 py-3 bg-content2">
				<div className="flex items-center justify-between mb-3">
					<div className="flex items-center space-x-2">
						<h1 className="text-lg font-semibold">Tasks</h1>
						<span className="text-sm text-foreground-500">
							Brain-managed task queue
						</span>
					</div>

					<div className="flex items-center gap-2">
						<TaskWorkflowHelp />
						<Button
							isIconOnly
							variant="ghost"
							onPress={() => refetch()}
							aria-label="Refresh"
						>
							<RefreshCw className="h-4 w-4" />
						</Button>
						<Button
							variant="primary"
							onPress={() => setIsRegenerateModalOpen(true)}
						>
							<RefreshCw className="h-4 w-4 mr-2" />
							Regenerate All Tasks
						</Button>
						<Button
							variant="primary"
							onPress={() => {
								setEditingTask(undefined);
								setEditingStatus(undefined);
								setIsModalOpen(true);
							}}
						>
							<Plus className="h-4 w-4 mr-2" />
							New Task
						</Button>
					</div>
				</div>

				{/* Compact filter bar */}
				<div className="flex items-center gap-3">
					<div className="relative">
						<Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-default-400" />
						<input
							type="text"
							placeholder="Search tasks..."
							value={searchText}
							onChange={(e) => setSearchText(e.target.value)}
							className="pl-8 pr-3 py-1.5 text-sm bg-default-100 border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-accent w-64"
						/>
					</div>
					<div className="h-4 w-px bg-divider" />
					<div className="flex items-center gap-2 text-sm">
						<span className="text-foreground-500">Total:</span>
						<span className="font-medium">{counts?.total ?? 0}</span>
					</div>
					<div className="h-4 w-px bg-divider" />
					<div className="flex items-center gap-2 flex-wrap">
						{Object.entries(counts?.byStatus ?? {}).map(([status, count]) => (
							<Button
								key={status}
								size="sm"
								variant={filter.status === status ? "primary" : "ghost"}
								onPress={() =>
									setFilter((f) =>
										f.status === status ? {} : { ...f, status },
									)
								}
								className="h-7"
							>
							<span
								className={
									filter.status === status
										? ""
										: isTaskStatus(status)
											? STATUS_CONFIG[status].color
											: "text-foreground-500"
								}
							>
									{status.replace("_", " ")}
								</span>
								<span>{count}</span>
							</Button>
						))}
						{filter.status && (
							<Button size="sm" variant="ghost" onPress={() => setFilter({})}>
								Clear filter
							</Button>
						)}
					</div>
				</div>

				<div className="mt-3 flex items-center gap-2 flex-wrap">
					<div className="flex items-center gap-1 text-xs text-foreground-500">
						<Tag className="h-3.5 w-3.5" />
						<span>Tags</span>
					</div>
					{availableTags.length === 0 ? (
						<span className="text-xs text-foreground-500">No tags yet</span>
					) : (
						availableTags.map((tag) => (
							<Chip
								key={tag}
								size="sm"
								variant={tagFilter.includes(tag) ? "primary" : "soft"}
								onClick={() => toggleTagFilter(tag)}
								className="cursor-pointer"
							>
								{tag}
							</Chip>
						))
					)}
					{tagFilter.length > 0 && (
						<Button size="sm" variant="ghost" onPress={() => setTagFilter([])}>
							Clear tags
						</Button>
					)}
				</div>
			</div>

			{isError && error && (
				<div className="p-4 bg-danger/10 text-danger border-b border-danger/20">
					<div className="flex items-center gap-2">
						<AlertTriangle className="h-4 w-4" />
						<span className="text-sm">{error.message}</span>
					</div>
				</div>
			)}

			<TaskTimeline tasks={tasks} onOpenTask={handleOpenDetails} />

			{/* Content area */}
			<div className="flex-1 flex overflow-hidden">
				{/* Task list */}
				<div className="flex-1 overflow-auto">
					{isLoading ? (
						<div className="p-4 space-y-4">
							{[1, 2, 3].map((i) => (
								<Card key={i} className="h-24">
									<Card.Content className="animate-pulse bg-default-100" />
								</Card>
							))}
						</div>
					) : (
						<div className="p-4">
							<TaskGrid
								tasks={filteredTasks}
								totalTasks={pagination?.total}
								availableTags={availableTags}
								selectedTaskId={selectedTask?.id}
								newTaskId={newTaskId}
								onOpenDetails={handleOpenDetails}
								onOpenDiscussions={handleOpenDiscussions}
								onUpdateTask={handleUpdateTask}
								onUpdateUi={handleUpdateUi}
								onDelete={handleDeleteTask}
								onCreateTaskAt={handleCreateTaskAt}
								onReorder={handleReorder}
							/>
							{/* Load More Button */}
							{hasNextPage && (
								<div className="mt-4 flex justify-center">
									<Button
										variant="secondary"
										onPress={() => fetchNextPage()}
										isDisabled={isFetchingNextPage}
										className="w-full max-w-md"
									>
										{isFetchingNextPage ? (
											<>
												<RefreshCw className="h-4 w-4 mr-2 animate-spin" />
												Loading more...
											</>
										) : (
											<>
												<ChevronDown className="h-4 w-4 mr-2" />
												Load more tasks ({tasks.length} loaded)
											</>
										)}
									</Button>
								</div>
							)}
							{!hasNextPage && tasks.length > 0 && (
								<div className="mt-4 text-center text-sm text-muted-foreground">
									All {tasks.length} tasks loaded
								</div>
							)}
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
				{regenerateTasksModal}

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
