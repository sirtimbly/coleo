import { Button } from '@heroui/react';
import { brainIsStale, formatDashboardAge, reportIsStale, healthReportIsStale } from '../../lib/dashboard-status';
import { RUNTIME_VERSION } from '../../version';
import { compareRuntimeVersions } from '../../../../shared/version-compatibility';
import type { DashboardBrain, DashboardReports, DashboardStatus, ReportSource } from '../../lib/dashboard-status';
import type { AllArmsAnalysis, Arm, CommandQueueHealth, TranscriptIndexerHealth } from '../../lib/api';

interface Issue { id: string; label: string; detail: string; action: string; route?: string; search?: string; danger?: boolean }
const sourceLabels: Record<ReportSource, string> = { status: 'System', brain: 'Brain', hosts: 'Hosts', arms: 'Arms', analysis: 'Activity', tasks: 'Tasks', indexer: 'Indexer', queue: 'Command queue' };

export function DashboardAttention({ status, brain, analysis, arms, indexer, queue, reports, now, loading, navigate, onInspectSystem }: {
  status: DashboardStatus | null; brain: DashboardBrain | null; analysis: AllArmsAnalysis | null; arms: Arm[];
  indexer: TranscriptIndexerHealth | null; queue: CommandQueueHealth | null; reports: DashboardReports; now: number; loading: boolean;
  onInspectSystem: () => void;
  navigate: (route: string, search?: string) => void;
}): React.JSX.Element {
  const issues: Issue[] = [];
  const stale = (source: ReportSource) => reportIsStale(reports[source], now);
  const failedSources = (Object.keys(reports) as ReportSource[]).filter((source) => stale(source) || (source === 'indexer' && healthReportIsStale(indexer, now)) || (source === 'queue' && healthReportIsStale(queue, now)));
  if (failedSources.length) issues.push({ id: 'reports', label: 'Some reports are unavailable or stale', detail: failedSources.map((source) => `${sourceLabels[source]}: ${reports[source]?.error ?? `last updated ${formatDashboardAge(source === 'indexer' ? indexer?.updatedAt : source === 'queue' ? queue?.updatedAt : reports[source]?.updatedAt, now)}`}`).join(' · '), action: 'Inspect system' });
  if (brain && !stale('brain')) {
    if (brain.modelAccess?.status === 'blocked') issues.push({ id: 'brain-access', label: 'Brain access blocked', detail: brain.modelAccess.message || 'Add Brain API credits to resume plan evaluation.', action: 'Open Brain', route: '/brain', danger: true });
    else if (brain.status === 'running' && brainIsStale(brain, now)) issues.push({ id: 'brain-stale', label: 'Brain status is unverified', detail: `Reported running · last poll ${formatDashboardAge(brain.lastPollAt, now)}. Check the Brain heartbeat and logs.`, action: 'Open Brain', route: '/brain' });
    else if (brain.plan?.status === 'blocked') issues.push({ id: 'plan', label: 'Plan needs attention', detail: brain.plan.detail, action: 'Open Brain', route: '/brain' });
  }
  if (indexer && !stale('indexer') && !healthReportIsStale(indexer, now) && ['error', 'stale', 'lagging'].includes(indexer.status)) issues.push({ id: 'indexer', label: 'Transcript indexing needs attention', detail: `${indexer.message || indexer.status} · ${indexer.lagMessages ?? 'Unknown'} events behind.`, action: 'Inspect system' });
  if (queue && !stale('queue') && !healthReportIsStale(queue, now) && queue.enabled && ['error', 'stale', 'lagging'].includes(queue.status)) issues.push({ id: 'queue', label: 'Command delivery needs attention', detail: queue.message || `${queue.lagMessages ?? 'Unknown'} commands behind.`, action: 'Inspect system', danger: queue.status === 'error' });
  if (status && !stale('status')) {
    for (const [key, service] of Object.entries(status.infrastructure)) {
      const required = !('optional' in service && service.optional) || (key === 'nats' && Boolean(status.versions?.agents.length));
      if (key !== 'indexer' && !service.healthy && required) issues.push({ id: key, label: `${key === 'nats' ? 'NATS messaging' : key === 'maildir' ? 'Maildir' : 'Database'} unavailable`, detail: service.error || 'Required service is not responding.', action: 'Inspect system', danger: true });
    }
    const api = status.versions?.api ?? { version: status.version };
    const comparisons = [compareRuntimeVersions(RUNTIME_VERSION, api), ...(status.versions?.agents ?? []).map((agent) => compareRuntimeVersions(api, agent))];
    if (comparisons.some((value) => value !== 'synced') || !status.versions?.agentDiscoveryAvailable) issues.push({ id: 'versions', label: comparisons.includes('incompatible') ? 'Component versions are incompatible' : comparisons.includes('drift') ? 'Component releases differ' : 'Component compatibility is unverified', detail: 'Inspect component releases and NATS schema versions before assuming compatibility.', action: 'Inspect system', danger: comparisons.includes('incompatible') });
  }
  const names = new Map(arms.map((arm) => [arm.id, arm.name]));
  if (!stale('analysis')) for (const arm of analysis?.arms ?? []) {
    if (arm.hasPermissionPending || ['silent', 'looping', 'error'].includes(arm.state)) issues.push({ id: `arm-${arm.armId}`, label: `${names.get(arm.armId) ?? arm.armId}: ${arm.hasPermissionPending ? 'permission needed' : arm.state}`, detail: arm.reason, action: 'Inspect Arm', route: '/viewer', search: `?arm=${encodeURIComponent(arm.armId)}`, danger: arm.state === 'error' });
  }
  const checking = loading || Object.keys(reports).length < Object.keys(sourceLabels).length;
  if (!issues.length) return <p role="status" className="text-sm text-muted-foreground">{checking ? 'Checking reports…' : 'No issues in the current reports.'}</p>;
  return <section aria-labelledby="dashboard-attention" className="rounded-lg bg-warning/5 px-4 py-3">
    <h2 id="dashboard-attention" className="text-sm font-semibold mb-2">Needs attention <span className="ml-2 font-normal text-muted-foreground">{issues.length}</span></h2>
    <ul className="space-y-3">
      {issues.map((issue) => <li key={issue.id} className="flex flex-wrap items-start justify-between gap-x-5 gap-y-1">
        <div className="min-w-0 flex-1"><p className={`text-sm font-medium ${issue.danger ? 'text-danger' : 'text-warning'}`}>{issue.label}</p><p className="text-xs text-muted-foreground break-words">{issue.detail}</p></div>
        <Button size="sm" variant="ghost" data-navigation-control={issue.route ? true : undefined} onPress={() => {
          if (issue.route) navigate(issue.route, issue.search);
          else onInspectSystem();
        }}>{issue.action}</Button>
      </li>)}
    </ul>
  </section>;
}
