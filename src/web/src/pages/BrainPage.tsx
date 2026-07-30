import { useEffect, useState, useCallback, useRef } from 'react';
import { Play, Square, RefreshCw, Save, X, Edit2 } from 'lucide-react';
import { api } from '@/lib';
import type { ActivityEntry, BrainConfigResponse, BrainModel } from '@/lib';
import { Button } from '@heroui/react';
import { Card, CardContent, DenseSection, DenseRow, DenseRowSkeleton, type Tone } from '@/components';
import { BrainActivityLog } from '@/components/BrainActivityLog';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useWebSocket, type WebSocketMessage } from '@/hooks/useWebSocket';
import { useWorkspaceOpenRoute } from '@/workspace/route-context';
import { mergeBrainActivity, parseBrainActivityEntry } from './brain-activity';

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

function BrainConfigSection({
  config,
  models,
  modelsError,
  onUpdate,
}: {
  config: BrainConfigResponse | null;
  models: BrainModel[];
  modelsError: string | null;
  onUpdate: () => Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [pollIntervalMs, setPollIntervalMs] = useState(config?.pollIntervalMs || 30000);
  const [maxArms, setMaxArms] = useState(config?.maxArms || 8);
  const [provider, setProvider] = useState(config?.provider || 'openai');
  const [model, setModel] = useState(config?.model || 'gpt-5.6-luna');
  const modelOptions = models.some((option) => option.id === model)
    ? models
    : [{ id: model, name: model }, ...models];

  useEffect(() => {
    if (!isEditing) {
      setPollIntervalMs(config?.pollIntervalMs || 30000);
      setMaxArms(config?.maxArms || 8);
      setProvider(config?.provider || 'openai');
      setModel(config?.model || 'gpt-5.6-luna');
    }
  }, [config, isEditing]);

  const handleSave = async () => {
    try {
      await api.updateBrainConfig({
        pollIntervalMs,
        maxArms,
        provider,
        model,
      });
      await onUpdate();
      setIsEditing(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  return (
    <DenseSection title="Brain Configuration" action={<EditToggle isEditing={isEditing} onToggle={() => setIsEditing(true)} />}>
      {isEditing ? (
        <div className="space-y-4 px-4 py-3">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="brainProvider" className="text-sm text-muted-foreground block mb-1">Provider</label>
              <select
                id="brainProvider"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className="w-full px-3 py-2 bg-secondary border border-border rounded-md"
              >
                <option value="openai">OpenAI</option>
                <option value="coming-soon" disabled>More coming soon</option>
              </select>
            </div>
            <div>
              <label htmlFor="brainModel" className="text-sm text-muted-foreground block mb-1">Model</label>
              <select
                id="brainModel"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full px-3 py-2 bg-secondary border border-border rounded-md"
              >
                {modelOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.name}</option>
                ))}
              </select>
              {modelsError && <p className="mt-1 text-xs text-warning">{modelsError}</p>}
            </div>
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
          <DenseRow tone="default" label="Provider" detail="Inference provider used by the brain" chipLabel={provider === 'openai' ? 'OpenAI' : provider} chipColor="default" />
          <DenseRow tone="default" label="Model" detail="Model used for brain analysis and coordination" chipLabel={model} chipColor="default" />
          <DenseRow tone="default" label="Poll Interval" detail="How often the brain checks for new work" chipLabel={`${pollIntervalMs}ms`} chipColor="default" />
          <DenseRow tone="default" label="Max Arms" detail="Maximum concurrent arms the brain will spawn" chipLabel={String(maxArms)} chipColor="default" />
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
  const [config, setConfig] = useState<BrainConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [brainModels, setBrainModels] = useState<BrainModel[]>([]);
  const [brainModelsError, setBrainModelsError] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);
  const [olderActivityLoading, setOlderActivityLoading] = useState(false);
  const [activityCursor, setActivityCursor] = useState<number | null>(null);
  const [hasOlderActivity, setHasOlderActivity] = useState(false);
  const previousAuthenticatedRef = useRef(false);
  const olderActivityRequestRef = useRef(false);

  const loadData = useCallback(async () => {
    try {
      const [statusRes, configRes, modelsRes] = await Promise.all([
        api.getBrainStatus(),
        api.getBrainModelConfig(),
        api.getBrainModels()
          .then((response) => ({ ...response, error: null }))
          .catch((modelsError: unknown) => ({
            models: [] as BrainModel[],
            error: modelsError instanceof Error ? modelsError.message : 'Failed to load provider models',
          })),
      ]);
      setStatus(statusRes.brain as BrainStatus);
      setConfig(configRes.brain);
      setBrainModels(modelsRes.models);
      setBrainModelsError(modelsRes.error);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load brain status');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadActivity = useCallback(async (options?: { beforeSequence?: number; preserveCursor?: boolean }) => {
    if (options?.beforeSequence) setOlderActivityLoading(true);
    else if (!options?.preserveCursor) setActivityLoading(true);

    try {
      const response = await api.listActivity({
        producer: 'brain',
        limit: 200,
        beforeSequence: options?.beforeSequence,
      });
      setActivity((current) => mergeBrainActivity(current, response.activity));
      if (!options?.preserveCursor) {
        setActivityCursor(response.pagination.nextCursor ?? null);
        setHasOlderActivity(response.pagination.hasMore ?? false);
      }
    } catch (err) {
      console.error('Failed to load Brain activity:', err);
    } finally {
      if (options?.beforeSequence) setOlderActivityLoading(false);
      else if (!options?.preserveCursor) setActivityLoading(false);
    }
  }, []);

  const loadOlderActivity = useCallback(async () => {
    if (!activityCursor || olderActivityRequestRef.current || !hasOlderActivity) return;
    olderActivityRequestRef.current = true;
    try {
      await loadActivity({ beforeSequence: activityCursor });
    } finally {
      olderActivityRequestRef.current = false;
    }
  }, [activityCursor, hasOlderActivity, loadActivity]);

  const handleWSMessage = useCallback((msg: WebSocketMessage) => {
    if (msg.channel === 'brain') void loadData();
    if (msg.channel === 'activity') {
      const entry = parseBrainActivityEntry(msg.data);
      if (entry?.actor === 'brain') {
        setActivity((current) => mergeBrainActivity(current, [entry]));
      }
    }
  }, [loadData]);

  const { connected, authenticated } = useWebSocket({ channels: ['brain', 'activity'], onMessage: handleWSMessage });

  useEffect(() => {
    void loadData();
    void loadActivity();
  }, [loadActivity, loadData]);

  useEffect(() => {
    if (authenticated && !previousAuthenticatedRef.current) {
      void loadActivity({ preserveCursor: true });
    }
    previousAuthenticatedRef.current = authenticated;
  }, [authenticated, loadActivity]);

  const handleRefresh = async () => {
    await Promise.all([loadData(), loadActivity({ preserveCursor: true })]);
  };

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
        <Button variant="ghost" size="sm" onPress={handleRefresh}>
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

      <BrainActivityLog
        activity={activity}
        connected={connected && authenticated}
        loading={activityLoading}
        loadingOlder={olderActivityLoading}
        hasMore={hasOlderActivity}
        onLoadOlder={loadOlderActivity}
        onNavigate={navigate}
      />

      <BrainConfigSection
        config={config}
        models={brainModels}
        modelsError={brainModelsError}
        onUpdate={loadData}
      />
    </div>
  );
}
