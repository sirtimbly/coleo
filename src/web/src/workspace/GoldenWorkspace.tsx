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
} from 'golden-layout';
import {
  Bot,
  LayoutPanelTop,
  MailPlus,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Save,
  SquareStack,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { NAVIGATION_ROUTES, findAppRoute, getAppRouteTitle } from '@/app/routes';
import { WorkspaceArmRail } from '@/components/WorkspaceArmRail';
import { useMessage } from '@/lib';
import {
  WorkspaceRouteProvider,
  type WorkspaceOpenMode,
  type WorkspaceRouteState,
} from './route-context';
import 'golden-layout/dist/css/goldenlayout-base.css';
import 'golden-layout/dist/css/themes/goldenlayout-dark-theme.css';
import './golden-workspace.css';

const WORKSPACE_COMPONENT_TYPE = 'route';
const STORAGE_KEY = 'coleo-golden-layout';

interface RoutePanelState extends WorkspaceRouteState {
  panelId: string;
  title?: string;
}

interface PanelInstance {
  container: ComponentContainer;
  hostElement: HTMLDivElement;
  route: RoutePanelState;
}

function createPanelId(): string {
  return `panel-${crypto.randomUUID()}`;
}

function createRoutePanelState(pathname: string, search: string, panelId = createPanelId(), title?: string): RoutePanelState {
  return {
    panelId,
    pathname,
    search,
    title,
  };
}

function createComponentConfig(route: RoutePanelState): ComponentItemConfig {
  const title = route.title ?? getAppRouteTitle(route.pathname, route.search);
  return {
    type: 'component',
    componentType: WORKSPACE_COMPONENT_TYPE,
    title,
    componentState: route,
  };
}

function createStackConfig(route: RoutePanelState): StackItemConfig {
  return {
    type: 'stack',
    content: [createComponentConfig(route)],
    activeItemIndex: 0,
  };
}

function createDefaultLayout(route: RoutePanelState): LayoutConfig {
  return {
    root: {
      type: 'stack',
      content: [
        {
          type: 'component',
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
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<RoutePanelState>;
  return (
    typeof candidate.panelId === 'string' &&
    typeof candidate.pathname === 'string' &&
    typeof candidate.search === 'string' &&
    (candidate.title === undefined || typeof candidate.title === 'string')
  );
}

function renderRoutePanel(
  route: RoutePanelState,
  onRouteChange: (route: WorkspaceRouteState) => void,
  onOpenRoute: (route: WorkspaceRouteState, mode?: WorkspaceOpenMode) => void,
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
      <WorkspaceRouteProvider route={route} onRouteChange={onRouteChange} onOpenRoute={onOpenRoute}>
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
  const { openNewMessage } = useMessage();
  const layoutHostRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<GoldenLayout | null>(null);
  const launcherRef = useRef<HTMLDivElement>(null);
  const paneMenuRef = useRef<HTMLDivElement>(null);
  const panelInstancesRef = useRef(new Map<string, PanelInstance>());
  const activePanelIdRef = useRef<string | null>(null);
  const [panelInstances, setPanelInstances] = useState<Record<string, PanelInstance>>({});
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [paneMenuOpen, setPaneMenuOpen] = useState(false);

  const persistWorkspaceLayout = useCallback(() => {
    if (!layoutRef.current) {
      return;
    }

    const savedLayout = layoutRef.current.saveLayout();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(LayoutConfig.fromResolved(savedLayout)));
  }, []);

  const updatePanelRoute = useCallback(
    (panelId: string, nextRoute: RoutePanelState) => {
      const panelInstance = panelInstancesRef.current.get(panelId);
      if (!panelInstance) {
        return;
      }

      const nextTitle = nextRoute.title ?? getAppRouteTitle(nextRoute.pathname, nextRoute.search);
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

  const focusPanel = useCallback((item: ComponentItem) => {
    const panelInstance = Array.from(panelInstancesRef.current.values()).find(
      (panel) => panel.container.parent === item,
    );
    if (!panelInstance) {
      return;
    }

    activePanelIdRef.current = panelInstance.route.panelId;
    persistWorkspaceLayout();

    if (item.parent instanceof Stack) {
      item.parent.setActiveComponentItem(item, true);
    }
  }, [persistWorkspaceLayout]);

  const findPanelItem = useCallback((pathname: string, search: string, panelId?: string) => {
    if (panelId) {
      return panelInstancesRef.current.get(panelId)?.container.parent ?? null;
    }

    const panelInstance = Array.from(panelInstancesRef.current.values()).find(
      (panel) => panel.route.pathname === pathname && panel.route.search === search,
    );

    return panelInstance?.container.parent ?? null;
  }, []);

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
      const activeItem = panelInstancesRef.current.get(activePanelIdRef.current)?.container.parent;
      if (activeItem instanceof ComponentItem && activeItem.parent instanceof Stack) {
        return activeItem.parent;
      }
    }

    return findFirstStack(layout.rootItem);
  }, []);

  const focusPanelByRoute = useCallback((route: RoutePanelState) => {
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
  }, [focusPanel]);

  const openRouteAsTab = useCallback((pathname: string, search: string) => {
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
        [{ typeId: 7 }],
      );
    }

    focusPanelByRoute(panelState);
  }, [focusPanelByRoute, getTargetStack]);

  const focusOrOpenRoute = useCallback((pathname: string, search: string) => {
    const existingItem = findPanelItem(pathname, search);
    if (existingItem) {
      focusPanel(existingItem);
      return;
    }

    openRouteAsTab(pathname, search);
  }, [findPanelItem, focusPanel, openRouteAsTab]);

  const splitRouteHorizontally = useCallback((pathname: string, search: string, title?: string) => {
    const layout = layoutRef.current;
    if (!layout) {
      return;
    }

    const panelState = createRoutePanelState(pathname, search, createPanelId(), title);
    const targetStack = getTargetStack();

    if (!targetStack) {
      // No target stack, just add as a new tab
      layout.addComponentAtLocation(
        WORKSPACE_COMPONENT_TYPE,
        panelState,
        title ?? getAppRouteTitle(panelState.pathname, panelState.search),
        [{ typeId: 7 }],
      );
      focusPanelByRoute(panelState);
      return;
    }

    // Check if root is a stack - if so, we need to convert it to a row with two stacks
    const rootItem = layout.rootItem;
    if (rootItem && ContentItem.isStack(rootItem)) {
      // Save current stack's content and active tab index
      const currentStackContent = rootItem.contentItems.map(item => ({
        type: 'component',
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
          type: 'row',
          content: [
            {
              type: 'stack',
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
    if (rootItem && (rootItem as unknown as { type: string }).type === 'row') {
      layout.addComponentAtLocation(
        WORKSPACE_COMPONENT_TYPE,
        panelState,
        title ?? getAppRouteTitle(panelState.pathname, panelState.search),
        [{ typeId: 2 }], // Add as sibling in a row
      );
      focusPanelByRoute(panelState);
      return;
    }

    // Fallback: just add as a new tab
    layout.addComponentAtLocation(
      WORKSPACE_COMPONENT_TYPE,
      panelState,
      title ?? getAppRouteTitle(panelState.pathname, panelState.search),
      [{ typeId: 7 }],
    );
    focusPanelByRoute(panelState);
  }, [focusPanelByRoute, getTargetStack]);

  const openRouteFromHref = useCallback((href: string, mode: 'focus' | 'tab' | 'split') => {
    const url = new URL(href, window.location.origin);

      if (mode === 'split') {
        splitRouteHorizontally(url.pathname, url.search, undefined);
        return;
      }

    if (mode === 'tab') {
      openRouteAsTab(url.pathname, url.search);
      return;
    }

    focusOrOpenRoute(url.pathname, url.search);
  }, [focusOrOpenRoute, openRouteAsTab, splitRouteHorizontally]);

  const openViewerForArm = useCallback((armId: string) => {
    focusOrOpenRoute('/viewer', `?arm=${encodeURIComponent(armId)}`);
  }, [focusOrOpenRoute]);

  useEffect(() => {
    if (!launcherOpen && !paneMenuOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (launcherRef.current?.contains(target) || paneMenuRef.current?.contains(target)) {
        return;
      }

      setLauncherOpen(false);
      setPaneMenuOpen(false);
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setLauncherOpen(false);
        setPaneMenuOpen(false);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [launcherOpen, paneMenuOpen]);

  const resetWorkspace = useCallback(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    layoutRef.current?.loadLayout(createDefaultLayout(createRoutePanelState('/', '')));
    window.requestAnimationFrame(() => {
      persistWorkspaceLayout();
    });
  }, [persistWorkspaceLayout]);

  const saveWorkspace = useCallback(() => {
    persistWorkspaceLayout();
  }, [persistWorkspaceLayout]);

  useEffect(() => {
    document.title = 'Coleo Observatory - Workspace';
  }, []);

  useEffect(() => {
    if (!layoutHostRef.current || layoutRef.current) {
      return;
    }

    const layout = new GoldenLayout(layoutHostRef.current);
    layoutRef.current = layout;

    layout.registerComponentFactoryFunction(WORKSPACE_COMPONENT_TYPE, (container, state) => {
      const route = isRoutePanelState(state)
        ? state
        : createRoutePanelState('/', '');
      const hostElement = document.createElement('div');
      hostElement.className = 'golden-workspace-panel-host';
      container.element.appendChild(hostElement);
      container.stateRequestEvent = () => panelInstancesRef.current.get(route.panelId)?.route ?? route;

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

      container.on('destroy', () => {
        panelInstancesRef.current.delete(route.panelId);
        setPanelInstances((current) => {
          const next = { ...current };
          delete next[route.panelId];
          return next;
        });
      });

      return undefined;
    });

    layout.on('focus', (event) => {
      if (event.target instanceof ComponentItem) {
        focusPanel(event.target);
      }
    });

    layout.on('stateChanged', () => {
      persistWorkspaceLayout();
    });

    const savedLayout = window.localStorage.getItem(STORAGE_KEY);
    if (savedLayout) {
      try {
        const parsedLayout = JSON.parse(savedLayout) as LayoutConfig & { resolved?: boolean };
        const normalizedLayout = parsedLayout.resolved
          ? LayoutConfig.fromResolved(parsedLayout as unknown as ResolvedLayoutConfig)
          : parsedLayout;
        layout.loadLayout(normalizedLayout);
      } catch (error) {
        console.error('Failed to restore saved workspace layout:', error);
        window.localStorage.removeItem(STORAGE_KEY);
        layout.loadLayout(createDefaultLayout(createRoutePanelState('/', '')));
      }
    } else {
      layout.loadLayout(createDefaultLayout(createRoutePanelState('/', '')));
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
      resizeObserver.disconnect();
      layout.destroy();
      layoutRef.current = null;
      currentPanelInstances.clear();
      setPanelInstances({});
    };
  }, [focusPanel, persistWorkspaceLayout]);

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
            (nextRoute, mode = 'focus') => {
              if (mode === 'split') {
                splitRouteHorizontally(nextRoute.pathname, nextRoute.search, nextRoute.title);
                return;
              }

              if (mode === 'tab') {
                openRouteAsTab(nextRoute.pathname, nextRoute.search);
                return;
              }

              focusOrOpenRoute(nextRoute.pathname, nextRoute.search);
            },
          ),
          panel.hostElement,
          panel.route.panelId,
        ),
      ),
    [focusOrOpenRoute, openRouteAsTab, panelInstances, splitRouteHorizontally, updatePanelRoute],
  );

  return (
    <div className="golden-workspace-shell flex h-screen">
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="golden-workspace-dock px-3 py-3">
          <div className="golden-workspace-dock-inner">
            <div className="golden-dock-left">
              <div className="golden-launcher" ref={launcherRef}>
                <button
                  type="button"
                  className="golden-launcher-button"
                  onClick={() => {
                    setPaneMenuOpen(false);
                    setLauncherOpen((current) => !current);
                  }}
                  aria-haspopup="menu"
                  aria-expanded={launcherOpen}
                >
                  <span className="golden-launcher-badge" aria-hidden="true">
                    <img
                      src="favicon.svg"
                      width="18"
                      height="18"
                      alt=""
                    />
                  </span>
                  <span className="golden-launcher-title">Views</span>
                  <LayoutPanelTop className="h-4 w-4 opacity-60" aria-hidden="true" />
                </button>

                {launcherOpen ? (
                  <div className="golden-launcher-menu" role="menu" aria-label="Open workspace view">
                    <div className="golden-launcher-menu-header">
                      <div className="font-semibold text-foreground">Open a view</div>
                      <div className="text-xs text-muted-foreground">
                        Open in the current stack or split beside the active pane.
                      </div>
                    </div>

                    <div className="golden-launcher-menu-list">
                      {NAVIGATION_ROUTES.map((route) => (
                        <div key={route.id} className="golden-launcher-menu-row">
                          <button
                            type="button"
                            className="golden-launcher-menu-action"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              openRouteFromHref(route.href, 'tab');
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
                              openRouteFromHref(route.href, 'split');
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
                  </div>
                ) : null}
              </div>
            </div>

            <div className="golden-dock-center">
              <WorkspaceArmRail onOpenViewer={openViewerForArm} />
            </div>

            <div className="golden-dock-right" role="toolbar" aria-label="Workspace actions">
              <button
                type="button"
                className="golden-dock-button golden-dock-button--primary"
                onClick={() => openRouteAsTab('/arms', '?spawn=1')}
              >
                <Bot className="h-4 w-4 mr-2" />
                Spawn Arm
              </button>
              <button
                type="button"
                className="golden-dock-button"
                onClick={openNewMessage}
              >
                <MailPlus className="h-4 w-4 mr-2" />
                New Message
              </button>
              <div className="golden-pane-menu" ref={paneMenuRef}>
                <button
                  type="button"
                  className="golden-dock-icon-button"
                  onClick={() => {
                    setLauncherOpen(false);
                    setPaneMenuOpen((current) => !current);
                  }}
                  aria-haspopup="menu"
                  aria-expanded={paneMenuOpen}
                  aria-label="Pane actions"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>

                {paneMenuOpen ? (
                  <div className="golden-pane-menu-dropdown" role="menu" aria-label="Pane actions">
                    <button
                      type="button"
                      className="golden-pane-menu-action"
                      onClick={() => {
                        openRouteFromHref(location.pathname + location.search, 'tab');
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

        <div className="flex-1 min-h-0 p-3">
          <div
            ref={layoutHostRef}
            className="golden-workspace-layout h-full"
          />
        </div>
      </div>

      {panelPortals}
    </div>
  );
}
