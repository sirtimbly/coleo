/**
 * Observatory API Server
 * 
 * Hono-based REST API for the Coleo dashboard and external integrations.
 * Arms communicate via MCP, not this API (to prevent them from affecting each other).
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { dirname } from "path";
import { initDatabase, Database, seedDatabase } from "../db";
import { logger, createAuthMiddleware, errorHandler } from "./middleware";
import { createSystemRoutes, createArmsRoutes, createActivityRoutes, createMailRoutes, createBrainRoutes, createConfigRoutes, createOpenCodeRoutes, createGardenRoutes, createProposalsRoutes, createTasksRoutes, createTaskDiscussionsRoutes, createAgentsRoutes, createDiscoveriesRoutes, createStatusReportsRoutes, createBugsRoutes, createEventsRoutes, createSearchRoutes } from "./routes";
import { loadApiConfig, shouldLog, type ApiConfig, type LogLevel } from "./config";
import { createWebSocketHandlers, getClientCount, getAuthenticatedCount, broadcast, broadcastArmEvent, enableHeartbeat } from "./websocket";
import { HarnessManager, setGlobalHarnessManager } from "../harness";
import { truncateLargeFields } from "../harness/event-stream";
import { NatsManager, setNatsManager, ArmClient } from "../nats";
import { loadEnvFile } from "../config/env";
import { cleanupOrphanedArms } from "./arm-cleanup";

export interface ServerContext {
  Variables: {
    db: Database;
    startedAt: Date;
  };
}

// Global ArmClient for distributed arm management
let globalArmClient: ArmClient | null = null;

export function getArmClient(): ArmClient | null {
  return globalArmClient;
}

export function setArmClient(client: ArmClient): void {
  globalArmClient = client;
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
  app.route("/api/tasks", createTasksRoutes());
  app.route("/api/tasks/:id/discussions", createTaskDiscussionsRoutes());
  app.route("/api/agents", createAgentsRoutes());
  app.route("/api/discoveries", createDiscoveriesRoutes());
  app.route("/api/status-reports", createStatusReportsRoutes());
  app.route("/api/bugs", createBugsRoutes());
  app.route("/api/events", createEventsRoutes());
  app.route("/api/search", createSearchRoutes());

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
  nats?: NatsManager;
  armClient?: ArmClient;
}> {
  await loadEnvFile();
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
  
  // Connect to NATS server (if available)
  let nats: NatsManager | undefined;
  let armClient: ArmClient | undefined;
  
  try {
    const natsUrl = process.env.COLEO_NATS_URL || 'nats://localhost:4222';
    log(`Connecting to NATS at ${natsUrl}...`, "verbose");
    
    nats = new NatsManager({ 
      url: natsUrl,
      debug: config.logLevel === "verbose",
      retryAttempts: 2,
      retryDelayMs: 500,
    });
    
    const connected = await nats.connect();
    
    if (connected) {
      setNatsManager(nats);
      log(`NATS connected at ${natsUrl}`, "normal");
      
      // Initialize ArmClient
      armClient = new ArmClient({
        natsUrl,
        debug: config.logLevel === "verbose",
        onAgentConnected: (agent) => {
          log(`[NATS] Agent connected: ${agent.agentId} (${agent.hostname})`, "normal");
          broadcast("agents", "agent.connected", agent);
        },
        onAgentDisconnected: (agentId) => {
          log(`[NATS] Agent disconnected: ${agentId}`, "normal");
          broadcast("agents", "agent.disconnected", { agentId });
        },
        onArmEvent: (event) => {
          // Forward NATS arm events to WebSocket
          if ('armId' in event) {
            broadcastArmEvent(event.armId, event.type, event);
          }
        },
      });
      
      await armClient.connect();
      setArmClient(armClient);
      log("ArmClient connected to NATS", "verbose");
    } else {
      log("NATS not available - distributed arm management disabled", "normal");
      nats = undefined;
    }
  } catch (err) {
    log(`Warning: Failed to connect to NATS: ${err}`, "normal");
    log("Distributed arm management will not be available", "normal");
    nats = undefined;
  }
  
  // Initialize harness manager first (needed for session recovery)
  log("Initializing harness manager...", "verbose");
  const coleoDir = dirname(config.dbPath);
  const harnessManager = new HarnessManager(coleoDir);
  await harnessManager.init();
  setGlobalHarnessManager(harnessManager);
  
  // Subscribe to arm events: store them and broadcast via WebSocket
  harnessManager.onEvent((armId, event, data) => {
    // Truncate large fields to prevent MAX_PAYLOAD_EXCEEDED errors
    const truncatedData = truncateLargeFields(data) as Record<string, unknown>;
    
    // Store the event in the database
    const now = new Date().toISOString();
    const eventData = JSON.stringify(truncatedData);

    try {
      const armExists = db.query("SELECT id FROM arms WHERE id = ?").get(armId) as { id: string } | null;
      if (!armExists) {
        console.warn(`[server] Skipping arm event for unknown arm: ${armId}`);
      } else {
        db.run(
          "INSERT INTO arm_events (arm_id, session_id, event_type, event_data, timestamp) VALUES (?, ?, ?, ?, ?)",
          [armId, (truncatedData as any)?.sessionId || null, event, eventData, now]
        );
      }
    } catch (err) {
      console.error(`[server] Failed to store arm event: ${err}`);
    }

    // Broadcast the event via WebSocket
    broadcastArmEvent(armId, event, truncatedData);
  });

  // Subscribe to arm death events - update database and broadcast
  harnessManager.onDeath((armId, reason) => {
    const now = new Date().toISOString();
    
    // Update arm status in database
    db.run(
      "UPDATE arms SET status = 'stopped', pid = NULL, port = NULL, updated_at = ? WHERE id = ?",
      [now, armId]
    );
    
    // Unassign any tasks assigned to this arm
    const tasksResult = db.query(
      "SELECT id, subject FROM tasks WHERE assigned_to = ? AND status IN ('pending', 'claimed')"
    ).all(armId) as Array<{ id: string; subject: string }>;
    
    if (tasksResult.length > 0) {
      db.run(
        "UPDATE tasks SET assigned_to = NULL, status = 'pending', updated_at = ? WHERE assigned_to = ? AND status IN ('pending', 'claimed')",
        [now, armId]
      );
      console.log(`[server] Unassigned ${tasksResult.length} task(s) from dead arm ${armId}`);
      
      // Broadcast task updates
      for (const task of tasksResult) {
        broadcast("tasks", "task.unassigned", { 
          taskId: task.id, 
          subject: task.subject,
          previousArm: armId, 
          reason: "arm_died" 
        });
      }
    }
    
    // Broadcast arm death
    broadcast("arms", "arm.died", { id: armId, reason, tasksUnassigned: tasksResult.length });
    console.log(`[server] Arm ${armId} died: ${reason}`);
  });
  
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

  // Prominently display the server URL
  const serverUrl = `http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`;
  console.log("");
  console.log("=".repeat(60));
  console.log("  Coleo API Server");
  console.log("=".repeat(60));
  console.log(`  URL:      ${serverUrl}`);
  console.log(`  Web UI:   cd src/web && bun run dev`);
  if (nats) {
    console.log(`  NATS:     ${nats.getServerUrl()}`);
  }
  console.log(`  API Key:  ${config.apiKey.startsWith("dev-") ? "(dev mode)" : config.apiKey.slice(0, 8) + "..."}`);
  console.log("=".repeat(60));
  console.log("");
  
  // Check if API key was auto-generated - only show in verbose mode
  if (config.apiKey.startsWith("dev-")) {
    log("=".repeat(60), "verbose");
    log("  DEV API KEY (set COLEO_API_KEY for production):", "verbose");
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
  if (nats) {
    log(`NATS: ${nats.getServerUrl()}`, "verbose");
  }

  return { server, db, config, harnessManager, nats, armClient };
}

// Allow running directly
if (import.meta.main) {
  startServer().catch(console.error);
}
