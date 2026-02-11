import { Button } from "@heroui/react";
import { useEffect, useState, useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import {
	Eye,
	Radio,
	Wrench,
	CheckCircle2,
	XCircle,
	Clock,
	Loader2,
	ChevronDown,
	ChevronRight,
	FileEdit,
	Terminal,
	AlertTriangle,
	MessageSquare,
	GitBranch,
	ListTodo,
	Zap,
	Bot,
	Coins,
	Trash2,
	RefreshCw,
	Maximize2,
	Minimize2,
	ShieldQuestion,
	TrendingUp,
	TrendingDown,
	Minus,
	CircleDashed,
	Play,
	Pause,
	AlertOctagon,
} from "lucide-react";
import {
	api,
	type Arm,
	type ArmTodo,
	type OpenCodeEvent,
	type ArmAnalysisFull,
	type ArmActivityState,
	type ArmMessage,
} from "@/lib";
import { StatusBadge } from "@/components";
import { useArmEvents, useWebSocket } from "@/hooks";

// Activity item types for the log
type ActivityType =
	| "message"
	| "tool"
	| "file"
	| "session"
	| "error"
	| "todo"
	| "step"
	| "terminal"
	| "branch";

interface ActivityItem {
	id: string;
	type: ActivityType;
	title: string;
	subtitle?: string;
	status: "pending" | "running" | "completed" | "error" | "info";
	timestamp: number;
	details?: Record<string, unknown>;
	expanded?: boolean;
}

interface ArmHistoryState {
	activities: ActivityItem[];
	todos: ArmTodo[];
	currentText: string;
	totalCost: number;
	totalTokens: { input: number; output: number };
	sessionStatus: string;
	lastUpdated: number;
}

type ViewerTab = "events" | "logs";

const MAX_HISTORY_ITEMS = 200;
const STORAGE_PREFIX = "coleo-arm-history-";

function getStorageKey(armId: string): string {
	return `${STORAGE_PREFIX}${armId}`;
}

function loadArmHistory(armId: string): ArmHistoryState | null {
	try {
		const key = getStorageKey(armId);
		const stored = localStorage.getItem(key);
		if (!stored) return null;

		const parsed = JSON.parse(stored) as ArmHistoryState;

		// Check if history is stale (older than 24 hours)
		if (Date.now() - parsed.lastUpdated > 24 * 60 * 60 * 1000) {
			localStorage.removeItem(key);
			return null;
		}

		return parsed;
	} catch {
		return null;
	}
}

function pruneOldHistories(): void {
	try {
		const cutoff = Date.now() - 24 * 60 * 60 * 1000;
		const keysToRemove: string[] = [];

		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (key?.startsWith(STORAGE_PREFIX)) {
				const stored = localStorage.getItem(key);
				if (stored) {
					try {
						const parsed = JSON.parse(stored) as { lastUpdated: number };
						if (parsed.lastUpdated < cutoff) {
							keysToRemove.push(key);
						}
					} catch {
						keysToRemove.push(key);
					}
				}
			}
		}

		keysToRemove.forEach((key) => localStorage.removeItem(key));
	} catch {
		// Ignore
	}
}

// Color schemes for different activity types
const activityColors: Record<
	ActivityType,
	{ bg: string; border: string; icon: string }
> = {
	message: {
		bg: "bg-blue-500/10",
		border: "border-l-blue-500",
		icon: "text-blue-500",
	},
	tool: {
		bg: "bg-purple-500/10",
		border: "border-l-purple-500",
		icon: "text-purple-500",
	},
	file: {
		bg: "bg-green-500/10",
		border: "border-l-green-500",
		icon: "text-green-500",
	},
	session: {
		bg: "bg-cyan-500/10",
		border: "border-l-cyan-500",
		icon: "text-cyan-500",
	},
	error: {
		bg: "bg-red-500/10",
		border: "border-l-red-500",
		icon: "text-red-500",
	},
	todo: {
		bg: "bg-yellow-500/10",
		border: "border-l-yellow-500",
		icon: "text-yellow-500",
	},
	step: {
		bg: "bg-indigo-500/10",
		border: "border-l-indigo-500",
		icon: "text-indigo-500",
	},
	terminal: {
		bg: "bg-orange-500/10",
		border: "border-l-orange-500",
		icon: "text-orange-500",
	},
	branch: {
		bg: "bg-pink-500/10",
		border: "border-l-pink-500",
		icon: "text-pink-500",
	},
};

const activityIcons: Record<ActivityType, typeof Wrench> = {
	message: MessageSquare,
	tool: Wrench,
	file: FileEdit,
	session: Zap,
	error: AlertTriangle,
	todo: ListTodo,
	step: Bot,
	terminal: Terminal,
	branch: GitBranch,
};

