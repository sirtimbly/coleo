import { useEffect, useMemo, useState, useCallback } from "react";
import {
	AlertTriangle,
	BarChart3,
	KeyRound,
	LayoutGrid,
	LoaderCircle,
	MoreHorizontal,
	Play,
	Plus,
	RefreshCw,
	RotateCcw,
	Server,
	Table2,
	Trash2,
	X,
} from "lucide-react";
import { Button, ButtonGroup, Dropdown } from "@heroui/react";
import { generateArmName } from "../../../cli/arm-names";
import {
	api,
	type AgentInfo,
	type Arm,
	type ArmTemplateSummary,
	type OpenCodeProvider,
} from "@/lib";
import { AllArmsTelemetryOverview } from "@/components/AllArmsTelemetryOverview";
import { StatusBadge } from "@/components/StatusBadge";
import { usePageTitle } from '@/hooks/usePageTitle';
import { useToast } from "@/hooks/useToast";
import { useWebSocket } from "@/hooks/useWebSocket";
import {
	useWorkspaceCloseRoute,
	useWorkspaceOpenRoute,
	useWorkspaceSearchParams,
} from '@/workspace/route-context';
import { ProviderSetupModal } from "@/components/ProviderSetupModal";
import {
	WorkbenchEmptyState,
	WorkbenchSurface,
} from "@/design-system/WorkbenchSurface";
import {
	ProjectionFilterMenu,
	ProjectionSearch,
} from "@/design-system/ProjectionControls";
import { ToolbarTemplateRows } from "@/design-system/toolbar-template";
import { ArmAvatar } from "@/workbench/ArmAvatar";
import { ArmCollectionRow } from "@/workbench/ArmCollectionRow";
import {
	ARM_COLLECTION_SCOPE_LABELS,
	armMatchesCollectionScope,
	armMatchesSearch,
	armNeedsAttention,
	type ArmCollectionScope,
} from "@/workbench/arm-collection-model";
import { useToolbarTemplate } from "@/workbench/toolbar-template-context";

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

type ArmListView = "grid" | "cards";

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

interface ArmActionProps {
	arm: Arm;
	spawningArmId: string | null;
	markingStuckArmId: string | null;
	onDelete: () => void;
	onSpawn: () => void;
	onRecover: () => void;
	onMarkStuck: () => void;
}

interface ArmRowProps extends ArmActionProps {
	attention: boolean;
	onOpen: () => void;
}

function ArmActionControls({
	arm,
	spawningArmId,
	markingStuckArmId,
	onDelete,
	onSpawn,
	onRecover,
	onMarkStuck,
}: ArmActionProps) {
	const action = armActionFor(arm);
	const isRecover = action?.kind === "recover";
	const isSpawning = spawningArmId === arm.id;
	const isMarkingStuck = markingStuckArmId === arm.id;

	return (
		<>
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
			{arm.status !== "stopped" && arm.status !== "planning_blocked" && (
				<span className="hidden 2xl:inline-flex">
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
				</span>
			)}
			<Dropdown>
				<Dropdown.Trigger
					aria-label={`Actions for ${arm.name}`}
					className="inline-flex h-7 w-7 cursor-pointer items-center justify-center text-muted-foreground outline-none transition-colors hover:bg-surface-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
				>
					<MoreHorizontal className="h-3.5 w-3.5" />
				</Dropdown.Trigger>
				<Dropdown.Popover placement="bottom end">
					<Dropdown.Menu
						onAction={(key) => {
							if (key === "stuck") onMarkStuck();
							if (key === "delete") onDelete();
						}}
					>
						{arm.status !== "stopped" && arm.status !== "planning_blocked" ? (
							<Dropdown.Item key="stuck" id="stuck" textValue="Mark stuck" isDisabled={markingStuckArmId !== null}>
								<span className="flex items-center gap-2 text-warning">
									<AlertTriangle className="h-4 w-4" />
									{arm.recoveryRequestedAt ? "Recovery requested" : "Mark stuck"}
								</span>
							</Dropdown.Item>
						) : null}
						<Dropdown.Item key="delete" id="delete" textValue="Delete arm">
							<span className="flex items-center gap-2 text-danger">
								<Trash2 className="h-4 w-4" />
								Delete arm
							</span>
						</Dropdown.Item>
					</Dropdown.Menu>
				</Dropdown.Popover>
			</Dropdown>
		</>
	);
}

function ArmRow(props: ArmRowProps) {
	return (
		<ArmCollectionRow
			arm={props.arm}
			attention={props.attention}
			onOpen={props.onOpen}
			actions={<ArmActionControls {...props} />}
		/>
	);
}

