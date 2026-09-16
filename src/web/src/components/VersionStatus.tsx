import { RUNTIME_VERSION } from '../version';
import { compareRuntimeVersions } from '../../../shared/version-compatibility';
import type { FleetVersions, RuntimeVersion, VersionCompatibility } from '../../../shared/version-compatibility';

const labels: Record<VersionCompatibility, string> = {
  synced: 'In sync',
  drift: 'Release differs',
  incompatible: 'Incompatible',
  unknown: 'Compatibility unknown',
};


export function VersionStatus({ versions, apiVersion, loading, stale }: {
  versions?: FleetVersions;
  apiVersion?: string;
  loading: boolean;
  stale: boolean;
}): React.JSX.Element {
  const api = versions?.api ?? { version: apiVersion };
  const components: Array<{ id: string; label: string; runtime: RuntimeVersion; comparison: VersionCompatibility }> = [
    { id: 'web', label: 'Web app', runtime: RUNTIME_VERSION, comparison: compareRuntimeVersions(api, RUNTIME_VERSION) },
    { id: 'api', label: 'API server', runtime: api, comparison: compareRuntimeVersions(RUNTIME_VERSION, api) },
    ...(versions?.agents ?? []).map((agent) => ({
      id: `agent-${agent.agentId}`,
      label: `Arm host: ${agent.hostname} (${agent.agentId})`,
      runtime: agent,
      comparison: compareRuntimeVersions(api, agent),
    })),
  ];
  const incompatible = components.some((component) => component.comparison === 'incompatible');
  const drift = components.some((component) => component.comparison === 'drift');
  const unknown = components.some((component) => component.comparison === 'unknown');

  return (
    <section aria-label="Component versions" className="py-2">
      <details>
        <summary className={`cursor-pointer text-sm ${incompatible ? 'text-danger' : drift || unknown ? 'text-warning' : ''}`}>
          {loading ? 'Checking versions…' : stale ? 'Version report stale' : incompatible ? 'Incompatible versions' : drift ? 'Release versions differ' : unknown || !versions?.agentDiscoveryAvailable ? 'Compatibility unverified' : 'Releases in sync'}
          <span className="ml-2 text-xs text-muted-foreground">Coleo {api.version ?? 'unknown'} · NATS schema {api.natsSchemaVersion ?? 'unknown'}</span>
        </summary>
        <dl className="py-2 pl-4 space-y-3">
          {components.map(({ id, label, runtime, comparison }) => (
            <div key={id} className="flex flex-wrap justify-between gap-2 text-xs">
              <dt className="min-w-0 break-all">{label}</dt>
              <dd className="text-muted-foreground">{runtime.version ?? 'unknown'} · NATS schema {runtime.natsSchemaVersion ?? 'unknown'} · {loading ? 'Checking…' : stale ? 'Stale report' : labels[comparison]}</dd>
            </div>
          ))}
        </dl>
      </details>
      {!loading ? (
        <div role="status" aria-live="polite" className="space-y-1 text-xs">
          {stale ? <p className="text-warning">Version refresh failed. These are the last reported versions; check API connectivity.</p> : null}
          {incompatible ? <p className="text-danger">Incompatible releases or NATS schemas detected. Deploy the same Coleo release to the API and all Arm hosts, then refresh the web app.</p> : null}
          {drift ? <p className="text-warning">Release versions differ within the compatibility range. Finish the rollout to put all components on the same release.</p> : null}
          {unknown ? <p className="text-warning">Some components do not report valid version metadata. Upgrade them before assuming compatibility.</p> : null}
          {!versions?.agentDiscoveryAvailable ? <p className="text-warning">Arm host discovery is unavailable; fleet compatibility cannot be verified.</p> : versions.agents.length === 0 ? <p className="text-muted-foreground">No Arm hosts are currently registered.</p> : null}
        </div>
      ) : null}
    </section>
  );
}
