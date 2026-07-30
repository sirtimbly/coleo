import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Chip } from '@heroui/react';
import { MessageSquarePlus, Plus } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { NAVIGATION_ROUTES, normalizeAppPathname } from '@/app/routes';
import type { AppLayoutMode } from '@/hooks/useLayoutMode';
import { api, cn, truncateMiddle, useMessage, useToast } from '@/lib';
import { useWebSocket } from '@/hooks/useWebSocket';
import { VERSION } from '@/version';

interface AppSidebarProps {
  layoutMode: AppLayoutMode;
  activePathname?: string;
  onOpenRoute?: (href: string) => void;
  onOpenRouteInNewPane?: (href: string) => void;
}

export function AppSidebar({
  layoutMode,
  activePathname,
  onOpenRoute,
  onOpenRouteInNewPane,
}: AppSidebarProps) {
  const [cwd, setCwd] = useState('/');
  const [projectName, setProjectName] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const { openNewMessage } = useMessage();
  const { showToast } = useToast();
  const normalizedActivePathname = useMemo(
    () => normalizeAppPathname(activePathname ?? '/'),
    [activePathname],
  );

  const fetchStatus = useCallback(async () => {
    try {
      const status = await api.status();
      setCwd(status.cwd);
      setProjectName(status.projectName);
    } catch (error) {
      console.error('Failed to fetch status:', error);
    }
  }, []);

  const fetchUnreadCount = useCallback(async () => {
    try {
      const inbox = await api.listInbox({ limit: 1 });
      setUnreadCount(inbox.pagination.unread);
    } catch (error) {
      console.error('Failed to fetch unread count:', error);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
    void fetchUnreadCount();
  }, [fetchStatus, fetchUnreadCount]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void fetchUnreadCount();
    }, 30000);

    return () => window.clearInterval(intervalId);
  }, [fetchUnreadCount]);

  useWebSocket({
    channels: ['mail'],
    onMessage: (message) => {
      if (message.channel !== 'mail') {
        return;
      }

      if (message.event === 'mail.received') {
        showToast(`New message: ${String((message.data as { subject?: string } | undefined)?.subject ?? 'New message')}`, 'info');
        void fetchUnreadCount();
        return;
      }

      if (message.event === 'mail.archived' || message.event === 'mail.read') {
        void fetchUnreadCount();
      }
    },
  });

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="border-b border-sidebar-border px-5 py-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md border border-sidebar-border bg-sidebar-accent">
            <img
              src="favicon.svg"
              width="20"
              height="20"
              alt="octopus illustration"
            />
          </div>

          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold uppercase tracking-[0.22em] text-sidebar-foreground">
              COLEO
            </h1>
            <p className="truncate pt-1 text-xs text-muted-foreground" title={cwd}>
              {projectName ? truncateMiddle(projectName, 32) : cwd}
            </p>
          </div>
        </div>
      </div>

      <nav className="flex-1 px-3 py-4">
        <ul className="space-y-1.5">
          {NAVIGATION_ROUTES.map((route) => {
            const routeBadge =
              route.id === 'mail' && unreadCount > 0 ? (
                <Chip
                  size="sm"
                  variant="soft"
                  color="danger"
                  className="ml-auto border border-danger/25"
                >
                  {unreadCount > 99 ? '99+' : unreadCount}
                </Chip>
              ) : null;

            if (layoutMode === 'golden' && onOpenRoute) {
              const isActive = normalizedActivePathname === route.href;

              return (
                <li key={route.id}>
                  <div className="group flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onOpenRoute(route.href)}
                      className={cn(
                        'flex min-w-0 flex-1 items-center gap-3 rounded-md border px-3 py-3 text-left text-sm font-medium transition-colors',
                        isActive
                          ? 'border-sidebar-border bg-sidebar-accent text-sidebar-foreground'
                          : 'border-transparent text-muted-foreground hover:border-sidebar-border hover:bg-sidebar-accent hover:text-sidebar-foreground',
                      )}
                    >
                      <route.icon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{route.label}</span>
                      {routeBadge}
                      <span
                        aria-hidden="true"
                        className={cn(
                          'ml-1 h-6 w-px rounded-full',
                          isActive ? 'bg-accent' : 'bg-transparent',
                        )}
                      />
                    </button>

                    <Button
                      isIconOnly
                      size="sm"
                      variant="ghost"
                      onPress={() => onOpenRouteInNewPane?.(route.href)}
                      className="h-10 w-10 rounded-md border border-transparent text-muted-foreground opacity-0 transition-all group-hover:opacity-100 hover:border-sidebar-border hover:bg-sidebar-accent hover:text-sidebar-foreground"
                      aria-label={`Open ${route.label} in a new pane`}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              );
            }

            return (
              <li key={route.id}>
                <NavLink
                  to={route.href}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-3 rounded-md border px-3 py-3 text-sm font-medium transition-colors',
                      isActive
                        ? 'border-sidebar-border bg-sidebar-accent text-sidebar-foreground'
                        : 'border-transparent text-muted-foreground hover:border-sidebar-border hover:bg-sidebar-accent hover:text-sidebar-foreground',
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <route.icon className="h-4 w-4 shrink-0" />
                      <span>{route.label}</span>
                      {routeBadge}
                      <span
                        aria-hidden="true"
                        className={cn(
                          'ml-auto h-6 w-px rounded-full',
                          isActive ? 'bg-accent' : 'bg-transparent',
                        )}
                      />
                    </>
                  )}
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-sidebar-border px-4 py-4">
        <button
          type="button"
          onClick={openNewMessage}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-sidebar-border bg-sidebar-accent px-3 py-3 text-sm font-medium text-sidebar-foreground transition-colors hover:bg-surface-secondary"
        >
          <MessageSquarePlus className="h-4 w-4" />
          New Message
          <kbd className="ml-auto rounded border border-sidebar-border px-1.5 py-0.5 text-[0.68rem] text-muted-foreground">
            N
          </kbd>
        </button>
      </div>

      <div className="border-t border-sidebar-border px-5 py-4 text-[0.68rem] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        v{VERSION}
      </div>
    </aside>
  );
}
