import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api } from '@/lib';
import type { JsonObject } from '@/lib';
import {
  type ViewerActivityItem,
  type ViewerActivityType,
} from '@/pages/arm-viewer-activity';
import { Card, CardContent, CardHeader, CardTitle } from '@/components';

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
const LEGEND_ROW_HEIGHT = 18;
const HOVER_TOOLTIP_WIDTH = 200;

export type ActivityCategory = 'write' | 'think' | 'tool' | 'complete';

export interface CategoryStyle {
  key: ActivityCategory;
  label: string;
  color: string;
}

export const CATEGORY_STYLES: CategoryStyle[] = [
  { key: 'write', label: 'File writes', color: '#3b82f6' },
  { key: 'think', label: 'Thinking / reasoning', color: '#eab308' },
  { key: 'tool', label: 'Tool calls', color: '#22c55e' },
  { key: 'complete', label: 'Completed tasks', color: '#a855f7' },
];

export function classifyActivity(activity: ViewerActivityItem): ActivityCategory {
  if (activity.type === 'file') {
    return 'write';
  }

  if (activity.type === 'message') {
    const details = activity.details as JsonObject | undefined;
    const role = typeof details?.role === 'string' ? details.role : undefined;
    if (activity.title.toLowerCase().includes('assistant') || role === 'assistant') {
      return 'think';
    }
    return 'think';
  }

  if (activity.type === 'tool') {
    return 'tool';
  }

  if (
    activity.status === 'completed' &&
    (activity.type === 'step' ||
      activity.type === 'todo' ||
      activity.type === 'session' ||
      activity.type === 'terminal')
  ) {
    return 'complete';
  }

  if (activity.type === 'step') {
    return 'complete';
  }

  if (activity.type === 'session' && activity.status === 'running') {
    return 'think';
  }

  return 'tool';
}

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
  windowMs?: number;
  limit?: number;
  title?: string;
  className?: string;
  /** When set, auto-refresh every N ms (defaults to 60s). Set to 0 to disable. */
  refreshMs?: number;
  /** If true, render without the surrounding Card shell (for embedded use). */
  embedded?: boolean;
}

