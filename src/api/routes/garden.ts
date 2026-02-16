/**
 * Garden routes
 *
 * Provides 3D garden topology, file claims, and activity visualization endpoints.
 * The "Garden" is a visualization of the project's file structure with ownership
 * and activity information.
 */
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { HttpError } from "../middleware";
import { releaseClaimsForInactiveArms } from "../claim-cleanup";
import { eventStore } from "../../nats/jetstream";
import { getActiveClaims, getRecentActivity, generateCoords } from "./garden-utils";

interface GardenContext {
  Variables: {
    db: Database;
  };
}

export interface GardenNode {
  path: string;
  type: "file" | "directory";
  coords: { x: number; y: number; z: number };
  owner: string | null;
  lastTouchedBy: string | null;
  lastTouchedAt: string | null;
  conflictZone: boolean;
}

export interface FileClaim {
  id: number;
  armId: string;
  filePath: string;
  claimType: "read" | "write" | "exclusive";
  claimedAt: string;
  releasedAt: string | null;
}

export interface FileActivity {
  path: string;
  armId: string;
  action: string;
  timestamp: string;
}

export function createGardenRoutes() {
  const app = new Hono<GardenContext>();

  /**
   * Get garden topology - a 3D view of file ownership and activity
   * GET /api/garden
   */
  app.get("/", async (c) => {
    const db = c.get("db");

    // Get all active claims to determine file ownership
    const claims = getActiveClaims(db);

    // Get recent file activity from JetStream
    const activity = await getRecentActivity();

    // Build nodes from claims and activity
    const nodeMap = new Map<string, GardenNode>();

    // Add nodes from claims
    for (const claim of claims) {
      if (!nodeMap.has(claim.filePath)) {
        nodeMap.set(claim.filePath, {
          path: claim.filePath,
          type: "file",
          coords: generateCoords(claim.filePath),
          owner: claim.armId,
          lastTouchedBy: claim.armId,
          lastTouchedAt: claim.claimedAt,
          conflictZone: false,
        });
      }
    }

    // Add nodes from activity
    for (const entry of activity) {
      if (entry.target && !nodeMap.has(entry.target)) {
        nodeMap.set(entry.target, {
          path: entry.target,
          type: "file",
          coords: generateCoords(entry.target),
          owner: null,
          lastTouchedBy: entry.actor,
          lastTouchedAt: entry.timestamp,
          conflictZone: false,
        });
      }
    }

    // Detect conflict zones (multiple arms claiming same file)
    const claimsByFile = new Map<string, string[]>();
    for (const claim of claims) {
      const arms = claimsByFile.get(claim.filePath) || [];
      if (!arms.includes(claim.armId)) {
        arms.push(claim.armId);
      }
      claimsByFile.set(claim.filePath, arms);
    }

    for (const [path, arms] of claimsByFile) {
      if (arms.length > 1 && nodeMap.has(path)) {
        const node = nodeMap.get(path)!;
        node.conflictZone = true;
      }
    }

    return c.json({
      nodes: Array.from(nodeMap.values()),
      stats: {
        totalFiles: nodeMap.size,
        activeClaims: claims.length,
        conflictZones: Array.from(nodeMap.values()).filter((n) => n.conflictZone).length,
      },
    });
  });

  /**
   * Get file tree with ownership markers
   * GET /api/garden/tree
   */
  app.get("/tree", (c) => {
    const db = c.get("db");
    const claims = getActiveClaims(db);

    // Build tree structure
    const tree: Record<string, { owner: string | null; claimType: string | null }> = {};

    for (const claim of claims) {
      tree[claim.filePath] = {
        owner: claim.armId,
        claimType: claim.claimType,
      };
    }

    return c.json({ tree });
  });

  /**
   * Get all active file claims
   * GET /api/garden/claims
   */
  app.get("/claims", (c) => {
    const db = c.get("db");
    const armId = c.req.query("arm");
    const filePath = c.req.query("file");

    if (armId || filePath) {
      releaseClaimsForInactiveArms(db);
    }

    let claims: FileClaim[];

    if (armId && filePath) {
      claims = db
        .query(
          `SELECT id, arm_id as armId, file_path as filePath, claim_type as claimType, 
           claimed_at as claimedAt, released_at as releasedAt
           FROM claims WHERE arm_id = ? AND file_path = ? AND released_at IS NULL`
        )
        .all(armId, filePath) as FileClaim[];
    } else if (armId) {
      claims = db
        .query(
          `SELECT id, arm_id as armId, file_path as filePath, claim_type as claimType,
           claimed_at as claimedAt, released_at as releasedAt
           FROM claims WHERE arm_id = ? AND released_at IS NULL`
        )
        .all(armId) as FileClaim[];
    } else if (filePath) {
      claims = db
        .query(
          `SELECT id, arm_id as armId, file_path as filePath, claim_type as claimType,
           claimed_at as claimedAt, released_at as releasedAt
           FROM claims WHERE file_path = ? AND released_at IS NULL`
        )
        .all(filePath) as FileClaim[];
    } else {
      claims = getActiveClaims(db);
    }

    return c.json({ claims });
  });

  /**
   * Create a new file claim
   * POST /api/garden/claims
   */
  app.post("/claims", async (c) => {
    const db = c.get("db");
    const body = await c.req.json<{
      armId: string;
      filePath: string;
      claimType?: "read" | "write" | "exclusive";
    }>();

    if (!body.armId || !body.filePath) {
      throw HttpError.badRequest("armId and filePath are required");
    }

    // Check if arm exists
    const arm = db.query("SELECT id FROM arms WHERE id = ?").get(body.armId);
    if (!arm) {
      throw HttpError.notFound(`Arm not found: ${body.armId}`);
    }

    const claimType = body.claimType || "read";
    const now = new Date().toISOString();

    const activeClaims = db
      .query(
        `SELECT arm_id as armId, claim_type as claimType
         FROM claims
         WHERE file_path = ? AND released_at IS NULL AND arm_id != ?`
      )
      .all(body.filePath, body.armId) as Array<{
      armId: string;
      claimType: "read" | "write" | "exclusive";
    }>;

    const conflictingClaims =
      claimType === "exclusive"
        ? activeClaims
        : claimType === "write"
          ? activeClaims.filter((claim) => claim.claimType === "write" || claim.claimType === "exclusive")
          : activeClaims.filter((claim) => claim.claimType === "exclusive");

    if (conflictingClaims.length > 0) {
      const conflictingArms = Array.from(new Set(conflictingClaims.map((claim) => claim.armId)));
      throw HttpError.badRequest(
        `File ${body.filePath} has conflicting claim(s) by: ${conflictingArms.join(", ")}`
      );
    }

    // Check if this arm already has a claim on this file
    const existingClaim = db
      .query("SELECT id FROM claims WHERE arm_id = ? AND file_path = ? AND released_at IS NULL")
      .get(body.armId, body.filePath);

    if (existingClaim) {
      // Update existing claim
      db.run(
        "UPDATE claims SET claim_type = ?, claimed_at = ? WHERE arm_id = ? AND file_path = ? AND released_at IS NULL",
        [claimType, now, body.armId, body.filePath]
      );
    } else {
      // Create new claim
      db.run("INSERT INTO claims (arm_id, file_path, claim_type, claimed_at) VALUES (?, ?, ?, ?)", [
        body.armId,
        body.filePath,
        claimType,
        now,
      ]);
    }

    return c.json(
      {
        claim: {
          armId: body.armId,
          filePath: body.filePath,
          claimType,
          claimedAt: now,
        },
      },
      201
    );
  });

  /**
   * Release a file claim
   * DELETE /api/garden/claims/:id
   */
  app.delete("/claims/:id", (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    const now = new Date().toISOString();
    const result = db.run("UPDATE claims SET released_at = ? WHERE id = ? AND released_at IS NULL", [
      now,
      id,
    ]);

    if (result.changes === 0) {
      throw HttpError.notFound(`Claim not found or already released: ${id}`);
    }

    return c.json({ released: true });
  });

  /**
   * Get current conflict zones
   * GET /api/garden/conflicts
   */
  app.get("/conflicts", (c) => {
    const db = c.get("db");

    // Find files with multiple active claims
    const conflicts = db
      .query(
        `SELECT file_path as path, GROUP_CONCAT(arm_id) as arms, COUNT(*) as claimCount
         FROM claims
         WHERE released_at IS NULL
         GROUP BY file_path
         HAVING COUNT(*) > 1`
      )
      .all() as Array<{ path: string; arms: string; claimCount: number }>;

    const result = conflicts.map((c) => ({
      path: c.path,
      arms: c.arms.split(","),
      claimCount: c.claimCount,
    }));

    return c.json({
      conflicts: result,
      count: result.length,
    });
  });

  /**
   * Get recent file touch activity from JetStream
   * GET /api/garden/activity
   */
  app.get("/activity", async (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);

    if (!eventStore.isInitialized()) {
      return c.json({ activity: [], message: "JetStream not available" });
    }

    try {
      const events = await eventStore.getRecentEvents(limit);
      
      // Filter to events that have file targets
      const activity = events
        .filter(e => e.data.target || e.data.filePath)
        .map(e => ({
          path: (e.data.target || e.data.filePath) as string,
          armId: e.armId || (e.data.actor as string) || "unknown",
          action: e.type,
          timestamp: e.timestamp,
        }));

      return c.json({ activity });
    } catch (err) {
      console.error("Garden activity query error:", err);
      return c.json({ activity: [] });
    }
  });

  return app;
}
