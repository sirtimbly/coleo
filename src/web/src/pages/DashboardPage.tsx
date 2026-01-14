import { useEffect, useState, useCallback } from 'react';
import { Bot, Vote, Activity, Clock, Wifi, WifiOff } from 'lucide-react';
import { api, type Arm, type ActivityEntry } from '@/lib';
import { Card, CardHeader, CardTitle, CardContent, StatusBadge } from '@/components';
import { useWebSocket } from '@/hooks';

interface SystemStatus {
  status: string;
  version: string;
  uptime: number;
  arms: { total: number };
  proposals: { open: number };
  activity: { last24h: number };
}

export function DashboardPage() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [arms, setArms] = useState<Arm[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Load initial data
  const loadData = useCallback(async () => {
    try {
      const [statusRes, armsRes, activityRes] = await Promise.all([
        api.status(),
        api.listArms(),
        api.listActivity({ limit: 5 }),
      ]);
      setStatus(statusRes);
      setArms(armsRes.arms);
      setActivity(activityRes.activity);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  // Handle WebSocket messages for real-time updates
  const handleWSMessage = useCallback((msg: { channel?: string; event?: string; data?: unknown }) => {
    if (msg.channel === 'arms') {
      // Refresh arms list when arms change
      api.listArms().then((res) => setArms(res.arms)).catch(console.error);
      // Also update status counts
      api.status().then((res) => setStatus(res)).catch(console.error);
    } else if (msg.channel === 'activity') {
      // Refresh activity when new activity comes in
      api.listActivity({ limit: 5 }).then((res) => setActivity(res.activity)).catch(console.error);
      // Also update status counts
      api.status().then((res) => setStatus(res)).catch(console.error);
    } else if (msg.channel === 'brain') {
      // Brain status changes
      api.status().then((res) => setStatus(res)).catch(console.error);
    }
  }, []);

  // Connect to WebSocket for real-time updates
  const { connected, authenticated } = useWebSocket({
    channels: ['arms', 'activity', 'brain'],
    onMessage: handleWSMessage,
    autoConnect: true,
  });

  useEffect(() => {
    loadData();
    // Fallback polling if WebSocket isn't working
    const interval = setInterval(loadData, 30000); // Refresh every 30s as fallback
    return () => clearInterval(interval);
  }, [loadData]);

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-secondary rounded w-48" />
          <div className="grid grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-24 bg-secondary rounded" />
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

  const formatUptime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  };

  return (
    <div className="p-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-muted-foreground">System overview and status</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          {connected && authenticated ? (
            <>
              <Wifi className="h-4 w-4 text-green-500" />
              <span className="text-muted-foreground">Live</span>
            </>
          ) : (
            <>
              <WifiOff className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Polling</span>
            </>
          )}
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardContent className="flex items-center gap-4">
            <div className="p-3 rounded-lg bg-secondary">
              <Bot className="h-6 w-6" />
            </div>
            <div>
              <p className="text-2xl font-bold">{status?.arms.total ?? 0}</p>
              <p className="text-sm text-muted-foreground">Active Arms</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center gap-4">
            <div className="p-3 rounded-lg bg-secondary">
              <Vote className="h-6 w-6" />
            </div>
            <div>
              <p className="text-2xl font-bold">{status?.proposals.open ?? 0}</p>
              <p className="text-sm text-muted-foreground">Open Proposals</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center gap-4">
            <div className="p-3 rounded-lg bg-secondary">
              <Activity className="h-6 w-6" />
            </div>
            <div>
              <p className="text-2xl font-bold">{status?.activity.last24h ?? 0}</p>
              <p className="text-sm text-muted-foreground">Activity (24h)</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center gap-4">
            <div className="p-3 rounded-lg bg-secondary">
              <Clock className="h-6 w-6" />
            </div>
            <div>
              <p className="text-2xl font-bold">{status ? formatUptime(status.uptime) : '-'}</p>
              <p className="text-sm text-muted-foreground">Uptime</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Arms & Activity */}
      <div className="grid grid-cols-2 gap-8">
        {/* Arms List */}
        <Card>
          <CardHeader>
            <CardTitle>Arms</CardTitle>
          </CardHeader>
          <CardContent>
            {arms.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No arms registered yet. Spawn one with:
                <code className="block mt-2 p-2 bg-secondary rounded text-xs">
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
                      <p className="text-xs text-muted-foreground">
                        {arm.domain} · {arm.harness}
                      </p>
                    </div>
                    <StatusBadge status={arm.status} />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent Activity */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            {activity.length === 0 ? (
              <p className="text-muted-foreground text-sm">No recent activity</p>
            ) : (
              <div className="space-y-3">
                {activity.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-start gap-3 text-sm"
                  >
                    <div className="h-2 w-2 rounded-full bg-primary mt-1.5" />
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
      </div>
    </div>
  );
}