function ArmCard(props: ArmRowProps) {
	const { arm, attention, onOpen } = props;
	const currentWork = arm.currentBugTitle ?? arm.currentTaskSubject;
	const contextUsage = arm.contextBudget
		? `${Math.round(Math.min((arm.currentContextUsed / arm.contextBudget) * 100, 100))}%`
		: "—";
	const runtimeLocation = arm.host ?? arm.agentId ?? "Not assigned";

	return (
		<article className={`min-w-0 overflow-hidden border bg-surface ${attention ? "border-warning/35 bg-warning/5" : "border-border"}`}>
			<div
				role="button"
				tabIndex={0}
				onClick={onOpen}
				onKeyDown={(event) => {
					if (event.key !== "Enter" && event.key !== " ") return;
					event.preventDefault();
					onOpen();
				}}
				className="cursor-pointer px-4 py-3 outline-none transition-colors hover:bg-surface-secondary/50 focus-visible:bg-surface-secondary"
			>
				<div className="flex min-w-0 items-start gap-3">
					<ArmAvatar armId={arm.id} className="h-10 w-10" />
					<div className="min-w-0 flex-1">
						<div className="flex min-w-0 items-center gap-2">
							<h2 className="truncate text-sm font-semibold text-foreground">{arm.name}</h2>
							<StatusBadge status={arm.status} />
						</div>
						<p className="mt-0.5 truncate text-[0.68rem] text-muted-foreground" title={`${arm.provider ?? "Default"} · ${arm.model ?? "Default"}`}>
							{arm.provider ?? "Default"} · {arm.model ?? "Default"}
						</p>
					</div>
				</div>
				<p className={`mt-3 line-clamp-2 min-h-10 text-xs leading-5 ${arm.status === "planning_blocked" ? "font-medium text-warning" : "text-muted-foreground"}`}>
					{arm.status === "planning_blocked"
						? "Waiting for the Brain to finish the project planning gate"
						: currentWork
							? `${arm.currentBugTitle ? "Bug" : "Task"} · ${currentWork}`
							: "Waiting for the brain to assign work"}
				</p>
				<dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-3 text-xs">
					<div className="min-w-0">
						<dt className="text-[0.6rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Runtime</dt>
						<dd className="mt-0.5 truncate capitalize text-foreground">{arm.runtime?.state ?? arm.status}</dd>
					</div>
					<div className="min-w-0">
						<dt className="text-[0.6rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Context</dt>
						<dd className="mt-0.5 tabular-nums text-foreground">{contextUsage}</dd>
					</div>
					<div className="min-w-0 col-span-2">
						<dt className="text-[0.6rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Host</dt>
						<dd className="mt-0.5 truncate text-foreground" title={runtimeLocation}>{runtimeLocation}</dd>
					</div>
				</dl>
			</div>
			<div className="flex min-h-10 items-center justify-end gap-1 border-t border-border px-3 py-1.5">
				<ArmActionControls {...props} />
			</div>
		</article>
	);
}

