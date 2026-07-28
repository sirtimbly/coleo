import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api, type ArmActivityMetricsResponse } from '@/lib';
import {
  type ViewerActivityItem,
  type ViewerActivityType,
} from '@/pages/arm-viewer-activity';
import { Card, CardContent, CardHeader, CardTitle } from '@/components';
import {
  CATEGORY_STYLES,
  classifyActivity,
  type ActivityCategory,
  type CategoryStyle,
} from './arm-activity-classify';

export type { ActivityCategory, CategoryStyle };
export { CATEGORY_STYLES, classifyActivity };

/**
 * ArmActivityChart
 *
 * Minute-by-minute activity bar graph over a 30-minute window.
 * Stacked bars per minute show events per activity category:
 *   - File writes (blue)
 *   - Thinking / reasoning (yellow)
 *   - Tool calls (green)
 *   - Completed tasks (prominent purple)
 *
 * Inactive minutes leave a gap so activity and efficiency are visible at a glance.
 * Tasks pile up vertically within a minute bar.
 */

const WINDOW_MINUTES = 30;
const MINUTE_MS = 60 * 1000;
const BAR_GAP_PX = 6;
const BAR_MAX_WIDTH_PX = 18;
const CHART_LEFT_PAD = 36;
const CHART_RIGHT_PAD = 12;
const CHART_TOP_PAD = 12;
const CHART_BOTTOM_PAD = 28;
const CHART_HEIGHT_PX = 180;
const CHART_HEIGHT_PX_COMPACT = 52;
const LEGEND_ROW_HEIGHT = 18;
const LEGEND_ROW_HEIGHT_COMPACT = 0;
const HOVER_TOOLTIP_WIDTH = 200;

interface MinuteBucket {
  index: number;
  startMs: number;
  endMs: number;
  counts: Record<ActivityCategory, number>;
  items: ViewerActivityItem[];
}

function buildBuckets(
  activities: ViewerActivityItem[],
  nowMs: number,
): MinuteBucket[] {
  const end = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const start = end - WINDOW_MINUTES * MINUTE_MS;
  const buckets: MinuteBucket[] = [];
  for (let i = 0; i < WINDOW_MINUTES; i++) {
    const minuteStart = start + i * MINUTE_MS;
    const minuteEnd = minuteStart + MINUTE_MS;
    buckets.push({
      index: i,
      startMs: minuteStart,
      endMs: minuteEnd,
      counts: { write: 0, think: 0, tool: 0, complete: 0 },
      items: [],
    });
  }

  for (const activity of activities) {
    if (activity.timestamp < start || activity.timestamp >= end) continue;
    const index = Math.floor((activity.timestamp - start) / MINUTE_MS);
    if (index < 0 || index >= buckets.length) continue;
    const bucket = buckets[index]!;
    const category = classifyActivity(activity);
    bucket.counts[category] += 1;
    bucket.items.push(activity);
  }

  return buckets;
}

interface ArmActivityChartProps {
  armId: string | null;
  activities?: ViewerActivityItem[];
  metrics?: ArmActivityMetricsResponse;
  windowMs?: number;
  limit?: number;
  title?: string;
  className?: string;
  compact?: boolean;
  /** When set, auto-refresh every N ms (defaults to 60s). Set to 0 to disable. */
  refreshMs?: number;
  /** If true, render without the surrounding Card shell (for embedded use). */
  embedded?: boolean;
}

