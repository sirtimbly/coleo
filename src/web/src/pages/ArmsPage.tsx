import { useEffect, useMemo, useState, useCallback } from "react";
import {
	AlertTriangle,
	Coins,
	KeyRound,
	LoaderCircle,
	Play,
	Plus,
	RefreshCw,
	RotateCcw,
	Server,
	Trash2,
	X,
	Zap,
} from "lucide-react";
import { Card, Chip, Button } from "@heroui/react";
import { generateArmName } from "../../../cli/arm-names";
import {
	api,
	type AgentInfo,
	type Arm,
	type ArmTemplateSummary,
	type OpenCodeProvider,
} from "@/lib";
import { ArmActivityChart } from "@/components/ArmActivityChart";
import { ArmContextUsageChart } from "@/components/ArmContextUsageChart";
import { ArmCostUsageChart } from "@/components/ArmCostUsageChart";
import { usePageTitle } from '@/hooks/usePageTitle';
import { useToast } from "@/hooks/useToast";
import { useWebSocket } from "@/hooks/useWebSocket";
import {
	useWorkspaceCloseRoute,
	useWorkspaceOpenRoute,
	useWorkspaceSearchParams,
} from '@/workspace/route-context';
import { ProviderSetupModal } from "@/components/ProviderSetupModal";

interface ArmEventData {
	arm?: Arm;
	id?: string;
	status?: string;
	changes?: Partial<Arm>;
}

interface SpawnDefaults {
	harness: string;
	provider: string;
	model: string;
}

interface OpenCodeCatalogState {
	source: "cache" | "fallback" | "live" | "unknown";
	message: string | null;
}

interface OpenCodeProvidersResponse {
	providers: OpenCodeProvider[];
	connected: string[];
	default?: Record<string, string>;
	error?: string;
	message?: string;
	fallback?: boolean;
	cached?: boolean;
	cachedAt?: string;
	source?: "live" | "cache" | "fallback";
}

interface NewArmModalState {
	isOpen: boolean;
	name: string;
	templateId: string;
	harness: string;
	provider: string;
	model: string;
	agentId: string;
}

const DEFAULT_SPAWN_DEFAULTS: SpawnDefaults = {
	harness: "opencode-api",
	provider: "",
	model: "",
};

const DEFAULT_OPENCODE_CATALOG_STATE: OpenCodeCatalogState = {
	source: "unknown",
	message: null,
};

const EMPTY_OPENCODE_PROVIDERS_RESPONSE: OpenCodeProvidersResponse = {
	providers: [],
	connected: [],
	source: "fallback",
	message: "Unable to load the cached OpenCode catalog.",
};

const DEFAULT_SPAWN_MODAL_STATE: NewArmModalState = {
	isOpen: false,
	name: "",
	templateId: "",
	harness: "",
	provider: "",
	model: "",
	agentId: "",
};

function isDaemonManagedHarness(harness: string): boolean {
	return harness === "opencode-api" || harness === "opencode";
}

