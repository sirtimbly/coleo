/**
 * Query Key Factories
 * 
 * Type-safe query key factories for all entities.
 * Follows the pattern: [entity, operation, params...]
 */



// Tasks
export const tasksKeys = {
  all: () => ['tasks'] as const,
  lists: () => [...tasksKeys.all(), 'list'] as const,
  list: (filters: { 
    status?: string; 
    priority?: string; 
    domain?: string;
    assignedTo?: string;
    phase?: string;
  }) => [...tasksKeys.lists(), filters] as const,
  details: () => [...tasksKeys.all(), 'detail'] as const,
  detail: (id: string) => [...tasksKeys.details(), id] as const,
  discussions: (taskId: string) => [...tasksKeys.detail(taskId), 'discussions'] as const,
  unreadCount: (taskId: string, userId: string) => 
    [...tasksKeys.detail(taskId), 'unread', userId] as const,
};

// Arms
export const armsKeys = {
  all: () => ['arms'] as const,
  lists: () => [...armsKeys.all(), 'list'] as const,
  list: () => [...armsKeys.lists()] as const,
  details: () => [...armsKeys.all(), 'detail'] as const,
  detail: (id: string) => [...armsKeys.details(), id] as const,
  messages: (id: string) => [...armsKeys.detail(id), 'messages'] as const,
  todos: (id: string) => [...armsKeys.detail(id), 'todos'] as const,
  status: (id: string) => [...armsKeys.detail(id), 'status'] as const,
  configs: () => [...armsKeys.all(), 'configs'] as const,
  config: (name: string) => [...armsKeys.configs(), name] as const,
};

// Bugs
export const bugsKeys = {
  all: () => ['bugs'] as const,
  lists: () => [...bugsKeys.all(), 'list'] as const,
  list: (filters: {
    source?: string;
    status?: string;
    priority?: string;
    assignee?: string;
  }) => [...bugsKeys.lists(), filters] as const,
  details: () => [...bugsKeys.all(), 'detail'] as const,
  detail: (id: string) => [...bugsKeys.details(), id] as const,
  stats: () => [...bugsKeys.all(), 'stats'] as const,
};

// Mail
export const mailKeys = {
  all: () => ['mail'] as const,
  inbox: (params?: { limit?: number; offset?: number }) => 
    [...mailKeys.all(), 'inbox', params ?? {}] as const,
  sent: (params?: { limit?: number; offset?: number }) => 
    [...mailKeys.all(), 'sent', params ?? {}] as const,
  archive: (params?: { limit?: number; offset?: number }) => 
    [...mailKeys.all(), 'archive', params ?? {}] as const,
};

// Brain
export const brainKeys = {
  all: () => ['brain'] as const,
  status: () => [...brainKeys.all(), 'status'] as const,
  config: () => [...brainKeys.all(), 'config'] as const,
};

// Activity
export const activityKeys = {
  all: () => ['activity'] as const,
  list: (params?: { 
    limit?: number; 
    offset?: number; 
    actor?: string;
  }) => [...activityKeys.all(), params ?? {}] as const,
};

// Status Reports
export const statusReportsKeys = {
  all: () => ['status-reports'] as const,
  lists: () => [...statusReportsKeys.all(), 'list'] as const,
  list: (params?: {
    taskId?: string;
    armId?: string;
    limit?: number;
    offset?: number;
  }) => [...statusReportsKeys.lists(), params ?? {}] as const,
  detail: (id: string) => [...statusReportsKeys.all(), 'detail', id] as const,
  stats: () => [...statusReportsKeys.all(), 'stats'] as const,
};

// Config
export const configKeys = {
  all: () => ['config'] as const,
  full: () => [...configKeys.all(), 'full'] as const,
  defaults: () => [...configKeys.all(), 'defaults'] as const,
  brain: () => [...configKeys.all(), 'brain'] as const,
};

// System Status
export const systemKeys = {
  all: () => ['system'] as const,
  status: () => [...systemKeys.all(), 'status'] as const,
  health: () => [...systemKeys.all(), 'health'] as const,
};

// Events/Analysis
export const eventsKeys = {
  all: () => ['events'] as const,
  armWindow: (armId: string, options?: { windowMs?: number; limit?: number }) => 
    [...eventsKeys.all(), 'arm', armId, 'window', options ?? {}] as const,
  armAnalysis: (armId: string, options?: { windowMs?: number }) => 
    [...eventsKeys.all(), 'arm', armId, 'analysis', options ?? {}] as const,
  allAnalysis: (options?: { windowMs?: number }) => 
    [...eventsKeys.all(), 'analysis', options ?? {}] as const,
  recent: (options?: { limit?: number; sinceMs?: number }) => 
    [...eventsKeys.all(), 'recent', options ?? {}] as const,
  types: () => [...eventsKeys.all(), 'types'] as const,
  healthConfig: () => [...eventsKeys.all(), 'health', 'config'] as const,
};

// OpenCode
export const opencodeKeys = {
  all: () => ['opencode'] as const,
  providers: () => [...opencodeKeys.all(), 'providers'] as const,
};
