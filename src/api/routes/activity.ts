/**
 * Activity log routes
 */
import { Hono } from "hono";
import type { Database } from "bun:sqlite";

interface ActivityContext {
  Variables: {
    db: Database;
  };
}

export interface ActivityEntry {
  id: number;
  timestamp: string;
  actor: string;
  action: string;
  target: string | null;
  details: Record<string, unknown>;
}

export function createActivityRoutes() {
  const app = new Hono<ActivityContext>();

  /**
   * List activity entries
   * GET /api/activity?limit=50&offset=0&actor=arm-123
   */
  app.get("/", (c) => {
    const db = c.get("db");
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);
    const offset = parseInt(c.req.query("offset") || "0", 10);
    const actor = c.req.query("actor");

    let query = `
      SELECT id, timestamp, actor, action, target, details
      FROM activity
    `;
    const params: unknown[] = [];

    if (actor) {
      query += " WHERE actor = ?";
      params.push(actor);
    }

    query += " ORDER BY timestamp DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    try {
      const rows = db.query(query).all(...(params as (string | number)[])) as ActivityRow[];

      const activity = rows.map(row => parseActivityRow(row));

      return c.json({ activity });
    } catch (err) {
      return c.json({ error: "Database error" }, 500);
    }
  });

  /**
   * Get activity stats for arms with time-bucketed data
   * GET /api/activity/stats?minutes=20&bucket_minutes=1
   */
  app.get("/stats", (c) => {
    const db = c.get("db");
    const minutes = Math.min(parseInt(c.req.query("minutes") || "20", 10), 120); // Max 2 hours
    const bucketMinutes = Math.max(parseInt(c.req.query("bucket_minutes") || "1", 10), 1);
    
    // Calculate the start time
    const startTime = new Date();
    startTime.setMinutes(startTime.getMinutes() - minutes);
    const startTimeStr = startTime.toISOString();
    
    try {
      // Query activity counts per arm per time bucket
      const query = `
        SELECT 
          actor,
          DATETIME((STRFTIME('%s', timestamp) / (? * 60)) * (? * 60), 'unixepoch') as bucket_time,
          COUNT(*) as activity_count
        FROM activity 
        WHERE timestamp >= ? 
        AND actor LIKE 'arm-%'
        GROUP BY actor, bucket_time
        ORDER BY bucket_time ASC, actor ASC
      `;
      
      const rows = db.query(query).all(bucketMinutes, bucketMinutes, startTimeStr) as Array<{
        actor: string;
        bucket_time: string;
        activity_count: number;
      }>;

      // Build the response structure
      const armStats: Record<string, Array<{ time: string; count: number }>> = {};
      
      // Initialize all time buckets for each arm that has activity
      const uniqueArms = new Set(rows.map(r => r.actor));
      const timeBuckets: string[] = [];
      
      // Generate all time buckets for the time range
      for (let i = 0; i < minutes / bucketMinutes; i++) {
        const bucketTime = new Date(startTime.getTime() + i * bucketMinutes * 60 * 1000);
        const bucketTimeStr = bucketTime.toISOString().substring(0, 19).replace('T', ' ');
        timeBuckets.push(bucketTimeStr);
      }
      
      // Initialize arm stats with empty buckets
      uniqueArms.forEach(arm => {
        armStats[arm] = timeBuckets.map(time => ({ time, count: 0 }));
      });
      
      // Fill in actual activity counts
      rows.forEach(row => {
        const arm = row.actor;
        const bucketIndex = timeBuckets.findIndex(t => t === row.bucket_time);
        const armData = armStats[arm];
        if (bucketIndex >= 0 && armData && armData[bucketIndex]) {
          armData[bucketIndex].count = row.activity_count;
        }
      });

      return c.json({
        timeRange: {
          startTime: startTimeStr,
          endTime: new Date().toISOString(),
          bucketMinutes,
          totalBuckets: timeBuckets.length
        },
        armStats
      });
    } catch (err) {
      console.error("Activity stats error:", err);
      return c.json({ error: "Database error" }, 500);
    }
  });

  /**
   * Log a new activity entry
   * POST /api/activity
   */
  app.post("/", async (c) => {
    const db = c.get("db");
    const body = await c.req.json<{
      actor: string;
      action: string;
      target?: string;
      details?: Record<string, unknown>;
    }>();

    if (!body.actor || !body.action) {
      return c.json({ error: "actor and action are required" }, 400);
    }

    const now = new Date().toISOString();

    const result = db.run(`
      INSERT INTO activity (timestamp, actor, action, target, details)
      VALUES (?, ?, ?, ?, ?)
    `, [
      now,
      body.actor,
      body.action,
      body.target || null,
      JSON.stringify(body.details || {}),
    ]);

    return c.json({
      entry: {
        id: Number(result.lastInsertRowid),
        timestamp: now,
        actor: body.actor,
        action: body.action,
        target: body.target || null,
        details: body.details || {},
      },
    }, 201);
  });

  return app;
}

interface ActivityRow {
  id: number;
  timestamp: string;
  actor: string;
  action: string;
  target: string | null;
  details: string;
}

function parseActivityRow(row: ActivityRow): ActivityEntry {
  return {
    ...row,
    details: JSON.parse(row.details || "{}"),
  };
}
