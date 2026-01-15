import { useState, useEffect } from 'react';
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
  ListTodo
} from 'lucide-react';
import { cn } from '@/lib';
import { MessageModal } from './MessageModal';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/brain', icon: Terminal, label: 'Brain' },
  { to: '/arms', icon: Bot, label: 'Arms' },
  { to: '/viewer', icon: Eye, label: 'Viewer' },
  { to: '/tasks', icon: ListTodo, label: 'Tasks' },
  { to: '/garden', icon: Flower2, label: 'Garden' },
  { to: '/mail', icon: Mail, label: 'Mail' },
  { to: '/proposals', icon: Vote, label: 'Proposals' },
  { to: '/activity', icon: Activity, label: 'Activity' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export function Layout() {
  const [isMessageModalOpen, setIsMessageModalOpen] = useState(false);

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
        setIsMessageModalOpen(true);
      }
    }
    
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="w-64 border-r border-border bg-card flex flex-col">
        {/* Logo */}
        <div className="p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Octagon className="h-8 w-8 text-primary" />
            <div>
              <h1 className="font-bold text-lg">Octopai</h1>
              <p className="text-xs text-muted-foreground">Observatory</p>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4">
          <ul className="space-y-1">
            {navItems.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-secondary text-secondary-foreground'
                        : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                    )
                  }
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        {/* New Message Button */}
        <div className="p-4 border-t border-border">
          <button
            onClick={() => setIsMessageModalOpen(true)}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-md text-sm font-medium transition-colors"
          >
            <MessageSquarePlus className="h-4 w-4" />
            New Message
            <kbd className="ml-auto px-1.5 py-0.5 bg-purple-700 rounded text-xs">N</kbd>
          </button>
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
        onClose={() => setIsMessageModalOpen(false)} 
      />
    </div>
  );
}
