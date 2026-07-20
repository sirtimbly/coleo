/**
 * API Client for Coleo Observatory
 */

import type {
  ArmConfig as SharedArmConfig,
  ArmConfigSummary as SharedArmConfigSummary,
  ColeoConfig as SharedColeoConfig,
  StatusReport as SharedStatusReport,
  TaskAttachment as SharedTaskAttachment,
  TaskComment as SharedTaskComment,
  TaskSummary as SharedTaskSummary,
  TaskDiff as SharedTaskDiff,
  TaskWorkAuthorType as SharedTaskWorkAuthorType,
} from '../../../types';

const API_BASE = '/api';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface UiMetadata extends JsonObject {
  tags?: string[];
  color?: string;
  bold?: boolean;
}

export interface TaskLlmMessage extends JsonObject {
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

export interface TaskLlmMetadata extends JsonObject {
  originalPrompt?: string;
  generatedDescription?: string;
  history?: TaskLlmMessage[];
}

export interface TaskUiMetadata extends UiMetadata {
  llm?: TaskLlmMetadata;
}

export interface TaskMetadata extends JsonObject {
  ui?: TaskUiMetadata;
}

export type BugUiMetadata = UiMetadata;

export interface BugMetadata extends JsonObject {
  ui?: BugUiMetadata;
}

interface ApiError {
  error: string;
  message?: string;
}

export interface OnboardingStatus {
  ready: boolean;
  projectDir: string;
  repository: {
    checkedOut: boolean;
    remoteUrl: string | null;
    branch: string | null;
  };
  ssh: {
    configured: boolean;
    publicKey: string | null;
  };
}

export interface WorkspaceTextFile {
  path: string;
  content: string;
  contentHash: string;
  size: number;
  modifiedAt: string;
}

export interface ProjectPlanCandidate extends WorkspaceTextFile {
  score: number;
  reasons: string[];
}

export interface SetupTemplateFile extends WorkspaceTextFile {
  format: 'yaml' | 'toml' | 'jinja';
}

export interface ProjectSetupStatus {
  required: boolean;
  completed: boolean;
  taskCount: number;
  canonicalPlan: WorkspaceTextFile | null;
  canonicalTaskCount: number;
  candidates: ProjectPlanCandidate[];
  templateFiles: SetupTemplateFile[];
  recommendedPath: string;
  defaultContent: string;
  defaultTemplateContent: string;
}

class ApiClient {
  private apiKey: string | null = null;

  setApiKey(key: string) {
    this.apiKey = key;
    localStorage.setItem('coleo_api_key', key);
  }

  getApiKey(): string | null {
    if (!this.apiKey) {
      this.apiKey = localStorage.getItem('coleo_api_key');
    }
    return this.apiKey;
  }

