/**
 * API Client for Coleo Observatory
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
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string>),
    };
    if (!(options.body instanceof FormData) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

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

  // OpenCode Providers (fetched from OpenCode server)
  async getOpenCodeProviders() {
    return this.request<{ 
      providers: OpenCodeProvider[];
      connected: string[];
      default?: Record<string, string>;
      error?: string;
      cached?: boolean;
      cachedAt?: string;
      source?: 'live' | 'cache' | 'fallback';
    }>('/opencode/providers');
  }

  async listAgents() {
    return this.request<{ agents: AgentInfo[] }>('/agents');
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
  }) {
    return this.request<{ bug: Bug }>(`/bugs`, {
      method: 'POST',
      body: JSON.stringify(bug),
    });
  }

  async updateBug(id: string, updates: {
    status?: string;
    priority?: string;
    assigneeArmId?: string;
    blockers?: string[];
    resolution?: string;
    humanNotified?: boolean;
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
    metadata?: Record<string, unknown>;
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

  async removeTaskFromPlan(id: string) {
    return this.request<{ deleted: boolean; removedFromPlan: boolean }>(`/tasks/${id}/remove-from-plan`, {
      method: 'POST',
    });
  }

  async reorderTask(taskId: string, toSortOrder: number) {
    return this.request<{ success: boolean }>('/tasks/reorder', {
      method: 'POST',
      body: JSON.stringify({ taskId, toSortOrder }),
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

  // User Preferences
  async getUserPreferences() {
    return this.request<{
      preferences: Record<string, string>;
    }>('/user/preferences');
  }

  async updateUserPreference(key: string, value: string) {
    return this.request<{
      success: boolean;
      preferences: Record<string, string>;
    }>('/user/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ [key]: value }),
    });
  }
}

// Types
export interface ColeoConfig {
  version: number;
  brain: {
    pollIntervalMs: number;
    maxArms: number;
  };
  mail: {
    fromAddress: string;
    toAddress: string;
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

// Arm configuration file structure (from .coleo/arms/*.toml)
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
  modalities?: {
    input: Array<'text' | 'audio' | 'image' | 'video' | 'pdf'>;
    output: Array<'text' | 'audio' | 'image' | 'video' | 'pdf'>;
  };
}

export interface TaskAttachment {
  uploadId: string;
  kind: 'image';
  filename: string;
  mimeType: string;
  sizeBytes: number;
  contentUrl: string;
}

export interface OpenCodeProvider {
  id: string;
  name: string;
  models: OpenCodeModel[];
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
  config: Record<string, unknown>;
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
}

export interface SpawnArmRequest {
  name?: string;
  domain?: string;
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
  distributed?: boolean;
  agentId?: string;
  host?: string;
  pid?: number;
  port?: number;
  sessionId?: string;
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
  state?: unknown;
  input?: unknown;
  output?: unknown;
  time?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface ArmMessage {
  info: {
    id: string;
    role: 'user' | 'assistant' | 'system';
    time?: unknown;
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
  metadata?: Record<string, unknown>;
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
export interface TaskComment {
  id: string;
  taskId: string;
  parentId?: string;
  content: string;
  authorType: 'human' | 'arm' | 'brain';
  authorId: string;
  authorName?: string;
  client: 'web' | 'mail' | 'mcp' | 'cli';
  edited: boolean;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
  screenshotPath?: string;
  replies?: TaskComment[]; // For threaded view
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
  metadata: Record<string, unknown>;
  commentCount?: number;
  lastCommentAt?: string | null;
}

// OpenCode SSE event types
export interface OpenCodeEvent {
  type: string;
  properties: Record<string, unknown>;
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
      data: Record<string, unknown>;
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
    data: Record<string, unknown>;
  }>;
  count: number;
}

// Singleton instance
export const api = new ApiClient();
