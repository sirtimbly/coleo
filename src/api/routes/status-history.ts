/**
 * Status History Search API Routes
 * 
 * Provides semantic search capabilities for arm status history,
 * task completions, discoveries, and bug reports.
 */

import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { searchStatusHistory, getStatusHistoryHealth } from "../../vector/indexing-pipeline";
import type { StatusHistoryEventType } from "../../vector/status-history";

interface StatusHistoryContext {
  Variables: {
    db: Database;
  };
}

/**
 * Create status history search routes
 */
export function createStatusHistoryRoutes(): Hono<StatusHistoryContext> {
  const app = new Hono<StatusHistoryContext>();

  /**
   * Search status history events
   * GET /api/status-history/search?q=query&type=status_report&limit=10
   */
  app.get("/search", async (c) => {
    const query = c.req.query("q");
    
    if (!query || query.trim().length === 0) {
      return c.json({ error: "Query parameter 'q' is required" }, 400);
    }

    // Parse options from query params
    const type = c.req.query("type") as StatusHistoryEventType | undefined;
    const source = c.req.query("source");
    const taskId = c.req.query("taskId");
    const bugId = c.req.query("bugId");
    const armId = c.req.query("armId");
    const limit = parseInt(c.req.query("limit") || "10", 10);
    const since = c.req.query("since") ? new Date(c.req.query("since")!) : undefined;
    const until = c.req.query("until") ? new Date(c.req.query("until")!) : undefined;

    try {
      const startTime = Date.now();
      const results = await searchStatusHistory(query, {
        limit,
        type,
        source,
        taskId,
        bugId,
        armId,
        since,
        until,
      });
      const took = Date.now() - startTime;

      return c.json({
        query,
        results: results.map((r) => ({
          id: r.id,
          score: r.score,
          event: r.event,
        })),
        total: results.length,
        took,
      });
    } catch (err) {
      console.error("[StatusHistory API] Search failed:", err);
      return c.json({ 
        error: "Search failed",
        message: err instanceof Error ? err.message : String(err),
      }, 500);
    }
  });

  /**
   * Get health status of the status history system
   * GET /api/status-history/health
   */
  app.get("/health", async (c) => {
    try {
      const health = await getStatusHistoryHealth();
      return c.json({
        healthy: health.healthy,
        collectionExists: health.collectionExists,
        pointsCount: health.pointsCount,
      });
    } catch (err) {
      return c.json({
        healthy: false,
        collectionExists: false,
        pointsCount: 0,
        error: err instanceof Error ? err.message : String(err),
      }, 503);
    }
  });

  /**
   * Get status history for a specific task
   * GET /api/status-history/task/:taskId
   */
  app.get("/task/:taskId", async (c) => {
    const taskId = c.req.param("taskId");
    const limit = parseInt(c.req.query("limit") || "20", 10);

    try {
      // Search for events related to this task
      const results = await searchStatusHistory("task completion status", {
        taskId,
        limit,
      });

      return c.json({
        taskId,
        events: results.map((r) => r.event),
        total: results.length,
      });
    } catch (err) {
      console.error("[StatusHistory API] Task history failed:", err);
      return c.json({ 
        error: "Failed to retrieve task history",
        message: err instanceof Error ? err.message : String(err),
      }, 500);
    }
  });

  /**
   * Get status history for a specific arm
   * GET /api/status-history/arm/:armId
   */
  app.get("/arm/:armId", async (c) => {
    const armId = c.req.param("armId");
    const limit = parseInt(c.req.query("limit") || "20", 10);
    const type = c.req.query("type") as StatusHistoryEventType | undefined;

    try {
      // Search for events from this arm
      const results = await searchStatusHistory("arm status activity", {
        source: armId,
        type,
        limit,
      });

      return c.json({
        armId,
        events: results.map((r) => r.event),
        total: results.length,
      });
    } catch (err) {
      console.error("[StatusHistory API] Arm history failed:", err);
      return c.json({ 
        error: "Failed to retrieve arm history",
        message: err instanceof Error ? err.message : String(err),
      }, 500);
    }
  });

  return app;
}
