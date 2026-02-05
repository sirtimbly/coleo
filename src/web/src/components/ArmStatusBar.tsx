import { useQuery } from '@tanstack/react-query';
import { StatusBadge } from './StatusBadge';
import { api, armsKeys, type Arm } from '@/lib/api';
import { useWebSocket } from '@/lib/websocket';
import { Bot, Loader2 } from 'lucide-react';

const REFRESH_INTERVAL = 5000; // 5 seconds

export function ArmStatusBar() {
  // Fetch active arms
  const { data: arms = [], isLoading, error } = useQuery({
    queryKey: armsKeys.list(),
    queryFn: async () => {
      const response = await api.listArms();
      return response.arms.filter(a => a.status !== 'stopped');
    },
    refetchInterval: REFRESH_INTERVAL,
  });

  // Subscribe to arms updates
  useWebSocket({
    channels: ['arms'],
    onMessage: (msg) => {
      if (msg.channel === 'arms') {
        // Query will auto-refetch on WebSocket message
      }
    },
  });

  if (isLoading) {
    return (
      <div className="h-12 border-b border-border bg-muted/20 flex items-center px-4 gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Loading arms...</span>
      </div>
    );
  }

  if (error || arms.length === 0) {
    return null;
  }

  return (
    <div className="h-12 border-b border-border bg-muted/20 flex items-center px-4 gap-4 overflow-x-auto">
      <div className="flex items-center gap-2 shrink-0">
        <Bot className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium text-muted-foreground">Active Arms</span>
      </div>

      <div className="flex items-center gap-3 flex-1 overflow-x-auto">
        {arms.map((arm) => (
          <div
            key={arm.id}
            className="flex items-center gap-2 shrink-0 bg-card border border-border rounded px-3 py-1.5 hover:bg-secondary/50 transition-colors"
            title={arm.harness}
          >
            <span className="font-medium text-sm truncate max-w-[120px]">{arm.name}</span>
            <StatusBadge status={arm.status} />

            {arm.currentTaskSubject && (
              <span className="text-xs text-muted-foreground truncate max-w-[150px]" title={arm.currentTaskSubject}>
                📋 {arm.currentTaskSubject.slice(0, 30)}...
              </span>
            )}

            {arm.currentBugTitle && (
              <span className="text-xs text-muted-foreground truncate max-w-[150px]" title={arm.currentBugTitle}>
                🐛 {arm.currentBugTitle.slice(0, 30)}...
              </span>
            )}

            {arm.provider && (
              <span className="text-xs text-muted-foreground">{arm.provider}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}