import { NavigationButton } from '@/design-system/navigation-button';
import { fleetCoverage, formatDashboardAge } from '../../lib/dashboard-status';
import type { AgentProviderStatus, AllArmsAnalysis, Arm } from '../../lib/api';

export function DashboardFleet({ arms, hosts, analysis, loading, stale, analysisStale, hostsStale, now, onOpenArm, onOpenFleet }: {
  arms: Arm[]; hosts: AgentProviderStatus[]; analysis: AllArmsAnalysis | null;
  loading: boolean; stale: boolean; analysisStale: boolean; hostsStale: boolean; now: number;
  onOpenArm: (id: string) => void; onOpenFleet: () => void;
}): React.JSX.Element {
  const knownHosts = new Set(hosts.map((host) => host.agentId));
  const groups = [
    ...hosts.map((host) => ({ id: host.agentId, label: host.hostname, host, arms: arms.filter((arm) => arm.agentId === host.agentId) })),
    { id: 'unassigned', label: 'Other Arms', host: null, arms: arms.filter((arm) => !arm.agentId || !knownHosts.has(arm.agentId)) },
  ].filter((group) => group.host || group.arms.length);
  const observed = new Map(analysis?.arms.map((arm) => [arm.armId, arm]));
  return <section aria-labelledby="dashboard-fleet" className="rounded-lg bg-surface px-4 py-3">
    <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
      <h2 id="dashboard-fleet" className="text-sm font-semibold">Fleet</h2>
      <NavigationButton size="sm" onPress={onOpenFleet}>Open fleet</NavigationButton>
    </div>
    <p className="text-xs text-muted-foreground mb-3">
      {loading ? 'Loading fleet…' : `${hosts.length} ${hosts.length === 1 ? 'host' : 'hosts'} · ${arms.length} registered ${arms.length === 1 ? 'Arm' : 'Arms'}`}
      {!loading ? ` · ${analysisStale ? 'Activity unavailable' : `Activity reports for ${fleetCoverage(arms, analysis)}/${arms.length} Arms`}` : ''}
      {stale || hostsStale ? ' · Last known inventory' : ''}
    </p>
    {!loading && !groups.length ? <p className="text-sm text-muted-foreground">No Arm hosts or Arms reported.</p> : null}
    {groups.map((group) => <div key={group.id} className="py-2">
      {group.host ? <details>
        <summary className="cursor-pointer text-sm py-2 break-words">
          {group.label}<span className="text-xs text-muted-foreground ml-3">{group.arms.length} {group.arms.length === 1 ? 'Arm' : 'Arms'} · {group.host.configuredProviders.length} {group.host.configuredProviders.length === 1 ? 'provider' : 'providers'} configured{group.host.error ? ' · Provider report unavailable' : ''}</span>
        </summary>
        <div className="text-xs text-muted-foreground space-y-1 py-2 pl-4 break-all">
          <p>{group.host.agentId} · v{group.host.version}</p>
          <p className="break-normal">{group.host.configuredProviders.map((provider) => provider.name).join(', ') || 'No providers configured'}</p>
          {group.host.error ? <p className="text-warning break-normal">{group.host.error}</p> : null}
        </div>
      </details> : <p className="text-sm py-2">{group.label}<span className="ml-3 text-xs text-muted-foreground">Host not reported or not currently registered</span></p>}
      {group.arms.map((arm) => {
        const activity = analysisStale ? undefined : observed.get(arm.id);
        return <button key={arm.id} type="button" onClick={() => onOpenArm(arm.id)} className="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded px-3 py-2 text-left hover:bg-secondary/50">
          <div className="min-w-0 flex-1"><p className="text-sm font-medium break-words">{arm.name}</p><p className="text-xs text-muted-foreground break-words">{arm.currentTaskSubject || arm.currentBugTitle || arm.domain || arm.harness}</p></div>
          <div className="text-xs text-right"><p className={activity?.state === 'error' ? 'text-danger' : activity?.hasPermissionPending || activity?.state === 'silent' || activity?.state === 'looping' ? 'text-warning' : 'text-muted-foreground'}>{stale ? 'Last reported: ' : ''}{arm.status} · {activity?.hasPermissionPending ? 'Permission needed' : activity?.state.replaceAll('_', ' ') ?? 'Activity unverified'}</p><p className="text-muted-foreground">Heartbeat: {formatDashboardAge(arm.lastHeartbeat, now)}</p></div>
        </button>;
      })}
    </div>)}
  </section>;
}
