/**
 * Operational dashboard projection.
 *
 * Dashboards summarize durable Arm metric samples and system health. Event
 * timelines and inbox attention are separate projections even when a live
 * event triggers this page to refetch its quantitative series.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { AlertTriangle, ChevronRight, Inbox } from 'lucide-react';
import { api, type AgentProviderStatus, type Arm, type AllArmsAnalysis, type ArmActivityState, type CommandQueueHealth, type TranscriptIndexerHealth } from '@/lib';
import { CollapsibleSection, StatusBadge, DenseSection, DenseRow, DenseRowSkeleton } from '@/components';
// import { Bot, Activity, Database, MessageSquare } from 'lucide-react';
import { TaskProgressWidget, type TaskStats } from '@/components/TaskProgressWidget';
import { StatusBurndownChart } from '@/components/StatusBurndownChart';
import { Button, Chip, Skeleton, Disclosure } from '@heroui/react';
import { useWebSocket, type WebSocketMessage } from '@/hooks/useWebSocket';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useWorkspaceOpenRoute } from '@/workspace/route-context';
import { RefreshGate } from '@/lib/refresh-gate';
import { hasOpenedProjectSetup, markProjectSetupOpened } from '@/lib/project-setup-visit';
import { ArmHostProvidersSection } from '@/components/ArmHostProvidersSection';
import {
  WorkbenchEmptyState,
  WorkbenchHeader,
  WorkbenchSurface,
  WorkbenchToolbar,
} from '@/design-system/WorkbenchSurface';

type Navigate = (pathname: string, search?: string) => void;

interface SystemStatus {
  status: string;
  version: string;
  uptime: number;
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
}

type BrainStatus = Awaited<ReturnType<typeof api.getBrainStatus>>['brain'];

const healthColorMap: Record<string, "success" | "warning" | "danger" | "default"> = {
  healthy: "success",
  idle: "default",
  stuck: "danger",
  stale: "warning",
  unknown: "default",
};

const stateColorMap: Record<ArmActivityState, "success" | "warning" | "danger" | "default" | "accent"> = {
  productive: "success",
  idle: "default",
  waiting_permission: "warning",
  looping: "accent",
  silent: "default",
  error: "danger",
  starting: "warning",
};

const indexerColorMap: Record<TranscriptIndexerHealth["status"], "success" | "warning" | "danger" | "default"> = {
  healthy: "success",
  lagging: "warning",
  stale: "danger",
  unavailable: "default",
  error: "danger",
};

const formatLastSeen = (timestamp?: string | null) => {
  if (!timestamp) return 'Never';
  const ms = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
};

const formatUptime = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

// ---------------------------------------------------------------------------

function InfrastructureSection({
  infrastructure,
  indexerHealth,
  commandQueueHealth,
  isLoading,
  indexerLoading,
  commandQueueLoading,
}: {
  infrastructure?: SystemStatus['infrastructure'];
  indexerHealth?: TranscriptIndexerHealth | null;
  commandQueueHealth?: CommandQueueHealth | null;
  isLoading: boolean;
  indexerLoading: boolean;
  commandQueueLoading: boolean;
}) {
  const qdrant = infrastructure?.qdrant ?? { healthy: false, optional: true, error: "Status unavailable" };
  const indexer = infrastructure?.indexer ?? { healthy: false, optional: true, running: false, error: "Status unavailable" };

  return (
    <DenseSection title="Infrastructure & Services">
      {isLoading ? (
        <>
          {[1, 2, 3, 4, 5].map((i) => (
            <DenseRowSkeleton key={i} />
          ))}
        </>
      ) : !infrastructure ? (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">No infrastructure data available</div>
      ) : (
        <>
          <DenseRow
            tone={infrastructure.database.healthy ? "success" : "danger"}
            label="Database"
            detail={infrastructure.database.error}
            detailTone="danger"
            chipLabel={infrastructure.database.healthy ? "Healthy" : "Error"}
            chipColor={infrastructure.database.healthy ? "success" : "danger"}
          />
          <DenseRow
            tone={infrastructure.nats.healthy ? "success" : infrastructure.nats.optional ? "warning" : "danger"}
            label="NATS"
            badge={infrastructure.nats.optional && (
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">optional</span>
            )}
            detail={infrastructure.nats.error}
            detailTone="warning"
            chipLabel={infrastructure.nats.healthy ? "Healthy" : infrastructure.nats.optional ? "Optional" : "Error"}
            chipColor={infrastructure.nats.healthy ? "success" : infrastructure.nats.optional ? "warning" : "danger"}
          />
          <DenseRow
            tone={infrastructure.maildir.healthy ? "success" : "danger"}
            label="Maildir"
            detail={infrastructure.maildir.error}
            detailTone="danger"
            chipLabel={infrastructure.maildir.healthy ? "Healthy" : "Error"}
            chipColor={infrastructure.maildir.healthy ? "success" : "danger"}
          />
          <DenseRow
            tone={qdrant.healthy ? "success" : qdrant.optional ? "warning" : "danger"}
            label="Qdrant"
            badge={qdrant.optional && (
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">optional</span>
            )}
            detail={qdrant.error}
            detailTone="warning"
            chipLabel={qdrant.healthy ? "Healthy" : qdrant.optional ? "Optional" : "Error"}
            chipColor={qdrant.healthy ? "success" : qdrant.optional ? "warning" : "danger"}
          />
          <DenseRow
            tone={indexer.running ? "success" : indexer.optional ? "warning" : "danger"}
            label="Indexer"
            badge={indexer.optional && (
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">optional</span>
            )}
            detail={indexer.error}
            detailTone="warning"
            chipLabel={indexer.running ? "Running" : indexer.optional ? "Optional" : "Error"}
            chipColor={indexer.running ? "success" : indexer.optional ? "warning" : "danger"}
          />
        </>
      )}

      {indexerLoading ? (
        <DenseRowSkeleton />
      ) : indexerHealth ? (
        <DenseRow
          tone={indexerColorMap[indexerHealth.status]}
          label="Transcript Indexer"
          detail={indexerHealth.message}
          detailTone="warning"
          meta={`lag ${indexerHealth.lagMessages ?? "-"} · ack ${indexerHealth.ackPending ?? "-"} · last active ${formatLastSeen(indexerHealth.lastActive)}`}
          chipLabel={indexerHealth.status}
          chipColor={indexerColorMap[indexerHealth.status]}
          sub={`stream=${indexerHealth.stream} · durable=${indexerHealth.durable} · consumerSeq=${indexerHealth.consumerSeq ?? "-"}`}
        />
      ) : null}

      {commandQueueLoading ? (
        <DenseRowSkeleton />
      ) : commandQueueHealth ? (
        <DenseRow
          tone={indexerColorMap[commandQueueHealth.status]}
          label="Command Queue"
          detail={commandQueueHealth.message}
          detailTone={commandQueueHealth.enabled ? "warning" : "danger"}
          meta={`lag ${commandQueueHealth.lagMessages ?? "-"} · ack ${commandQueueHealth.ackPending ?? "-"} · last active ${formatLastSeen(commandQueueHealth.lastActive)} · enabled ${commandQueueHealth.enabled ? "yes" : "no"}`}
          chipLabel={commandQueueHealth.status}
          chipColor={indexerColorMap[commandQueueHealth.status]}
          sub={`stream=${commandQueueHealth.stream} · durable=${commandQueueHealth.durable} · consumerSeq=${commandQueueHealth.consumerSeq ?? "-"}`}
        />
      ) : null}
    </DenseSection>
  );
}

function PlanStatusSection({
  status,
  brain,
  analysis,
  isLoading,
  brainLoading,
  onNavigate,
}: {
  status?: SystemStatus;
  brain?: BrainStatus | null;
  analysis?: AllArmsAnalysis;
  isLoading: boolean;
  brainLoading: boolean;
  onNavigate: Navigate;
}) {
  const attentionArms = analysis?.arms.filter(
    (a) => a.state === "looping" || a.state === "silent" || a.state === "error" || a.hasPermissionPending,
  ) ?? [];

  return (
    <DenseSection
      title="Plan Status"
      action={(
        <Button
          size="sm"
          variant="ghost"
          onPress={() => onNavigate('/setup', '?path=.project%2Fplan.md')}
        >
          Edit plan
        </Button>
      )}
    >
      {isLoading ? (
        <>
          {[1, 2, 3, 4].map((i) => (
            <DenseRowSkeleton key={i} />
          ))}
        </>
      ) : !status ? (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">No plan data available</div>
      ) : (
        <>
          <DenseRow
            tone={status.arms.stuck > 0 ? "danger" : status.arms.stale > 0 ? "warning" : status.arms.total > 0 ? "success" : "default"}
            label="Arms"
            detail={
              status.arms.total > 0
                ? `${status.arms.healthy} healthy · ${status.arms.idle} idle${status.arms.stuck > 0 ? ` · ${status.arms.stuck} stuck` : ""}${status.arms.stale > 0 ? ` · ${status.arms.stale} stale` : ""}`
                : "No arms registered"
            }
            detailTone={status.arms.stuck > 0 ? "danger" : status.arms.stale > 0 ? "warning" : "default"}
            chipLabel={String(status.arms.total)}
            chipColor="accent"
            onClick={() => onNavigate("/arms")}
          />
          <DenseRow
            tone={status.proposals.open > 0 ? "warning" : "default"}
            label="Open Proposals"
            detail={status.proposals.open > 0 ? "Awaiting review" : "None pending"}
            chipLabel={String(status.proposals.open)}
            chipColor={status.proposals.open > 0 ? "warning" : "default"}
            onClick={() => onNavigate("/messaging", "?facet=history")}
          />
          <DenseRow
            tone="default"
            label="Activity (24h)"
            detail="Events recorded in the last 24 hours"
            chipLabel={String(status.activity.last24h)}
            chipColor="default"
            onClick={() => onNavigate("/messaging", "?facet=history")}
          />
          <DenseRow
            tone="default"
            label="Uptime"
            detail={`v${status.version}`}
            chipLabel={formatUptime(status.uptime)}
            chipColor="default"
          />
        </>
      )}

      {brainLoading ? (
        <>
          <DenseRowSkeleton />
          <DenseRowSkeleton />
        </>
      ) : brain ? (
        <>
          <DenseRow
            tone={brain.modelAccess.status === "blocked" ? "danger" : brain.status === "running" ? "success" : "default"}
            label="Brain"
            detail={brain.modelAccess.status === "blocked"
              ? "Plan evaluation blocked · add Brain API credits"
              : `${brain.activeArmsCount} active arms · lastPoll ${formatLastSeen(brain.lastPollAt)}`}
            detailTone={brain.modelAccess.status === "blocked" ? "danger" : "default"}
            chipLabel={brain.status}
            chipColor={brain.modelAccess.status === "blocked" ? "danger" : brain.status === "running" ? "success" : "default"}
            sub={brain.modelAccess.status === "blocked"
              ? `lastPoll=${formatLastSeen(brain.lastPollAt)}`
              : `interval=${brain.pollIntervalMs}ms`}
            onClick={() => onNavigate("/brain")}
          />
          <DenseRow
            tone={brain.pendingTasksCount > 0 ? "warning" : "default"}
            label="Pending Tasks"
            detail={`${brain.completedToday} completed today`}
            chipLabel={String(brain.pendingTasksCount)}
            chipColor={brain.pendingTasksCount > 0 ? "warning" : "default"}
            onClick={() => onNavigate("/tasks")}
          />
        </>
      ) : null}

      {analysis && analysis.arms.length > 0 && (
        <DenseRow
          tone="default"
          label="Arm Activity"
          detail={
            <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span className="text-success">{analysis.summary.productive} productive</span>
              <span className="text-muted-foreground">{analysis.summary.idle} idle</span>
              <span className="text-warning">{analysis.summary.starting} starting</span>
              <span className="text-warning">{analysis.summary.waiting} waiting</span>
              <span className="text-accent">{analysis.summary.looping} looping</span>
              <span className="text-muted-foreground">{analysis.summary.silent} silent</span>
              <span className="text-danger">{analysis.summary.error} error</span>
            </span>
          }
          onClick={() => onNavigate("/arms")}
        />
      )}

      {attentionArms.length > 0 && (
        <div className="px-4 py-2">
          <Disclosure>
            <Disclosure.Heading>
              <Button slot="trigger" variant="secondary" size="sm" className="w-full justify-between gap-2 text-warning">
                <span className="flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Needs attention · {attentionArms.length}
                </span>
                <Disclosure.Indicator />
              </Button>
            </Disclosure.Heading>
            <Disclosure.Content>
              <div className="mt-2 divide-y divide-border rounded-md border border-border">
                {attentionArms.map((arm) => (
                  <button
                    key={arm.armId}
                    type="button"
                    onClick={() => onNavigate("/viewer", `?arm=${encodeURIComponent(arm.armId)}`)}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-left transition-colors hover:bg-default-100/60"
                  >
                    <span className="font-mono text-xs">{arm.armId.slice(0, 12)}...</span>
                    <div className="flex items-center gap-2">
                      <Chip size="sm" variant="soft" color={stateColorMap[arm.state]}>
                        {arm.state}
                      </Chip>
                      {arm.hasPermissionPending && (
                        <Chip size="sm" variant="soft" color="warning">
                          permission pending
                        </Chip>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </Disclosure.Content>
          </Disclosure>
        </div>
      )}
    </DenseSection>
  );
}

function ArmsListSection({
  status,
  arms,
  isLoading,
  onNavigate,
}: {
  status?: SystemStatus;
  arms: Arm[];
  isLoading: boolean;
  onNavigate: Navigate;
}) {
  const hasDetails = status?.arms.details && status.arms.details.length > 0;

  return (
    <WorkbenchSurface>
      <WorkbenchHeader
        title="Arms"
        description="Fleet health and current assignments"
        actions={
          <Button size="sm" variant="ghost" onPress={() => onNavigate("/arms")}>
            Open fleet <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        }
      />
      <div className="p-4">
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="p-3 rounded-lg bg-secondary/50 space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <Skeleton className="h-4 w-24 rounded mb-1" />
                    <Skeleton className="h-3 w-16 rounded" />
                  </div>
                  <Skeleton className="h-6 w-16 rounded" />
                </div>
                <Skeleton className="h-3 w-full rounded" />
              </div>
            ))}
          </div>
        ) : hasDetails ? (
          <div className="rounded-md border border-border divide-y divide-border overflow-hidden">
            {status.arms.details.map((arm) => (
              <button
                key={arm.id}
                type="button"
                onClick={() => onNavigate("/viewer", `?arm=${encodeURIComponent(arm.id)}`)}
                className="w-full px-3 py-2 text-left transition-colors hover:bg-default-100/60"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{arm.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{arm.domain}</p>
                  </div>
                  <Chip
                    size="sm"
                    variant="soft"
                    color={healthColorMap[arm.health] || "default"}
                    className="shrink-0"
                  >
                    {arm.health}
                  </Chip>
                </div>
                {arm.currentTask && (
                  <p className="text-xs text-muted-foreground mt-1 truncate">
                    Task: <span className="font-medium">{arm.currentTask}</span>
                  </p>
                )}
                <div className="flex gap-3 mt-1 text-[11px] text-muted-foreground">
                  <span>Heartbeat: {formatLastSeen(arm.lastHeartbeat)}</span>
                  <span>Activity: {formatLastSeen(arm.lastActivity)}</span>
                </div>
              </button>
            ))}
          </div>
        ) : arms.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No arms registered yet. Spawn one with:
            <code className="block mt-2 p-2 bg-secondary rounded text-xs font-mono">
              coleo arm spawn --name explorer --agent opencode
            </code>
          </p>
        ) : (
          <div className="rounded-md border border-border divide-y divide-border overflow-hidden">
            {arms.map((arm) => (
              <button
                key={arm.id}
                type="button"
                onClick={() => onNavigate("/viewer", `?arm=${encodeURIComponent(arm.id)}`)}
                className="flex w-full items-center justify-between px-3 py-2 text-left transition-colors hover:bg-default-100/60"
              >
                <div className="min-w-0">
                  <p className="font-medium truncate">{arm.name}</p>
                  <p className="text-xs text-muted-foreground truncate">{arm.harness}</p>
                </div>
                <StatusBadge status={arm.status} />
              </button>
            ))}
          </div>
        )}
      </div>
    </WorkbenchSurface>
  );
}

function OperationalInboxSection({ onNavigate }: { onNavigate: Navigate }) {
  return (
    <WorkbenchSurface>
      <WorkbenchHeader
        title="Operational Inbox"
        description="Live messages, Brain decisions, Arm events, and project changes"
        actions={
          <Button size="sm" variant="primary" onPress={() => onNavigate("/messaging", "?facet=attention")}>
            <Inbox className="h-3.5 w-3.5" />
            Open Inbox
          </Button>
        }
      />
      <div className="px-4 py-3 text-sm leading-6 text-muted-foreground">
        Review actionable changes, search retained history, and open task, bug,
        or Arm targets from the unified stream.
      </div>
    </WorkbenchSurface>
  );
}

export function DashboardPage() {
  usePageTitle('Coleo Observatory - Dashboard');

  const openWorkspaceRoute = useWorkspaceOpenRoute();
  const navigate = useCallback<Navigate>((pathname, search = '') => {
    openWorkspaceRoute({ pathname, search }, pathname === '/viewer' ? 'tab' : 'focus');
  }, [openWorkspaceRoute]);

  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [arms, setArms] = useState<Arm[]>([]);
  const [armsAnalysis, setArmsAnalysis] = useState<AllArmsAnalysis | null>(null);
  const [indexerHealth, setIndexerHealth] = useState<TranscriptIndexerHealth | null>(null);
  const [commandQueueHealth, setCommandQueueHealth] = useState<CommandQueueHealth | null>(null);
  const [brainStatus, setBrainStatus] = useState<BrainStatus | null>(null);
  const [armHosts, setArmHosts] = useState<AgentProviderStatus[]>([]);
  const [taskStats, setTaskStats] = useState<TaskStats | null>(null);
  const [taskStatsLoading, setTaskStatsLoading] = useState(true);
  const [taskStatsError, setTaskStatsError] = useState<string | null>(null);
  const [burndownRefresh, setBurndownRefresh] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [detailsLoading, setDetailsLoading] = useState(true);
  const [indexerLoading, setIndexerLoading] = useState(true);
  const [commandQueueLoading, setCommandQueueLoading] = useState(true);
  const [brainLoading, setBrainLoading] = useState(true);
  const [armHostsLoading, setArmHostsLoading] = useState(true);
  const [showProjectSetup, setShowProjectSetup] = useState(false);
  const refreshGate = useRef(new RefreshGate());

  const loadCriticalData = useCallback(async () => {
    await refreshGate.current.run('status', async () => {
      try {
        const statusRes = await api.status();
        setStatus(statusRes);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load status');
      } finally {
        setStatusLoading(false);
      }
    }, 1_000);
  }, []);

  const loadIndexerHealth = useCallback(async () => {
    await refreshGate.current.run('indexer', async () => {
      try {
        const healthRes = await api.getTranscriptIndexerHealth();
        setIndexerHealth(healthRes);
      } catch {
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
      } finally {
        setIndexerLoading(false);
      }
    }, 5_000);
  }, []);

  const loadCommandQueueHealth = useCallback(async () => {
    await refreshGate.current.run('command-queue', async () => {
      try {
        const healthRes = await api.getCommandQueueHealth();
        setCommandQueueHealth(healthRes);
      } catch {
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
      } finally {
        setCommandQueueLoading(false);
      }
    }, 5_000);
  }, []);

  const loadBrainStatus = useCallback(async () => {
    await refreshGate.current.run('brain', async () => {
      try {
        const res = await api.getBrainStatus();
        setBrainStatus(res.brain);
      } catch {
        // Preserve the last successful snapshot during a transient failure.
      } finally {
        setBrainLoading(false);
      }
    }, 5_000);
  }, []);

  const loadArmHosts = useCallback(async () => {
    await refreshGate.current.run('arm-host-providers', async () => {
      try {
        const response = await api.getAgentProviderStatus();
        setArmHosts(response.hosts);
      } catch {
        // Preserve the last successful host snapshot during a transient failure.
      } finally {
        setArmHostsLoading(false);
      }
    }, 5_000);
  }, []);

  const loadDetails = useCallback(async () => {
    await refreshGate.current.run('details', async () => {
      try {
        const armsRes = await api.listArms();
        setArms(armsRes.arms);
      } catch {
        // Preserve the last successful snapshot during a transient failure.
      } finally {
        setDetailsLoading(false);
      }
    }, 5_000);
  }, []);

  const loadAnalysis = useCallback(async () => {
    await refreshGate.current.run('analysis', async () => {
      try {
        const analysisRes = await api.getAllArmsAnalysis();
        setArmsAnalysis(analysisRes);
      } catch {
        // Analysis is optional; keep the last successful snapshot.
      }
    }, 5_000);
  }, []);

  const loadTaskStats = useCallback(async () => {
    await refreshGate.current.run('task-stats', async () => {
      try {
        const stats = await api.getTaskStats();
        setTaskStats(stats);
        setTaskStatsError(null);
        setBurndownRefresh((current) => current + 1);
      } catch (err) {
        setTaskStatsError(err instanceof Error ? err.message : 'Failed to load task progress');
      } finally {
        setTaskStatsLoading(false);
      }
    }, 1_000);
  }, []);

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
    loadCriticalData();
    loadDetails();
    loadAnalysis();
    loadIndexerHealth();
    loadCommandQueueHealth();
    loadBrainStatus();
    loadArmHosts();
    loadTaskStats();

    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      loadCriticalData();
      loadDetails();
      loadIndexerHealth();
      loadCommandQueueHealth();
      loadBrainStatus();
      loadArmHosts();
      loadTaskStats();
    }, 30000);
    return () => clearInterval(interval);
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

  const infrastructureServices = status ? Object.values(status.infrastructure) : [];
  const healthyServiceCount = infrastructureServices.filter((service) => service.healthy).length;
  const configuredProviderCount = armHosts.reduce((total, host) => total + host.configuredProviders.length, 0);
  const availableProviderCount = armHosts.reduce((total, host) => total + host.availableProviderCount, 0);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <WorkbenchHeader
        title="Dashboard"
        description="System readiness, runtime hosts, and sampled operational metrics"
        actions={
          <div className="flex items-center gap-3 text-[0.72rem] font-semibold uppercase tracking-[0.18em]">
          {connected && authenticated ? (
            <div className="flex items-center gap-2 text-success">
              <span className="h-2 w-2 rounded-full bg-success" />
              <span>Connected</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-warning">
              <span className="h-2 w-2 rounded-full bg-warning" />
              <span>Polling</span>
            </div>
          )}
          </div>
        }
      />
      <WorkbenchToolbar>
        <span className="text-xs text-muted-foreground">
          {statusLoading ? "Loading system status…" : `${healthyServiceCount}/${infrastructureServices.length} services healthy`}
        </span>
        <span className="text-xs text-muted-foreground">
          {detailsLoading ? "Loading Arms…" : `${arms.length} Arms`}
        </span>
        <span className="text-xs text-muted-foreground">
          {taskStatsLoading ? "Loading tasks…" : `${taskStats?.active ?? 0} active tasks`}
        </span>
      </WorkbenchToolbar>

      <div className="min-h-0 flex-1 overflow-auto">

      {showProjectSetup ? (
        <section className="m-3 flex flex-col gap-4 rounded-xl border border-accent/30 bg-accent/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-semibold text-foreground">Give the Brain a project plan</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              This repository has no tasks or structured project plan yet. Review any plan files Coleo found,
              or write a new one, before starting the first arm.
            </p>
          </div>
          <a
            href="/setup"
            target="_blank"
            rel="noreferrer"
            onClick={() => {
              markProjectSetupOpened();
              setShowProjectSetup(false);
            }}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90"
          >
            Open setup <ChevronRight className="h-4 w-4" />
          </a>
        </section>
      ) : null}

      <CollapsibleSection
        title="System readiness"
        summary={[
          {
            label: 'Services',
            value: statusLoading ? '...' : `${healthyServiceCount}/${infrastructureServices.length}`,
            tone: infrastructureServices.length > 0 && healthyServiceCount === infrastructureServices.length ? 'success' : 'warning',
          },
          { label: 'Arms', value: statusLoading ? '...' : status?.arms.total ?? 0 },
        ]}
        className="rounded-none border-x-0 border-t-0"
        bodyClassName="grid grid-cols-1 gap-4 xl:grid-cols-2"
      >
        <InfrastructureSection
          infrastructure={status?.infrastructure}
          indexerHealth={indexerHealth}
          commandQueueHealth={commandQueueHealth}
          isLoading={statusLoading}
          indexerLoading={indexerLoading}
          commandQueueLoading={commandQueueLoading}
        />
        <PlanStatusSection
          status={status ?? undefined}
          brain={brainStatus}
          analysis={armsAnalysis ?? undefined}
          isLoading={statusLoading}
          brainLoading={brainLoading}
          onNavigate={navigate}
        />
      </CollapsibleSection>

      <CollapsibleSection
        title="Runtime hosts"
        summary={[
          { label: 'Hosts', value: armHostsLoading ? '...' : armHosts.length },
          { label: 'Providers', value: armHostsLoading ? '...' : `${configuredProviderCount}/${availableProviderCount}` },
        ]}
        className="rounded-none border-x-0 border-t-0"
      >
        <ArmHostProvidersSection
          hosts={armHosts}
          isLoading={armHostsLoading}
          onOpenArms={() => navigate("/arms")}
        />
      </CollapsibleSection>

      <CollapsibleSection
        title="Operational feed"
        summary={[
          { label: 'Arms', value: detailsLoading ? '...' : arms.length },
          { label: 'Events (24h)', value: statusLoading ? '...' : status?.activity.last24h ?? 0 },
        ]}
        className="rounded-none border-x-0 border-t-0"
        bodyClassName="grid grid-cols-1 gap-4 xl:grid-cols-2"
      >
        <ArmsListSection status={status ?? undefined} arms={arms} isLoading={detailsLoading} onNavigate={navigate} />
        <OperationalInboxSection onNavigate={navigate} />
      </CollapsibleSection>

      <CollapsibleSection
        title="Task progress"
        summary={[
          { label: 'Total', value: taskStatsLoading ? '...' : taskStats?.total ?? 0 },
          { label: 'Active', value: taskStatsLoading ? '...' : taskStats?.active ?? 0, tone: taskStats?.active ? 'accent' : 'default' },
          { label: 'Blocked', value: taskStatsLoading ? '...' : taskStats?.blocked ?? 0, tone: taskStats?.blocked ? 'warning' : 'default' },
        ]}
        className="rounded-none border-x-0 border-t-0"
      >
        <TaskProgressWidget
          stats={taskStats ?? undefined}
          isLoading={taskStatsLoading}
          error={taskStatsError ?? undefined}
          embedded
        />
      </CollapsibleSection>

      <StatusBurndownChart
        entity="task"
        refreshKey={burndownRefresh}
        className="rounded-none border-x-0 border-t-0"
      />

      </div>
    </div>
  );
}
