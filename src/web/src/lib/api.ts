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
      arms: { total: number };
      proposals: { open: number };
      activity: { last24h: number };
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

// Singleton instance
export const api = new ApiClient();
