import { useCallback, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { api } from '@/lib';
import { usePageTitle } from '@/hooks/usePageTitle';
import './hosts-harnesses.css';
import { HostServiceConnections } from './host-service-connections';
import { HOST_ROLES } from '../../../../server/src/shared/hosts';
import type { Arm } from '@/lib/api';
import type { HostInput, HostRecord, ServiceState } from '../../../../server/src/shared/hosts';

const emptyHost: HostInput = { name: '', hostname: '', roles: ['arm'], agentId: null, notes: '' };
interface HarnessDraft {
  id: string | null;
  name: string;
  provider: string;
  model: string;
  workdir: string;
  agentId: string;
}
const emptyHarness: HarnessDraft = { id: null, name: '', provider: '', model: '', workdir: '', agentId: '' };
type Tab = 'hosts' | 'harnesses' | 'services';

export function HostsHarnessesPage(): React.JSX.Element {
  usePageTitle('Hosts & harnesses · Coleo');
  const [tab, setTab] = useState<Tab>('hosts');
  const [hosts, setHosts] = useState<HostRecord[]>([]);
  const [arms, setArms] = useState<Arm[]>([]);
  const [services, setServices] = useState<ServiceState | null>(null);
  const [hostDraft, setHostDraft] = useState<HostInput | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [harness, setHarness] = useState<HarnessDraft | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [discovery, setDiscovery] = useState(true);
  const [confirmation, setConfirmation] = useState<{
    label: string;
    run: () => Promise<unknown>;
    restart?: boolean;
  } | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    const results = await Promise.allSettled([api.listHosts(), api.listHarnesses(), api.getHostServices()]);
    const [h, a, s] = results;
    if (h.status === 'fulfilled') {
      setHosts(h.value.hosts);
      setDiscovery(h.value.discoveryAvailable);
    }
    if (a.status === 'fulfilled') setArms(a.value.arms);
    if (s.status === 'fulfilled') setServices(s.value);
    const failures = results.filter((r) => r.status === 'rejected');
    setError(failures.map((r) => (r.status === 'rejected' ? String(r.reason) : '')).join('; '));
    setLoading(false);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function mutate(action: () => Promise<unknown>, message: string, refresh = true): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(message);
      setConfirmation(null);
      if (refresh) await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  function editHost(host: HostRecord): void {
    setHostId(host.source === 'registered' ? host.id : null);
    setHostDraft({
      name: host.name,
      hostname: host.hostname,
      roles: host.roles,
      agentId: host.agentId,
      notes: host.notes,
    });
  }
  return (
    <div className="fleet-view">
      <header className="fleet-heading">
        <div>
          <h1>Hosts & harnesses</h1>
          <p>Manage machines, harness runtimes, and service connections.</p>
        </div>
        <Button size="sm" variant="secondary" isDisabled={busy || loading} onPress={() => void load()}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      </header>
      <nav className="fleet-tabs" aria-label="Hosts and harnesses views">
        {(['hosts', 'harnesses', 'services'] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-current={tab === value ? 'page' : undefined}
            onClick={() => {
              setTab(value);
              setConfirmation(null);
            }}
          >
            {value === 'hosts' ? 'Hosts' : value === 'harnesses' ? 'Harnesses' : 'Service connections'}
          </button>
        ))}
      </nav>
      <div className="fleet-content" aria-busy={busy || loading}>
        {error ? (
          <p role="alert" className="fleet-error">
            {error}
          </p>
        ) : null}
        {notice ? <p role="status">{notice}</p> : null}
        {confirmation ? (
          <div className="fleet-confirm" role="alert">
            <p>{confirmation.label}</p>
            <Button
              size="sm"
              variant="danger"
              isDisabled={busy}
              onPress={() =>
                void mutate(
                  confirmation.run,
                  confirmation.restart
                    ? 'Restart requested. Reconnect to the configured API address, then refresh to inspect the restart output.'
                    : 'Action completed.',
                  !confirmation.restart,
                )
              }
            >
              Confirm
            </Button>
            <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => setConfirmation(null)}>
              Cancel
            </Button>
          </div>
        ) : null}
        {tab === 'hosts' ? (
          <>
            <div className="fleet-section-heading">
              <h2>Host inventory</h2>
              <Button
                size="sm"
                isDisabled={busy}
                onPress={() => {
                  setHostId(null);
                  setHostDraft({ ...emptyHost });
                }}
              >
                Add host
              </Button>
            </div>
            <p>
              Discovered hosts reflect running services. Register them to save labels, roles, and notes. Removing an
              inventory entry does not stop its services.
            </p>
            {!discovery ? (
              <p role="status">Arm Host discovery is unavailable. Saved inventory is still available.</p>
            ) : null}
            {hostDraft ? (
              <form
                className="fleet-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void mutate(async () => {
                    await api.saveHost(hostId, hostDraft);
                    setHostDraft(null);
                  }, 'Host saved.');
                }}
              >
                <h3>{hostId ? 'Edit host' : 'Register host'}</h3>
                <label>
                  Name
                  <input
                    required
                    maxLength={200}
                    value={hostDraft.name}
                    onChange={(e) => setHostDraft({ ...hostDraft, name: e.target.value })}
                  />
                </label>
                <label>
                  Hostname or IP
                  <input
                    required
                    value={hostDraft.hostname}
                    onChange={(e) => setHostDraft({ ...hostDraft, hostname: e.target.value })}
                  />
                </label>
                <label>
                  Arm Host ID (optional)
                  <input
                    value={hostDraft.agentId ?? ''}
                    onChange={(e) => setHostDraft({ ...hostDraft, agentId: e.target.value || null })}
                  />
                </label>
                <fieldset>
                  <legend>Services on this host</legend>
                  {HOST_ROLES.map((role) => (
                    <label className="fleet-check" key={role}>
                      <input
                        type="checkbox"
                        checked={hostDraft.roles.includes(role)}
                        onChange={(e) =>
                          setHostDraft({
                            ...hostDraft,
                            roles: e.target.checked
                              ? [...hostDraft.roles, role]
                              : hostDraft.roles.filter((r) => r !== role),
                          })
                        }
                      />
                      {role === 'arm' ? 'Arm Host' : role.toUpperCase()}
                    </label>
                  ))}
                </fieldset>
                <label>
                  Notes
                  <textarea
                    value={hostDraft.notes}
                    onChange={(e) => setHostDraft({ ...hostDraft, notes: e.target.value })}
                  />
                </label>
                <div className="fleet-actions">
                  <Button size="sm" type="submit" isDisabled={busy || !hostDraft.roles.length}>
                    Save host
                  </Button>
                  <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => setHostDraft(null)}>
                    Cancel
                  </Button>
                </div>
              </form>
            ) : null}
            <div className="fleet-table-wrap">
              <table>
                <caption className="sr-only">Saved and discovered hosts</caption>
                <thead>
                  <tr>
                    <th>Host</th>
                    <th>Services</th>
                    <th>Status</th>
                    <th>Details</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {hosts.map((host) => (
                    <tr key={host.id}>
                      <td>
                        <strong>{host.name}</strong>
                        <span>{host.hostname}</span>
                      </td>
                      <td>{host.roles.join(', ')}</td>
                      <td>
                        {host.status}
                        <span>{host.source}</span>
                      </td>
                      <td>
                        {host.notes}
                        <span>{host.agentId}</span>
                        <span>{host.capabilities.join(', ')}</span>
                      </td>
                      <td>
                        <div className="fleet-actions">
                          <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => editHost(host)}>
                            {host.source === 'registered' ? 'Edit' : 'Register'}
                          </Button>
                          {host.source === 'registered' ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              isDisabled={busy}
                              onPress={() =>
                                setConfirmation({
                                  label: `Remove ${host.name} from inventory?`,
                                  run: () => api.deleteHost(host.id),
                                })
                              }
                            >
                              Remove
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
        {tab === 'harnesses' ? (
          <>
            <div className="fleet-section-heading">
              <h2>Harness runtimes</h2>
              <Button size="sm" isDisabled={busy} onPress={() => setHarness({ ...emptyHarness })}>
                Create harness
              </Button>
            </div>
            <p>Each Arm owns a harness runtime. Create and start one here, or manage an existing runtime.</p>
            {harness ? (
              <form
                className="fleet-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void mutate(async () => {
                    const data = {
                      name: harness.name,
                      ...(harness.provider ? { provider: harness.provider } : {}),
                      ...(harness.model ? { model: harness.model } : {}),
                    };
                    if (harness.id) await api.updateArm(harness.id, data);
                    else {
                      await api.createArm({
                        ...data,
                        harness: 'opencode-api',
                        ...(harness.workdir ? { workdir: harness.workdir } : {}),
                      });
                      setHarness({ ...harness, id: harness.name });
                      try {
                        await api.spawnArm(
                          harness.name,
                          harness.agentId
                            ? { agentId: harness.agentId, preferAgent: true, allowLocalFallback: false }
                            : {},
                        );
                      } catch (error) {
                        await load();
                        throw new Error(
                          `Harness record created, but start failed: ${error instanceof Error ? error.message : String(error)}. Stop and start the saved harness to retry.`,
                        );
                      }
                    }
                    setHarness(null);
                  }, 'Harness saved.');
                }}
              >
                <h3>
                  {harness.id ? 'Edit harness · settings apply on next start' : 'Create and start an OpenCode harness'}
                </h3>
                <label>
                  Name
                  <input
                    required
                    value={harness.name}
                    onChange={(e) => setHarness({ ...harness, name: e.target.value })}
                  />
                </label>
                <label>
                  Provider (optional)
                  <input
                    value={harness.provider}
                    onChange={(e) => setHarness({ ...harness, provider: e.target.value })}
                  />
                </label>
                <label>
                  Model (optional)
                  <input value={harness.model} onChange={(e) => setHarness({ ...harness, model: e.target.value })} />
                </label>
                {!harness.id ? (
                  <>
                    <label>
                      Working directory on host (optional)
                      <input
                        value={harness.workdir}
                        onChange={(e) => setHarness({ ...harness, workdir: e.target.value })}
                      />
                    </label>
                    <label>
                      Arm Host
                      <select
                        value={harness.agentId}
                        onChange={(e) => setHarness({ ...harness, agentId: e.target.value })}
                      >
                        <option value="">Automatic selection</option>
                        {hosts
                          .filter((h) => h.agentId && h.status === 'connected')
                          .map((h) => (
                            <option key={h.id} value={h.agentId!}>
                              {h.name} · {h.agentId}
                            </option>
                          ))}
                      </select>
                    </label>
                  </>
                ) : null}
                <div className="fleet-actions">
                  <Button size="sm" type="submit" isDisabled={busy}>
                    {harness.id ? 'Save harness' : 'Create and start'}
                  </Button>
                  <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => setHarness(null)}>
                    Cancel
                  </Button>
                </div>
              </form>
            ) : null}
            {!loading && !arms.length ? <p>No harnesses yet. Create one to begin.</p> : null}
            <div className="fleet-table-wrap">
              <table>
                <caption className="sr-only">Harness runtimes</caption>
                <thead>
                  <tr>
                    <th>Harness</th>
                    <th>Status</th>
                    <th>Host</th>
                    <th>Model</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {arms.map((arm) => (
                    <tr key={arm.id}>
                      <td>
                        <strong>{arm.name}</strong>
                        <span>
                          {arm.harness} · {arm.id}
                        </span>
                      </td>
                      <td>{arm.status}</td>
                      <td>{arm.host || arm.agentId || 'API host / unassigned'}</td>
                      <td>
                        {arm.provider} / {arm.model}
                      </td>
                      <td>
                        <div className="fleet-actions">
                          <Button
                            size="sm"
                            variant="ghost"
                            isDisabled={busy}
                            onPress={() =>
                              setHarness({
                                ...emptyHarness,
                                id: arm.id,
                                name: arm.name,
                                provider: arm.provider ?? '',
                                model: arm.model ?? '',
                              })
                            }
                          >
                            Edit
                          </Button>
                          {arm.status === 'stopped' || arm.status === 'error' ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              isDisabled={busy}
                              onPress={() => void mutate(() => api.spawnArm(arm.id), 'Harness started.')}
                            >
                              Start
                            </Button>
                          ) : (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                isDisabled={busy}
                                onPress={() =>
                                  void mutate(
                                    () => api.controlHarness(arm.id, arm.status === 'paused' ? 'resume' : 'pause'),
                                    'Harness updated.',
                                  )
                                }
                              >
                                {arm.status === 'paused' ? 'Resume' : 'Pause'}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                isDisabled={busy}
                                onPress={() =>
                                  setConfirmation({
                                    label: `Stop ${arm.name}? This interrupts current work and releases file claims. The arm profile is kept.`,
                                    run: () => api.controlHarness(arm.id, 'kill'),
                                  })
                                }
                              >
                                Stop
                              </Button>
                            </>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            isDisabled={busy || arm.status !== 'stopped'}
                            onPress={() =>
                              setConfirmation({
                                label: `Delete the stopped harness ${arm.name}?`,
                                run: () => api.deleteArm(arm.id),
                              })
                            }
                          >
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
        {tab === 'services' && services ? (
          <HostServiceConnections
            services={services}
            busy={busy}
            onSave={(settings, close) => {
              void mutate(async () => {
                await api.saveHostServices(settings);
                close();
              }, 'Settings saved. Apply and restart to activate them.');
            }}
            onRestart={() =>
              setConfirmation({
                label:
                  'Apply saved settings and restart the API? Stop all harnesses first. Your client may disconnect; reconnect at the new API address.',
                restart: true,
                run: () => api.restartHostServices(),
              })
            }
          />
        ) : null}
      </div>
    </div>
  );
}