function usesOpenCodeCatalog(harness: string): boolean {
	return harness === "opencode-api";
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function pickFirstCompatibleTemplate(
	templates: ArmTemplateSummary[],
	availableHarnesses: string[],
): ArmTemplateSummary | null {
	return (
		templates.find((template) => availableHarnesses.includes(template.harness)) || null
	);
}

function pickPreferredHarness(preferredHarness: string, availableHarnesses: string[]): string {
	if (availableHarnesses.length === 0) {
		return preferredHarness;
	}

	return availableHarnesses.includes(preferredHarness)
		? preferredHarness
		: availableHarnesses[0]!;
}

function generateSuggestedArmName(existingArms: Arm[]): string {
	const existingIds = new Set(existingArms.map((arm) => arm.id.toLowerCase()));

	for (let attempt = 0; attempt < 20; attempt++) {
		const candidate = generateArmName();
		if (!existingIds.has(candidate.toLowerCase())) {
			return candidate;
		}
	}

	return `${generateArmName()}-${existingArms.length + 1}`;
}

function formatAge(seconds: number | null | undefined): string {
	if (seconds === null || seconds === undefined) {
		return "Never";
	}
	if (seconds < 60) {
		return `${seconds}s ago`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h ${minutes % 60}m ago`;
	}
	const days = Math.floor(hours / 24);
	return `${days}d ${hours % 24}h ago`;
}

function runtimeTone(state: string | undefined): "success" | "warning" | "danger" | "default" {
	if (state === "active" || state === "quiet") return "success";
	if (state === "starting") return "warning";
	if (state === "hung" || state === "recoverable") return "danger";
	return "default";
}

function armActionFor(arm: Arm): { kind: "spawn" | "recover"; label: string } | null {
	const runtimeState = arm.runtime?.state;
	if (
		arm.runtime?.canRecover &&
		(runtimeState === "hung" || runtimeState === "recoverable" || runtimeState === "stopped")
	) {
		return { kind: "recover", label: runtimeState === "hung" ? "Recover" : "Restart" };
	}

	if (arm.status === "stopped" || arm.status === "error") {
		return { kind: "spawn", label: "Spawn" };
	}

	if (arm.status === "starting" && !arm.runtime?.hasRuntime) {
		return { kind: "spawn", label: "Spawn" };
	}

	return null;
}

function needsAttention(arm: Arm): boolean {
	const runtimeState = arm.runtime?.state;
	return (
		armActionFor(arm) !== null ||
		runtimeState === "hung" ||
		runtimeState === "recoverable" ||
		arm.status === "error"
	);
}

const STATUS_DOT_CLASS: Record<string, string> = {
	busy: "bg-primary",
	idle: "bg-success",
	starting: "bg-warning",
	stopped: "bg-default-400",
	error: "bg-danger",
};

function statusDotClass(status: string): string {
	return STATUS_DOT_CLASS[status] || "bg-default-400";
}

interface ArmRowProps {
	arm: Arm;
	attention: boolean;
	spawningArmId: string | null;
	markingStuckArmId: string | null;
	onOpen: () => void;
	onDelete: () => void;
	onSpawn: () => void;
	onRecover: () => void;
	onMarkStuck: () => void;
}

function ArmRow({
	arm,
	attention,
	spawningArmId,
	markingStuckArmId,
	onOpen,
	onDelete,
	onSpawn,
	onRecover,
	onMarkStuck,
}: ArmRowProps) {
	const action = armActionFor(arm);
	const isRecover = action?.kind === "recover";
	const isSpawning = spawningArmId === arm.id;
	const isMarkingStuck = markingStuckArmId === arm.id;
	const contextPct = arm.contextBudget
		? Math.min((arm.currentContextUsed / arm.contextBudget) * 100, 100)
		: 0;
	const currentWork = arm.currentBugTitle || arm.currentTaskSubject || null;

	const diagnosticParts: string[] = [];
	if (arm.runtime) {
		diagnosticParts.push(arm.runtime.reason);
		diagnosticParts.push(
			[
				`status=${arm.runtime.signals.dbStatus}`,
				arm.runtime.signals.hasPid ? "pid" : "no-pid",
				arm.runtime.signals.hasPort ? "port" : "no-port",
				arm.runtime.signals.hasSessionId ? "session" : "no-session",
				arm.runtime.signals.hasAgentId ? "agent" : "local",
				arm.runtime.signals.hasWorkdir ? "workdir" : "no-workdir",
				arm.runtime.signals.hasAssignedTask ? "task" : "no-task",
			].join(" · "),
		);
	}
	if (arm.host || arm.agentId) {
		diagnosticParts.push(
			`${arm.host || arm.agentId}${arm.host && arm.agentId ? ` · ${arm.agentId}` : ""}`,
		);
	}
	if (arm.port || arm.pid) {
		diagnosticParts.push(
			`${arm.port ? `:${arm.port}` : "no port"}${arm.pid ? ` · pid ${arm.pid}` : ""}`,
		);
	}

	return (
		<div
			role="button"
			tabIndex={0}
			onClick={onOpen}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onOpen();
				}
			}}
			className={`group relative flex cursor-pointer flex-col gap-1.5 px-4 py-3 outline-none transition-colors hover:bg-default-100/50 focus-visible:bg-default-100/60 ${
				attention ? "bg-warning/5" : ""
			}`}
		>
			<div className="flex items-center gap-3">
				<span
					className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(arm.status)} ${
						arm.status === "busy" ? "animate-pulse" : ""
					}`}
					aria-hidden
				/>
				<span className="font-medium shrink-0">{arm.name}</span>
				{arm.recoveryRequestedAt && (
					<Chip size="sm" variant="soft" color="warning" className="shrink-0">
						Recovery requested
					</Chip>
				)}
				<span className="text-xs text-muted-foreground shrink-0">{arm.harness}</span>
				{arm.provider && (
					<Chip size="sm" variant="soft" className="shrink-0">
						{arm.provider}
					</Chip>
				)}
				{arm.model && (
					<Chip size="sm" variant="soft" color="success" className="shrink-0">
						{arm.model}
					</Chip>
				)}

				<span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
					{currentWork ? (
						<>
							<span className="mr-1">{arm.currentBugTitle ? "🐛" : "📋"}</span>
							{currentWork}
						</>
					) : (
						<span className="italic text-muted-foreground/60">
							Idle — waiting for the brain to assign work
						</span>
					)}
				</span>

				<div className="hidden shrink-0 items-center gap-1.5 sm:flex" title="Context used">
					<div className="h-1.5 w-16 overflow-hidden rounded-full bg-default-200">
						<div
							className="h-full bg-primary transition-all"
							style={{ width: `${contextPct}%` }}
						/>
					</div>
					<span className="w-9 text-right text-[11px] text-muted-foreground">
						{Math.round(contextPct)}%
					</span>
				</div>

				{arm.totalTokens !== undefined && (
					<span className="hidden shrink-0 items-center gap-1 text-[11px] text-muted-foreground md:flex">
						<Zap className="h-3 w-3" />
						{arm.totalTokens.toLocaleString()}
					</span>
				)}
				{arm.totalCost !== undefined && arm.totalCost > 0 && (
					<span className="hidden shrink-0 items-center gap-1 text-[11px] text-muted-foreground lg:flex">
						<Coins className="h-3 w-3" />${arm.totalCost.toFixed(3)}
					</span>
				)}

				<span className="hidden w-24 shrink-0 text-right text-[11px] text-muted-foreground md:block">
					{arm.lastActivityAt ? formatAge(arm.runtime?.secondsSinceOutput) : "Never"}
				</span>

				<div
					className="flex shrink-0 items-center gap-1.5"
					onClick={(e) => e.stopPropagation()}
				>
					{action && (
						<Button
							variant={isRecover ? "secondary" : "primary"}
							size="sm"
							onPress={() => void (isRecover ? onRecover() : onSpawn())}
							isDisabled={spawningArmId !== null}
							className={isRecover ? "gap-1.5 text-warning" : "gap-1.5"}
						>
							{isSpawning ? (
								<LoaderCircle className="h-3.5 w-3.5 animate-spin" />
							) : isRecover ? (
								<RotateCcw className="h-3.5 w-3.5" />
							) : (
								<Play className="h-3.5 w-3.5" />
							)}
							{isSpawning ? (isRecover ? "Recovering…" : "Starting…") : action.label}
						</Button>
					)}
					{arm.status !== "stopped" && (
						<Button
							variant="ghost"
							size="sm"
							onPress={onMarkStuck}
							isDisabled={markingStuckArmId !== null}
							className="gap-1.5 text-warning"
						>
							<AlertTriangle className="h-3.5 w-3.5" />
							{isMarkingStuck
								? "Reporting…"
								: arm.recoveryRequestedAt
									? "Recovery requested"
									: "Mark stuck"}
						</Button>
					)}
					<Button
						isIconOnly
						variant="ghost"
						size="sm"
						onPress={onDelete}
						className="text-muted-foreground opacity-0 transition-opacity hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
					>
						<Trash2 className="h-3.5 w-3.5" />
					</Button>
				</div>
			</div>

			{diagnosticParts.length > 0 && (
				<div className="pl-5 font-mono text-[10.5px] leading-relaxed text-muted-foreground/50 flex flex-wrap gap-x-3">
					{arm.runtime && (
						<Chip
							size="sm"
							variant="soft"
							color={runtimeTone(arm.runtime.state)}
							className="!h-4 !px-1.5 !text-[10px] normal-case"
						>
							{arm.runtime.state}
						</Chip>
					)}
					{diagnosticParts.map((part, i) => (
						<span key={i}>{part}</span>
					))}
				</div>
			)}
		</div>
	);
}

