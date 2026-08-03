/**
 * Renders the shared task/bug status history chart.
 *
 * Dashboard callers use the collapsible presentation, while compact workbench
 * insight panels can embed the chart body without spending space on a second header.
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Input, Label } from '@heroui/react';
import { Clock3, Loader2 } from 'lucide-react';
import { api } from '@/lib';
import { CollapsibleSection } from '@/components/CollapsibleSection';
import { RESOURCE_STATUS_STYLES } from '@/design-system/resource-status-styles';
import { niceAxisMaximum, stackedTotal } from './status-burndown-chart';

import type {
  StatusSeriesEntity,
  StatusSeriesResolution,
  StatusSeriesResponse,
} from '@/lib';

const RESOLUTION_LABELS: Record<StatusSeriesResolution, string> = {
  hour: 'Hour',
  day: 'Day',
  week: 'Week',
};

const MAX_RANGE_MS: Record<StatusSeriesResolution, number> = {
  hour: 31 * 24 * 60 * 60 * 1000,
  day: 2 * 366 * 24 * 60 * 60 * 1000,
  week: 10 * 366 * 24 * 60 * 60 * 1000,
};

interface DateRangeValue {
  start: string;
  end: string;
}

export interface StatusBurndownChartProps {
  entity: StatusSeriesEntity;
  refreshKey?: number;
  className?: string;
  defaultExpanded?: boolean;
  embedded?: boolean;
}

function toLocalDateTimeValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function createDefaultRange(): DateRangeValue {
  const end = Date.now();
  return {
    start: toLocalDateTimeValue(new Date(end - 7 * 24 * 60 * 60 * 1000)),
    end: toLocalDateTimeValue(new Date(end)),
  };
}

function toIsoRange(range: DateRangeValue): DateRangeValue {
  return {
    start: new Date(range.start).toISOString(),
    end: new Date(range.end).toISOString(),
  };
}

function validateRange(range: DateRangeValue, resolution: StatusSeriesResolution): string | null {
  const start = new Date(range.start).getTime();
  const end = new Date(range.end).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'Enter both start and end date-times.';
  if (start >= end) return 'Start must be before end.';
  if (end - start > MAX_RANGE_MS[resolution]) {
    const maximum = resolution === 'hour' ? '31 days' : resolution === 'day' ? '2 years' : '10 years';
    return `${RESOLUTION_LABELS[resolution]} resolution supports up to ${maximum}.`;
  }
  return null;
}

function formatBucketLabel(value: string, resolution: StatusSeriesResolution): string {
  const date = new Date(value);
  if (resolution === 'hour') {
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' });
}

export function StatusBurndownChart({
  entity,
  refreshKey = 0,
  className,
  defaultExpanded = true,
  embedded = false,
}: StatusBurndownChartProps) {
  const initialRangeRef = useRef<DateRangeValue>(createDefaultRange());
  const [draftRange, setDraftRange] = useState(initialRangeRef.current);
  const [appliedRange, setAppliedRange] = useState(() => toIsoRange(initialRangeRef.current));
  const [resolution, setResolution] = useState<StatusSeriesResolution>('day');
  const [data, setData] = useState<StatusSeriesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const isChartVisible = embedded || isExpanded;
  const rangeError = validateRange(draftRange, resolution);
  const noun = entity === 'task' ? 'tasks' : 'bugs';

  useEffect(() => {
    if (!isChartVisible) return;

    const controller = new AbortController();
    setLoading(true);
    api.getStatusSeries({
      entity,
      start: appliedRange.start,
      end: appliedRange.end,
      resolution,
    }, controller.signal)
      .then((response) => {
        setData(response);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : `Failed to load ${noun} burndown`);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [appliedRange.end, appliedRange.start, entity, isChartVisible, noun, refreshKey, resolution]);

  const buckets = data?.buckets ?? [];
  const statuses = data?.statuses ?? Object.keys(RESOURCE_STATUS_STYLES[entity]);
  const rangeDays = Math.max(
    1,
    Math.round((new Date(appliedRange.end).getTime() - new Date(appliedRange.start).getTime()) / 86_400_000),
  );
  const maxDisplayed = Math.max(0, ...buckets.map((bucket) => stackedTotal(bucket.counts, statuses)));
  const yMaximum = niceAxisMaximum(maxDisplayed);
  const width = Math.max(720, buckets.length * 18 + 76);
  const height = 280;
  const left = 44;
  const right = 16;
  const top = 14;
  const bottom = 44;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const slotWidth = plotWidth / Math.max(1, buckets.length);
  const barWidth = Math.max(4, Math.min(30, slotWidth * 0.72));
  const labelStep = Math.max(1, Math.ceil(buckets.length / 6));
  const yTickCount = yMaximum <= 5
    ? yMaximum
    : [5, 4, 3, 2].find((count) => yMaximum % count === 0) ?? 5;
  const selected = hovered === null ? null : buckets[hovered] ?? null;

  return (
    <CollapsibleSection
      title={entity === 'task' ? 'Task Burndown' : 'Bug Burndown'}
      summary={[
        { label: 'Resolution', value: RESOLUTION_LABELS[resolution] },
        { label: 'Range', value: `${rangeDays}d` },
      ]}
      isExpanded={isChartVisible}
      onExpandedChange={embedded ? undefined : setIsExpanded}
      className={className}
      triggerClassName={embedded ? "hidden" : undefined}
      bodyClassName={embedded ? "space-y-4 pt-4" : "space-y-4"}
      unmountOnCollapse
    >
        <div className="grid gap-2 lg:grid-cols-[minmax(12rem,1fr)_minmax(12rem,1fr)_auto_auto] lg:items-end">
          <DateTimeInput
            id={`${entity}-burndown-start`}
            label="Start"
            value={draftRange.start}
            isInvalid={Boolean(rangeError)}
            onChange={(start) => setDraftRange((current) => ({ ...current, start }))}
          />
          <DateTimeInput
            id={`${entity}-burndown-end`}
            label="End"
            value={draftRange.end}
            isInvalid={Boolean(rangeError)}
            onChange={(end) => setDraftRange((current) => ({ ...current, end }))}
          />
          <div className="space-y-1">
            <span className="block text-xs font-medium text-muted-foreground">Resolution</span>
            <div className="flex rounded-lg border border-border bg-surface-secondary p-0.5">
              {(Object.keys(RESOLUTION_LABELS) as StatusSeriesResolution[]).map((value) => (
                <Button
                  key={value}
                  size="sm"
                  variant={resolution === value ? 'primary' : 'ghost'}
                  onPress={() => setResolution(value)}
                >
                  {RESOLUTION_LABELS[value]}
                </Button>
              ))}
            </div>
          </div>
          <Button
            variant="primary"
            isDisabled={Boolean(rangeError) || loading}
            onPress={() => setAppliedRange(toIsoRange(draftRange))}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock3 className="h-4 w-4" />}
            Apply
          </Button>
        </div>

        <p className={rangeError ? 'text-xs text-danger' : 'text-xs text-muted-foreground'}>
          {rangeError || 'Times use your local timezone. Bars show the status of every item at the end of each interval.'}
        </p>

        <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
          {statuses.map((status) => {
            const style = RESOURCE_STATUS_STYLES[entity][status] ?? { label: status, color: '#64748b' };
            return (
              <span key={status} className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: style.color }} />
                {style.label}
              </span>
            );
          })}
        </div>

        {error ? (
          <div className="flex h-56 items-center justify-center rounded-md border border-danger/30 bg-danger/10 text-sm text-danger">
            {error}
          </div>
        ) : loading && !data ? (
          <div className="h-56 animate-pulse rounded bg-secondary" />
        ) : maxDisplayed === 0 ? (
          <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
            No {noun} existed in the selected range.
          </div>
        ) : (
          <div className="relative overflow-x-auto">
            <svg
              viewBox={`0 0 ${width} ${height}`}
              className="h-64 min-w-full"
              style={{ width }}
              role="img"
              aria-label={`${entity === 'task' ? 'Task' : 'Bug'} statuses over time`}
              onMouseLeave={() => setHovered(null)}
            >
              {Array.from({ length: yTickCount + 1 }, (_, index) => index / yTickCount).map((fraction) => {
                const y = top + plotHeight - fraction * plotHeight;
                const value = Math.round(fraction * yMaximum);
                return (
                  <g key={fraction}>
                    <line x1={left} x2={width - right} y1={y} y2={y} stroke="#e5e7eb" strokeWidth="1" />
                    <text x={left - 8} y={y + 4} textAnchor="end" fill="#6b7280" fontSize="11">
                      {value}
                    </text>
                  </g>
                );
              })}

              {buckets.map((bucket, index) => {
                const x = left + index * slotWidth + (slotWidth - barWidth) / 2;
                let y = top + plotHeight;
                return (
                  <g
                    key={bucket.start}
                    onMouseEnter={() => setHovered(index)}
                    onMouseLeave={() => setHovered(null)}
                  >
                    {statuses.map((status) => {
                      const count = bucket.counts[status] ?? 0;
                      if (count <= 0) return null;
                      const segmentHeight = count / yMaximum * plotHeight;
                      y -= segmentHeight;
                      return (
                        <rect
                          key={status}
                          x={x}
                          y={y}
                          width={barWidth}
                          height={segmentHeight}
                          fill={RESOURCE_STATUS_STYLES[entity][status]?.color ?? '#64748b'}
                          rx="1.5"
                        />
                      );
                    })}
                    <rect x={left + index * slotWidth} y={top} width={slotWidth} height={plotHeight} fill="transparent" />
                    {index % labelStep === 0 ? (
                      <text
                        x={x + barWidth / 2}
                        y={height - 14}
                        textAnchor="middle"
                        fill="#6b7280"
                        fontSize="10"
                      >
                        {formatBucketLabel(bucket.start, resolution)}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </svg>

            {selected ? (
              <div className="pointer-events-none sticky bottom-auto left-full top-2 z-10 -mt-64 mr-3 w-48 -translate-x-full rounded-md border border-border bg-background/95 p-2 text-xs shadow">
                <strong>{formatBucketLabel(selected.start, resolution)}</strong>
                <div className="mt-1 space-y-0.5">
                  {statuses.map((status) => {
                    const style = RESOURCE_STATUS_STYLES[entity][status] ?? { label: status, color: '#64748b' };
                    return (
                      <div key={status} className="flex items-center justify-between gap-3">
                        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                          <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: style.color }} />
                          {style.label}
                        </span>
                        <span className="font-medium">{selected.counts[status] ?? 0}</span>
                      </div>
                    );
                  })}
                  <div className="mt-1 flex justify-between border-t border-border pt-1 font-semibold">
                    <span>Total</span>
                    <span>{selected.total}</span>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        )}
    </CollapsibleSection>
  );
}

function DateTimeInput({
  id,
  label,
  value,
  isInvalid,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  isInvalid: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <Label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        aria-invalid={isInvalid}
        fullWidth
        type="datetime-local"
        value={value}
        variant="secondary"
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
