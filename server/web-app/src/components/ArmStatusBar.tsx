import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type ArmAnalysisFull } from '@/lib/api';
import { armsKeys } from '@/lib/queryKeys';
import { useWebSocket } from '@/hooks/useWebSocket';
import { Bot, Loader2 } from 'lucide-react';

const REFRESH_INTERVAL = 5000; // 5 seconds

const stateDotClass: Record<ArmAnalysisFull['analysis']['state'], string> = {
  productive: 'bg-success',
  idle: 'bg-muted-foreground/50',
  waiting_permission: 'bg-warning',
  looping: 'bg-accent',
  silent: 'bg-muted-foreground/50',
  error: 'bg-danger',
  starting: 'bg-warning',
};

export function ArmStatusBar() {
  // Fetch active arms with their analysis
  const { data: arms = [], isLoading, error } = useQuery({
    queryKey: armsKeys.list(),
    queryFn: async () => {
      const response = await api.listArms();
      const activeArms = response.arms.filter(a => a.status !== 'stopped');
      
      // Fetch analysis for each active arm
      const armsWithAnalysis = await Promise.all(
        activeArms.map(async (arm) => {
          try {
            const res = await api.getArmAnalysis(arm.id);
            return { ...arm, analysis: res };
          } catch {
            return { ...arm, analysis: null };
          }
        })
      );
      
      return armsWithAnalysis;
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
      <div className="flex h-12 items-center gap-3 border-b border-border bg-background px-5">
        <Loader2 className="h-4 w-4 animate-spin text-accent" />
        <span className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Loading arms</span>
      </div>
    );
  }

  if (error) {
    return null;
  }

  if (arms.length === 0) {
    return (
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background px-5">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
          <Bot className="h-4 w-4 text-muted-foreground" />
          <span>No active arms</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-12 shrink-0 items-center gap-4 overflow-x-auto border-b border-border bg-background px-5">
      <div className="flex shrink-0 items-center gap-3 text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        <span>System</span>
        <span className="flex items-center gap-2 text-foreground">
          <span className="h-2 w-2 rounded-full bg-success" />
          {arms.length} active
        </span>
      </div>

      <div className="h-4 w-px shrink-0 bg-border" />

      <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
        {arms.map((arm) => {
          const state = arm.analysis?.analysis.state;
          const stateLabel = state ? state.replace('_', ' ') : 'monitoring';
          
          return (
            <Link
              key={arm.id}
              to={`/viewer?arm=${encodeURIComponent(arm.id)}`}
              className="flex shrink-0 items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5 text-sm transition-colors hover:bg-surface-secondary"
              title={arm.harness}
            >
              <span className="font-medium text-foreground">{arm.name}</span>
              <span className="flex items-center gap-1.5 text-[0.68rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                <span className={`h-2 w-2 rounded-full ${state ? stateDotClass[state] : 'bg-muted-foreground/50'}`} />
                {stateLabel}
              </span>
              {arm.currentTaskSubject ? (
                <span className="hidden max-w-[180px] truncate text-xs text-muted-foreground xl:inline" title={arm.currentTaskSubject}>
                  {arm.currentTaskSubject}
                </span>
              ) : null}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
