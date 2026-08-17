/**
 * Golden Layout workbench shell.
 *
 * The shell is the browser's window manager: it restores database-backed
 * layouts, hosts route-based view instances, surfaces background attention on
 * tabs, and exposes navigation and command-palette actions.
 */
import {
	ComponentContainer,
	ComponentItem,
	ContentItem,
	GoldenLayout,
	LayoutConfig,
	type RootItemConfig,
	type ResolvedLayoutConfig,
	Stack,
	type StackItemConfig,
	type ComponentItemConfig,
} from "golden-layout";
import {
	Bot,
	Command,
	MailPlus,
	MoreHorizontal,
	Plus,
	RotateCcw,
	Save,
	Search,
	SquareStack,
} from "lucide-react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	NAVIGATION_ROUTES,
	findAppRoute,
	getAppRouteTitle,
} from "@/app/routes";
import {
	WorkspaceCommandPalette,
	type CommandPaletteMode,
	type WorkspaceCommandAction,
} from "@/components/WorkspaceCommandPalette";
import { api, truncateMiddle, truncateStart, useMessage } from "@/lib";
import { createRandomId } from "@/lib/utils";
import { useLiveProjections } from "@/workbench/live-projections";
import {
	RESTORE_WORKSPACE_LAYOUT_EVENT,
	SAVE_WORKSPACE_LAYOUT_EVENT,
	type RestoreWorkspaceLayoutDetail,
	type SaveWorkspaceLayoutDetail,
} from "@/workbench/layout-commands";
import { useWorkbenchProfile } from "@/workbench/profile-context";
import { WorkbenchStatusBar } from "@/workbench/WorkbenchStatusBar";
import type { JsonObject } from "@/lib/api";
import type { WorkbenchChannel } from "@/workbench/types";
import {
	WorkspaceRouteProvider,
	type WorkspaceOpenMode,
	type WorkspaceRouteState,
} from "./route-context";
import "golden-layout/dist/css/goldenlayout-base.css";
import "golden-layout/dist/css/themes/goldenlayout-dark-theme.css";
import "./golden-workspace.css";

const WORKSPACE_COMPONENT_TYPE = "route";
const STORAGE_KEY = "coleo-golden-layout";
const LAYOUT_SAVE_DELAY_MS = 750;

// Mirrors LocationSelector.TypeId from golden-layout. The package declares it
// as a const enum, which cannot be imported at runtime under esbuild.
const LOCATION_SELECTOR_FIRST_ROW = 4;
const LOCATION_SELECTOR_ROOT = 7;

function profileStorageKey(profileId: string): string {
	return `${STORAGE_KEY}:${profileId}`;
}

function routeAttentionChannels(pathname: string): WorkbenchChannel[] {
	switch (pathname) {
		case "/tasks":
		case "/grid":
			return ["tasks"];
		case "/bugs":
			return ["bugs"];
		case "/brain":
			return ["brain", "activity"];
		case "/arms":
		case "/viewer":
			return ["arms", "arm-events", "agents"];
		case "/processes":
			return ["arms", "arm-events", "agents", "tasks", "bugs"];
		case "/mail":
			return ["mail"];
		case "/messaging":
			return ["brain", "mail", "arms", "arm-events", "activity"];
		case "/activity":
			return ["activity"];
		case "/proposals":
			return ["proposals"];
		case "/settings":
			return ["workbench"];
		default:
			return [];
	}
}

interface RoutePanelState extends WorkspaceRouteState {
	panelId: string;
	title?: string;
}

interface PanelInstance {
	container: ComponentContainer;
	hostElement: HTMLDivElement;
	route: RoutePanelState;
}

function normalizeLegacyRoute(route: RoutePanelState): RoutePanelState {
	if (["/activity", "/proposals", "/status-reports"].includes(route.pathname)) {
		return {
			...route,
			pathname: "/messaging",
			search: "?facet=history",
			title: undefined,
		};
	}
	return route;
}

function createPanelId(): string {
	return createRandomId("panel");
}

function createRoutePanelState(
	pathname: string,
	search: string,
	panelId = createPanelId(),
	title?: string,
): RoutePanelState {
	return normalizeLegacyRoute({
		panelId,
		pathname,
		search,
		title,
	});
}

function createComponentConfig(route: RoutePanelState): ComponentItemConfig {
	const title = route.title ?? getAppRouteTitle(route.pathname, route.search);
	return {
		type: "component",
		componentType: WORKSPACE_COMPONENT_TYPE,
		title,
		componentState: route,
	};
}

function createStackConfig(route: RoutePanelState): StackItemConfig {
	return {
		type: "stack",
		content: [createComponentConfig(route)],
		activeItemIndex: 0,
	};
}

function createDefaultLayout(route: RoutePanelState): LayoutConfig {
	return {
		root: {
			type: "stack",
			content: [
				{
					type: "component",
					componentType: WORKSPACE_COMPONENT_TYPE,
					title: getAppRouteTitle(route.pathname, route.search),
					componentState: route,
				},
			],
		},
		settings: {
			reorderEnabled: true,
			popoutWholeStack: false,
		},
	};
}

