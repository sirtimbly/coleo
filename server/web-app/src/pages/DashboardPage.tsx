import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '@/lib/api';
import type { AgentProviderStatus, Arm, AllArmsAnalysis, CommandQueueHealth, TranscriptIndexerHealth } from '@/lib/api';
import { TaskProgressWidget } from '@/components/TaskProgressWidget';
import type { TaskStats } from '@/components/TaskProgressWidget';
import { StatusBurndownChart } from '@/components/StatusBurndownChart';
import { DashboardFleet } from '@/components/dashboard/DashboardFleet';
import { DashboardSystem } from '@/components/dashboard/DashboardSystem';
import { DashboardAttention } from '@/components/dashboard/DashboardAttention';
import { useWebSocket } from '@/hooks/useWebSocket';
import type { WebSocketMessage } from '@/hooks/useWebSocket';
import { NavigationButton } from '@/design-system/navigation-button';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useWorkspaceOpenRoute } from '@/workspace/route-context';
import { RefreshGate } from '@/lib/refresh-gate';
import { hasOpenedProjectSetup, markProjectSetupOpened } from '@/lib/project-setup-visit';
import { brainIsStale, reportIsStale, healthReportIsStale, formatDashboardAge } from '@/lib/dashboard-status';
import type { DashboardStatus, DashboardBrain, DashboardReports, ReportSource } from '@/lib/dashboard-status';
import { WorkbenchEmptyState, WorkbenchHeader, WorkbenchSurface } from '@/design-system/WorkbenchSurface';

type Navigate = (pathname: string, search?: string) => void;

