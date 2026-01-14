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
      const activity = rows.map(parseActivityRow);

      // Get total count
      let countQuery = "SELECT COUNT(*) as count FROM activity";
      if (actor) {
        countQuery += " WHERE actor = ?";
      }
      const countRow = db.query(countQuery).get(...(actor ? [actor] : [])) as { count: number };

      return c.json({
        activity,
        pagination: {
          limit,
          offset,
          total: countRow.count,
        },
      });
    } catch {
      return c.json({
        activity: [],
        pagination: { limit, offset, total: 0 },
      });
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
