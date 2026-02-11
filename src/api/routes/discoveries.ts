/**
 * Discoveries routes
 * 
 * API for querying arm discoveries
 */
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { HttpError } from "../middleware";

interface DiscoveriesContext {
  Variables: {
    db: Database;
  };
}

export interface Discovery {
  id: string;
  armId: string;
  armName: string;
  kind: string;
  title: string;
  details: string;
  filePath: string | null;
  lineNumber: number | null;
  severity: string;
  status: string;
  taskId?: string | null;
  phase?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DiscoveryRow {
  id: string;
  arm_id: string;
  arm_name: string;
  kind: string;
  title: string;
  details: string;
  file_path: string | null;
  line_number: number | null;
  severity: string;
  status: string;
  task_id: string | null;
  phase: string | null;
  created_at: string;
  updated_at: string;
}

export function createDiscoveriesRoutes() {
  const app = new Hono<DiscoveriesContext>();

  // Create a discovery
  app.post("/", async (c) => {
    const db = c.var.db;
    const body = await c.req.json<{
      id?: string;
      armId: string;
      armName?: string;
      kind: string;
      title: string;
      details: string;
      filePath?: string | null;
      lineNumber?: number | null;
      severity?: string;
      status?: string;
    }>();

    if (!body.armId || !body.kind || !body.title || !body.details) {
      throw HttpError.badRequest("armId, kind, title, and details are required");
    }

    const now = new Date().toISOString();
    const id = body.id || `disc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      db.run(
        `
        INSERT INTO discoveries (
          id, arm_id, arm_name, kind, title, details, file_path, line_number, severity, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          id,
          body.armId,
          body.armName || body.armId,
          body.kind,
          body.title,
          body.details,
          body.filePath || null,
          body.lineNumber || null,
          body.severity || "info",
          body.status || "open",
          now,
          now,
        ],
      );

      return c.json({
        discovery: {
          id,
          armId: body.armId,
          armName: body.armName || body.armId,
          kind: body.kind,
          title: body.title,
          details: body.details,
          filePath: body.filePath || null,
          lineNumber: body.lineNumber || null,
          severity: body.severity || "info",
          status: body.status || "open",
          createdAt: now,
          updatedAt: now,
        },
      }, 201);
    } catch {
      throw HttpError.internal("Failed to create discovery");
    }
  });
  
  // List discoveries with filtering
  app.get("/", async (c) => {
    const db = c.var.db;
    const armId = c.req.query("armId");
    const kind = c.req.query("kind");
    const severity = c.req.query("severity");
    const status = c.req.query("status") || "open";
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);
    
    let query = `
      SELECT id, arm_id, arm_name, kind, title, details, file_path, line_number, severity, status, task_id, phase, created_at, updated_at
      FROM discoveries
      WHERE status = ?
    `;
    
    const params: (string | number)[] = [status];
    
    if (armId) {
      query += " AND arm_id = ?";
      params.push(armId);
    }
    
    if (kind) {
      query += " AND kind = ?";
      params.push(kind);
    }
    
    if (severity) {
      query += " AND severity = ?";
      params.push(severity);
    }
    
    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);
    
    try {
      const stmt = db.query(query);
      const rows = params.length > 0 ? stmt.all(...params) : stmt.all();
      const typedRows = rows as DiscoveryRow[];
      
      const discoveries: Discovery[] = typedRows.map(row => ({
        id: row.id,
        armId: row.arm_id,
        armName: row.arm_name,
        kind: row.kind,
        title: row.title,
        details: row.details,
        filePath: row.file_path,
        lineNumber: row.line_number,
        severity: row.severity,
        status: row.status,
        taskId: row.task_id,
        phase: row.phase,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
      
      return c.json({ discoveries });
    } catch (err) {
      throw HttpError.internal("Failed to query discoveries");
    }
  });
  
  // Get a single discovery
  app.get("/:id", async (c) => {
    const db = c.var.db;
    const id = c.req.param("id");
    
    const row = db.query(
      "SELECT id, arm_id, arm_name, kind, title, details, file_path, line_number, severity, status, task_id, phase, created_at, updated_at FROM discoveries WHERE id = ?"
    ).get(id) as DiscoveryRow | null;
    
    if (!row) {
      throw HttpError.notFound("Discovery not found");
    }
    
    const discovery: Discovery = {
      id: row.id,
      armId: row.arm_id,
      armName: row.arm_name,
      kind: row.kind,
      title: row.title,
      details: row.details,
      filePath: row.file_path,
      lineNumber: row.line_number,
      severity: row.severity,
      status: row.status,
      taskId: row.task_id,
      phase: row.phase,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    
    return c.json({ discovery });
  });
  
  // Update discovery status
  app.patch("/:id", async (c) => {
    const db = c.var.db;
    const id = c.req.param("id");
    const body = await c.req.json();
    
    const validStatuses = ["open", "acknowledged", "resolved", "dismissed"];
    if (body.status && !validStatuses.includes(body.status)) {
      throw HttpError.badRequest("Invalid status");
    }
    
    const updates: string[] = [];
    const params: (string | number | null)[] = [];
    
    if (body.status) {
      updates.push("status = ?");
      params.push(body.status);
    }
    
    if (updates.length === 0) {
      throw HttpError.badRequest("No updates provided");
    }
    
    updates.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(id);
    
    try {
      db.run(`UPDATE discoveries SET ${updates.join(", ")} WHERE id = ?`, params);
      return c.json({ success: true });
    } catch (err) {
      throw HttpError.internal("Failed to update discovery");
    }
  });
  
  // Search discoveries (full-text)
  app.get("/search", async (c) => {
    const db = c.var.db;
    const q = c.req.query("q");
    const severity = c.req.query("severity");
    const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
    
    if (!q || q.length < 2) {
      throw HttpError.badRequest("Search query must be at least 2 characters");
    }
    
    try {
      // Try FTS5 first
      let query = `
        SELECT d.id, d.arm_id, d.arm_name, d.kind, d.title, d.details, d.file_path, d.line_number, d.severity, d.status, d.created_at, d.updated_at
        FROM discoveries d
        JOIN discoveries_fts fts ON d.rowid = fts.rowid
        WHERE discoveries_fts MATCH ?
        ${severity ? "AND d.severity = ?" : ""}
        ORDER BY d.created_at DESC
        LIMIT ?
      `;
      
       const params: (string | number)[] = [q];
      if (severity) params.push(severity);
      params.push(limit);
      
      const stmt = db.query(query);
      const rows = params.length > 0 ? stmt.all(...params) : stmt.all();
      const typedRows = rows as DiscoveryRow[];
      
      const discoveries: Discovery[] = typedRows.map(row => ({
        id: row.id,
        armId: row.arm_id,
        armName: row.arm_name,
        kind: row.kind,
        title: row.title,
        details: row.details,
        filePath: row.file_path,
        lineNumber: row.line_number,
        severity: row.severity,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
      
      return c.json({ discoveries });
    } catch {
      // Fall back to LIKE search if FTS fails
      let query = `
        SELECT id, arm_id, arm_name, kind, title, details, file_path, line_number, severity, status, created_at, updated_at
        FROM discoveries
        WHERE (title LIKE ? OR details LIKE ?)
        ${severity ? "AND severity = ?" : ""}
        ORDER BY created_at DESC
        LIMIT ?
      `;
      
       const searchTerm = `%${q}%`;
       const params: (string | number)[] = [searchTerm, searchTerm];
       if (severity) params.push(severity);
       params.push(limit);
       
       const stmt = db.query(query);
       const rows = params.length > 0 ? stmt.all(...params) : stmt.all();
       const typedRows = rows as DiscoveryRow[];
       
       const discoveries: Discovery[] = typedRows.map(row => ({
        id: row.id,
        armId: row.arm_id,
        armName: row.arm_name,
        kind: row.kind,
        title: row.title,
        details: row.details,
        filePath: row.file_path,
        lineNumber: row.line_number,
        severity: row.severity,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
      
      return c.json({ discoveries });
    }
  });
  
  // Get discovery statistics
  app.get("/stats", async (c) => {
    const db = c.var.db;
    
    try {
      const bySeverity = db.query(`
        SELECT severity, COUNT(*) as count
        FROM discoveries
        GROUP BY severity
      `).all() as Array<{ severity: string; count: number }>;
      
      const byKind = db.query(`
        SELECT kind, COUNT(*) as count
        FROM discoveries
        GROUP BY kind
      `).all() as Array<{ kind: string; count: number }>;
      
      const byStatus = db.query(`
        SELECT status, COUNT(*) as count
        FROM discoveries
        GROUP BY status
      `).all() as Array<{ status: string; count: number }>;
      
      const recentCount = db.query(`
        SELECT COUNT(*) as count
        FROM discoveries
        WHERE created_at > datetime('now', '-24 hours')
      `).get() as { count: number };
      
      return c.json({
        bySeverity: bySeverity.reduce((acc, s) => ({ ...acc, [s.severity]: s.count }), {}),
        byKind: byKind.reduce((acc, k) => ({ ...acc, [k.kind]: k.count }), {}),
        byStatus: byStatus.reduce((acc, s) => ({ ...acc, [s.status]: s.count }), {}),
        recent24h: recentCount.count,
      });
    } catch (err) {
      throw HttpError.internal("Failed to get discovery stats");
    }
  });
  
  return app;
}
