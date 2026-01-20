/**
 * API Client for Octopai Observatory
 */

const API_BASE = '/api';

interface ApiError {
  error: string;
  message?: string;
}

class ApiClient {
  private apiKey: string | null = null;

  setApiKey(key: string) {
    this.apiKey = key;
    localStorage.setItem('octopai_api_key', key);
  }

  getApiKey(): string | null {
    if (!this.apiKey) {
      this.apiKey = localStorage.getItem('octopai_api_key');
    }
    return this.apiKey;
  }

  clearApiKey() {
    this.apiKey = null;
    localStorage.removeItem('octopai_api_key');
  }

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };

    const apiKey = this.getApiKey();
    if (apiKey) {
      headers['X-API-Key'] = apiKey;
    }

    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error: ApiError = await response.json().catch(() => ({
        error: 'Request failed',
        message: response.statusText,
      }));
      throw new Error(error.message || error.error);
    }

    return response.json();
  }

  // Health & Status
  async health() {
    return this.request<{ status: string; timestamp: string }>('/health');
  }

  async status() {
    return this.request<{
      status: string;
      version: string;
      uptime: number;
      brain: {
        running: boolean;
        lastPoll?: string;
        status?: string;
      };
      arms: {
        total: number;
        healthy: number;
        idle: number;
        stuck: number;
        stale: number;
        details: Array<{
          id: string;
          name: string;
          status: string;
          domain: string;
          currentTask?: string;
          lastActivity?: string;
          lastHeartbeat?: string;
          health: "healthy" | "idle" | "stuck" | "stale" | "unknown";
        }>;
      };
      proposals: { open: number };
      activity: { last24h: number };
      infrastructure: {
        database: { healthy: boolean; error?: string };
        nats: { healthy: boolean; optional: boolean; error?: string };
        maildir: { healthy: boolean; error?: string };
      };
      timestamp: string;
    }>('/status');
  }

  async config() {
    return this.request<{
      brain: { pollIntervalMs: number; maxArms: number };
      version: string;
    }>('/config');
  }

  // Full Config API
  async getFullConfig() {
    return this.request<{ config: OctopaiConfig }>('/config');
  }

  async updateConfig(data: Partial<OctopaiConfig>) {
    return this.request<{ config: OctopaiConfig }>('/config', {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async getDefaults() {
    return this.request<{ defaults: OctopaiConfig['defaults'] }>('/config/defaults');
  }

  async updateDefaults(data: Partial<OctopaiConfig['defaults']>) {
    return this.request<{ defaults: OctopaiConfig['defaults'] }>('/config/defaults', {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async updateBrainConfig(data: Partial<OctopaiConfig['brain']>) {
    return this.request<{ brain: OctopaiConfig['brain'] }>('/config/brain', {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  // Arm Config Files
  async listArmConfigs() {
    return this.request<{ arms: ArmConfigSummary[] }>('/config/arms');
  }

  async getArmConfig(name: string) {
    return this.request<{ filename: string; config: ArmConfig; raw: string }>(`/config/arms/${name}`);
  }

  async updateArmConfig(name: string, data: { config?: ArmConfig; raw?: string }) {
    return this.request<{ filename: string; config: ArmConfig; raw: string }>(`/config/arms/${name}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteArmConfig(name: string) {
    return this.request<{ deleted: boolean; filename: string }>(`/config/arms/${name}`, {
      method: 'DELETE',
    });
  }

  // OpenCode Providers (fetched from OpenCode server)
  async getOpenCodeProviders() {
    return this.request<{ 
      providers: OpenCodeProvider[];
      connected: string[];
      error?: string;
    }>('/opencode/providers');
  }

  // Arms
  async listArms() {
    return this.request<{ arms: Arm[] }>('/arms');
  }

  async getArm(id: string) {
    return this.request<{ arm: Arm }>(`/arms/${id}`);
  }

  async createArm(data: Partial<Arm>) {
    return this.request<{ arm: Arm }>('/arms', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateArm(id: string, data: Partial<Arm>) {
    return this.request<{ arm: Arm }>(`/arms/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async deleteArm(id: string) {
    return this.request<{ deleted: boolean }>(`/arms/${id}`, {
      method: 'DELETE',
    });
  }

  async getArmMessages(id: string, limit = 50) {
    return this.request<{ 
      messages: ArmMessage[];
      sessionId?: string;
      error?: string;
    }>(`/arms/${id}/messages?limit=${limit}`);
  }

  async getArmTodos(id: string) {
    return this.request<{
      todos: ArmTodo[];
      error?: string;
    }>(`/arms/${id}/todos`);
  }

  async getArmStatus(id: string) {
    return this.request<{
      status: string;
      opencodeStatus: { status: string; error?: string } | null;
      sessionId?: string;
      error?: string;
    }>(`/arms/${id}/status`);
  }

  async updateArmMetrics(id: string, data: {
    tokens?: { input?: number; output?: number };
    cost?: number;
    currentTask?: { id: string; subject: string } | null;
  }) {
    return this.request<{ success: boolean }>(`/arms/${id}/metrics`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  // SSE Event stream URL for arm events (includes API key as query param since EventSource can't send headers)
  getArmEventsUrl(id: string): string {
    const apiKey = this.getApiKey();
    const params = new URLSearchParams();
    if (apiKey) {
      params.set('api_key', apiKey);
    }
    return `${API_BASE}/arms/${id}/events?${params.toString()}`;
  }

  // Activity
  async listActivity(params?: { limit?: number; offset?: number; actor?: string }) {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', params.limit.toString());
    if (params?.offset) query.set('offset', params.offset.toString());
    if (params?.actor) query.set('actor', params.actor);
    
    const queryStr = query.toString();
    return this.request<{
      activity: ActivityEntry[];
      pagination: { limit: number; offset: number; total: number };
    }>(`/activity${queryStr ? `?${queryStr}` : ''}`);
  }

  // Brain
  async getBrainStatus() {
    return this.request<{
      brain: {
        status: string;
        lastPollAt: string | null;
        pollIntervalMs: number;
        activeArmsCount: number;
        pendingTasksCount: number;
        completedToday: number;
        uptime: number | null;
      };
    }>('/brain/status');
  }

  async startBrain() {
    return this.request<{ started: boolean; status: string }>('/brain/start', {
      method: 'POST',
    });
  }

  async stopBrain() {
    return this.request<{ stopped: boolean; status: string }>('/brain/stop', {
      method: 'POST',
    });
  }

  async getBrainConfig() {
    return this.request<{
      brain: {
        pollIntervalMs: number;
        maxArms: number;
        heartbeatTimeoutSeconds: number;
      };
    }>('/brain/config');
  }

  async sendBrainMessage(data: { message: string; priority?: 'critical' | 'high' | 'normal' | 'low'; domain?: string }) {
    return this.request<{ sent: boolean; messageId: string; subject: string }>('/brain/message', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // Mail
  async listInbox(params?: { limit?: number; offset?: number }) {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', params.limit.toString());
    if (params?.offset) query.set('offset', params.offset.toString());
    const queryStr = query.toString();
    return this.request<{
      messages: MailMessage[];
      pagination: { limit: number; offset: number; total: number; unread: number };
    }>(`/mail/inbox${queryStr ? `?${queryStr}` : ''}`);
  }

  async listSent(params?: { limit?: number; offset?: number }) {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', params.limit.toString());
    if (params?.offset) query.set('offset', params.offset.toString());
    const queryStr = query.toString();
    return this.request<{
      messages: MailMessage[];
      pagination: { limit: number; offset: number; total: number };
    }>(`/mail/sent${queryStr ? `?${queryStr}` : ''}`);
  }

  async listArchive(params?: { limit?: number; offset?: number }) {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', params.limit.toString());
    if (params?.offset) query.set('offset', params.offset.toString());
    const queryStr = query.toString();
    return this.request<{
      messages: MailMessage[];
      pagination: { limit: number; offset: number; total: number };
    }>(`/mail/archive${queryStr ? `?${queryStr}` : ''}`);
  }

  async sendMail(data: { from: string; to: string; subject: string; body: string; headers?: Record<string, string> }) {
    return this.request<{ message: MailMessage }>('/mail/send', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async markMailRead(id: string) {
    return this.request<{ success: boolean }>(`/mail/inbox/${id}/read`, {
      method: 'POST',
    });
  }

  async archiveMail(id: string) {
    return this.request<{ success: boolean }>(`/mail/inbox/${id}/archive`, {
      method: 'POST',
    });
  }

  // Status Reports
  async listStatusReports(params?: {
    taskId?: string;
    armId?: string;
    limit?: number;
    offset?: number;
  }) {
    const query = new URLSearchParams();
    if (params?.taskId) query.set('taskId', params.taskId);
    if (params?.armId) query.set('armId', params.armId);
    if (params?.limit) query.set('limit', params.limit.toString());
    if (params?.offset) query.set('offset', params.offset.toString());
    const queryStr = query.toString();
    return this.request<{
      reports: StatusReport[];
      pagination: { limit: number; offset: number; total: number };
    }>(`/status-reports${queryStr ? `?${queryStr}` : ''}`);
  }

  async getStatusReport(id: string) {
    return this.request<{ report: StatusReport }>(`/status-reports/${id}`);
  }

  async getStatusReportStats() {
    return this.request<{
      statusDistribution: Array<{ status: string; count: number }>;
      recentReports: number;
      reportsByArm: Array<{ armId: string; count: number }>;
    }>('/status-reports/stats');
  }

  // Tasks
  async listTasks(params?: {
    status?: string; 
    priority?: string; 
    domain?: string;
    assignedTo?: string;
    phase?: string;
    limit?: number; 
    offset?: number;
  }) {
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    if (params?.priority) query.set('priority', params.priority);
    if (params?.domain) query.set('domain', params.domain);
    if (params?.assignedTo) query.set('assignedTo', params.assignedTo);
    if (params?.phase) query.set('phase', params.phase);
    if (params?.limit) query.set('limit', params.limit.toString());
    if (params?.offset) query.set('offset', params.offset.toString());
    const queryStr = query.toString();
    return this.request<{
      tasks: Task[];
      pagination: { limit: number; offset: number; total: number };
      counts: { total: number; byStatus: Record<string, number> };
    }>(`/tasks${queryStr ? `?${queryStr}` : ''}`);
  }

  async getTask(id: string) {
    return this.request<{ task: Task; dependencies: string[] }>(`/tasks/${id}`);
  }

  async createTask(data: {
    subject: string;
    description: string;
    priority?: Task['priority'];
    domain?: string;
    phase?: string;
    sourceType?: Task['sourceType'];
    sourceRef?: string;
    dueDate?: string;
    metadata?: Record<string, unknown>;
  }) {
    return this.request<{ task: Task }>('/tasks', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateTask(id: string, data: Partial<{
    subject: string;
    description: string;
    status: Task['status'];
    priority: Task['priority'];
    domain: string;
    phase: string;
    assignedTo: string | null;
    dueDate: string | null;
    artifacts: string[];
    metadata: Record<string, unknown>;
  }>) {
    return this.request<{ task: Task }>(`/tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async deleteTask(id: string) {
    return this.request<{ deleted: boolean }>(`/tasks/${id}`, {
      method: 'DELETE',
    });
  }
}

// Types
export interface OctopaiConfig {
  version: number;
  brain: {
    pollIntervalMs: number;
    maxArms: number;
  };
  mail: {
    fromAddress: string;
    digestSchedule: 'immediate' | 'hourly' | 'daily';
  };
  terminal: {
    emulator: 'auto' | 'ghostty' | 'iterm2' | 'terminal' | 'wezterm';
  };
  defaults: {
    harness: string;
    provider: string;
    model: string;
    contextBudget: number;
  };
}

// Arm configuration file structure (from .octopai/arms/*.toml)
export interface ArmConfig {
  arm: {
    name: string;
    domain: string;
    harness: string;
  };
  context?: {
    budget?: number;
    priority_files?: string[];
  };
  personality?: {
    traits?: string;
  };
  convictions?: {
    core?: string[];
  };
  specializations?: string[];
  tools?: {
    requires_browser?: boolean;
  };
}

// Summary of arm config for listing
export interface ArmConfigSummary {
  filename: string;
  name: string;
  domain: string;
  harness: string;
  budget?: number;
}

// OpenCode provider/model info (from OpenCode server API)
export interface OpenCodeModel {
  id: string;
  name: string;
  limit?: {
    context?: number;
    output?: number;
  };
}

export interface OpenCodeProvider {
  id: string;
  name: string;
  models: OpenCodeModel[];
}

export interface Arm {
  id: string;
  name: string;
  domain: string;
  harness: string;
  status: 'idle' | 'busy' | 'paused' | 'error' | 'stopped';
  contextBudget: number;
  currentContextUsed: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  config: Record<string, unknown>;
  personality?: string;
  convictions?: string[];
  reputation?: number;
  totalTokens?: number;
  totalCost?: number;
  currentTaskSubject?: string;
  provider?: string;
  model?: string;
}

export interface ActivityEntry {
  id: number;
  timestamp: string;
  actor: string;
  action: string;
  target: string | null;
  details: Record<string, unknown>;
}

export interface MailMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
  headers: Record<string, string>;
  flags: {
    seen: boolean;
    replied: boolean;
    flagged: boolean;
    draft: boolean;
    trashed: boolean;
  };
  filePath?: string;
}

// Arm message from OpenCode session
export interface ArmMessagePart {
  type: string;
  text?: string;
  toolName?: string;
  name?: string;
  state?: string;
  result?: unknown;
  error?: string;
}

export interface ArmMessage {
  info: {
    id: string;
    role: 'user' | 'assistant' | 'system';
    time?: number;
    error?: { name: string; data?: { message: string } };
  };
  parts: ArmMessagePart[];
}

// Arm todo from OpenCode session
export interface ArmTodo {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'high' | 'medium' | 'low';
}

// Status report from arm during or after task execution
export interface StatusReport {
  id: string;
  taskId: string;
  armId: string;
  status: "on_track" | "blocked" | "issues_found" | "needs_review" | "completed_with_issues";
  summary: string;
  issues?: string[];
  blockers?: string[];
  nextSteps?: string;
  filesChanged?: string[];
  testsStatus?: "passing" | "failing" | "not_run";
  createdAt: string;
  updatedAt?: string;
  resolvedAt?: string;
  resolution?: string;
}

// Brain-managed task
export interface Task {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'claimed' | 'in_progress' | 'completed' | 'failed' | 'blocked' | 'cancelled';
  priority: 'critical' | 'high' | 'normal' | 'low';
  sourceType: 'manual' | 'plan' | 'email' | 'discovery' | 'proposal';
  sourceRef: string | null;
  phase: string | null;
  domain: string | null;
  assignedTo: string | null;
  assignedArmName?: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  claimedAt: string | null;
  startedAt: string | null;
  dueDate: string | null;
  artifacts: string[];
  metadata: Record<string, unknown>;
}

// OpenCode SSE event types
export interface OpenCodeEvent {
  type: string;
  properties: Record<string, unknown>;
}

// Singleton instance
export const api = new ApiClient();
