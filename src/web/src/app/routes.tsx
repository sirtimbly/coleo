/**
 * Static workbench view contributions.
 *
 * Each entry gives the shell a route-backed view type. The registry remains
 * static while the migration consolidates presentation and persistence.
 */
import {
  Activity,
  Bot,
  Bug,
  Eye,
  FileText,
  Flower2,
  Grid3x3,
  LayoutDashboard,
  ListTodo,
  ClipboardCheck,
  Mail,
  MessageSquareMore,
  Inbox,
  Search,
  Settings,
  Terminal,
  Workflow,
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
  ProcessesPage,
  SettingsPage,
  StatusReportsPage,
  StatusHistorySearchPage,
  TasksPage,
  UnifiedGridPage,
  SetupPage,
  ComposeMessagePage,
  CardPanelPage,
  CardCatalogPage,
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
    label: 'Plan & Documents',
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
    id: 'processes',
    href: '/processes',
    path: 'processes',
    label: 'Processes',
    icon: Workflow,
    component: ProcessesPage,
    showInNav: true,
  },
  {
    id: 'viewer',
    href: '/viewer',
    path: 'viewer',
    label: 'Viewer',
    icon: Eye,
    component: ArmViewerPage,
    // Viewer requires Arm context and is opened from fleet/search selections.
    showInNav: false,
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
      return taskId ? 'Task details' : 'Tasks';
    },
  },
  {
    id: 'status-reports',
    href: '/status-reports',
    path: 'status-reports',
    label: 'History',
    icon: FileText,
    component: StatusReportsPage,
    showInNav: false,
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
    label: 'Project Mail',
    icon: Mail,
    component: MailPage,
    showInNav: false,
  },
  {
    id: 'proposals',
    href: '/proposals',
    path: 'proposals',
    label: 'Proposals',
    icon: Vote,
    component: ProposalsPage,
    showInNav: false,
  },
  {
    id: 'activity',
    href: '/activity',
    path: 'activity',
    label: 'Activity',
    icon: Activity,
    component: ActivityPage,
    showInNav: false,
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
    label: 'Inbox',
    icon: Inbox,
    component: MessagingPage,
    showInNav: true,
  },
  {
    id: 'card',
    href: '/card',
    path: 'card',
    label: 'Card',
    icon: FileText,
    component: CardPanelPage,
    showInNav: false,
    getTitle: (searchParams) => {
      const id = searchParams.get('id');
      return id ? `Card ${id.slice(0, 8)}` : 'Card';
    },
  },
  {
    id: 'card-catalog',
    href: '/card-catalog',
    path: 'card-catalog',
    label: 'Card catalog',
    icon: Grid3x3,
    component: CardCatalogPage,
    showInNav: false,
  },
  {
    id: 'grid',
    href: '/grid',
    path: 'grid',
    label: 'Grid',
    icon: Grid3x3,
    component: UnifiedGridPage,
    showInNav: true,
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
