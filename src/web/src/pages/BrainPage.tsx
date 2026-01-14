import { useEffect, useState, useCallback } from 'react';
import { Play, Square, Settings, RefreshCw, Terminal } from 'lucide-react';
import { api } from '@/lib';
import { Card, CardHeader, CardTitle, CardContent, StatusBadge } from '@/components';
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

export function BrainPage() {
  const [status, setStatus] = useState<BrainStatus | null>(null);
  const [config, setConfig] = useState<{
    brain: { pollIntervalMs: number; maxArms: number; heartbeatTimeoutSeconds: number };
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [statusRes, configRes] = await Promise.all([
        api.getBrainStatus(),
        api.getBrainConfig(),
      ]);
      setStatus(statusRes.brain as BrainStatus);
      setConfig(configRes);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load brain status');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleWSMessage = useCallback((msg: { channel?: string; event?: string; data?: unknown }) => {
    if (msg.channel === 'brain') {
      loadData();
    }
  }, [loadData]);

  useWebSocket({
    channels: ['brain'],
    onMessage: handleWSMessage,
  });

  useEffect(() => {
    loadData();
  }, [loadData]);

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

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-secondary rounded w-48" />
          <div className="grid grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-32 bg-secondary rounded" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <Card className="border-destructive">
          <CardContent>
            <p className="text-destructive">Error: {error}</p>
            <p className="text-sm text-muted-foreground mt-2">
              Make sure the API server is running: <code>bun run server</code>
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const getBrainStatusType = (status: string) => {
    if (status === 'running') return 'idle' as const;
    if (status === 'paused') return 'paused' as const;
    return 'stopped' as const;
  };

  return (
    <div className="p-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Brain</h1>
          <p className="text-muted-foreground">Central coordinator status and control</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadData}
            className="p-2 text-muted-foreground hover:text-foreground transition-colors"
            title="Refresh"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Status Card */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Terminal className="h-5 w-5" />
            Brain Status
          </CardTitle>
          <StatusBadge status={getBrainStatusType(status?.status || 'stopped')} />
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 gap-6">
            <div>
              <p className="text-sm text-muted-foreground">Status</p>
              <p className="text-2xl font-bold capitalize">{status?.status || 'unknown'}</p>
            </div>
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
          </div>

          <div className="flex gap-3 mt-6 pt-6 border-t">
            {status?.status === 'running' ? (
              <button
                onClick={handleStop}
                disabled={actionLoading === 'stop'}
                className="flex items-center gap-2 px-4 py-2 bg-destructive text-destructive-foreground rounded-md hover:bg-destructive/90 disabled:opacity-50"
              >
                <Square className="h-4 w-4" />
                {actionLoading === 'stop' ? 'Stopping...' : 'Stop Brain'}
              </button>
            ) : status?.status === 'paused' ? (
              <button
                onClick={handleStart}
                disabled={actionLoading === 'start'}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
              >
                <Play className="h-4 w-4" />
                {actionLoading === 'start' ? 'Resuming...' : 'Resume Brain'}
              </button>
            ) : (
              <button
                onClick={handleStart}
                disabled={actionLoading === 'start'}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
              >
                <Play className="h-4 w-4" />
                {actionLoading === 'start' ? 'Starting...' : 'Start Brain'}
              </button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Configuration */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Configuration
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-6">
            <div>
              <p className="text-sm text-muted-foreground">Poll Interval</p>
              <p className="text-lg font-medium">{formatPollInterval(config?.brain.pollIntervalMs || 30000)}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Max Arms</p>
              <p className="text-lg font-medium">{config?.brain.maxArms || 8}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Heartbeat Timeout</p>
              <p className="text-lg font-medium">{config?.brain.heartbeatTimeoutSeconds || 120}s</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Last Activity */}
      <Card>
        <CardHeader>
          <CardTitle>Last Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Last Poll</span>
              <span>
                {status?.lastPollAt
                  ? new Date(status.lastPollAt).toLocaleString()
                  : 'Never'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Completed Today</span>
              <span className="font-medium">{status?.completedToday || 0} tasks</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
