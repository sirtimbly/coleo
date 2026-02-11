/**
 * Status Reports routes
 * Handle status reports from arms and provide dashboard API
 */
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { HttpError } from "../middleware";
import { broadcast } from "../websocket";

interface StatusReportsContext {
  Variables: {
    db: Database;
  };
}

export interface StatusReport {
  id: string;
  taskId: string;
  armId: string;
  status: "on_track" | "blocked" | "issues_found" | "needs_review" | "completed_with_issues";
  summary: string;
  issues?: string[];
  blockers?: string[];
  nextSteps?: string;
  filesChanged?: string[];
  testsStatus?: "passing" | "failing" | "not_run";
  createdAt: string;
}

export function createStatusReportsRoutes() {
  const app = new Hono<StatusReportsContext>();

  /**
   * Submit a status report from an arm
   * POST /api/status-reports
   */
  app.post("/", async (c) => {
    const db = c.get("db");
    const body = await c.req.json<{
      taskId: string;
      armId: string;
      status: StatusReport["status"];
      summary: string;
      issues?: string[];
      blockers?: string[];
      nextSteps?: string;
      filesChanged?: string[];
      testsStatus?: StatusReport["testsStatus"];
    }>();

    if (!body.taskId || !body.armId || !body.status || !body.summary) {
      throw HttpError.badRequest("taskId, armId, status, and summary are required");
    }

    const id = `${body.taskId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = new Date().toISOString();

    try {
      db.run(`
        INSERT INTO status_reports (
          id, task_id, arm_id, status, summary, issues, blockers,
          next_steps, files_changed, tests_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        id,
        body.taskId,
        body.armId,
        body.status,
        body.summary,
        body.issues ? JSON.stringify(body.issues) : null,
        body.blockers ? JSON.stringify(body.blockers) : null,
        body.nextSteps || null,
        body.filesChanged ? JSON.stringify(body.filesChanged) : null,
        body.testsStatus || null,
        now,
      ]);

      // Broadcast status report event
      broadcast("brain", "status_report_received", {
        report: {
          id,
          taskId: body.taskId,
          armId: body.armId,
          status: body.status,
          summary: body.summary,
          createdAt: now,
        },
      });

      return c.json({ report: { id, ...body, createdAt: now } }, 201);
    } catch (err) {
      console.error("Failed to save status report:", err);
      throw HttpError.internal("Failed to save status report");
    }
  });

  /**
   * List status reports
   * GET /api/status-reports?taskId=xxx&armId=xxx&limit=50&offset=0
   */
  app.get("/", (c) => {
    const db = c.get("db");
    const taskId = c.req.query("taskId");
    const armId = c.req.query("armId");
    const status = c.req.query("status");
    const since = c.req.query("since");
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    let query = `
      SELECT
        id, task_id as taskId, arm_id as armId, status, summary,
        issues, blockers, next_steps as nextSteps,
        files_changed as filesChanged, tests_status as testsStatus,
        created_at as createdAt
      FROM status_reports
    `;
    const params: unknown[] = [];

    if (taskId || armId || status || since) {
      query += " WHERE";
      if (taskId) {
        query += " task_id = ?";
        params.push(taskId);
      }
      if (armId) {
        if (params.length > 0) query += " AND";
        query += " arm_id = ?";
        params.push(armId);
      }
      if (status) {
        if (params.length > 0) query += " AND";
        query += " status = ?";
        params.push(status);
      }
      if (since) {
        if (params.length > 0) query += " AND";
        query += " created_at > ?";
        params.push(since);
      }
    }

    query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    try {
      const rows = db.query(query).all(...(params as any[])) as StatusReportRow[];

      const reports = rows.map(parseStatusReportRow);

      // Get total count
      let countQuery = "SELECT COUNT(*) as count FROM status_reports";
      const countParams: any[] = [];
      if (taskId || armId || status || since) {
        countQuery += " WHERE";
        if (taskId) {
          countQuery += " task_id = ?";
          countParams.push(taskId);
        }
        if (armId) {
          if (countParams.length > 0) countQuery += " AND";
          countQuery += " arm_id = ?";
          countParams.push(armId);
        }
        if (status) {
          if (countParams.length > 0) countQuery += " AND";
          countQuery += " status = ?";
          countParams.push(status);
        }
        if (since) {
          if (countParams.length > 0) countQuery += " AND";
          countQuery += " created_at > ?";
          countParams.push(since);
        }
      }

      const countRow = db.query(countQuery).get(...countParams) as { count: number };

      return c.json({
        reports,
        pagination: {
          limit,
          offset,
          total: countRow.count,
        },
      });
    } catch (err) {
      console.error("Failed to fetch status reports:", err);
      return c.json({ reports: [], pagination: { limit, offset, total: 0 } });
    }
  });

  /**
   * Get a single status report
   * GET /api/status-reports/:id
   */
  app.get("/:id", (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    const row = db.query(`
      SELECT
        id, task_id as taskId, arm_id as armId, status, summary,
        issues, blockers, next_steps as nextSteps,
        files_changed as filesChanged, tests_status as testsStatus,
        created_at as createdAt
      FROM status_reports
      WHERE id = ?
    `).get(id) as StatusReportRow | null;

    if (!row) {
      throw HttpError.notFound(`Status report not found: ${id}`);
    }

    return c.json({ report: parseStatusReportRow(row) });
  });

  /**
   * Get status report statistics
   * GET /api/status-reports/stats
   */
  app.get("/stats", (c) => {
    const db = c.get("db");

    try {
      // Get status distribution
      const statusStats = db.query(`
        SELECT status, COUNT(*) as count
        FROM status_reports
        GROUP BY status
      `).all() as Array<{ status: string; count: number }>;

      // Get recent reports (last 24 hours)
      const recentReports = db.query(`
        SELECT COUNT(*) as count
        FROM status_reports
        WHERE created_at >= datetime('now', '-1 day')
      `).get() as { count: number };

      // Get reports by arm
      const armStats = db.query(`
        SELECT arm_id as armId, COUNT(*) as count
        FROM status_reports
        GROUP BY arm_id
        ORDER BY count DESC
        LIMIT 10
      `).all() as Array<{ armId: string; count: number }>;

      return c.json({
        statusDistribution: statusStats,
        recentReports: recentReports.count,
        reportsByArm: armStats,
      });
    } catch (err) {
      console.error("Failed to get status report stats:", err);
      return c.json({
        statusDistribution: [],
        recentReports: 0,
        reportsByArm: [],
      });
    }
  });

  return app;
}

// Database row type
interface StatusReportRow {
  id: string;
  taskId: string;
  armId: string;
  status: string;
  summary: string;
  issues: string | null;
  blockers: string | null;
  nextSteps: string | null;
  filesChanged: string | null;
  testsStatus: string | null;
  createdAt: string;
}

function parseStatusReportRow(row: StatusReportRow): StatusReport {
  return {
    ...row,
    status: row.status as StatusReport["status"],
    issues: row.issues ? JSON.parse(row.issues) : undefined,
    blockers: row.blockers ? JSON.parse(row.blockers) : undefined,
    nextSteps: row.nextSteps || undefined,
    filesChanged: row.filesChanged ? JSON.parse(row.filesChanged) : undefined,
    testsStatus: (row.testsStatus === "passing" || row.testsStatus === "failing" || row.testsStatus === "not_run")
      ? row.testsStatus as StatusReport["testsStatus"]
      : undefined,
  };
}