export function ArmsPage() {
	const [searchParams] = useWorkspaceSearchParams();
	const openWorkspaceRoute = useWorkspaceOpenRoute();
	const closeWorkspaceRoute = useWorkspaceCloseRoute('/arms');
	const toolbarTemplate = useToolbarTemplate("arms");
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
	const [searchText, setSearchText] = useState("");
	const [scope, setScope] = useState<ArmCollectionScope>("all");
	const [telemetryExpanded, setTelemetryExpanded] = useState(true);
	const [listView, setListView] = useState<ArmListView>("grid");
	const [spawnModal, setSpawnModal] = useState<NewArmModalState>(
		DEFAULT_SPAWN_MODAL_STATE,
	);
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
			source: selectedOpenCodeModel.pricing.source,
			estimated: selectedOpenCodeModel.pricing.estimated ?? true,
			fetchedAt: selectedOpenCodeModel.pricing.fetchedAt,
			matchedModel: selectedOpenCodeModel.pricing.matchedModel,
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

	const armScopeOptions = useMemo(() => {
		const counts: Record<ArmCollectionScope, number> = {
			all: arms.length,
			attention: 0,
			working: 0,
			waiting: 0,
		};
		for (const arm of arms) {
			if (armNeedsAttention(arm)) counts.attention++;
			else if (arm.status === "busy" || arm.status === "running") counts.working++;
			else counts.waiting++;
		}
		return (Object.keys(ARM_COLLECTION_SCOPE_LABELS) as ArmCollectionScope[]).map((id) => ({
			id,
			label: ARM_COLLECTION_SCOPE_LABELS[id],
			count: counts[id],
		}));
	}, [arms]);
	const visibleArms = useMemo(
		() => arms.filter((arm) => armMatchesCollectionScope(arm, scope) && armMatchesSearch(arm, searchText)),
		[arms, scope, searchText],
	);
	const ArmRenderer = listView === "cards" ? ArmCard : ArmRow;
	const toolbarWidgets = {
		"arms.search": (
			<ProjectionSearch
				value={searchText}
				onChange={setSearchText}
				placeholder="Search arms…"
				className="min-w-36 max-w-xl"
			/>
		),
		"arms.telemetry": (
			<Button
				size="sm"
				variant={telemetryExpanded ? "secondary" : "ghost"}
				aria-pressed={telemetryExpanded}
				aria-controls="arms-telemetry-panel"
				aria-label="Toggle fleet telemetry"
				onPress={() => setTelemetryExpanded((current) => !current)}
				className="h-8 min-w-0 shrink-0 px-2"
			>
				<BarChart3 className="h-3.5 w-3.5" />
				<span className="hidden sm:inline">Telemetry</span>
			</Button>
		),
		"arms.refresh": (
			<Button
				isIconOnly
				size="sm"
				variant="ghost"
				onPress={() => void loadArms()}
				aria-label="Refresh arms"
			>
				<RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
			</Button>
		),
		"arms.spawn": (
			<Button
				size="sm"
				variant="primary"
				onPress={openSpawnPanel}
				isDisabled={loading}
				aria-label="Spawn arm"
				className="min-w-0 px-2.5"
			>
				<Plus className="h-4 w-4" />
				<span className="hidden sm:inline">Spawn</span>
			</Button>
		),
		"arms.display": (
			<ButtonGroup size="sm" variant="ghost" aria-label="Arm list display">
				<Button
					aria-pressed={listView === "grid"}
					variant={listView === "grid" ? "secondary" : "ghost"}
					onPress={() => setListView("grid")}
					className="h-7 min-w-0 px-2"
				>
					<Table2 className="h-3.5 w-3.5" aria-hidden="true" />
					Grid
				</Button>
				<Button
					aria-pressed={listView === "cards"}
					variant={listView === "cards" ? "secondary" : "ghost"}
					onPress={() => setListView("cards")}
					className="h-7 min-w-0 px-2"
				>
					<LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" />
					Cards
				</Button>
			</ButtonGroup>
		),
		"arms.result-count": (
			<span className="inline-flex shrink-0 self-center items-center text-xs tabular-nums text-muted-foreground">
				{visibleArms.length} of {arms.length}
			</span>
		),
		"arms.scope": (
			<ProjectionFilterMenu
				label="View"
				value={scope}
				options={armScopeOptions}
				onChange={(value) => setScope(value as ArmCollectionScope)}
				className="h-7 min-h-7"
			/>
		),
	};

	if (error) {
		return (
			<div className="p-8">
				<WorkbenchSurface className="border-danger">
					<WorkbenchEmptyState title="Unable to load Arms" description={error} />
				</WorkbenchSurface>
			</div>
		);
	}

	return (
		<div
			className={
				isSpawnPage
					? "min-h-full overflow-auto bg-surface p-3 sm:p-5"
					: "flex h-full min-h-0 flex-col overflow-hidden bg-background"
			}
		>
			{!isSpawnPage ? (
				<>
					<ToolbarTemplateRows template={toolbarTemplate} widgets={toolbarWidgets} />

					<div className="min-h-0 flex-1 overflow-auto">
					{telemetryExpanded ? (
						<section
							id="arms-telemetry-panel"
							aria-label="Fleet telemetry"
							className="border-b border-border"
						>
							<AllArmsTelemetryOverview
								embedded
								contextBudget={
									loading ? undefined : arms.reduce((total, arm) => total + arm.contextBudget, 0)
								}
							/>
						</section>
					) : null}

					{loading ? (
						<div className={listView === "cards" ? "grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3" : "space-y-2 p-4"}>
							{[1, 2, 3, 4].map((i) => (
								<div key={i} className={`${listView === "cards" ? "h-56" : "h-16"} animate-pulse bg-default-100/60`} />
							))}
						</div>
					) : arms.length === 0 ? (
						<WorkbenchEmptyState
							title="No arms registered yet"
							description="Spawn an Arm to let the brain assign work."
							action={<code className="border border-border bg-surface-secondary px-3 py-2 text-xs">coleo arm spawn</code>}
							icon={<Server className="h-4 w-4" />}
						/>
					) : visibleArms.length === 0 ? (
						<WorkbenchEmptyState
							title="No matching arms"
							description="Try another search or fleet view."
							action={<Button size="sm" variant="ghost" onPress={() => { setSearchText(""); setScope("all"); }}>Clear filters</Button>}
							icon={<Server className="h-4 w-4" />}
						/>
					) : (
						<div className={listView === "cards" ? "grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3" : "bg-surface"}>
							{visibleArms.map((arm) => (
								<ArmRenderer
									key={arm.id}
									arm={arm}
									attention={armNeedsAttention(arm)}
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
					)}
					</div>
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
											<span className="font-medium text-foreground">Model estimate*</span>
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
										{modelPricing?.source === "openrouter" ? (
											<p className="mt-1 text-xs">
												Approximate market rate via OpenRouter
												{modelPricing.matchedModel ? ` (${modelPricing.matchedModel})` : ""}.
											</p>
										) : modelPricing?.source === "known" ? (
											<p className="mt-1 text-xs">
												Approximate catalog rate, not actual provider billing.
											</p>
										) : null}
										{selectedOpenCodeModel.limit?.context ? (
											<p className="mt-1 text-xs">
												Context capacity: {selectedOpenCodeModel.limit.context.toLocaleString()} tokens.
											</p>
										) : null}
										{modelPricing ? (
											<p className="mt-2 text-xs">
												* Estimate assumes per-token billing. Your provider account or plan may include usage or not charge per token.
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
