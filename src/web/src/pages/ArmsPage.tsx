import { useEffect, useMemo, useState, useCallback } from "react";
import { Coins, LoaderCircle, Play, Plus, RotateCcw, Server, Trash2, X, Zap } from "lucide-react";
import { createPortal } from "react-dom";
import { Card, Chip, Button } from "@heroui/react";
import { generateArmName } from "../../../cli/arm-names";
import {
	api,
	type AgentInfo,
	type Arm,
	type ArmTemplateSummary,
	type OpenCodeProvider,
} from "@/lib";
import { StatusBadge } from "@/components";
import { usePageTitle } from '@/hooks/usePageTitle';
import { useToast } from "@/hooks/useToast";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useWorkspaceSearchParams } from '@/workspace/route-context';

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

export function ArmsPage() {
	usePageTitle('Coleo Observatory - Arms');
	const [searchParams, setSearchParams] = useWorkspaceSearchParams();
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
	const [spawnModal, setSpawnModal] = useState<NewArmModalState>(
		DEFAULT_SPAWN_MODAL_STATE,
	);
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
			setOpenCodeProviders(catalogIsCacheBacked ? providersRes.providers : []);
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

	const hasCachedOpenCodeCatalog = openCodeCatalog.source === "cache";

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

	const closeSpawnModal = useCallback(() => {
		setSpawnModal(DEFAULT_SPAWN_MODAL_STATE);
	}, []);

	const submitSpawnModal = useCallback(async () => {
		const name = spawnModal.name.trim();
		const provider = spawnModal.provider.trim();
		const model = spawnModal.model.trim();

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
			setSpawnModal(DEFAULT_SPAWN_MODAL_STATE);
		} catch (err) {
			showError(
				err instanceof Error ? err.message : "Failed to spawn arm",
				"Spawn Failed",
			);
		} finally {
			setSpawningArmId(null);
		}
	}, [agents.length, arms, loadArms, showError, showSuccess, spawnModal]);

	useEffect(() => {
		if (searchParams.get("spawn") !== "1") {
			return;
		}

		openSpawnModal();
		setSearchParams({});
	}, [openSpawnModal, searchParams, setSearchParams]);

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

			if (usesOpenCodeCatalog(nextHarness) && hasCachedOpenCodeCatalog && openCodeProviders.length > 0) {
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
		hasCachedOpenCodeCatalog,
		openCodeProviders,
		spawnDefaults.harness,
		spawnDefaults.model,
		spawnDefaults.provider,
		spawnModal.isOpen,
	]);

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
		<div className="p-8 space-y-8 overflow-auto">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-2xl font-bold">Arms</h1>
					<p className="text-muted-foreground">Manage your AI agents</p>
				</div>
				<Button
					variant="primary"
					className="gap-2"
					onPress={openSpawnModal}
					isDisabled={loading}
				>
					<Plus className="h-4 w-4" />
					Spawn Arm
				</Button>
			</div>

			{loading ? (
				<div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
					{[1, 2, 3, 4].map((i) => (
						<Card key={i} className="h-48">
							<Card.Content>
								<div className="h-full bg-muted animate-pulse rounded" />
							</Card.Content>
						</Card>
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
				<div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
					{arms.map((arm) => (
						<Card key={arm.id}>
							<Card.Header className="flex flex-row items-start justify-between">
								<div>
									<Card.Title className="flex items-center gap-2">
										{arm.name}
										<StatusBadge status={arm.status} />
									</Card.Title>
									<p className="text-sm text-muted-foreground mt-1">
										{arm.harness}
										{(arm.provider || arm.model) && (
											<span className="block mt-1">
												{arm.provider && (
													<Chip size="sm" variant="soft">
														{arm.provider}
													</Chip>
												)}
												{arm.provider && arm.model && <span> · </span>}
												{arm.model && (
													<Chip size="sm" variant="soft" color="success">
														{arm.model}
													</Chip>
												)}
											</span>
										)}
									</p>
								</div>
								<Button
									isIconOnly
									variant="ghost"
									size="sm"
									onPress={() => handleDelete(arm.id)}
									className="text-danger hover:text-danger"
								>
									<Trash2 className="h-4 w-4" />
								</Button>
							</Card.Header>
							<Card.Content>
								<div className="space-y-3 text-sm">
									<div>
										<div className="flex justify-between text-muted-foreground mb-1">
											<span>Context</span>
											<span>
												{arm.currentContextUsed.toLocaleString()} /{" "}
												{arm.contextBudget.toLocaleString()}
											</span>
										</div>
										<div className="h-2 bg-default-200 rounded-full overflow-hidden">
											<div
												className="h-full bg-primary transition-all"
												style={{
													width: `${Math.min((arm.currentContextUsed / arm.contextBudget) * 100, 100)}%`,
												}}
											/>
										</div>
									</div>

									{(arm.totalTokens !== undefined ||
										arm.totalCost !== undefined) && (
										<div className="flex items-center gap-4 text-muted-foreground">
											{arm.totalTokens !== undefined && (
												<div className="flex items-center gap-1">
													<Zap className="h-3 w-3" />
													<span>{arm.totalTokens.toLocaleString()} tokens</span>
												</div>
											)}
											{arm.totalCost !== undefined && arm.totalCost > 0 && (
												<div className="flex items-center gap-1">
													<Coins className="h-3 w-3" />
													<span>${arm.totalCost.toFixed(4)}</span>
												</div>
											)}
										</div>
									)}

									{(arm.currentTaskSubject || arm.currentBugTitle) && (
										<div className="p-2 bg-default-100 rounded">
											<div className="text-xs text-muted-foreground mb-1">
												{arm.currentBugTitle ? '🐛 Current bug' : '📋 Current task'}
											</div>
											<div className="text-sm truncate">
												{arm.currentBugTitle || arm.currentTaskSubject}
											</div>
										</div>
									)}

									{arm.reputation !== undefined && (
										<div className="flex justify-between">
											<span className="text-muted-foreground">Reputation</span>
											<span className="font-medium">{arm.reputation}/100</span>
										</div>
									)}

									<div className="flex justify-between">
										<span className="text-muted-foreground">Last active</span>
										<span>
											{arm.lastActivityAt
												? new Date(arm.lastActivityAt).toLocaleString()
												: "Never"}
										</span>
									</div>

									{arm.runtime && (
										<>
											<div className="flex justify-between items-center gap-3">
												<span className="text-muted-foreground">Runtime state</span>
												<Chip
													size="sm"
													variant="soft"
													color={runtimeTone(arm.runtime.state)}
												>
													{arm.runtime.state}
												</Chip>
											</div>

											<div className="flex justify-between gap-3">
												<span className="text-muted-foreground">Last output</span>
												<span className="text-right">
													{formatAge(arm.runtime.secondsSinceOutput)}
												</span>
											</div>

											<div className="flex justify-between gap-3">
												<span className="text-muted-foreground">Heartbeat</span>
												<span className="text-right">
													{formatAge(arm.runtime.secondsSinceHeartbeat)}
												</span>
											</div>

											<div className="rounded bg-default-100 p-2 text-xs text-muted-foreground">
												{arm.runtime.reason}
											</div>

											<div className="rounded bg-default-100/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">
												status={arm.runtime.signals.dbStatus}
												{" · "}
												{arm.runtime.signals.hasPid ? "pid" : "no-pid"}
												{" · "}
												{arm.runtime.signals.hasPort ? "port" : "no-port"}
												{" · "}
												{arm.runtime.signals.hasSessionId ? "session" : "no-session"}
												{" · "}
												{arm.runtime.signals.hasAgentId ? "agent" : "local"}
												{" · "}
												{arm.runtime.signals.hasWorkdir ? "workdir" : "no-workdir"}
												{" · "}
												{arm.runtime.signals.hasAssignedTask ? "task" : "no-task"}
											</div>
										</>
									)}

									{(arm.host || arm.agentId) && (
									<div className="flex justify-between gap-3">
										<span className="text-muted-foreground">Runtime</span>
										<span className="text-right">
											{arm.host || arm.agentId}
											{arm.host && arm.agentId ? ` · ${arm.agentId}` : ""}
										</span>
									</div>
								)}

									{(arm.port || arm.pid) && (
										<div className="flex justify-between gap-3">
											<span className="text-muted-foreground">Process</span>
											<span className="text-right">
												{arm.port ? `:${arm.port}` : "no port"}
												{arm.pid ? ` · pid ${arm.pid}` : ""}
											</span>
										</div>
									)}
								</div>

								{arm.personality && (
									<div className="mt-4 p-3 bg-default-100 rounded text-xs text-muted-foreground">
										{arm.personality.slice(0, 150)}...
									</div>
								)}

								{(() => {
									const action = armActionFor(arm);
									if (!action) {
										return null;
									}

									const isRecover = action.kind === "recover";
									return (
											<div className="mt-4 flex justify-end">
												<Button
													variant={isRecover ? "secondary" : "primary"}
													size="sm"
													onPress={() =>
														void (isRecover ? handleRecover(arm) : handleSpawn(arm))
													}
													isDisabled={spawningArmId !== null}
													className={isRecover ? "gap-2 text-warning" : "gap-2"}
												>
												{spawningArmId === arm.id ? (
													<LoaderCircle className="h-4 w-4 animate-spin" />
												) : isRecover ? (
													<RotateCcw className="h-4 w-4" />
												) : (
													<Play className="h-4 w-4" />
												)}
												{spawningArmId === arm.id
													? isRecover
														? "Recovering..."
														: "Starting..."
													: action.label}
											</Button>
										</div>
									);
								})()}
							</Card.Content>
						</Card>
					))}
				</div>
			)}

			{spawnModal.isOpen &&
				createPortal(
					<div className="fixed inset-0 z-50 flex items-center justify-center">
						<div
							className="absolute inset-0 bg-black/60 backdrop-blur-sm"
							onClick={closeSpawnModal}
						/>
						<div className="relative mx-4 w-full max-w-2xl rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl">
							<div className="flex items-center justify-between border-b border-zinc-700 px-4 py-3">
								<div>
									<h2 className="text-lg font-semibold text-white">Spawn New Arm</h2>
									<p className="text-sm text-zinc-400">
										Create a new arm record and start it on a connected arm agent host.
									</p>
								</div>
								<button
									onClick={closeSpawnModal}
									className="rounded p-1 text-zinc-400 transition-colors hover:text-white"
								>
									<X className="h-5 w-5" />
								</button>
							</div>

							<div className="space-y-5 p-4">
								<div className="rounded-lg border border-cyan-900/60 bg-cyan-950/30 p-3 text-sm text-cyan-100">
									The API server is the control plane. Spawn sends a command to a connected
									arm agent. If that agent is running on another host, the arm will start on
									that host rather than on the API server machine.
								</div>

								<div className="grid gap-4 md:grid-cols-2">
									<div>
										<label className="mb-2 block text-sm font-medium text-zinc-300">
											Arm name
										</label>
										<input
											value={spawnModal.name}
											onChange={(e) =>
												setSpawnModal((current) => ({
													...current,
													name: e.target.value,
												}))
											}
											placeholder="e.g. explorer-2"
											className="w-full rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-2 text-white placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
										/>
									</div>
									<div>
										<label className="mb-2 block text-sm font-medium text-zinc-300">
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
											className="w-full rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-2 text-white focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
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
									<p className="text-sm text-zinc-400">
										Using <code>{selectedTemplate.filename}</code> from{" "}
										<code>.coleo/templates</code> to prefill harness and model settings.
									</p>
								)}

								<div className="grid gap-4 md:grid-cols-3">
									<div>
										<label className="mb-2 block text-sm font-medium text-zinc-300">
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
											className="w-full rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-2 text-white disabled:opacity-50 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
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
										<label className="mb-2 block text-sm font-medium text-zinc-300">
											Provider
										</label>
										{usesOpenCodeCatalog(spawnModal.harness) &&
										hasCachedOpenCodeCatalog &&
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
												className="w-full rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-2 text-white focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
											>
												{openCodeProviders.map((provider) => (
													<option key={provider.id} value={provider.id}>
														{provider.name}
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
												className="w-full rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-2 text-white placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
											/>
										)}
									</div>
									<div>
										<label className="mb-2 block text-sm font-medium text-zinc-300">
											Model
										</label>
										{usesOpenCodeCatalog(spawnModal.harness) &&
										hasCachedOpenCodeCatalog &&
										selectedOpenCodeModels.length > 0 ? (
											<select
												value={spawnModal.model}
												onChange={(e) =>
													setSpawnModal((current) => ({
														...current,
														model: e.target.value,
													}))
												}
												className="w-full rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-2 text-white focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
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
												className="w-full rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-2 text-white placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
											/>
										)}
									</div>
								</div>

								{usesOpenCodeCatalog(spawnModal.harness) && hasCachedOpenCodeCatalog && openCodeProviders.length > 0 && (
									<p className="text-sm text-zinc-400">
										Provider and model options come from the cached authenticated OpenCode
										catalog in <code>.coleo/cache/opencode-models.json</code>.
									</p>
								)}

								{usesOpenCodeCatalog(spawnModal.harness) && !hasCachedOpenCodeCatalog && (
									<div className="rounded-lg border border-amber-900/60 bg-amber-950/30 p-3 text-sm text-amber-100">
										{openCodeCatalog.message ||
											"No cached authenticated OpenCode catalog is available yet. Spawn one OpenCode arm after restarting the API server, or enter provider/model manually for now."}
									</div>
								)}

								{spawnModal.name.trim() && arms.some((arm) => arm.id === spawnModal.name.trim()) && (
									<div className="rounded-lg border border-amber-900/60 bg-amber-950/30 p-3 text-sm text-amber-100">
										An arm named <code>{spawnModal.name.trim()}</code> already exists. Pick a
										new name for a brand new spawn, or use the row-level Recover/Spawn action
										on the existing arm card.
									</div>
								)}

								<div>
									<label className="mb-2 block text-sm font-medium text-zinc-300">
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
										className="w-full rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-2 text-white disabled:opacity-50 focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
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
									<p className="mt-2 text-sm text-zinc-400">
										This defaults to the first connected arm agent host.
									</p>
								</div>

								{spawnModal.harness && isDaemonManagedHarness(spawnModal.harness) && (
									<div className="rounded-lg border border-amber-900/60 bg-amber-950/30 p-3 text-sm text-amber-100">
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
										on a host you want to run arms on, then reopen this modal.
									</div>
								)}

								{selectedSpawnAgent && (
									<p className="text-sm text-zinc-400">
										Selected host capabilities: {selectedSpawnAgent.capabilities.join(", ")}
									</p>
								)}
							</div>

							<div className="flex items-center justify-between border-t border-zinc-700 bg-zinc-800/50 px-4 py-3">
								<span className="text-xs text-zinc-500">
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
					</div>,
					document.body,
				)}
		</div>
	);
}