  clearApiKey() {
    this.apiKey = null;
    localStorage.removeItem('coleo_api_key');
  }

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const headers = new Headers(options.headers);
    if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const apiKey = this.getApiKey();
    if (apiKey) {
      headers.set('X-API-Key', apiKey);
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

  async getOnboardingStatus() {
    return this.request<OnboardingStatus>('/onboarding');
  }

  async generateOnboardingSshKey() {
    return this.request<OnboardingStatus>('/onboarding/ssh-key', {
      method: 'POST',
    });
  }

  async cloneOnboardingRepository(data: { repositoryUrl: string; branch?: string }) {
    return this.request<OnboardingStatus>('/onboarding/clone', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getProjectSetupStatus() {
    return this.request<ProjectSetupStatus>('/project-setup');
  }

  async saveProjectSetupFile(data: { path: string; content: string; expectedHash?: string | null; kind: 'plan' | 'template' }) {
    return this.request<{ file: WorkspaceTextFile }>('/project-setup/file', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async saveProjectPlanFile(data: { path: string; content: string; expectedHash?: string | null }) {
    return this.saveProjectSetupFile({ ...data, kind: 'plan' });
  }

  async prepareProjectPlan(data: { sourcePath: string; content: string; expectedHash?: string | null }) {
    return this.request<{
      completed: boolean;
      mode: 'ai' | 'structured';
      canonicalPlan: WorkspaceTextFile;
      taskCount: number;
    }>('/project-setup/prepare', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async search(params: {
    query: string;
    types?: string[];
    limit?: number;
    keywordWeight?: number;
    semanticWeight?: number;
  }) {
    return this.request<SearchResponse>('/search', {
      method: 'POST',
      body: JSON.stringify({
        query: params.query,
        types: params.types,
        limit: params.limit ?? 20,
        // Prefer keyword for command-palette snappiness; semantic is optional/slow.
        keywordWeight: params.keywordWeight ?? 0.85,
        semanticWeight: params.semanticWeight ?? 0.15,
      }),
    });
  }

  async status() {
    return this.request<{
      status: string;
      version: string;
      cwd: string;
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
        qdrant: { healthy: boolean; optional: boolean; error?: string };
        indexer: { healthy: boolean; optional: boolean; running: boolean; error?: string };
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
    return this.request<{ config: ColeoConfig }>('/config');
  }

  async updateConfig(data: Partial<ColeoConfig>) {
    return this.request<{ config: ColeoConfig }>('/config', {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async getDefaults() {
    return this.request<{ defaults: ColeoConfig['defaults'] }>('/config/defaults');
  }

  async updateDefaults(data: Partial<ColeoConfig['defaults']>) {
    return this.request<{ defaults: ColeoConfig['defaults'] }>('/config/defaults', {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async updateBrainConfig(data: Partial<ColeoConfig['brain']>) {
    return this.request<{ brain: ColeoConfig['brain'] }>('/config/brain', {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  // Mail Config
  async getMailConfig() {
    return this.request<{ mail: ColeoConfig['mail'] }>('/config/mail');
  }

  async updateMailConfig(data: Partial<ColeoConfig['mail']>) {
    return this.request<{ mail: ColeoConfig['mail'] }>('/config/mail', {
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

  // OpenCode Providers (served from the API's cached local OpenCode catalog)
  async getOpenCodeProviders() {
    return this.request<{
      providers: OpenCodeProvider[];
      connected: string[];
      default?: Record<string, string>;
      error?: string;
      message?: string;
      fallback?: boolean;
      cached?: boolean;
      cachedAt?: string;
      source?: 'live' | 'cache' | 'fallback';
    }>('/opencode/providers');
  }

  async getAgentOpenCodeProviders(agentId: string) {
    return this.request<{ providers: OpenCodeProvider[] }>(
      `/opencode/agents/${encodeURIComponent(agentId)}/providers`,
    );
  }

  async setAgentOpenCodeApiKey(agentId: string, providerId: string, apiKey: string) {
    return this.request<{ providers: OpenCodeProvider[] }>(
      `/opencode/agents/${encodeURIComponent(agentId)}/providers/${encodeURIComponent(providerId)}/api-key`,
      {
        method: 'POST',
        body: JSON.stringify({ apiKey }),
      },
    );
  }

  async listAgents() {
    return this.request<{ agents: AgentInfo[] }>('/agents');
  }

  async getAgentProviderStatus() {
    return this.request<{ hosts: AgentProviderStatus[] }>('/agents/providers');
  }

  async listArmTemplates() {
    return this.request<{ templates: ArmTemplateSummary[] }>('/arms/templates');
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

  async spawnArm(id: string, data: SpawnArmRequest = {}) {
    return this.request<SpawnArmResponse>(`/arms/${id}/spawn`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async recoverArm(id: string, data: SpawnArmRequest = {}) {
    return this.request<SpawnArmResponse>(`/arms/${id}/recover`, {
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

  async sendArmPrompt(data: {
    armId: string;
    prompt: string;
    interrupt?: boolean;
    attachments?: TaskAttachment[];
  }) {
    const { armId, ...body } = data;
    return this.request<{ success: boolean; message: string; distributed?: boolean }>(`/arms/${armId}/prompt`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
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

  async getTranscriptIndexerHealth(params?: { stream?: string; durable?: string; staleMs?: number }) {
    const query = new URLSearchParams();
    if (params?.stream) query.set('stream', params.stream);
    if (params?.durable) query.set('durable', params.durable);
    if (params?.staleMs) query.set('staleMs', params.staleMs.toString());
    const queryStr = query.toString();
    return this.request<TranscriptIndexerHealth>(
      `/activity/indexer-health${queryStr ? `?${queryStr}` : ''}`
    );
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

  async sendBrainMessage(data: {
    message: string;
    priority?: 'critical' | 'high' | 'normal' | 'low';
    domain?: string;
    inReplyTo?: string;
    threadId?: string;
    subject?: string;
    attachments?: TaskAttachment[];
  }) {
    return this.request<{ sent: boolean; messageId: string; subject: string }>('/brain/message', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async uploadImage(file: File) {
    const formData = new FormData();
    formData.append('file', file);
    return this.request<{ attachment: TaskAttachment }>('/uploads/images', {
      method: 'POST',
      body: formData,
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

  // Status history (Qdrant hybrid semantic search)
  async searchStatusHistory(params: {
    query: string;
    armIds?: string[];
    eventTypes?: string[];
    taskId?: string;
    bugId?: string;
    from?: string;
    to?: string;
    daysBack?: number;
    limit?: number;
    keywordWeight?: number;
    semanticWeight?: number;
  }) {
    const filters: Record<string, unknown> = {};
    if (params.armIds?.length) filters.arm_ids = params.armIds;
    if (params.eventTypes?.length) filters.event_types = params.eventTypes;
    if (params.taskId) filters.task_id = params.taskId;
    if (params.bugId) filters.bug_id = params.bugId;
    if (params.from) {
      filters.from = params.from;
    } else if (params.daysBack !== undefined) {
      filters.from = new Date(Date.now() - params.daysBack * 24 * 60 * 60 * 1000).toISOString();
    }
    if (params.to) filters.to = params.to;

    return this.request<StatusHistorySearchResponse>('/status-history/search', {
      method: 'POST',
      body: JSON.stringify({
        query: params.query,
        filters,
        limit: params.limit ?? 20,
        keywordWeight: params.keywordWeight,
        semanticWeight: params.semanticWeight,
        include_context: true,
      }),
    });
  }

  async getStatusHistoryStats(period = 'all') {
    return this.request<{
      period: string;
      healthy: boolean;
      collectionExists: boolean;
      pointsCount: number;
    }>(`/status-history/stats?period=${encodeURIComponent(period)}`);
  }

  // Bugs
  async listBugs(params?: {
    source?: string;
    status?: string;
    priority?: string;
    assignee?: string;
    limit?: number;
  }) {
    const query = new URLSearchParams();
    if (params?.source) query.set('source', params.source);
    if (params?.status) query.set('status', params.status);
    if (params?.priority) query.set('priority', params.priority);
    if (params?.assignee) query.set('assignee', params.assignee);
    if (params?.limit) query.set('limit', params.limit.toString());
    const queryStr = query.toString();
    return this.request<{ bugs: Bug[] }>(`/bugs${queryStr ? `?${queryStr}` : ''}`);
  }

  async getBug(id: string) {
    return this.request<{ bug: Bug }>(`/bugs/${id}`);
  }

  async createBug(bug: {
    title: string;
    description: string;
    source: "arm_reported" | "human_reported" | "system_detected";
    sourceTaskId?: string;
    priority?: "low" | "medium" | "high" | "critical";
    errorDetails?: string;
    metadata?: BugMetadata;
  }) {
    return this.request<{ bug: Bug }>(`/bugs`, {
      method: 'POST',
      body: JSON.stringify(bug),
    });
  }

  async updateBug(id: string, updates: {
    title?: string;
    description?: string;
    status?: Bug['status'];
    priority?: Bug['priority'];
    assigneeArmId?: string;
    blockers?: string[];
    resolution?: string;
    humanNotified?: boolean;
    metadata?: BugMetadata;
  }) {
    return this.request<{ success: boolean }>(`/bugs/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }

  async deleteBug(id: string) {
    return this.request<{ success: boolean }>(`/bugs/${id}`, {
      method: 'DELETE',
    });
  }

  async getBugStats() {
    return this.request<{
      bySource: Record<string, number>;
      byStatus: Record<string, number>;
      byPriority: Record<string, number>;
      recent24h: number;
      unresolved: number;
    }>('/bugs/stats');
  }

  async reorderBug(bugId: string, toSortOrder: number) {
    return this.request<{ success: boolean }>('/bugs/reorder', {
      method: 'POST',
      body: JSON.stringify({ bugId, toSortOrder }),
    });
  }

  // Discoveries
  async listDiscoveries(params?: {
    armId?: string;
    kind?: string;
    severity?: string;
    status?: string;
    limit?: number;
  }) {
    const query = new URLSearchParams();
    if (params?.armId) query.set('armId', params.armId);
    if (params?.kind) query.set('kind', params.kind);
    if (params?.severity) query.set('severity', params.severity);
    if (params?.status) query.set('status', params.status);
    if (params?.limit) query.set('limit', params.limit.toString());
    const queryStr = query.toString();
    return this.request<{ discoveries: Discovery[] }>(`/discoveries${queryStr ? `?${queryStr}` : ''}`);
  }

  async getDiscovery(id: string) {
    return this.request<{ discovery: Discovery }>(`/discoveries/${id}`);
  }

  async updateDiscovery(id: string, updates: {
    status: string;
  }) {
    return this.request<{ success: boolean }>(`/discoveries/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }

  async getDiscoveryStats() {
    return this.request<{
      bySeverity: Record<string, number>;
      byKind: Record<string, number>;
      byStatus: Record<string, number>;
      recent24h: number;
    }>('/discoveries/stats');
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
    progress?: number;
    metadata?: TaskMetadata;
    sortOrder?: number;
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
    progress: number;
    artifacts: string[];
    metadata: TaskMetadata;
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

  async getTaskStats() {
    return this.request<{
      total: number;
      byStatus: Record<string, number>;
      completionRate: number;
      active: number;
      blocked: number;
    }>('/tasks/stats');
  }

  async getTaskBurndown(params: {
    start: string;
    end: string;
    bin?: 'hour' | 'day' | 'week' | 'month';
    status?: string;
    assignedTo?: string;
    domain?: string;
    timeZone?: string;
  }) {
    const query = new URLSearchParams();
    query.set('start', params.start);
    query.set('end', params.end);
    if (params.bin) query.set('bin', params.bin);
    if (params.status?.trim()) query.set('status', params.status);
    if (params.assignedTo?.trim()) query.set('assignedTo', params.assignedTo);
    if (params.domain?.trim()) query.set('domain', params.domain);
    if (params.timeZone?.trim()) query.set('timeZone', params.timeZone);

    return this.request<{
      start: string;
      end: string;
      bin: 'hour' | 'day' | 'week' | 'month';
      timeZone: string;
      buckets: Array<{
        bucket: string;
        created: number;
        completed: number;
        cumulativeCreated: number;
        cumulativeCompleted: number;
      }>;
    }>(`/tasks/burndown?${query.toString()}`);
  }

  async getTaskBlockingBugs(taskId: string) {
    return this.request<{
      taskId: string;
      blockingBugs: Array<{
        id: string;
        title: string;
        description: string;
        source: string;
        status: string;
        priority: string;
        assigneeArmId?: string;
        createdAt: string;
        updatedAt: string;
      }>;
      count: number;
    }>(`/tasks/${taskId}/blocking-bugs`);
  }

  // Task Discussions
  async getTaskDiscussions(
    taskId: string,
    params?: {
      limit?: number;
      offset?: number;
      threaded?: boolean;
    }
  ) {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', params.limit.toString());
    if (params?.offset) query.set('offset', params.offset.toString());
    if (params?.threaded) query.set('threaded', 'true');
    const queryStr = query.toString();
    return this.request<{
      discussions: TaskComment[];
      totalCount: number;
    }>(`/tasks/${taskId}/discussions${queryStr ? `?${queryStr}` : ''}`);
  }

  async createTaskDiscussion(
    taskId: string,
    data: {
      content: string;
      parentId?: string;
      authorType: 'human' | 'arm' | 'brain';
      authorId: string;
      authorName?: string;
      client: 'web' | 'mail' | 'mcp' | 'cli';
    }
  ) {
    return this.request<{ comment: TaskComment }>(`/tasks/${taskId}/discussions`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateTaskDiscussion(
    taskId: string,
    commentId: string,
    data: { content: string; authorId: string }
  ) {
    return this.request<{ comment: TaskComment }>(`/tasks/${taskId}/discussions/${commentId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async deleteTaskDiscussion(taskId: string, commentId: string, authorId: string) {
    return this.request<{ deleted: boolean }>(`/tasks/${taskId}/discussions/${commentId}`, {
      method: 'DELETE',
      body: JSON.stringify({ authorId }),
    });
  }

  async markTaskDiscussionsRead(taskId: string, userId: string, lastReadCommentId: string) {
    return this.request<{ marked: boolean }>(`/tasks/${taskId}/discussions/mark-read`, {
      method: 'POST',
      body: JSON.stringify({ userId, lastReadCommentId }),
    });
  }

  async getUnreadDiscussionCount(taskId: string, userId: string) {
    return this.request<{ unreadCount: number }>(`/tasks/${taskId}/discussions/unread?userId=${encodeURIComponent(userId)}`);
  }

  // Task Summaries (work-in-progress log)
  async getTaskSummaries(taskId: string, params?: { limit?: number; offset?: number }) {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', params.limit.toString());
    if (params?.offset) query.set('offset', params.offset.toString());
    const queryStr = query.toString();
    return this.request<{ summaries: TaskSummary[]; latest: TaskSummary | null }>(
      `/tasks/${taskId}/summaries${queryStr ? `?${queryStr}` : ''}`
    );
  }

  async getLatestTaskSummary(taskId: string) {
    return this.request<{ summary: TaskSummary | null }>(`/tasks/${taskId}/summaries/latest`);
  }

  async createTaskSummary(
    taskId: string,
    data: { content: string; authorType: TaskWorkAuthorType; authorId: string; authorName?: string }
  ) {
    return this.request<{ summary: TaskSummary }>(`/tasks/${taskId}/summaries`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }
  // Task Checklists
  async getTaskChecklist(taskId: string) {
    return this.request<{ items: ChecklistItem[] }>(`/tasks/${taskId}/checklist`);
  }

  async createChecklistItem(taskId: string, data: {
    text: string;
    completed?: boolean;
    sortOrder?: number;
  }) {
    return this.request<{ item: ChecklistItem }>(`/tasks/${taskId}/checklist`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateTaskSummary(taskId: string, summaryId: string, content: string) {
    return this.request<{ summary: TaskSummary }>(`/tasks/${taskId}/summaries/${summaryId}`, {
      method: 'PATCH',
      body: JSON.stringify({ content }),
    });
  }

  // Task Diffs (work-in-progress diff log)
  async getTaskDiffs(taskId: string, params?: { limit?: number; offset?: number }) {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', params.limit.toString());
    if (params?.offset) query.set('offset', params.offset.toString());
    const queryStr = query.toString();
    return this.request<{ diffs: TaskDiff[]; totalCount: number }>(
      `/tasks/${taskId}/diffs${queryStr ? `?${queryStr}` : ''}`
    );
  }

  async getTaskDiff(taskId: string, diffId: string) {
    return this.request<{ diff: TaskDiff }>(`/tasks/${taskId}/diffs/${diffId}`);
  }

  async createTaskDiff(
    taskId: string,
    data: {
      title?: string;
      filePath?: string;
      diff: string;
      additions?: number;
      deletions?: number;
      authorType: TaskWorkAuthorType;
      authorId: string;
      authorName?: string;
    }
  ) {
    return this.request<{ diff: TaskDiff }>(`/tasks/${taskId}/diffs`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }
  async updateChecklistItem(taskId: string, itemId: number, data: {
    text?: string;
    completed?: boolean;
    sortOrder?: number;
  }) {
    return this.request<{ item: ChecklistItem }>(`/tasks/${taskId}/checklist/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async markTaskDiffsViewed(taskId: string, userId: string, lastViewedDiffId: string) {
    return this.request<{ marked: boolean }>(`/tasks/${taskId}/diffs/mark-viewed`, {
      method: 'POST',
      body: JSON.stringify({ userId, lastViewedDiffId }),
    });
  }

  async getUnviewedDiffCount(taskId: string, userId: string) {
    return this.request<{ unviewedCount: number }>(`/tasks/${taskId}/diffs/unviewed?userId=${encodeURIComponent(userId)}`);
  }
  async deleteChecklistItem(taskId: string, itemId: number) {
    return this.request<{ success: boolean }>(`/tasks/${taskId}/checklist/${itemId}`, {
      method: 'DELETE',
    });
  }

  async reorderChecklistItems(taskId: string, itemIds: number[]) {
    return this.request<{ success: boolean }>(`/tasks/${taskId}/checklist/reorder`, {
      method: 'POST',
      body: JSON.stringify({ itemIds }),
    });
  }

  async removeTaskFromPlan(id: string) {
    return this.request<{ deleted: boolean; removedFromPlan: boolean }>(`/tasks/${id}/remove-from-plan`, {
      method: 'POST',
    });
  }

  async reorderTask(taskId: string, toSortOrder: number, prevTaskId?: string | null, nextTaskId?: string | null) {
    return this.request<{ success: boolean }>('/tasks/reorder', {
      method: 'POST',
      body: JSON.stringify({ taskId, toIndex: toSortOrder, prevTaskId, nextTaskId }),
    });
  }

  // Events API - arm health monitoring
  async getArmEventWindow(armId: string, options?: { windowMs?: number; limit?: number }) {
    const query = new URLSearchParams();
    if (options?.windowMs) query.set('windowMs', options.windowMs.toString());
    if (options?.limit) query.set('limit', options.limit.toString());
    const queryStr = query.toString();
    return this.request<EventWindowResponse>(
      `/events/arms/${armId}/window${queryStr ? `?${queryStr}` : ''}`
    );
  }

  async getArmAnalysis(armId: string, options?: { windowMs?: number }) {
    const query = new URLSearchParams();
    if (options?.windowMs) query.set('windowMs', options.windowMs.toString());
    const queryStr = query.toString();
    return this.request<ArmAnalysisFull>(
      `/events/arms/${armId}/analysis${queryStr ? `?${queryStr}` : ''}`
    );
  }

  async getAllArmsAnalysis(options?: { windowMs?: number }) {
    const query = new URLSearchParams();
    if (options?.windowMs) query.set('windowMs', options.windowMs.toString());
    const queryStr = query.toString();
    return this.request<AllArmsAnalysis>(
      `/events/analysis${queryStr ? `?${queryStr}` : ''}`
    );
  }

  async getRecentEvents(options?: { limit?: number; sinceMs?: number }) {
    const query = new URLSearchParams();
    if (options?.limit) query.set('limit', options.limit.toString());
    if (options?.sinceMs) query.set('sinceMs', options.sinceMs.toString());
    const queryStr = query.toString();
    return this.request<RecentEventsResponse>(
      `/events/recent${queryStr ? `?${queryStr}` : ''}`
    );
  }

  async getEventTypes() {
    return this.request<{ knownTypes: string[]; count: number }>('/events/types');
  }

  // Garden
  async getGardenScene() {
    return this.request<{ scene: GardenScene }>('/garden/scene');
  }

  async getHealthConfig() {
    return this.request<{
      analyzer: {
        silentThresholdMs: number;
        productiveEventThreshold: number;
        loopRepetitionThreshold: number;
        permissionEscalationMs: number;
        startupGracePeriodMs: number;
      };
      sse: {
        minIntervalPerArmMs: number;
        maxQueueSize: number;
        flushIntervalMs: number;
        heartbeatIntervalMs: number;
      };
    }>('/events/health/config');
  }

  // SSE Event stream URL for global events
  getEventsStreamUrl(options?: { armIds?: string[]; types?: string[] }): string {
    const apiKey = this.getApiKey();
    const params = new URLSearchParams();
    if (apiKey) params.set('api_key', apiKey);
    if (options?.armIds?.length) params.set('armIds', options.armIds.join(','));
    if (options?.types?.length) params.set('types', options.types.join(','));
    return `${API_BASE}/events/stream?${params.toString()}`;
  }

}

// Types
export type ColeoConfig = SharedColeoConfig;

// Arm configuration file structure (from .coleo/arms/*.toml)
export type ArmConfig = SharedArmConfig;

// Summary of arm config for listing
export type ArmConfigSummary = SharedArmConfigSummary;

export interface ArmTemplateSummary {
  id: string;
  filename: string;
  name: string;
  description: string;
  domain: string;
  harness: string;
  contextBudget: number;
  provider?: string;
  model?: string;
}

// OpenCode provider/model info (from the cached authenticated OpenCode catalog)
export interface OpenCodeModel {
  id: string;
  name: string;
  limit?: {
    context?: number;
    output?: number;
  };
  modalities?: {
    input: Array<'text' | 'audio' | 'image' | 'video' | 'pdf'>;
    output: Array<'text' | 'audio' | 'image' | 'video' | 'pdf'>;
  };
}

export type TaskAttachment = SharedTaskAttachment;

export interface SearchResult {
  id: string;
  type: string;
  title: string;
  content: string;
  score: number;
  keywordScore?: number;
  semanticScore?: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  query: string;
  semanticUsed: boolean;
  took: number;
}

export interface StatusHistoryEvent {
  id: string;
  type: string;
  timestamp: string;
  source: string;
  title: string;
  content: string;
  taskId?: string;
  bugId?: string;
  discoveryId?: string;
  armId?: string;
  status?: string;
  priority?: string;
  metadata: Record<string, unknown>;
}

export interface StatusHistorySearchHit {
  event: StatusHistoryEvent;
  score: number;
  keywordScore: number;
  semanticScore: number;
  highlights: string[];
}

export interface StatusHistorySearchResponse {
  results: StatusHistorySearchHit[];
  total: number;
  query: string;
  semanticUsed: boolean;
  query_time_ms: number;
}

export interface OpenCodeProvider {
  id: string;
  name: string;
  models: OpenCodeModel[];
  connected?: boolean;
  authMethod?: 'api-key' | 'oauth' | 'external';
}

export interface AgentInfo {
  agentId: string;
  hostname: string;
  platform: string;
  startedAt: string;
  version: string;
  capabilities: string[];
  maxArms: number;
}

export interface AgentProviderStatus {
  agentId: string;
  hostname: string;
  version: string;
  configuredProviders: Array<{
    id: string;
    name: string;
    authMethod: 'api-key' | 'oauth' | 'external';
  }>;
  availableProviderCount: number;
  error: string | null;
}

export interface Arm {
  id: string;
  name: string;
  domain: string;
  harness: string;
  status: 'idle' | 'busy' | 'paused' | 'error' | 'stopped' | 'starting' | 'running';
  contextBudget: number;
  currentContextUsed: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  lastHeartbeat?: string | null;
  lastOutputAt?: string | null;
  config: JsonObject;
  personality?: string;
  convictions?: string[];
  reputation?: number;
  totalTokens?: number;
  totalCost?: number;
  currentTaskSubject?: string;
  currentBugId?: string;
  currentBugTitle?: string;
  pid?: number;
  port?: number;
  provider?: string;
  model?: string;
  agentId?: string;
  host?: string;
  sessionId?: string;
  workdir?: string;
  runtime?: ArmRuntimeSummary;
}

export interface SpawnArmRequest {
  name?: string;
  domain?: string;
  template?: string;
  workdir?: string;
  provider?: string;
  model?: string;
  initialPrompt?: string;
  harness?: string;
  preferAgent?: boolean;
  agentId?: string;
  recover?: boolean;
  allowLocalFallback?: boolean;
}

export interface SpawnArmResponse {
  spawned: boolean;
  recovered?: boolean;
  recoveryMode?: 'reattached' | 'recovered' | 'restarted';
  distributed?: boolean;
  agentId?: string;
  host?: string;
  pid?: number;
  port?: number;
  sessionId?: string;
  provider?: string;
  model?: string;
}

export interface ArmRuntimeSummary {
  state: 'starting' | 'active' | 'quiet' | 'hung' | 'recoverable' | 'stopped' | 'unknown';
  reason: string;
  distributed: boolean;
  hasRuntime: boolean;
  hasSession: boolean;
  canRecover: boolean;
  canRestart: boolean;
  lastActivityAt: string | null;
  lastHeartbeatAt: string | null;
  lastOutputAt: string | null;
  secondsSinceActivity: number | null;
  secondsSinceHeartbeat: number | null;
  secondsSinceOutput: number | null;
  signals: {
    dbStatus: string;
    hasPid: boolean;
    hasPort: boolean;
    hasSessionId: boolean;
    hasAgentId: boolean;
    hasWorkdir: boolean;
    hasAssignedTask: boolean;
    distributed: boolean;
  };
}

export interface ActivityEntry {
  id: number;
  timestamp: string;
  actor: string;
  action: string;
  target: string | null;
  details: JsonObject;
}

export interface GardenVec3 {
  x: number;
  y: number;
  z: number;
}

export interface GardenSceneAnchor {
  id: string;
  label: string;
  kind: 'workspace' | 'domain' | 'operations';
  position: GardenVec3;
  itemCount: number;
}

export interface GardenSceneBrain {
  id: 'brain';
  label: string;
  position: GardenVec3;
  status: 'stopped' | 'running' | 'paused';
  pollIntervalMs: number;
  lastPollAt?: string;
  pendingTasks: number;
  completedToday: number;
  completedTaskCount: number;
}

export interface GardenSceneArm {
  id: string;
  label: string;
  domain: string | null;
  position: GardenVec3;
  legacyStatus: string;
  lifecycleState: string | null;
  currentTaskId: string | null;
  currentBugId: string | null;
  targetAnchorId: string | null;
  lastActivityAt: string | null;
  lastHeartbeatAt: string | null;
  lastOutputAt: string | null;
  workdir: string | null;
}

export interface GardenSceneTask {
  id: string;
  label: string;
  position: GardenVec3;
  status: string;
  priority: string;
  domain: string | null;
  classification: string | null;
  phase: string | null;
  assignedTo: string | null;
  anchorId: string;
  progress: number | null;
  updatedAt: string;
}

export interface GardenSceneBug {
  id: string;
  label: string;
  position: GardenVec3;
  status: string;
  priority: string;
  assigneeArmId: string | null;
  sourceTaskId: string | null;
}

export interface GardenSceneBubble {
  id: string;
  label: string;
  kind: 'proposal' | 'discovery' | 'health';
  position: GardenVec3;
  status: string;
  severity?: string | null;
  phase?: string | null;
  sourceArmId?: string | null;
  taskId?: string | null;
}

export interface GardenSceneLink {
  id: string;
  kind: 'brain_arm' | 'task_assignment' | 'claim' | 'consensus';
  sourceId: string;
  targetId: string;
  weight: number;
  opacity: number;
  count?: number;
}

export interface GardenSceneStats {
  activeArms: number;
  visibleTasks: number;
  visibleBugs: number;
  visibleDiscoveries: number;
  openProposals: number;
  activeClaims: number;
  conflictZones: number;
  recentActivity: number;
}

export interface GardenScene {
  generatedAt: string;
  brain: GardenSceneBrain;
  anchors: GardenSceneAnchor[];
  arms: GardenSceneArm[];
  tasks: GardenSceneTask[];
  bugs: GardenSceneBug[];
  bubbles: GardenSceneBubble[];
  links: GardenSceneLink[];
  stats: GardenSceneStats;
}

export interface TranscriptIndexerHealth {
  status: "healthy" | "lagging" | "stale" | "unavailable" | "error";
  stream: string;
  durable: string;
  consumerFound: boolean;
  lagMessages: number | null;
  ackPending: number | null;
  streamLastSeq: number | null;
  streamMessages?: number;
  consumerStreamSeq: number | null;
  consumerSeq: number | null;
  lastActive: string | null;
  staleThresholdMs: number;
  updatedAt: string;
  message?: string;
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
  id?: string;
  text?: string;
  tool?: string;
  toolName?: string;
  name?: string;
  state?: JsonValue;
  input?: JsonValue;
  output?: JsonValue;
  time?: JsonValue;
  result?: JsonValue;
  error?: JsonValue;
}

export interface ArmMessage {
  info: {
    id: string;
    role: 'user' | 'assistant' | 'system';
    time?: JsonValue;
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
export type StatusReport = SharedStatusReport;

// Bug tracking
export interface Bug {
  id: string;
  title: string;
  description: string;
  source: "arm_reported" | "human_reported" | "system_detected";
  sourceArmId?: string;
  sourceTaskId?: string;
  status: "open" | "investigating" | "fixing" | "verifying" | "resolved" | "closed";
  priority: "low" | "medium" | "high" | "critical";
  assigneeArmId?: string;
  assigneeArmName?: string;
  blockers: string[]; // Array of blocking task IDs
  errorDetails?: string;
  resolution?: string;
  sortOrder?: number;
  metadata?: BugMetadata;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  humanNotified: boolean;
}

export interface Discovery {
  id: string;
  armId: string;
  armName: string;
  kind: string;
  title: string;
  details: string;
  filePath: string | null;
  lineNumber: number | null;
  severity: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

// Task comment/discussion
export type TaskComment = SharedTaskComment;

// Task work summary/diff log entries
export type TaskWorkAuthorType = SharedTaskWorkAuthorType;
export type TaskSummary = SharedTaskSummary;
export type TaskDiff = SharedTaskDiff;
// Task checklist item
export interface ChecklistItem {
  id: number;
  taskId: string;
  text: string;
  completed: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
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
  planLineUid?: string | null;
  sortOrder?: number | null;
  progress?: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  claimedAt: string | null;
  startedAt: string | null;
  dueDate: string | null;
  artifacts: string[];
  metadata: TaskMetadata;
  commentCount?: number;
  lastCommentAt?: string | null;
  checklist?: ChecklistItem[];
}

// OpenCode SSE event types
export interface OpenCodeEvent extends JsonObject {
  type: string;
  properties: JsonObject;
}

export function isOpenCodeEvent(value: JsonValue | undefined): value is OpenCodeEvent {
  if (!isJsonObject(value)) return false;
  return typeof value.type === 'string' && isJsonObject(value.properties);
}

// Arm activity analysis types (from brain event-window system)
export type ArmActivityState =
  | "productive"
  | "idle"
  | "waiting_permission"
  | "looping"
  | "silent"
  | "error"
  | "starting";

export interface ArmAnalysis {
  armId: string;
  state: ArmActivityState;
  confidence: "high" | "medium" | "low";
  reason: string;
  recommendedAction?: "none" | "prompt" | "interrupt" | "kill" | "escalate";
  silentDurationMs: number;
  hasPermissionPending: boolean;
}

export interface ArmAnalysisFull {
  armId: string;
  analysis: {
    state: ArmActivityState;
    confidence: "high" | "medium" | "low";
    reason: string;
    recommendedAction?: string;
    metrics: {
      eventCount: number;
      silentDurationMs: number;
      lastEventAt: string | null;
      recentMessageCount: number;
      recentToolCount: number;
      recentFileEditCount: number;
    };
    pendingPermission?: {
      requestedAt: string;
      action: string;
      context?: string;
    };
    loopPattern?: {
      pattern: string[];
      repetitions: number;
    };
    unknownEventTypes: string[];
  };
  trend: {
    improving: boolean;
    degrading: boolean;
    stable: boolean;
    recentStates: ArmActivityState[];
  };
}

export interface AllArmsAnalysis {
  arms: ArmAnalysis[];
  summary: {
    total: number;
    productive: number;
    idle: number;
    waiting: number;
    looping: number;
    silent: number;
    error: number;
    starting: number;
  };
}

export interface EventWindowResponse {
  armId: string;
  window: {
    events: Array<{
      type: string;
      timestamp: string;
      data: JsonObject;
    }>;
    lastEventAt: string | null;
    silentDurationMs: number;
    unknownEventTypes: string[];
  };
  summary: {
    totalEvents: number;
    eventTypeCounts: Record<string, number>;
    firstEventAt: string | null;
    lastEventAt: string | null;
    durationMs: number;
  };
}

export interface RecentEventsResponse {
  events: Array<{
    type: string;
    armId?: string;
    timestamp: string;
    data: JsonObject;
  }>;
  count: number;
}

// Singleton instance
export const api = new ApiClient();