export function DashboardPage() {
  usePageTitle('Coleo Observatory - Dashboard');

  const openWorkspaceRoute = useWorkspaceOpenRoute();
  const navigate = useCallback<Navigate>((pathname, search = '') => {
    openWorkspaceRoute({ pathname, search }, pathname === '/viewer' ? 'tab' : 'focus');
  }, [openWorkspaceRoute]);

  const [status, setStatus] = useState<DashboardStatus | null>(null);
  const [arms, setArms] = useState<Arm[]>([]);
  const [armsAnalysis, setArmsAnalysis] = useState<AllArmsAnalysis | null>(null);
  const [indexerHealth, setIndexerHealth] = useState<TranscriptIndexerHealth | null>(null);
  const [commandQueueHealth, setCommandQueueHealth] = useState<CommandQueueHealth | null>(null);
  const [brainStatus, setBrainStatus] = useState<DashboardBrain | null>(null);
  const [armHosts, setArmHosts] = useState<AgentProviderStatus[]>([]);
  const [taskStats, setTaskStats] = useState<TaskStats | null>(null);
  const [taskStatsLoading, setTaskStatsLoading] = useState(true);
  const [taskStatsError, setTaskStatsError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const systemRef = useRef<HTMLElement>(null);
  const [burndownRefresh, setBurndownRefresh] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [detailsLoading, setDetailsLoading] = useState(true);
  const [showProjectSetup, setShowProjectSetup] = useState(false);
  const [reports, setReports] = useState<DashboardReports>({});
  const [now, setNow] = useState(Date.now);
  const reportSuccess = useCallback((source: ReportSource) => {
    setReports((current) => ({ ...current, [source]: { updatedAt: Date.now() } }));
  }, []);
  const reportFailure = useCallback((source: ReportSource) => {
    setReports((current) => ({ ...current, [source]: { ...current[source], error: 'Refresh failed' } }));
  }, []);
  const refreshGate = useRef(new RefreshGate());

  const loadCriticalData = useCallback(async () => {
    await refreshGate.current.run('status', async () => {
      try {
        const statusRes = await api.status();
        setStatus(statusRes);
        setError(null);
        reportSuccess('status');
      } catch (err) {
        reportFailure('status');
        setError(err instanceof Error ? err.message : 'Failed to load status');
      } finally {
        setStatusLoading(false);
      }
    }, 1_000);
  }, [reportSuccess, reportFailure]);

  const loadIndexerHealth = useCallback(async () => {
    await refreshGate.current.run('indexer', async () => {
      try {
        const healthRes = await api.getTranscriptIndexerHealth();
        setIndexerHealth(healthRes);
        reportSuccess('indexer');
      } catch {
        reportFailure('indexer');
        setIndexerHealth((current) => current ?? {
          status: "error",
          stream: "coleo-events",
          durable: "project-scoped",
          consumerFound: false,
          lagMessages: null,
          ackPending: null,
          streamLastSeq: null,
          consumerStreamSeq: null,
          consumerSeq: null,
          lastActive: null,
          staleThresholdMs: 120000,
          updatedAt: new Date().toISOString(),
          message: "Failed to load indexer health",
        });
      }
    }, 5_000);
  }, [reportSuccess, reportFailure]);

  const loadCommandQueueHealth = useCallback(async () => {
    await refreshGate.current.run('command-queue', async () => {
      try {
        const healthRes = await api.getCommandQueueHealth();
        setCommandQueueHealth(healthRes);
        reportSuccess('queue');
      } catch {
        reportFailure('queue');
        setCommandQueueHealth((current) => current ?? {
          status: "error",
          stream: "coleo-commands",
          durable: "cmd-projector-to-db",
          consumerFound: false,
          lagMessages: null,
          ackPending: null,
          streamLastSeq: null,
          consumerStreamSeq: null,
          consumerSeq: null,
          lastActive: null,
          staleThresholdMs: 120000,
          updatedAt: new Date().toISOString(),
          message: "Failed to load command queue health",
          enabled: true,
        });
      }
    }, 5_000);
  }, [reportSuccess, reportFailure]);

  const loadBrainStatus = useCallback(async () => {
    await refreshGate.current.run('brain', async () => {
      try {
        const res = await api.getBrainStatus();
        setBrainStatus(res.brain);
        reportSuccess('brain');
      } catch {
        reportFailure('brain');
        // Preserve the last successful snapshot during a transient failure.
      }
    }, 5_000);
  }, [reportSuccess, reportFailure]);

  const loadArmHosts = useCallback(async () => {
    await refreshGate.current.run('arm-host-providers', async () => {
      try {
        const response = await api.getAgentProviderStatus();
        setArmHosts(response.hosts);
        reportSuccess('hosts');
      } catch {
        reportFailure('hosts');
        // Preserve the last successful host snapshot during a transient failure.
      }
    }, 5_000);
  }, [reportSuccess, reportFailure]);

  const loadDetails = useCallback(async () => {
    await refreshGate.current.run('details', async () => {
      try {
        const armsRes = await api.listArms();
        setArms(armsRes.arms);
        reportSuccess('arms');
      } catch {
        reportFailure('arms');
        // Preserve the last successful snapshot during a transient failure.
      } finally {
        setDetailsLoading(false);
      }
    }, 5_000);
  }, [reportSuccess, reportFailure]);

  const loadAnalysis = useCallback(async () => {
    await refreshGate.current.run('analysis', async () => {
      try {
        const analysisRes = await api.getAllArmsAnalysis();
        setArmsAnalysis(analysisRes);
        reportSuccess('analysis');
      } catch {
        reportFailure('analysis');
        // Analysis is optional; keep the last successful snapshot.
      }
    }, 5_000);
  }, [reportSuccess, reportFailure]);

  const loadTaskStats = useCallback(async () => {
    await refreshGate.current.run('task-stats', async () => {
      try {
        const stats = await api.getTaskStats();
        setTaskStats(stats);
        setTaskStatsError(null);
        setBurndownRefresh((current) => current + 1);
        reportSuccess('tasks');
      } catch (err) {
        reportFailure('tasks');
        setTaskStatsError(err instanceof Error ? err.message : 'Failed to load task progress');
      } finally {
        setTaskStatsLoading(false);
      }
    }, 1_000);
  }, [reportSuccess, reportFailure]);

  const handleWSMessage = useCallback((msg: WebSocketMessage) => {
    if (msg.channel === 'arms') {
      void loadDetails();
    }
    if (msg.channel === 'arm-events') {
      void loadIndexerHealth();
      void loadCommandQueueHealth();
    }
    if (msg.channel === 'brain') {
      void loadBrainStatus();
    }
    if (msg.channel === 'arms' || msg.channel === 'activity' || msg.channel === 'brain') {
      void loadCriticalData();
    }
    if (msg.channel === 'tasks') {
      void loadTaskStats();
    }
  }, [loadBrainStatus, loadCommandQueueHealth, loadCriticalData, loadDetails, loadIndexerHealth, loadTaskStats]);

  const { connected, authenticated } = useWebSocket({
    channels: ['arms', 'activity', 'brain', 'arm-events', 'tasks'],
    onMessage: handleWSMessage,
    autoConnect: true,
  });

  useEffect(() => {
    const refresh = () => {
      setNow(Date.now());
      if (document.visibilityState !== 'visible') return;
      void loadCriticalData();
      void loadDetails();
      void loadAnalysis();
      void loadIndexerHealth();
      void loadCommandQueueHealth();
      void loadBrainStatus();
      void loadArmHosts();
      void loadTaskStats();
    };
    refresh();
    const interval = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [loadArmHosts, loadCommandQueueHealth, loadCriticalData, loadDetails, loadAnalysis, loadIndexerHealth, loadBrainStatus, loadTaskStats]);

  useEffect(() => {
    let active = true;
    const updateBanner = () => {
      if (hasOpenedProjectSetup()) {
        setShowProjectSetup(false);
        return;
      }
      void api.getProjectSetupStatus()
        .then((projectSetup) => {
          if (active) setShowProjectSetup(projectSetup.required);
        })
        .catch(() => {
          // Project setup is helpful but must not block the dashboard.
        });
    };

    updateBanner();
    window.addEventListener('focus', updateBanner);
    return () => {
      active = false;
      window.removeEventListener('focus', updateBanner);
    };


  }, []);

  if (error && !status) {
    return (
      <div className="p-8">
        <WorkbenchSurface className="border-danger">
          <WorkbenchEmptyState
            title="Unable to load the dashboard"
            description={`${error}. Make sure the API server is running.`}
          />
        </WorkbenchSurface>
      </div>
    );
  }

  const stale = (source: ReportSource) => reportIsStale(reports[source], now);
  const brainStale = stale('brain') || brainIsStale(brainStatus, now);
  const metrics = [
    { label: 'Active tasks', value: taskStats?.active, stale: stale('tasks') },
    { label: 'Pending tasks', value: taskStats?.byStatus.pending ?? (taskStats ? 0 : undefined), stale: stale('tasks') },
    { label: 'Blocked tasks', value: taskStats?.blocked, stale: stale('tasks') },
    { label: 'Completed today', value: brainStatus?.completedToday, stale: brainStale },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <WorkbenchHeader title="Dashboard" actions={<span className="text-xs text-muted-foreground">{connected && authenticated ? 'Live updates connected' : 'Polling for updates'}</span>} />
      <div data-testid="dashboard-content" className="min-h-0 flex-1 overflow-auto px-4 py-4 space-y-4">
        <DashboardAttention status={status} brain={brainStatus} analysis={armsAnalysis} arms={arms} indexer={indexerHealth} queue={commandQueueHealth} reports={reports} now={now} loading={statusLoading} navigate={navigate} onInspectSystem={() => {
          systemRef.current?.querySelectorAll('details').forEach((details) => { details.open = true; });
          systemRef.current?.scrollIntoView({ block: 'start' });
        }} />
        {showProjectSetup ? <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>Give the Brain a project plan.</span>
          <a href="/setup" target="_blank" rel="noreferrer" className="text-accent" onClick={() => { markProjectSetupOpened(); setShowProjectSetup(false); }}>Open setup</a>
        </div> : null}
        <section aria-labelledby="dashboard-work" className="rounded-lg bg-surface px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h2 id="dashboard-work" className="text-sm font-semibold">Work</h2>
            <NavigationButton size="sm" onPress={() => navigate('/tasks')}>Open tasks</NavigationButton>
          </div>
          <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-x-5 gap-y-4">
            {metrics.map((metric) => <div key={metric.label}>
              <dt className="text-xs text-muted-foreground">{metric.label}</dt>
              <dd className="text-2xl font-medium tabular-nums">{metric.stale ? '—' : metric.value ?? '—'}</dd>
              {metric.stale ? <p className="text-xs text-muted-foreground">{metric.value === undefined ? 'Not reported' : `Last reported: ${metric.value}`}</p> : null}
            </div>)}
          </dl>
          <details className="mt-3">
            <summary className="cursor-pointer text-sm py-2">Brain<span className="ml-2 text-xs text-muted-foreground">{brainStale ? 'Status unverified' : brainStatus?.status ?? 'Not reported'} · Last poll {formatDashboardAge(brainStatus?.lastPollAt, now)}</span></summary>
            <div className="pl-4 py-2 text-xs text-muted-foreground space-y-2">
              <p>{brainStatus?.activeArmsCount ?? 'Unknown'} active Arms reported · Poll interval: {brainStatus ? `${brainStatus.pollIntervalMs / 1000}s` : 'Unknown'}</p>
              {brainStatus?.plan ? <p>{brainStale ? 'Last reported plan: ' : ''}{brainStatus.plan.detail}{brainStatus.plan.nextStep ? ` · ${brainStatus.plan.nextStep}` : ''}</p> : null}
              <NavigationButton size="sm" onPress={() => navigate('/brain')}>Open Brain</NavigationButton>
            </div>
          </details>
          <div className="flex flex-wrap items-center gap-3 mt-3">
            <NavigationButton size="sm" onPress={() => navigate('/setup', '?path=.project%2Fplan.md')}>Edit plan</NavigationButton>
            <NavigationButton size="sm" onPress={() => navigate('/messaging', '?facet=attention')}>Open Inbox{status && !stale('status') ? ` · ${status.proposals.open} open proposals` : ''}</NavigationButton>
          </div>
          <details className="mt-3" onToggle={(event) => setHistoryOpen(event.currentTarget.open)}>
            <summary className="cursor-pointer text-sm py-2">Progress and activity<span className="ml-2 text-xs text-muted-foreground">{status && !stale('status') ? `${status.activity.last24h} events in 24h` : 'Activity unverified'}</span></summary>
            {historyOpen ? <div className="pt-3 space-y-4">
              <TaskProgressWidget stats={stale('tasks') ? undefined : taskStats ?? undefined} isLoading={taskStatsLoading} error={taskStatsError ?? (stale('tasks') ? 'Task report is unavailable or stale.' : undefined)} embedded />
              <StatusBurndownChart entity="task" refreshKey={burndownRefresh} className="border-0 rounded-none" />
              <NavigationButton size="sm" onPress={() => navigate('/messaging', '?facet=history')}>View activity history</NavigationButton>
            </div> : null}
          </details>
        </section>
        <DashboardFleet arms={arms} hosts={armHosts} analysis={armsAnalysis} loading={detailsLoading} stale={stale('arms')} analysisStale={stale('analysis')} hostsStale={stale('hosts')} now={now} onOpenArm={(id) => navigate('/viewer', `?arm=${encodeURIComponent(id)}`)} onOpenFleet={() => navigate('/arms')} />
        <DashboardSystem sectionRef={systemRef} status={status} indexer={indexerHealth} queue={commandQueueHealth} loading={statusLoading} stale={stale('status')} indexerStale={stale('indexer') || healthReportIsStale(indexerHealth, now)} queueStale={stale('queue') || healthReportIsStale(commandQueueHealth, now)} now={now} />
      </div>
    </div>
  );
}