function isRoutePanelState(value: unknown): value is RoutePanelState {
	if (!value || typeof value !== "object") {
		return false;
	}

	const candidate = value as Partial<RoutePanelState>;
	return (
		typeof candidate.panelId === "string" &&
		typeof candidate.pathname === "string" &&
		typeof candidate.search === "string" &&
		(candidate.title === undefined || typeof candidate.title === "string")
	);
}

function renderRoutePanel(
	route: RoutePanelState,
	onRouteChange: (route: WorkspaceRouteState) => void,
	onOpenRoute: (route: WorkspaceRouteState, mode?: WorkspaceOpenMode) => void,
	onCloseRoute: () => void,
) {
	const matchedRoute = findAppRoute(route.pathname);
	if (!matchedRoute) {
		return (
			<div className="golden-workspace-panel flex items-center justify-center">
				<div className="text-center space-y-2">
					<SquareStack className="mx-auto h-10 w-10 text-muted-foreground" />
					<p className="font-medium">Unknown panel route</p>
					<p className="text-sm text-muted-foreground">{route.pathname}</p>
				</div>
			</div>
		);
	}

	const RouteComponent = matchedRoute.component;

	return (
		<div className="golden-workspace-panel">
			<WorkspaceRouteProvider
				route={route}
				onRouteChange={onRouteChange}
				onOpenRoute={onOpenRoute}
				onCloseRoute={onCloseRoute}
			>
				<RouteComponent />
			</WorkspaceRouteProvider>
		</div>
	);
}

function findFirstStack(item: ContentItem | undefined): Stack | null {
	if (!item) {
		return null;
	}

	if (ContentItem.isStack(item)) {
		return item;
	}

	for (const child of item.contentItems) {
		const stack = findFirstStack(child);
		if (stack) {
			return stack;
		}
	}

	return null;
}

