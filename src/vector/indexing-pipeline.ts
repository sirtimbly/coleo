/**
 * Status History Indexing Pipeline
 * 
 * Consumes status events from NATS JetStream and indexes them in Qdrant
 * for semantic search capabilities.
 */

import { embeddingService } from "../embedding";
import { qdrantStore } from "../qdrant";
import { eventStore, type EventData } from "../nats/jetstream";
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
    STATUS_HISTORY_CONFIG.vectorSize,
    STATUS_HISTORY_CONFIG.distance,
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
      payload: {
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
        metadata: event.metadata,
      },
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
    event: {
      id: r.id,
      type: r.payload.type as StatusHistoryEventType,
      timestamp: r.payload.timestamp as string,
      source: r.payload.source as string,
      title: r.payload.title as string,
      content: r.payload.content as string,
      taskId: r.payload.taskId as string | undefined,
      bugId: r.payload.bugId as string | undefined,
      discoveryId: r.payload.discoveryId as string | undefined,
      armId: r.payload.armId as string | undefined,
      status: r.payload.status as StatusHistoryEvent["status"],
      priority: r.payload.priority as StatusHistoryEvent["priority"],
      metadata: (r.payload.metadata as Record<string, unknown>) || {},
    },
  }));
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
  const event: StatusHistoryEvent = {
    id: createEventId(type, sourceId, eventData.timestamp),
    type,
    timestamp: eventData.timestamp,
    source: eventData.armId || "system",
    title: String(eventData.data.subject || eventData.data.title || eventData.type),
    content: String(eventData.data.summary || eventData.data.description || eventData.data.content || ""),
    taskId: eventData.data.taskId as string | undefined,
    bugId: eventData.data.bugId as string | undefined,
    discoveryId: eventData.data.discoveryId as string | undefined,
    armId: eventData.armId,
    status: eventData.data.status as StatusHistoryEvent["status"],
    priority: eventData.data.priority as StatusHistoryEvent["priority"],
    metadata: eventData.data,
  };
  
  await indexStatusHistoryEvent(event);
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
