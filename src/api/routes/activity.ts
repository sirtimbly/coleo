/**
 * Activity log routes
 *
 * Activity is now stored in JetStream, not SQLite.
 * This provides event sourcing with the stream as the single source of truth.
 */
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { basename } from "path";
import { eventStore, type EventData } from "../../nats/jetstream";
import { getNatsManager } from "../../nats/server";

interface ActivityContext {
  Variables: {
    db: Database;
  };
}

export interface ActivityEntry {
  timestamp: string;
  actor: string;
  action: string;
  target: string | null;
  details: Record<string, unknown>;
}

interface ArmMetadata {
  id: string;
  host: string | null;
  workdir: string | null;
  project: string | null;
}

interface TranscriptEntry {
  timestamp: string;
  armId: string;
  action: string;
  text: string;
  details: Record<string, unknown>;
  partitions: {
    armId: string;
    host: string | null;
    project: string | null;
    workdir: string | null;
  };
}

function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = parseInt(raw || String(fallback), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function parseDateQuery(raw: string | undefined): { value?: Date; error?: string } {
  if (!raw) {
    return {};
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return { error: `Invalid date: ${raw}` };
  }

  return { value: parsed };
}

function parseOptionalPositiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (!raw) {
    return fallback;
  }

  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function parseIdList(...rawValues: Array<string | undefined>): string[] {
  const values: string[] = [];
  for (const raw of rawValues) {
    if (!raw) {
      continue;
    }

    for (const token of raw.split(",")) {
      const id = token.trim();
      if (id.length > 0) {
        values.push(id);
      }
    }
  }

  return Array.from(new Set(values));
}

function parseWorkdir(configText: string | null): string | null {
  if (!configText) {
    return null;
  }

  try {
    const parsed = JSON.parse(configText) as Record<string, unknown>;
    const workdir = parsed.workdir;
    return typeof workdir === "string" && workdir.trim().length > 0 ? workdir : null;
  } catch {
    return null;
  }
}

function deriveProject(workdir: string | null): string | null {
  if (!workdir) {
    return null;
  }

  const normalized = workdir.replace(/\\/g, "/").replace(/\/+$/, "");
  const project = basename(normalized);
  return project.length > 0 ? project : null;
}

function matchesProjectFilter(projectFilter: string, metadata: ArmMetadata | undefined): boolean {
  if (!metadata) {
    return false;
  }

  const filter = projectFilter.toLowerCase();
  const project = metadata.project?.toLowerCase();
  const workdir = metadata.workdir?.toLowerCase();

  if (project === filter) {
    return true;
  }

  if (!workdir) {
    return false;
  }

  if (workdir === filter) {
    return true;
  }

  return workdir.includes(`/${filter}/`);
}

function serializeValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const values = value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0);
    return values.length > 0 ? values.join(" ") : null;
  }
  return null;
}

function buildTranscriptText(eventType: string, details: Record<string, unknown>): string {
  const preferredKeys = [
    "message",
    "prompt",
    "content",
    "text",
    "summary",
    "error",
    "reason",
    "title",
  ];

  const textParts: string[] = [];
  for (const key of preferredKeys) {
    const value = serializeValue(details[key]);
    if (value) {
      textParts.push(value);
    }
  }

  let body = textParts.join(" ").trim();
  if (!body) {
    body = JSON.stringify(details);
  }

  const combined = `${eventType} ${body}`.trim();
  return combined.length > 4000 ? `${combined.slice(0, 4000)}...` : combined;
}

function sortEventsOldestFirst(a: { event: EventData }, b: { event: EventData }): number {
  const aTime = new Date(a.event.timestamp).getTime();
  const bTime = new Date(b.event.timestamp).getTime();

  if (aTime !== bTime) {
    return aTime - bTime;
  }

  return a.event.type.localeCompare(b.event.type);
}

function toIsoTimestamp(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return null;
}

