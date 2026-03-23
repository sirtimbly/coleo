import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Chip } from '@heroui/react';
import { MessageSquarePlus, Plus } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { NAVIGATION_ROUTES, normalizeAppPathname } from '@/app/routes';
import type { AppLayoutMode } from '@/hooks/useLayoutMode';
import { api, cn, useMessage, useToast } from '@/lib';
import { useWebSocket } from '@/hooks/useWebSocket';

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
    <aside className="w-64 border-r border-border bg-card flex flex-col shrink-0">
      <div className="p-4 border-b border-border">
        <div className="flex items-start gap-1">
          <img
            src="favicon.svg"
            width="20"
            height="20"
            className="pt-1"
            alt="octopus illustration"
          />
          <div>
            <h1 className="font-bold text-lg">Coleo</h1>
            <p className="text-xs text-muted-foreground">{cwd}</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 p-4">
        <ul className="space-y-1">
          {NAVIGATION_ROUTES.map((route) => {
            const routeBadge =
              route.id === 'mail' && unreadCount > 0 ? (
                <Chip
                  size="sm"
                  variant="primary"
                  color="danger"
                  className="ml-auto"
                >
                  {unreadCount > 99 ? '99+' : unreadCount}
                </Chip>
              ) : null;

            if (layoutMode === 'golden' && onOpenRoute) {
              const isActive = normalizedActivePathname === route.href;

              return (
                <li key={route.id}>
                  <div
                    className={cn(
                      'group flex items-center gap-1 rounded-md transition-colors',
                      isActive ? 'bg-accent/10' : 'hover:bg-secondary/40',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onOpenRoute(route.href)}
                      className={cn(
                        'flex min-w-0 flex-1 items-center gap-3 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors',
                        isActive
                          ? 'text-accent'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <route.icon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{route.label}</span>
                      {routeBadge}
                    </button>

                    <Button
                      isIconOnly
                      size="sm"
                      variant="ghost"
                      onPress={() => onOpenRouteInNewPane?.(route.href)}
                      className="mr-1 opacity-0 transition-opacity group-hover:opacity-100"
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
                      'flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground',
                    )
                  }
                >
                  <route.icon className="h-4 w-4" />
                  {route.label}
                  {routeBadge}
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="p-4 border-t border-border space-y-3">
        <Button
          onPress={openNewMessage}
          className="w-full justify-center gap-2"
        >
          <MessageSquarePlus className="h-4 w-4" />
          New Message
          <kbd className="ml-auto px-1.5 py-0.5 bg-purple-700 rounded text-xs">
            N
          </kbd>
        </Button>
      </div>

      <div className="p-4 border-t border-border text-xs text-muted-foreground">
        v0.2.0
      </div>
    </aside>
  );
}
