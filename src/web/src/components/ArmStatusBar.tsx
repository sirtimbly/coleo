import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type ArmAnalysisFull } from '@/lib/api';
import { armsKeys } from '@/lib/queryKeys';
import { useWebSocket } from '@/hooks/useWebSocket';
import { Bot, Loader2, Zap, Pause, ShieldQuestion, RefreshCw, AlertOctagon } from 'lucide-react';

const REFRESH_INTERVAL = 5000; // 5 seconds

// Simplified state config for mini status bar
const stateIcons: Record<ArmAnalysisFull['analysis']['state'], typeof Zap> = {
  productive: Zap,
  idle: Pause,
  waiting_permission: ShieldQuestion,
  looping: RefreshCw,
  silent: RefreshCw,
  error: AlertOctagon,
  starting: Zap,
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
      <div className="h-14 border-b border-border/50 bg-gradient-to-r from-slate-50 via-white to-purple-50/30 dark:from-slate-900 dark:via-zinc-900 dark:to-purple-950/30 flex items-center px-4 gap-2 shadow-sm">
        <Loader2 className="h-4 w-4 animate-spin text-accent" />
        <span className="text-sm text-muted-foreground">Loading arms...</span>
      </div>
    );
  }

  if (error) {
    return null;
  }

  if (arms.length === 0) {
    return (
      <div className="h-14 border-b border-border/50 bg-gradient-to-r from-slate-50 via-white to-purple-50/30 dark:from-slate-900 dark:via-zinc-900 dark:to-purple-950/30 flex items-center px-4 gap-3 flex-shrink-0 shadow-sm backdrop-blur-sm">
        <div className="flex items-center gap-2 shrink-0 bg-white/50 dark:bg-white/5 px-3 py-1.5 rounded-lg border border-border/50">
          <Bot className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium text-muted-foreground">No active arms</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-14 border-b border-border/50 bg-gradient-to-r from-slate-50 via-white to-purple-50/30 dark:from-slate-900 dark:via-zinc-900 dark:to-purple-950/30 flex items-center px-4 gap-3 overflow-x-auto shadow-sm backdrop-blur-sm flex-shrink-0">
      <div className="flex items-center gap-2 shrink-0 bg-white/50 dark:bg-white/5 px-3 py-1.5 rounded-lg border border-border/50">
        <Bot className="h-4 w-4 text-accent" />
        <span className="text-sm font-semibold text-foreground">{arms.length} Active</span>
      </div>

      <div className="h-8 w-px bg-border/30" />

      <div className="flex items-center gap-2 flex-1 overflow-x-auto">
        {arms.map((arm) => {
          const StateIcon = arm.analysis ? stateIcons[arm.analysis.analysis.state] : null;
          const state = arm.analysis?.analysis.state;
          
          return (
            <Link
              key={arm.id}
              to={`/viewer?arm=${encodeURIComponent(arm.id)}`}
              className="flex items-center gap-2 shrink-0 bg-white/70 dark:bg-zinc-800/70 border border-border/40 rounded-xl px-3 py-2 hover:bg-white dark:hover:bg-zinc-800 transition-all shadow-sm"
              title={arm.harness}
            >
              <span className="font-bold text-sm truncate max-w-[80px]">{arm.name}</span>
              
              {arm.analysis && StateIcon && (
                <div
                  className={`flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full ${
                    state === 'productive' 
                      ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                      : state === 'idle'
                      ? 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400'
                      : state === 'waiting_permission'
                      ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                      : 'bg-purple-500/10 text-purple-600 dark:text-purple-400'
                  }`}
                  title={`Health: ${arm.analysis.analysis.state} - ${arm.analysis.analysis.reason}`}
                >
                  <StateIcon className={`h-3 w-3 ${
                    state === 'productive' ? 'text-green-500 dark:text-green-400' :
                    state === 'waiting_permission' ? 'text-amber-500 dark:text-amber-400' :
                    'text-muted-foreground'
                  }`} />
                  <span className="capitalize">{arm.analysis.analysis.state.replace('_', ' ')}</span>
                </div>
              )}

              {arm.currentTaskSubject && (
                <span className="text-xs text-foreground/70 truncate max-w-[100px] flex items-center gap-1" title={arm.currentTaskSubject}>
                  <span className="text-accent">●</span>
                  {arm.currentTaskSubject.slice(0, 15)}
                </span>
              )}

              {arm.currentBugTitle && (
                <span className="text-xs text-destructive/80 truncate max-w-[100px] flex items-center gap-1" title={arm.currentBugTitle}>
                  <span>🐛</span>
                  {arm.currentBugTitle.slice(0, 15)}
                </span>
              )}

              {arm.provider && (
                <span className="text-xs text-muted-foreground/60">{arm.provider}</span>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
