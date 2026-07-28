/**
 * Events routes
 *
 * Provides API endpoints for:
 * - Fetching event windows for arms
 * - Real-time throttled SSE stream of events
 * - Health monitoring data
 */
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { HttpError } from "../middleware";
import { BrainEventWindow, brainEventWindow } from "../../brain/event-window";
import { ArmActivityAnalyzer, armActivityAnalyzer } from "../../brain/activity-analyzer";
import { eventStore } from "../../nats/jetstream";
import { isRecord } from "../../utils/json";

interface EventsContext {
  Variables: {
    db: Database;
  };
}

type ActivityMetricCategory = "write" | "think" | "tool" | "complete";

interface ActivityMetricBucket {
  start: string;
  counts: Record<ActivityMetricCategory, number>;
}

function classifyActivityMetric(type: string, data: Record<string, unknown>): ActivityMetricCategory {
  if (type === "file.edited" || type.startsWith("file.")) {
    return "write";
  }

  if (type === "message.part.updated" || type === "message.part.created") {
    const part = data.part;
    if (isRecord(part) && (part.type === "text" || part.type === "reasoning")) {
      return "think";
    }
  }

  if (type === "task.completed" || type === "task.completion" || type === "step.completed") {
    return "complete";
  }

  return "tool";
}

/**
 * Throttle state for SSE connections
 */
interface ThrottleState {
  lastSent: Map<string, Date>; // armId -> last event time
  eventQueue: Array<{
    armId: string;
    type: string;
    data: Record<string, unknown>;
    timestamp: string;
  }>;
}

/**
 * Configuration for SSE throttling
 */
const SSE_CONFIG = {
  /** Minimum interval between events for the same arm (ms) */
  minIntervalPerArmMs: 500,
  /** Maximum events in the queue before dropping oldest */
  maxQueueSize: 100,
  /** How often to flush the queue (ms) */
  flushIntervalMs: 100,
  /** Heartbeat interval to keep connection alive (ms) */
  heartbeatIntervalMs: 15000,
};

/**
 * Sensitive fields to redact from events
 */
const SENSITIVE_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /token/i,
  /credential/i,
  /private/i,
];

/**
 * Sanitize event data by redacting sensitive fields
 */
function sanitizeEventValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeEventValue(item));
  }

  if (isRecord(value)) {
    return sanitizeEventData(value);
  }

  return value;
}

function sanitizeEventData(data: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    // Check if key matches sensitive patterns
    const isSensitive = SENSITIVE_PATTERNS.some((pattern) => pattern.test(key));

    if (isSensitive) {
      sanitized[key] = "[REDACTED]";
    } else if (typeof value === "string" && value.length > 2000) {
      // Truncate very long strings
      sanitized[key] = value.slice(0, 2000) + "... [truncated]";
    } else {
      sanitized[key] = sanitizeEventValue(value);
    }
  }

  return sanitized;
}

