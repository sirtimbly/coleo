import { useEffect, useState, useCallback } from 'react';
import { Bot, Vote, Activity, Clock, Wifi, WifiOff, Database, MessageSquare } from 'lucide-react';
import { api, type Arm, type ActivityEntry, type AllArmsAnalysis, type ArmActivityState } from '@/lib';
import { Card, CardHeader, CardTitle, CardContent, StatusBadge } from '@/components';
import { Button, Chip, Surface, Skeleton, Disclosure } from '@heroui/react';
import { useWebSocket } from '@/hooks';

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
  };
}

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

function InfrastructureCard({ infrastructure, isLoading }: { infrastructure?: SystemStatus['infrastructure'], isLoading: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Infrastructure Health</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="grid grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-5 w-5 rounded" />
                <div className="flex-1">
                  <Skeleton className="h-4 w-20 rounded mb-1" />
                  <Skeleton className="h-3 w-16 rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : !infrastructure ? null : (
          <div className="grid grid-cols-3 gap-4">
            <div className="flex items-center gap-3">
              <Database className="h-5 w-5 text-muted-foreground" />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">Database</span>
                  <Chip
                    size="sm"
                    variant="soft"
                    color={infrastructure.database.healthy ? "success" : "danger"}
                  >
                    {infrastructure.database.healthy ? "Healthy" : "Error"}
                  </Chip>
                </div>
                {infrastructure.database.error && (
                  <p className="text-xs text-danger mt-1">{infrastructure.database.error}</p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <MessageSquare className="h-5 w-5 text-muted-foreground" />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">NATS</span>
                  <Chip
                    size="sm"
                    variant="soft"
                    color={infrastructure.nats.healthy ? "success" : infrastructure.nats.optional ? "warning" : "danger"}
                  >
                    {infrastructure.nats.healthy ? "Healthy" : infrastructure.nats.optional ? "Optional" : "Error"}
                  </Chip>
                  {infrastructure.nats.optional && <span className="text-xs text-muted-foreground">(optional)</span>}
                </div>
                {infrastructure.nats.error && (
                  <p className="text-xs text-warning mt-1">{infrastructure.nats.error}</p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Activity className="h-5 w-5 text-muted-foreground" />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">Maildir</span>
                  <Chip
                    size="sm"
                    variant="soft"
                    color={infrastructure.maildir.healthy ? "success" : "danger"}
                  >
                    {infrastructure.maildir.healthy ? "Healthy" : "Error"}
                  </Chip>
                </div>
                {infrastructure.maildir.error && (
                  <p className="text-xs text-danger mt-1">{infrastructure.maildir.error}</p>
                )}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatsGrid({ status, isLoading }: { status?: SystemStatus, isLoading: boolean }) {
  const formatUptime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  };

  const stats = [
    { key: "arms", icon: Bot, value: status?.arms.total ?? 0, label: "Active Arms", sublabel: status && status.arms.total > 0 ? `${status.arms.healthy} healthy, ${status.arms.idle} idle` : undefined, sublabelErrors: status && (status.arms.stuck > 0 || status.arms.stale > 0) ? { stuck: status.arms.stuck, stale: status.arms.stale } : undefined },
    { key: "proposals", icon: Vote, value: status?.proposals.open ?? 0, label: "Open Proposals" },
    { key: "activity", icon: Activity, value: status?.activity.last24h ?? 0, label: "Activity (24h)" },
    { key: "uptime", icon: Clock, value: status ? formatUptime(status.uptime) : "-", label: "Uptime" },
  ];

  return (
    <div className="grid grid-cols-4 gap-4">
      {isLoading ? (
        <>
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardContent className="flex items-center gap-4">
                <Skeleton className="h-12 w-12 rounded-lg" />
                <div className="flex-1">
                  <Skeleton className="h-8 w-16 rounded mb-2" />
                  <Skeleton className="h-4 w-24 rounded" />
                </div>
              </CardContent>
            </Card>
          ))}
        </>
      ) : (
        stats.map((stat) => (
          <Card key={stat.key}>
            <CardContent className="flex items-center gap-4">
              <div className="p-3 rounded-lg bg-secondary">
                <stat.icon className="h-6 w-6" />
              </div>
              <div>
                <p className="text-2xl font-bold">{stat.value}</p>
                <p className="text-sm text-muted-foreground">{stat.label}</p>
                {stat.sublabel && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {stat.sublabel}
                    {stat.sublabelErrors && (
                      <>
                        {stat.sublabelErrors.stuck > 0 && (
                          <span className="text-danger">, {stat.sublabelErrors.stuck} stuck</span>
                        )}
                        {stat.sublabelErrors.stale > 0 && (
                          <span className="text-warning">, {stat.sublabelErrors.stale} stale</span>
                        )}
                      </>
                    )}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

function ArmAnalysisSection({ analysis, isLoading }: { analysis?: AllArmsAnalysis, isLoading: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Arm Activity Analysis</span>
          <span className="text-xs font-normal text-muted-foreground">
            Event-based health monitoring
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="grid grid-cols-7 gap-4 mb-4">
            {["productive", "idle", "starting", "waiting", "looping", "silent", "error"].map((key) => (
              <div key={key} className="text-center p-2 rounded bg-secondary/50">
                <Skeleton className="h-6 w-8 mx-auto mb-1 rounded" />
                <Skeleton className="h-3 w-12 mx-auto rounded" />
              </div>
            ))}
          </div>
        ) : !analysis || analysis.arms.length === 0 ? null : (
          <>
            <div className="grid grid-cols-7 gap-4 mb-4">
              <Surface variant="secondary" className="text-center p-2 rounded">
                <p className="text-lg font-bold text-success">{analysis.summary.productive}</p>
                <p className="text-xs text-muted-foreground">Productive</p>
              </Surface>
              <Surface variant="secondary" className="text-center p-2 rounded">
                <p className="text-lg font-bold text-default">{analysis.summary.idle}</p>
                <p className="text-xs text-muted-foreground">Idle</p>
              </Surface>
              <Surface variant="secondary" className="text-center p-2 rounded">
                <p className="text-lg font-bold text-warning">{analysis.summary.starting}</p>
                <p className="text-xs text-muted-foreground">Starting</p>
              </Surface>
              <Surface variant="secondary" className="text-center p-2 rounded">
                <p className="text-lg font-bold text-warning">{analysis.summary.waiting}</p>
                <p className="text-xs text-muted-foreground">Waiting</p>
              </Surface>
              <Surface variant="secondary" className="text-center p-2 rounded">
                <p className="text-lg font-bold text-accent">{analysis.summary.looping}</p>
                <p className="text-xs text-muted-foreground">Looping</p>
              </Surface>
              <Surface variant="secondary" className="text-center p-2 rounded">
                <p className="text-lg font-bold text-default">{analysis.summary.silent}</p>
                <p className="text-xs text-muted-foreground">Silent</p>
              </Surface>
              <Surface variant="secondary" className="text-center p-2 rounded">
                <p className="text-lg font-bold text-danger">{analysis.summary.error}</p>
                <p className="text-xs text-muted-foreground">Error</p>
              </Surface>
            </div>

            {analysis.arms.filter((a) => a.state === "looping" || a.state === "silent" || a.state === "error" || a.hasPermissionPending).length > 0 && (
              <Disclosure>
                <Disclosure.Trigger>
                  <Button variant="secondary" className="w-full justify-between">
                    <span>Needs Attention ({analysis.arms.filter((a) => a.state === "looping" || a.state === "silent" || a.state === "error" || a.hasPermissionPending).length})</span>
                    <Disclosure.Indicator />
                  </Button>
                </Disclosure.Trigger>
                <Disclosure.Content>
                  <Surface variant="secondary" className="mt-2 p-4 rounded">
                    <div className="space-y-2">
                      {analysis.arms.filter((a) => a.state === "looping" || a.state === "silent" || a.state === "error" || a.hasPermissionPending).map((arm) => (
                        <div key={arm.armId} className="flex items-center justify-between">
                          <span className="text-sm font-mono">{arm.armId.slice(0, 12)}...</span>
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
                        </div>
                      ))}
                    </div>
                  </Surface>
                </Disclosure.Content>
              </Disclosure>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ArmsListSection({ status, arms, isLoading }: { status?: SystemStatus, arms: Arm[], isLoading: boolean }) {
  const hasDetails = status?.arms.details && status.arms.details.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Arms</CardTitle>
      </CardHeader>
      <CardContent>
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
          <div className="space-y-3">
            {status.arms.details.map((arm) => (
              <Surface key={arm.id} variant="secondary" className="p-3 rounded-lg">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{arm.name}</p>
                    <p className="text-xs text-muted-foreground">{arm.domain}</p>
                  </div>
                  <Chip
                    size="sm"
                    variant="soft"
                    color={healthColorMap[arm.health] || "default"}
                  >
                    {arm.health}
                  </Chip>
                </div>
                {arm.currentTask && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Task: <span className="font-medium">{arm.currentTask}</span>
                  </p>
                )}
                <div className="flex gap-4 mt-1 text-xs text-muted-foreground">
                  <span>Heartbeat: {formatLastSeen(arm.lastHeartbeat)}</span>
                  <span>Activity: {formatLastSeen(arm.lastActivity)}</span>
                </div>
              </Surface>
            ))}
          </div>
        ) : arms.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No arms registered yet. Spawn one with:
            <code className="block mt-2 p-2 bg-secondary rounded text-xs font-mono">
              octopai arm spawn --name explorer --agent opencode
            </code>
          </p>
        ) : (
          <div className="space-y-3">
            {arms.map((arm) => (
              <div
                key={arm.id}
                className="flex items-center justify-between p-3 rounded-lg bg-secondary/50"
              >
                <div>
                  <p className="font-medium">{arm.name}</p>
                  <p className="text-xs text-muted-foreground">{arm.harness}</p>
                </div>
                <StatusBadge status={arm.status} />
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ActivitySection({ activity, isLoading }: { activity: ActivityEntry[], isLoading: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Activity</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex items-start gap-3">
                <Skeleton className="h-2 w-2 rounded-full mt-1.5" />
                <div className="flex-1">
                  <Skeleton className="h-4 w-full rounded mb-1" />
                  <Skeleton className="h-3 w-24 rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : activity.length === 0 ? (
          <p className="text-muted-foreground text-sm">No recent activity</p>
        ) : (
          <div className="space-y-3">
            {activity.map((entry) => (
              <div key={entry.id} className="flex items-start gap-3 text-sm">
                <div className="h-2 w-2 rounded-full bg-accent mt-1.5" />
                <div>
                  <p>
                    <span className="font-medium">{entry.actor}</span>{' '}
                    <span className="text-muted-foreground">{entry.action}</span>
                    {entry.target && (
                      <span className="text-muted-foreground"> on {entry.target}</span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(entry.timestamp).toLocaleString()}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const formatLastSeen = (timestamp?: string) => {
  if (!timestamp) return 'Never';
  const ms = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
};

export function DashboardPage() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [arms, setArms] = useState<Arm[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [armsAnalysis, setArmsAnalysis] = useState<AllArmsAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [detailsLoading, setDetailsLoading] = useState(true);

  const loadCriticalData = useCallback(async () => {
    try {
      const statusRes = await api.status();
      setStatus(statusRes);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load status');
    } finally {
      setStatusLoading(false);
    }
  }, []);

  const loadDetails = useCallback(async () => {
    setDetailsLoading(true);
    try {
      const [armsRes, activityRes] = await Promise.all([
        api.listArms(),
        api.listActivity({ limit: 5 }),
      ]);
      setArms(armsRes.arms);
      setActivity(activityRes.activity);
    } catch {
      // Details might fail - that's OK, we show what we can
    } finally {
      setDetailsLoading(false);
    }
  }, []);

  const loadAnalysis = useCallback(async () => {
    try {
      const analysisRes = await api.getAllArmsAnalysis();
      setArmsAnalysis(analysisRes);
    } catch {
      setArmsAnalysis(null);
    }
  }, []);

  const handleWSMessage = useCallback((msg: { channel?: string; event?: string; data?: unknown }) => {
    if (msg.channel === 'arms') {
      api.listArms().then((res) => setArms(res.arms)).catch(console.error);
    } else if (msg.channel === 'activity') {
      api.listActivity({ limit: 5 }).then((res) => setActivity(res.activity)).catch(console.error);
    }
    if (msg.channel === 'arms' || msg.channel === 'activity' || msg.channel === 'brain') {
      api.status().then((res) => setStatus(res)).catch(console.error);
    }
  }, []);

  const { connected, authenticated } = useWebSocket({
    channels: ['arms', 'activity', 'brain'],
    onMessage: handleWSMessage,
    autoConnect: true,
  });

  useEffect(() => {
    loadCriticalData();
    loadDetails();
    loadAnalysis();

    const interval = setInterval(() => {
      loadCriticalData();
      loadDetails();
    }, 30000);
    return () => clearInterval(interval);
  }, [loadCriticalData, loadDetails, loadAnalysis]);

  if (error && !status) {
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
    <div className="p-8 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gradient-heading">Dashboard</h1>
          <p className="text-muted-foreground">System overview and status</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          {connected && authenticated ? (
            <Chip variant="soft" color="success" size="sm">
              <div className="flex items-center gap-1">
                <Wifi className="h-3 w-3" />
                <span>Live</span>
              </div>
            </Chip>
          ) : (
            <Chip variant="soft" color="warning" size="sm">
              <div className="flex items-center gap-1">
                <WifiOff className="h-3 w-3" />
                <span>Polling</span>
              </div>
            </Chip>
          )}
        </div>
      </div>

      <InfrastructureCard infrastructure={status?.infrastructure} isLoading={statusLoading} />

      <StatsGrid status={status ?? undefined} isLoading={statusLoading} />

      <ArmAnalysisSection analysis={armsAnalysis ?? undefined} isLoading={detailsLoading} />

      <div className="grid grid-cols-2 gap-8">
        <ArmsListSection status={status ?? undefined} arms={arms} isLoading={detailsLoading} />
        <ActivitySection activity={activity} isLoading={detailsLoading} />
      </div>
    </div>
  );
}
