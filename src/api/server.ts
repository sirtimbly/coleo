/**
 * Observatory API Server
 * 
 * Hono-based REST API for the Octopai dashboard and external integrations.
 * Arms communicate via MCP, not this API (to prevent them from affecting each other).
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { initDatabase, Database, seedDatabase } from "../db";
import { logger, createAuthMiddleware, errorHandler } from "./middleware";
import { createSystemRoutes, createArmsRoutes, createActivityRoutes, createMailRoutes, createBrainRoutes, createConfigRoutes, createOpenCodeRoutes, createGardenRoutes, createProposalsRoutes } from "./routes";
import { loadApiConfig, shouldLog, type ApiConfig, type LogLevel } from "./config";
import { createWebSocketHandlers, getClientCount, getAuthenticatedCount, broadcast, enableHeartbeat } from "./websocket";
import { HarnessManager, setGlobalHarnessManager } from "../harness";

/**
 * Clean up orphaned arms on server startup
 * 
 * When the server restarts, any arms that were running via harness manager
 * are lost (the sessions were tied to the old server process).
 * This function detects such orphaned arms and either:
 * - Recovers them if the process is still running and has a known port
 * - Marks them as stopped if the process is dead
 */
async function cleanupOrphanedArms(db: Database, harnessManager?: HarnessManager): Promise<void> {
  const now = new Date().toISOString();
  
  // Find arms that were marked as running
  const runningArms = db.query(`
    SELECT id, name, pid, port, harness, status
    FROM arms
    WHERE status IN ('idle', 'busy', 'running', 'starting')
  `).all() as Array<{ id: string; name: string; pid: number | null; port: number | null; harness: string; status: string }>;
  
  let orphanedCount = 0;
  let recoveredCount = 0;
  
  for (const arm of runningArms) {
    let isAlive = false;
    
    if (arm.pid) {
      try {
        process.kill(arm.pid, 0);
        isAlive = true;
      } catch {
        isAlive = false;
      }
    }
    
    if (!isAlive) {
      console.log(`[cleanup] Marking orphaned arm as stopped: ${arm.name} (${arm.id})`);
      db.run(
        "UPDATE arms SET status = 'stopped', pid = NULL, port = NULL, updated_at = ? WHERE id = ?",
        [now, arm.id]
      );
      orphanedCount++;
    } else if (harnessManager && arm.port && arm.harness === "opencode-api") {
      // Try to recover the session
      console.log(`[cleanup] Attempting to recover arm: ${arm.name} (port ${arm.port})`);
      const recovered = await harnessManager.recover(arm.id, arm.harness, arm.port, arm.pid!);
      if (recovered) {
        recoveredCount++;
        console.log(`[cleanup] Successfully recovered arm: ${arm.name}`);
      } else {
        console.log(`[cleanup] Failed to recover arm: ${arm.name}, marking as stopped`);
        db.run(
          "UPDATE arms SET status = 'stopped', pid = NULL, port = NULL, updated_at = ? WHERE id = ?",
          [now, arm.id]
        );
        orphanedCount++;
      }
    } else if (isAlive) {
      // Process is alive but can't recover - just log it
      console.log(`[cleanup] Arm ${arm.name} has running process (PID ${arm.pid}) but cannot recover session`);
    }
  }
  
  if (orphanedCount > 0) {
    console.log(`[cleanup] Cleaned up ${orphanedCount} orphaned arm(s)`);
  }
  if (recoveredCount > 0) {
    console.log(`[cleanup] Recovered ${recoveredCount} arm session(s)`);
  }
}

export interface ServerContext {
  Variables: {
    db: Database;
    startedAt: Date;
  };
}

/**
 * Create and configure the Hono app
 */
