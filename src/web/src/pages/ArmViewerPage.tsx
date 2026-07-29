import { Button, Dropdown, Popover, Switch } from "@heroui/react";
import { useEffect, useState, useCallback, useRef, type ReactNode } from "react";
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
	Info,
	SlidersHorizontal,
	MoreHorizontal,
	Server,
} from "lucide-react";
import {
	api,
	cn,
	type JsonObject,
	type JsonValue,
	type Arm,
	type ArmTodo,
	type OpenCodeEvent,
	type ArmAnalysisFull,
	type ArmActivityState,
	type ArmMessage,
	isJsonObject,
} from "@/lib";
import { StatusBadge } from "@/components";
import { useArmEvents, useWebSocket } from "@/hooks";
import {
	useIsWorkspacePanel,
	useWorkspaceOpenRoute,
	useWorkspaceSearchParams,
} from '@/workspace/route-context';
import {
	getViewerEventActivityId,
	upsertViewerActivity,
	type ViewerActivityItem as ActivityItem,
	type ViewerActivityType as ActivityType,
} from "./arm-viewer-activity";
import { ArmActivityChart } from "@/components/ArmActivityChart";
import { ArmContextUsageChart } from "@/components/ArmContextUsageChart";
import { ArmCostUsageChart } from "@/components/ArmCostUsageChart";

function compactJsonObject(entries: Record<string, JsonValue | undefined>): JsonObject {
	const result: JsonObject = {};
	for (const [key, value] of Object.entries(entries)) {
		if (value !== undefined) {
			result[key] = value;
		}
	}
	return result;
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
const MESSAGE_LOG_PREFERENCES_STORAGE_KEY = "coleo-arm-viewer-message-log-preferences";

type MessageLogContentType = "message" | "response" | "thinking" | "tool" | "error";
type BrainActivityCategory =
	| "stuck"
	| "intervention"
	| "task"
	| "session"
	| "health"
	| "decision"
	| "configuration";

interface MessageLogPreferences {
	collapsed: Record<MessageLogContentType, boolean>;
	brainActivity: Record<BrainActivityCategory, boolean>;
}

const DEFAULT_MESSAGE_LOG_PREFERENCES: MessageLogPreferences = {
	collapsed: {
		message: false,
		response: true,
		thinking: true,
		tool: true,
		error: true,
	},
	brainActivity: {
		stuck: true,
		intervention: true,
		task: true,
		session: true,
		health: true,
		decision: true,
		configuration: true,
	},
};

const MESSAGE_LOG_TYPE_OPTIONS: readonly {
	type: MessageLogContentType;
	label: string;
	description: string;
}[] = [
	{ type: "message", label: "Messages", description: "User and system messages" },
	{ type: "response", label: "Responses", description: "Model completion text" },
	{ type: "thinking", label: "Thinking", description: "Model reasoning" },
	{ type: "tool", label: "Tools", description: "Tool calls and results" },
	{ type: "error", label: "Errors", description: "Model and tool failures" },
];

const BRAIN_ACTIVITY_GROUPS: readonly {
	heading: string;
	options: readonly { type: BrainActivityCategory; label: string; description: string }[];
}[] = [
	{
		heading: "Recovery",
		options: [
			{ type: "stuck", label: "Stuck detection", description: "Diagnosis and confidence" },
			{ type: "intervention", label: "Interventions", description: "Interrupts, compaction, and escalation" },
		],
	},
	{
		heading: "Work",
		options: [
			{ type: "task", label: "Task orchestration", description: "Assignment, validation, and completion" },
			{ type: "decision", label: "Brain decisions", description: "Output handling and silent completion" },
		],
	},
	{
		heading: "Runtime",
		options: [
			{ type: "session", label: "Session lifecycle", description: "Spawn, recovery, reset, and status sync" },
			{ type: "health", label: "Health signals", description: "Heartbeat and runtime health" },
			{ type: "configuration", label: "Configuration", description: "Model and budget changes" },
		],
	},
];

function loadMessageLogPreferences(): MessageLogPreferences {
	if (typeof localStorage === "undefined") {
		return DEFAULT_MESSAGE_LOG_PREFERENCES;
	}

	try {
		const stored = localStorage.getItem(MESSAGE_LOG_PREFERENCES_STORAGE_KEY);
		if (!stored) {
			return DEFAULT_MESSAGE_LOG_PREFERENCES;
		}

		const parsed = JSON.parse(stored);
		if (!isJsonObject(parsed) || !isJsonObject(parsed.collapsed)) {
			return DEFAULT_MESSAGE_LOG_PREFERENCES;
		}

		const collapsed = { ...DEFAULT_MESSAGE_LOG_PREFERENCES.collapsed };
		for (const { type } of MESSAGE_LOG_TYPE_OPTIONS) {
			const value = parsed.collapsed[type];
			if (typeof value === "boolean") {
				collapsed[type] = value;
			}
		}
		const brainActivity = { ...DEFAULT_MESSAGE_LOG_PREFERENCES.brainActivity };
		if (isJsonObject(parsed.brainActivity)) {
			for (const group of BRAIN_ACTIVITY_GROUPS) {
				for (const { type } of group.options) {
					const value = parsed.brainActivity[type];
					if (typeof value === "boolean") {
						brainActivity[type] = value;
					}
				}
			}
		}

		return { collapsed, brainActivity };
	} catch {
		return DEFAULT_MESSAGE_LOG_PREFERENCES;
	}
}

function getBrainActivityCategory(activity: ActivityItem): BrainActivityCategory | null {
	if (!activity.details || activity.details.actor !== "brain") {
		return null;
	}

	const eventType = typeof activity.details.eventType === "string"
		? activity.details.eventType
		: activity.title.toLowerCase().replaceAll(" ", "_");
	if (eventType.includes("stuck_detected")) return "stuck";
	if (
		eventType.includes("unstuck") ||
		eventType.includes("idle_arm_stuck") ||
		eventType.includes("zombie") ||
		eventType.includes("stuck_escalated")
	) return "intervention";
	if (
		eventType.includes("task_") ||
		eventType.includes("validation") ||
		eventType.includes("verification") ||
		eventType.includes("blocked_task")
	) return "task";
	if (
		eventType.includes("silent_completion") ||
		eventType.includes("arm_output_action")
	) return "decision";
	if (
		eventType.includes("heartbeat") ||
		eventType.includes("health") ||
		eventType.includes("infrastructure_alert")
	) return "health";
	if (
		eventType.includes("config") ||
		eventType.includes("budget") ||
		eventType.includes("model")
	) return "configuration";
	if (
		eventType.includes("arm_detected") ||
		eventType.includes("arm_initialized") ||
		eventType.includes("arm_waiting") ||
		eventType.includes("status_synced") ||
		eventType.includes("session")
	) return "session";

	return null;
}

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

const HANDLED_EVENT_TYPES = new Set([
	"connected",
	"arm.heartbeat",
	"server-heartbeat",
	"server.heartbeat",
	"message.updated",
	"message.part.updated",
	"message.part.created",
	"file.edited",
	"session.status",
	"session.error",
	"todo.updated",
	"pty.created",
	"pty.updated",
	"pty.exited",
	"vcs.branch.updated",
	"lsp.client.diagnostics",
]);

const SESSION_STATUS_LABELS: Record<string, string> = {
	busy: "Working",
	idle: "Idle",
	retry: "Retrying",
	unknown: "Checking",
};

function formatViewerSessionStatus(status: string): string {
	return (
		SESSION_STATUS_LABELS[status] ??
		status.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase())
	);
}