export function GoldenWorkspace() {
	const { isMessageModalOpen, markMessageOpened, openNewMessage } = useMessage();
	const { profile, layouts, isLoading: profileLoading } = useWorkbenchProfile();
	const { attention, clearAttention } = useLiveProjections();
	const layoutHostRef = useRef<HTMLDivElement>(null);
	const layoutRef = useRef<GoldenLayout | null>(null);
	const launcherRef = useRef<HTMLDivElement>(null);
	const paneMenuRef = useRef<HTMLDivElement>(null);
	const panelInstancesRef = useRef(new Map<string, PanelInstance>());
	const activePanelIdRef = useRef<string | null>(null);
	const layoutSaveTimerRef = useRef<number | null>(null);
	const loadedProfileIdRef = useRef<string | null>(null);
	const suppressLayoutSaveRef = useRef(false);
	const [panelInstances, setPanelInstances] = useState<
		Record<string, PanelInstance>
	>({});
	const [launcherOpen, setLauncherOpen] = useState(false);
	const [paneMenuOpen, setPaneMenuOpen] = useState(false);
	const [paletteMode, setPaletteMode] = useState<CommandPaletteMode | null>(
		null,
	);
	const [projectName, setProjectName] = useState<string | null>(null);
	const [projectCwd, setProjectCwd] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void api.status().then((status) => {
			if (!cancelled) {
				setProjectName(status.projectName);
				setProjectCwd(status.cwd);
			}
		}).catch((error) => {
			console.error("Failed to fetch project identity:", error);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const persistWorkspaceLayout = useCallback(() => {
		if (!layoutRef.current || suppressLayoutSaveRef.current) {
			return;
		}

		const savedLayout = layoutRef.current.saveLayout();
		window.localStorage.setItem(
			profileStorageKey(profile?.id ?? "local"),
			JSON.stringify(LayoutConfig.fromResolved(savedLayout)),
		);
		if (!profile) return;
		if (layoutSaveTimerRef.current !== null) {
			window.clearTimeout(layoutSaveTimerRef.current);
		}
		const portableLayout = LayoutConfig.fromResolved(savedLayout);
		layoutSaveTimerRef.current = window.setTimeout(() => {
			layoutSaveTimerRef.current = null;
			void api.saveWorkbenchLayout(`current:${profile.id}`, {
				profileId: profile.id,
				name: "Current workspace",
				description: "Automatically saved Golden Layout workspace",
				layout: portableLayout as unknown as JsonObject,
				isDefault: true,
				shared: false,
			}).catch((error) => {
				console.error("Failed to save workbench layout:", error);
			});
		}, LAYOUT_SAVE_DELAY_MS);
	}, [profile]);

	const updatePanelRoute = useCallback(
		(panelId: string, nextRoute: RoutePanelState) => {
			const panelInstance = panelInstancesRef.current.get(panelId);
			if (!panelInstance) {
				return;
			}

			const nextTitle =
				nextRoute.title ??
				getAppRouteTitle(nextRoute.pathname, nextRoute.search);
			panelInstance.route = nextRoute;
			panelInstance.container.setTitle(nextTitle);

			panelInstancesRef.current.set(panelId, panelInstance);
			setPanelInstances((current) => ({
				...current,
				[panelId]: {
					...panelInstance,
					route: nextRoute,
				},
			}));

			persistWorkspaceLayout();
		},
		[persistWorkspaceLayout],
	);

	const focusPanel = useCallback(
		(item: ComponentItem) => {
			const panelInstance = Array.from(panelInstancesRef.current.values()).find(
				(panel) => panel.container.parent === item,
			);
			if (!panelInstance) {
				return;
			}

			activePanelIdRef.current = panelInstance.route.panelId;
			panelInstance.container.setTitle(
				panelInstance.route.title ??
					getAppRouteTitle(panelInstance.route.pathname, panelInstance.route.search),
			);
			const channels = routeAttentionChannels(panelInstance.route.pathname);
			if (channels.length > 0) clearAttention(channels);

			if (
				item.parent instanceof Stack &&
				item.parent.getActiveComponentItem() !== item
			) {
				item.parent.setActiveComponentItem(item, true);
			}
		},
		[clearAttention],
	);

	useEffect(() => {
		for (const panel of panelInstancesRef.current.values()) {
			const channels = routeAttentionChannels(panel.route.pathname);
			const needsAttention = panel.route.panelId !== activePanelIdRef.current &&
				channels.some((channel) => (attention.channels[channel] ?? 0) > 0);
			const title = panel.route.title ?? getAppRouteTitle(panel.route.pathname, panel.route.search);
			panel.container.setTitle(needsAttention ? `● ${title}` : title);
		}
	}, [attention]);

	const findPanelItem = useCallback(
		(pathname: string, search: string, panelId?: string) => {
			if (panelId) {
				return panelInstancesRef.current.get(panelId)?.container.parent ?? null;
			}

			const panelInstance = Array.from(panelInstancesRef.current.values()).find(
				(panel) =>
					panel.route.pathname === pathname && panel.route.search === search,
			);

			return panelInstance?.container.parent ?? null;
		},
		[],
	);

	const getTargetStack = useCallback((): Stack | null => {
		const layout = layoutRef.current;
		if (!layout) {
			return null;
		}

		const focusedStack = layout.focusedComponentItem?.parent;
		if (focusedStack instanceof Stack) {
			return focusedStack;
		}

		if (activePanelIdRef.current) {
			const activeItem = panelInstancesRef.current.get(activePanelIdRef.current)
				?.container.parent;
			if (
				activeItem instanceof ComponentItem &&
				activeItem.parent instanceof Stack
			) {
				return activeItem.parent;
			}
		}

		return findFirstStack(layout.rootItem);
	}, []);

	const focusPanelByRoute = useCallback(
		(route: RoutePanelState) => {
			// Poll for the panel instance since it may not be created immediately
			// after addComponent is called
			let attempts = 0;
			const maxAttempts = 50; // 500ms total

			const tryFocus = () => {
				const panelInstance = panelInstancesRef.current.get(route.panelId);
				if (panelInstance?.container?.parent) {
					focusPanel(panelInstance.container.parent);
					return;
				}

				attempts++;
				if (attempts < maxAttempts) {
					setTimeout(tryFocus, 10);
				}
			};

			// Start polling after a short delay to allow React to render
			setTimeout(tryFocus, 10);
		},
		[focusPanel],
	);

	const openRouteAsTab = useCallback(
		(pathname: string, search: string) => {
			const layout = layoutRef.current;
			if (!layout) {
				return;
			}

			const panelState = createRoutePanelState(pathname, search);
			const targetStack = getTargetStack();

			if (targetStack) {
				targetStack.addComponent(
					WORKSPACE_COMPONENT_TYPE,
					panelState,
					getAppRouteTitle(panelState.pathname, panelState.search),
				);
			} else {
				layout.addComponentAtLocation(
					WORKSPACE_COMPONENT_TYPE,
					panelState,
					getAppRouteTitle(panelState.pathname, panelState.search),
					[{ typeId: LOCATION_SELECTOR_ROOT }],
				);
			}

			focusPanelByRoute(panelState);
		},
		[focusPanelByRoute, getTargetStack],
	);

	const focusOrOpenRoute = useCallback(
		(pathname: string, search: string) => {
			const existingItem = findPanelItem(pathname, search);
			if (existingItem) {
				focusPanel(existingItem);
				return;
			}

			openRouteAsTab(pathname, search);
		},
		[findPanelItem, focusPanel, openRouteAsTab],
	);

	const splitRouteHorizontally = useCallback(
		(pathname: string, search: string, title?: string) => {
			const layout = layoutRef.current;
			if (!layout) {
				return;
			}

			const panelState = createRoutePanelState(
				pathname,
				search,
				createPanelId(),
				title,
			);
			const targetStack = getTargetStack();

			if (!targetStack) {
				// No target stack, just add as a new tab
				layout.addComponentAtLocation(
					WORKSPACE_COMPONENT_TYPE,
					panelState,
					title ?? getAppRouteTitle(panelState.pathname, panelState.search),
					[{ typeId: LOCATION_SELECTOR_ROOT }],
				);
				focusPanelByRoute(panelState);
				return;
			}

			// Check if root is a stack - if so, we need to convert it to a row with two stacks
			const rootItem = layout.rootItem;
			if (rootItem && ContentItem.isStack(rootItem)) {
				// Save current stack's content and active tab index
				const currentStackContent = rootItem.contentItems.map((item) => ({
					type: "component",
					componentType: WORKSPACE_COMPONENT_TYPE,
					title: (item as ComponentItem).title,
					componentState: (item as ComponentItem).container.state,
				}));

				// Get the active tab index from the root stack (which contains all tabs)
				const activeComponentItem = rootItem.getActiveComponentItem();
				const activeItemIndex = activeComponentItem
					? rootItem.contentItems.indexOf(activeComponentItem)
					: 0;

				// Create new row layout with two stacks
				const newLayout: LayoutConfig = {
					root: {
						type: "row",
						content: [
							{
								type: "stack",
								content: currentStackContent,
								activeItemIndex: Math.max(0, activeItemIndex),
							},
							createStackConfig(panelState),
						],
					} as unknown as RootItemConfig,
					settings: {
						reorderEnabled: true,
						popoutWholeStack: false,
					},
				};

				layout.loadLayout(newLayout);
				focusPanelByRoute(panelState);
				return;
			}

			// If root is already a row, add as sibling
			if (
				rootItem &&
				(rootItem as unknown as { type: string }).type === "row"
			) {
			layout.addComponentAtLocation(
				WORKSPACE_COMPONENT_TYPE,
				panelState,
				title ?? getAppRouteTitle(panelState.pathname, panelState.search),
				[{ typeId: LOCATION_SELECTOR_FIRST_ROW }], // Add as a sibling in the first row
			);
				focusPanelByRoute(panelState);
				return;
			}

			// Fallback: just add as a new tab
			layout.addComponentAtLocation(
				WORKSPACE_COMPONENT_TYPE,
				panelState,
				title ?? getAppRouteTitle(panelState.pathname, panelState.search),
				[{ typeId: LOCATION_SELECTOR_ROOT }],
			);
			focusPanelByRoute(panelState);
		},
		[focusPanelByRoute, getTargetStack],
	);

	const openActionRoute = useCallback(
		(pathname: string, search: string, title?: string) => {
			const layout = layoutRef.current;
			if (!layout) {
				return;
			}

			const panelState = createRoutePanelState(
				pathname,
				search,
				createPanelId(),
				title,
			);
			const panelTitle = title ?? getAppRouteTitle(pathname, search);
			const rootItem = layout.rootItem;

			if (rootItem && ContentItem.isStack(rootItem)) {
				const currentStackContent = rootItem.contentItems.map((item) => ({
					type: "component" as const,
					componentType: WORKSPACE_COMPONENT_TYPE,
					title: (item as ComponentItem).title,
					componentState: (item as ComponentItem).container.state,
				}));
				const activeComponentItem = rootItem.getActiveComponentItem();
				const activeItemIndex = activeComponentItem
					? rootItem.contentItems.indexOf(activeComponentItem)
					: 0;

				layout.loadLayout({
					root: {
						type: "row",
						content: [
							{
								type: "stack",
								content: currentStackContent,
								activeItemIndex: Math.max(0, activeItemIndex),
							},
							createStackConfig(panelState),
						],
					} as unknown as RootItemConfig,
					settings: {
						reorderEnabled: true,
						popoutWholeStack: false,
					},
				});
				focusPanelByRoute(panelState);
				return;
			}

			const rightStack = (() => {
				const findRightmostStack = (item: ContentItem | undefined): Stack | null => {
					if (!item) return null;
					if (ContentItem.isStack(item)) return item;
					for (let index = item.contentItems.length - 1; index >= 0; index--) {
						const stack = findRightmostStack(item.contentItems[index]);
						if (stack) return stack;
					}
					return null;
				};

				return findRightmostStack(rootItem);
			})();

		if (rightStack) {
			rightStack.addComponent(WORKSPACE_COMPONENT_TYPE, panelState, panelTitle);
		} else {
			layout.addComponentAtLocation(
				WORKSPACE_COMPONENT_TYPE,
				panelState,
				panelTitle,
				[{ typeId: LOCATION_SELECTOR_ROOT }],
			);
		}

			focusPanelByRoute(panelState);
		},
		[focusPanelByRoute],
	);

	useEffect(() => {
		if (!isMessageModalOpen) {
			return;
		}

		openActionRoute("/compose", "", "New Message");
		markMessageOpened();
	}, [isMessageModalOpen, markMessageOpened, openActionRoute]);

	const openRouteFromHref = useCallback(
		(href: string, mode: WorkspaceOpenMode) => {
			const url = new URL(href, window.location.origin);
			if (mode === "action") {
				openActionRoute(url.pathname, url.search);
				return;
			}

			if (mode === "split") {
				splitRouteHorizontally(url.pathname, url.search, undefined);
				return;
			}

			if (mode === "tab") {
				openRouteAsTab(url.pathname, url.search);
				return;
			}

			focusOrOpenRoute(url.pathname, url.search);
		},
		[focusOrOpenRoute, openActionRoute, openRouteAsTab, splitRouteHorizontally],
	);

	const openViewerForArm = useCallback(
		(armId: string) => {
			focusOrOpenRoute("/viewer", `?arm=${encodeURIComponent(armId)}`);
		},
		[focusOrOpenRoute],
	);

	const closeMenus = useCallback(() => {
		setLauncherOpen(false);
		setPaneMenuOpen(false);
	}, []);

	const openPalette = useCallback((mode: CommandPaletteMode) => {
		setLauncherOpen(false);
		setPaneMenuOpen(false);
		setPaletteMode(mode);
	}, []);

	const closePalette = useCallback(() => {
		setPaletteMode(null);
	}, []);

	useEffect(() => {
		if (!launcherOpen && !paneMenuOpen) {
			return;
		}

		function handlePointerDown(event: MouseEvent) {
			const target = event.target as Node;
			if (
				launcherRef.current?.contains(target) ||
				paneMenuRef.current?.contains(target)
			) {
				return;
			}

			closeMenus();
		}

		function handleEscape(event: KeyboardEvent) {
			if (event.key === "Escape") {
				closeMenus();
			}
		}

		document.addEventListener("mousedown", handlePointerDown);
		document.addEventListener("keydown", handleEscape);

		return () => {
			document.removeEventListener("mousedown", handlePointerDown);
			document.removeEventListener("keydown", handleEscape);
		};
	}, [closeMenus, launcherOpen, paneMenuOpen]);

	const resetWorkspace = useCallback(() => {
		window.localStorage.removeItem(profileStorageKey(profile?.id ?? "local"));
		layoutRef.current?.loadLayout(
			createDefaultLayout(createRoutePanelState("/", "")),
		);
		window.requestAnimationFrame(() => {
			persistWorkspaceLayout();
		});
	}, [persistWorkspaceLayout, profile?.id]);

	const saveWorkspace = useCallback(() => {
		persistWorkspaceLayout();
	}, [persistWorkspaceLayout]);

	useEffect(() => {
		const saveNamedLayout = (event: Event) => {
			if (!layoutRef.current || !profile) return;
			const detail = (event as CustomEvent<SaveWorkspaceLayoutDetail>).detail;
			if (!detail?.name.trim()) return;
			const existing = layouts.find((layout) =>
				layout.profileId === profile.id
				&& layout.name.toLocaleLowerCase() === detail.name.trim().toLocaleLowerCase()
			);
			const portableLayout = LayoutConfig.fromResolved(layoutRef.current.saveLayout());
			void api.saveWorkbenchLayout(existing?.id ?? createRandomId("layout"), {
				profileId: profile.id,
				name: detail.name.trim(),
				description: "Named Golden Layout workspace",
				layout: portableLayout as unknown as JsonObject,
				isDefault: existing?.isDefault ?? false,
				shared: detail.shared,
			}).catch((error) => {
				console.error("Failed to save named workspace layout:", error);
			});
		};

		const restoreNamedLayout = (event: Event) => {
			if (!layoutRef.current) return;
			const detail = (event as CustomEvent<RestoreWorkspaceLayoutDetail>).detail;
			const record = layouts.find((layout) => layout.id === detail?.layoutId);
			if (!record) return;
			suppressLayoutSaveRef.current = true;
			try {
				layoutRef.current.loadLayout(record.layout as unknown as LayoutConfig);
			} catch (error) {
				console.error("Failed to restore named workspace layout:", error);
			}
			window.requestAnimationFrame(() => {
				suppressLayoutSaveRef.current = false;
				persistWorkspaceLayout();
			});
		};

		window.addEventListener(SAVE_WORKSPACE_LAYOUT_EVENT, saveNamedLayout);
		window.addEventListener(RESTORE_WORKSPACE_LAYOUT_EVENT, restoreNamedLayout);
		return () => {
			window.removeEventListener(SAVE_WORKSPACE_LAYOUT_EVENT, saveNamedLayout);
			window.removeEventListener(RESTORE_WORKSPACE_LAYOUT_EVENT, restoreNamedLayout);
		};
	}, [layouts, persistWorkspaceLayout, profile]);

	const commandActions = useMemo((): WorkspaceCommandAction[] => {
		return [
			{
				id: "spawn-arm",
				label: "Spawn Arm",
				description: "Open the arm spawn flow",
				group: "Commands",
				icon: Bot,
				run: () => openActionRoute("/arms", "?spawn=1", "Spawn Arm"),
			},
			{
				id: "new-message",
				label: "New Message",
				description: "Compose a message to brain or an arm",
				group: "Commands",
				icon: MailPlus,
				shortcut: "N",
				run: () => openNewMessage(),
			},
			{
				id: "search",
				label: "Search workspace",
				description: "Find arms, bugs, tasks, and more",
				group: "Commands",
				icon: Search,
				shortcut: "⌘P",
				run: () => openPalette("search"),
			},
			{
				id: "duplicate-pane",
				label: "Duplicate Pane",
				description: "Open the active view in a new tab",
				group: "Layout",
				icon: Plus,
				run: () => {
					const active =
						(activePanelIdRef.current &&
							panelInstancesRef.current.get(activePanelIdRef.current)?.route) ||
						Array.from(panelInstancesRef.current.values())[0]?.route;
					if (!active) return;
					openRouteAsTab(active.pathname, active.search);
				},
			},
			{
				id: "save-layout",
				label: "Save Layout",
				description: "Persist the current multi-pane layout",
				group: "Layout",
				icon: Save,
				run: () => saveWorkspace(),
			},
			{
				id: "reset-layout",
				label: "Reset Layout",
				description: "Restore the default single-pane workspace",
				group: "Layout",
				icon: RotateCcw,
				run: () => resetWorkspace(),
			},
		];
	}, [openActionRoute, openNewMessage, openPalette, openRouteAsTab, resetWorkspace, saveWorkspace]);

	useEffect(() => {
		function handleGlobalKeydown(event: KeyboardEvent) {
			const target = event.target as HTMLElement | null;
			const tag = target?.tagName;
			const isTypingTarget =
				tag === "INPUT" ||
				tag === "TEXTAREA" ||
				tag === "SELECT" ||
				target?.isContentEditable === true;

			const meta = event.metaKey || event.ctrlKey;
			const key = event.key.toLowerCase();

			// ⌘P → entity search, ⌘⇧P → command palette (VS Code style)
			if (meta && key === "p") {
				event.preventDefault();
				openPalette(event.shiftKey ? "actions" : "search");
				return;
			}

			if (meta && key === "k" && !event.shiftKey) {
				event.preventDefault();
				openPalette("actions");
				return;
			}

			if (event.key === "Escape" && paletteMode) {
				event.preventDefault();
				closePalette();
				return;
			}

			if (isTypingTarget || paletteMode) {
				return;
			}
		}

		document.addEventListener("keydown", handleGlobalKeydown);
		return () => document.removeEventListener("keydown", handleGlobalKeydown);
	}, [closePalette, openPalette, paletteMode]);

	useEffect(() => {
		document.title = "Coleo Observatory - Workspace";
	}, []);

	// Golden Layout is an imperative singleton. Keep its event callbacks current
	// through a ref so profile/layout query refreshes do not tear down and rebuild
	// the complete pane tree after every database-backed auto-save.
	const layoutRuntimeRef = useRef({
		profile,
		layouts,
		focusPanel,
		persistWorkspaceLayout,
	});
	layoutRuntimeRef.current = {
		profile,
		layouts,
		focusPanel,
		persistWorkspaceLayout,
	};

	useEffect(() => {
		if (!layoutHostRef.current || layoutRef.current || profileLoading) {
			return;
		}

		const initialProfile = layoutRuntimeRef.current.profile;
		const initialLayouts = layoutRuntimeRef.current.layouts;
		const layout = new GoldenLayout(layoutHostRef.current);
		layoutRef.current = layout;
		loadedProfileIdRef.current = initialProfile?.id ?? "local";

		layout.registerComponentFactoryFunction(
			WORKSPACE_COMPONENT_TYPE,
			(container, state) => {
				const restoredRoute = isRoutePanelState(state)
					? state
					: createRoutePanelState("/", "");
				const route = normalizeLegacyRoute(restoredRoute);
				const hostElement = document.createElement("div");
				hostElement.className = "golden-workspace-panel-host";
				container.element.appendChild(hostElement);
				container.setTitle(
					route.title ?? getAppRouteTitle(route.pathname, route.search),
				);
				container.stateRequestEvent = () =>
					panelInstancesRef.current.get(route.panelId)?.route ?? route;

				const panelInstance: PanelInstance = {
					container,
					hostElement,
					route,
				};

				panelInstancesRef.current.set(route.panelId, panelInstance);
				setPanelInstances((current) => ({
					...current,
					[route.panelId]: panelInstance,
				}));

				container.on("destroy", () => {
					panelInstancesRef.current.delete(route.panelId);
					setPanelInstances((current) => {
						const next = { ...current };
						delete next[route.panelId];
						return next;
					});
				});

				return undefined;
			},
		);

		layout.on("focus", (event) => {
			if (event.target instanceof ComponentItem) {
				layoutRuntimeRef.current.focusPanel(event.target);
			}
		});

		layout.on("stateChanged", () => {
			layoutRuntimeRef.current.persistWorkspaceLayout();
		});

		const requestedPathname = window.location.pathname;
		const requestedSearch = window.location.search;
		const requestedRoute = findAppRoute(requestedPathname)
			&& (requestedPathname !== "/" || requestedSearch)
			? createRoutePanelState(requestedPathname, requestedSearch)
			: null;
		const serverLayout = initialLayouts.find((item) =>
			item.profileId === initialProfile?.id && item.isDefault
		)?.layout;
		const savedLayout = window.localStorage.getItem(
			profileStorageKey(initialProfile?.id ?? "local"),
		) ?? (initialProfile?.id === "local" ? window.localStorage.getItem(STORAGE_KEY) : null);
		if (requestedRoute) {
			// A deep link represents an explicit view request. Start a focused
			// workspace for it instead of allowing a saved layout to obscure it.
			layout.loadLayout(createDefaultLayout(requestedRoute));
		} else if (serverLayout) {
			try {
				layout.loadLayout(serverLayout as unknown as LayoutConfig);
			} catch (error) {
				console.error("Failed to restore database workspace layout:", error);
				layout.loadLayout(createDefaultLayout(createRoutePanelState("/", "")));
			}
		} else if (savedLayout) {
			try {
				const parsedLayout = JSON.parse(savedLayout) as LayoutConfig & {
					resolved?: boolean;
				};
				const normalizedLayout = parsedLayout.resolved
					? LayoutConfig.fromResolved(
							parsedLayout as unknown as ResolvedLayoutConfig,
						)
					: parsedLayout;
				layout.loadLayout(normalizedLayout);
			} catch (error) {
				console.error("Failed to restore saved workspace layout:", error);
				window.localStorage.removeItem(profileStorageKey(initialProfile?.id ?? "local"));
				layout.loadLayout(createDefaultLayout(createRoutePanelState("/", "")));
			}
		} else {
			layout.loadLayout(createDefaultLayout(createRoutePanelState("/", "")));
		}

		const resizeObserver = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (!entry) {
				return;
			}

			layout.setSize(entry.contentRect.width, entry.contentRect.height);
		});

		resizeObserver.observe(layoutHostRef.current);
		const currentPanelInstances = panelInstancesRef.current;

		return () => {
			if (layoutSaveTimerRef.current !== null) {
				window.clearTimeout(layoutSaveTimerRef.current);
				layoutSaveTimerRef.current = null;
			}
			resizeObserver.disconnect();
			layout.destroy();
			layoutRef.current = null;
			currentPanelInstances.clear();
			setPanelInstances({});
		};
	}, [profileLoading]);

	useEffect(() => {
		const layout = layoutRef.current;
		if (!layout || !profile || profileLoading || loadedProfileIdRef.current === profile.id) {
			return;
		}

		if (layoutSaveTimerRef.current !== null) {
			window.clearTimeout(layoutSaveTimerRef.current);
			layoutSaveTimerRef.current = null;
		}
		const serverLayout = layouts.find((item) =>
			item.profileId === profile.id && item.isDefault
		)?.layout;
		const localLayout = window.localStorage.getItem(profileStorageKey(profile.id));
		let targetLayout: LayoutConfig = createDefaultLayout(createRoutePanelState("/", ""));

		if (serverLayout) {
			targetLayout = serverLayout as unknown as LayoutConfig;
		} else if (localLayout) {
			try {
				const parsedLayout = JSON.parse(localLayout) as LayoutConfig & { resolved?: boolean };
				targetLayout = parsedLayout.resolved
					? LayoutConfig.fromResolved(parsedLayout as unknown as ResolvedLayoutConfig)
					: parsedLayout;
			} catch (error) {
				console.error("Failed to restore profile workspace layout:", error);
			}
		}

		suppressLayoutSaveRef.current = true;
		loadedProfileIdRef.current = profile.id;
		try {
			layout.loadLayout(targetLayout);
		} catch (error) {
			console.error("Failed to switch profile workspace layout:", error);
			layout.loadLayout(createDefaultLayout(createRoutePanelState("/", "")));
		}
		window.requestAnimationFrame(() => {
			suppressLayoutSaveRef.current = false;
		});
	}, [layouts, profile, profileLoading]);

	const panelPortals = useMemo(
		() =>
			Object.values(panelInstances).map((panel) =>
				createPortal(
					renderRoutePanel(
						panel.route,
						(nextRoute) =>
							updatePanelRoute(panel.route.panelId, {
								...nextRoute,
								panelId: panel.route.panelId,
							}),
						(nextRoute, mode = "focus") => {
							if (mode === "split") {
								splitRouteHorizontally(
									nextRoute.pathname,
									nextRoute.search,
									nextRoute.title,
								);
								return;
							}

							if (mode === "action") {
								openActionRoute(
									nextRoute.pathname,
									nextRoute.search,
									nextRoute.title,
								);
								return;
							}

							if (mode === "tab") {
								openRouteAsTab(nextRoute.pathname, nextRoute.search);
								return;
							}

							focusOrOpenRoute(nextRoute.pathname, nextRoute.search);
						},
						() => panel.container.close(),
					),
					panel.hostElement,
					panel.route.panelId,
				),
			),
		[
			focusOrOpenRoute,
			openActionRoute,
			openRouteAsTab,
			panelInstances,
			splitRouteHorizontally,
			updatePanelRoute,
		],
	);

	return (
		<div className="observatory-backdrop golden-workspace-shell flex h-screen">
			<div className="flex-1 min-w-0 flex flex-col">
				<header className="golden-workspace-dock px-3 pt-3 pb-2">
					<div className="golden-workspace-dock-inner">
						<div className="golden-dock-left">
							<div className="golden-launcher" ref={launcherRef}>
								<button
									type="button"
									className="golden-launcher-button"
									onClick={() => {
										setPaneMenuOpen(false);
										setPaletteMode(null);
										setLauncherOpen((current) => !current);
									}}
									aria-haspopup="menu"
									aria-expanded={launcherOpen}
									aria-label="Open launcher"
									title="Open a view"
								>
									<span className="golden-launcher-badge" aria-hidden="true">
										<img
											src="/brand/coleo-pet-v2.png"
											width="64"
											height="64"
											alt=""
										/>
									</span>
								</button>

								{launcherOpen ? (
									<div
										className="golden-launcher-menu"
										role="menu"
										aria-label="Open workspace view"
									>
										<div className="golden-launcher-menu-header">
											<div className="font-semibold text-foreground">
												Open a view
											</div>
											<div className="text-xs text-muted-foreground">
												Tab opens in the current stack · + splits beside it
											</div>
										</div>

										<div className="golden-launcher-menu-list">
											{NAVIGATION_ROUTES.map((route) => (
												<div
													key={route.id}
													className="golden-launcher-menu-row"
												>
													<button
														type="button"
														className="golden-launcher-menu-action"
														onClick={(e) => {
															e.preventDefault();
															e.stopPropagation();
															openRouteFromHref(route.href, "tab");
															setLauncherOpen(false);
														}}
														title={`Open ${route.label} in a new tab`}
													>
														<route.icon className="h-4 w-4" />
														<span>{route.label}</span>
													</button>

													<button
														type="button"
														className="golden-launcher-menu-plus"
														onClick={(e) => {
															e.preventDefault();
															e.stopPropagation();
															openRouteFromHref(route.href, "split");
															setLauncherOpen(false);
														}}
														aria-label={`Open ${route.label} in a new pane to the right`}
														title={`Open ${route.label} in a new pane to the right`}
													>
														<Plus className="h-3.5 w-3.5" />
													</button>
												</div>
											))}
										</div>

										<div className="golden-launcher-menu-footer">
											<button
												type="button"
												className="golden-launcher-menu-secondary"
												onClick={() => {
													setLauncherOpen(false);
													openPalette("search");
												}}
											>
												<Search className="h-3.5 w-3.5" />
												<span>Search arms & records</span>
												<kbd className="workspace-palette-kbd">⌘P</kbd>
											</button>
											<button
												type="button"
												className="golden-launcher-menu-secondary"
												onClick={() => {
													setLauncherOpen(false);
													openPalette("actions");
												}}
											>
												<Command className="h-3.5 w-3.5" />
												<span>Command palette</span>
												<kbd className="workspace-palette-kbd">⌘⇧P</kbd>
											</button>
										</div>
									</div>
								) : null}
							</div>

							<div className="golden-dock-project">
								<span className="golden-dock-project-app">COLEO</span>
								<span className="golden-dock-project-name" title={projectCwd ?? undefined}>
									{projectName
										? truncateMiddle(projectName, 32)
										: projectCwd
											? truncateStart(projectCwd, 32)
											: "…"}
								</span>
							</div>
						</div>

						<div className="golden-dock-center">
							<button
								type="button"
								className="golden-dock-search"
								onClick={() => openPalette("search")}
								title="Search (⌘P)"
							>
								<Search className="h-4 w-4 shrink-0 opacity-60" />
								<span className="golden-dock-search-label">
									Search arms, bugs, tasks…
								</span>
								<kbd className="workspace-palette-kbd">⌘P</kbd>
							</button>
						</div>

						<div
							className="golden-dock-right"
							role="toolbar"
							aria-label="Workspace actions"
						>
							<button
								type="button"
								className="golden-dock-button golden-dock-button--primary"
								onClick={() => openActionRoute("/arms", "?spawn=1", "Spawn Arm")}
								title="Spawn Arm"
							>
								<Bot className="h-4 w-4" />
								<span className="golden-dock-button-label">Spawn</span>
							</button>
							<button
								type="button"
								className="golden-dock-button"
								onClick={openNewMessage}
								title="New Message"
							>
								<MailPlus className="h-4 w-4" />
								<span className="golden-dock-button-label">Message</span>
							</button>
							<button
								type="button"
								className="golden-dock-icon-button"
								onClick={() => openPalette("actions")}
								aria-label="Command palette"
								title="Command palette (⌘⇧P)"
							>
								<Command className="h-4 w-4" />
							</button>
							<div className="golden-pane-menu" ref={paneMenuRef}>
								<button
									type="button"
									className="golden-dock-icon-button"
									onClick={() => {
										setLauncherOpen(false);
										setPaletteMode(null);
										setPaneMenuOpen((current) => !current);
									}}
									aria-haspopup="menu"
									aria-expanded={paneMenuOpen}
									aria-label="Layout actions"
									title="Layout"
								>
									<MoreHorizontal className="h-4 w-4" />
								</button>

								{paneMenuOpen ? (
									<div
										className="golden-pane-menu-dropdown"
										role="menu"
										aria-label="Layout actions"
									>
										<button
											type="button"
											className="golden-pane-menu-action"
											onClick={() => {
												const active =
													(activePanelIdRef.current &&
														panelInstancesRef.current.get(
															activePanelIdRef.current,
														)?.route) ||
													Array.from(panelInstancesRef.current.values())[0]
														?.route;
												if (active) {
													openRouteAsTab(active.pathname, active.search);
												}
												setPaneMenuOpen(false);
											}}
										>
											<Plus className="h-4 w-4" />
											<span>Duplicate Pane</span>
										</button>
										<button
											type="button"
											className="golden-pane-menu-action"
											onClick={() => {
												saveWorkspace();
												setPaneMenuOpen(false);
											}}
										>
											<Save className="h-4 w-4" />
											<span>Save Layout</span>
										</button>
										<button
											type="button"
											className="golden-pane-menu-action"
											onClick={() => {
												resetWorkspace();
												setPaneMenuOpen(false);
											}}
										>
											<RotateCcw className="h-4 w-4" />
											<span>Reset Layout</span>
										</button>
									</div>
								) : null}
							</div>
						</div>
					</div>
				</header>

				<div className="flex-1 min-h-0 px-3 pb-3">
					<div ref={layoutHostRef} className="golden-workspace-layout h-full" />
				</div>
				<WorkbenchStatusBar
					onOpenProcesses={() => focusOrOpenRoute("/processes", "")}
					onOpenProfiles={() => focusOrOpenRoute("/settings", "")}
				/>
			</div>

			<WorkspaceCommandPalette
				mode={paletteMode}
				onClose={closePalette}
				actions={commandActions}
				onOpenRoute={(pathname, search = "") =>
					focusOrOpenRoute(pathname, search)
				}
				onOpenArm={openViewerForArm}
			/>

			{panelPortals}
		</div>
	);
}
