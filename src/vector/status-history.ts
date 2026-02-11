/**
 * Status History Event Schema
 * 
 * Defines the structure for status history events stored in Qdrant
 * for semantic search of arm status reports, task completions, discoveries, and bugs.
 */

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
  priority?: "critical" | "high" | "normal" | "low";
  
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
  collectionName: "status-history",
  
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
  ],
};

/**
 * Convert a status history event to searchable text
 */
export function eventToText(event: StatusHistoryEvent): string {
  const parts = [
    event.title,
    event.content,
    event.type,
    event.source,
  ];
  
  if (event.status) parts.push(`Status: ${event.status}`);
  if (event.priority) parts.push(`Priority: ${event.priority}`);
  
  return parts.filter(Boolean).join("\n\n");
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
