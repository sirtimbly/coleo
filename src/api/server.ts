/**
 * Observatory API Server
 * 
 * Hono-based REST API for the Octopai dashboard and external integrations.
 * Arms communicate via MCP, not this API (to prevent them from affecting each other).
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { initDatabase, Database } from "../db";
import { logger, createAuthMiddleware, errorHandler } from "./middleware";
import { createSystemRoutes, createArmsRoutes, createActivityRoutes, createMailRoutes, createBrainRoutes, createConfigRoutes } from "./routes";
import { loadApiConfig, type ApiConfig } from "./config";
import { createWebSocketHandlers, getClientCount, getAuthenticatedCount, broadcast } from "./websocket";
import { HarnessManager, setGlobalHarnessManager } from "../harness";

/**
 * Clean up orphaned arms on server startup
 * 
 * When the server restarts, any arms that were running via harness manager
 * are lost (the PTY sessions were tied to the old server process).
 * This function detects such orphaned arms and marks them as stopped.
 */
async function cleanupOrphanedArms(db: Database): Promise<void> {
  const now = new Date().toISOString();
  
  // Find arms that were marked as running but whose processes are dead
  const runningArms = db.query(`
    SELECT id, name, pid, status
    FROM arms
    WHERE status IN ('idle', 'busy', 'running', 'starting')
  `).all() as Array<{ id: string; name: string; pid: number | null; status: string }>;
  
  let orphanedCount = 0;
  
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
        "UPDATE arms SET status = 'stopped', pid = NULL, updated_at = ? WHERE id = ?",
        [now, arm.id]
      );
      orphanedCount++;
    }
  }
  
  if (orphanedCount > 0) {
    console.log(`[cleanup] Cleaned up ${orphanedCount} orphaned arm(s)`);
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
  
  console.log("Initializing database...");
  const db = await initDatabase(config.dbPath);
  
  // Clean up orphaned arms from previous server sessions
  console.log("Checking for orphaned arms...");
  await cleanupOrphanedArms(db);
  
  // Initialize harness manager
  console.log("Initializing harness manager...");
  const octopaiDir = config.dbPath.replace(/\/octopai\.db$/, "");
  const harnessManager = new HarnessManager(octopaiDir);
  await harnessManager.init();
  setGlobalHarnessManager(harnessManager);
  
  // Subscribe to log events and broadcast via WebSocket
  harnessManager.onLog((armId, data) => {
    broadcast("arms", "arm.log", { armId, data });
  });
  
  console.log("Creating app...");
  const app = createApp(db, config);

  console.log(`Starting server on ${config.host}:${config.port}...`);
  
  // Check if API key was auto-generated
  if (config.apiKey.startsWith("dev-")) {
    console.log("");
    console.log("=".repeat(60));
    console.log("  DEV API KEY (set OCTOPAI_API_KEY for production):");
    console.log(`  ${config.apiKey}`);
    console.log("=".repeat(60));
    console.log("");
  }

  // Create WebSocket handlers
  const wsHandlers = createWebSocketHandlers(config.apiKey);

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

  console.log(`Server running at http://${config.host}:${config.port}`);
  console.log(`WebSocket available at ws://${config.host}:${config.port}/ws`);
  console.log(`Database: ${config.dbPath}`);

  return { server, db, config, harnessManager };
}

// Allow running directly
if (import.meta.main) {
  startServer().catch(console.error);
}
