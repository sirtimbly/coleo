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
} from "lucide-react";
import { Button, Chip, Card, Tabs } from "@heroui/react";
import {
	type Task,
	type TaskLlmMetadata,
	type TaskMetadata,
	type TaskUiMetadata,
	cn,
} from "@/lib";
import { TaskModal, TaskDiscussionPanel, TaskSummaryPanel, TaskDiffPanel } from "@/components";
import { WorkspacePageShell } from "@/components/WorkspacePageShell";
import { useWebSocket, type WebSocketMessage } from "@/hooks/useWebSocket";
import { TaskGrid } from "@/components/TaskGrid";
import type { TaskUpdate } from "@/components/TaskGridRow";
import { useTasks } from "@/hooks/useTasks";
import { usePageTitle } from '@/hooks/usePageTitle';
import { useQueryClient } from "@tanstack/react-query";
import { tasksKeys } from "@/lib/queryKeys";
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
					className="w-full resize-none rounded-md border border-border/70 bg-content2 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
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
			<p className="whitespace-pre-wrap">{description}</p>
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
	const [editingTask, setEditingTask] = useState<Task | undefined>(undefined);
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
			}}
			onSaved={() => refetch()}
			task={editingTask}
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
		const toolbar = (
			<>
				<Button isIconOnly size="sm" variant="ghost" onPress={() => refetch()} aria-label="Refresh">
					<RefreshCw className="h-4 w-4" />
				</Button>
				<Button
					size="sm"
					variant="primary"
					onPress={() => {
						setEditingTask(undefined);
						setIsModalOpen(true);
					}}
				>
					<Plus className="h-4 w-4 mr-1.5" />
					New
				</Button>
			</>
		);

		const filters = (
			<div className="space-y-2">
				<div className="flex flex-wrap items-center gap-2">
					<div className="relative min-w-[220px] flex-1 max-w-sm">
						<Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-default-400" />
						<input
							type="text"
							placeholder="Search tasks..."
							value={searchText}
							onChange={(e) => setSearchText(e.target.value)}
							className="w-full rounded-md border border-border/70 bg-content2 px-8 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
						/>
					</div>
					<div className="text-xs text-muted-foreground">
						{counts?.total ?? 0} total
					</div>
				</div>

				<div className="flex flex-wrap items-center gap-2">
					{Object.entries(counts?.byStatus ?? {}).map(([status, count]) => (
						<Button
							key={status}
							size="sm"
							variant={filter.status === status ? "primary" : "ghost"}
							onPress={() =>
								setFilter((current) =>
									current.status === status ? {} : { ...current, status },
								)
							}
						>
							<span>{status.replace("_", " ")}</span>
							<span>{count}</span>
						</Button>
					))}
					{availableTags.slice(0, 8).map((tag) => (
						<Chip
							key={tag}
							size="sm"
							variant={tagFilter.includes(tag) ? "primary" : "soft"}
							onClick={() => toggleTagFilter(tag)}
							className="cursor-pointer"
						>
							{tag}
						</Chip>
					))}
				</div>
			</div>
		);

		if (!selectedTask) {
			return (
				<>
					<WorkspacePageShell
						title="Tasks"
						subtitle="Compact task queue"
						toolbar={toolbar}
						filters={filters}
					>
						<div className="h-full overflow-auto p-3">
							<TaskGrid
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
					</WorkspacePageShell>
					{taskModal}
				</>
			);
		}

		return (
			<>
				<WorkspacePageShell
					title={selectedTask.subject}
					subtitle={sidebarTab === "discussions" ? "Task discussion" : "Task details"}
					toolbar={
						<div className="flex items-center gap-2">
							<TaskPriorityBadge
								priority={selectedTask.priority}
								taskId={selectedTask.id}
								onPriorityChange={handlePriorityChange}
							/>
						</div>
					}
				>
					<Tabs
						selectedKey={sidebarTab}
						onSelectionChange={(key) => {
							if (key === "details" || key === "summary" || key === "diff" || key === "discussions") {
								setSidebarTab(key);
							}
						}}
						className="flex h-full flex-col"
					>
						<Tabs.ListContainer className="border-b border-border/70 px-3 py-2">
							<Tabs.List aria-label="Task tabs">
							<Tabs.Tab id={detailsTabId}>
								<FileText className="h-4 w-4" />
								<span className="px-2">Details</span>
								<Tabs.Indicator />
							</Tabs.Tab>
							<Tabs.Tab id={summaryTabId}>
								<ScrollText className="h-4 w-4" />
								<span className="px-2">Summary</span>
								<Tabs.Indicator />
							</Tabs.Tab>
							<Tabs.Tab id={diffTabId}>
								<GitCommitHorizontal className="h-4 w-4" />
								<span className="px-2">Diff</span>
								<Tabs.Indicator />
							</Tabs.Tab>
							<Tabs.Tab id={discussionsTabId}>
								<MessageSquare className="h-4 w-4" />
								<span className="px-2">Discussions</span>
								<Tabs.Indicator />
							</Tabs.Tab>
						</Tabs.List>
					</Tabs.ListContainer>

					<Tabs.Panel id={detailsTabId} className="flex-1 overflow-auto p-4">
							<div className="space-y-4">
								<div className="flex items-center justify-between">
									<span className="text-xs text-muted-foreground font-mono">ID: {selectedTask.id}</span>
									<TaskCreatedAt createdAt={selectedTask.createdAt} />
								</div>
								<div>
									<h5 className="mb-1 text-sm font-medium text-foreground-500">Description</h5>
									<TaskDescriptionField
										taskId={selectedTask.id}
										description={selectedTask.description}
										onSave={(taskId, description) => handleUpdateTask(taskId, { description })}
									/>
								</div>
								<div className="grid grid-cols-2 gap-4 text-sm">
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
							</div>
						</Tabs.Panel>

					<Tabs.Panel id={summaryTabId} className="flex-1 p-0">
							<TaskSummaryPanel taskId={selectedTask.id} className="h-full" />
						</Tabs.Panel>

					<Tabs.Panel id={diffTabId} className="flex-1 p-0">
							<TaskDiffPanel taskId={selectedTask.id} className="h-full" />
						</Tabs.Panel>

					<Tabs.Panel id={discussionsTabId} className="flex-1 p-0">
							<TaskDiscussionPanel
								taskId={selectedTask.id}
								onCommentCountChange={setDiscussionCount}
								className="h-full"
							/>
						</Tabs.Panel>
					</Tabs>
				</WorkspacePageShell>
				{taskModal}
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
							onPress={() => {
								setEditingTask(undefined);
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
					<Card className="w-128 overflow-auto border-l rounded-none shadow-none flex flex-col">
						{/* Header with close button */}
						<div className="p-3 border-b flex items-center justify-between flex-shrink-0">
							<h3
								className="font-semibold text-sm max-w-[280px]"
								title={selectedTask.subject}
							>
								{selectedTask.subject}
							</h3>
							<Button
								isIconOnly
								size="sm"
								variant="ghost"
								onPress={() => setSelectedTask(null)}
								aria-label="Close"
							>
								<X className="h-4 w-4" />
							</Button>
						</div>

						{/* Tabs */}
						<Tabs
							selectedKey={sidebarTab}
							onSelectionChange={(key) => {
								if (key === "details" || key === "summary" || key === "diff" || key === "discussions") {
									setSidebarTab(key);
								}
							}}
							className="flex-1 flex flex-col"
						>
							<Tabs.ListContainer className="flex-shrink-0">
								<Tabs.List aria-label="Task tabs" className="w-full">
									<Tabs.Tab id={detailsTabId} className="flex-1">
										<FileText className="h-4 w-4" />
										<span className="px-2">Details</span>
										<Tabs.Indicator />
									</Tabs.Tab>
									<Tabs.Tab id={summaryTabId} className="flex-1">
										<ScrollText className="h-4 w-4" />
										<span className="px-2">Summary</span>
										<Tabs.Indicator />
									</Tabs.Tab>
									<Tabs.Tab id={diffTabId} className="flex-1">
										<GitCommitHorizontal className="h-4 w-4" />
										<span className="px-2">Diff</span>
										<Tabs.Indicator />
									</Tabs.Tab>
									<Tabs.Tab id={discussionsTabId} className="flex-1">
										<MessageSquare className="h-4 w-4" />
										<span className="px-2">Discussions</span>
										<Tabs.Indicator />
										{discussionCount > 0 && (
											<Chip color="accent" size="sm" variant="soft">
												{discussionCount}
											</Chip>
										)}
									</Tabs.Tab>
								</Tabs.List>
							</Tabs.ListContainer>

						<Tabs.Panel id={detailsTabId} className="flex-1 p-0">
								<div className="p-4 overflow-auto h-full">
									<div className="space-y-4">
										<div className="flex items-center justify-between">
											<span className="text-xs text-foreground-500 font-mono">
												ID: {selectedTask.id}
											</span>
											<TaskCreatedAt createdAt={selectedTask.createdAt} />
										</div>

										<div>
											<TaskPriorityBadge
												priority={selectedTask.priority}
												taskId={selectedTask.id}
												onPriorityChange={handlePriorityChange}
											/>
										</div>

										<div>
											<h5 className="text-sm font-medium text-foreground-500 mb-1">
												Description
											</h5>
											<TaskDescriptionField
												taskId={selectedTask.id}
												description={selectedTask.description}
												onSave={(taskId, description) => handleUpdateTask(taskId, { description })}
											/>
										</div>

										<div className="grid grid-cols-2 gap-4 text-sm">
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
												<span className="text-foreground-500">Priority:</span>
												<div className="mt-1">
													<TaskPriorityBadge
														priority={selectedTask.priority}
														taskId={selectedTask.id}
														onPriorityChange={handlePriorityChange}
													/>
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
												<p className="text-sm">
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
												<p className="text-sm">
													{
														getTaskUiMeta(selectedTask).llm
															?.generatedDescription
													}
												</p>
											</div>
										)}
									</div>
								</div>
							</Tabs.Panel>

						<Tabs.Panel id={summaryTabId} className="flex-1 p-0">
								<TaskSummaryPanel taskId={selectedTask.id} className="h-full" />
							</Tabs.Panel>

						<Tabs.Panel id={diffTabId} className="flex-1 p-0">
								<TaskDiffPanel taskId={selectedTask.id} className="h-full" />
							</Tabs.Panel>

						<Tabs.Panel
							id={discussionsTabId}
							className="flex-1 p-0"
						>
								<TaskDiscussionPanel
									taskId={selectedTask.id}
									onCommentCountChange={setDiscussionCount}
									className="h-full"
								/>
							</Tabs.Panel>
						</Tabs>
					</Card>
				)}
			</div>

				{/* Task Modal */}
				<TaskModal
					isOpen={isModalOpen}
					onClose={() => {
						setIsModalOpen(false);
						setEditingTask(undefined);
					}}
					onSaved={() => refetch()}
					task={editingTask}
				/>

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
