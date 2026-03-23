import { useQuery } from '@tanstack/react-query';
import { AlertOctagon, Bot, Loader2, Pause, RefreshCw, ShieldQuestion, Zap } from 'lucide-react';
import { api, type ArmAnalysisFull } from '@/lib/api';
import { armsKeys } from '@/lib/queryKeys';
import { useWebSocket } from '@/hooks/useWebSocket';

const REFRESH_INTERVAL = 5000;

const stateIcons: Record<ArmAnalysisFull['analysis']['state'], typeof Zap> = {
  productive: Zap,
  idle: Pause,
  waiting_permission: ShieldQuestion,
  looping: RefreshCw,
  silent: RefreshCw,
  error: AlertOctagon,
  starting: Zap,
};

interface WorkspaceArmRailProps {
  onOpenViewer: (armId: string) => void;
}

export function WorkspaceArmRail({ onOpenViewer }: WorkspaceArmRailProps) {
  const { data: arms = [], isLoading, error } = useQuery({
    queryKey: armsKeys.list(),
    queryFn: async () => {
      const response = await api.listArms();
      const activeArms = response.arms.filter((arm) => arm.status !== 'stopped');

      const armsWithAnalysis = await Promise.all(
        activeArms.map(async (arm) => {
          try {
            const analysis = await api.getArmAnalysis(arm.id);
            return { ...arm, analysis };
          } catch {
            return { ...arm, analysis: null };
          }
        }),
      );

      return armsWithAnalysis;
    },
    refetchInterval: REFRESH_INTERVAL,
  });

  useWebSocket({
    channels: ['arms'],
    onMessage: () => {},
  });

  if (isLoading) {
    return (
      <div className="golden-dock-empty">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Loading arms…</span>
      </div>
    );
  }

  if (error || arms.length === 0) {
    return (
      <div className="golden-dock-empty">
        <Bot className="h-4 w-4" />
        <span>No active arms</span>
      </div>
    );
  }

  return (
    <div className="golden-dock-arm-strip">
      {arms.map((arm) => {
        const state = arm.analysis?.analysis.state;
        const StateIcon = state ? stateIcons[state] : null;

        return (
          <button
            key={arm.id}
            type="button"
            className="golden-dock-arm-tile"
            data-state={state || 'idle'}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onOpenViewer(arm.id);
            }}
            title={arm.analysis?.analysis.reason || arm.harness}
          >
            <span className="golden-dock-arm-name">{arm.name}</span>

            {StateIcon ? (
              <span className="golden-dock-arm-state">
                <StateIcon className="h-3.5 w-3.5" />
                <span>{state?.replace('_', ' ')}</span>
              </span>
            ) : null}

            {arm.currentTaskSubject ? (
              <span className="golden-dock-arm-meta" title={arm.currentTaskSubject}>
                {arm.currentTaskSubject}
              </span>
            ) : arm.currentBugTitle ? (
              <span className="golden-dock-arm-meta" title={arm.currentBugTitle}>
                {arm.currentBugTitle}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
