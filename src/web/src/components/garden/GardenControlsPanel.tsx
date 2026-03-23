import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components';

import type { GardenDisplaySettings } from './types';

interface GardenControlsPanelProps {
  settings: GardenDisplaySettings;
  onChange: (updates: Partial<GardenDisplaySettings>) => void;
}

interface ToggleRowProps {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

function ToggleRow({ label, description, checked, onChange }: ToggleRowProps) {
  return (
    <label className="flex items-start gap-3 rounded-lg border border-border/60 bg-black/10 px-3 py-2">
      <input
        type="checkbox"
        className="mt-1 h-4 w-4 accent-cyan-400"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}

interface SliderRowProps {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}

function SliderRow({ label, description, value, min, max, step, onChange }: SliderRowProps) {
  return (
    <div className="rounded-lg border border-border/60 bg-black/10 px-3 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-foreground">{label}</div>
          <div className="text-xs text-muted-foreground">{description}</div>
        </div>
        <div className="text-xs font-medium text-cyan-200">{value.toFixed(1)}</div>
      </div>
      <input
        type="range"
        className="w-full accent-cyan-400"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

export function GardenControlsPanel({ settings, onChange }: GardenControlsPanelProps) {
  return (
    <Card className="max-h-[min(72vh,720px)] overflow-hidden border-cyan-400/15 bg-slate-950/75 backdrop-blur">
      <CardHeader className="mb-3 border-b border-cyan-400/10 pb-3">
        <CardTitle className="text-cyan-50">Garden Controls</CardTitle>
        <CardDescription>
          Reduce noise by keeping only the layers you need visible.
        </CardDescription>
      </CardHeader>

      <CardContent className="max-h-[min(calc(72vh-88px),632px)] space-y-5 overflow-y-auto pr-2">
        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-200/80">Layers</h4>
          <div className="space-y-2">
            <ToggleRow
              label="Tasks"
              description="Main work objects and their local blooms."
              checked={settings.showTasks}
              onChange={(checked) => onChange({ showTasks: checked })}
            />
            <ToggleRow
              label="Bugs"
              description="Urgent bug spikes near the affected work."
              checked={settings.showBugs}
              onChange={(checked) => onChange({ showBugs: checked })}
            />
            <ToggleRow
              label="Discoveries"
              description="Secondary findings as jiggling bubbles."
              checked={settings.showDiscoveries}
              onChange={(checked) => onChange({ showDiscoveries: checked })}
            />
            <ToggleRow
              label="Proposals"
              description="Governance bubbles orbiting the brain."
              checked={settings.showProposals}
              onChange={(checked) => onChange({ showProposals: checked })}
            />
            <ToggleRow
              label="Claims"
              description="Thin ownership strands to workspace anchors."
              checked={settings.showClaims}
              onChange={(checked) => onChange({ showClaims: checked })}
            />
            <ToggleRow
              label="Health"
              description="Infrastructure health bubbles near the boundary shelf."
              checked={settings.showHealth}
              onChange={(checked) => onChange({ showHealth: checked })}
            />
          </div>
        </div>

        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-200/80">Display</h4>
          <div className="space-y-2">
            <ToggleRow
              label="Labels"
              description="Show text labels for the main scene objects."
              checked={settings.showLabels}
              onChange={(checked) => onChange({ showLabels: checked })}
            />
            <ToggleRow
              label="Links"
              description="Show task assignment and consensus links."
              checked={settings.showLinks}
              onChange={(checked) => onChange({ showLinks: checked })}
            />
            <ToggleRow
              label="Completed Tasks"
              description="Keep recently completed work visible in the beds."
              checked={settings.showCompleted}
              onChange={(checked) => onChange({ showCompleted: checked })}
            />
            <ToggleRow
              label="Follow Selection"
              description="Nudge the camera toward the selected object."
              checked={settings.followSelection}
              onChange={(checked) => onChange({ followSelection: checked })}
            />
          </div>
        </div>

        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-200/80">Atmosphere</h4>
          <div className="space-y-3">
            <SliderRow
              label="Brightness"
              description="Overall scene luminance and bloom."
              value={settings.brightness}
              min={0.6}
              max={1.6}
              step={0.1}
              onChange={(value) => onChange({ brightness: value })}
            />
            <SliderRow
              label="Motion"
              description="How much the scene breathes and jiggles."
              value={settings.motion}
              min={0.2}
              max={1.8}
              step={0.1}
              onChange={(value) => onChange({ motion: value })}
            />
            <SliderRow
              label="Bubble Scale"
              description="Scale secondary bubble entities up or down."
              value={settings.bubbleScale}
              min={0.7}
              max={1.6}
              step={0.1}
              onChange={(value) => onChange({ bubbleScale: value })}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
