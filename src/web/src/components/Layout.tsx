import { useState, useEffect } from 'react';
import { Button, Chip } from '@heroui/react';
import { NavLink, Outlet } from 'react-router-dom';
import {
  LayoutDashboard,
  Bot,
  Eye,
  Terminal,
  Flower2,
  Mail,
  Vote,
  Activity,
  Settings,
  Octagon,
  MessageSquarePlus,
  ListTodo,
  Bug
} from 'lucide-react';
import { cn, api, useToast, useMessage } from '@/lib';
import { MessageModal } from './MessageModal';

const getNavItems = (unreadCount: number) => [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/brain', icon: Terminal, label: 'Brain' },
  { to: '/arms', icon: Bot, label: 'Arms' },
  { to: '/viewer', icon: Eye, label: 'Viewer' },
  { to: '/tasks', icon: ListTodo, label: 'Tasks' },
  { to: '/bugs', icon: Bug, label: 'Bugs' },
  { to: '/garden', icon: Flower2, label: 'Garden' },
  { to: '/messaging', icon: Mail, label: 'Messaging', badge: unreadCount },
  { to: '/proposals', icon: Vote, label: 'Proposals' },
  { to: '/activity', icon: Activity, label: 'Activity' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export function Layout() {
  const [unreadCount, setUnreadCount] = useState(0);
  const { showToast } = useToast();
  const { isMessageModalOpen, replyContext, openNewMessage, closeMessageModal } = useMessage();

  // Fetch unread message counts
  const fetchUnreadCount = async () => {
    try {
      const [inboxResult] = await Promise.all([
        api.listInbox({ limit: 1 }), // Get pagination info with unread count
      ]);
      setUnreadCount(inboxResult.pagination.unread);
    } catch (error) {
      console.error('Failed to fetch unread count:', error);
    }
  };

  // WebSocket connection for real-time updates
  useEffect(() => {
    const ws = new WebSocket('ws://localhost:3000/ws');

    ws.onopen = () => {
      // Authenticate and subscribe to mail events
      ws.send(JSON.stringify({
        type: 'auth',
        apiKey: api.getApiKey()
      }));
      ws.send(JSON.stringify({
        type: 'subscribe',
        channel: 'mail'
      }));
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.channel === 'mail') {
          // Handle mail events
          if (message.event === 'mail.received') {
            showToast(`New message: ${message.data.subject || 'New message'}`, 'info');
            fetchUnreadCount(); // Refresh unread count
          } else if (message.event === 'mail.archived' || message.event === 'mail.read') {
            fetchUnreadCount(); // Refresh unread count
          }
        }
      } catch (error) {
        console.error('WebSocket message parse error:', error);
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    return () => {
      ws.close();
    };
  }, [showToast]);

  // Fetch unread counts on mount and every 30 seconds
  useEffect(() => {
    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 30000);
    return () => clearInterval(interval);
  }, []);

  // Global keyboard shortcut: 'N' to open message modal
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ignore if typing in an input/textarea
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      // 'N' key opens the message modal
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        openNewMessage();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [openNewMessage]);

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="w-64 border-r border-border bg-card flex flex-col">
        {/* Logo */}
        <div className="p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Octagon className="h-8 w-8 text-accent" />
            <div>
              <h1 className="font-bold text-lg">Coleo</h1>
              <p className="text-xs text-muted-foreground">Observatory</p>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4">
          <ul className="space-y-1">
            {getNavItems(unreadCount).map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                    )
                  }
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                  {item.badge ? (
                    <Chip size="sm" variant="primary" color="danger" className="ml-auto">
                      {item.badge > 99 ? '99+' : item.badge}
                    </Chip>
                  ) : null}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        {/* New Message Button */}
        <div className="p-4 border-t border-border">
          <Button
            onPress={openNewMessage}
            className="w-full justify-center gap-2"
          >
            <MessageSquarePlus className="h-4 w-4" />
            New Message
            <kbd className="ml-auto px-1.5 py-0.5 bg-purple-700 rounded text-xs">N</kbd>
          </Button>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-border text-xs text-muted-foreground">
          v0.1.0
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>

      {/* Message Modal */}
      <MessageModal 
        isOpen={isMessageModalOpen} 
        onClose={closeMessageModal}
        replyTo={replyContext}
      />
    </div>
  );
}
