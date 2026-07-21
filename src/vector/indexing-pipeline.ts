/**
 * Status History Indexing Pipeline
 * 
 * Consumes status events from NATS JetStream and indexes them in Qdrant
 * for semantic search capabilities.
 */

import { embeddingService } from "../embedding";
import { qdrantStore } from "../qdrant";
import { eventStore, type EventData } from "../nats/jetstream";
import type { ConsumedStatusEvent } from "../nats/status-history-consumer";
import {
  type StatusHistoryEvent,
  type StatusHistoryEventType,
  STATUS_HISTORY_CONFIG,
  eventToText,
  createEventId,
} from "./status-history";

/**
 * Initialize the status history collection in Qdrant
 */
export async function initializeStatusHistoryCollection(): Promise<void> {
  await qdrantStore.createCollection(
    STATUS_HISTORY_CONFIG.collectionName,
    embeddingService.getVectorSize(),
    STATUS_HISTORY_CONFIG.distance,
  );
  await Promise.all(
    STATUS_HISTORY_CONFIG.filterFields.map((field) =>
      qdrantStore.createPayloadIndex(
        STATUS_HISTORY_CONFIG.collectionName,
        field,
        field === "timestamp" ? "datetime" : "keyword",
      ),
    ),
  );
  console.log("[StatusHistory] Collection initialized");
}

/**
 * Index a status history event in Qdrant
 */
export async function indexStatusHistoryEvent(
  event: StatusHistoryEvent,
): Promise<void> {
  // Generate embedding for the event
  const text = eventToText(event);
  const embedding = await embeddingService.embed(text);
  
  // Upsert into Qdrant
  await qdrantStore.upsertPoints(STATUS_HISTORY_CONFIG.collectionName, [
    {
      id: event.id,
      vector: embedding.embedding,
      payload: buildStatusHistoryPayload(event),
    },
  ]);
  
  console.log(`[StatusHistory] Indexed event: ${event.id}`);
}

/**
 * Search status history events
 */
export async function searchStatusHistory(
  query: string,
  options: {
    limit?: number;
    type?: StatusHistoryEventType;
    source?: string;
    taskId?: string;
    bugId?: string;
    armId?: string;
    classification?: string;
    since?: Date;
    until?: Date;
  } = {},
): Promise<Array<{
  id: string;
  score: number;
  event: StatusHistoryEvent;
}>> {
  // Generate query embedding
  const embedding = await embeddingService.embed(query);
  
  // Build filter
  const filter: Record<string, unknown> = {};
  const must: unknown[] = [];
  
  if (options.type) {
    must.push({ key: "type", match: { value: options.type } });
  }
  if (options.source) {
    must.push({ key: "source", match: { value: options.source } });
  }
  if (options.taskId) {
    must.push({ key: "taskId", match: { value: options.taskId } });
  }
  if (options.bugId) {
    must.push({ key: "bugId", match: { value: options.bugId } });
  }
  if (options.armId) {
    must.push({ key: "armId", match: { value: options.armId } });
  }
  if (options.classification) {
    must.push({ key: "classification", match: { value: options.classification } });
  }
  if (options.since || options.until) {
    const range: Record<string, string> = {};
    if (options.since) range.gte = options.since.toISOString();
    if (options.until) range.lte = options.until.toISOString();
    must.push({ key: "timestamp", range });
  }
  
  if (must.length > 0) {
    filter.must = must;
  }
  
  // Search Qdrant
  const results = await qdrantStore.search(
    STATUS_HISTORY_CONFIG.collectionName,
    embedding.embedding,
    {
      limit: options.limit || 10,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
      with_payload: true,
    },
  );
  
  return results.map((r) => ({
    id: r.id,
    score: r.score,
    event: buildStatusHistoryEvent(r.id, r.payload),
  }));
}

function buildStatusHistoryPayload(event: StatusHistoryEvent): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: event.type,
    timestamp: event.timestamp,
    source: event.source,
    title: event.title,
    content: event.content,
    taskId: event.taskId,
    bugId: event.bugId,
    discoveryId: event.discoveryId,
    armId: event.armId,
    status: event.status,
    priority: event.priority,
    classification: event.classification,
    metadata: event.metadata,
    event,
  };

  return payload;
}

function buildStatusHistoryEvent(
  fallbackId: string,
  payload: Record<string, unknown>,
): StatusHistoryEvent {
  const embedded = payload.event;
  if (isStatusHistoryEvent(embedded)) {
    return {
      ...embedded,
      id: embedded.id || fallbackId,
      metadata: embedded.metadata || {},
    };
  }

  return {
    id: fallbackId,
    type: parseStatusHistoryType(payload.type),
    timestamp: payload.timestamp as string,
    source: payload.source as string,
    title: payload.title as string,
    content: payload.content as string,
    taskId: payload.taskId as string | undefined,
    bugId: payload.bugId as string | undefined,
    discoveryId: payload.discoveryId as string | undefined,
    armId: payload.armId as string | undefined,
    status: payload.status as StatusHistoryEvent["status"],
    priority: payload.priority as StatusHistoryEvent["priority"],
    classification: payload.classification as string | undefined,
    metadata: sanitizeMetadata(payload.metadata),
  };
}

function isStatusHistoryEvent(value: unknown): value is StatusHistoryEvent {
  if (!value || typeof value !== "object") {
    return false;
  }

  const typed = value as Record<string, unknown>;
  const type = parseStatusHistoryType(typed.type);
  return (
    typeof typed.timestamp === "string" &&
    typeof typed.source === "string" &&
    typeof typed.title === "string" &&
    typeof typed.content === "string" &&
    typeof type !== "undefined"
  );
}