export function ArmsPage() {
	const [searchParams] = useWorkspaceSearchParams();
	const openWorkspaceRoute = useWorkspaceOpenRoute();
	const closeWorkspaceRoute = useWorkspaceCloseRoute('/arms');
	const isSpawnPage = searchParams.get("spawn") === "1";
	usePageTitle(isSpawnPage ? 'Coleo Observatory - Spawn Arm' : 'Coleo Observatory - Arms');
	const [arms, setArms] = useState<Arm[]>([]);
	const [agents, setAgents] = useState<AgentInfo[]>([]);
	const [armTemplates, setArmTemplates] = useState<ArmTemplateSummary[]>([]);
	const [openCodeProviders, setOpenCodeProviders] = useState<OpenCodeProvider[]>([]);
	const [openCodeCatalog, setOpenCodeCatalog] = useState<OpenCodeCatalogState>(
		DEFAULT_OPENCODE_CATALOG_STATE,
	);
	const [spawnDefaults, setSpawnDefaults] = useState<SpawnDefaults>(
		DEFAULT_SPAWN_DEFAULTS,
	);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [spawningArmId, setSpawningArmId] = useState<string | null>(null);
	const [markingStuckArmId, setMarkingStuckArmId] = useState<string | null>(null);
	const [spawnModal, setSpawnModal] = useState<NewArmModalState>(
		DEFAULT_SPAWN_MODAL_STATE,
	);
	const [telemetryArmId, setTelemetryArmId] = useState<string | null>(null);
	const [providerSetupProviderId, setProviderSetupProviderId] = useState<string | null>(null);
	const [loadingAgentProviders, setLoadingAgentProviders] = useState(false);
	const { showError, showSuccess } = useToast();

	const loadArms = useCallback(async () => {
		try {
			const [armsRes, agentsRes, defaultsRes, providersRes, templatesRes] = await Promise.all([
				api.listArms(),
				api.listAgents().catch(() => ({ agents: [] as AgentInfo[] })),
				api
					.getDefaults()
					.catch(() => ({ defaults: { ...DEFAULT_SPAWN_DEFAULTS, contextBudget: 0 } })),
				api
					.getOpenCodeProviders()
					.catch(() => EMPTY_OPENCODE_PROVIDERS_RESPONSE),
				api.listArmTemplates().catch(() => ({ templates: [] as ArmTemplateSummary[] })),
			]);
			setArms(armsRes.arms);
			setAgents(agentsRes.agents);
			setArmTemplates(templatesRes.templates);
			const catalogIsCacheBacked =
				providersRes.source === "cache" &&
				providersRes.fallback !== true;
			setOpenCodeProviders(
				catalogIsCacheBacked
					? providersRes.providers.map((provider) => ({
							...provider,
							connected: providersRes.connected.includes(provider.id),
						}))
					: [],
			);
			setOpenCodeCatalog({
				source: providersRes.source || "unknown",
				message:
					catalogIsCacheBacked
						? providersRes.message || null
						: providersRes.message ||
						  "The API has not loaded a cached authenticated OpenCode catalog yet.",
			});
			setSpawnDefaults({
				harness: defaultsRes.defaults.harness,
				provider: defaultsRes.defaults.provider,
				model: defaultsRes.defaults.model,
			});
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load arms");
		} finally {
			setLoading(false);
		}
	}, []);

	const handleWSMessage = useCallback(
		(msg: { channel?: string; event?: string; data?: unknown }) => {
			if (msg.channel !== "arms" || !msg.event || !msg.data) return;

			const data = msg.data as ArmEventData;

			switch (msg.event) {
				case "arm.created":
					if (data.arm) {
						setArms((prev) => [...prev, data.arm as Arm]);
					}
					break;

				case "arm.updated":
					if (data.arm) {
						setArms((prev) =>
							prev.map((arm) => (arm.id === data.arm?.id ? data.arm : arm)),
						);
					}
					break;

				case "arm.deleted":
					if (data.id) {
						setArms((prev) => prev.filter((arm) => arm.id !== data.id));
					}
					break;

				case "arm.spawned":
				case "arm.killed":
					void loadArms();
					break;

				case "arm.prompt_sent":
					if (data.id && data.status) {
						setArms((prev) =>
							prev.map((arm) =>
								arm.id === data.id
									? { ...arm, status: data.status as Arm["status"] }
									: arm,
							),
						);
					}
					break;
			}
		},
		[loadArms],
	);

	useWebSocket({
		channels: ["arms"],
		onMessage: handleWSMessage,
	});

	useEffect(() => {
		loadArms();
	}, [loadArms]);

	const handleDelete = async (id: string) => {
		if (!confirm("Are you sure you want to delete this arm?")) return;
		try {
			await api.deleteArm(id);
			await loadArms();
		} catch (err) {
			showError(
				err instanceof Error ? err.message : "Failed to delete arm",
				"Delete Failed",
			);
		}
	};

	const handleSpawn = useCallback(
		async (
			arm: Arm,
			options?: {
				preferAgent?: boolean;
				agentId?: string;
				allowLocalFallback?: boolean;
			},
		) => {
			setSpawningArmId(arm.id);

			try {
				const response = await api.spawnArm(arm.id, {
					provider: arm.provider,
					model: arm.model,
					preferAgent: options?.preferAgent,
					agentId: options?.agentId,
					allowLocalFallback: options?.allowLocalFallback,
				});
				await loadArms();

				const target = response.distributed
					? response.host || response.agentId || "remote arm agent host"
					: "the API server host";
				showSuccess(`Spawned ${arm.name} on ${target}`, "Arm Started");
				setSpawnModal(DEFAULT_SPAWN_MODAL_STATE);
			} catch (err) {
				showError(
					err instanceof Error ? err.message : "Failed to spawn arm",
					"Spawn Failed",
				);
			} finally {
				setSpawningArmId(null);
			}
		},
		[loadArms, showError, showSuccess],
	);

	const handleRecover = useCallback(
		async (
			arm: Arm,
			options?: {
				agentId?: string;
				allowLocalFallback?: boolean;
			},
		) => {
			setSpawningArmId(arm.id);

			try {
				const response = await api.recoverArm(arm.id, {
					provider: arm.provider,
					model: arm.model,
					agentId: options?.agentId,
					allowLocalFallback: options?.allowLocalFallback,
				});
				await loadArms();

				const target = response.distributed
					? response.host || response.agentId || "remote arm agent host"
					: "the API server host";
				const action =
					response.recoveryMode === "reattached"
						? "Reattached"
						: response.recoveryMode === "recovered"
							? "Recovered"
							: "Restarted";
				showSuccess(`${action} ${arm.name} on ${target}`, "Arm Recovery");
			} catch (err) {
				showError(
					err instanceof Error ? err.message : "Failed to recover arm",
					"Recovery Failed",
				);
			} finally {
				setSpawningArmId(null);
			}
		},
		[loadArms, showError, showSuccess],
	);

	const handleMarkStuck = useCallback(
		async (arm: Arm) => {
			setMarkingStuckArmId(arm.id);
			try {
				const { arm: updatedArm } = await api.markArmStuck(arm.id);
				setArms((previous) =>
					previous.map((current) => (current.id === updatedArm.id ? updatedArm : current)),
				);
				await loadArms();
				showSuccess(`${arm.name} will be checked for recovery on the next brain pass.`, "Arm Marked Stuck");
			} catch (err) {
				showError(err instanceof Error ? err.message : "Failed to mark arm stuck", "Mark Stuck Failed");
			} finally {
				setMarkingStuckArmId(null);
			}
		},
		[loadArms, showError, showSuccess],
	);

	const allAgentHarnesses = useMemo(
		() => uniqueStrings(agents.flatMap((agent) => agent.capabilities)),
		[agents],
	);

	const selectedSpawnAgent = useMemo(
		() => agents.find((agent) => agent.agentId === spawnModal.agentId) || null,
		[agents, spawnModal.agentId],
	);

	const selectedTemplate = useMemo(
		() => armTemplates.find((template) => template.id === spawnModal.templateId) || null,
		[armTemplates, spawnModal.templateId],
	);

	const selectedOpenCodeProvider = useMemo(
		() => openCodeProviders.find((provider) => provider.id === spawnModal.provider) || null,
		[openCodeProviders, spawnModal.provider],
	);

	const selectedOpenCodeModels = useMemo(
		() => selectedOpenCodeProvider?.models ?? [],
		[selectedOpenCodeProvider],
	);

	const selectedOpenCodeModel = useMemo(
		() => selectedOpenCodeModels.find((model) => model.id === spawnModal.model) || null,
		[selectedOpenCodeModels, spawnModal.model],
	);

	const modelPricing = useMemo(() => {
		if (!selectedOpenCodeModel?.pricing) return null;
		const input = selectedOpenCodeModel.pricing.input ?? 0;
		const output = selectedOpenCodeModel.pricing.output ?? 0;
		if (input <= 0 && output <= 0) return null;
		return {
			input,
			output,
			per100k: (input + output) / 20,
		};
	}, [selectedOpenCodeModel]);

	const contextBudgetWarning = useMemo(() => {
		const modelLimit = selectedOpenCodeModel?.limit?.context;
		const requestedBudget = selectedTemplate?.contextBudget;
		return Boolean(modelLimit && requestedBudget && requestedBudget > modelLimit);
	}, [selectedOpenCodeModel, selectedTemplate]);

	const isHighCostModel = (modelPricing?.per100k ?? 0) >= 2;

	const availableHarnesses = useMemo(() => {
		return uniqueStrings(selectedSpawnAgent?.capabilities ?? []);
	}, [selectedSpawnAgent]);

	const compatibleTemplates = useMemo(() => {
		if (availableHarnesses.length === 0) {
			return armTemplates;
		}
		return armTemplates.filter((template) =>
			availableHarnesses.includes(template.harness),
		);
	}, [armTemplates, availableHarnesses]);

	const hasOpenCodeCatalog =
		openCodeCatalog.source === "cache" || openCodeCatalog.source === "live";

	const selectedTelemetryArm = useMemo(() => {
		const sortedByActivity = [...arms].sort((left, right) => {
			const leftAt = left.lastActivityAt ? new Date(left.lastActivityAt).getTime() : 0;
			const rightAt = right.lastActivityAt ? new Date(right.lastActivityAt).getTime() : 0;
			return rightAt - leftAt;
		});

		if (arms.length === 0) {
			return null;
		}

		if (telemetryArmId) {
			const match = arms.find((arm) => arm.id === telemetryArmId);
			if (match) {
				return match;
			}
		}

		return sortedByActivity[0]!;
	}, [arms, telemetryArmId]);

	useEffect(() => {
		if (arms.length === 0) {
			setTelemetryArmId(null);
			return;
		}

		if (!telemetryArmId || !arms.some((arm) => arm.id === telemetryArmId)) {
			setTelemetryArmId(selectedTelemetryArm?.id ?? null);
		}
	}, [arms, telemetryArmId, selectedTelemetryArm?.id]);

	const openSpawnModal = useCallback(() => {
		const initialAgentId = agents[0]?.agentId || "";
		const initialAgentHarnesses = uniqueStrings(agents[0]?.capabilities ?? allAgentHarnesses);
		const initialTemplate = pickFirstCompatibleTemplate(
			armTemplates,
			initialAgentHarnesses,
		);
		const initialHarness = pickPreferredHarness(
			initialTemplate?.harness || spawnDefaults.harness,
			initialAgentHarnesses,
		);
		const suggestedName = generateSuggestedArmName(arms);

		setSpawnModal({
			isOpen: true,
			name: suggestedName,
			templateId: initialTemplate?.id || "",
			harness: initialHarness,
			provider: initialTemplate?.provider || spawnDefaults.provider,
			model: initialTemplate?.model || spawnDefaults.model,
			agentId: initialAgentId,
		});
	}, [agents, allAgentHarnesses, armTemplates, arms, spawnDefaults]);

	const openSpawnPanel = useCallback(() => {
		openWorkspaceRoute(
			{ pathname: "/arms", search: "?spawn=1", title: "Spawn Arm" },
			"action",
		);
	}, [openWorkspaceRoute]);

	const closeSpawnModal = useCallback(() => {
		setSpawnModal(DEFAULT_SPAWN_MODAL_STATE);
		setProviderSetupProviderId(null);
		if (isSpawnPage) {
			closeWorkspaceRoute();
		}
	}, [closeWorkspaceRoute, isSpawnPage]);

	const openProviderSetupModal = useCallback((providerId: string) => {
		setProviderSetupProviderId(providerId);
	}, []);

	const openArmViewer = useCallback(
		(armId: string) => {
			openWorkspaceRoute(
				{ pathname: "/viewer", search: `?arm=${encodeURIComponent(armId)}` },
				"tab",
			);
		},
		[openWorkspaceRoute],
	);

	const submitSpawnModal = useCallback(async () => {
		const name = spawnModal.name.trim();
		const provider = spawnModal.provider.trim();
		const model = spawnModal.model.trim();
		let didSpawn = false;

		if (!name) {
			showError("Enter a name for the new arm", "Spawn Failed");
			return;
		}

		if (arms.some((arm) => arm.id === name)) {
			showError(`An arm named "${name}" already exists`, "Spawn Failed");
			return;
		}

		if (agents.length === 0) {
			showError(
				"No connected arm agent hosts are available. Start an arm agent first.",
				"Spawn Failed",
			);
			return;
		}

		if (!spawnModal.harness) {
			showError("Choose a harness supported by the selected arm agent host", "Spawn Failed");
			return;
		}

		if (!spawnModal.agentId) {
			showError("Choose an arm agent host", "Spawn Failed");
			return;
		}

		if (selectedOpenCodeProvider?.connected === false) {
			openProviderSetupModal(selectedOpenCodeProvider.id);
			return;
		}

		setSpawningArmId(name);

		try {
			const response = await api.spawnArm(name, {
				name,
				template: spawnModal.templateId || undefined,
				harness: spawnModal.harness,
				provider: provider || undefined,
				model: model || undefined,
				preferAgent: true,
				agentId: spawnModal.agentId,
			});
			await loadArms();

			const target = response.host || response.agentId || "remote arm agent host";
			showSuccess(`Spawned ${name} on ${target}`, "Arm Started");
			didSpawn = true;
		} catch (err) {
			showError(
				err instanceof Error ? err.message : "Failed to spawn arm",
				"Spawn Failed",
			);
		} finally {
			setSpawningArmId(null);
			if (didSpawn) {
				closeSpawnModal();
			}
		}
	}, [
		agents.length,
		arms,
		closeSpawnModal,
		loadArms,
		openProviderSetupModal,
		selectedOpenCodeProvider,
		showError,
		showSuccess,
		spawnModal,
	]);

	useEffect(() => {
		if (searchParams.get("spawn") !== "1") {
			return;
		}

		openSpawnModal();
	}, [openSpawnModal, searchParams]);

	useEffect(() => {
		if (!spawnModal.isOpen || !spawnModal.agentId || !usesOpenCodeCatalog(spawnModal.harness)) {
			return;
		}

		let cancelled = false;
		setLoadingAgentProviders(true);
		void api.getAgentOpenCodeProviders(spawnModal.agentId)
			.then((response) => {
				if (cancelled) return;
				setOpenCodeProviders(response.providers);
				setOpenCodeCatalog({ source: "live", message: null });
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setOpenCodeCatalog((current) => ({
					...current,
					message: err instanceof Error ? err.message : "Unable to load providers from the arm host",
				}));
			})
			.finally(() => {
				if (!cancelled) setLoadingAgentProviders(false);
			});

		return () => {
			cancelled = true;
		};
	}, [spawnModal.agentId, spawnModal.harness, spawnModal.isOpen]);

	useEffect(() => {
		if (!spawnModal.isOpen) {
			return;
		}

		setSpawnModal((current) => {
			const nextAgentId = agents.some((agent) => agent.agentId === current.agentId)
				? current.agentId
				: agents[0]?.agentId || "";
			const nextAgent =
				agents.find((agent) => agent.agentId === nextAgentId) || null;
			const nextAvailableHarnesses = uniqueStrings(nextAgent?.capabilities ?? []);
			const nextCompatibleTemplates =
				nextAvailableHarnesses.length === 0
					? armTemplates
					: armTemplates.filter((template) =>
							nextAvailableHarnesses.includes(template.harness),
					  );
			const nextTemplateId = current.templateId
				? nextCompatibleTemplates.some((template) => template.id === current.templateId)
					? current.templateId
					: nextCompatibleTemplates[0]?.id || ""
				: "";
			const nextTemplate =
				armTemplates.find((template) => template.id === nextTemplateId) || null;

			const nextHarness = current.harness
				? nextAvailableHarnesses.includes(current.harness)
					? current.harness
					: pickPreferredHarness(
							nextTemplate?.harness || spawnDefaults.harness,
							nextAvailableHarnesses,
					  )
				: pickPreferredHarness(
						nextTemplate?.harness || spawnDefaults.harness,
						nextAvailableHarnesses,
				  );

			let nextProvider =
				nextTemplateId !== current.templateId
					? nextTemplate?.provider || spawnDefaults.provider
					: current.provider;
			let nextModel =
				nextTemplateId !== current.templateId
					? nextTemplate?.model || spawnDefaults.model
					: current.model;

			if (usesOpenCodeCatalog(nextHarness) && hasOpenCodeCatalog && openCodeProviders.length > 0) {
				const providerExists = openCodeProviders.some(
					(provider) => provider.id === current.provider,
				);
				const resolvedProvider =
					providerExists
						? current.provider
						: openCodeProviders.find(
								(provider) => provider.id === spawnDefaults.provider,
						  )?.id || openCodeProviders[0]?.id || "";
				const providerRecord =
					openCodeProviders.find((provider) => provider.id === resolvedProvider) || null;
				const providerModels = providerRecord?.models ?? [];
				const modelExists = providerModels.some((model) => model.id === current.model);

				nextProvider = resolvedProvider;
				nextModel = modelExists
					? current.model
					: providerModels.find((model) => model.id === spawnDefaults.model)?.id ||
					  providerModels[0]?.id ||
					  "";
			}

			if (
				nextAgentId === current.agentId &&
				nextTemplateId === current.templateId &&
				nextHarness === current.harness &&
				nextProvider === current.provider &&
				nextModel === current.model
			) {
				return current;
			}

			return {
				...current,
				agentId: nextAgentId,
				templateId: nextTemplateId,
				harness: nextHarness,
				provider: nextProvider,
				model: nextModel,
			};
		});
	}, [
		agents,
		armTemplates,
		hasOpenCodeCatalog,
		openCodeProviders,
		spawnDefaults.harness,
		spawnDefaults.model,
		spawnDefaults.provider,
		spawnModal.isOpen,
	]);

	const { attentionArms, healthyArms } = useMemo(() => {
		const attention: Arm[] = [];
		const healthy: Arm[] = [];
		for (const arm of arms) {
			(needsAttention(arm) ? attention : healthy).push(arm);
		}
		return { attentionArms: attention, healthyArms: healthy };
	}, [arms]);

	if (error) {
		return (
			<div className="p-8">
				<Card className="border-danger">
					<Card.Content>
						<p className="text-danger">{error}</p>
					</Card.Content>
				</Card>
			</div>
		);
	}

	return (
		<div
			className={
				isSpawnPage
					? "min-h-full overflow-auto bg-surface p-3 sm:p-5"
					: "p-8 space-y-8 overflow-auto"
			}
		>
			{!isSpawnPage ? (
				<>
					<div className="flex items-center justify-between">
						<div>
							<h1 className="text-2xl font-bold">Arms</h1>
							<p className="text-muted-foreground">Manage your AI agents</p>
						</div>
						<Button
							variant="primary"
							className="gap-2"
							onPress={openSpawnPanel}
							isDisabled={loading}
						>
							<Plus className="h-4 w-4" />
							Spawn Arm
						</Button>
					</div>

					{selectedTelemetryArm ? (
						<div className="space-y-4 rounded-lg border border-border bg-surface/90 p-4">
							<div className="flex flex-wrap items-center justify-between gap-3">
								<div className="space-y-1">
									<div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
										Telemetry Overview
									</div>
									<div className="text-sm font-semibold text-foreground">
										30-minute activity, context, and cost
									</div>
								</div>
								<label className="text-xs text-muted-foreground">
									<span className="mr-2">Arm</span>
									<select
										value={selectedTelemetryArm.id}
										onChange={(event) => setTelemetryArmId(event.target.value)}
										className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-foreground"
									>
										{arms
											.slice()
											.sort((left, right) => left.name.localeCompare(right.name))
											.map((arm) => (
												<option key={arm.id} value={arm.id}>
													{arm.name}
												</option>
											))}
									</select>
								</label>
							</div>

							<div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
								<ArmActivityChart armId={selectedTelemetryArm.id} />
								<ArmContextUsageChart
									armId={selectedTelemetryArm.id}
									title={`Context Usage - ${selectedTelemetryArm.name}`}
								/>
								<ArmCostUsageChart
									armId={selectedTelemetryArm.id}
									title={`Cost Usage - ${selectedTelemetryArm.name}`}
								/>
							</div>
						</div>
					) : null}

					{loading ? (
						<div className="space-y-2">
							{[1, 2, 3, 4].map((i) => (
								<div key={i} className="h-16 rounded-lg bg-default-100/60 animate-pulse" />
							))}
						</div>
					) : arms.length === 0 ? (
						<Card>
							<Card.Content className="py-12 text-center">
								<p className="text-muted-foreground mb-4">No arms registered yet</p>
								<code className="block p-4 bg-muted/20 rounded text-sm text-left max-w-md mx-auto">
									coleo arm spawn
								</code>
							</Card.Content>
						</Card>
					) : (
						<div className="space-y-6">
							{attentionArms.length > 0 && (
						<div className="space-y-2">
							<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-warning">
								<AlertTriangle className="h-3.5 w-3.5" />
								Needs attention · {attentionArms.length}
							</div>
							<div className="rounded-lg border border-warning/40 divide-y divide-warning/20 overflow-hidden">
								{attentionArms.map((arm) => (
									<ArmRow
										key={arm.id}
										arm={arm}
										attention
										spawningArmId={spawningArmId}
										markingStuckArmId={markingStuckArmId}
										onOpen={() => openArmViewer(arm.id)}
										onDelete={() => handleDelete(arm.id)}
										onSpawn={() => handleSpawn(arm)}
										onRecover={() => handleRecover(arm)}
										onMarkStuck={() => handleMarkStuck(arm)}
									/>
								))}
							</div>
						</div>
					)}

					<div className="space-y-2">
						{attentionArms.length > 0 && (
							<div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
								Running · {healthyArms.length}
							</div>
						)}
						<div className="rounded-lg border border-default-200 divide-y divide-default-200 overflow-hidden">
							{healthyArms.length === 0 ? (
								<div className="px-4 py-6 text-center text-sm text-muted-foreground">
									All arms need attention right now.
								</div>
							) : (
								healthyArms.map((arm) => (
									<ArmRow
										key={arm.id}
										arm={arm}
										attention={false}
										spawningArmId={spawningArmId}
										markingStuckArmId={markingStuckArmId}
										onOpen={() => openArmViewer(arm.id)}
										onDelete={() => handleDelete(arm.id)}
										onSpawn={() => handleSpawn(arm)}
										onRecover={() => handleRecover(arm)}
										onMarkStuck={() => handleMarkStuck(arm)}
									/>
								))
							)}
						</div>
					</div>
				</div>
			)}
					</>
			) : null}

			{isSpawnPage && spawnModal.isOpen ? (
				<div className="flex min-h-full w-full items-start justify-center">
					<div className="spawn-arm-panel flex min-h-[min(44rem,100%)] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-overlay text-foreground shadow-xl">
							<div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
								<div>
									<h2 className="text-lg font-semibold text-foreground">Spawn New Arm</h2>
									<p className="text-sm text-muted-foreground">
										Create a new arm record and start it on a connected arm agent host.
									</p>
								</div>
								<button
									type="button"
									onClick={closeSpawnModal}
									className="rounded p-1 text-muted-foreground transition-colors hover:bg-surface-secondary hover:text-foreground"
									aria-label="Close spawn arm"
								>
									<X className="h-5 w-5" />
								</button>
							</div>

							<div className="min-h-0 space-y-5 overflow-y-auto p-4">
								<div className="rounded-lg border border-accent/40 bg-accent/10 p-3 text-sm text-foreground">
									The API server is the control plane. Spawn sends a command to a connected
									arm agent. If that agent is running on another host, the arm will start on
									that host rather than on the API server machine.
								</div>

								<div className="spawn-arm-panel__identity grid gap-4">
									<div>
										<div className="mb-2 flex items-center justify-between gap-3">
											<label className="text-sm font-medium text-foreground" htmlFor="spawn-arm-name">
												Arm name
											</label>
											<Button
												variant="ghost"
												size="sm"
												onPress={() =>
													setSpawnModal((current) => ({
														...current,
														name: generateSuggestedArmName(arms),
													}))
												}
												className="gap-1.5 text-xs"
											>
												<RefreshCw className="h-3.5 w-3.5" />
												Regenerate
											</Button>
										</div>
										<input
											id="spawn-arm-name"
											value={spawnModal.name}
											onChange={(e) =>
												setSpawnModal((current) => ({
													...current,
													name: e.target.value,
												}))
											}
											placeholder="e.g. explorer-2"
											className="w-full rounded-lg border border-border bg-surface-secondary px-3 py-2 text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
										/>
									</div>
									<div>
										<label className="mb-2 block text-sm font-medium text-foreground">
											Template
										</label>
										<select
											value={spawnModal.templateId}
											onChange={(e) =>
												setSpawnModal((current) => {
													const templateId = e.target.value;
													const template =
														armTemplates.find((entry) => entry.id === templateId) || null;
													return {
														...current,
														templateId,
														harness:
															template?.harness || current.harness || spawnDefaults.harness,
														provider:
															template?.provider || spawnDefaults.provider,
														model: template?.model || spawnDefaults.model,
													};
												})
											}
											className="w-full rounded-lg border border-border bg-surface-secondary px-3 py-2 text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
										>
											<option value="">Custom arm (no template)</option>
											{compatibleTemplates.map((template) => (
												<option key={template.id} value={template.id}>
													{template.filename} - {template.description}
												</option>
											))}
										</select>
									</div>
								</div>

								{selectedTemplate && (
									<p className="text-sm text-muted-foreground">
										Using <code>{selectedTemplate.filename}</code> from{" "}
										<code>.coleo/templates</code> to prefill harness and model settings.
									</p>
								)}

								<div className="spawn-arm-panel__runtime grid gap-4">
									<div>
										<label className="mb-2 block text-sm font-medium text-foreground">
											Harness
										</label>
										<select
											value={spawnModal.harness}
											onChange={(e) =>
												setSpawnModal((current) => ({
													...current,
													harness: e.target.value,
												}))
											}
											disabled={availableHarnesses.length === 0}
											className="w-full rounded-lg border border-border bg-surface-secondary px-3 py-2 text-foreground disabled:opacity-50 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
										>
											{availableHarnesses.length === 0 ? (
												<option value="">No compatible harnesses available</option>
											) : (
												availableHarnesses.map((harness) => (
													<option key={harness} value={harness}>
														{harness}
													</option>
												))
											)}
										</select>
									</div>
									<div>
										<label className="mb-2 block text-sm font-medium text-foreground">
											Provider
										</label>
										{usesOpenCodeCatalog(spawnModal.harness) &&
										hasOpenCodeCatalog &&
										openCodeProviders.length > 0 ? (
											<select
												value={spawnModal.provider}
												onChange={(e) =>
													setSpawnModal((current) => {
														const providerId = e.target.value;
														const providerRecord =
															openCodeProviders.find(
																(provider) => provider.id === providerId,
															) || null;
														return {
															...current,
															provider: providerId,
															model: providerRecord?.models[0]?.id || "",
														};
													})
												}
												className="w-full rounded-lg border border-border bg-surface-secondary px-3 py-2 text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
											>
												{openCodeProviders.map((provider) => (
													<option key={provider.id} value={provider.id}>
													{provider.name}{provider.connected === false ? " · setup required" : ""}
													</option>
												))}
											</select>
										) : (
											<input
												value={spawnModal.provider}
												onChange={(e) =>
													setSpawnModal((current) => ({
														...current,
														provider: e.target.value,
													}))
												}
												placeholder={spawnDefaults.provider || "Use server default"}
												className="w-full rounded-lg border border-border bg-surface-secondary px-3 py-2 text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
											/>
										)}
									</div>
									<div>
										<label className="mb-2 block text-sm font-medium text-foreground">
											Model
										</label>
										{usesOpenCodeCatalog(spawnModal.harness) &&
										hasOpenCodeCatalog &&
										selectedOpenCodeModels.length > 0 ? (
											<select
												value={spawnModal.model}
												onChange={(e) =>
													setSpawnModal((current) => ({
														...current,
														model: e.target.value,
													}))
												}
												className="w-full rounded-lg border border-border bg-surface-secondary px-3 py-2 text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
											>
												{selectedOpenCodeModels.map((model) => (
													<option key={model.id} value={model.id}>
														{model.name}
													</option>
												))}
											</select>
										) : (
											<input
												value={spawnModal.model}
												onChange={(e) =>
													setSpawnModal((current) => ({
														...current,
														model: e.target.value,
													}))
												}
												placeholder={spawnDefaults.model || "Use server default"}
												className="w-full rounded-lg border border-border bg-surface-secondary px-3 py-2 text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
											/>
										)}
									</div>
								</div>

								{usesOpenCodeCatalog(spawnModal.harness) && hasOpenCodeCatalog && openCodeProviders.length > 0 && (
									<p className="text-sm text-muted-foreground">
										Provider and model options come from OpenCode on the selected arm host.
									</p>
								)}

								{selectedOpenCodeModel ? (
									<div className="rounded-lg border border-border bg-surface-secondary/45 p-3 text-sm text-muted-foreground">
										<div className="flex flex-wrap items-center justify-between gap-2">
											<span className="font-medium text-foreground">Model estimate</span>
											{modelPricing ? (
												<span>
													${modelPricing.input.toFixed(2)} input / ${modelPricing.output.toFixed(2)} output per 1M tokens
												</span>
											) : (
												<span>Provider did not report pricing.</span>
											)}
										</div>
										{modelPricing ? (
											<p className="mt-1 text-xs">
												A balanced 100k-token run is approximately ${modelPricing.per100k.toFixed(2)}.
											</p>
										) : null}
										{selectedOpenCodeModel.limit?.context ? (
											<p className="mt-1 text-xs">
												Context capacity: {selectedOpenCodeModel.limit.context.toLocaleString()} tokens.
											</p>
										) : null}
									</div>
								) : null}

								{contextBudgetWarning ? (
									<div className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm text-foreground">
										This template requests {selectedTemplate?.contextBudget.toLocaleString()} context tokens, but the selected model supports only {selectedOpenCodeModel?.limit?.context?.toLocaleString()}. Choose a larger-context model or a different template.
									</div>
								) : null}

								{isHighCostModel ? (
									<div className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm text-foreground">
										This is a high-cost model. Its estimated balanced 100k-token run is ${modelPricing?.per100k.toFixed(2)}; choose a lower-cost model if this arm will run frequently.
									</div>
								) : null}

								{usesOpenCodeCatalog(spawnModal.harness) && selectedOpenCodeProvider?.connected === false && (
									<div className="flex items-center justify-between gap-3 rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm text-foreground">
										<div className="flex items-start gap-2">
											<KeyRound className="mt-0.5 h-4 w-4 shrink-0" />
											<p>
												{selectedOpenCodeProvider.name} needs to be connected on {selectedSpawnAgent?.hostname || "this arm host"} before spawning.
											</p>
										</div>
										<Button
											variant="secondary"
											onPress={() => openProviderSetupModal(selectedOpenCodeProvider.id)}
										>
											Set up
										</Button>
									</div>
								)}

								{usesOpenCodeCatalog(spawnModal.harness) && !hasOpenCodeCatalog && (
									<div className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm text-foreground">
										{loadingAgentProviders ? "Loading providers from the selected arm host…" : openCodeCatalog.message ||
											"No cached authenticated OpenCode catalog is available yet. Spawn one OpenCode arm after restarting the API server, or enter provider/model manually for now."}
									</div>
								)}

								{spawnModal.name.trim() && arms.some((arm) => arm.id === spawnModal.name.trim()) && (
									<div className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm text-foreground">
										An arm named <code>{spawnModal.name.trim()}</code> already exists. Pick a
										new name for a brand new spawn, or use the row-level Recover/Spawn action
										on the existing arm card.
									</div>
								)}

								<div>
									<label className="mb-2 block text-sm font-medium text-foreground">
										Arm agent host
									</label>
									<select
										value={spawnModal.agentId}
										onChange={(e) =>
											setSpawnModal((current) => ({
												...current,
												agentId: e.target.value,
											}))
										}
										disabled={agents.length === 0}
										className="w-full rounded-lg border border-border bg-surface-secondary px-3 py-2 text-foreground disabled:opacity-50 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
									>
										{agents.length === 0 ? (
											<option value="">No arm agents connected</option>
										) : (
											agents.map((agent) => (
												<option key={agent.agentId} value={agent.agentId}>
													{agent.hostname} · {agent.agentId}
												</option>
											))
										)}
									</select>
									<p className="mt-2 text-sm text-muted-foreground">
										This defaults to the first connected arm agent host.
									</p>
								</div>

								{spawnModal.harness && isDaemonManagedHarness(spawnModal.harness) && (
									<div className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm text-foreground">
										<div className="flex items-start gap-2">
											<Server className="mt-0.5 h-4 w-4 shrink-0" />
											<p>
												<code>{spawnModal.harness}</code> is daemon-managed. A connected arm
												agent host is required for this spawn flow.
											</p>
										</div>
									</div>
								)}

								{agents.length === 0 && (
									<div className="rounded-lg border border-danger/50 bg-danger/10 p-3 text-sm text-danger">
										No arm agents are currently connected. Start <code>coleo agent start</code>{" "}
										on a host you want to run arms on, then reopen this panel.
									</div>
								)}

								{selectedSpawnAgent && (
									<p className="text-sm text-muted-foreground">
										Selected host capabilities: {selectedSpawnAgent.capabilities.join(", ")}
									</p>
								)}
							</div>

							<div className="flex shrink-0 items-center justify-between border-t border-border bg-surface-secondary/60 px-4 py-3">
								<span className="text-xs text-muted-foreground">
									The runtime host is chosen from the connected arm agents and returned by
									the API after spawn.
								</span>
								<div className="flex gap-2">
									<Button variant="ghost" onPress={closeSpawnModal}>
										Cancel
									</Button>
									<Button
										variant="primary"
										onPress={submitSpawnModal}
										isDisabled={
											!spawnModal.name.trim() ||
											!spawnModal.harness ||
											agents.length === 0 ||
											selectedOpenCodeProvider?.connected === false ||
											spawningArmId !== null ||
											arms.some((arm) => arm.id === spawnModal.name.trim())
										}
										className="gap-2"
									>
										{spawningArmId !== null ? (
											<LoaderCircle className="h-4 w-4 animate-spin" />
										) : (
											<Play className="h-4 w-4" />
										)}
										{spawningArmId !== null ? "Starting..." : "Spawn Arm"}
									</Button>
								</div>
							</div>
					</div>
				</div>
			) : null}

			<ProviderSetupModal
				agentId={spawnModal.agentId}
				agentHostname={selectedSpawnAgent?.hostname || "the selected arm host"}
				initialProviderId={providerSetupProviderId}
				providers={openCodeProviders}
				onClose={() => setProviderSetupProviderId(null)}
				onSaved={(providers) => {
					setOpenCodeProviders(providers);
					setOpenCodeCatalog({ source: "live", message: null });
				}}
			/>
		</div>
	);
}
