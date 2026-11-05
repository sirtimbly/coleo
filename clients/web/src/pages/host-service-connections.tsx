import { useState } from 'react';
import { Button } from '@heroui/react';
import type { ServiceSettings, ServiceState } from '../../../../server/src/shared/hosts';

interface Props {
  services: ServiceState;
  busy: boolean;
  onSave: (settings: ServiceSettings, onSuccess: () => void) => void;
  onRestart: () => void;
}
export function HostServiceConnections({ services, busy, onSave, onRestart }: Props): React.JSX.Element {
  const [settings, setSettings] = useState<ServiceSettings | null>(null);
  return (
    <>
      <div className="fleet-section-heading">
        <h2>Service connections</h2>
        <Button
          size="sm"
          isDisabled={busy}
          onPress={() =>
            setSettings({
              ...services.active,
              ...Object.fromEntries(Object.entries(services.saved).filter(([, v]) => v)),
            })
          }
        >
          Edit connections
        </Button>
      </div>
      <p>{services.explanation}</p>
      <div className="fleet-table-wrap">
        <table>
          <caption className="sr-only">Active and saved service settings</caption>
          <thead>
            <tr>
              <th>Setting</th>
              <th>Active</th>
              <th>Saved for next restart</th>
            </tr>
          </thead>
          <tbody>
            {(Object.keys(services.active) as (keyof ServiceSettings)[]).map((key) => (
              <tr key={key}>
                <th>
                  {
                    {
                      host: 'API bind host',
                      port: 'API port',
                      natsUrl: 'NATS server',
                      dbPath: 'SQLite database path',
                    }[key]
                  }
                </th>
                <td>{services.active[key]}</td>
                <td>{services.saved[key] || 'Uses active setting'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {settings ? (
        <form
          className="fleet-form"
          onSubmit={(e) => {
            e.preventDefault();
            onSave(settings, () => setSettings(null));
          }}
        >
          <h3>Edit service connections</h3>
          {(Object.keys(settings) as (keyof ServiceSettings)[]).map((key) => (
            <label key={key}>
              {
                {
                  host: 'API bind host',
                  port: 'API port',
                  natsUrl: 'NATS server URL',
                  dbPath: 'Existing SQLite database path on API host',
                }[key]
              }
              <input
                required
                value={settings[key]}
                onChange={(e) => setSettings({ ...settings, [key]: e.target.value })}
              />
            </label>
          ))}
          <div className="fleet-actions">
            <Button size="sm" type="submit" isDisabled={busy}>
              Save settings
            </Button>
            <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => setSettings(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      <Button size="sm" variant="secondary" isDisabled={busy || !services.restartAvailable} onPress={onRestart}>
        Apply and restart API
      </Button>
      {!services.restartAvailable ? (
        <p>This API is managed externally. Apply settings through its deployment controls.</p>
      ) : null}
      {services.restartLog ? (
        <details>
          <summary>Last restart output</summary>
          <pre>{services.restartLog}</pre>
        </details>
      ) : null}
    </>
  );
}
