import { useEffect, useState } from 'react';
import {
  Button,
  DateField,
  DateInputGroup,
  Label,
} from '@heroui/react';
import { fromDate, getLocalTimeZone, type DateValue } from '@internationalized/date';
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
  start: DateValue;
  end: DateValue;
}

interface AppliedRange {
  start: string;
  end: string;
}

function createRange(durationMs: number): DraftRange {
  const timeZone = getLocalTimeZone();
  const end = Date.now();
  return {
    start: fromDate(new Date(end - durationMs), timeZone),
    end: fromDate(new Date(end), timeZone),
  };
}

function toAppliedRange(range: DraftRange): AppliedRange {
  const timeZone = getLocalTimeZone();
  return {
    start: range.start.toDate(timeZone).toISOString(),
    end: range.end.toDate(timeZone).toISOString(),
  };
}

function validateRange(range: DraftRange): string | null {
  const timeZone = getLocalTimeZone();
  const duration = range.end.toDate(timeZone).getTime() - range.start.toDate(timeZone).getTime();
  if (duration <= 0) return 'Start must be before end.';
  if (duration > MAX_RANGE_MS) return 'Select a range of 7 days or less.';
  return null;
}

function DateTimeField({
  label,
  value,
  isInvalid,
  onChange,
}: {
  label: string;
  value: DateValue;
  isInvalid: boolean;
  onChange: (value: DateValue) => void;
}) {
  return (
    <DateField
      aria-label={label}
      className="min-w-0 flex-1"
      granularity="minute"
      hideTimeZone
      hourCycle={24}
      isInvalid={isInvalid}
      value={value}
      onChange={(next) => {
        if (next) onChange(next);
      }}
    >
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      <DateInputGroup fullWidth variant="secondary">
        <DateInputGroup.Input>
          {(segment) => <DateInputGroup.Segment segment={segment} />}
        </DateInputGroup.Input>
      </DateInputGroup>
    </DateField>
  );
}

export function AllArmsTelemetryOverview() {
  const [draftRange, setDraftRange] = useState<DraftRange>(() => createRange(THIRTY_MINUTES_MS));
  const [appliedRange, setAppliedRange] = useState<AppliedRange>(() =>
    toAppliedRange(createRange(THIRTY_MINUTES_MS)),
  );
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
    <section className="space-y-4 rounded-lg border border-border bg-surface/90 p-4" aria-labelledby="telemetry-overview-title">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
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

        <div className="flex w-full flex-col gap-2 xl:max-w-3xl">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <DateTimeField
              label="Start"
              value={draftRange.start}
              isInvalid={Boolean(rangeError)}
              onChange={(start) => setDraftRange((current) => ({ ...current, start }))}
            />
            <DateTimeField
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
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <ArmActivityChart
            armId={null}
            metrics={activityMetrics}
            title="Activity - All Arms"
            refreshMs={0}
          />
          <ArmContextUsageChart
            armId={null}
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
