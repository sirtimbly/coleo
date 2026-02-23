/**
 * Health and status routes
 */
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { join } from "path";
import { eventStore } from "../../nats/jetstream";
import { getServiceStatus } from "../../daemon";
import { getNatsManager } from "../../nats/server";
import { qdrantStore } from "../../qdrant";
import { Maildir } from "../../mail";
import { getColeoDir } from "../../config";

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
  app.get("/status", async (c) => {
    const db = c.get("db");
    const startedAt = c.get("startedAt");

    // Get counts from database
    let armCount = 0;
    let proposalCount = 0;
    let activityCount = 0;

    try {
      const armRow = db.query("SELECT COUNT(*) as count FROM arms").get() as { count: number } | null;
      const proposalRow = db.query("SELECT COUNT(*) as count FROM proposals WHERE status = 'open'").get() as { count: number } | null;

      armCount = armRow?.count ?? 0;
      proposalCount = proposalRow?.count ?? 0;
      
      // Get activity count from JetStream (approximate - last 24h worth of events)
      if (eventStore.isInitialized()) {
        try {
          const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
          const events = await eventStore.getRecentEvents(1000, since);
          activityCount = events.length;
        } catch {
          // Fall back to 0 if JetStream query fails
        }
      }
    } catch {
      // Tables may not exist yet
    }

    // Get detailed arm information with health status
    const armsDetails: Array<{
      id: string;
      name: string;
      status: string;
      domain: string;
      currentTask?: string;
      lastActivity?: string;
      lastHeartbeat?: string;
      health: "healthy" | "idle" | "stuck" | "stale" | "unknown";
    }> = [];
    
    try {
      const arms = db.query(`
        SELECT 
          id, name, status, domain, current_task,
          last_activity_at, last_heartbeat, updated_at
        FROM arms 
        ORDER BY last_activity_at DESC
      `).all() as Array<{
        id: string;
        name: string;
        status: string;
        domain: string;
        current_task: string | null;
        last_activity_at: string | null;
        last_heartbeat: string | null;
        updated_at: string;
      }>;

      const now = Date.now();
      for (const arm of arms) {
        let health: "healthy" | "idle" | "stuck" | "stale" | "unknown" = "unknown";
        
        // Determine health based on status and activity
        // Priority: DB status > heartbeat age > activity age > default to idle
        
        if (arm.status === "stopped" || arm.status === "error") {
          // Explicitly stopped or errored
          health = "stuck";
        } else if (arm.status === "paused") {
          // Paused arms are idle
          health = "idle";
        } else if (arm.last_heartbeat) {
          // Has heartbeat - use it to determine health
          const hbAge = now - new Date(arm.last_heartbeat).getTime();
          if (hbAge < 90000) {
            // Heartbeat within last 90 seconds - use status
            health = arm.status === "busy" ? "healthy" : "idle";
          } else if (hbAge < 300000) {
            // Heartbeat 90s-5min old - potentially stale
            health = "stale";
          } else {
            // No recent heartbeat - stuck or stopped
            health = "stuck";
          }
        } else if (arm.last_activity_at) {
          // No heartbeat but has activity - older arms or non-API harness
          const activityAge = now - new Date(arm.last_activity_at).getTime();
          if (activityAge < 300000) {
            // Activity within 5 minutes - use status
            health = arm.status === "busy" ? "healthy" : "idle";
          } else {
            // Old activity - stale
            health = "stale";
          }
        } else {
          // No heartbeat or activity - newly created or actually idle
          const createdAge = now - new Date(arm.updated_at).getTime();
          if (createdAge < 120000) {
            // Created within last 2 minutes - probably just starting up
            health = "idle";
          } else {
            // Old with no activity - unknown/stale
            health = "stale";
          }
        }

        armsDetails.push({
          id: arm.id,
          name: arm.name,
          status: arm.status,
          domain: arm.domain,
          currentTask: arm.current_task || undefined,
          lastActivity: arm.last_activity_at || undefined,
          lastHeartbeat: arm.last_heartbeat || undefined,
          health,
        });
      }
    } catch {
      // Table may not exist yet or query failed
    }

    // Check infrastructure health - read from database (updated by brain)
    const infrastructure = {
      database: { healthy: true, error: undefined as string | undefined },
      nats: { healthy: false, optional: true, error: undefined as string | undefined },
      maildir: { healthy: true, error: undefined as string | undefined },
      qdrant: { healthy: false, optional: true, error: undefined as string | undefined },
      indexer: {
        healthy: false,
        optional: true,
        running: false,
        error: undefined as string | undefined,
      },
    };

    // Read infrastructure health from database
    try {
      const healthRows = db.query(`
        SELECT component, healthy, optional, error, last_check
        FROM infrastructure_health
      `).all() as Array<{
        component: string;
        healthy: number;
        optional: number;
        error: string | null;
        last_check: string;
      }>;
      
      for (const row of healthRows) {
        const isHealthy = row.healthy === 1;
        const isOptional = row.optional === 1;
        const error = row.error || undefined;
        
        // Check if data is stale (more than 5 minutes old)
        const checkAge = Date.now() - new Date(row.last_check).getTime();
        const isStale = checkAge > 300000; // 5 minutes
        
        if (row.component === 'database') {
          infrastructure.database.healthy = isHealthy && !isStale;
          infrastructure.database.error = isStale ? "Health check stale" : error;
        } else if (row.component === 'nats') {
          infrastructure.nats.healthy = isHealthy && !isStale;
          infrastructure.nats.optional = isOptional;
          infrastructure.nats.error = isStale ? "Health check stale" : error;
        } else if (row.component === 'maildir') {
          infrastructure.maildir.healthy = isHealthy && !isStale;
          infrastructure.maildir.error = isStale ? "Health check stale" : error;
        }
      }
    } catch (err) {
      // Table may not exist yet, use defaults
      infrastructure.database.error = "Health data not available";
      infrastructure.nats.error = "Health data not available";
      infrastructure.maildir.error = "Health data not available";
    }

    // Also do a live database check
    try {
      db.query("SELECT 1").get();
      infrastructure.database.healthy = true;
      infrastructure.database.error = undefined;
    } catch (err) {
      infrastructure.database.healthy = false;
      infrastructure.database.error = err instanceof Error ? err.message : "Connection failed";
    }

    // Live NATS connectivity check from API process state
    try {
      const natsManager = getNatsManager();
      if (natsManager?.ready()) {
        infrastructure.nats.healthy = true;
        infrastructure.nats.error = undefined;
      } else {
        infrastructure.nats.healthy = false;
        infrastructure.nats.error = infrastructure.nats.error || "API is not connected to NATS";
      }
    } catch (err) {
      infrastructure.nats.healthy = false;
      infrastructure.nats.error = err instanceof Error ? err.message : "NATS status check failed";
    }

    // Live Maildir accessibility check (inbox path)
    try {
      const inbox = new Maildir(join(getColeoDir(), "mail", "inbox"));
      await inbox.list("new");
      infrastructure.maildir.healthy = true;
      infrastructure.maildir.error = undefined;
    } catch (err) {
      infrastructure.maildir.healthy = false;
      infrastructure.maildir.error = err instanceof Error ? err.message : "Maildir status check failed";
    }

    // Live Qdrant connectivity check
    try {
      await qdrantStore.listCollections();
      infrastructure.qdrant.healthy = true;
      infrastructure.qdrant.error = undefined;
    } catch (err) {
      infrastructure.qdrant.healthy = false;
      infrastructure.qdrant.error = err instanceof Error ? err.message : "Qdrant status check failed";
    }

    // Check transcript indexer service status (daemon-managed background process)
    try {
      const indexerStatus = await getServiceStatus("indexer");
      infrastructure.indexer.running = indexerStatus.running;
      infrastructure.indexer.healthy = indexerStatus.running;
      infrastructure.indexer.error = indexerStatus.running ? undefined : "Not running";
    } catch (err) {
      infrastructure.indexer.running = false;
      infrastructure.indexer.healthy = false;
      infrastructure.indexer.error = err instanceof Error ? err.message : "Status check failed";
    }

    // Check brain status from infrastructure health table
    let brainStatus: {
      running: boolean;
      lastPoll?: string;
      status?: string;
    } = { running: false };
    
    try {
      // Brain updates infrastructure_health during poll, so check if data is recent
      const healthCheck = db.query(`
        SELECT last_check FROM infrastructure_health 
        WHERE component = 'database' 
        ORDER BY last_check DESC 
        LIMIT 1
      `).get() as { last_check: string } | null;
      
      if (healthCheck) {
        const checkAge = Date.now() - new Date(healthCheck.last_check).getTime();
        // If last check was within 2 minutes, brain is probably running
        brainStatus.running = checkAge < 120000;
        brainStatus.lastPoll = healthCheck.last_check;
        brainStatus.status = brainStatus.running ? "running" : "stopped (stale data)";
      } else {
        brainStatus.status = "not started";
      }
    } catch {
      brainStatus.status = "unknown";
    }

    const overallHealth = infrastructure.database.healthy && infrastructure.maildir.healthy;

    return c.json({
      status: overallHealth ? "ok" : "degraded",
      version: "0.2.0",
      cwd: process.cwd(),
      uptime: Math.floor((Date.now() - startedAt.getTime()) / 1000),
      brain: brainStatus,
      arms: {
        total: armCount,
        healthy: armsDetails.filter(a => a.health === "healthy").length,
        idle: armsDetails.filter(a => a.health === "idle").length,
        stuck: armsDetails.filter(a => a.health === "stuck").length,
        stale: armsDetails.filter(a => a.health === "stale").length,
        details: armsDetails,
      },
      proposals: {
        open: proposalCount,
      },
      activity: {
        last24h: activityCount,
      },
      infrastructure,
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
      version: "0.2.0",
    });
  });

  return app;
}