export function ArmActivityChart({
  armId,
  activities: externalActivities,
  metrics: externalMetrics,
  windowMs = WINDOW_MINUTES * MINUTE_MS,
  limit = 1000,
  title = 'Arm Activity',
  className,
  compact = false,
  refreshMs = 60_000,
  embedded = false,
}: ArmActivityChartProps) {
  const [activities, setActivities] = useState<ViewerActivityItem[]>(
    externalActivities ?? [],
  );
  const [metricBuckets, setMetricBuckets] = useState<MinuteBucket[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (externalMetrics) {
      setMetricBuckets(toMinuteBuckets(externalMetrics));
      setActivities([]);
      setError(null);
      return;
    }
    if (externalActivities !== undefined) {
      setActivities(externalActivities);
      setMetricBuckets(null);
      return;
    }
    if (!armId) {
      setActivities([]);
      setMetricBuckets(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .getArmActivityMetrics(armId, windowMs)
      .then((response) => {
        if (cancelled) return;
        setMetricBuckets(toMinuteBuckets(response));
        setActivities([]);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load activity');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [armId, externalActivities, externalMetrics, windowMs, limit, tick]);

  useEffect(() => {
    if (!refreshMs || refreshMs <= 0) return;
    const interval = setInterval(() => setTick((t) => t + 1), refreshMs);
    return () => clearInterval(interval);
  }, [refreshMs]);

  const buckets = metricBuckets ?? buildBuckets(activities, Date.now());

  const maxStack = useMemo(() => {
    let peak = 0;
    for (const bucket of buckets) {
      const total = bucket.counts.write + bucket.counts.think + bucket.counts.tool + bucket.counts.complete;
      if (total > peak) peak = total;
    }
    return peak;
  }, [buckets]);

  const bucketCount = Math.max(1, buckets.length);
  const chartWidth = WINDOW_MINUTES * (BAR_MAX_WIDTH_PX + BAR_GAP_PX) + CHART_LEFT_PAD + CHART_RIGHT_PAD;
  const legendHeight = compact ? LEGEND_ROW_HEIGHT_COMPACT : LEGEND_ROW_HEIGHT;
  const topPad = compact ? 10 : CHART_TOP_PAD;
  const bottomPad = compact ? 20 : CHART_BOTTOM_PAD;
  const chartHeight = (compact ? CHART_HEIGHT_PX_COMPACT : CHART_HEIGHT_PX) + topPad + bottomPad + legendHeight;
  const labelColor = '#6b7280';
  const gridColor = '#e5e7eb';

  const barAreaWidth = chartWidth - CHART_LEFT_PAD - CHART_RIGHT_PAD;
  const barSlotWidth = barAreaWidth / bucketCount;
  const barGap = Math.min(BAR_GAP_PX, barSlotWidth * 0.25);
  const barWidth = Math.max(2, Math.min(BAR_MAX_WIDTH_PX, barSlotWidth - barGap));

  const plotTop = topPad;
  const plotBottom = chartHeight - bottomPad - legendHeight;
  const plotHeight = plotBottom - plotTop;
  const barMaxHeight = plotHeight;
  const unitHeight = maxStack > 0 ? barMaxHeight / maxStack : 0;

  const renderBars = () => {
    return buckets.map((bucket, index) => {
      const total =
        bucket.counts.write +
        bucket.counts.think +
        bucket.counts.tool +
        bucket.counts.complete;
      const x = CHART_LEFT_PAD + index * barSlotWidth;
      let y = plotBottom;

      const segments: Array<{ color: string; height: number; count: number }> = [];
      for (const style of CATEGORY_STYLES) {
        const count = bucket.counts[style.key];
        if (count <= 0) continue;
        const height = count * unitHeight;
        segments.push({ color: style.color, height, count });
      }

      if (total === 0) {
        return null;
      }

      return (
        <g
          key={`bar-${index}-${bucket.startMs}`}
          onMouseEnter={() => setHovered(index)}
          onMouseLeave={() => setHovered(null)}
        >
          {segments.map((segment, segIndex) => {
            y -= segment.height;
            const rect = (
              <rect
                key={`seg-${index}-${segIndex}`}
                x={x}
                y={y}
                width={barWidth}
                height={Math.max(0, segment.height)}
                fill={segment.color}
                rx={1.5}
              />
            );
            return rect;
          })}
          <rect
            x={x - 1}
            y={plotTop}
            width={barWidth + 2}
            height={plotHeight}
            fill="transparent"
          />
        </g>
      );
    });
  };

  const timeLabels = useMemo(() => {
    if (buckets.length === 0) return [];
    const labels: Array<{ index: number; label: string }> = [];
    const sampleCount = Math.min(6, buckets.length);
    const step = Math.max(1, Math.floor(buckets.length / sampleCount));
    for (let i = 0; i < buckets.length; i += step) {
      const bucket = buckets[i]!;
      const date = new Date(bucket.startMs);
      labels.push({
        index: i,
        label: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      });
    }
    return labels;
  }, [buckets]);

  const rangeLabel = externalMetrics
    ? `${new Date(externalMetrics.window.start).toLocaleString()} - ${new Date(externalMetrics.window.end).toLocaleString()}`
    : `Last ${WINDOW_MINUTES} min`;

  const selectedBucket = hovered === null ? null : buckets[hovered] ?? null;
  const hasActivity = buckets.some((bucket) =>
    bucket.counts.write + bucket.counts.think + bucket.counts.tool + bucket.counts.complete > 0,
  );

  const inner = (
    <div className="space-y-2 text-sm">
      {!compact ? (
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <>
            {CATEGORY_STYLES.map((style) => (
              <div key={style.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: style.color }}
                />
                <span>{style.label}</span>
              </div>
            ))}
            <span className="text-[0.7rem] text-muted-foreground">
              {rangeLabel}
            </span>
          </>
        </div>
      ) : null}

      {loading && activities.length === 0 ? (
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground" style={{ height: compact ? 52 : 180 }}>
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading activity...</span>
        </div>
      ) : error ? (
        <div className="flex items-center justify-center rounded-md border border-danger/30 bg-danger/10 text-sm text-danger" style={{ height: compact ? 52 : 180 }}>
          {error}
        </div>
      ) : !hasActivity ? (
        <div className="flex items-center justify-center rounded-md border border-dashed border-border bg-surface-secondary/35 text-sm text-muted-foreground" style={{ height: compact ? 52 : 180 }}>
          No activity in the selected range.
        </div>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${chartWidth} ${chartHeight}`}
            className="w-full"
            style={{ maxHeight: chartHeight }}
            role="img"
            aria-label={`Arm activity from ${rangeLabel}`}
            onMouseLeave={() => setHovered(null)}
            onMouseMove={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const pointerX = (event.clientX - rect.left) / rect.width * chartWidth;
              const offset = pointerX - CHART_LEFT_PAD;
              const index = Math.floor(offset / barSlotWidth);
              setHovered(Math.max(0, Math.min(buckets.length - 1, index)));
            }}
          >
            {!compact && [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
              const y = plotBottom - fraction * plotHeight;
              return (
              <line
                key={`grid-${fraction}`}
                x1={CHART_LEFT_PAD}
                x2={chartWidth - CHART_RIGHT_PAD}
                  y1={y}
                  y2={y}
                  stroke={gridColor}
                  strokeWidth={1}
                />
              );
            })}
            {!compact && <text x={4} y={plotTop + 10} fill={labelColor} fontSize={10}>
              {maxStack}
            </text>}
            {!compact && <text x={6} y={plotBottom - 2} fill={labelColor} fontSize={10}>
              0
            </text>}
            {renderBars()}
            {!compact && timeLabels.map(({ index, label }) => {
              const x = CHART_LEFT_PAD + index * barSlotWidth + barWidth / 2;
              return (
                <text
                  key={`axis-${index}`}
                  x={x}
                  y={chartHeight - legendHeight - 8}
                  fill={labelColor}
                  fontSize={10}
                  textAnchor="middle"
                >
                  {label}
                </text>
              );
            })}
            {!compact && hovered !== null && (
              <line
                x1={CHART_LEFT_PAD + hovered * barSlotWidth + barWidth / 2}
                x2={CHART_LEFT_PAD + hovered * barSlotWidth + barWidth / 2}
                y1={plotTop}
                y2={plotBottom}
                stroke="#9ca3af"
                strokeDasharray="3 3"
              />
            )}
          </svg>
          {!compact && selectedBucket ? (
              <div
                className="pointer-events-none absolute right-2 top-2 z-10 rounded-md border border-border bg-background/95 px-3 py-2 text-xs shadow"
                style={{ width: compact ? 160 : HOVER_TOOLTIP_WIDTH }}
              >
              <div className="font-semibold">
                {new Date(selectedBucket.startMs).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </div>
              <div className="mt-1 grid grid-cols-2 gap-1">
                {CATEGORY_STYLES.map((style) => (
                  <div key={style.key} className="flex items-center gap-1">
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ backgroundColor: style.color }}
                    />
                    <span className="text-muted-foreground">{selectedBucket.counts[style.key]}</span>
                    <span className="truncate text-muted-foreground">{style.label}</span>
                  </div>
                ))}
              </div>
              <div className="mt-1 text-[0.7rem] text-muted-foreground">
                {selectedBucket.counts.write +
                  selectedBucket.counts.think +
                  selectedBucket.counts.tool +
                  selectedBucket.counts.complete}{' '}
                events this minute
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );

  if (embedded) {
    return <div className={className}>{inner}</div>;
  }
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          <span>{title}</span>
          <span className="text-xs font-normal text-muted-foreground">
            File writes, thinking, tool calls, completed tasks
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>{inner}</CardContent>
    </Card>
  );
}

function toMinuteBuckets(response: ArmActivityMetricsResponse): MinuteBucket[] {
  const bucketMs = response.window.bucketMs;
  return response.buckets.map((bucket, index) => {
    const startMs = new Date(bucket.start).getTime();
    return {
      index,
      startMs,
      endMs: startMs + bucketMs,
      counts: bucket.counts,
      items: [],
    };
  });
}

export type { ViewerActivityItem, ViewerActivityType };
