/**
 * Health and status routes
 */
import { Hono } from "hono";
import type { Database } from "bun:sqlite";

interface SystemContext {
  Variables: {
    db: Database;
    startedAt: Date;
  };
}

export function createSystemRoutes() {
  const app = new Hono<SystemContext>();

  /**
   * Health check - no auth required
   * GET /api/health
   */
  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * System status - requires auth
   * GET /api/status
   */
  app.get("/status", (c) => {
    const db = c.get("db");
    const startedAt = c.get("startedAt");

    // Get counts from database
    let armCount = 0;
    let proposalCount = 0;
    let activityCount = 0;

    try {
      const armRow = db.query("SELECT COUNT(*) as count FROM arms").get() as { count: number } | null;
      const proposalRow = db.query("SELECT COUNT(*) as count FROM proposals WHERE status = 'open'").get() as { count: number } | null;
      const activityRow = db.query("SELECT COUNT(*) as count FROM activity WHERE timestamp > datetime('now', '-24 hours')").get() as { count: number } | null;

      armCount = armRow?.count ?? 0;
      proposalCount = proposalRow?.count ?? 0;
      activityCount = activityRow?.count ?? 0;
    } catch {
      // Tables may not exist yet
    }

    return c.json({
      status: "ok",
      version: "0.1.0",
      uptime: Math.floor((Date.now() - startedAt.getTime()) / 1000),
      arms: {
        total: armCount,
      },
      proposals: {
        open: proposalCount,
      },
      activity: {
        last24h: activityCount,
      },
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * Get system configuration (non-sensitive)
   * GET /api/config
   */
  app.get("/config", (c) => {
    const db = c.get("db");

    let config: Record<string, string> = {};
    try {
      const rows = db.query("SELECT key, value FROM config").all() as { key: string; value: string }[];
      for (const row of rows) {
        config[row.key] = row.value;
      }
    } catch {
      // Table may not exist yet
    }

    return c.json({
      brain: {
        pollIntervalMs: parseInt(config.brain_poll_interval_ms || "30000", 10),
        maxArms: parseInt(config.brain_max_arms || "8", 10),
      },
      version: "0.1.0",
    });
  });

  return app;
}