function parseStatusHistoryType(value: unknown): StatusHistoryEventType {
  if (
    typeof value === "string" &&
    [
      "status_report",
      "task_completion",
      "discovery",
      "bug_report",
      "task_created",
      "task_updated",
      "arm_event",
    ].includes(value)
  ) {
    return value as StatusHistoryEventType;
  }
  return "status_report";
}

function sanitizeMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Process an event from NATS JetStream and index it
 */
export async function processStatusEvent(eventData: EventData): Promise<void> {
  // Map event types to status history event types
  const typeMap: Record<string, StatusHistoryEventType> = {
    "status.report": "status_report",
    "status_report.submitted": "status_report",
    "task.status_reported": "status_report",
    "task.completed": "task_completion",
    "discovery.created": "discovery",
    "task.discovery_reported": "discovery",
    "bug.reported": "bug_report",
    "bug_report": "bug_report",
    "report_bug": "bug_report",
    "task.created": "task_created",
    "task.updated": "task_updated",
    "arm.event": "arm_event",
  };
  
  const type = typeMap[eventData.type];
  if (!type) {
    // Not a status history event type
    return;
  }
  
  const sourceId = (eventData.armId || (eventData.data.id as string) || "unknown");
  const identifiers = resolveStatusHistoryEventIdentifiers(eventData.data, type);
  const event: StatusHistoryEvent = {
    id: createEventId(type, sourceId, eventData.timestamp),
    type,
    timestamp: eventData.timestamp,
    source: eventData.armId || "system",
    title: String(eventData.data.subject || eventData.data.title || eventData.type),
    content: String(eventData.data.summary || eventData.data.description || eventData.data.content || ""),
    taskId: identifiers.taskId,
    bugId: identifiers.bugId,
    discoveryId: identifiers.discoveryId,
    armId: eventData.armId,
    status: eventData.data.status as StatusHistoryEvent["status"],
    priority: eventData.data.priority as StatusHistoryEvent["priority"],
    classification: classificationFrom(eventData.data),
    metadata: eventData.data,
  };
  
  await indexStatusHistoryEvent(event);
}

/** Index a normalized JetStream event while preserving delivery metadata. */
export async function processConsumedStatusHistoryEvent(
  consumed: ConsumedStatusEvent,
): Promise<void> {
  const { event: eventData } = consumed;
  const sourceId = eventData.armId || stringValue(eventData.data.id) || "unknown";
  const identifiers = resolveStatusHistoryEventIdentifiers(eventData.data, consumed.type);
  const event: StatusHistoryEvent = {
    id: createEventId(consumed.type, sourceId, eventData.timestamp),
    type: consumed.type,
    timestamp: eventData.timestamp,
    source: eventData.armId || "system",
    title: String(eventData.data.subject || eventData.data.title || eventData.type),
    content: String(eventData.data.summary || eventData.data.description || eventData.data.content || ""),
    taskId: identifiers.taskId,
    bugId: identifiers.bugId,
    discoveryId: identifiers.discoveryId,
    armId: eventData.armId,
    status: eventData.data.status as StatusHistoryEvent["status"],
    priority: eventData.data.priority as StatusHistoryEvent["priority"],
    classification: consumed.classification,
    metadata: {
      ...eventData.data,
      originalEvent: eventData,
      rawPayload: consumed.rawPayload,
      stream: consumed.metadata,
    },
  };

  await indexStatusHistoryEvent(event);
}

export function resolveStatusHistoryEventIdentifiers(
  data: Record<string, unknown>,
  type: StatusHistoryEventType,
): {
  taskId?: string;
  bugId?: string;
  discoveryId?: string;
} {
  return {
    taskId:
      stringValue(data.taskId)
      || stringValue(data.task_id)
      || stringValue(data.sourceTaskId)
      || stringValue(data.source_task_id),
    bugId:
      stringValue(data.bugId)
      || stringValue(data.bug_id)
      || (type === "bug_report" ? stringValue(data.id) : undefined),
    discoveryId: stringValue(data.discoveryId) || stringValue(data.discovery_id),
  };
}

function classificationFrom(data: Record<string, unknown>): string | undefined {
  return (
    stringValue(data.classification) ||
    (data.task && typeof data.task === "object"
      ? stringValue((data.task as Record<string, unknown>).classification)
      : undefined)
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Start the status history indexing pipeline
 * Polls NATS JetStream events and indexes them
 */
export async function startStatusHistoryPipeline(
  pollIntervalMs = 5000
): Promise<() => void> {
  // Initialize collection
  await initializeStatusHistoryCollection();
  
  let lastPollTime = new Date();
  let running = true;
  
  const poll = async () => {
    while (running) {
      try {
        // Query for new events since last poll
        const events = await eventStore.queryEvents({
          subjects: ["coleo.events.>"],
          since: lastPollTime,
          limit: 100,
        });
        
        for (const event of events) {
          await processStatusEvent(event);
        }
        
        lastPollTime = new Date();
      } catch (err) {
        console.error("[StatusHistory] Failed to poll events:", err);
      }
      
      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  };
  
  // Start polling in background
  poll();
  
  console.log("[StatusHistory] Pipeline started");
  
  // Return stop function
  return () => {
    running = false;
    console.log("[StatusHistory] Pipeline stopped");
  };
}

/**
 * Get health status of the status history system
 */
export async function getStatusHistoryHealth(): Promise<{
  healthy: boolean;
  collectionExists: boolean;
  pointsCount: number;
}> {
  try {
    const info = await qdrantStore.getCollectionInfo(STATUS_HISTORY_CONFIG.collectionName);
    return {
      healthy: true,
      collectionExists: true,
      pointsCount: info.points_count,
    };
  } catch (err) {
    return {
      healthy: false,
      collectionExists: false,
      pointsCount: 0,
    };
  }
}
