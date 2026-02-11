import { useEffect, useState, useCallback } from 'react';
import { Bot, Vote, Activity, Clock, Wifi, WifiOff, Database, MessageSquare } from 'lucide-react';
import { api, type Arm, type ActivityEntry, type AllArmsAnalysis, type ArmActivityState, type RecentEventsResponse } from '@/lib';
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

type RecentEvent = RecentEventsResponse['events'][number];

const NOTABLE_TASK_EVENTS = new Set([
  'task.completed',
  'task.failed',
  'task.blocked',
  'task.validated',
  'task.status_reported',
  'task.discovery_reported',
  'task.dependency_reported',
  'task.context_compressed',
]);

const NOTABLE_OTHER_EVENTS = new Set([
  'arm.status_changed',
  'system.status',
  'session.error',
]);

const EVENT_LABELS: Record<string, string> = {
  'task.completed': 'Task completed',
  'task.failed': 'Task failed',
  'task.blocked': 'Task blocked',
  'task.validated': 'Task validated',
  'task.status_reported': 'Status report submitted',
  'task.discovery_reported': 'Discovery reported',
  'task.dependency_reported': 'Dependency reported',
  'task.context_compressed': 'Context compressed',
  'arm.status_changed': 'Arm status changed',
  'system.status': 'System status update',
  'session.error': 'Session error',
};

const getDataString = (data: Record<string, unknown> | undefined, keys: string[]) => {
  if (!data) return undefined;
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
};

const isNotableEvent = (event: RecentEvent) =>
  NOTABLE_TASK_EVENTS.has(event.type) || NOTABLE_OTHER_EVENTS.has(event.type);

const humanizeEventType = (type: string) =>
  type.replace(/\./g, ' ').replace(/_/g, ' ');

const formatEventTitle = (event: RecentEvent) => {
  const label = EVENT_LABELS[event.type] ?? humanizeEventType(event.type);
  const taskId = getDataString(event.data, ['taskId', 'task_id', 'target']);
  const bugId = getDataString(event.data, ['bugId', 'bug_id']);
  const armId = event.armId || getDataString(event.data, ['armId', 'arm_id', 'actor']);

  if (event.type === 'arm.status_changed' && armId) {
    const newStatus = getDataString(event.data, ['to', 'newStatus', 'status']);
    return newStatus ? `Arm ${armId} is ${newStatus}` : `${label}: ${armId}`;
  }

  const subject = taskId ? `Task ${taskId}` : bugId ? `Bug ${bugId}` : armId ? `Arm ${armId}` : null;
  return subject ? `${label}: ${subject}` : label;
};

const formatEventMeta = (event: RecentEvent) => {
  const parts: string[] = [];
  const taskId = getDataString(event.data, ['taskId', 'task_id', 'target']);
  const bugId = getDataString(event.data, ['bugId', 'bug_id']);
  const armId = event.armId || getDataString(event.data, ['armId', 'arm_id', 'actor']);
  const status = getDataString(event.data, ['status', 'newStatus', 'to']);

  if (taskId) parts.push(`Task ${taskId}`);
  if (bugId) parts.push(`Bug ${bugId}`);
  if (armId && event.type !== 'arm.status_changed') parts.push(`Arm ${armId}`);
  if (status) parts.push(`Status ${status}`);

  return parts;
};

const getEventDotClass = (event: RecentEvent) => {
  const type = event.type;
  if (type.includes('failed') || type.includes('error')) return 'bg-danger';
  if (type.includes('blocked')) return 'bg-warning';
  if (type.includes('completed') || type.includes('validated')) return 'bg-success';
  return 'bg-accent';
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
              coleo arm spawn --name explorer --agent opencode
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

function NotableEventsSection({ events, isLoading, error }: { events: RecentEvent[], isLoading: boolean, error: string | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Notable Events</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-start gap-3">
                <Skeleton className="h-2 w-2 rounded-full mt-1.5" />
                <div className="flex-1">
                  <Skeleton className="h-4 w-full rounded mb-1" />
                  <Skeleton className="h-3 w-32 rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div>
            <p className="text-sm text-danger">{error}</p>
            <p className="text-xs text-muted-foreground mt-1">Event stream may be unavailable.</p>
          </div>
        ) : events.length === 0 ? (
          <p className="text-muted-foreground text-sm">No notable events yet</p>
        ) : (
          <div className="space-y-3">
            {events.map((event, index) => {
              const meta = formatEventMeta(event);
              return (
                <div key={`${event.type}-${event.timestamp}-${index}`} className="flex items-start gap-3 text-sm">
                  <div className={`h-2 w-2 rounded-full mt-1.5 ${getEventDotClass(event)}`} />
                  <div className="flex-1">
                    <p className="font-medium">{formatEventTitle(event)}</p>
                    <p className="text-xs text-muted-foreground">
                      {meta.length > 0 ? `${meta.join(' • ')} • ` : ''}
                      {new Date(event.timestamp).toLocaleString()}
                    </p>
                  </div>
                </div>
              );
            })}
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
  document.title = "Coleo Observatory - Dashboard";
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [arms, setArms] = useState<Arm[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [notableEvents, setNotableEvents] = useState<RecentEvent[]>([]);
  const [armsAnalysis, setArmsAnalysis] = useState<AllArmsAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [detailsLoading, setDetailsLoading] = useState(true);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState<string | null>(null);

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

  const loadNotableEvents = useCallback(async () => {
    setEventsLoading(true);
    try {
      const eventsRes = await api.getRecentEvents({ limit: 60, sinceMs: 1000 * 60 * 60 * 24 });
      const filtered = eventsRes.events.filter(isNotableEvent).slice(0, 6);
      setNotableEvents(filtered);
      setEventsError(null);
    } catch (err) {
      setEventsError(err instanceof Error ? err.message : 'Failed to load events');
    } finally {
      setEventsLoading(false);
    }
  }, []);

  const handleWSMessage = useCallback((msg: { channel?: string; event?: string; data?: unknown }) => {
    if (msg.channel === 'arms') {
      api.listArms().then((res) => setArms(res.arms)).catch(console.error);
    } else if (msg.channel === 'activity') {
      api.listActivity({ limit: 5 }).then((res) => setActivity(res.activity)).catch(console.error);
    }
    if (msg.channel === 'arm-events') {
      loadNotableEvents();
    }
    if (msg.channel === 'arms' || msg.channel === 'activity' || msg.channel === 'brain') {
      api.status().then((res) => setStatus(res)).catch(console.error);
    }
  }, [loadNotableEvents]);

  const { connected, authenticated } = useWebSocket({
    channels: ['arms', 'activity', 'brain', 'arm-events'],
    onMessage: handleWSMessage,
    autoConnect: true,
  });

  useEffect(() => {
    loadCriticalData();
    loadDetails();
    loadAnalysis();
    loadNotableEvents();

    const interval = setInterval(() => {
      loadCriticalData();
      loadDetails();
      loadNotableEvents();
    }, 30000);
    return () => clearInterval(interval);
  }, [loadCriticalData, loadDetails, loadAnalysis, loadNotableEvents]);

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

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
        <ArmsListSection status={status ?? undefined} arms={arms} isLoading={detailsLoading} />
        <NotableEventsSection events={notableEvents} isLoading={eventsLoading} error={eventsError} />
        <ActivitySection activity={activity} isLoading={detailsLoading} />
      </div>
    </div>
  );
}
