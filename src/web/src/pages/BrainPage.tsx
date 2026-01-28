import { useEffect, useState, useCallback } from 'react';
import { Play, Square, RefreshCw, Terminal, Save, X, Edit2 } from 'lucide-react';
import { api } from '@/lib';
import type { OctopaiConfig, OpenCodeProvider } from '@/lib';
import { Button, Chip } from '@heroui/react';
import { Card } from '@heroui/react';
import { useWebSocket } from '@/hooks/useWebSocket';

interface BrainStatus {
  status: 'stopped' | 'running' | 'paused';
  lastPollAt: string | null;
  pollIntervalMs: number;
  activeArmsCount: number;
  pendingTasksCount: number;
  completedToday: number;
  uptime: number | null;
}

const KNOWN_HARNESSES = ['opencode', 'claude-code', 'aider'];
const TERMINAL_EMULATORS = ['auto', 'ghostty', 'iterm2', 'terminal', 'wezterm'] as const;

function BrainStatusCard({ status }: { status: BrainStatus | null }) {
  const formatUptime = (seconds: number | null | undefined) => {
    if (seconds === null || seconds === undefined) return '-';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  };

  const formatPollInterval = (ms: number) => {
    if (ms >= 60000) return `${ms / 60000} min`;
    if (ms >= 1000) return `${ms / 1000}s`;
    return `${ms}ms`;
  };

  const getStatusColor = (brainStatus: string) => {
    if (brainStatus === 'running') return 'success';
    if (brainStatus === 'paused') return 'warning';
    return 'default';
  };

  return (
    <Card>
      <Card.Header className="flex flex-row items-center justify-between">
        <Card.Title className="flex items-center gap-2">
          <Terminal className="h-5 w-5" />
          Brain Status
        </Card.Title>
        <Chip size="sm" variant="soft" color={getStatusColor(status?.status || 'stopped')}>
          {status?.status || 'unknown'}
        </Chip>
      </Card.Header>
      <Card.Content>
        <div className="grid grid-cols-4 gap-6">
          <div>
            <p className="text-sm text-muted-foreground">Uptime</p>
            <p className="text-2xl font-bold">{formatUptime(status?.uptime)}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Active Arms</p>
            <p className="text-2xl font-bold">{status?.activeArmsCount || 0}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Pending Tasks</p>
            <p className="text-2xl font-bold">{status?.pendingTasksCount || 0}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Poll Interval</p>
            <p className="text-2xl font-bold">{formatPollInterval(status?.pollIntervalMs || 30000)}</p>
          </div>
        </div>
      </Card.Content>
    </Card>
  );
}