export function createApp(db: Database, config: ApiConfig): Hono<ServerContext> {
  const app = new Hono<ServerContext>();
  const startedAt = new Date();

  // Inject database and start time into context
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("startedAt", startedAt);
    await next();
  });

  // Global middleware
  app.use("*", errorHandler);
  app.use("*", logger);
  app.use("*", cors({
    origin: config.corsOrigins,
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "X-API-Key"],
    credentials: true,
  }));

  // Auth middleware (skips /api/health)
  app.use("/api/*", createAuthMiddleware(config.apiKey));

  // Mount routes
  app.route("/api", createSystemRoutes());
  app.route("/api/brain", createBrainRoutes());
  app.route("/api/arms", createArmsRoutes());
  app.route("/api/activity", createActivityRoutes());
  app.route("/api/mail", createMailRoutes());
  app.route("/api/config", createConfigRoutes());
  app.route("/api/opencode", createOpenCodeRoutes());
  app.route("/api/garden", createGardenRoutes());
  app.route("/api/proposals", createProposalsRoutes());

  // Root redirect to health
  app.get("/", (c) => c.redirect("/api/health"));

  return app;
}

/**
 * Start the API server
 */
export async function startServer(configOverrides?: Partial<ApiConfig>): Promise<{
  server: ReturnType<typeof Bun.serve>;
  db: Database;
  config: ApiConfig;
  harnessManager: HarnessManager;
}> {
  const baseConfig = loadApiConfig();
  // Filter out undefined values from overrides
  const overrides = configOverrides ? 
    Object.fromEntries(Object.entries(configOverrides).filter(([_, v]) => v !== undefined)) : 
    {};
  const config = { ...baseConfig, ...overrides } as ApiConfig;
  
  const log = (msg: string, level: LogLevel = "normal") => {
    if (shouldLog(config.logLevel, level)) {
      console.log(msg);
    }
  };

  log("Initializing database...", "verbose");
  const db = await initDatabase(config.dbPath);
  
  // Seed development data if database is new (no migrations applied)
  try {
    const migrationCheck = db.query("SELECT COUNT(*) as count FROM _migrations").get() as { count: number } | null;
    if (migrationCheck && migrationCheck.count === 0) {
      await seedDatabase(db);
    }
  } catch {
    // Tables don't exist yet, seed will run after migrations
  }
  
  // Initialize harness manager first (needed for session recovery)
  log("Initializing harness manager...", "verbose");
  const octopaiDir = config.dbPath.replace(/\/octopai\.db$/, "");
  const harnessManager = new HarnessManager(octopaiDir);
  await harnessManager.init();
  setGlobalHarnessManager(harnessManager);
  
  // Now clean up/recover orphaned arms (after harness manager is ready)
  log("Checking for orphaned arms...", "verbose");
  await cleanupOrphanedArms(db, harnessManager);
  
  // Subscribe to log events and broadcast via WebSocket
  harnessManager.onLog((armId, data) => {
    broadcast("arms", "arm.log", { armId, data });
  });
  
  log("Creating app...", "verbose");
  const app = createApp(db, config);

  log(`Starting server on ${config.host}:${config.port}...`, "normal");
  
  // Check if API key was auto-generated - only show in verbose mode
  if (config.apiKey.startsWith("dev-")) {
    log("=".repeat(60), "verbose");
    log("  DEV API KEY (set OCTOPAI_API_KEY for production):", "verbose");
    log(`  ${config.apiKey}`, "verbose");
    log("=".repeat(60), "verbose");
  }

  // Create WebSocket handlers
  const wsHandlers = createWebSocketHandlers(config.apiKey, config.logLevel);
  enableHeartbeat(); // Start WebSocket cleanup heartbeat

  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    fetch(req, server) {
      // Handle WebSocket upgrade
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const upgraded = server.upgrade(req, {
          data: {
            authenticated: false,
            subscriptions: new Set(),
            lastPing: Date.now(),
          },
        });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      
      // Handle regular HTTP requests with Hono
      return app.fetch(req);
    },
    websocket: wsHandlers,
  });

  log(`Server running at http://${config.host}:${config.port}`, "normal");
  log(`WebSocket: ws://${config.host}:${config.port}/ws`, "verbose");
  log(`Database: ${config.dbPath}`, "verbose");

  return { server, db, config, harnessManager };
}

// Allow running directly
if (import.meta.main) {
  startServer().catch(console.error);
}