export function createActivityRoutes() {
  const app = new Hono<ActivityContext>();

  /**
   * Transcript view of arm events ordered oldest-first.
   * GET /api/activity/transcript?armId=A,B&host=devbox&project=coleo&since=...
   */
  app.get("/transcript", async (c) => {
    const db = c.get("db");
    const limit = parseLimit(c.req.query("limit"), 200, 1000);
    const scanLimit = parseLimit(c.req.query("scanLimit"), Math.max(limit * 5, 500), 5000);
    const hostFilter = c.req.query("host")?.trim() || null;
    const projectFilter = c.req.query("project")?.trim() || null;
    const requestedArmIds = parseIdList(c.req.query("armId"), c.req.query("armIds"));

    const sinceQuery = parseDateQuery(c.req.query("since"));
    if (sinceQuery.error) {
      return c.json({ error: sinceQuery.error }, 400);
    }

    const untilQuery = parseDateQuery(c.req.query("until"));
    if (untilQuery.error) {
      return c.json({ error: untilQuery.error }, 400);
    }

    if (!eventStore.isInitialized()) {
      return c.json({
        transcript: [],
        pagination: { limit, returned: 0, hasMore: false, order: "asc" },
        filters: {
          armIds: requestedArmIds,
          host: hostFilter,
          project: projectFilter,
          since: sinceQuery.value?.toISOString() || null,
          until: untilQuery.value?.toISOString() || null,
        },
        message: "JetStream not available - start the API server with NATS",
      });
    }

    try {
      const armRows = db.query(
        "SELECT id, host, config FROM arms",
      ).all() as Array<{ id: string; host: string | null; config: string | null }>;

      const armMetadata = new Map<string, ArmMetadata>();
      for (const row of armRows) {
        const workdir = parseWorkdir(row.config);
        armMetadata.set(row.id, {
          id: row.id,
          host: row.host,
          workdir,
          project: deriveProject(workdir),
        });
      }

      let effectiveArmIds: string[] | null = requestedArmIds.length > 0 ? requestedArmIds : null;
      if (hostFilter || projectFilter) {
        const matchingPartitionArms = armRows
          .map((row) => row.id)
          .filter((armId) => {
            const metadata = armMetadata.get(armId);
            if (hostFilter) {
              if ((metadata?.host || "").toLowerCase() !== hostFilter.toLowerCase()) {
                return false;
              }
            }
            if (projectFilter) {
              if (!matchesProjectFilter(projectFilter, metadata)) {
                return false;
              }
            }
            return true;
          });

        if (effectiveArmIds) {
          const partitionSet = new Set(matchingPartitionArms);
          effectiveArmIds = effectiveArmIds.filter((armId) => partitionSet.has(armId));
        } else {
          effectiveArmIds = matchingPartitionArms;
        }
      }

      if (effectiveArmIds && effectiveArmIds.length === 0) {
        return c.json({
          transcript: [],
          pagination: { limit, returned: 0, hasMore: false, order: "asc" },
          filters: {
            armIds: requestedArmIds,
            host: hostFilter,
            project: projectFilter,
            since: sinceQuery.value?.toISOString() || null,
            until: untilQuery.value?.toISOString() || null,
          },
        });
      }

      let scopedEvents: Array<{ armId: string; event: EventData }> = [];
      if (effectiveArmIds && effectiveArmIds.length > 0) {
        const perArmResults = await Promise.all(
          effectiveArmIds.map(async (armId) => {
            const events = await eventStore.queryEvents({
              subject: `coleo.events.arm.${armId}.>`,
              since: sinceQuery.value,
              until: untilQuery.value,
              limit: scanLimit,
            });
            return events.map((event) => ({
              armId: event.armId || armId,
              event,
            }));
          }),
        );
        scopedEvents = perArmResults.flat();
      } else {
        const events = await eventStore.queryEvents({
          subject: "coleo.events.arm.>",
          since: sinceQuery.value,
          until: untilQuery.value,
          limit: scanLimit,
        });
        scopedEvents = events
          .filter((event) => typeof event.armId === "string" && event.armId.length > 0)
          .map((event) => ({
            armId: event.armId as string,
            event,
          }));
      }

      scopedEvents.sort(sortEventsOldestFirst);
      const sliced = scopedEvents.slice(0, limit);

      const transcript: TranscriptEntry[] = sliced.map(({ armId, event }) => {
        const details = event.data || {};
        const metadata = armMetadata.get(armId);
        return {
          timestamp: event.timestamp,
          armId,
          action: event.type,
          text: buildTranscriptText(event.type, details),
          details,
          partitions: {
            armId,
            host: metadata?.host || null,
            project: metadata?.project || null,
            workdir: metadata?.workdir || null,
          },
        };
      });

      return c.json({
        transcript,
        pagination: {
          limit,
          returned: transcript.length,
          hasMore: scopedEvents.length > transcript.length,
          order: "asc",
          scannedEvents: scopedEvents.length,
        },
        filters: {
          armIds: requestedArmIds,
          host: hostFilter,
          project: projectFilter,
          since: sinceQuery.value?.toISOString() || null,
          until: untilQuery.value?.toISOString() || null,
        },
      });
    } catch (err) {
      console.error("Transcript query error:", err);
      return c.json({ error: "JetStream error" }, 500);
    }
  });

  /**
   * Transcript indexer health from JetStream durable consumer state.
   * GET /api/activity/indexer-health?stream=coleo-events&durable=transcript-indexer-v1
   */
  app.get("/indexer-health", async (c) => {
    const stream = c.req.query("stream")?.trim() || process.env.COLEO_EVENT_STREAM || "coleo-events";
    const durable =
      c.req.query("durable")?.trim() || process.env.COLEO_TRANSCRIPT_INDEX_DURABLE || "transcript-indexer-v1";
    const staleThresholdMs = parseOptionalPositiveInt(
      c.req.query("staleMs"),
      parseOptionalPositiveInt(process.env.COLEO_TRANSCRIPT_INDEXER_STALE_MS, 120000, 86_400_000),
      86_400_000,
    );

    if (!eventStore.isInitialized()) {
      return c.json({
        status: "unavailable",
        stream,
        durable,
        consumerFound: false,
        lagMessages: null,
        ackPending: null,
        streamLastSeq: null,
        consumerStreamSeq: null,
        consumerSeq: null,
        lastActive: null,
        staleThresholdMs,
        updatedAt: new Date().toISOString(),
        message: "JetStream not initialized",
      });
    }

    const natsManager = getNatsManager();
    const connection = natsManager?.getConnection();
    if (!connection) {
      return c.json({
        status: "unavailable",
        stream,
        durable,
        consumerFound: false,
        lagMessages: null,
        ackPending: null,
        streamLastSeq: null,
        consumerStreamSeq: null,
        consumerSeq: null,
        lastActive: null,
        staleThresholdMs,
        updatedAt: new Date().toISOString(),
        message: "NATS connection unavailable",
      });
    }

    try {
      const jsm = await connection.jetstreamManager();

      const streamInfo = await jsm.streams.info(stream).catch(() => null);
      if (!streamInfo) {
        return c.json({
          status: "unavailable",
          stream,
          durable,
          consumerFound: false,
          lagMessages: null,
          ackPending: null,
          streamLastSeq: null,
          consumerStreamSeq: null,
          consumerSeq: null,
          lastActive: null,
          staleThresholdMs,
          updatedAt: new Date().toISOString(),
          message: `Stream not found: ${stream}`,
        });
      }

      const consumerInfo = await jsm.consumers.info(stream, durable).catch(() => null);
      if (!consumerInfo) {
        return c.json({
          status: "unavailable",
          stream,
          durable,
          consumerFound: false,
          lagMessages: null,
          ackPending: null,
          streamLastSeq: streamInfo.state.last_seq,
          consumerStreamSeq: null,
          consumerSeq: null,
          lastActive: null,
          staleThresholdMs,
          updatedAt: new Date().toISOString(),
          message: `Consumer not found: ${durable}`,
        });
      }

      const lagMessages = typeof consumerInfo.num_pending === "number" ? consumerInfo.num_pending : null;
      const ackPending = typeof consumerInfo.num_ack_pending === "number" ? consumerInfo.num_ack_pending : null;
      const consumerStreamSeq =
        typeof consumerInfo.delivered?.stream_seq === "number" ? consumerInfo.delivered.stream_seq : null;
      const consumerSeq =
        typeof consumerInfo.delivered?.consumer_seq === "number" ? consumerInfo.delivered.consumer_seq : null;
      const lastActive = toIsoTimestamp(consumerInfo.delivered?.last_active || null);

      let status: "healthy" | "lagging" | "stale" = "healthy";
      if ((lagMessages ?? 0) > 0 || (ackPending ?? 0) > 0) {
        status = "lagging";
      }
      if (lastActive) {
        const ageMs = Date.now() - new Date(lastActive).getTime();
        if (ageMs > staleThresholdMs) {
          status = "stale";
        }
      } else if ((lagMessages ?? 0) > 0) {
        status = "stale";
      }

      return c.json({
        status,
        stream,
        durable,
        consumerFound: true,
        lagMessages,
        ackPending,
        streamLastSeq: streamInfo.state.last_seq,
        streamMessages: streamInfo.state.messages,
        consumerStreamSeq,
        consumerSeq,
        lastActive,
        staleThresholdMs,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({
        status: "error",
        stream,
        durable,
        consumerFound: false,
        lagMessages: null,
        ackPending: null,
        streamLastSeq: null,
        consumerStreamSeq: null,
        consumerSeq: null,
        lastActive: null,
        staleThresholdMs,
        updatedAt: new Date().toISOString(),
        message,
      });
    }
  });

  /**
   * List activity entries from JetStream
   * GET /api/activity?limit=50&actor=arm-123
   */
  app.get("/", async (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);
    const actor = c.req.query("actor");

    if (!eventStore.isInitialized()) {
      return c.json({ 
        activity: [],
        message: "JetStream not available - start the API server with NATS",
      });
    }

    try {
      let events;
      if (actor) {
        // Filter by specific arm
        events = await eventStore.getArmEvents(actor, limit);
      } else {
        // Get all recent events
        events = await eventStore.getRecentEvents(limit);
      }

      const activity = events.map(event => ({
        timestamp: event.timestamp,
        actor: event.armId || (event.data.actor as string) || "brain",
        action: event.type,
        target: event.armId || null,
        details: event.data,
      }));

      return c.json({ activity });
    } catch (err) {
      console.error("Activity query error:", err);
      return c.json({ error: "JetStream error" }, 500);
    }
  });

  /**
   * Get activity stats for arms with time-bucketed data
   * GET /api/activity/stats?minutes=20&bucket_minutes=1
   * 
   * Note: This is a simplified version that returns event counts from JetStream.
   * Time bucketing is done client-side for now since JetStream doesn't support SQL-like grouping.
   */
  app.get("/stats", async (c) => {
    const minutes = Math.min(parseInt(c.req.query("minutes") || "20", 10), 120);
    
    if (!eventStore.isInitialized()) {
      return c.json({ 
        timeRange: { startTime: new Date().toISOString(), endTime: new Date().toISOString() },
        armStats: {},
        message: "JetStream not available",
      });
    }

    const startTime = new Date();
    startTime.setMinutes(startTime.getMinutes() - minutes);
    
    try {
      // Get recent events within the time range
      const events = await eventStore.getRecentEvents(1000, startTime);

      // Group by arm
      const armStats: Record<string, Array<{ time: string; count: number }>> = {};
      
      for (const event of events) {
        const armId = event.armId;
        if (!armId || !armId.startsWith('arm-')) continue;
        
        if (!armStats[armId]) {
          armStats[armId] = [];
        }
        
        // Simple aggregation - add each event
        armStats[armId].push({
          time: event.timestamp,
          count: 1,
        });
      }

      return c.json({
        timeRange: {
          startTime: startTime.toISOString(),
          endTime: new Date().toISOString(),
        },
        armStats,
      });
    } catch (err) {
      console.error("Activity stats error:", err);
      return c.json({ error: "JetStream error" }, 500);
    }
  });

  /**
   * Log a new activity entry to JetStream
   * POST /api/activity
   */
  app.post("/", async (c) => {
    const body = await c.req.json<{
      actor: string;
      action: string;
      target?: string;
      details?: Record<string, unknown>;
    }>();

    if (!body.actor || !body.action) {
      return c.json({ error: "actor and action are required" }, 400);
    }

    if (!eventStore.isInitialized()) {
      return c.json({ error: "JetStream not available" }, 503);
    }

    const now = new Date().toISOString();
    const subject = body.target 
      ? `coleo.events.arm.${body.target}.${body.action}`
      : `coleo.events.api.${body.action}`;

    try {
      await eventStore.publishEvent(subject, {
        type: body.action,
        armId: body.target,
        data: { actor: body.actor, ...body.details },
        timestamp: now,
      });

      return c.json({
        entry: {
          timestamp: now,
          actor: body.actor,
          action: body.action,
          target: body.target || null,
          details: body.details || {},
        },
      }, 201);
    } catch (err) {
      console.error("Failed to publish activity:", err);
      return c.json({ error: "Failed to publish event" }, 500);
    }
  });

  return app;
}
