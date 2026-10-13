import type { JsonObject } from "@/lib";
import type { ViewerActivityItem } from "@/pages/arm-viewer-activity";

/**
 * Activity classification helpers for the Arm Activity & Efficiency chart.
 *
 * Maps an arm viewer's ActivityItem into the four display categories the
 * chart renders: blue file writes, yellow thinking/reasoning, green tool
 * calls, and prominent purple completed tasks.
 */

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
