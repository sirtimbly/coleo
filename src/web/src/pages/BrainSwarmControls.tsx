import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { BrainSettingSwitch } from './BrainSettingSwitch';
import { api } from '@/lib/api';
import type { BrainConfigResponse } from '@/lib/api';

interface BrainSwarmControlsProps {
  config: BrainConfigResponse | null;
  pollIntervalMs: number;
  onSaved: (config: BrainConfigResponse) => void;
}

export function BrainSwarmControls({ config, pollIntervalMs, onSaved }: BrainSwarmControlsProps) {
  const mode = config?.swarmEvaluationMode ?? 'off';
  const windowPolls = config?.swarmWindowPolls ?? 10;
  const [windowDraft, setWindowDraft] = useState(String(windowPolls));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setWindowDraft(String(windowPolls)); }, [windowPolls]);

  const save = async (changes: Partial<Pick<BrainConfigResponse, 'swarmEvaluationMode' | 'swarmWindowPolls'>>) => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const response = await api.updateBrainConfig(changes);
      onSaved(response.brain);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save swarm settings');
    } finally {
      setSaving(false);
    }
  };

  const count = Number(windowDraft);
  const validCount = Number.isInteger(count) && count >= 1 && count <= 100;
  const seconds = windowPolls * pollIntervalMs / 1000;
  const duration = seconds >= 60 ? `${Math.round(seconds / 60 * 10) / 10} minutes` : `${seconds} seconds`;

  return (
    <section aria-labelledby="brain-swarm-title" className="rounded-lg bg-surface-secondary/40 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="brain-swarm-title" className="text-sm font-semibold">Swarm activity evaluation</h2>
        <span className="text-xs text-muted-foreground">
          {!config ? 'Loading…' : mode === 'off' ? 'Off' : mode === 'shadow' ? 'Proposals only' : 'Execution enabled'}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        JEV reviews recent arm activity, current state, and prior Brain actions together.
      </p>
      <div className="my-4 grid gap-4 sm:grid-cols-2">
        <BrainSettingSwitch
          label="Evaluate swarm activity"
          description="Record proposed actions each poll. Requires the Brain’s JEV API key."
          selected={mode !== 'off'}
          disabled={!config || saving}
          onChange={enabled => { void save({ swarmEvaluationMode: enabled ? 'shadow' : 'off' }); }}
        />
        <BrainSettingSwitch
          label="Execute swarm actions"
          description="Run supported actions that pass confidence and repeat checks."
          selected={mode === 'execute'}
          disabled={!config || saving || mode === 'off'}
          onChange={enabled => { void save({ swarmEvaluationMode: enabled ? 'execute' : 'shadow' }); }}
        />
      </div>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => {
        event.preventDefault();
        if (validCount) void save({ swarmWindowPolls: count });
      }}>
        <div>
          <label htmlFor="swarm-window-polls" className="mb-1 block text-xs text-muted-foreground">Activity window (polls)</label>
          <input id="swarm-window-polls" type="number" min={1} max={100} step={1} required
            value={windowDraft} disabled={!config || saving}
            onChange={(event) => { setWindowDraft(event.target.value); setSaved(false); }}
            aria-describedby="swarm-window-description"
            className="w-24 rounded-md border border-border bg-secondary px-3 py-2 text-sm" />
        </div>
        <Button type="submit" size="sm" variant="secondary"
          isDisabled={!config || saving || !validCount || count === windowPolls}>Save window</Button>
        <p id="swarm-window-description" className="pb-2 text-xs text-muted-foreground">
          Current window: {windowPolls} polls · {duration}
        </p>
      </form>
      <p className="mt-3 text-xs text-muted-foreground">
        Changes apply on the next evaluation. Turning execution off cancels actions that have not started.
        {' '}Dev-server restarts and Git preservation remain proposals. These switches control only this evaluator.
      </p>
      <p role="status" className="mt-2 text-xs text-muted-foreground">{saving ? 'Saving…' : saved ? 'Settings saved.' : ''}</p>
      {error ? <p role="alert" className="mt-2 text-sm text-danger">{error}</p> : null}
    </section>
  );
}