export function createEventsRoutes() {
  const app = new Hono<EventsContext>();

  /**
   * Publish an event into JetStream through API auth/type boundaries.
   * POST /api/events/internal/publish
   */
  app.post("/internal/publish", async (c) => {
    const body = await c.req.json<{
      subject?: unknown;
      type?: unknown;
      armId?: unknown;
      data?: unknown;
      timestamp?: unknown;
    }>();

    if (typeof body.subject !== "string" || body.subject.trim().length === 0) {
      throw HttpError.badRequest("subject is required");
    }
    if (!body.subject.startsWith("coleo.events.")) {
      throw HttpError.badRequest("subject must start with coleo.events.");
    }
    if (typeof body.type !== "string" || body.type.trim().length === 0) {
      throw HttpError.badRequest("type is required");
    }
    if (!isRecord(body.data)) {
      throw HttpError.badRequest("data must be an object");
    }
    if (body.armId !== undefined && typeof body.armId !== "string") {
      throw HttpError.badRequest("armId must be a string when provided");
    }
    if (
      body.timestamp !== undefined &&
      (typeof body.timestamp !== "string" ||
        Number.isNaN(new Date(body.timestamp).getTime()))
    ) {
      throw HttpError.badRequest("timestamp must be an ISO date string when provided");
    }

    if (!eventStore.isInitialized()) {
      return c.json({ error: "Event store not available" }, 503);
    }

    await eventStore.publishEvent(body.subject, {
      type: body.type,
      armId: typeof body.armId === "string" ? body.armId : undefined,
      data: body.data,
      timestamp:
        typeof body.timestamp === "string"
          ? new Date(body.timestamp).toISOString()
          : new Date().toISOString(),
    });

    return c.json({ published: true });
  });

  /**
   * Get event window for a specific arm
   * GET /api/events/arms/:armId/window
   *
   * Query params:
   * - windowMs: How far back to look (default: 10 minutes)
   * - limit: Maximum events to return (default: 200)
   */
  app.get("/arms/:armId/window", async (c) => {
    const armId = c.req.param("armId");
    const windowMs = parseInt(c.req.query("windowMs") || "600000", 10);
    const limit = Math.min(parseInt(c.req.query("limit") || "200", 10), 500);

    if (!brainEventWindow.isAvailable()) {
      return c.json(
        {
          error: "Event store not available",
          armId,
          events: [],
        },
        503
      );
    }

    try {
      const window = await brainEventWindow.getWindowForArm(armId, {
        windowMs,
        limit,
      });

      const summary = brainEventWindow.summarizeWindow(window);

      return c.json({
        armId,
        window: {
          events: window.events.map((e) => ({
            type: e.type,
            timestamp: e.timestamp,
            data: sanitizeEventData(e.data),
            sequence: e.sequence,
          })),
          lastEventAt: window.lastEventAt?.toISOString() ?? null,
          silentDurationMs: window.silentDurationMs,
          unknownEventTypes: window.unknownEventTypes,
        },
        summary: {
          totalEvents: summary.totalEvents,
          eventTypeCounts: Object.fromEntries(summary.eventTypeCounts),
          firstEventAt: summary.firstEventAt?.toISOString() ?? null,
          lastEventAt: summary.lastEventAt?.toISOString() ?? null,
          durationMs: summary.durationMs,
        },
      });
    } catch (err) {
      throw HttpError.internal(`Failed to fetch event window: ${err}`);
    }
  });

  /**
   * Aggregate recent arm activity into fixed minute buckets for chart rendering.
   * GET /api/events/arms/:armId/metrics
   */
  app.get("/arms/:armId/metrics", async (c) => {
    const armId = c.req.param("armId");
    const requestedWindowMs = Number.parseInt(c.req.query("windowMs") || "1800000", 10);
    const windowMs = Number.isFinite(requestedWindowMs)
      ? Math.min(Math.max(requestedWindowMs, 60_000), 30 * 60 * 1000)
      : 30 * 60 * 1000;
    const bucketMs = 60_000;
    const endMs = Math.ceil(Date.now() / bucketMs) * bucketMs;
    const startMs = endMs - windowMs;
    const bucketCount = Math.ceil(windowMs / bucketMs);
    const buckets: ActivityMetricBucket[] = Array.from({ length: bucketCount }, (_, index) => ({
      start: new Date(startMs + index * bucketMs).toISOString(),
      counts: { write: 0, think: 0, tool: 0, complete: 0 },
    }));

    if (!brainEventWindow.isAvailable()) {
      return c.json({
        armId,
        window: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), bucketMs },
        buckets,
        summary: { totalEvents: 0, lastEventAt: null },
      });
    }

    try {
      const window = await brainEventWindow.getWindowForArm(armId, {
        windowMs,
        limit: 1000,
      });
      let totalEvents = 0;

      for (const event of window.events) {
        const timestamp = new Date(event.timestamp).getTime();
        if (!Number.isFinite(timestamp) || timestamp < startMs || timestamp >= endMs) continue;
        const index = Math.floor((timestamp - startMs) / bucketMs);
        const bucket = buckets[index];
        if (!bucket) continue;
        bucket.counts[classifyActivityMetric(event.type, event.data)] += 1;
        totalEvents += 1;
      }

      return c.json({
        armId,
        window: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), bucketMs },
        buckets,
        summary: {
          totalEvents,
          lastEventAt: window.lastEventAt?.toISOString() ?? null,
        },
      });
    } catch (err) {
      throw HttpError.internal(`Failed to aggregate arm metrics: ${err}`);
    }
  });

  /**
   * Get analysis for a specific arm
   * GET /api/events/arms/:armId/analysis
   */
  app.get("/arms/:armId/analysis", async (c) => {
    const armId = c.req.param("armId");
    const windowMs = parseInt(c.req.query("windowMs") || "600000", 10);

    if (!brainEventWindow.isAvailable()) {
      return c.json(
        {
          error: "Event store not available",
          armId,
        },
        503
      );
    }

    try {
      const window = await brainEventWindow.getWindowForArm(armId, {
        windowMs,
      });

      const analysis = armActivityAnalyzer.analyze(window);
      const trend = armActivityAnalyzer.getStateTrend(armId);

      return c.json({
        armId,
        analysis: {
          state: analysis.state,
          confidence: analysis.confidence,
          reason: analysis.reason,
          recommendedAction: analysis.recommendedAction,
          metrics: analysis.metrics,
          pendingPermission: analysis.pendingPermission,
          loopPattern: analysis.loopPattern,
          unknownEventTypes: analysis.unknownEventTypes,
        },
        trend: {
          improving: trend.improving,
          degrading: trend.degrading,
          stable: trend.stable,
          recentStates: trend.history,
        },
      });
    } catch (err) {
      throw HttpError.internal(`Failed to analyze arm: ${err}`);
    }
  });

  /**
   * Get analysis for all active arms
   * GET /api/events/analysis
   */
  app.get("/analysis", async (c) => {
    const db = c.get("db");
    const windowMs = parseInt(c.req.query("windowMs") || "600000", 10);

    if (!brainEventWindow.isAvailable()) {
      return c.json(
        {
          error: "Event store not available",
          arms: [],
        },
        503
      );
    }

    try {
      // Get active arm IDs from database
      const rows = db
        .query(
          `SELECT id FROM arms WHERE status NOT IN ('stopped', 'error') ORDER BY name`
        )
        .all() as Array<{ id: string }>;

      const armIds = rows.map((r) => r.id);

      if (armIds.length === 0) {
        return c.json({ arms: [], summary: { total: 0 } });
      }

      // Fetch windows and analyze
      const windows = await brainEventWindow.getWindowsForAllArms(armIds, {
        windowMs,
      });

      const analyses = armActivityAnalyzer.analyzeAll(windows);

      // Build response
      const arms: Array<{
        armId: string;
        state: string;
        confidence: string;
        reason: string;
        recommendedAction?: string;
        silentDurationMs: number;
        hasPermissionPending: boolean;
      }> = [];

      const summary = {
        total: armIds.length,
        productive: 0,
        idle: 0,
        waiting: 0,
        looping: 0,
        silent: 0,
        error: 0,
        starting: 0,
      };

      for (const [armId, analysis] of analyses) {
        arms.push({
          armId,
          state: analysis.state,
          confidence: analysis.confidence,
          reason: analysis.reason,
          recommendedAction: analysis.recommendedAction,
          silentDurationMs: analysis.metrics.silentDurationMs,
          hasPermissionPending: !!analysis.pendingPermission,
        });

        // Update summary
        switch (analysis.state) {
          case "productive":
            summary.productive++;
            break;
          case "idle":
            summary.idle++;
            break;
          case "waiting_permission":
            summary.waiting++;
            break;
          case "looping":
            summary.looping++;
            break;
          case "silent":
            summary.silent++;
            break;
          case "error":
            summary.error++;
            break;
          case "starting":
            summary.starting++;
            break;
        }
      }

      return c.json({ arms, summary });
    } catch (err) {
      throw HttpError.internal(`Failed to analyze arms: ${err}`);
    }
  });

  /**
   * Get recent events across all arms
   * GET /api/events/recent
   */
  app.get("/recent", async (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
    const sinceMs = parseInt(c.req.query("sinceMs") || "0", 10);

    if (!eventStore.isInitialized()) {
      return c.json(
        {
          error: "Event store not available",
          events: [],
        },
        503
      );
    }

    try {
      const since = sinceMs > 0 ? new Date(Date.now() - sinceMs) : undefined;
      const events = await eventStore.getRecentEvents(limit, since);

      return c.json({
        events: events.map((e) => ({
          type: e.type,
          armId: e.armId,
          timestamp: e.timestamp,
          data: sanitizeEventData(e.data),
        })),
        count: events.length,
      });
    } catch (err) {
      throw HttpError.internal(`Failed to fetch recent events: ${err}`);
    }
  });

  /**
   * Throttled SSE stream of events
   * GET /api/events/stream
   *
   * Query params:
   * - armIds: Comma-separated list of arm IDs to filter (optional)
   * - types: Comma-separated list of event types to filter (optional)
   */
  app.get("/stream", async (c) => {
    const armIdsParam = c.req.query("armIds");
    const typesParam = c.req.query("types");

    const filterArmIds = armIdsParam
      ? new Set(armIdsParam.split(",").map((s) => s.trim()))
      : null;
    const filterTypes = typesParam
      ? new Set(typesParam.split(",").map((s) => s.trim()))
      : null;

    // Set up SSE response
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");
    c.header("X-Accel-Buffering", "no");

    // Create throttle state
    const throttle: ThrottleState = {
      lastSent: new Map(),
      eventQueue: [],
    };

    // Create a readable stream for SSE
    const encoder = new TextEncoder();
    let isOpen = true;

    const stream = new ReadableStream({
      async start(controller) {
        // Send initial connection event
        controller.enqueue(
          encoder.encode(
            `event: connected\ndata: ${JSON.stringify({
              timestamp: new Date().toISOString(),
              config: SSE_CONFIG,
            })}\n\n`
          )
        );

        // Set up heartbeat
        const heartbeatTimer = setInterval(() => {
          if (!isOpen) {
            clearInterval(heartbeatTimer);
            return;
          }
          controller.enqueue(
            encoder.encode(
              `: heartbeat ${new Date().toISOString()}\n\n`
            )
          );
        }, SSE_CONFIG.heartbeatIntervalMs);

        // Set up event polling
        let lastPollTime = new Date();

        const pollTimer = setInterval(async () => {
          if (!isOpen) {
            clearInterval(pollTimer);
            return;
          }

          try {
            if (!eventStore.isInitialized()) {
              return;
            }

            // Fetch events since last poll
            const events = await eventStore.getRecentEvents(50, lastPollTime);
            lastPollTime = new Date();

            for (const event of events) {
              // Apply filters
              if (filterArmIds && event.armId && !filterArmIds.has(event.armId)) {
                continue;
              }
              if (filterTypes && !filterTypes.has(event.type)) {
                continue;
              }

              // Apply throttling per arm
              if (event.armId) {
                const lastSent = throttle.lastSent.get(event.armId);
                if (lastSent) {
                  const elapsed = Date.now() - lastSent.getTime();
                  if (elapsed < SSE_CONFIG.minIntervalPerArmMs) {
                    // Queue instead of sending
                    throttle.eventQueue.push({
                      armId: event.armId,
                      type: event.type,
                      data: sanitizeEventData(event.data),
                      timestamp: event.timestamp,
                    });

                    // Trim queue if too large
                    if (throttle.eventQueue.length > SSE_CONFIG.maxQueueSize) {
                      throttle.eventQueue.shift();
                    }
                    continue;
                  }
                }

                throttle.lastSent.set(event.armId, new Date());
              }

              // Send event
              const eventData = JSON.stringify({
                type: event.type,
                armId: event.armId,
                timestamp: event.timestamp,
                data: sanitizeEventData(event.data),
              });

              controller.enqueue(
                encoder.encode(`event: arm-event\ndata: ${eventData}\n\n`)
              );
            }

            // Flush queued events periodically
            if (throttle.eventQueue.length > 0) {
              const now = Date.now();
              const toFlush: typeof throttle.eventQueue = [];

              // Find events that can be flushed
              for (const queuedEvent of throttle.eventQueue) {
                const lastSent = throttle.lastSent.get(queuedEvent.armId);
                if (!lastSent || now - lastSent.getTime() >= SSE_CONFIG.minIntervalPerArmMs) {
                  toFlush.push(queuedEvent);
                  throttle.lastSent.set(queuedEvent.armId, new Date());
                }
              }

              // Remove flushed events from queue
              throttle.eventQueue = throttle.eventQueue.filter(
                (e) => !toFlush.includes(e)
              );

              // Send flushed events
              for (const event of toFlush) {
                const eventData = JSON.stringify(event);
                controller.enqueue(
                  encoder.encode(`event: arm-event\ndata: ${eventData}\n\n`)
                );
              }
            }
          } catch (err) {
            console.error("[events/stream] Poll error:", err);
          }
        }, SSE_CONFIG.flushIntervalMs);

        // Handle client disconnect
        c.req.raw.signal.addEventListener("abort", () => {
          isOpen = false;
          clearInterval(heartbeatTimer);
          clearInterval(pollTimer);
          controller.close();
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  /**
   * Get health monitor configuration
   * GET /api/events/health/config
   */
  app.get("/health/config", (c) => {
    const analyzerConfig = armActivityAnalyzer.getConfig();

    return c.json({
      analyzer: analyzerConfig,
      sse: SSE_CONFIG,
    });
  });

  /**
   * Get known event types
   * GET /api/events/types
   */
  app.get("/types", async (c) => {
    // Import the known types from event-window-constants
    const { KNOWN_EVENT_TYPES } = await import("../../brain/event-window-constants");

    return c.json({
      knownTypes: Array.from(KNOWN_EVENT_TYPES).sort(),
      count: KNOWN_EVENT_TYPES.size,
    });
  });

  return app;
}