export function ArmActivityChart({
  armId,
  activities: externalActivities,
  windowMs = WINDOW_MINUTES * MINUTE_MS,
  limit = 1000,
  title = 'Arm Activity',
  className,
  refreshMs = 60_000,
  embedded = false,
}: ArmActivityChartProps) {
  const [activities, setActivities] = useState<ViewerActivityItem[]>(
    externalActivities ?? [],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (externalActivities !== undefined) {
      setActivities(externalActivities);
      return;
    }
    if (!armId) {
      setActivities([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .getArmEventWindow(armId, { windowMs, limit })
      .then((response) => {
        if (cancelled) return;
        const items: ViewerActivityItem[] = [];
        for (const event of response.window.events) {
          const ts = new Date(event.timestamp).getTime();
          if (!Number.isFinite(ts)) continue;
          const type = mapEventTypeToActivityType(event.type);
          items.push({
            id: `event-${event.sequence ?? event.type}-${ts}-${items.length}`,
            type,
            title: event.type,
            timestamp: ts,
            status: 'completed',
            details: event.data,
          });
        }
        setActivities(items);
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
  }, [armId, externalActivities, windowMs, limit, tick]);

  useEffect(() => {
    if (!refreshMs || refreshMs <= 0) return;
    const interval = setInterval(() => setTick((t) => t + 1), refreshMs);
    return () => clearInterval(interval);
  }, [refreshMs]);

  const buckets = buildBuckets(activities, Date.now());

  const maxStack = useMemo(() => {
    let peak = 0;
    for (const bucket of buckets) {
      const total = bucket.counts.write + bucket.counts.think + bucket.counts.tool + bucket.counts.complete;
      if (total > peak) peak = total;
    }
    return peak;
  }, [buckets]);

  const chartWidth = WINDOW_MINUTES * (BAR_MAX_WIDTH_PX + BAR_GAP_PX) + CHART_LEFT_PAD + CHART_RIGHT_PAD;
  const chartHeight = CHART_HEIGHT_PX + CHART_TOP_PAD + CHART_BOTTOM_PAD + LEGEND_ROW_HEIGHT;
  const labelColor = '#6b7280';
  const gridColor = '#e5e7eb';

  const barAreaWidth = chartWidth - CHART_LEFT_PAD - CHART_RIGHT_PAD;
  const barSlotWidth = barAreaWidth / WINDOW_MINUTES;
  const barWidth = Math.max(4, barSlotWidth - BAR_GAP_PX);

  const plotTop = CHART_TOP_PAD;
  const plotBottom = chartHeight - CHART_BOTTOM_PAD - LEGEND_ROW_HEIGHT;
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
    const sampleCount = Math.min(6, WINDOW_MINUTES);
    const step = Math.max(1, Math.floor(WINDOW_MINUTES / sampleCount));
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

  const selectedBucket = hovered === null ? null : buckets[hovered] ?? null;

  const inner = (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-3">
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
          Last {WINDOW_MINUTES} min
        </span>
      </div>

      {loading && activities.length === 0 ? (
        <div className="flex h-[180px] items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading activity...</span>
        </div>
      ) : error ? (
        <div className="flex h-[180px] items-center justify-center rounded-md border border-danger/30 bg-danger/10 text-sm text-danger">
          {error}
        </div>
      ) : activities.length === 0 ? (
        <div className="flex h-[180px] items-center justify-center rounded-md border border-dashed border-border bg-surface-secondary/35 text-sm text-muted-foreground">
          No activity in the last {WINDOW_MINUTES} minutes.
        </div>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${chartWidth} ${chartHeight}`}
            className="w-full"
            style={{ maxHeight: chartHeight }}
            role="img"
            aria-label="Per-minute arm activity for the last 30 minutes"
            onMouseLeave={() => setHovered(null)}
            onMouseMove={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const pointerX = (event.clientX - rect.left) / rect.width * chartWidth;
              const offset = pointerX - CHART_LEFT_PAD;
              const index = Math.floor(offset / barSlotWidth);
              setHovered(Math.max(0, Math.min(buckets.length - 1, index)));
            }}
          >
            {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
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
            <text x={4} y={plotTop + 10} fill={labelColor} fontSize={10}>
              {maxStack}
            </text>
            <text x={6} y={plotBottom - 2} fill={labelColor} fontSize={10}>
              0
            </text>
            {renderBars()}
            {timeLabels.map(({ index, label }) => {
              const x = CHART_LEFT_PAD + index * barSlotWidth + barWidth / 2;
              return (
                <text
                  key={`axis-${index}`}
                  x={x}
                  y={chartHeight - LEGEND_ROW_HEIGHT - 8}
                  fill={labelColor}
                  fontSize={10}
                  textAnchor="middle"
                >
                  {label}
                </text>
              );
            })}
            {hovered !== null && (
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
          {selectedBucket ? (
            <div
              className="pointer-events-none absolute right-2 top-2 z-10 rounded-md border border-border bg-background/95 px-3 py-2 text-xs shadow"
              style={{ width: HOVER_TOOLTIP_WIDTH }}
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

function mapEventTypeToActivityType(eventType: string): ViewerActivityType {
  if (eventType === 'message.updated' || eventType === 'message.part.updated' || eventType === 'message.part.created') {
    return 'message';
  }
  if (eventType === 'file.edited') {
    return 'file';
  }
  if (eventType === 'session.status' || eventType === 'session.error') {
    return 'session';
  }
  if (eventType === 'todo.updated') {
    return 'todo';
  }
  if (eventType === 'pty.created' || eventType === 'pty.updated' || eventType === 'pty.exited') {
    return 'terminal';
  }
  if (eventType === 'vcs.branch.updated') {
    return 'branch';
  }
  if (eventType === 'error') {
    return 'error';
  }
  return 'tool';
}

export type { ViewerActivityItem, ViewerActivityType };
