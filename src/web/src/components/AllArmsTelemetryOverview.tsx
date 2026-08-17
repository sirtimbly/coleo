import { useEffect, useState } from 'react';
import {
  Button,
  Input,
  Label,
} from '@heroui/react';
import { Clock3, Loader2 } from 'lucide-react';
import { api, type AllArmsTelemetryResponse, type ArmActivityMetricsResponse } from '@/lib';
import { ArmActivityChart } from './ArmActivityChart';
import { ArmContextUsageChart } from './ArmContextUsageChart';
import { ArmCostUsageChart } from './ArmCostUsageChart';
import { aggregateContextSamples, mapAllArmCostSamples } from './all-arms-telemetry';

const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_MS = 7 * ONE_DAY_MS;

interface DraftRange {
  start: string;
  end: string;
}

interface AppliedRange {
  start: string;
  end: string;
}

function createRange(durationMs: number): DraftRange {
  const end = Date.now();
  return {
    start: toLocalDateTimeValue(new Date(end - durationMs)),
    end: toLocalDateTimeValue(new Date(end)),
  };
}

function toLocalDateTimeValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function toAppliedRange(range: DraftRange): AppliedRange {
  return {
    start: new Date(range.start).toISOString(),
    end: new Date(range.end).toISOString(),
  };
}

function validateRange(range: DraftRange): string | null {
  const start = new Date(range.start).getTime();
  const end = new Date(range.end).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'Enter both start and end date-times.';
  const duration = end - start;
  if (duration <= 0) return 'Start must be before end.';
  if (duration > MAX_RANGE_MS) return 'Select a range of 7 days or less.';
  return null;
}

function DateTimeInput({
  label,
  value,
  isInvalid,
  onChange,
}: {
  label: string;
  value: string;
  isInvalid: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="min-w-0 flex-1 space-y-1">
      <Label htmlFor={`telemetry-${label.toLowerCase()}`} className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      <Input
        id={`telemetry-${label.toLowerCase()}`}
        aria-invalid={isInvalid}
        className="w-full"
        fullWidth
        type="datetime-local"
        value={value}
        variant="secondary"
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

interface AllArmsTelemetryOverviewProps {
  embedded?: boolean;
  contextBudget?: number;
}

export function AllArmsTelemetryOverview({
  embedded = false,
  contextBudget,
}: AllArmsTelemetryOverviewProps) {
  const [draftRange, setDraftRange] = useState<DraftRange>(() => createRange(ONE_DAY_MS));
  const [appliedRange, setAppliedRange] = useState<AppliedRange>(() => toAppliedRange(draftRange));
  const [telemetry, setTelemetry] = useState<AllArmsTelemetryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const rangeError = validateRange(draftRange);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getAllArmsTelemetry(appliedRange.start, appliedRange.end)
      .then((response) => {
        if (cancelled) return;
        setTelemetry(response);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : 'Failed to load arm telemetry');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [appliedRange.end, appliedRange.start]);

  const applyPreset = (durationMs: number) => {
    const range = createRange(durationMs);
    setDraftRange(range);
    setAppliedRange(toAppliedRange(range));
  };

  const activityMetrics: ArmActivityMetricsResponse | undefined = telemetry
    ? {
        armId: 'all',
        window: telemetry.window,
        buckets: telemetry.activity.buckets,
        summary: telemetry.activity.summary,
      }
    : undefined;
  const chartRange = telemetry
    ? {
        start: new Date(telemetry.window.start).getTime(),
        end: new Date(telemetry.window.end).getTime(),
      }
    : undefined;
  const contextSamples = telemetry ? aggregateContextSamples(telemetry.contextSamples) : undefined;
  const costSamples = telemetry ? mapAllArmCostSamples(telemetry.costSamples) : undefined;

  return (
    <section
      className={embedded ? 'space-y-4' : 'space-y-4 rounded-lg border border-border bg-surface/90 p-4'}
      aria-label={embedded ? 'All-arm telemetry controls and charts' : undefined}
      aria-labelledby={embedded ? undefined : 'telemetry-overview-title'}
    >
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        {!embedded ? (
          <div className="space-y-1">
            <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Telemetry Overview
            </div>
            <h2 id="telemetry-overview-title" className="text-sm font-semibold text-foreground">
              All-arm activity, context, and cost
            </h2>
            <p className="text-xs text-muted-foreground">
              {telemetry ? `${telemetry.armCount} registered arms` : 'All registered arms'} · exact applied date-time range
            </p>
          </div>
        ) : null}

        <div className={embedded ? 'flex w-full flex-col gap-2' : 'flex w-full flex-col gap-2 xl:max-w-3xl'}>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <DateTimeInput
              label="Start"
              value={draftRange.start}
              isInvalid={Boolean(rangeError)}
              onChange={(start) => setDraftRange((current) => ({ ...current, start }))}
            />
            <DateTimeInput
              label="End"
              value={draftRange.end}
              isInvalid={Boolean(rangeError)}
              onChange={(end) => setDraftRange((current) => ({ ...current, end }))}
            />
            <Button
              variant="primary"
              isDisabled={Boolean(rangeError) || loading}
              onPress={() => setAppliedRange(toAppliedRange(draftRange))}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock3 className="h-4 w-4" />}
              Apply
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={rangeError ? 'text-xs text-danger' : 'text-xs text-muted-foreground'}>
              {rangeError || 'Times use your local timezone. Maximum range: 7 days.'}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="tertiary" onPress={() => applyPreset(THIRTY_MINUTES_MS)}>
                Last 30m
              </Button>
              <Button size="sm" variant="tertiary" onPress={() => applyPreset(ONE_DAY_MS)}>
                Last 24h
              </Button>
            </div>
          </div>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-4 text-sm text-danger">
          {error}
        </div>
      ) : !telemetry && loading ? (
        <div className="flex h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading all-arm telemetry...
        </div>
      ) : telemetry ? (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr))]">
          <ArmActivityChart
            armId={null}
            metrics={activityMetrics}
            title="Activity - All Arms"
            refreshMs={0}
          />
          <ArmContextUsageChart
            armId={null}
            contextBudget={contextBudget}
            samples={contextSamples}
            range={chartRange}
            title="Context Usage - All Arms"
          />
          <ArmCostUsageChart
            armId={null}
            samples={costSamples}
            range={chartRange}
            title="Cost Usage - All Arms"
          />
        </div>
      ) : null}
    </section>
  );
}