export function ArmViewerPage() {
	const [searchParams, setSearchParams] = useSearchParams();
	const selectedArmId = searchParams.get("arm");

	const [arms, setArms] = useState<Arm[]>([]);
	const [activities, setActivities] = useState<ActivityItem[]>([]);
	const [todos, setTodos] = useState<ArmTodo[]>([]);
	const [sessionStatus, setSessionStatus] = useState<string>("unknown");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [currentText, setCurrentText] = useState<string>("");
	const [totalCost, setTotalCost] = useState<number>(0);
	const [totalTokens, setTotalTokens] = useState<{
		input: number;
		output: number;
	}>({ input: 0, output: 0 });
	const [panelWidth, setPanelWidth] = useState(400);
	const [isResizing, setIsResizing] = useState(false);
	const [viewerExpanded, setViewerExpanded] = useState(false);
	const [armAnalysis, setArmAnalysis] = useState<ArmAnalysisFull | null>(null);
	const [analysisLoading, setAnalysisLoading] = useState(false);
	const [activeTab, setActiveTab] = useState<ViewerTab>("logs");
	const [messages, setMessages] = useState<ArmMessage[]>([]);
	const [logsLoading, setLogsLoading] = useState(false);
	const [logsError, setLogsError] = useState<string | null>(null);

	const feedContainerRef = useRef<HTMLDivElement>(null);
	const autoScrollEnabledRef = useRef(true);
	const activityIdCounter = useRef(0);
	const lastLogsRefreshAt = useRef(0);

	const isAtBottom = useCallback((container: HTMLDivElement) => {
		const bottomOffset =
			container.scrollHeight - container.scrollTop - container.clientHeight;
		return bottomOffset <= 24;
	}, []);

	const handleFeedScroll = useCallback(() => {
		const container = feedContainerRef.current;
		if (!container) {
			return;
		}
		autoScrollEnabledRef.current = isAtBottom(container);
	}, [isAtBottom]);

	const scrollFeedToBottom = useCallback(
		(behavior: ScrollBehavior = "auto") => {
			const container = feedContainerRef.current;
			if (!container) {
				return;
			}
			container.scrollTo({ top: container.scrollHeight, behavior });
		},
		[],
	);

	// Generate unique activity ID
	const genId = () => `act-${++activityIdCounter.current}-${Date.now()}`;

	// Add or update activity
	const upsertActivity = useCallback(
		(
			id: string,
			updates: Partial<ActivityItem> & { type: ActivityType; title: string },
		) => {
			setActivities((prev) => {
				const idx = prev.findIndex((a) => a.id === id);
				if (idx >= 0) {
					const updated = [...prev];
					updated[idx] = { ...updated[idx], ...updates };
					return updated;
				}
				return [
					...prev,
					{
						id,
						status: "info",
						timestamp: Date.now(),
						expanded: false,
						...updates,
					},
				];
			});
		},
		[],
	);

	// Load arms list
	const loadArms = async () => {
		try {
			const res = await api.listArms();
			setArms(res.arms.filter((a) => a.status !== "stopped"));
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load arms");
		} finally {
			setLoading(false);
		}
	};

	// Load todos for selected arm
	const loadTodos = async (armId: string) => {
		try {
			const res = await api.getArmTodos(armId);
			if (res.todos) {
				setTodos(res.todos);
			}
		} catch (err) {
			console.error("Failed to load todos:", err);
		}
	};

	// Load analysis for selected arm
	const loadAnalysis = async (armId: string) => {
		setAnalysisLoading(true);
		try {
			const res = await api.getArmAnalysis(armId);
			setArmAnalysis(res);
		} catch (err) {
			// Analysis might not be available if NATS isn't running
			console.error("Failed to load analysis:", err);
			setArmAnalysis(null);
		} finally {
			setAnalysisLoading(false);
		}
	};

	const loadMessages = useCallback(async (armId: string, silent = false) => {
		if (!silent) {
			setLogsLoading(true);
		}
		try {
			const res = await api.getArmMessages(armId, 200);
			setMessages(res.messages || []);
			setLogsError(res.error || null);
		} catch (err) {
			setLogsError(
				err instanceof Error ? err.message : "Failed to load message logs",
			);
		} finally {
			if (!silent) {
				setLogsLoading(false);
			}
		}
	}, []);

	const refreshMessagesThrottled = useCallback(
		(armId: string) => {
			const now = Date.now();
			if (now - lastLogsRefreshAt.current < 1000) {
				return;
			}
			lastLogsRefreshAt.current = now;
			void loadMessages(armId, true);
		},
		[loadMessages],
	);

	// Handle SSE events from arm
	const handleArmEvent = useCallback(
		(event: OpenCodeEvent) => {
			const { type, properties: props } = event;

			// Message events
			if (type === "message.updated") {
				const info = props.info as { id: string; role: string } | undefined;
				if (info) {
					const role = info.role;
					const roleLabel =
						role === "assistant"
							? "Assistant"
							: role === "user"
								? "User"
								: "System";
					upsertActivity(`msg-${info.id}`, {
						type: "message",
						title: `${roleLabel} message`,
						status: "running",
						details: { role, messageId: info.id },
					});
				}
				if (selectedArmId && activeTab === "logs") {
					refreshMessagesThrottled(selectedArmId);
				}
			}

			// Text parts - use delta for incremental updates
			if (type === "message.part.updated" || type === "message.part.created") {
				const part = props.part as
					| {
							id?: string;
							type: string;
							text?: string;
							tool?: string;
							state?: {
								status: string;
								title?: string;
								input?: Record<string, unknown>;
								output?: string;
								error?: string;
								time?: { start: number; end: number };
							};
					  }
					| undefined;
				const delta = props.delta as string | undefined;

				if (part) {
					// Text content - use delta for updates, full text for creates
					if (part.type === "text") {
						if (delta) {
							// Append delta to current text
							setCurrentText((prev) => prev + delta);
						} else if (type === "message.part.created" && part.text) {
							// New text part, set initial text
							setCurrentText(part.text);
						}
					}

					// Tool calls
					if (part.type === "tool" && part.tool) {
						const state = part.state;
						const status = state?.status || "pending";
						const title = state?.title || part.tool;
						// Use part.id if available for stable key, otherwise generate one
						const toolId = part.id || `tool-${part.tool}-${Date.now()}`;

						let actStatus: ActivityItem["status"] = "pending";
						if (status === "running") actStatus = "running";
						else if (status === "completed") actStatus = "completed";
						else if (status === "error") actStatus = "error";

						upsertActivity(toolId, {
							type: "tool",
							title: title,
							subtitle: part.tool,
							status: actStatus,
							details: {
								tool: part.tool,
								input: state?.input,
								output: state?.output,
								error: state?.error,
								duration: state?.time
									? state.time.end - state.time.start
									: undefined,
							},
						});
					}

					// Step finish - contains cost/token info
					if (part.type === "step-finish") {
						const stepPart = part as unknown as {
							cost?: number;
							tokens?: {
								input: number;
								output: number;
								reasoning?: number;
								cache?: { read: number; write: number };
							};
							reason?: string;
						};

						if (stepPart.cost) {
							setTotalCost((prev) => prev + stepPart.cost!);
						}
						if (stepPart.tokens) {
							setTotalTokens((prev) => ({
								input: prev.input + stepPart.tokens!.input,
								output: prev.output + stepPart.tokens!.output,
							}));
						}

						upsertActivity(genId(), {
							type: "step",
							title: "Step completed",
							subtitle: stepPart.reason || "done",
							status: "completed",
							details: {
								cost: stepPart.cost,
								tokens: stepPart.tokens,
							},
						});
					}

					// File parts
					if (part.type === "file") {
						const filePart = part as unknown as {
							filename?: string;
							mime?: string;
						};
						upsertActivity(genId(), {
							type: "file",
							title: filePart.filename || "File",
							subtitle: filePart.mime,
							status: "info",
						});
					}

					if (selectedArmId && activeTab === "logs") {
						refreshMessagesThrottled(selectedArmId);
					}
				}
			}

			// File edited
			if (type === "file.edited") {
				const file = props.file as string | undefined;
				if (file) {
					upsertActivity(genId(), {
						type: "file",
						title: "File edited",
						subtitle: file.split("/").pop() || file,
						status: "completed",
						details: { path: file },
					});
				}
			}

			// Session status
			if (type === "session.status") {
				const status = props.status as
					| { type: string; attempt?: number; message?: string }
					| undefined;
				if (status?.type) {
					setSessionStatus(status.type);

					if (status.type === "idle") {
						// Mark all running activities as completed
						setActivities((prev) =>
							prev.map((a) =>
								a.status === "running" ? { ...a, status: "completed" } : a,
							),
						);
						setCurrentText("");

						// Refresh todos
						if (selectedArmId) {
							loadTodos(selectedArmId);
							refreshMessagesThrottled(selectedArmId);
						}
					} else if (status.type === "busy") {
						upsertActivity("session-busy", {
							type: "session",
							title: "Processing",
							status: "running",
						});
					} else if (status.type === "retry") {
						upsertActivity(genId(), {
							type: "session",
							title: "Retrying",
							subtitle: `Attempt ${status.attempt}: ${status.message}`,
							status: "running",
						});
					}
				}
			}

			// Session error
			if (type === "session.error") {
				const error = props.error as
					| { name?: string; data?: { message?: string } }
					| undefined;
				const message = error?.data?.message || error?.name || "Unknown error";
				upsertActivity(genId(), {
					type: "error",
					title: "Error",
					subtitle: message,
					status: "error",
					details: { error },
				});
			}

			// Todo updates - only update if this is for the currently selected arm
			if (type === "todo.updated") {
				const todos = props.todos as ArmTodo[] | undefined;
				if (todos && selectedArmId) {
					// Only update todos if the event is from the currently selected arm
					// The SSE connection should already be filtered by arm, but this adds extra safety
					setTodos(todos);
					upsertActivity("todos-updated", {
						type: "todo",
						title: "Todos updated",
						subtitle: `${todos.filter((t) => t.status === "completed").length}/${todos.length} complete`,
						status: "info",
						details: { count: todos.length },
					});
				}
			}

			// PTY (terminal) events
			if (type === "pty.created" || type === "pty.updated") {
				const ptyId = props.id as string | undefined;
				upsertActivity(`pty-${ptyId}`, {
					type: "terminal",
					title: "Terminal",
					subtitle: type === "pty.created" ? "Created" : "Updated",
					status: type === "pty.created" ? "running" : "info",
				});
			}

			if (type === "pty.exited") {
				const ptyId = props.id as string | undefined;
				const code = props.code as number | undefined;
				upsertActivity(`pty-${ptyId}`, {
					type: "terminal",
					title: "Terminal exited",
					subtitle: `Exit code: ${code}`,
					status: code === 0 ? "completed" : "error",
				});
			}

			// VCS branch
			if (type === "vcs.branch.updated") {
				const branch = props.branch as string | undefined;
				upsertActivity(genId(), {
					type: "branch",
					title: "Branch updated",
					subtitle: branch,
					status: "info",
				});
			}

			// LSP diagnostics
			if (type === "lsp.client.diagnostics") {
				const diagnostics = props.diagnostics as
					| Array<{ severity: number; message: string }>
					| undefined;
				const errorCount =
					diagnostics?.filter((d) => d.severity === 1).length || 0;
				const warnCount =
					diagnostics?.filter((d) => d.severity === 2).length || 0;
				if (errorCount > 0 || warnCount > 0) {
					upsertActivity(genId(), {
						type: errorCount > 0 ? "error" : "session",
						title: "Diagnostics",
						subtitle: `${errorCount} errors, ${warnCount} warnings`,
						status: errorCount > 0 ? "error" : "info",
					});
				}
			}
		},
		[activeTab, refreshMessagesThrottled, selectedArmId, upsertActivity],
	);

	// Subscribe to arm events
	const { connected } = useArmEvents({
		armId: selectedArmId,
		onEvent: handleArmEvent,
		autoConnect: !!selectedArmId,
	});

	// Subscribe to arms channel for status updates
	useWebSocket({
		channels: ["arms"],
		onMessage: (msg) => {
			if (msg.channel === "arms") {
				loadArms();
			}
		},
	});

	// Load arms on mount
	useEffect(() => {
		loadArms();
		pruneOldHistories();
	}, []);

	// Reset or restore state when arm changes
	useEffect(() => {
		if (selectedArmId) {
			autoScrollEnabledRef.current = true;
			// Try to restore from localStorage first
			const saved = loadArmHistory(selectedArmId);
			if (saved) {
				setActivities(saved.activities.slice(-MAX_HISTORY_ITEMS));
				// Don't restore todos from cache - always fetch fresh to prevent cross-arm contamination
				setTodos([]);
				setCurrentText(saved.currentText);
				setTotalCost(saved.totalCost);
				setTotalTokens(saved.totalTokens);
				setSessionStatus(saved.sessionStatus);
				// Note: We don't restore activityIdCounter as it's just for generating IDs
			} else {
				// No saved history - start fresh
				setActivities([]);
				setTodos([]);
				setSessionStatus("unknown");
				setCurrentText("");
				setTotalCost(0);
				setTotalTokens({ input: 0, output: 0 });
				activityIdCounter.current = 0;
			}
			// Always fetch fresh todos and analysis
			loadTodos(selectedArmId);
			loadAnalysis(selectedArmId);
			void loadMessages(selectedArmId);
		} else {
			// Clear analysis when no arm selected
			setArmAnalysis(null);
			setMessages([]);
			setLogsError(null);
		}
	}, [loadMessages, selectedArmId]);

	// Refresh text logs while viewing the Logs tab
	useEffect(() => {
		if (!selectedArmId || activeTab !== "logs") {
			return;
		}

		void loadMessages(selectedArmId, true);

		const interval = setInterval(() => {
			void loadMessages(selectedArmId, true);
		}, 3000);

		return () => clearInterval(interval);
	}, [activeTab, loadMessages, selectedArmId]);

	// Handle panel resizing
	useEffect(() => {
		const handleMouseMove = (e: MouseEvent) => {
			if (!isResizing) return;
			const newWidth = e.clientX;
			if (newWidth > 300 && newWidth < window.innerWidth - 400) {
				setPanelWidth(newWidth);
			}
		};

		const handleMouseUp = () => {
			setIsResizing(false);
		};

		if (isResizing) {
			document.addEventListener("mousemove", handleMouseMove);
			document.addEventListener("mouseup", handleMouseUp);
		}

		return () => {
			document.removeEventListener("mousemove", handleMouseMove);
			document.removeEventListener("mouseup", handleMouseUp);
		};
	}, [isResizing]);

	// Auto-scroll while the user remains at the bottom of the viewport
	useEffect(() => {
		if (!autoScrollEnabledRef.current) {
			return;
		}
		scrollFeedToBottom("auto");
	}, [activeTab, activities, currentText, messages, scrollFeedToBottom]);

	useEffect(() => {
		const raf = requestAnimationFrame(() => {
			const container = feedContainerRef.current;
			if (!container) {
				return;
			}
			autoScrollEnabledRef.current = isAtBottom(container);
			if (autoScrollEnabledRef.current) {
				scrollFeedToBottom("auto");
			}
		});
		return () => cancelAnimationFrame(raf);
	}, [activeTab, isAtBottom, scrollFeedToBottom]);

	const selectArm = (armId: string) => {
		setSearchParams({ arm: armId });
	};

	const handleClearHistory = useCallback(() => {
		if (selectedArmId) {
			localStorage.removeItem(getStorageKey(selectedArmId));
			setActivities([]);
			setTodos([]);
			setCurrentText("");
			setTotalCost(0);
			setTotalTokens({ input: 0, output: 0 });
			setSessionStatus("unknown");
			activityIdCounter.current = 0;
		}
	}, [selectedArmId]);

	const toggleActivity = (id: string) => {
		setActivities((prev) =>
			prev.map((a) => (a.id === id ? { ...a, expanded: !a.expanded } : a)),
		);
	};

	const selectedArm = arms.find((a) => a.id === selectedArmId);
	const selectedWorkItem =
		selectedArm?.currentBugTitle ?? selectedArm?.currentTaskSubject ?? null;
	const workItemType = selectedArm?.currentBugTitle
		? "bug"
		: selectedArm?.currentTaskSubject
			? "task"
			: null;

	if (loading) {
		return (
			<div className="p-8">
				<div className="animate-pulse space-y-4">
					<div className="h-8 bg-secondary rounded w-48" />
					<div className="h-96 bg-secondary rounded" />
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-full">
			{/* Left Panel - Arm selector */}
			<div className="flex flex-col" style={{ width: panelWidth }}>
				<div className="border-b border-border px-4 py-3 bg-muted/20">
					<div className="flex items-center justify-between">
						<div className="flex items-center space-x-2">
							<Eye className="h-4 w-4 text-muted-foreground" />
							<h2 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">
								Active Arms
							</h2>
						</div>
						<Button
							variant="secondary"
							onClick={() => setViewerExpanded(!viewerExpanded)}
							aria-label={viewerExpanded ? "Collapse panel" : "Expand panel"}
							isIconOnly
						>
							{viewerExpanded ? (
								<Minimize2 className="h-4 w-4" />
							) : (
								<Maximize2 className="h-4 w-4" />
							)}
						</Button>
					</div>
				</div>

				<div className="flex-1 overflow-auto">
					{arms.length === 0 ? (
						<div className="p-8 text-center text-muted-foreground">
							<Eye className="h-12 w-12 mx-auto mb-4 opacity-50" />
							<p className="text-sm">No active arms</p>
						</div>
					) : (
						<div className="p-2 space-y-1">
							{arms.map((arm) => (
								<Button
									key={arm.id}
									variant="ghost"
									className={`w-full justify-start h-auto py-3 px-4 ${
										selectedArmId === arm.id
											? "bg-accent text-accent-foreground"
											: "hover:bg-secondary"
									}`}
									onPress={() => selectArm(arm.id)}
								>
									<div className="flex items-center justify-between">
										<span className="font-medium truncate pr-2">
											{arm.name}
										</span>
										<StatusBadge status={arm.status} />
									</div>
									<p
										className={`text-xs mt-1 ${
											selectedArmId === arm.id
												? "text-accent-foreground/70"
												: "text-muted-foreground"
										}`}
									>
										{arm.harness}
									</p>
								</Button>
							))}
						</div>
					)}
				</div>
			</div>

			{/* Resizable divider */}
			<div
				className="w-1 bg-border hover:bg-accent/20 cursor-col-resize transition-colors"
				onMouseDown={() => setIsResizing(true)}
			/>

			{/* Right Panel - Activity viewer */}
			<div className="flex-1 flex flex-col overflow-hidden">
				{/* Header */}
				<div className="border-b border-border px-4 py-3 bg-gradient-to-r from-muted/15 via-background to-muted/10">
					<div className="flex flex-wrap items-start justify-between gap-3">
						<div className="min-w-0 flex-1">
							<div className="flex flex-wrap items-center gap-2">
								<div className="h-8 w-8 rounded-lg bg-accent/10 text-accent flex items-center justify-center">
									<Bot className="h-4 w-4" />
								</div>
								<h1 className="text-lg font-semibold tracking-tight truncate">
									{selectedArm ? selectedArm.name : "Arm Viewer"}
								</h1>
								{selectedArm && <StatusBadge status={selectedArm.status} />}
								{selectedArm?.harness && (
									<span className="inline-flex items-center rounded-md border border-border/70 bg-background/70 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
										{selectedArm.harness}
									</span>
								)}
							</div>
							<div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
								{selectedWorkItem ? (
									<div className="w-full min-w-0 rounded-md border border-border/70 bg-background/70 px-2.5 py-1.5">
										<span className="flex items-center gap-1.5 text-foreground/90">
											{workItemType === "bug" ? (
												<AlertOctagon className="h-3.5 w-3.5 shrink-0 text-amber-500" />
											) : (
												<ListTodo className="h-3.5 w-3.5 shrink-0 text-accent" />
											)}
											<span className="truncate min-w-0">{selectedWorkItem}</span>
										</span>
									</div>
								) : (
									<div className="inline-flex items-center gap-1.5 text-muted-foreground">
										<Minus className="h-3.5 w-3.5" />
										<span>No active task or bug</span>
									</div>
								)}
								{selectedArm?.provider && (
									<span className="inline-flex items-center rounded-md border border-border/70 bg-background/70 px-2 py-1 text-xs text-muted-foreground">
										{selectedArm.provider}
									</span>
								)}
								{selectedArm?.model && (
									<span className="inline-flex items-center rounded-md border border-border/70 bg-background/70 px-2 py-1 text-xs text-muted-foreground">
										{selectedArm.model}
									</span>
								)}
							</div>
						</div>

						{selectedArmId && (
							<div className="flex items-center gap-3 flex-wrap justify-end">
								<Button
									variant="secondary"
									onPress={() => {
										loadArms();
										if (selectedArmId) {
											loadTodos(selectedArmId);
											loadAnalysis(selectedArmId);
											if (activeTab === "logs") {
												void loadMessages(selectedArmId);
											}
										}
									}}
									isDisabled={loading}
									isIconOnly
								>
									<RefreshCw className="h-4 w-4" />
								</Button>

								{/* Clear history button */}
								{activeTab === "events" && activities.length > 0 && (
									<Button
										variant="ghost"
										size="sm"
										onPress={handleClearHistory}
										aria-label="Clear message history"
									>
										<Trash2 className="h-3 w-3" />
										<span>Clear</span>
									</Button>
								)}

								{/* Stats */}
								{(totalCost > 0 || totalTokens.input > 0) && (
									<div className="flex items-center gap-3 text-xs text-muted-foreground">
										<span className="flex items-center gap-1">
											<Coins className="h-3 w-3" />${totalCost.toFixed(4)}
										</span>
										<span>
											{(
												totalTokens.input + totalTokens.output
											).toLocaleString()}{" "}
											tokens
										</span>
									</div>
								)}

								{/* Connection status */}
								{connected ? (
									<div className="flex items-center gap-1 text-green-500 text-sm">
										<Radio className="h-4 w-4" />
										<span>Live</span>
									</div>
								) : (
									<div className="flex items-center gap-1 text-muted-foreground text-sm">
										<XCircle className="h-4 w-4" />
										<span>Disconnected</span>
									</div>
								)}

								{sessionStatus === "busy" && (
									<div className="flex items-center gap-1 text-yellow-500 text-sm">
										<Loader2 className="h-4 w-4 animate-spin" />
										<span>Working...</span>
									</div>
								)}
							</div>
						)}
					</div>
				</div>

				{error && (
					<div className="p-4 bg-destructive/10 text-destructive border-b border-destructive/20">
						<div className="flex items-center gap-2">
							<AlertTriangle className="h-4 w-4" />
							<span className="text-sm">{error}</span>
						</div>
					</div>
				)}

				{/* Arm Analysis Panel */}
				{selectedArmId && (
					<ArmAnalysisPanel
						analysis={armAnalysis}
						loading={analysisLoading}
						onRefresh={() => loadAnalysis(selectedArmId)}
					/>
				)}

				{/* Tabs */}
				{selectedArmId && (
					<div className="border-b border-border px-4 py-2 bg-muted/5">
						<div className="inline-flex items-center rounded-lg border border-border p-1 gap-1">
							<Button
								size="sm"
								variant={activeTab === "logs" ? "primary" : "ghost"}
								onPress={() => setActiveTab("logs")}
							>
								Logs
							</Button>
							<Button
								size="sm"
								variant={activeTab === "events" ? "primary" : "ghost"}
								onPress={() => setActiveTab("events")}
							>
								Events
							</Button>
						</div>
					</div>
				)}

				{/* Content area */}
				{!selectedArmId ? (
					<div className="flex-1 flex items-center justify-center text-muted-foreground">
						<div className="text-center">
							<Eye className="h-12 w-12 mx-auto mb-4 opacity-50" />
							<p>Select an arm from the left panel to view its activity</p>
						</div>
					</div>
				) : (
					<div className="flex-1 flex overflow-hidden">
						{activeTab === "events" ? (
							<div
								ref={feedContainerRef}
								onScroll={handleFeedScroll}
								className="flex-1 overflow-auto p-4 space-y-2"
							>
								{/* Current text output */}
								{currentText && (
									<div className="bg-secondary/30 rounded-lg p-4 mb-4 border border-border">
										<div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
											<Bot className="h-3 w-3" />
											<span>Assistant is typing...</span>
											<Loader2 className="h-3 w-3 animate-spin ml-auto" />
										</div>
										<div className="text-sm whitespace-pre-wrap max-h-48 overflow-auto">
											{currentText.slice(-1500)}
										</div>
									</div>
								)}

								{/* Activity items */}
								{activities.length === 0 && !currentText ? (
									<div className="text-center text-muted-foreground py-8">
										<p>No activity yet. Send a prompt to start.</p>
									</div>
								) : (
									activities.map((activity) => (
										<ActivityItemComponent
											key={activity.id}
											activity={activity}
											onToggle={() => toggleActivity(activity.id)}
										/>
									))
								)}
							</div>
						) : (
							<div
								ref={feedContainerRef}
								onScroll={handleFeedScroll}
								className="flex-1 overflow-auto p-4 space-y-4"
							>
								{logsError && (
									<div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
										{logsError}
									</div>
								)}

								{logsLoading && messages.length === 0 ? (
									<div className="flex items-center gap-2 text-muted-foreground text-sm">
										<Loader2 className="h-4 w-4 animate-spin" />
										<span>Loading logs...</span>
									</div>
								) : null}

								{messages.length === 0 && !logsLoading ? (
									<div className="text-center text-muted-foreground py-8">
										<p>No message logs yet.</p>
									</div>
								) : (
									messages.map((message) => (
										<MessageLogItem key={message.info.id} message={message} />
									))
								)}
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

function ActivityItemComponent({
	activity,
	onToggle,
}: {
	activity: ActivityItem;
	onToggle: () => void;
}) {
	const colors = activityColors[activity.type];
	const Icon = activityIcons[activity.type];
	const hasDetails =
		activity.details && Object.keys(activity.details).length > 0;

	const statusIcon = {
		pending: <Clock className="h-3 w-3 text-muted-foreground" />,
		running: <Loader2 className="h-3 w-3 animate-spin text-yellow-500" />,
		completed: <CheckCircle2 className="h-3 w-3 text-green-500" />,
		error: <XCircle className="h-3 w-3 text-red-500" />,
		info: null,
	}[activity.status];

	return (
		<div
			className={`rounded-lg border-l-2 ${colors.border} ${colors.bg} overflow-hidden`}
		>
			<Button
				variant="ghost"
				onPress={onToggle}
				isDisabled={!hasDetails}
				className="w-full justify-start h-auto py-2 px-2"
			>
				{hasDetails ? (
					activity.expanded ? (
						<ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" />
					) : (
						<ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0" />
					)
				) : (
					<span className="w-3" />
				)}

				<Icon className={`h-4 w-4 ${colors.icon} flex-shrink-0`} />

				<span className="text-sm font-medium truncate flex-1">
					{activity.title}
				</span>

				{activity.subtitle && (
					<span className="text-xs text-muted-foreground truncate max-w-[40%]">
						{activity.subtitle}
					</span>
				)}

				{statusIcon}

				<span className="text-xs text-muted-foreground flex-shrink-0">
					{formatTime(activity.timestamp)}
				</span>
			</Button>

			{/* Expanded details */}
			{activity.expanded && hasDetails && (
				<div className="px-4 pb-3 pt-1 border-t border-border/50">
					<pre className="text-xs text-muted-foreground overflow-auto max-h-48 whitespace-pre-wrap">
						{formatDetails(activity.details!)}
					</pre>
				</div>
			)}
		</div>
	);
}

function TodoItem({ todo }: { todo: ArmTodo }) {
	const statusIcon = {
		pending: <Clock className="h-4 w-4 text-muted-foreground" />,
		in_progress: <Loader2 className="h-4 w-4 animate-spin text-yellow-500" />,
		completed: <CheckCircle2 className="h-4 w-4 text-green-500" />,
		cancelled: <XCircle className="h-4 w-4 text-muted-foreground" />,
	}[todo.status];

	const priorityColor = {
		high: "border-l-red-500",
		medium: "border-l-yellow-500",
		low: "border-l-green-500",
	}[todo.priority];

	return (
		<div className={`p-3 rounded bg-secondary/50 border-l-2 ${priorityColor}`}>
			<div className="flex items-start gap-2">
				{statusIcon}
				<span
					className={`text-sm flex-1 ${
						todo.status === "completed" || todo.status === "cancelled"
							? "line-through text-muted-foreground"
							: ""
					}`}
				>
					{todo.content}
				</span>
			</div>
		</div>
	);
}

function MessageLogItem({ message }: { message: ArmMessage }) {
	const role = message.info.role;
	const roleLabel =
		role === "assistant" ? "Assistant" : role === "user" ? "User" : "System";
	const roleColor =
		role === "assistant"
			? "text-blue-600"
			: role === "user"
				? "text-emerald-600"
				: "text-amber-600";
	const timestamp = formatMessageTime(message.info.time);

	return (
		<div className="rounded-lg border border-border bg-card p-3">
			<div className="flex items-center justify-between gap-2 mb-2">
				<div
					className={`text-xs uppercase tracking-wide font-semibold ${roleColor}`}
				>
					{roleLabel}
				</div>
				{timestamp && (
					<div className="text-xs text-muted-foreground">{timestamp}</div>
				)}
			</div>

			<div className="space-y-2">
				{message.parts.map((part, index) => {
					if (part.type === "text" && part.text) {
						return (
							<pre
								key={`${message.info.id}-text-${index}`}
								className="text-sm whitespace-pre-wrap font-mono"
							>
								{part.text}
							</pre>
						);
					}

					if (
						(part.type === "tool-invocation" || part.type === "tool") &&
						(part.toolName || part.tool || part.name)
					) {
						const tool = part.toolName || part.tool || part.name || "unknown";
						const details = extractToolDetails(part);
						const state = details.status ? ` [${details.status}]` : "";
						return (
							<div
								key={`${message.info.id}-tool-${index}`}
								className="rounded border border-border/60 bg-muted/20 px-2 py-1"
							>
								<div className="text-xs text-muted-foreground font-mono">
									{`Tool: ${tool}${state}`}
								</div>
								{details.input !== undefined && details.input !== null && (
									<div className="text-[11px] text-muted-foreground font-mono">
										{`input: ${summarizeToolValue(details.input)}`}
									</div>
								)}
								{details.output !== undefined && details.output !== null && (
									<div className="text-[11px] text-muted-foreground font-mono">
										{`output: ${summarizeToolValue(details.output)}`}
									</div>
								)}
								{details.error !== undefined && details.error !== null && (
									<div className="text-[11px] text-destructive font-mono">
										{`error: ${summarizeToolValue(details.error)}`}
									</div>
								)}
								{details.durationMs !== undefined && (
									<div className="text-[11px] text-muted-foreground font-mono">
										{`duration: ${details.durationMs}ms`}
									</div>
								)}
							</div>
						);
					}

					return null;
				})}
			</div>
		</div>
	);
}

function formatMessageTime(timeValue: unknown): string | null {
	if (timeValue === undefined || timeValue === null) {
		return null;
	}

	let raw: unknown = timeValue;
	if (typeof timeValue === "object") {
		const timeObj = timeValue as Record<string, unknown>;
		raw =
			timeObj.completed ??
			timeObj.created ??
			timeObj.updated ??
			timeObj.end ??
			timeObj.start;
	}

	let date: Date | null = null;
	if (typeof raw === "number" && Number.isFinite(raw)) {
		const ms = raw < 1_000_000_000_000 ? raw * 1000 : raw;
		date = new Date(ms);
	} else if (typeof raw === "string") {
		if (/^\d+$/.test(raw)) {
			const parsed = Number.parseInt(raw, 10);
			const ms = parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
			date = new Date(ms);
		} else {
			date = new Date(raw);
		}
	}

	if (!date || Number.isNaN(date.getTime())) {
		return null;
	}

	return date.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

function extractToolDetails(part: ArmMessage["parts"][number]): {
	status?: string;
	input?: unknown;
	output?: unknown;
	error?: unknown;
	durationMs?: number;
} {
	const details: {
		status?: string;
		input?: unknown;
		output?: unknown;
		error?: unknown;
		durationMs?: number;
	} = {};

	if (typeof part.state === "string") {
		details.status = part.state;
	} else if (part.state && typeof part.state === "object") {
		const stateObj = part.state as Record<string, unknown>;
		if (typeof stateObj.status === "string") {
			details.status = stateObj.status;
		}
		if (stateObj.input !== undefined) {
			details.input = stateObj.input;
		}
		if (stateObj.output !== undefined) {
			details.output = stateObj.output;
		}
		if (stateObj.error !== undefined) {
			details.error = stateObj.error;
		}
		if (stateObj.time && typeof stateObj.time === "object") {
			const timeObj = stateObj.time as Record<string, unknown>;
			const start =
				typeof timeObj.start === "number" ? timeObj.start : undefined;
			const end = typeof timeObj.end === "number" ? timeObj.end : undefined;
			if (start !== undefined && end !== undefined && end >= start) {
				details.durationMs = end - start;
			}
		}
	}

	if (details.input === undefined && part.input !== undefined) {
		details.input = part.input;
	}
	if (details.output === undefined && part.output !== undefined) {
		details.output = part.output;
	}
	if (details.output === undefined && part.result !== undefined) {
		details.output = part.result;
	}
	if (details.error === undefined && part.error !== undefined) {
		details.error = part.error;
	}

	return details;
}

function summarizeToolValue(value: unknown): string {
	if (typeof value === "string") {
		return value.length > 220 ? `${value.slice(0, 220)}...` : value;
	}

	try {
		const serialized = JSON.stringify(value);
		if (!serialized) {
			return String(value);
		}
		return serialized.length > 220
			? `${serialized.slice(0, 220)}...`
			: serialized;
	} catch {
		return String(value);
	}
}

// State colors and icons for arm analysis
const stateConfig: Record<
	ArmActivityState,
	{ bg: string; border: string; text: string; icon: typeof Bot }
> = {
	productive: {
		bg: "bg-green-500/20",
		border: "border-green-500",
		text: "text-green-600",
		icon: Zap,
	},
	idle: {
		bg: "bg-blue-500/20",
		border: "border-blue-500",
		text: "text-blue-600",
		icon: Pause,
	},
	waiting_permission: {
		bg: "bg-yellow-500/20",
		border: "border-yellow-500",
		text: "text-yellow-600",
		icon: ShieldQuestion,
	},
	looping: {
		bg: "bg-orange-500/20",
		border: "border-orange-500",
		text: "text-orange-600",
		icon: RefreshCw,
	},
	silent: {
		bg: "bg-gray-500/20",
		border: "border-gray-500",
		text: "text-gray-600",
		icon: CircleDashed,
	},
	error: {
		bg: "bg-red-500/20",
		border: "border-red-500",
		text: "text-red-600",
		icon: AlertOctagon,
	},
	starting: {
		bg: "bg-cyan-500/20",
		border: "border-cyan-500",
		text: "text-cyan-600",
		icon: Play,
	},
};

function ArmAnalysisPanel({
	analysis,
	loading,
	onRefresh,
}: {
	analysis: ArmAnalysisFull | null;
	loading: boolean;
	onRefresh: () => void;
}) {
	if (loading) {
		return (
			<div className="p-4 border-b border">
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<Loader2 className="h-4 w-4 animate-spin" />
					<span>Loading analysis...</span>
				</div>
			</div>
		);
	}

	if (!analysis) {
		return null;
	}

	const state = analysis.analysis.state;
	const config = stateConfig[state];
	const StateIcon = config.icon;

	const trendIcon = analysis.trend.improving ? (
		<TrendingUp className="h-3 w-3 text-green-500" />
	) : analysis.trend.degrading ? (
		<TrendingDown className="h-3 w-3 text-red-500" />
	) : (
		<Minus className="h-3 w-3 text-muted-foreground" />
	);

	const trendLabel = analysis.trend.improving
		? "Improving"
		: analysis.trend.degrading
			? "Degrading"
			: "Stable";

	return (
		<div className={`p-4 border-b border-l-2 ${config.border} ${config.bg}`}>
			<div className="flex items-center justify-between mb-2">
				<div className="flex items-center gap-2">
					<StateIcon className={`h-4 w-4 ${config.text}`} />
					<span className={`font-medium text-sm capitalize ${config.text}`}>
						{state.replace("_", " ")}
					</span>
					<span
						className={`text-xs px-1.5 py-0.5 rounded ${
							analysis.analysis.confidence === "high"
								? "bg-green-500/20 text-green-700"
								: analysis.analysis.confidence === "medium"
									? "bg-yellow-500/20 text-yellow-700"
									: "bg-gray-500/20 text-gray-600"
						}`}
					>
						{analysis.analysis.confidence} confidence
					</span>
				</div>
				<button
					onClick={onRefresh}
					className="text-muted-foreground hover:text-foreground transition-colors"
					aria-label="Refresh analysis"
				>
					<RefreshCw className="h-3 w-3" />
				</button>
			</div>

			<p className="text-xs text-muted-foreground mb-2">
				{analysis.analysis.reason}
			</p>

			{/* Metrics row */}
			<div className="flex items-center gap-4 text-xs text-muted-foreground">
				<span>{analysis.analysis.metrics.eventCount} events</span>
				<span>
					{analysis.analysis.metrics.recentFileEditCount} files edited
				</span>
				<span className="flex items-center gap-1">
					{trendIcon}
					{trendLabel}
				</span>
			</div>

			{/* Permission pending alert */}
			{analysis.analysis.pendingPermission && (
				<div className="mt-3 p-2 bg-yellow-500/10 border border-yellow-500/30 rounded text-xs">
					<div className="flex items-center gap-2 text-yellow-700">
						<ShieldQuestion className="h-3 w-3" />
						<span className="font-medium">Permission requested:</span>
						<span>{analysis.analysis.pendingPermission.action}</span>
					</div>
					{analysis.analysis.pendingPermission.context && (
						<p className="mt-1 text-muted-foreground">
							{analysis.analysis.pendingPermission.context}
						</p>
					)}
				</div>
			)}

			{/* Loop pattern alert */}
			{analysis.analysis.loopPattern && (
				<div className="mt-3 p-2 bg-orange-500/10 border border-orange-500/30 rounded text-xs">
					<div className="flex items-center gap-2 text-orange-700">
						<RefreshCw className="h-3 w-3" />
						<span className="font-medium">Loop detected:</span>
						<span>{analysis.analysis.loopPattern.repetitions} repetitions</span>
					</div>
					<p className="mt-1 text-muted-foreground font-mono">
						{analysis.analysis.loopPattern.pattern.slice(0, 3).join(" → ")}
						{analysis.analysis.loopPattern.pattern.length > 3 && "..."}
					</p>
				</div>
			)}

			{/* Unknown event types warning
      {analysis.analysis.unknownEventTypes.length > 0 && (
        <div className="mt-3 p-2 bg-gray-500/10 border border-gray-500/30 rounded text-xs">
          <div className="flex items-center gap-2 text-gray-600">
            <AlertTriangle className="h-3 w-3" />
            <span>Unknown events: {analysis.analysis.unknownEventTypes.slice(0, 3).join(', ')}</span>
          </div>
        </div>
      )} */}
		</div>
	);
}

function formatTime(timestamp: number): string {
	const date = new Date(timestamp);
	return date.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

function formatDetails(details: Record<string, unknown>): string {
	// Format details for display, handling special cases
	const formatted: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(details)) {
		if (value === undefined || value === null) continue;

		if (key === "output" && typeof value === "string" && value.length > 500) {
			formatted[key] = value.slice(0, 500) + "... (truncated)";
		} else if (key === "input" && typeof value === "object") {
			// Truncate long input values
			const inputObj = value as Record<string, unknown>;
			const truncatedInput: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(inputObj)) {
				if (typeof v === "string" && v.length > 200) {
					truncatedInput[k] = v.slice(0, 200) + "...";
				} else {
					truncatedInput[k] = v;
				}
			}
			formatted[key] = truncatedInput;
		} else if (key === "duration" && typeof value === "number") {
			formatted[key] = `${value}ms`;
		} else {
			formatted[key] = value;
		}
	}

	return JSON.stringify(formatted, null, 2);
}