function formatStatusLayerLabel(value: string): string {
	return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function getViewerStatusNarrative({
	armStatus,
	analysisState,
	sessionLabel,
	connected,
}: {
	armStatus: string;
	analysisState: ArmActivityState | null;
	sessionLabel: string;
	connected: boolean;
}): string {
	const lifecycle = formatStatusLayerLabel(armStatus);
	const session = sessionLabel.toLowerCase();

	if (analysisState === "silent") {
		return `${lifecycle} arm, no recent output; session is ${session}.`;
	}

	if (analysisState === "waiting_permission") {
		return `${lifecycle} arm, waiting on a human decision.`;
	}

	if (analysisState === "productive") {
		return `${lifecycle} arm with recent productive activity.`;
	}

	if (analysisState === "looping") {
		return `${lifecycle} arm may be repeating work.`;
	}

	if (analysisState === "error") {
		return `${lifecycle} arm needs attention.`;
	}

	if (!connected) {
		return `${lifecycle} arm; live stream is disconnected.`;
	}

	return `${lifecycle} arm; session is ${session}.`;
}

function formatAnalysisReason(reason: string): string {
	if (reason.includes("Infinity")) {
		return "No recent events in the current analysis window.";
	}

	return reason;
}

function formatCompactNumber(value: number): string {
	return new Intl.NumberFormat("en-US", {
		notation: value >= 1000 ? "compact" : "standard",
		maximumFractionDigits: 1,
	}).format(value);
}

export function ArmViewerPage() {
	const isWorkspacePanel = useIsWorkspacePanel();
	const openWorkspaceRoute = useWorkspaceOpenRoute();
	const [searchParams, setSearchParams] = useWorkspaceSearchParams();
	const selectedArmId = searchParams.get("arm");

	const [arms, setArms] = useState<Arm[]>([]);
	const [activities, setActivities] = useState<ActivityItem[]>([]);
	const [, setTodos] = useState<ArmTodo[]>([]);
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
	const [summaryExpanded, setSummaryExpanded] = useState(false);
	const [messages, setMessages] = useState<ArmMessage[]>([]);
	const [messageLogPreferences, setMessageLogPreferences] = useState(loadMessageLogPreferences);
	const [logsLoading, setLogsLoading] = useState(false);
	const [logsError, setLogsError] = useState<string | null>(null);
	const [logsLoadedArmId, setLogsLoadedArmId] = useState<string | null>(null);
	const [eventsLoading, setEventsLoading] = useState(false);
	const [markingStuck, setMarkingStuck] = useState(false);

	const feedContainerRef = useRef<HTMLDivElement>(null);
	const workspaceContainerRef = useRef<HTMLDivElement>(null);
	const autoScrollEnabledRef = useRef(true);
	const lastLogsRefreshAt = useRef(0);
	const messageRequestId = useRef(0);
	const selectedArmIdRef = useRef(selectedArmId);
	const activeTabRef = useRef(activeTab);
	const [workspaceWidth, setWorkspaceWidth] = useState(0);
	selectedArmIdRef.current = selectedArmId;
	activeTabRef.current = activeTab;

	const setMessageLogTypeCollapsed = useCallback(
		(type: MessageLogContentType, collapsed: boolean) => {
			setMessageLogPreferences((previous) => {
				const next = {
					...previous,
					collapsed: { ...previous.collapsed, [type]: collapsed },
				};
				try {
					localStorage.setItem(MESSAGE_LOG_PREFERENCES_STORAGE_KEY, JSON.stringify(next));
				} catch {
					// Keep the in-memory preference when storage is unavailable.
				}
				return next;
			});
		},
		[],
	);

	const setBrainActivityVisible = useCallback(
		(type: BrainActivityCategory, visible: boolean) => {
			setMessageLogPreferences((previous) => {
				const next = {
					...previous,
					brainActivity: { ...previous.brainActivity, [type]: visible },
				};
				try {
					localStorage.setItem(MESSAGE_LOG_PREFERENCES_STORAGE_KEY, JSON.stringify(next));
				} catch {
					// Keep the in-memory preference when storage is unavailable.
				}
				return next;
			});
		},
		[],
	);

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

	// Add or update activity
	const upsertActivity = useCallback(
		(
			id: string,
			updates: Partial<ActivityItem> & { type: ActivityType; title: string },
		) => {
			setActivities((previous) =>
				upsertViewerActivity(
					previous,
					{
						id,
						status: "info",
						timestamp: Date.now(),
						expanded: false,
						...updates,
					},
					MAX_HISTORY_ITEMS,
				),
			);
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

	const updateContextBudget = useCallback(async (armId: string, contextBudget: number) => {
		const response = await api.updateArm(armId, { contextBudget });
		setArms((previous) =>
			previous.map((arm) => (arm.id === armId ? response.arm : arm)),
		);
	}, []);

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
	const loadAnalysis = useCallback(async (armId: string, silent = false) => {
		if (!silent) setAnalysisLoading(true);
		try {
			const res = await api.getArmAnalysis(armId);
			if (selectedArmIdRef.current === armId) setArmAnalysis(res);
		} catch (err) {
			// Analysis might not be available if NATS isn't running
			console.error("Failed to load analysis:", err);
			if (selectedArmIdRef.current === armId) setArmAnalysis(null);
		} finally {
			if (!silent && selectedArmIdRef.current === armId) setAnalysisLoading(false);
		}
	}, []);

	const loadSessionState = useCallback(async (armId: string) => {
		try {
			const response = await api.getArmState(armId);
			if (selectedArmIdRef.current !== armId) return;
			const normalizedSessionStatus =
				response.state === "processing" || response.state === "executing"
					? "busy"
					: response.state;
			setSessionStatus(normalizedSessionStatus);
			const normalizedArmStatus: Arm["status"] =
				normalizedSessionStatus === "busy" || normalizedSessionStatus === "retry"
					? "busy"
					: normalizedSessionStatus === "idle" ||
						  normalizedSessionStatus === "starting" ||
						  normalizedSessionStatus === "error" ||
						  normalizedSessionStatus === "stopped"
						? normalizedSessionStatus
						: "running";
			setArms((previous) =>
				previous.map((arm) =>
					arm.id === armId && arm.status !== normalizedArmStatus
						? { ...arm, status: normalizedArmStatus }
						: arm,
				),
			);
		} catch {
			// Live events and arm lifecycle status remain available as fallbacks.
		}
	}, []);

	const loadMessages = useCallback(async (armId: string, silent = false) => {
		const requestId = ++messageRequestId.current;
		if (!silent) {
			setLogsLoading(true);
		}
		try {
			let res = await api.getArmMessages(armId, 200);
			let retriedWithSmallerLimit = false;
			if (res.error?.includes("Response too large for NATS")) {
				for (const limit of [50, 10]) {
					retriedWithSmallerLimit = true;
					res = await api.getArmMessages(armId, limit);
					if (!res.error?.includes("Response too large for NATS")) {
						break;
					}
				}
			}
			if (!silent && !retriedWithSmallerLimit && (res.messages?.length || 0) === 0 && !res.error) {
				await new Promise((resolve) => setTimeout(resolve, 500));
				res = await api.getArmMessages(armId, 200);
			}
			if (requestId !== messageRequestId.current || selectedArmIdRef.current !== armId) return;
			const nextMessages = res.messages || [];
			setMessages((previous) =>
				silent && nextMessages.length === 0 && previous.length > 0 ? previous : nextMessages,
			);
			if (nextMessages.length > 0) {
				let input = 0;
				let output = 0;
				let cost = 0;
				for (const message of nextMessages) {
					input += message.info.tokens?.input || 0;
					output += message.info.tokens?.output || 0;
					cost += message.info.cost || 0;
				}
				setTotalTokens({ input, output });
				setTotalCost(cost);
			}
			setLogsLoadedArmId(armId);
			setLogsError(res.error || null);
		} catch (err) {
			if (requestId !== messageRequestId.current || selectedArmIdRef.current !== armId) return;
			setLogsError(
				err instanceof Error ? err.message : "Failed to load message logs",
			);
		} finally {
			if (!silent && requestId === messageRequestId.current && selectedArmIdRef.current === armId) {
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
		(event: OpenCodeEvent, options?: { historical?: boolean }) => {
			const { type, properties: props } = event;
			const parsedTimestamp = event.timestamp ? new Date(event.timestamp).getTime() : Date.now();
			const eventTimestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now();
			const eventActivityId = (suffix: string) => getViewerEventActivityId(event, suffix);
			const recordActivity = (
				id: string,
				updates: Partial<ActivityItem> & { type: ActivityType; title: string },
			) => upsertActivity(id, { timestamp: eventTimestamp, ...updates });

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
					recordActivity(`msg-${info.id}`, {
						type: "message",
						title: `${roleLabel} message`,
						status: "running",
						details: { role, messageId: info.id },
					});
				}
				if (
					!options?.historical &&
					selectedArmIdRef.current &&
					activeTabRef.current === "logs"
				) {
					refreshMessagesThrottled(selectedArmIdRef.current);
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
								input?: JsonObject;
								output?: string;
								error?: string;
								time?: { start: number; end: number };
							};
					  }
					| undefined;
				const delta = typeof props.delta === "string" ? props.delta : undefined;

				if (part) {
					// Text content - use delta for updates, full text for creates
					if (!options?.historical && part.type === "text") {
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
						const toolId = part.id || eventActivityId("tool");

						let actStatus: ActivityItem["status"] = "pending";
						if (status === "running") actStatus = "running";
						else if (status === "completed") actStatus = "completed";
						else if (status === "error") actStatus = "error";

							recordActivity(toolId, {
								type: "tool",
								title: title,
								subtitle: part.tool,
								status: actStatus,
								details: compactJsonObject({
									tool: part.tool,
									input: state?.input,
									output: state?.output,
									error: state?.error,
									duration: state?.time
										? state.time.end - state.time.start
										: undefined,
								}),
							});
						}

					// Step finish - contains cost/token info
					if (part.type === "step-finish") {
						const stepPart = part as {
							cost?: number;
							tokens?: {
								input: number;
								output: number;
								reasoning?: number;
								cache?: { read: number; write: number };
							};
							reason?: string;
						};

						if (!options?.historical && stepPart.cost) {
							setTotalCost((prev) => prev + stepPart.cost!);
						}
						if (!options?.historical && stepPart.tokens) {
							setTotalTokens((prev) => ({
								input: prev.input + stepPart.tokens!.input,
								output: prev.output + stepPart.tokens!.output,
							}));
						}

							recordActivity(eventActivityId("step"), {
								type: "step",
								title: "Step completed",
								subtitle: stepPart.reason || "done",
								status: "completed",
								details: compactJsonObject({
									cost: stepPart.cost,
									tokens: stepPart.tokens,
								}),
							});
						}

					// File parts
					if (part.type === "file") {
						const filePart = part as {
							filename?: string;
							mime?: string;
						};
						recordActivity(eventActivityId("file"), {
							type: "file",
							title: filePart.filename || "File",
							subtitle: filePart.mime,
							status: "info",
						});
					}

					if (
						!options?.historical &&
						selectedArmIdRef.current &&
						activeTabRef.current === "logs"
					) {
						refreshMessagesThrottled(selectedArmIdRef.current);
					}
				}
			}

			// File edited
			if (type === "file.edited") {
				const file = typeof props.file === "string" ? props.file : undefined;
				if (file) {
					recordActivity(eventActivityId("file-edited"), {
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
					if (!options?.historical) {
						setSessionStatus(status.type);
					}

					if (!options?.historical && status.type === "idle") {
						// Mark all running activities as completed
						setActivities((prev) =>
							prev.map((a) =>
								a.status === "running" ? { ...a, status: "completed" } : a,
							),
						);
						setCurrentText("");

						// Refresh todos
						if (selectedArmIdRef.current) {
							void loadTodos(selectedArmIdRef.current);
							refreshMessagesThrottled(selectedArmIdRef.current);
						}
					} else if (status.type === "busy") {
						recordActivity("session-busy", {
							type: "session",
							title: "Processing",
							status: "running",
						});
					} else if (status.type === "retry") {
						recordActivity(eventActivityId("retry"), {
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
					recordActivity(eventActivityId("error"), {
						type: "error",
						title: "Error",
						subtitle: message,
						status: "error",
						details: compactJsonObject({ error }),
					});
				}

				// Todo updates - only update if this is for the currently selected arm
				if (type === "todo.updated") {
					const todos = Array.isArray(props.todos) ? (props.todos as unknown as ArmTodo[]) : undefined;
				if (todos) {
					// Only update todos if the event is from the currently selected arm
					// The SSE connection should already be filtered by arm, but this adds extra safety
					if (!options?.historical) {
						setTodos(todos);
					}
					recordActivity("todos-updated", {
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
				const ptyId = typeof props.id === "string" ? props.id : undefined;
				recordActivity(ptyId ? `pty-${ptyId}` : eventActivityId("pty"), {
					type: "terminal",
					title: "Terminal",
					subtitle: type === "pty.created" ? "Created" : "Updated",
					status: type === "pty.created" ? "running" : "info",
				});
			}

			if (type === "pty.exited") {
				const ptyId = typeof props.id === "string" ? props.id : undefined;
				const code = typeof props.code === "number" ? props.code : undefined;
				recordActivity(ptyId ? `pty-${ptyId}` : eventActivityId("pty-exited"), {
					type: "terminal",
					title: "Terminal exited",
					subtitle: `Exit code: ${code}`,
					status: code === 0 ? "completed" : "error",
				});
			}

			// VCS branch
			if (type === "vcs.branch.updated") {
				const branch = typeof props.branch === "string" ? props.branch : undefined;
				recordActivity(eventActivityId("branch"), {
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
					recordActivity(eventActivityId("diagnostics"), {
						type: errorCount > 0 ? "error" : "session",
						title: "Diagnostics",
						subtitle: `${errorCount} errors, ${warnCount} warnings`,
						status: errorCount > 0 ? "error" : "info",
					});
				}
			}

			if (!HANDLED_EVENT_TYPES.has(type)) {
				recordActivity(eventActivityId("generic"), {
					type: "session",
					title: formatStatusLayerLabel(type),
					status: "info",
					details: { ...props, eventType: type },
				});
			}
		},
		[refreshMessagesThrottled, upsertActivity],
	);

	const loadEvents = useCallback(
		async (armId: string) => {
			setEventsLoading(true);
			try {
				const response = await api.getArmEventWindow(armId, {
					windowMs: 30 * 60 * 1000,
					limit: 200,
				});
				if (selectedArmIdRef.current !== armId) return;
				const historyWatermark = response.summary.lastEventAt
					? new Date(response.summary.lastEventAt).getTime()
					: null;
				if (historyWatermark !== null && Number.isFinite(historyWatermark)) {
					setActivities((previous) =>
						previous.filter((activity) => activity.timestamp > historyWatermark),
					);
				}
				for (const event of response.window.events) {
					handleArmEvent(
						{
							type: event.type,
							properties: event.data,
							timestamp: event.timestamp,
							sequence: event.sequence,
						},
						{ historical: true },
					);
				}
			} catch (err) {
				console.error("Failed to load event history:", err);
			} finally {
				if (selectedArmIdRef.current === armId) setEventsLoading(false);
			}
		},
		[handleArmEvent],
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
			messageRequestId.current++;
			setLogsLoadedArmId(null);
			setMessages([]);
			setLogsError(null);
			setArmAnalysis(null);
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
			} else {
				// No saved history - start fresh
				setActivities([]);
				setTodos([]);
				setSessionStatus("unknown");
				setCurrentText("");
				setTotalCost(0);
				setTotalTokens({ input: 0, output: 0 });
			}
			// Always fetch fresh runtime data for the selected arm.
			void loadTodos(selectedArmId);
			void loadAnalysis(selectedArmId);
			void loadSessionState(selectedArmId);
			void loadEvents(selectedArmId);
			void loadMessages(selectedArmId);
		} else {
			// Clear analysis when no arm selected
			setArmAnalysis(null);
			setMessages([]);
			setLogsLoadedArmId(null);
			setLogsError(null);
		}
	}, [loadAnalysis, loadEvents, loadMessages, loadSessionState, selectedArmId]);

	// Refresh text logs while viewing the Logs tab
	useEffect(() => {
		if (!selectedArmId || activeTab !== "logs") {
			return;
		}

		const interval = setInterval(() => {
			void loadMessages(selectedArmId, true);
		}, 3000);

		return () => clearInterval(interval);
	}, [activeTab, loadMessages, selectedArmId]);

	useEffect(() => {
		if (!selectedArmId) return;
		const interval = setInterval(() => {
			void loadAnalysis(selectedArmId, true);
			void loadSessionState(selectedArmId);
		}, 10_000);
		return () => clearInterval(interval);
	}, [loadAnalysis, loadSessionState, selectedArmId]);

	useEffect(() => {
		if (!selectedArmId) return;
		const timeout = setTimeout(() => {
			try {
				const history: ArmHistoryState = {
					activities: activities.slice(-MAX_HISTORY_ITEMS),
					todos: [],
					currentText,
					totalCost,
					totalTokens,
					sessionStatus,
					lastUpdated: Date.now(),
				};
				localStorage.setItem(getStorageKey(selectedArmId), JSON.stringify(history));
			} catch {
				// Storage is a best-effort bridge until persisted event history loads.
			}
		}, 500);
		return () => clearTimeout(timeout);
	}, [activities, currentText, selectedArmId, sessionStatus, totalCost, totalTokens]);

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

	useEffect(() => {
		if (!isWorkspacePanel || !workspaceContainerRef.current) {
			return;
		}

		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (entry) {
				setWorkspaceWidth(entry.contentRect.width);
			}
		});

		observer.observe(workspaceContainerRef.current);
		return () => observer.disconnect();
	}, [isWorkspacePanel]);

	const selectArm = (armId: string) => {
		if (!isWorkspacePanel) {
			setSearchParams({ arm: armId });
			return;
		}

		openWorkspaceRoute(
			{
				pathname: "/viewer",
				search: `?arm=${encodeURIComponent(armId)}`,
			},
			workspaceWidth >= 920 ? "split" : "tab",
		);
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
		}
	}, [selectedArmId]);

	const toggleActivity = (id: string) => {
		setActivities((prev) =>
			prev.map((a) => (a.id === id ? { ...a, expanded: !a.expanded } : a)),
		);
	};

	const selectedArm = arms.find((a) => a.id === selectedArmId);
	const handleMarkStuck = async () => {
		if (!selectedArm) return;
		setMarkingStuck(true);
		try {
			const { arm: updatedArm } = await api.markArmStuck(selectedArm.id);
			setArms((previous) =>
				previous.map((current) => (current.id === updatedArm.id ? updatedArm : current)),
			);
			await loadArms();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to mark arm stuck");
		} finally {
			setMarkingStuck(false);
		}
	};
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

	if (isWorkspacePanel) {
		if (!selectedArmId) {
			return (
				<div ref={workspaceContainerRef} className="flex h-full min-h-0 flex-col bg-background">
					<div className="border-b border-border px-5 py-5">
						<div className="flex items-start justify-between gap-4">
							<div>
								<p className="text-[0.72rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
									Arm Viewer
								</p>
								<h1 className="mt-2 text-3xl font-semibold tracking-tight">
									Select an active arm
								</h1>
								<p className="mt-1 text-sm text-muted-foreground">
									Open a live console to inspect session output, state changes, and recent activity.
								</p>
							</div>

							<Button
								variant="ghost"
								onPress={loadArms}
								isIconOnly
								size="sm"
								aria-label="Refresh"
							>
								<RefreshCw className="h-4 w-4" />
							</Button>
						</div>
					</div>

					<div className="border-b border-border px-5 py-3 text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
						{arms.length} active arm{arms.length === 1 ? "" : "s"}
					</div>

					<ArmSelectorPanel
						arms={arms}
						selectedArmId={selectedArmId}
						onSelectArm={selectArm}
						emptyTitle="No active arms"
						emptyDescription="Spawn an arm to open a viewer session."
						className="flex-1"
					/>
				</div>
			);
		}

		return (
			<div ref={workspaceContainerRef} className="h-full">
				<ArmViewerConsole
					selectedArm={selectedArm}
					selectedWorkItem={selectedWorkItem}
					workItemType={workItemType}
					activeTab={activeTab}
					onTabChange={setActiveTab}
					summaryExpanded={summaryExpanded}
					onSummaryExpandedChange={setSummaryExpanded}
					connected={connected}
					sessionStatus={sessionStatus}
					error={error}
					totalCost={totalCost}
					totalTokens={totalTokens}
					activities={activities}
					currentText={currentText}
					messages={messages}
					messageLogPreferences={messageLogPreferences}
					onMessageLogTypeCollapsedChange={setMessageLogTypeCollapsed}
					onBrainActivityVisibleChange={setBrainActivityVisible}
					onContextBudgetChange={updateContextBudget}
					logsLoading={logsLoading}
					logsReady={logsLoadedArmId === selectedArm?.id}
					logsError={logsError}
					eventsLoading={eventsLoading}
					analysis={armAnalysis}
					analysisLoading={analysisLoading}
					onRefresh={() => {
						loadArms();
						if (selectedArmId) {
							loadTodos(selectedArmId);
							loadAnalysis(selectedArmId);
							if (activeTab === "logs") {
								void loadMessages(selectedArmId);
							}
						}
					}}
					onRefreshAnalysis={() => {
						if (selectedArmId) {
							loadAnalysis(selectedArmId);
						}
					}}
					onClearHistory={handleClearHistory}
					onMarkStuck={handleMarkStuck}
					markingStuck={markingStuck}
					feedContainerRef={feedContainerRef}
					onFeedScroll={handleFeedScroll}
					onToggleActivity={toggleActivity}
				/>
			</div>
		);
	}

	return (
		<div className="flex h-full">
			{/* Left Panel - Arm selector */}
			{viewerExpanded ? null : (
				<div
					className="flex shrink-0 flex-col border-r border-border bg-background"
					style={{ width: panelWidth }}
				>
					<div className="border-b border-border px-4 py-4">
						<div className="flex items-center justify-between gap-3">
							<div>
								<p className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
									Arm Viewer
								</p>
								<h2 className="mt-2 text-lg font-semibold tracking-tight">Active Arms</h2>
							</div>
							<Button
								variant="ghost"
								onPress={() => setViewerExpanded(true)}
								aria-label="Collapse arm selector"
								isIconOnly
								size="sm"
							>
								<Minimize2 className="h-4 w-4" />
							</Button>
						</div>
					</div>

					<ArmSelectorPanel
						arms={arms}
						selectedArmId={selectedArmId}
						onSelectArm={selectArm}
						emptyTitle="No active arms"
						emptyDescription="Spawn an arm to inspect its live console."
						className="flex-1"
					/>
				</div>
			)}

			{/* Resizable divider */}
			{viewerExpanded ? null : (
				<div
					className="w-px bg-border hover:bg-accent/30 cursor-col-resize transition-colors"
					onMouseDown={() => setIsResizing(true)}
				/>
			)}

			{/* Right Panel - Activity viewer */}
			<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
				{viewerExpanded ? (
					<div className="border-b border-border px-4 py-3">
						<Button
							variant="ghost"
							onPress={() => setViewerExpanded(false)}
							aria-label="Expand arm selector"
							size="sm"
						>
							<Maximize2 className="h-4 w-4" />
							Show Arms
						</Button>
					</div>
				) : null}

				<ArmViewerConsole
					selectedArm={selectedArm}
					selectedWorkItem={selectedWorkItem}
					workItemType={workItemType}
					activeTab={activeTab}
					onTabChange={setActiveTab}
					summaryExpanded={summaryExpanded}
					onSummaryExpandedChange={setSummaryExpanded}
					connected={connected}
					sessionStatus={sessionStatus}
					error={error}
					totalCost={totalCost}
					totalTokens={totalTokens}
					activities={activities}
					currentText={currentText}
					messages={messages}
					messageLogPreferences={messageLogPreferences}
					onMessageLogTypeCollapsedChange={setMessageLogTypeCollapsed}
					onBrainActivityVisibleChange={setBrainActivityVisible}
					onContextBudgetChange={updateContextBudget}
					logsLoading={logsLoading}
					logsReady={logsLoadedArmId === selectedArm?.id}
					logsError={logsError}
					eventsLoading={eventsLoading}
					analysis={armAnalysis}
					analysisLoading={analysisLoading}
					onRefresh={() => {
						loadArms();
						if (selectedArmId) {
							loadTodos(selectedArmId);
							loadAnalysis(selectedArmId);
							if (activeTab === "logs") {
								void loadMessages(selectedArmId);
							}
						}
					}}
					onRefreshAnalysis={() => {
						if (selectedArmId) {
							loadAnalysis(selectedArmId);
						}
					}}
					onClearHistory={handleClearHistory}
					onMarkStuck={handleMarkStuck}
					markingStuck={markingStuck}
					feedContainerRef={feedContainerRef}
					onFeedScroll={handleFeedScroll}
					onToggleActivity={toggleActivity}
				/>
			</div>
		</div>
	);
}

function ArmSelectorPanel({
	arms,
	selectedArmId,
	onSelectArm,
	emptyTitle,
	emptyDescription,
	className,
}: {
	arms: Arm[];
	selectedArmId: string | null;
	onSelectArm: (armId: string) => void;
	emptyTitle: string;
	emptyDescription: string;
	className?: string;
}) {
	return (
		<div className={cn("min-h-0 overflow-auto p-3", className)}>
			{arms.length === 0 ? (
				<div className="flex h-full min-h-[240px] items-center justify-center rounded-md border border-dashed border-border bg-surface-secondary/35 px-6 text-center">
					<div>
						<Eye className="mx-auto mb-4 h-10 w-10 text-muted-foreground/60" />
						<p className="text-sm font-medium">{emptyTitle}</p>
						<p className="mt-1 text-sm text-muted-foreground">{emptyDescription}</p>
					</div>
				</div>
			) : (
				<div className="space-y-2">
					{arms.map((arm) => {
						const isSelected = selectedArmId === arm.id;
						const summary =
							arm.currentTaskSubject ?? arm.currentBugTitle ?? arm.harness;

						return (
							<button
								key={arm.id}
								type="button"
								className={cn(
									"w-full rounded-md border px-3 py-3 text-left transition-colors",
									isSelected
										? "border-accent/45 bg-accent/8"
										: "border-border bg-card hover:bg-surface-secondary/55",
								)}
								onClick={() => onSelectArm(arm.id)}
							>
								<div className="flex items-start justify-between gap-3">
									<div className="min-w-0">
										<div className="flex items-center gap-2">
											<span
												className={cn(
													"h-2 w-2 rounded-full",
													arm.status === "running"
														? "bg-success"
														: arm.status === "starting"
															? "bg-warning"
															: arm.status === "error"
																? "bg-danger"
																: "bg-muted-foreground/60",
												)}
											/>
											<div className="truncate text-sm font-medium">{arm.name}</div>
										</div>
										<div className="mt-1 truncate text-xs text-muted-foreground">
											{summary}
										</div>
										<div className="mt-2 flex flex-wrap items-center gap-2 text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
											<span>{arm.harness}</span>
											{arm.provider ? <span>{arm.provider}</span> : null}
										</div>
									</div>

									<StatusBadge status={arm.status} />
								</div>
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}

function ArmViewerConsole({
	selectedArm,
	selectedWorkItem,
	workItemType,
	activeTab,
	onTabChange,
	summaryExpanded,
	onSummaryExpandedChange,
	connected,
	sessionStatus,
	error,
	totalCost,
	totalTokens,
	activities,
	currentText,
	messages,
	messageLogPreferences,
	onMessageLogTypeCollapsedChange,
	onBrainActivityVisibleChange,
	onContextBudgetChange,
	logsLoading,
	logsReady,
	logsError,
	eventsLoading,
	analysis,
	analysisLoading,
	onRefresh,
	onRefreshAnalysis,
	onClearHistory,
	onMarkStuck,
	markingStuck,
	feedContainerRef,
	onFeedScroll,
	onToggleActivity,
}: {
	selectedArm?: Arm;
	selectedWorkItem: string | null;
	workItemType: "bug" | "task" | null;
	activeTab: ViewerTab;
	onTabChange: (tab: ViewerTab) => void;
	summaryExpanded: boolean;
	onSummaryExpandedChange: (expanded: boolean) => void;
	connected: boolean;
	sessionStatus: string;
	error: string | null;
	totalCost: number;
	totalTokens: { input: number; output: number };
	activities: ActivityItem[];
	currentText: string;
	messages: ArmMessage[];
	messageLogPreferences: MessageLogPreferences;
	onMessageLogTypeCollapsedChange: (type: MessageLogContentType, collapsed: boolean) => void;
	onBrainActivityVisibleChange: (type: BrainActivityCategory, visible: boolean) => void;
	onContextBudgetChange: (armId: string, contextBudget: number) => Promise<void>;
	logsLoading: boolean;
	logsReady: boolean;
	logsError: string | null;
	eventsLoading: boolean;
	analysis: ArmAnalysisFull | null;
	analysisLoading: boolean;
	onRefresh: () => void;
	onRefreshAnalysis: () => void;
	onClearHistory: () => void;
	onMarkStuck: () => void;
	markingStuck: boolean;
	feedContainerRef: { current: HTMLDivElement | null };
	onFeedScroll: () => void;
	onToggleActivity: (id: string) => void;
}) {
	const arm = selectedArm ?? null;
	const sessionLabel = formatViewerSessionStatus(sessionStatus);
	const hasEventTelemetry = (analysis?.analysis.metrics.eventCount || 0) > 0;
	const analysisState = hasEventTelemetry
		? analysis?.analysis.state.replaceAll("_", " ") ?? null
		: null;
	const totalTokenCount = totalTokens.input + totalTokens.output;
	const focusedBrainActivities = activities.filter((activity) => {
		const category = getBrainActivityCategory(activity);
		return category !== null && messageLogPreferences.brainActivity[category];
	});
	const focusedActivityItems = [
		...messages.map((message) => ({
			kind: "message" as const,
			message,
			timestamp: getMessageTimestamp(message.info.time) ?? 0,
		})),
		...focusedBrainActivities.map((activity) => ({
			kind: "brain" as const,
			activity,
			timestamp: activity.timestamp,
		})),
	].sort((left, right) => left.timestamp - right.timestamp);
	const streamCount = activeTab === "logs" ? focusedActivityItems.length : activities.length;
	const streamValue = activeTab === "logs" && !logsReady
		? "Loading focused activity"
		: `${formatCompactNumber(streamCount)} ${activeTab === "logs" ? "focused" : "events"}`;
	const activityStateTone =
		hasEventTelemetry && analysis?.analysis.state === "error"
			? "danger"
			: hasEventTelemetry &&
					(analysis?.analysis.state === "waiting_permission" ||
						analysis?.analysis.state === "starting")
				? "warning"
				: hasEventTelemetry && analysis?.analysis.state === "productive"
					? "success"
					: "neutral";
	const sessionTone =
		sessionStatus === "busy" ? "warning" : connected ? "success" : "neutral";
	const compactSummary = true;
	const statusNarrative = arm
		? getViewerStatusNarrative({
				armStatus: arm.status,
				analysisState: hasEventTelemetry ? analysis?.analysis.state ?? null : null,
				sessionLabel,
				connected,
			})
		: null;

	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			<div className="border-b border-border px-5 py-3">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="min-w-0 flex-1">
						{arm ? (
							<div className="flex min-w-0 items-center gap-3">
								<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface-secondary text-accent">
									<Bot className="h-4 w-4" />
								</div>
								<div className="min-w-0">
									<div className="flex min-w-0 flex-wrap items-center gap-2">
										<h1 className="truncate text-xl font-semibold tracking-tight">
											{arm.name}
										</h1>
										<StatusBadge status={arm.status} />
									</div>
									<div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
										<span className="truncate">
											{arm.provider ? `${arm.provider}${arm.model ? ` / ${arm.model}` : ""}` : arm.model ?? "Arm console"}
										</span>
										<span className="h-1 w-1 rounded-full bg-muted-foreground/40" />
										<span className="inline-flex items-center gap-1.5">
											<span className={cn("h-1.5 w-1.5 rounded-full", connected ? "bg-success" : "bg-danger")} />
											{connected ? "Live" : "Offline"}
										</span>
										{arm.recoveryRequestedAt ? (
											<span className="inline-flex items-center gap-1 text-warning">
												<AlertTriangle className="h-3 w-3" />
												Recovery requested
											</span>
										) : null}
									</div>
								</div>
							</div>
						) : (
							<div className="mt-3">
								<h1 className="text-2xl font-semibold tracking-tight">Arm Viewer</h1>
								<p className="mt-2 text-sm text-muted-foreground">
									Select an arm to inspect its live output, structured events, and recent health signals.
								</p>
							</div>
						)}
					</div>

					<div className="flex flex-wrap items-center justify-end gap-2">
						{arm ? (
							<ArmDetailsPopover
								arm={arm}
								connected={connected}
								totalCost={totalCost}
								totalTokens={totalTokens}
							/>
						) : null}
						{arm && arm.status !== "stopped" ? (
							<Button
								variant="ghost"
								size="sm"
								onPress={onMarkStuck}
								isDisabled={markingStuck}
								className="gap-1.5 text-warning"
							>
								<AlertTriangle className="h-4 w-4" />
								{markingStuck
									? "Reporting…"
									: arm.recoveryRequestedAt
										? "Recovery requested"
										: "Mark stuck"}
							</Button>
						) : null}
						<Button
							variant="ghost"
							onPress={onRefresh}
							isIconOnly
							size="sm"
							aria-label="Refresh viewer"
						>
							<RefreshCw className="h-4 w-4" />
						</Button>
					</div>
				</div>
			</div>

			{arm ? (
				<div className="border-b border-border">
					<div className="flex flex-wrap items-center gap-2 px-5 py-2.5">
						<button
							type="button"
							onClick={() => onSummaryExpandedChange(!summaryExpanded)}
							className="flex min-w-0 flex-1 items-center gap-3 rounded-md py-1 text-left transition-colors hover:text-foreground"
							aria-expanded={summaryExpanded}
							aria-label={summaryExpanded ? "Collapse status details" : "Expand status details"}
						>
							<ViewerToolbarPill
								label={analysisState ?? arm.status}
								tone={activityStateTone}
								icon={<PulseStateIcon analysis={hasEventTelemetry ? analysis : null} armStatus={arm.status} />}
								compact
							/>
							<span className="min-w-0 truncate text-sm text-muted-foreground">
								{statusNarrative}
							</span>
						</button>

						<StatusDetailsPopover
							armStatus={arm.status}
							analysis={analysis}
							sessionLabel={sessionLabel}
							sessionStatus={sessionStatus}
							connected={connected}
							streamLabel={streamValue}
						/>

						<div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
							{activeTab === "logs" ? (
								<MessageSquare className="h-3.5 w-3.5" />
							) : (
								<Zap className="h-3.5 w-3.5" />
							)}
							<span>{activeTab === "logs" && !logsReady ? "—" : formatCompactNumber(streamCount)}</span>
						</div>

						<Button
							variant="ghost"
							size="sm"
							isIconOnly
							onPress={() => onSummaryExpandedChange(!summaryExpanded)}
							aria-label={summaryExpanded ? "Collapse status details" : "Expand status details"}
						>
							<ChevronDown
								className={cn(
									"h-4 w-4 text-muted-foreground transition-transform",
									summaryExpanded ? "rotate-180" : "",
								)}
							/>
						</Button>
					</div>

					{summaryExpanded ? (
						<div className="px-5 pb-3">
							<div className="grid gap-2 md:grid-cols-2 2xl:grid-cols-[minmax(0,1.35fr)_repeat(4,minmax(0,1fr))]">
								<ViewerMetricCard
									label="Current Focus"
									value={selectedWorkItem ?? "Monitoring"}
									detail={
										selectedWorkItem
											? workItemType === "bug"
												? "Bug under review"
												: "Task in progress"
											: "No active task or bug"
									}
									tone={workItemType === "bug" ? "warning" : "accent"}
									icon={
										workItemType === "bug" ? (
											<AlertOctagon className="h-4 w-4" />
										) : (
											<ListTodo className="h-4 w-4" />
										)
									}
									isPrimary
									compact={compactSummary}
								/>
								<ViewerMetricCard
									label="Activity State"
									value={analysisState ?? (analysisLoading ? "Checking" : "No event data")}
									detail={
										hasEventTelemetry && analysis?.analysis.confidence
											? `${analysis.analysis.confidence} confidence`
											: "Waiting for structured events"
									}
									tone={activityStateTone}
									icon={<PulseStateIcon analysis={hasEventTelemetry ? analysis : null} armStatus={arm.status} />}
									compact={compactSummary}
								/>
								<ViewerMetricCard
									label="Session"
									value={sessionLabel}
									detail={connected ? "Event stream connected" : "History only"}
									tone={sessionTone}
									icon={
										sessionStatus === "busy" ? (
											<Loader2 className="h-4 w-4 animate-spin" />
										) : (
											<Radio className="h-4 w-4" />
										)
									}
									compact={compactSummary}
								/>
								<ViewerMetricCard
									label="Stream"
									value={streamValue}
									detail={activeTab === "logs" ? "Model transcript and brain decisions" : "Raw live event stream"}
									tone="neutral"
									icon={
										activeTab === "logs" ? (
											<Terminal className="h-4 w-4" />
										) : (
											<Zap className="h-4 w-4" />
										)
									}
									compact={compactSummary}
								/>
								<ViewerMetricCard
									label="Usage"
									value={totalTokenCount > 0 ? `${formatCompactNumber(totalTokenCount)} tokens` : "No usage yet"}
									detail={totalCost > 0 ? `$${totalCost.toFixed(4)} total` : "Cost not available"}
									tone="neutral"
									icon={<Coins className="h-4 w-4" />}
									compact={compactSummary}
								/>
							</div>

						<ArmAnalysisPanel
							analysis={analysis}
							loading={analysisLoading}
							onRefresh={onRefreshAnalysis}
							compact
							embedded
						/>
					</div>
				) : null}
			</div>
		) : null}

			<div className="border-b border-border px-5 py-2.5">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="inline-flex items-center rounded-md border border-border bg-surface-secondary/70 p-0.5">
						<ViewerTabButton
							label="Focused Activity"
							isActive={activeTab === "logs"}
							onPress={() => onTabChange("logs")}
						/>
						<ViewerTabButton
							label="Firehose"
							isActive={activeTab === "events"}
							onPress={() => onTabChange("events")}
						/>
					</div>

					<div className="flex flex-wrap items-center gap-2">
						{activeTab === "logs" ? (
							<CustomizeViewPopover
								preferences={messageLogPreferences}
								onCollapsedChange={onMessageLogTypeCollapsedChange}
								onBrainActivityVisibleChange={onBrainActivityVisibleChange}
							/>
						) : null}
						<Dropdown>
							<Dropdown.Trigger
								aria-label="Viewer actions"
								className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-surface-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
							>
								<MoreHorizontal className="h-4 w-4" />
							</Dropdown.Trigger>
							<Dropdown.Popover>
								<Dropdown.Menu
									onAction={(key) => {
										if (key === "refresh") {
											onRefresh();
										}
										if (key === "clear") {
											onClearHistory();
										}
									}}
								>
									<Dropdown.Item key="refresh" id="refresh" textValue="Refresh">
										<span className="flex items-center gap-2">
											<RefreshCw className="h-4 w-4" />
											Refresh
										</span>
									</Dropdown.Item>
									<Dropdown.Item
										key="clear"
										id="clear"
										textValue="Clear event history"
										isDisabled={activeTab !== "events" || activities.length === 0}
									>
										<span className="flex items-center gap-2">
											<Trash2 className="h-4 w-4" />
											Clear event history
										</span>
									</Dropdown.Item>
								</Dropdown.Menu>
							</Dropdown.Popover>
						</Dropdown>
					</div>
				</div>
			</div>

			{error ? (
				<div className="border-b border-danger/20 bg-danger/10 px-5 py-3">
					<div className="flex items-center gap-2 text-sm text-danger">
						<AlertTriangle className="h-4 w-4" />
						<span>{error}</span>
					</div>
				</div>
			) : null}

			<div className="min-h-0 flex-1 overflow-hidden">
						{arm ? (
							activeTab === "events" ? (
							<div
								ref={feedContainerRef}
								onScroll={onFeedScroll}
								className="h-full overflow-auto bg-surface/70 p-4"
							>
								<div className="mx-auto flex w-full max-w-5xl flex-col gap-3">
									{selectedArm?.id ? (
										<div className="grid gap-3 xl:grid-cols-3">
											<ArmActivityChart
												armId={selectedArm.id}
												activities={activities}
													title="Activity & Efficiency"
													embedded
													compact
												/>
												<ArmContextUsageChart
													armId={selectedArm.id}
													contextBudget={selectedArm.contextBudget}
													onContextBudgetChange={(contextBudget) =>
														onContextBudgetChange(selectedArm.id, contextBudget)
													}
													title="Context Usage"
													embedded
													compact
												/>
												<ArmCostUsageChart
													armId={selectedArm.id}
													title="Cost Usage"
													embedded
													compact
												/>
										</div>
									) : null}
									{currentText ? (
											<div className="overflow-hidden rounded-md border border-accent/35 bg-accent/8">
										<div className="flex items-center gap-2 border-b border-accent/20 px-4 py-3 text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-accent">
											<Bot className="h-3.5 w-3.5" />
											Live Draft
											<Loader2 className="ml-auto h-3.5 w-3.5 animate-spin" />
										</div>
										<pre className="max-h-56 overflow-auto px-4 py-4 font-mono text-[12px] leading-6 whitespace-pre-wrap text-foreground/90">
											{currentText.slice(-2000)}
										</pre>
									</div>
								) : null}

								{eventsLoading && activities.length === 0 ? (
									<div className="flex items-center gap-2 text-sm text-muted-foreground">
										<Loader2 className="h-4 w-4 animate-spin" />
										<span>Loading event history...</span>
									</div>
								) : activities.length === 0 && !currentText ? (
									<ViewerEmptyState
										icon={<Zap className="h-8 w-8" />}
										title="No firehose events yet"
										description="Raw live events will appear here as the arm works."
									/>
								) : (
									activities.map((activity) => (
										<ActivityItemComponent
											key={activity.id}
											activity={activity}
											onToggle={() => onToggleActivity(activity.id)}
										/>
									))
								)}
							</div>
						</div>
					) : (
						<div
							ref={feedContainerRef}
							onScroll={onFeedScroll}
							className="h-full overflow-auto bg-surface/70 p-4"
						>
							<div className="mx-auto flex max-w-5xl flex-col">
								{logsError ? (
									<div className="rounded-md border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
										{logsError}
									</div>
								) : null}

								{(logsLoading || !logsReady) && messages.length === 0 ? (
									<div className="flex items-center gap-2 text-sm text-muted-foreground">
										<Loader2 className="h-4 w-4 animate-spin" />
										<span>Loading logs...</span>
									</div>
								) : null}

								{focusedActivityItems.length === 0 && logsReady && !logsLoading ? (
									<ViewerEmptyState
										icon={<Terminal className="h-8 w-8" />}
										title="No focused activity yet"
										description="Model messages and selected brain decisions will appear here."
									/>
								) : (
									focusedActivityItems.map((item) =>
										item.kind === "message" ? (
											<MessageLogItem
												key={item.message.info.id}
												message={item.message}
												preferences={messageLogPreferences}
												onCollapsedChange={onMessageLogTypeCollapsedChange}
											/>
										) : (
											<BrainActivityLogItem key={`brain-${item.activity.id}`} activity={item.activity} />
										),
									)
								)}
							</div>
						</div>
					)
				) : (
					<div className="flex h-full items-center justify-center px-6">
						<ViewerEmptyState
							icon={<Eye className="h-9 w-9" />}
							title="Select an arm to begin"
							description="Choose an active arm from the selector to inspect its console."
						/>
					</div>
				)}
			</div>
		</div>
	);
}

function ViewerMetricCard({
	label,
	value,
	detail,
	icon,
	tone,
	isPrimary = false,
	compact = false,
}: {
	label: string;
	value: string;
	detail: string;
	icon: ReactNode;
	tone: "neutral" | "accent" | "success" | "warning" | "danger";
	isPrimary?: boolean;
	compact?: boolean;
}) {
	const toneClass = {
		neutral: "border-border bg-card text-foreground",
		accent: "border-accent/25 bg-accent/8 text-foreground",
		success: "border-success/25 bg-success/8 text-foreground",
		warning: "border-warning/30 bg-warning/10 text-foreground",
		danger: "border-danger/25 bg-danger/10 text-foreground",
	}[tone];

	const iconTone = {
		neutral: "text-muted-foreground",
		accent: "text-accent",
		success: "text-success",
		warning: "text-warning",
		danger: "text-danger",
	}[tone];

	const showDetail = !compact || isPrimary;

	return (
		<div
			className={cn(
				"rounded-md border",
				compact ? "px-2.5 py-2" : "px-4 py-3",
				toneClass,
				isPrimary && !compact ? "md:col-span-2 2xl:col-span-1 2xl:min-h-[96px]" : "",
			)}
		>
			<div className={cn("flex items-start", compact ? "gap-2.5" : "gap-3")}>
				<div className={cn("mt-0.5", iconTone)}>{icon}</div>
				<div className="min-w-0">
					<div
						className={cn(
							"font-semibold uppercase text-muted-foreground",
							compact ? "text-[0.62rem] tracking-[0.15em]" : "text-[0.68rem] tracking-[0.18em]",
						)}
					>
						{label}
					</div>
					<div
						className={cn(
							"break-words font-semibold capitalize leading-tight text-foreground",
							compact ? "mt-1 text-[0.9rem]" : "mt-2 text-sm",
						)}
					>
						{value}
					</div>
					{showDetail ? (
						<div
							className={cn(
								"text-muted-foreground",
								compact ? "mt-0.5 text-[0.72rem] leading-4" : "mt-1 text-sm",
							)}
						>
							{detail}
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}

function ViewerTabButton({
	label,
	isActive,
	onPress,
}: {
	label: string;
	isActive: boolean;
	onPress: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onPress}
			className={cn(
				"rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
				isActive
					? "bg-background text-foreground shadow-sm"
					: "text-muted-foreground hover:text-foreground",
			)}
		>
			{label}
		</button>
	);
}

function ViewerToolbarPill({
	label,
	icon,
	tone,
	compact = false,
}: {
	label: string;
	icon: ReactNode;
	tone: "neutral" | "success" | "warning" | "danger";
	compact?: boolean;
}) {
	const toneClass = {
		neutral: "border-border bg-surface-secondary text-muted-foreground",
		success: "border-success/25 bg-success/8 text-success",
		warning: "border-warning/25 bg-warning/10 text-warning",
		danger: "border-danger/25 bg-danger/10 text-danger",
	}[tone];

	return (
		<div
			className={cn(
				"inline-flex shrink-0 items-center gap-2 rounded-md border font-semibold uppercase tracking-[0.14em]",
				compact ? "px-2 py-1 text-[0.62rem]" : "px-2.5 py-1.5 text-[0.68rem]",
				toneClass,
			)}
		>
			{icon}
			<span>{label}</span>
		</div>
	);
}

function ArmDetailsPopover({
	arm,
	connected,
	totalCost,
	totalTokens,
}: {
	arm: Arm;
	connected: boolean;
	totalCost: number;
	totalTokens: { input: number; output: number };
}) {
	const detailRows = [
		["Harness", arm.harness],
		["Provider", arm.provider ?? "Unknown"],
		["Model", arm.model ?? "Unknown"],
		["Stream", connected ? "Live" : "Offline"],
		["Tokens", formatCompactNumber(totalTokens.input + totalTokens.output)],
		["Cost", totalCost > 0 ? `$${totalCost.toFixed(4)}` : "Not available"],
	];

	return (
		<Popover>
			<Popover.Trigger
				aria-label="Arm details"
				className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md px-2.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-surface-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
			>
				<Server className="h-4 w-4" />
				<span className="hidden sm:inline">Details</span>
			</Popover.Trigger>
			<Popover.Content placement="bottom end" className="w-72">
				<Popover.Dialog className="outline-none">
					<div className="px-1 py-1">
						<div className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
							Arm Details
						</div>
						<div className="mt-3 grid gap-2">
							{detailRows.map(([label, value]) => (
								<div key={label} className="flex items-center justify-between gap-4 text-sm">
									<span className="text-muted-foreground">{label}</span>
									<span className="truncate text-right font-medium text-foreground">{value}</span>
								</div>
							))}
						</div>
					</div>
				</Popover.Dialog>
			</Popover.Content>
		</Popover>
	);
}

function StatusDetailsPopover({
	armStatus,
	analysis,
	sessionLabel,
	sessionStatus,
	connected,
	streamLabel,
}: {
	armStatus: string;
	analysis: ArmAnalysisFull | null;
	sessionLabel: string;
	sessionStatus: string;
	connected: boolean;
	streamLabel: string;
}) {
	const healthState = analysis?.analysis.state ?? null;
	const healthValue = healthState ? formatStatusLayerLabel(healthState) : "No analysis yet";
	const lifecycleValue = formatStatusLayerLabel(armStatus);

	return (
		<Popover>
			<Popover.Trigger
				aria-label="Explain arm statuses"
				className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-surface-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
			>
				<Info className="h-4 w-4" />
			</Popover.Trigger>
			<Popover.Content placement="bottom end" className="w-[520px] max-w-[calc(100vw-2rem)]">
				<Popover.Dialog className="max-h-[min(430px,calc(100vh-2rem))] overflow-auto outline-none">
					<div className="space-y-3 px-1 py-1">
						<div>
							<div className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
								Status Layers
							</div>
							<p className="mt-1 text-sm leading-5 text-muted-foreground">
								These labels answer different questions, so more than one can be true at once.
							</p>
						</div>

						<div className="grid gap-2 sm:grid-cols-2">
							<StatusLayerRow
								label="Lifecycle"
								value={lifecycleValue}
								detail="What the API currently knows about the arm process. Busy means the arm is assigned or active from the orchestrator's point of view."
							/>
							<StatusLayerRow
								label="Health"
								value={healthValue}
								detail={
									analysis
										? formatAnalysisReason(analysis.analysis.reason)
										: "The recent event analyzer has not produced a health signal yet."
								}
							/>
							<StatusLayerRow
								label="Session"
								value={sessionLabel}
								detail={`The live harness session state. ${
									sessionStatus === "busy"
										? "Working means a response or tool action is in flight."
										: "Waiting means the stream is open, but no response is currently in flight."
								}`}
							/>
							<StatusLayerRow
								label="Stream"
								value={connected ? "Live" : "Offline"}
								detail={`${streamLabel} loaded. This only describes whether the browser is receiving updates.`}
							/>
						</div>
					</div>
				</Popover.Dialog>
			</Popover.Content>
		</Popover>
	);
}

function StatusLayerRow({
	label,
	value,
	detail,
}: {
	label: string;
	value: string;
	detail: string;
}) {
	return (
		<div className="rounded-md border border-border bg-surface-secondary/35 px-3 py-2">
			<div className="flex items-center justify-between gap-3">
				<span className="text-[0.62rem] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
					{label}
				</span>
				<span className="text-sm font-semibold text-foreground">{value}</span>
			</div>
			<p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">{detail}</p>
		</div>
	);
}

function ViewerEmptyState({
	icon,
	title,
	description,
}: {
	icon: ReactNode;
	title: string;
	description: string;
}) {
	return (
		<div className="rounded-md border border-dashed border-border bg-surface-secondary/35 px-6 py-10 text-center">
			<div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-md border border-border bg-card text-muted-foreground">
				{icon}
			</div>
			<p className="text-base font-semibold">{title}</p>
			<p className="mt-2 text-sm text-muted-foreground">{description}</p>
		</div>
	);
}

function PulseStateIcon({
	analysis,
	armStatus,
}: {
	analysis: ArmAnalysisFull | null;
	armStatus: string;
}) {
	if (analysis) {
		const Icon = stateConfig[analysis.analysis.state].icon;
		return <Icon className="h-4 w-4" />;
	}

	if (armStatus === "running") {
		return <Play className="h-4 w-4" />;
	}

	if (armStatus === "starting") {
		return <Loader2 className="h-4 w-4 animate-spin" />;
	}

	if (armStatus === "error") {
		return <AlertOctagon className="h-4 w-4" />;
	}

	return <CircleDashed className="h-4 w-4" />;
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
		pending: <Clock className="h-3.5 w-3.5 text-muted-foreground" />,
		running: <Loader2 className="h-3.5 w-3.5 animate-spin text-warning" />,
		completed: <CheckCircle2 className="h-3.5 w-3.5 text-success" />,
		error: <XCircle className="h-3.5 w-3.5 text-danger" />,
		info: null,
	}[activity.status];

	return (
		<div className="overflow-hidden rounded-md border border-border bg-card">
			<div className={cn("h-1 w-full", colors.bg)} />
			<Button
				variant="ghost"
				onPress={onToggle}
				isDisabled={!hasDetails}
				className="h-auto w-full justify-start px-4 py-3"
			>
				<div className="flex min-w-0 flex-1 items-start gap-3 text-left">
					<div className={cn("mt-0.5 rounded-sm border border-border p-2", colors.bg)}>
						<Icon className={`h-4 w-4 ${colors.icon}`} />
					</div>

					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-2">
							<span className="truncate text-sm font-semibold">{activity.title}</span>
							{statusIcon}
							<span className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
								{activity.status}
							</span>
						</div>
						{activity.subtitle ? (
							<div className="mt-1 truncate text-sm text-muted-foreground">
								{activity.subtitle}
							</div>
						) : null}
					</div>

					<div className="flex items-center gap-2 pl-2 text-xs text-muted-foreground">
						<span>{formatTime(activity.timestamp)}</span>
						{hasDetails ? (
							activity.expanded ? (
								<ChevronDown className="h-3.5 w-3.5" />
							) : (
								<ChevronRight className="h-3.5 w-3.5" />
							)
						) : null}
					</div>
				</div>
			</Button>

			{activity.expanded && hasDetails ? (
				<div className="border-t border-border px-4 py-3">
					<pre className="max-h-56 overflow-auto rounded-sm bg-surface-secondary/45 px-3 py-3 text-[12px] leading-6 whitespace-pre-wrap text-muted-foreground">
						{formatDetails(activity.details!)}
					</pre>
				</div>
			) : null}
		</div>
	);
}

function CustomizeViewPopover({
	preferences,
	onCollapsedChange,
	onBrainActivityVisibleChange,
}: {
	preferences: MessageLogPreferences;
	onCollapsedChange: (type: MessageLogContentType, collapsed: boolean) => void;
	onBrainActivityVisibleChange: (type: BrainActivityCategory, visible: boolean) => void;
}) {
	return (
		<Popover>
			<Popover.Trigger
				aria-label="Customize focused activity"
				className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md px-2.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-surface-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
			>
				<SlidersHorizontal className="h-4 w-4" />
				<span className="hidden sm:inline">Customize view</span>
			</Popover.Trigger>
			<Popover.Content placement="bottom end" className="w-96 max-w-[calc(100vw-2rem)]">
				<Popover.Dialog className="max-h-[min(560px,calc(100vh-2rem))] overflow-auto outline-none">
					<div className="px-1 py-1">
						<div className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
							Customize focused activity
						</div>
						<p className="mt-1 text-sm leading-5 text-muted-foreground">
							Choose the transcript details and brain activity shown in this view. Preferences are saved locally.
						</p>
						<div className="mt-4 text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
							Transcript display
						</div>
						<div className="mt-2 grid gap-1">
							{MESSAGE_LOG_TYPE_OPTIONS.map(({ type, label, description }) => {
								const collapsed = preferences.collapsed[type];
								return (
									<button
										key={type}
										type="button"
										aria-pressed={!collapsed}
										onClick={() => onCollapsedChange(type, !collapsed)}
										className="flex items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-surface-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
									>
										<span>
											<span className="block text-sm font-medium text-foreground">{label}</span>
											<span className="block text-xs text-muted-foreground">{description}</span>
										</span>
										<span className="shrink-0 text-xs font-medium text-muted-foreground">
											{collapsed ? "Collapsed" : "Expanded"}
										</span>
									</button>
								);
							})}
						</div>
						<div className="mt-5 text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
							Brain activity
						</div>
						<div className="mt-2 grid gap-4">
							{BRAIN_ACTIVITY_GROUPS.map(({ heading, options }) => (
								<div key={heading}>
									<div className="mb-1 text-xs font-semibold text-foreground">{heading}</div>
									<div className="grid gap-1">
										{options.map(({ type, label, description }) => (
											<Switch
												key={type}
												size="sm"
												isSelected={preferences.brainActivity[type]}
												onChange={(visible) => onBrainActivityVisibleChange(type, visible)}
											>
												<Switch.Content className="flex-1 items-start gap-2 rounded-md px-2 py-1 hover:bg-surface-secondary">
													<Switch.Control>
														<Switch.Thumb />
													</Switch.Control>
													<span>
														<span className="block text-sm font-medium text-foreground">{label}</span>
														<span className="block text-xs text-muted-foreground">{description}</span>
													</span>
												</Switch.Content>
											</Switch>
										))}
									</div>
								</div>
							))}
						</div>
					</div>
				</Popover.Dialog>
			</Popover.Content>
		</Popover>
	);
}

function MessageLogItem({
	message,
	preferences,
	onCollapsedChange,
}: {
	message: ArmMessage;
	preferences: MessageLogPreferences;
	onCollapsedChange: (type: MessageLogContentType, collapsed: boolean) => void;
}) {
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
		<div className="border-b border-border/70 px-2 py-3 last:border-b-0">
			<div className="flex items-center justify-between gap-3 px-1">
				<div className="flex min-w-0 items-center gap-2">
					<span className={cn("h-1.5 w-1.5 rounded-full", role === "assistant" ? "bg-accent" : role === "user" ? "bg-success" : "bg-warning")} />
					<div className={`text-[0.62rem] uppercase tracking-[0.15em] font-semibold ${roleColor}`}>
						{roleLabel}
					</div>
				</div>
				{timestamp ? (
					<div className="text-xs text-muted-foreground">{timestamp}</div>
				) : null}
			</div>

			<div className="mt-2 space-y-2">
				{formatMessageError(message.info.error) ? (
					<MessageLogEntry
						type="error"
						label="Error"
						collapsed={preferences.collapsed.error}
						onCollapsedChange={onCollapsedChange}
					>
						<pre className="font-mono text-[12px] leading-6 whitespace-pre-wrap text-destructive">
							{formatMessageError(message.info.error)}
						</pre>
					</MessageLogEntry>
				) : null}
				{message.parts.map((part, index) => {
					const text = part.text || part.content;
					if (part.type === "text" && text) {
						const type: MessageLogContentType = role === "assistant" ? "response" : "message";
						return (
							<MessageLogEntry
								key={`${message.info.id}-text-${index}`}
								type={type}
								label={type === "response" ? "Response" : "Message"}
								collapsed={preferences.collapsed[type]}
								onCollapsedChange={onCollapsedChange}
							>
								<pre className="max-h-96 overflow-auto font-mono text-[12px] leading-6 whitespace-pre-wrap text-foreground/92">
									{text}
								</pre>
							</MessageLogEntry>
						);
					}

					if (part.type === "reasoning" && text) {
						return (
							<MessageLogEntry
								key={`${message.info.id}-reasoning-${index}`}
								type="thinking"
								label="Thinking"
								collapsed={preferences.collapsed.thinking}
								onCollapsedChange={onCollapsedChange}
							>
								<pre className="max-h-96 overflow-auto font-mono text-[12px] leading-6 whitespace-pre-wrap text-muted-foreground">
									{text}
								</pre>
							</MessageLogEntry>
						);
					}

					if (part.type === "error") {
						const error = formatMessageError(part.error) || text;
						if (error) {
							return (
								<MessageLogEntry
									key={`${message.info.id}-error-${index}`}
									type="error"
									label="Error"
									collapsed={preferences.collapsed.error}
									onCollapsedChange={onCollapsedChange}
								>
									<pre className="font-mono text-[12px] leading-6 whitespace-pre-wrap text-destructive">
										{error}
									</pre>
								</MessageLogEntry>
							);
						}
					}

					if (
						(part.type === "tool-invocation" || part.type === "tool") &&
						(part.toolName || part.tool || part.name)
					) {
						const tool = part.toolName || part.tool || part.name || "unknown";
						const details = extractToolDetails(part);
						const state = details.status ? ` [${details.status}]` : "";
						return (
							<div key={`${message.info.id}-tool-${index}`} className="space-y-2">
								<MessageLogEntry
									type="tool"
									label={`Tool: ${tool}${state}`}
									collapsed={preferences.collapsed.tool}
									onCollapsedChange={onCollapsedChange}
								>
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
									{details.durationMs !== undefined && (
										<div className="text-[11px] text-muted-foreground font-mono">
											{`duration: ${details.durationMs}ms`}
										</div>
									)}
								</MessageLogEntry>
								{details.error !== undefined && details.error !== null ? (
									<MessageLogEntry
										type="error"
										label="Tool error"
										collapsed={preferences.collapsed.error}
										onCollapsedChange={onCollapsedChange}
									>
										<pre className="font-mono text-[12px] leading-6 whitespace-pre-wrap text-destructive">
											{summarizeToolValue(details.error)}
										</pre>
									</MessageLogEntry>
								) : null}
							</div>
						);
					}

					if (text) {
						const type: MessageLogContentType = role === "assistant" ? "response" : "message";
						return (
							<MessageLogEntry
								key={`${message.info.id}-${part.type}-${index}`}
								type={type}
								label={
									part.type === "completion"
										? "Completion"
										: type === "response"
											? "Response"
											: "Message"
								}
								collapsed={preferences.collapsed[type]}
								onCollapsedChange={onCollapsedChange}
							>
								<pre className="max-h-96 overflow-auto font-mono text-[12px] leading-6 whitespace-pre-wrap text-foreground/92">
									{text}
								</pre>
							</MessageLogEntry>
						);
					}

					return null;
				})}
			</div>
		</div>
	);
}

function BrainActivityLogItem({ activity }: { activity: ActivityItem }) {
	const category = getBrainActivityCategory(activity);

	return (
		<div className="border-b border-border/70 px-2 py-3 last:border-b-0">
			<div className="rounded-md border border-cyan-500/25 bg-cyan-500/5 px-3 py-2.5">
				<div className="flex items-center justify-between gap-3">
					<div className="flex min-w-0 items-center gap-2">
						<Bot className="h-3.5 w-3.5 shrink-0 text-cyan-600" />
						<span className="truncate text-sm font-semibold text-foreground">{activity.title}</span>
						{category ? (
							<span className="text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-cyan-700">
								Brain {category}
							</span>
						) : null}
					</div>
					<span className="shrink-0 text-xs text-muted-foreground">{formatTime(activity.timestamp)}</span>
				</div>
				{activity.subtitle ? (
					<div className="mt-1 text-sm text-muted-foreground">{activity.subtitle}</div>
				) : null}
				{activity.details && Object.keys(activity.details).length > 1 ? (
					<details className="group mt-2">
						<summary className="cursor-pointer text-xs font-medium text-muted-foreground">
							Details
						</summary>
						<pre className="mt-2 max-h-56 overflow-auto rounded-sm bg-surface-secondary/45 px-3 py-2 text-[12px] leading-6 whitespace-pre-wrap text-muted-foreground">
							{formatDetails(activity.details)}
						</pre>
					</details>
				) : null}
			</div>
		</div>
	);
}

function formatMessageError(error: unknown): string | null {
	if (typeof error === "string" && error.trim()) {
		return error;
	}
	const errorRecord = error as JsonValue;
	if (!isJsonObject(errorRecord)) {
		return null;
	}

	const name = typeof errorRecord.name === "string" ? errorRecord.name : null;
	const data = isJsonObject(errorRecord.data) ? errorRecord.data : null;
	const message = typeof data?.message === "string" ? data.message : null;
	if (name && message) {
		return `${name}: ${message}`;
	}

	return name || message;
}

function MessageLogEntry({
	type,
	label,
	collapsed,
	onCollapsedChange,
	children,
}: {
	type: MessageLogContentType;
	label: string;
	collapsed: boolean;
	onCollapsedChange: (type: MessageLogContentType, collapsed: boolean) => void;
	children: ReactNode;
}) {
	return (
		<details
			className="group rounded-md border border-border/60 bg-surface-secondary/25"
			open={!collapsed}
			onToggle={(event) => onCollapsedChange(type, !event.currentTarget.open)}
		>
			<summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground marker:content-none">
				<span>{label}</span>
				<ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
			</summary>
			<div className="border-t border-border/60 px-3 py-2.5">{children}</div>
		</details>
	);
}

function getMessageTimestamp(timeValue: JsonValue | undefined): number | null {
	if (timeValue === undefined || timeValue === null) {
		return null;
	}

	let raw: JsonValue = timeValue;
	if (isJsonObject(timeValue)) {
		const timeObj = timeValue;
		raw = (
			timeObj.completed ??
			timeObj.created ??
			timeObj.updated ??
			timeObj.end ??
			timeObj.start ??
			null
		);
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
	return date.getTime();
}

function formatMessageTime(timeValue: JsonValue | undefined): string | null {
	const timestamp = getMessageTimestamp(timeValue);
	if (timestamp === null) {
		return null;
	}

	return new Date(timestamp).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

function extractToolDetails(part: ArmMessage["parts"][number]): {
	status?: string;
	input?: JsonValue;
	output?: JsonValue;
	error?: JsonValue;
	durationMs?: number;
} {
	const details: {
		status?: string;
		input?: JsonValue;
		output?: JsonValue;
		error?: JsonValue;
		durationMs?: number;
	} = {};

	if (typeof part.state === "string") {
		details.status = part.state;
	} else if (isJsonObject(part.state)) {
		const stateObj = part.state;
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
		if (isJsonObject(stateObj.time)) {
			const timeObj = stateObj.time;
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

function summarizeToolValue(value: JsonValue): string {
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
	compact = false,
	embedded = false,
}: {
	analysis: ArmAnalysisFull | null;
	loading: boolean;
	onRefresh: () => void;
	compact?: boolean;
	embedded?: boolean;
}) {
	if (loading) {
		return (
			<div
				className={cn(
					embedded ? "pt-2.5" : "border-b border-border px-5",
					compact ? "py-3" : "py-4",
				)}
			>
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<Loader2 className="h-4 w-4 animate-spin" />
					<span>Loading health signals...</span>
				</div>
			</div>
		);
	}

	if (!analysis) {
		return null;
	}

	if (analysis.analysis.metrics.eventCount === 0) {
		return (
			<div
				className={cn(
					embedded ? "pt-2.5" : "border-b border-border px-5",
					compact ? "py-3" : "py-4",
				)}
			>
				<div className="flex items-start gap-3 rounded-md border border-border bg-surface-secondary/60 px-3 py-2.5">
					<Radio className="mt-0.5 h-4 w-4 text-muted-foreground" />
					<div className="min-w-0 flex-1">
						<p className="text-sm font-medium">No structured event telemetry yet</p>
						<p className="mt-1 text-xs leading-5 text-muted-foreground">
							Message logs remain available; health confidence and trend appear after events arrive.
						</p>
					</div>
					<button
						onClick={onRefresh}
						className="text-muted-foreground transition-colors hover:text-foreground"
						aria-label="Refresh analysis"
					>
						<RefreshCw className="h-3.5 w-3.5" />
					</button>
				</div>
			</div>
		);
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

	const compactSignals = [
		analysis.analysis.pendingPermission
			? { label: "Permission pending", tone: "warning" as const }
			: null,
		analysis.analysis.loopPattern
			? {
					label: `Loop ${analysis.analysis.loopPattern.repetitions}x`,
					tone: "danger" as const,
				}
			: null,
	].filter((value): value is { label: string; tone: "warning" | "danger" } => value !== null);

	return (
		<div
			className={cn(
				embedded ? "pt-2.5" : "border-b border-border px-5",
				compact ? "py-3" : "py-4",
			)}
		>
			<div
				className={cn(
					"grid md:grid-cols-2 2xl:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))]",
					compact ? "gap-2" : "gap-3",
				)}
			>
				<div className={cn("rounded-md border", config.bg, compact ? "px-3 py-2.5" : "px-4 py-3")}>
					<div className="flex items-start justify-between gap-3">
						<div className={cn("flex items-start", compact ? "gap-2.5" : "gap-3")}>
							<div
								className={cn(
									"rounded-sm border border-current/15",
									config.text,
									compact ? "p-1.5" : "p-2",
								)}
							>
								<StateIcon className="h-4 w-4" />
							</div>
							<div>
								<div
									className={cn(
										"font-semibold uppercase text-muted-foreground",
										compact ? "text-[0.62rem] tracking-[0.15em]" : "text-[0.68rem] tracking-[0.18em]",
									)}
								>
									Health Signal
								</div>
								<div
									className={cn(
										"font-semibold capitalize",
										config.text,
										compact ? "mt-1.5 text-[0.92rem]" : "mt-2 text-sm",
									)}
								>
									{state.replace("_", " ")}
								</div>
							</div>
						</div>
						<button
							onClick={onRefresh}
							className="text-muted-foreground transition-colors hover:text-foreground"
							aria-label="Refresh analysis"
						>
							<RefreshCw className="h-3.5 w-3.5" />
						</button>
					</div>
					<p className={cn("text-muted-foreground", compact ? "mt-2 text-[0.76rem] leading-5" : "mt-3 text-sm")}>
						{formatAnalysisReason(analysis.analysis.reason)}
					</p>
					{compactSignals.length > 0 ? (
						<div className="mt-2 flex flex-wrap gap-2">
							{compactSignals.map((signal) => (
								<span
									key={signal.label}
									className={cn(
										"inline-flex items-center rounded-md border px-2 py-1 text-[0.62rem] font-semibold uppercase tracking-[0.14em]",
										signal.tone === "warning"
											? "border-warning/25 bg-warning/10 text-warning"
											: "border-danger/25 bg-danger/10 text-danger",
									)}
								>
									{signal.label}
								</span>
							))}
						</div>
					) : null}
				</div>

				<ViewerMetricCard
					label="Confidence"
					value={analysis.analysis.confidence}
					detail="Model confidence in the current state"
					tone={
						analysis.analysis.confidence === "high"
							? "success"
							: analysis.analysis.confidence === "medium"
								? "warning"
								: "neutral"
					}
					icon={<ShieldQuestion className="h-4 w-4" />}
					compact={compact}
				/>
				<ViewerMetricCard
					label="Recent Events"
					value={`${analysis.analysis.metrics.eventCount}`}
					detail={`${analysis.analysis.metrics.recentFileEditCount} files edited`}
					tone="neutral"
					icon={<Zap className="h-4 w-4" />}
					compact={compact}
				/>
				<ViewerMetricCard
					label="Trend"
					value={trendLabel}
					detail="Direction of activity quality"
					tone={analysis.trend.improving ? "success" : analysis.trend.degrading ? "danger" : "neutral"}
					icon={trendIcon}
					compact={compact}
				/>
			</div>

			{!compact && (analysis.analysis.pendingPermission || analysis.analysis.loopPattern) ? (
				<div className="mt-3 grid gap-3 xl:grid-cols-2">
					{analysis.analysis.pendingPermission ? (
						<div className="rounded-md border border-warning/25 bg-warning/10 px-4 py-3 text-sm">
							<div className="flex items-center gap-2 font-medium text-warning">
								<ShieldQuestion className="h-4 w-4" />
								<span>Permission requested</span>
							</div>
							<div className="mt-2 text-foreground">
								{analysis.analysis.pendingPermission.action}
							</div>
							{analysis.analysis.pendingPermission.context ? (
								<p className="mt-1 text-sm text-muted-foreground">
									{analysis.analysis.pendingPermission.context}
								</p>
							) : null}
						</div>
					) : null}

					{analysis.analysis.loopPattern ? (
						<div className="rounded-md border border-danger/25 bg-danger/10 px-4 py-3 text-sm">
							<div className="flex items-center gap-2 font-medium text-danger">
								<RefreshCw className="h-4 w-4" />
								<span>Loop detected</span>
							</div>
							<div className="mt-2 text-foreground">
								{analysis.analysis.loopPattern.repetitions} repetitions
							</div>
							<p className="mt-1 font-mono text-[12px] text-muted-foreground">
								{analysis.analysis.loopPattern.pattern.slice(0, 3).join(" → ")}
								{analysis.analysis.loopPattern.pattern.length > 3 ? "..." : ""}
							</p>
						</div>
					) : null}
				</div>
			) : null}
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

function formatDetails(details: JsonObject): string {
	// Format details for display, handling special cases
	const formatted: JsonObject = {};

	for (const [key, value] of Object.entries(details)) {
		if (value === undefined || value === null) continue;

		if (key === "output" && typeof value === "string" && value.length > 500) {
			formatted[key] = value.slice(0, 500) + "... (truncated)";
		} else if (key === "input" && isJsonObject(value)) {
			// Truncate long input values
			const inputObj = value;
			const truncatedInput: JsonObject = {};
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
