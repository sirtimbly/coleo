import {
  Activity,
  Bot,
  Bug,
  Eye,
  FileText,
  Flower2,
  LayoutDashboard,
  ListTodo,
  ClipboardCheck,
  Mail,
  MessageSquareMore,
  Search,
  Settings,
  Terminal,
  Vote,
  type LucideIcon,
} from 'lucide-react';
import type { ComponentType } from 'react';
import {
  ActivityPage,
  ArmViewerPage,
  ArmsPage,
  BrainPage,
  BugsPage,
  DashboardPage,
  GardenPage,
  MailPage,
  MessagingPage,
  ProposalsPage,
  SettingsPage,
  StatusReportsPage,
  StatusHistorySearchPage,
  TasksPage,
  UnifiedGridPage,
  SetupPage,
  ComposeMessagePage,
} from '@/pages';

export interface AppRouteDefinition {
  id: string;
  href: string;
  path?: string;
  index?: boolean;
  label: string;
  icon: LucideIcon;
  component: ComponentType;
  showInNav?: boolean;
  getTitle?: (searchParams: URLSearchParams) => string;
}

export const APP_ROUTES: AppRouteDefinition[] = [
  {
    id: 'dashboard',
    href: '/',
    index: true,
    label: 'Dashboard',
    icon: LayoutDashboard,
    component: DashboardPage,
    showInNav: true,
  },
  {
    id: 'setup',
    href: '/setup',
    path: 'setup',
    label: 'Setup',
    icon: ClipboardCheck,
    component: SetupPage,
    showInNav: true,
  },
  {
    id: 'brain',
    href: '/brain',
    path: 'brain',
    label: 'Brain',
    icon: Terminal,
    component: BrainPage,
    showInNav: true,
  },
  {
    id: 'arms',
    href: '/arms',
    path: 'arms',
    label: 'Arms',
    icon: Bot,
    component: ArmsPage,
    showInNav: true,
    getTitle: (searchParams) => searchParams.get('spawn') === '1' ? 'Spawn Arm' : 'Arms',
  },
  {
    id: 'viewer',
    href: '/viewer',
    path: 'viewer',
    label: 'Viewer',
    icon: Eye,
    component: ArmViewerPage,
    showInNav: true,
    getTitle: (searchParams) => {
      const armId = searchParams.get('arm');
      return armId ? `Viewer: ${armId}` : 'Viewer';
    },
  },
  {
    id: 'tasks',
    href: '/tasks',
    path: 'tasks',
    label: 'Tasks',
    icon: ListTodo,
    component: TasksPage,
    showInNav: true,
    getTitle: (searchParams) => {
      const taskId = searchParams.get('task');
      return taskId ? `Task: ${taskId}` : 'Tasks';
    },
  },
  {
    id: 'status-reports',
    href: '/status-reports',
    path: 'status-reports',
    label: 'History',
    icon: FileText,
    component: StatusReportsPage,
    showInNav: true,
  },
  {
    id: 'history-search',
    href: '/history-search',
    path: 'history-search',
    label: 'Search History',
    icon: Search,
    component: StatusHistorySearchPage,
    showInNav: true,
  },
  {
    id: 'bugs',
    href: '/bugs',
    path: 'bugs',
    label: 'Bugs',
    icon: Bug,
    component: BugsPage,
    showInNav: true,
    getTitle: (searchParams) => {
      const bugId = searchParams.get('bug');
      return bugId ? `Bug: ${bugId}` : 'Bugs';
    },
  },
  {
    id: 'garden',
    href: '/garden',
    path: 'garden',
    label: 'Garden',
    icon: Flower2,
    component: GardenPage,
    showInNav: true,
  },
  {
    id: 'mail',
    href: '/mail',
    path: 'mail',
    label: 'Mail',
    icon: Mail,
    component: MailPage,
    showInNav: true,
  },
  {
    id: 'proposals',
    href: '/proposals',
    path: 'proposals',
    label: 'Proposals',
    icon: Vote,
    component: ProposalsPage,
    showInNav: true,
  },
  {
    id: 'activity',
    href: '/activity',
    path: 'activity',
    label: 'Activity',
    icon: Activity,
    component: ActivityPage,
    showInNav: true,
  },
  {
    id: 'settings',
    href: '/settings',
    path: 'settings',
    label: 'Settings',
    icon: Settings,
    component: SettingsPage,
    showInNav: true,
  },
  {
    id: 'compose',
    href: '/compose',
    path: 'compose',
    label: 'New Message',
    icon: MessageSquareMore,
    component: ComposeMessagePage,
  },
  {
    id: 'messaging',
    href: '/messaging',
    path: 'messaging',
    label: 'Messaging',
    icon: MessageSquareMore,
    component: MessagingPage,
  },
  {
    id: 'grid',
    href: '/grid',
    path: 'grid',
    label: 'Grid',
    icon: ListTodo,
    component: UnifiedGridPage,
  },
];

export const NAVIGATION_ROUTES = APP_ROUTES.filter((route) => route.showInNav);

export function normalizeAppPathname(pathname: string): string {
  if (pathname === '') {
    return '/';
  }

  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }

  return pathname;
}

export function findAppRoute(pathname: string): AppRouteDefinition | undefined {
  const normalizedPathname = normalizeAppPathname(pathname);
  return APP_ROUTES.find((route) => route.href === normalizedPathname);
}

export function getAppRouteTitle(pathname: string, search = ''): string {
  const route = findAppRoute(pathname);
  if (!route) {
    return 'Observatory';
  }

  if (!route.getTitle) {
    return route.label;
  }

  return route.getTitle(new URLSearchParams(search));
}
