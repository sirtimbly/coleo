import type { RefObject } from 'react';
import { VersionStatus } from '../VersionStatus';
import { formatDashboardAge } from '../../lib/dashboard-status';
import type { DashboardStatus } from '../../lib/dashboard-status';
import type { CommandQueueHealth, TranscriptIndexerHealth } from '../../lib/api';

export function DashboardSystem({ status, indexer, queue, loading, stale, indexerStale, queueStale, now, sectionRef }: {
  sectionRef: RefObject<HTMLElement | null>;
  status: DashboardStatus | null; indexer: TranscriptIndexerHealth | null; queue: CommandQueueHealth | null;
  loading: boolean; stale: boolean; indexerStale: boolean; queueStale: boolean; now: number;
}): React.JSX.Element {
  return <section ref={sectionRef} aria-labelledby="dashboard-system" id="dashboard-system-section" className="rounded-lg bg-surface-secondary/40 px-4 py-3">
    <h2 id="dashboard-system" className="text-sm font-semibold mb-2">System</h2>
    <VersionStatus versions={status?.versions} apiVersion={status?.version} loading={loading} stale={stale} />
    <details className="py-2">
      <summary className="cursor-pointer text-sm">Services <span className="ml-2 text-xs text-muted-foreground">{loading ? 'Loading…' : stale ? 'Last known status' : status ? Object.entries(status.infrastructure).filter(([key, service]) => key !== 'indexer' && !service.healthy).map(([key]) => `${key === 'qdrant' ? 'Qdrant' : key} unavailable`).join(' · ') || 'Responding' : 'Not reported'}</span></summary>
      <dl className="text-sm py-2 pl-4 space-y-3">
        {status ? Object.entries(status.infrastructure).filter(([key]) => key !== 'indexer').map(([key, service]) => <div key={key} className="flex flex-wrap justify-between gap-2">
          <dt>{({ database: 'Database', nats: 'NATS', maildir: 'Maildir', qdrant: 'Qdrant' } as Record<string, string>)[key] ?? key}{'optional' in service && service.optional ? <span className="ml-2 text-xs text-muted-foreground">Optional</span> : null}</dt>
          <dd className={`text-xs max-w-full break-words ${stale ? 'text-muted-foreground' : service.healthy ? 'text-muted-foreground' : 'text-warning'}`}>{stale ? 'Last reported: ' : ''}{service.healthy ? 'Responding' : service.error || 'Unavailable'}</dd>
        </div>) : <div className="text-muted-foreground">Service status unavailable.</div>}
      </dl>
    </details>
    {([{ name: 'Transcript indexing', value: indexer, stale: indexerStale }, { name: 'Command queue', value: queue, stale: queueStale }]).map(({ name, value, stale: reportStale }) => <details key={name} className="py-2">
      <summary className="cursor-pointer text-sm">{name}<span className={`ml-2 text-xs ${reportStale || !value ? 'text-muted-foreground' : value.status === 'error' || value.status === 'stale' || value.status === 'lagging' ? 'text-warning' : 'text-muted-foreground'}`}>{reportStale ? 'Report unavailable or stale' : value ? `${value.status === 'healthy' && !value.lastActive ? 'Activity unverified' : value.status} · ${value.lagMessages ?? 'unknown'} behind` : 'Not reported'}</span></summary>
      <div className="text-xs text-muted-foreground space-y-1 py-2 pl-4 break-words">
        {name === 'Transcript indexing' ? <p>Local process: {stale ? 'Unverified' : status?.infrastructure.indexer.running ? 'Running' : 'Not running'} · Consumer scope: {value?.durable ?? 'Not reported'}</p> : null}
        {name === 'Command queue' && queue ? <p>{queue.enabled ? 'Enabled' : 'Disabled'}</p> : null}
        <p>{value?.message}</p>
        <p>Last active: {formatDashboardAge(value?.lastActive, now)} · Pending acknowledgements: {value?.ackPending ?? 'Unknown'}</p>
        <p>Report updated: {formatDashboardAge(value?.updatedAt, now)}</p>
        <p className="font-mono break-all">Stream: {value?.stream ?? 'Unknown'} · Consumer: {value?.durable ?? 'Unknown'} · Sequence: {value?.consumerSeq ?? 'Unknown'}</p>
      </div>
    </details>)}
    <p className="text-xs text-muted-foreground mt-3">API uptime: {status ? `${Math.floor(status.uptime / 3600)}h ${Math.floor(status.uptime % 3600 / 60)}m` : 'Not reported'}{stale ? ' · Last known report' : ''}</p>
  </section>;
}
