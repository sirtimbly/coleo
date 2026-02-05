/**
 * Activity log routes
 * 
 * Activity is now stored in JetStream, not SQLite.
 * This provides event sourcing with the stream as the single source of truth.
 */
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { eventStore } from "../../nats/jetstream";

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

export function createActivityRoutes() {
  const app = new Hono<ActivityContext>();

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
