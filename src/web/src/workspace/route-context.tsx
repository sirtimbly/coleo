import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import {
  createSearchParams,
  useNavigate,
  useSearchParams as useBrowserSearchParams,
  type SetURLSearchParams,
} from 'react-router-dom';

export interface WorkspaceRouteState {
  pathname: string;
  search: string;
  title?: string;
}

export type WorkspaceOpenMode = 'focus' | 'tab' | 'split' | 'action';

interface WorkspaceRouteContextValue {
  route: WorkspaceRouteState;
  searchParams: URLSearchParams;
  setSearchParams: SetURLSearchParams;
  openRoute: (route: WorkspaceRouteState, mode?: WorkspaceOpenMode) => void;
  closeRoute: () => void;
}

const WorkspaceRouteContext = createContext<WorkspaceRouteContextValue | null>(null);

interface WorkspaceRouteProviderProps {
  children: ReactNode;
  route: WorkspaceRouteState;
  onRouteChange: (route: WorkspaceRouteState) => void;
  onOpenRoute: (route: WorkspaceRouteState, mode?: WorkspaceOpenMode) => void;
  onCloseRoute: () => void;
}

export function WorkspaceRouteProvider({
  children,
  route,
  onRouteChange,
  onOpenRoute,
  onCloseRoute,
}: WorkspaceRouteProviderProps) {
  const searchParams = useMemo(() => new URLSearchParams(route.search), [route.search]);

  const setSearchParams = useCallback<SetURLSearchParams>(
    (nextInit) => {
      const nextValue =
        typeof nextInit === 'function'
          ? nextInit(new URLSearchParams(route.search))
          : nextInit;
      const nextSearchParams = createSearchParams(nextValue);
      const nextSearch = nextSearchParams.toString();

      onRouteChange({
        pathname: route.pathname,
        search: nextSearch ? `?${nextSearch}` : '',
      });
    },
    [onRouteChange, route.pathname, route.search],
  );

  const value = useMemo<WorkspaceRouteContextValue>(
    () => ({
      route,
      searchParams,
      setSearchParams,
      openRoute: onOpenRoute,
      closeRoute: onCloseRoute,
    }),
    [onCloseRoute, onOpenRoute, route, searchParams, setSearchParams],
  );

  return (
    <WorkspaceRouteContext.Provider value={value}>
      {children}
    </WorkspaceRouteContext.Provider>
  );
}

export function useWorkspaceSearchParams() {
  const workspaceRoute = useContext(WorkspaceRouteContext);
  const browserSearchParams = useBrowserSearchParams();

  if (!workspaceRoute) {
    return browserSearchParams;
  }

  return [workspaceRoute.searchParams, workspaceRoute.setSearchParams] as const;
}

export function useIsWorkspacePanel(): boolean {
  return useContext(WorkspaceRouteContext) !== null;
}

export function useWorkspaceOpenRoute() {
  const workspaceRoute = useContext(WorkspaceRouteContext);
  const navigate = useNavigate();

  return useCallback(
    (route: WorkspaceRouteState, mode: WorkspaceOpenMode = 'focus') => {
      if (workspaceRoute) {
        workspaceRoute.openRoute(route, mode);
        return;
      }

      navigate(`${route.pathname}${route.search}`);
    },
    [navigate, workspaceRoute],
  );
}

export function useWorkspaceCloseRoute(fallback = '/') {
  const workspaceRoute = useContext(WorkspaceRouteContext);
  const navigate = useNavigate();

  return useCallback(() => {
    if (workspaceRoute) {
      workspaceRoute.closeRoute();
      return;
    }

    navigate(fallback);
  }, [fallback, navigate, workspaceRoute]);
}
