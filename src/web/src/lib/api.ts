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
}

// Types
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

// Singleton instance
export const api = new ApiClient();
