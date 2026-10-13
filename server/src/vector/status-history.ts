/**
 * Status History Event Schema
 * 
 * Defines the structure for status history events stored in Qdrant
 * for semantic search of arm status reports, task completions, discoveries, and bugs.
 */

import { getProjectCollectionName } from "../project-scope";

/**
 * Types of status history events
 */
export type StatusHistoryEventType = 
  | "status_report"
  | "task_completion" 
  | "discovery"
  | "bug_report"
  | "task_created"
  | "task_updated"
  | "arm_event";

/**
 * Status history event for vector storage
 */
export interface StatusHistoryEvent {
  /** Unique event ID */
  id: string;
  
  /** Event type */
  type: StatusHistoryEventType;
  
  /** Event timestamp */
  timestamp: string;
  
  /** Source (arm_id, 'brain', 'system') */
  source: string;

  /** Canonical project directory partition. */
  projectDir?: string;

  /** Non-sensitive hash of the canonical project directory. */
  projectKey?: string;
  
  /** Event title/subject */
  title: string;
  
  /** Event content/description */
  content: string;
  
  /** Related task ID (if applicable) */
  taskId?: string;
  
  /** Related bug ID (if applicable) */
  bugId?: string;
  
  /** Related discovery ID (if applicable) */
  discoveryId?: string;
  
  /** Arm ID (if applicable) */
  armId?: string;
  
  /** Status (for status reports) */
  status?: "on_track" | "blocked" | "issues_found" | "needs_review" | "completed_with_issues";
  
  /** Priority (for tasks/bugs) */
  priority?: "critical" | "high" | "medium" | "low" | "normal";

  /** Task or event classification (for example, development or bug_fix). */
  classification?: string;
  
  /** Additional metadata */
  metadata: Record<string, unknown>;
  
  /** Vector embedding (1536 dimensions for OpenAI) */
  vector?: number[];
}

/**
 * Configuration for status history collection
 */
export const STATUS_HISTORY_CONFIG = {
  /** Collection name in Qdrant */
  collectionName: getProjectCollectionName("status-history"),
  
  /** Vector size (1536 for OpenAI embeddings) */
  vectorSize: 1536,
  
  /** Distance metric */
  distance: "Cosine" as const,
  
  /** Payload fields for filtering */
  filterFields: [
    "type",
    "source", 
    "taskId",
    "bugId",
    "discoveryId",
    "armId",
    "status",
    "priority",
    "timestamp",
    "classification",
    "projectDir",
    "projectKey",
  ],
};

/**
 * Retention policy for status-history points in Qdrant (days).
 * `null` means keep forever.
 *
 * Matches plan:
 * - Task completions / critical: forever
 * - Status reports: 90 days
 * - Routine heartbeats (arm_event): 7 days
 */
export const STATUS_HISTORY_RETENTION_DAYS: Record<StatusHistoryEventType, number | null> = {
  task_completion: null,
  task_created: null,
  task_updated: 90,
  status_report: 90,
  discovery: null,
  bug_report: null,
  arm_event: 7,
};

/** Override via env, e.g. COLEO_STATUS_HISTORY_RETENTION_STATUS_REPORT=60 */
export function getRetentionDaysForType(type: StatusHistoryEventType): number | null {
  const envKey = `COLEO_STATUS_HISTORY_RETENTION_${type.toUpperCase()}`;
  const raw = process.env[envKey];
  if (raw === "forever" || raw === "null" || raw === "-1") return null;
  if (raw !== undefined && raw !== "") {
    const n = Number.parseInt(raw, 10);
    if (!Number.isNaN(n) && n >= 0) return n;
  }
  return STATUS_HISTORY_RETENTION_DAYS[type];
}

/**
 * Convert a status history event to searchable text
 */
export function eventToText(event: StatusHistoryEvent): string {
  const { vector: _vector, ...eventData } = event;
  return [
    event.title,
    event.content,
    event.status ? `Status: ${event.status}` : undefined,
    event.priority ? `Priority: ${event.priority}` : undefined,
    `Complete event: ${stableStringify(eventData)}`,
  ].filter(Boolean).join("\n\n");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJsonValue(nested)]),
  );
}

/**
 * Create a unique event ID
 */
export function createEventId(
  type: StatusHistoryEventType,
  sourceId: string,
  timestamp: string | Date,
): string {
  const ts = typeof timestamp === "string" ? timestamp : timestamp.toISOString();
  return `${type}-${sourceId}-${ts}`;
}
