import { useEffect, useMemo, useState } from 'react';
import { BarChart3, Info, SlidersHorizontal, X } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components';
import { GardenCanvas } from '@/components/garden/GardenCanvas';
import { GardenControlsPanel } from '@/components/garden/GardenControlsPanel';
import { GardenInspector } from '@/components/garden/GardenInspector';
import type { GardenDisplaySettings, GardenSelection } from '@/components/garden/types';
import { useGardenScene } from '@/hooks/useGardenScene';
import { usePageTitle } from '@/hooks/usePageTitle';

const SETTINGS_STORAGE_KEY = 'coleo:garden:settings';

const DEFAULT_SETTINGS: GardenDisplaySettings = {
  showTasks: true,
  showBugs: true,
  showDiscoveries: true,
  showProposals: true,
  showClaims: true,
  showHealth: true,
  showLabels: false,
  showLinks: true,
  showCompleted: false,
  followSelection: true,
  brightness: 1.3,
  motion: 1,
  bubbleScale: 1,
};

function loadStoredSettings(): GardenDisplaySettings {
  if (typeof window === 'undefined') {
    return DEFAULT_SETTINGS;
  }

  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<GardenDisplaySettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function StatChip({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent: string;
}) {
  return (
    <div className="rounded-full border border-border bg-surface-secondary px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
      <div className={`mt-1 text-sm font-semibold ${accent}`}>{value}</div>
    </div>
  );
}

export function GardenPage() {
  usePageTitle('Coleo Observatory - Garden');

  const { data: scene, isLoading, isError, error } = useGardenScene();
  const [settings, setSettings] = useState<GardenDisplaySettings>(loadStoredSettings);
  const [selection, setSelection] = useState<GardenSelection | null>({ kind: 'brain', id: 'brain' });
  const [controlsOpen, setControlsOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [hudOpen, setHudOpen] = useState(false);

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    if (!scene) return;
    if (!selection) return;

    const knownIds = new Set<string>([
      scene.brain.id,
      ...scene.anchors.map((anchor) => anchor.id),
      ...scene.arms.map((arm) => arm.id),
      ...scene.tasks.map((task) => task.id),
      ...scene.bugs.map((bug) => bug.id),
      ...scene.bubbles.map((bubble) => bubble.id),
    ]);

    if (!knownIds.has(selection.id)) {
      setSelection({ kind: 'brain', id: 'brain' });
    }
  }, [scene, selection]);

  const selectedSummary = useMemo(() => {
    if (!selection) return 'Nothing selected';
    switch (selection.kind) {
      case 'brain':
        return 'Brain nucleus selected';
      case 'arm':
        return `Arm ${selection.id}`;
      case 'task':
        return `Task ${selection.id}`;
      case 'bug':
        return `Bug ${selection.id}`;
      case 'anchor':
        return `Anchor ${selection.id}`;
      case 'bubble':
        return `Bubble ${selection.id}`;
      default:
        return selection.id;
    }
  }, [selection]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background text-foreground">
      <div className="border-b border-border bg-surface px-4 py-2 lg:px-5">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-full border border-border bg-surface-secondary px-3 py-1.5 text-xs font-medium text-foreground transition hover:border-accent/50 hover:bg-surface-tertiary"
            onClick={() => setHudOpen((current) => !current)}
          >
            {hudOpen ? <X className="h-3.5 w-3.5" /> : <BarChart3 className="h-3.5 w-3.5" />}
            {hudOpen ? 'Hide stats' : 'Show stats'}
          </button>
          <div className="font-medium text-foreground">{selectedSummary}</div>
          <div className="text-xs text-muted-foreground">
            Mouse orbit/pan/zoom. WASD or arrows move.
          </div>
        </div>

        {hudOpen ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <StatChip
              label="Active Arms"
              value={scene?.stats.activeArms ?? '—'}
              accent="text-cyan-600 dark:text-cyan-300"
            />
            <StatChip
              label="Tasks"
              value={scene?.stats.visibleTasks ?? '—'}
              accent="text-emerald-600 dark:text-emerald-300"
            />
            <StatChip
              label="Bugs"
              value={scene?.stats.visibleBugs ?? '—'}
              accent="text-amber-600 dark:text-amber-300"
            />
            <StatChip
              label="Discoveries"
              value={scene?.stats.visibleDiscoveries ?? '—'}
              accent="text-sky-600 dark:text-sky-300"
            />
            <StatChip
              label="Proposals"
              value={scene?.stats.openProposals ?? '—'}
              accent="text-fuchsia-600 dark:text-fuchsia-300"
            />
            <StatChip
              label="Conflicts"
              value={scene?.stats.conflictZones ?? '—'}
              accent="text-rose-600 dark:text-rose-300"
            />
          </div>
        ) : null}
      </div>

      <div className="flex-1 overflow-hidden p-3 lg:p-4">
        <div className="relative h-full">
          {isLoading ? (
            <Card className="border-border bg-surface">
              <CardHeader>
                <CardTitle>Loading Garden</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                Building the scene from current arms, tasks, bugs, discoveries, and ownership links…
              </CardContent>
            </Card>
          ) : isError || !scene ? (
            <Card className="border-danger/30 bg-surface">
              <CardHeader>
                <CardTitle className="text-danger">Unable to Load Garden</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-danger">
                {error instanceof Error ? error.message : 'Unknown scene error'}
              </CardContent>
            </Card>
          ) : (
            <>
              <GardenCanvas
                scene={scene}
                settings={settings}
                selection={selection}
                onSelect={setSelection}
              />
              <div className="pointer-events-none absolute left-3 top-3 z-20 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-cyan-400/15 bg-slate-950/80 px-3 py-1.5 text-xs font-medium text-cyan-50 shadow-lg transition hover:border-cyan-300/30 hover:bg-slate-900/90"
                  onClick={() => setControlsOpen((current) => !current)}
                >
                  {controlsOpen ? <X className="h-3.5 w-3.5" /> : <SlidersHorizontal className="h-3.5 w-3.5" />}
                  {controlsOpen ? 'Hide controls' : 'Controls'}
                </button>
              </div>

              <div className="pointer-events-none absolute right-3 top-3 z-20 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-cyan-400/15 bg-slate-950/80 px-3 py-1.5 text-xs font-medium text-cyan-50 shadow-lg transition hover:border-cyan-300/30 hover:bg-slate-900/90"
                  onClick={() => setInspectorOpen((current) => !current)}
                >
                  {inspectorOpen ? <X className="h-3.5 w-3.5" /> : <Info className="h-3.5 w-3.5" />}
                  {inspectorOpen ? 'Hide details' : 'Details'}
                </button>
              </div>

              {controlsOpen ? (
                <div className="absolute left-3 top-14 z-20 w-[min(86vw,290px)] max-w-full">
                  <GardenControlsPanel
                    settings={settings}
                    onChange={(updates) => setSettings((current) => ({ ...current, ...updates }))}
                  />
                </div>
              ) : null}

              {inspectorOpen ? (
                <div className="absolute right-3 top-14 z-20 w-[min(86vw,290px)] max-w-full">
                  <GardenInspector scene={scene} selection={selection} />
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