function BrainConfigSection({ config, onUpdate }: { config: OctopaiConfig | null; onUpdate: () => void }) {
  const [isEditing, setIsEditing] = useState(false);
  const [pollIntervalMs, setPollIntervalMs] = useState(config?.brain.pollIntervalMs || 30000);
  const [maxArms, setMaxArms] = useState(config?.brain.maxArms || 8);

  useEffect(() => {
    if (!isEditing) {
      setPollIntervalMs(config?.brain.pollIntervalMs || 30000);
      setMaxArms(config?.brain.maxArms || 8);
    }
  }, [config, isEditing]);

  const handleSave = async () => {
    try {
      await api.updateConfig({ brain: { pollIntervalMs, maxArms } });
      onUpdate();
      setIsEditing(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  return (
    <Card>
      <Card.Header>
        <Card.Title>Brain Configuration</Card.Title>
      </Card.Header>
      <Card.Content>
        {isEditing ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="pollInterval" className="text-sm text-muted-foreground block mb-1">Poll Interval (ms)</label>
                <input
                  id="pollInterval"
                  type="number"
                  value={pollIntervalMs}
                  onChange={(e) => setPollIntervalMs(parseInt(e.target.value) || 30000)}
                  className="w-full px-3 py-2 bg-secondary border border-border rounded-md"
                />
              </div>
              <div>
                <label htmlFor="maxArms" className="text-sm text-muted-foreground block mb-1">Max Arms</label>
                <input
                  id="maxArms"
                  type="number"
                  value={maxArms}
                  onChange={(e) => setMaxArms(parseInt(e.target.value) || 8)}
                  className="w-full px-3 py-2 bg-secondary border border-border rounded-md"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="primary" size="sm" onPress={handleSave}>
                <Save className="h-4 w-4" /> Save
              </Button>
              <Button variant="secondary" size="sm" onPress={() => setIsEditing(false)}>
                <X className="h-4 w-4" /> Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-muted-foreground">Poll Interval</p>
                <p className="text-lg font-medium">{pollIntervalMs}ms</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Max Arms</p>
                <p className="text-lg font-medium">{maxArms}</p>
              </div>
            </div>
            <Button variant="ghost" size="sm" onPress={() => setIsEditing(true)}>
              <Edit2 className="h-4 w-4" /> Edit
            </Button>
          </div>
        )}
      </Card.Content>
    </Card>
  );
}

function DefaultsSection({
  config,
  openCodeProviders,
  connectedProviders,
  onUpdate
}: {
  config: OctopaiConfig | null;
  openCodeProviders: OpenCodeProvider[];
  connectedProviders: string[];
  onUpdate: () => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [harness, setHarness] = useState(config?.defaults?.harness || 'opencode');
  const [provider, setProvider] = useState(config?.defaults?.provider || 'github-copilot');
  const [model, setModel] = useState(config?.defaults?.model || '');
  const [contextBudget, setContextBudget] = useState(config?.defaults?.contextBudget || 100000);

  useEffect(() => {
    if (!isEditing && config?.defaults) {
      setHarness(config.defaults.harness || 'opencode');
      setProvider(config.defaults.provider || 'github-copilot');
      setModel(config.defaults.model || '');
      setContextBudget(config.defaults.contextBudget || 100000);
    }
  }, [config, isEditing]);

  const isOpenCode = harness === 'opencode';
  const selectedProvider = openCodeProviders.find(p => p.id === provider);
  const availableModels = selectedProvider?.models || [];

  const handleProviderChange = (providerId: string) => {
    setProvider(providerId);
    const providerInfo = openCodeProviders.find(p => p.id === providerId);
    setModel(providerInfo?.models[0]?.id || '');
  };

  const handleSave = async () => {
    try {
      await api.updateConfig({ defaults: { harness, provider, model, contextBudget } });
      onUpdate();
      setIsEditing(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const getProviderDisplayName = (providerId: string) => {
    const providerInfo = openCodeProviders.find(p => p.id === providerId);
    return providerInfo?.name || providerId || 'Not set';
  };

  return (
    <Card>
      <Card.Header>
        <Card.Title>Default Settings</Card.Title>
      </Card.Header>
      <Card.Content>
        {isEditing ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="harness" className="text-sm text-muted-foreground block mb-1">Harness</label>
                <select
                  id="harness"
                  value={harness}
                  onChange={(e) => {
                    setHarness(e.target.value);
                    if (e.target.value === 'opencode') {
                      setProvider('github-copilot');
                      setModel('claude-sonnet-4');
                    }
                  }}
                  className="w-full px-3 py-2 bg-secondary border border-border rounded-md"
                >
                  {KNOWN_HARNESSES.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
              {isOpenCode && (
                <div>
                  <label htmlFor="provider" className="text-sm text-muted-foreground block mb-1">Provider</label>
                  <select
                    id="provider"
                    value={provider}
                    onChange={(e) => handleProviderChange(e.target.value)}
                    className="w-full px-3 py-2 bg-secondary border border-border rounded-md"
                  >
                    {openCodeProviders.length > 0 ? (
                      openCodeProviders.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.name}{connectedProviders.includes(p.id) ? ' (connected)' : ''}
                        </option>
                      ))
                    ) : (
                      <>
                        <option value="github-copilot">GitHub Copilot</option>
                        <option value="opencode">OpenCode Zen</option>
                      </>
                    )}
                  </select>
                </div>
              )}
              <div>
                <label htmlFor="model" className="text-sm text-muted-foreground block mb-1">Model</label>
                {isOpenCode && availableModels.length > 0 ? (
                  <select
                    id="model"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className="w-full px-3 py-2 bg-secondary border border-border rounded-md"
                  >
                    {availableModels.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                ) : (
                  <input
                    id="model"
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className="w-full px-3 py-2 bg-secondary border border-border rounded-md"
                    placeholder="model name"
                  />
                )}
              </div>
              <div>
                <label htmlFor="contextBudget" className="text-sm text-muted-foreground block mb-1">Context Budget</label>
                <input
                  id="contextBudget"
                  type="number"
                  value={contextBudget}
                  onChange={(e) => setContextBudget(parseInt(e.target.value) || 100000)}
                  className="w-full px-3 py-2 bg-secondary border border-border rounded-md"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="primary" size="sm" onPress={handleSave}>
                <Save className="h-4 w-4" /> Save
              </Button>
              <Button variant="secondary" size="sm" onPress={() => setIsEditing(false)}>
                <X className="h-4 w-4" /> Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-muted-foreground">Harness</p>
                <p className="text-lg font-medium">{harness}</p>
              </div>
              {isOpenCode && (
                <div>
                  <p className="text-sm text-muted-foreground">Provider</p>
                  <p className="text-lg font-medium">{getProviderDisplayName(provider)}</p>
                </div>
              )}
              <div>
                <p className="text-sm text-muted-foreground">Model</p>
                <p className="text-lg font-medium font-mono text-sm">{model || 'Not set'}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Context Budget</p>
                <p className="text-lg font-medium">{contextBudget.toLocaleString()}</p>
              </div>
            </div>
            <Button variant="ghost" size="sm" onPress={() => setIsEditing(true)}>
              <Edit2 className="h-4 w-4" /> Edit
            </Button>
          </div>
        )}
      </Card.Content>
    </Card>
  );
}

function TerminalSection({ config, onUpdate }: { config: OctopaiConfig | null; onUpdate: () => void }) {
  const [isEditing, setIsEditing] = useState(false);
  const [emulator, setEmulator] = useState(config?.terminal?.emulator || 'auto');

  useEffect(() => {
    if (!isEditing && config?.terminal) {
      setEmulator(config.terminal.emulator || 'auto');
    }
  }, [config, isEditing]);

  const handleSave = async () => {
    try {
      await api.updateConfig({ terminal: { emulator } });
      onUpdate();
      setIsEditing(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  return (
    <Card>
      <Card.Header>
        <Card.Title>Terminal Settings</Card.Title>
      </Card.Header>
      <Card.Content>
        {isEditing ? (
          <div className="space-y-4">
            <div>
              <label htmlFor="emulator" className="text-sm text-muted-foreground block mb-1">Terminal Emulator</label>
              <select
                id="emulator"
                value={emulator}
                onChange={(e) => setEmulator(e.target.value as typeof TERMINAL_EMULATORS[number])}
                className="w-full px-3 py-2 bg-secondary border border-border rounded-md max-w-xs"
              >
                {TERMINAL_EMULATORS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="flex gap-2">
              <Button variant="primary" size="sm" onPress={handleSave}>
                <Save className="h-4 w-4" /> Save
              </Button>
              <Button variant="secondary" size="sm" onPress={() => setIsEditing(false)}>
                <X className="h-4 w-4" /> Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <p className="text-sm text-muted-foreground">Terminal Emulator</p>
              <p className="text-lg font-medium">{emulator}</p>
            </div>
            <Button variant="ghost" size="sm" onPress={() => setIsEditing(true)}>
              <Edit2 className="h-4 w-4" /> Edit
            </Button>
          </div>
        )}
      </Card.Content>
    </Card>
  );
}

function ActivityCard({ status }: { status: BrainStatus | null }) {
  return (
    <Card>
      <Card.Header>
        <Card.Title>Activity</Card.Title>
      </Card.Header>
      <Card.Content>
        <div className="space-y-3">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Last Poll</span>
            <span>
              {status?.lastPollAt ? new Date(status.lastPollAt).toLocaleString() : 'Never'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Completed Today</span>
            <span className="font-medium">{status?.completedToday || 0} tasks</span>
          </div>
        </div>
      </Card.Content>
    </Card>
  );
}

export function BrainPage() {
  const [status, setStatus] = useState<BrainStatus | null>(null);
  const [config, setConfig] = useState<OctopaiConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [openCodeProviders, setOpenCodeProviders] = useState<OpenCodeProvider[]>([]);
  const [connectedProviders, setConnectedProviders] = useState<string[]>([]);

  const loadData = useCallback(async () => {
    try {
      const [statusRes, configRes, providersRes] = await Promise.all([
        api.getBrainStatus(),
        api.getFullConfig(),
        api.getOpenCodeProviders(),
      ]);
      setStatus(statusRes.brain as BrainStatus);
      setConfig(configRes.config);
      setOpenCodeProviders(providersRes.providers);
      setConnectedProviders(providersRes.connected);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load brain status');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleWSMessage = useCallback((msg: { channel?: string }) => {
    if (msg.channel === 'brain') loadData();
  }, [loadData]);

  useWebSocket({ channels: ['brain'], onMessage: handleWSMessage });

  useEffect(() => { loadData(); }, [loadData]);

  const handleStart = async () => {
    setActionLoading('start');
    try {
      await api.startBrain();
      loadData();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to start brain');
    } finally {
      setActionLoading(null);
    }
  };

  const handleStop = async () => {
    if (!confirm('Are you sure you want to stop the brain? This will halt all task processing.')) return;
    setActionLoading('stop');
    try {
      await api.stopBrain();
      loadData();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to stop brain');
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <div className="p-8 space-y-8">
        <div className="h-9 w-48 bg-secondary animate-pulse rounded" />
        <div className="grid grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => <div key={i} className="h-32 bg-secondary animate-pulse rounded" />)}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <Card className="border-danger">
          <Card.Content>
            <p className="text-danger">Error: {error}</p>
            <p className="text-sm text-muted-foreground mt-2">
              Make sure the API server is running: <code className="px-1 bg-secondary rounded">bun run server</code>
            </p>
          </Card.Content>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gradient-heading">Brain</h1>
          <p className="text-muted-foreground">Central coordinator status and configuration</p>
        </div>
        <Button variant="ghost" size="sm" onPress={loadData}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      <BrainStatusCard status={status} />

      <div className="flex gap-3 pt-4">
        {status?.status === 'running' ? (
          <Button variant="primary" onPress={handleStop} isDisabled={actionLoading === 'stop'}>
            <Square className="h-4 w-4" />
            {actionLoading === 'stop' ? 'Stopping...' : 'Stop Brain'}
          </Button>
        ) : (
          <Button variant="primary" onPress={handleStart} isDisabled={actionLoading === 'start'}>
            <Play className="h-4 w-4" />
            {actionLoading === 'start' ? 'Starting...' : (status?.status === 'paused' ? 'Resume Brain' : 'Start Brain')}
          </Button>
        )}
      </div>

      <BrainConfigSection config={config} onUpdate={loadData} />

      <DefaultsSection
        config={config}
        openCodeProviders={openCodeProviders}
        connectedProviders={connectedProviders}
        onUpdate={loadData}
      />

      <TerminalSection config={config} onUpdate={loadData} />

      <ActivityCard status={status} />
    </div>
  );
}
