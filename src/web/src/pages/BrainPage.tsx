import { useEffect, useState, useCallback } from 'react';
import { Play, Square, RefreshCw, Save, X, Edit2 } from 'lucide-react';
import { api } from '@/lib';
import type { ColeoConfig, OpenCodeProvider } from '@/lib';
import { Button } from '@heroui/react';
import { Card, CardContent, DenseSection, DenseRow, DenseRowSkeleton, type Tone } from '@/components';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useWorkspaceOpenRoute } from '@/workspace/route-context';

interface BrainStatus {
  status: 'stopped' | 'running' | 'paused';
  lastPollAt: string | null;
  pollIntervalMs: number;
  activeArmsCount: number;
  pendingTasksCount: number;
  completedToday: number;
  uptime: number | null;
}

type Navigate = (pathname: string, search?: string) => void;

const AVAILABLE_HARNESSES = ['opencode', 'opencode-api', 'opencode-tui'] as const;

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

const statusTone = (brainStatus: string): Tone => {
  if (brainStatus === 'running') return 'success';
  if (brainStatus === 'paused') return 'warning';
  return 'default';
};

function EditToggle({ isEditing, onToggle }: { isEditing: boolean; onToggle: () => void }) {
  if (isEditing) return null;
  return (
    <Button variant="ghost" size="sm" onPress={onToggle}>
      <Edit2 className="h-3.5 w-3.5" /> Edit
    </Button>
  );
}

function BrainStatusSection({
  status,
  isLoading,
  actionLoading,
  onStart,
  onStop,
  onNavigate,
}: {
  status: BrainStatus | null;
  isLoading: boolean;
  actionLoading: string | null;
  onStart: () => void;
  onStop: () => void;
  onNavigate: Navigate;
}) {
  return (
    <DenseSection
      title="Brain Status"
      action={
        status?.status === 'running' ? (
          <Button variant="secondary" size="sm" onPress={onStop} isDisabled={actionLoading === 'stop'}>
            <Square className="h-3.5 w-3.5" />
            {actionLoading === 'stop' ? 'Stopping…' : 'Stop Brain'}
          </Button>
        ) : (
          <Button variant="primary" size="sm" onPress={onStart} isDisabled={actionLoading === 'start'}>
            <Play className="h-3.5 w-3.5" />
            {actionLoading === 'start' ? 'Starting…' : status?.status === 'paused' ? 'Resume Brain' : 'Start Brain'}
          </Button>
        )
      }
    >
      {isLoading ? (
        <>
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <DenseRowSkeleton key={i} />
          ))}
        </>
      ) : (
        <>
          <DenseRow
            tone={statusTone(status?.status || 'stopped')}
            label="Status"
            detail={`uptime ${formatUptime(status?.uptime)}`}
            chipLabel={status?.status || 'unknown'}
            chipColor={statusTone(status?.status || 'stopped')}
          />
          <DenseRow
            tone={(status?.activeArmsCount ?? 0) > 0 ? 'success' : 'default'}
            label="Active Arms"
            detail="Arms currently registered with the coordinator"
            chipLabel={String(status?.activeArmsCount ?? 0)}
            chipColor="accent"
            onClick={() => onNavigate('/arms')}
          />
          <DenseRow
            tone={(status?.pendingTasksCount ?? 0) > 0 ? 'warning' : 'default'}
            label="Pending Tasks"
            detail={`${status?.completedToday ?? 0} completed today`}
            chipLabel={String(status?.pendingTasksCount ?? 0)}
            chipColor={(status?.pendingTasksCount ?? 0) > 0 ? 'warning' : 'default'}
            onClick={() => onNavigate('/tasks')}
          />
          <DenseRow
            tone="default"
            label="Poll Interval"
            detail="How often the brain checks for new work"
            chipLabel={formatPollInterval(status?.pollIntervalMs || 30000)}
            chipColor="default"
          />
          <DenseRow
            tone="default"
            label="Last Poll"
            detail={status?.lastPollAt ? new Date(status.lastPollAt).toLocaleString() : 'Never'}
          />
        </>
      )}
    </DenseSection>
  );
}

function BrainConfigSection({ config, onUpdate }: { config: ColeoConfig | null; onUpdate: () => void }) {
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
      await api.updateConfig({
        brain: {
          pollIntervalMs,
          maxArms,
          armGracePeriodMinutes: config?.brain.armGracePeriodMinutes ?? 10,
        },
      });
      onUpdate();
      setIsEditing(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  return (
    <DenseSection title="Brain Configuration" action={<EditToggle isEditing={isEditing} onToggle={() => setIsEditing(true)} />}>
      {isEditing ? (
        <div className="space-y-4 px-4 py-3">
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
        <>
          <DenseRow tone="default" label="Poll Interval" detail="How often the brain checks for new work" chipLabel={`${pollIntervalMs}ms`} chipColor="default" />
          <DenseRow tone="default" label="Max Arms" detail="Maximum concurrent arms the brain will spawn" chipLabel={String(maxArms)} chipColor="default" />
        </>
      )}
    </DenseSection>
  );
}

function DefaultsSection({
  config,
  openCodeProviders,
  connectedProviders,
  onUpdate
}: {
  config: ColeoConfig | null;
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
    <DenseSection title="Default Settings" action={<EditToggle isEditing={isEditing} onToggle={() => setIsEditing(true)} />}>
      {isEditing ? (
        <div className="space-y-4 px-4 py-3">
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
                    setModel('gpt-5.1-codex-mini');
                  }
                }}
                className="w-full px-3 py-2 bg-secondary border border-border rounded-md"
              >
                {AVAILABLE_HARNESSES.map(h => <option key={h} value={h}>{h}</option>)}
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
        <>
          <DenseRow tone="default" label="Harness" chipLabel={harness} chipColor="default" />
          {isOpenCode && (
            <DenseRow tone="default" label="Provider" chipLabel={getProviderDisplayName(provider)} chipColor="default" />
          )}
          <DenseRow tone="default" label="Model" detail={model || 'Not set'} />
          <DenseRow tone="default" label="Context Budget" chipLabel={contextBudget.toLocaleString()} chipColor="default" />
        </>
      )}
    </DenseSection>
  );
}

export function BrainPage() {
  usePageTitle('Coleo Observatory - Brain');

  const openWorkspaceRoute = useWorkspaceOpenRoute();
  const navigate = useCallback<Navigate>((pathname, search = '') => {
    openWorkspaceRoute({ pathname, search }, 'focus');
  }, [openWorkspaceRoute]);

  const [status, setStatus] = useState<BrainStatus | null>(null);
  const [config, setConfig] = useState<ColeoConfig | null>(null);
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

  if (error) {
    return (
      <div className="p-8">
        <Card className="border-danger">
          <CardContent>
            <p className="text-danger">Error: {error}</p>
            <p className="text-sm text-muted-foreground mt-2">
              Make sure the API server is running: <code className="px-1 bg-secondary rounded">bun run server</code>
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4 px-6 py-6">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Brain</h1>
          <p className="mt-1 text-sm text-muted-foreground">Central coordinator status and configuration</p>
        </div>
        <Button variant="ghost" size="sm" onPress={loadData}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      <BrainStatusSection
        status={status}
        isLoading={loading}
        actionLoading={actionLoading}
        onStart={handleStart}
        onStop={handleStop}
        onNavigate={navigate}
      />

      <BrainConfigSection config={config} onUpdate={loadData} />

      <DefaultsSection
        config={config}
        openCodeProviders={openCodeProviders}
        connectedProviders={connectedProviders}
        onUpdate={loadData}
      />
    </div>
  );
}
