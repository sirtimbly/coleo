/**
 * Observatory API Server
 * 
 * Hono-based REST API for the Coleo dashboard and external integrations.
 * Arms communicate via MCP, not this API (to prevent them from affecting each other).
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { existsSync, statSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { initDatabase, Database, seedDatabase } from "../db";
import { apiKeyMatches, logger, createAuthMiddleware, REEF_PROXY_API_KEY_HEADER } from "./middleware";
import { formatErrorResponse } from "./middleware/error";
import { createSystemRoutes, createArmsRoutes, createActivityRoutes, createMailRoutes, createBrainRoutes, createConfigRoutes, createOpenCodeRoutes, createGardenRoutes, createProposalsRoutes, createTasksRoutes, createTaskDiscussionsRoutes, createTaskSummariesRoutes, createTaskDiffsRoutes, createAgentsRoutes, createDiscoveriesRoutes, createStatusReportsRoutes, createBugsRoutes, createEscalationRoutes, createEventsRoutes, createSearchRoutes, createStatusHistoryRoutes, createStatusSeriesRoutes, createUploadApiRoutes, createUploadContentRoutes, createOnboardingRoutes, createProjectSetupRoutes } from "./routes";
import { loadApiConfig, shouldLog, type ApiConfig, type LogLevel } from "./config";
import { createWebSocketHandlers, getClientCount, getAuthenticatedCount, broadcast, broadcastArmEvent, enableHeartbeat } from "./websocket";
import { HarnessManager, setGlobalHarnessManager } from "../harness";
import { truncateLargeFields } from "../harness/event-stream";
import { NatsManager, setNatsManager, ArmClient, startStatusHistoryConsumer } from "../nats";
import { eventStore } from "../nats/jetstream";
import { loadEnvFile } from "../config/env";
import { ensureDefaultArmTemplates, getColeoDir } from "../config";
import { cleanupOrphanedArms } from "./arm-cleanup";
import { startBrainMessageBridge } from "./brain-message-bridge";
import { qdrantStore } from "../qdrant";
import {
  initializeStatusHistoryCollection,
  processConsumedStatusHistoryEvent,
} from "../vector/indexing-pipeline";
import { getServiceStatus, startService } from "../daemon";
import { setArmClient } from "./arm-client-registry";
import { recordMessageMetrics } from "./arm-metrics";
import type { ServerContext } from "./server-context";

export { getArmClient, setArmClient } from "./arm-client-registry";
const INDEXER_AUTOSTART_ENV = "COLEO_TRANSCRIPT_INDEXER_AUTOSTART";

interface CreateAppOptions {
  webDist?: string | null;
}

export function createProxyAwareWebSocketHandlers(
  handlers: ReturnType<typeof createWebSocketHandlers>,
) {
  return {
    ...handlers,
    open(ws: Parameters<typeof handlers.open>[0]) {
      const proxyAuthenticated = ws.data.authenticated;
      handlers.open(ws);
      if (proxyAuthenticated) {
        ws.data.authenticated = true;
        ws.send(JSON.stringify({ type: "auth", success: true }));
      }
    },
    message(
      ws: Parameters<typeof handlers.message>[0],
      message: Parameters<typeof handlers.message>[1],
    ) {
      if (ws.data.authenticated) {
        try {
          const parsed = JSON.parse(message.toString()) as { type?: unknown };
          if (parsed.type === "auth") {
            ws.send(JSON.stringify({ type: "auth", success: true }));
            return;
          }
        } catch {
          // Let the standard handler return its existing invalid-message error.
        }
      }
      handlers.message(ws, message);
    },
  };
}

function findWebDist(): string | null {
  const candidates = [
    resolve(process.cwd(), "dist/web"),
    resolve(process.cwd(), "src/web/dist"),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html")) && existsSync(join(candidate, "assets"))) {
      return candidate;
    }
  }

  return null;
}

function resolveWebAsset(webDist: string, pathname: string): string | null {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const requested = resolve(webDist, `.${decodedPath}`);
  const relativePath = relative(webDist, requested);
  if (relativePath.startsWith("..") || relativePath === "") {
    return null;
  }

  return requested;
}

function webFileResponse(path: string, cacheControl: string): Response {
  const file = Bun.file(path);
  return new Response(file, {
    headers: {
      "Cache-Control": cacheControl,
      "Content-Type": file.type,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function shouldAutostartTranscriptIndexer(): boolean {
  const nodeEnv = (process.env.NODE_ENV || "").toLowerCase();
  if (nodeEnv === "test") {
    return false;
  }

  const raw = process.env[INDEXER_AUTOSTART_ENV];
  if (!raw) {
    return true;
  }

  const value = raw.trim().toLowerCase();
  return !["0", "false", "no", "off", "disabled"].includes(value);
}

async function maybeStartTranscriptIndexer(
  log: (msg: string, level?: LogLevel) => void,
  options: {
    natsReady: boolean;
    jetstreamReady: boolean;
    qdrantReady: boolean;
    quietSkips?: boolean;
  },
): Promise<void> {
  const quietSkips = options.quietSkips === true;

  if (!shouldAutostartTranscriptIndexer()) {
    if (!quietSkips) {
      log(
        `[startup] Transcript indexer autostart disabled (${INDEXER_AUTOSTART_ENV})`,
        "verbose",
      );
    }
    return;
  }

  if (!options.natsReady) {
    if (!quietSkips) {
      log("[startup] Skipping transcript indexer autostart: NATS is unavailable", "normal");
    }
    return;
  }

  if (!options.jetstreamReady) {
    if (!quietSkips) {
      log("[startup] Skipping transcript indexer autostart: JetStream EventStore is unavailable", "normal");
    }
    return;
  }

  if (!options.qdrantReady) {
    if (!quietSkips) {
      log("[startup] Skipping transcript indexer autostart: Qdrant is unavailable", "normal");
    }
    return;
  }

  try {
    const current = await getServiceStatus("indexer");
    if (current.running) {
      return;
    }

    const status = await startService("indexer");
    if (status.running) {
      log(`[startup] Transcript indexer running (PID: ${status.pid ?? "unknown"})`, "normal");
    }
  } catch (err) {
    log(`[startup] Warning: failed to start transcript indexer: ${err}`, "normal");
  }
}

export function mapHarnessEventStatus(event: string, data: unknown): string | null {
  if (event === "session.idle") {
    return "idle";
  }

  if (event === "session.error") {
    return "error";
  }

  if (event === "process.died") {
    return "stopped";
  }

  if (event === "session.status" || event === "session.updated") {
    const rawStatus = (data as { status?: unknown } | null)?.status;
    const status =
      rawStatus && typeof rawStatus === "object"
        ? (rawStatus as { type?: unknown }).type
        : rawStatus;
    if (typeof status !== "string") {
      return null;
    }

    const normalized = status.toLowerCase();
    if (normalized === "idle") return "idle";
    if (
      normalized === "busy" ||
      normalized === "processing" ||
      normalized === "executing" ||
      normalized === "running" ||
      normalized === "retry"
    ) {
      return "busy";
    }
    if (normalized === "error" || normalized === "failed") return "error";
  }

  return null;
}

/**
 * Create and configure the Hono app
 */
export function createApp(db: Database, config: ApiConfig, options: CreateAppOptions = {}): Hono<ServerContext> {
  const app = new Hono<ServerContext>();
  const startedAt = new Date();

  // Inject database and start time into context
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("startedAt", startedAt);
    await next();
  });

  // Global error handler (Hono-native path for route exceptions)
  app.onError((err, c) => formatErrorResponse(c, err));

  // Global request logging. CORS is intentionally limited to the API and
  // signed-upload routes so it does not reconstruct Bun's static file responses.
  app.use("*", logger);
  const corsMiddleware = cors({
    origin: config.corsOrigins,
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "X-API-Key", REEF_PROXY_API_KEY_HEADER],
    credentials: true,
  });
  app.use("/api/*", corsMiddleware);
  app.use("/uploads/*", corsMiddleware);

  // Auth middleware (skips /api/health)
  app.use("/api/*", createAuthMiddleware(config.apiKey));

  // Public signed upload content URLs
  app.route("/uploads", createUploadContentRoutes());

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
  app.route("/api/tasks/:id/summaries", createTaskSummariesRoutes());
  app.route("/api/tasks/:id/diffs", createTaskDiffsRoutes());
  app.route("/api/agents", createAgentsRoutes());
  app.route("/api/discoveries", createDiscoveriesRoutes());
  app.route("/api/status-reports", createStatusReportsRoutes());
  app.route("/api/bugs", createBugsRoutes());
  app.route("/api/escalations", createEscalationRoutes());
  app.route("/api/events", createEventsRoutes());
  app.route("/api/search", createSearchRoutes());
  app.route("/api/status-history", createStatusHistoryRoutes());
  app.route("/api/status-series", createStatusSeriesRoutes());
  app.route("/api/uploads", createUploadApiRoutes());
  app.route("/api/onboarding", createOnboardingRoutes());
  app.route("/api/project-setup", createProjectSetupRoutes());

  // Serve the production SPA on the same origin as the API and WebSocket.
  const webDist = options.webDist === undefined ? findWebDist() : options.webDist;
  if (webDist) {
    app.get("*", (c) => {
      const pathname = new URL(c.req.url).pathname;
      if (pathname.startsWith("/api/") || pathname === "/api" || pathname.startsWith("/uploads/")) {
        return c.notFound();
      }

      const assetPath = resolveWebAsset(webDist, pathname);
      if (assetPath && existsSync(assetPath) && statSync(assetPath).isFile()) {
        const cacheControl = pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache";
        return webFileResponse(assetPath, cacheControl);
      }

      return webFileResponse(join(webDist, "index.html"), "no-cache");
    });
  }

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

  const seededTemplates = await ensureDefaultArmTemplates(getColeoDir());
  if (seededTemplates.created.length > 0) {
    log(`[startup] Seeded ${seededTemplates.created.length} default Arm templates`, "normal");
  }

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

  // Connect to Qdrant (if available)
  try {
    await qdrantStore.initialize();
    log("Qdrant connected - semantic search enabled", "normal");
  } catch (err) {
    log(`Warning: Failed to connect to Qdrant: ${err}`, "normal");
    log("Semantic search will fall back to keyword-only until Qdrant is available", "normal");
  }
  
  // Connect to NATS server (if available)
  let nats: NatsManager | undefined;
  let armClient: ArmClient | undefined;
  
  try {
    const natsUrl = process.env.COLEO_NATS_URL || 'nats://localhost:4222';
    log(`Connecting to NATS at ${natsUrl}...`, "verbose");
    
    nats = new NatsManager({ 
      url: natsUrl,
      token: process.env.COLEO_NATS_TOKEN,
      debug: config.logLevel === "verbose",
      retryAttempts: 2,
      retryDelayMs: 500,
    });
    
    const connected = await nats.connect();
    
    if (connected) {
      setNatsManager(nats);
      log(`NATS connected at ${natsUrl}`, "normal");

      const connection = nats.getConnection();
      if (connection) {
        startBrainMessageBridge({
          connection,
          db,
          log: (message) => log(message, "verbose"),
        });
        if (qdrantStore.isInitialized()) {
          try {
            await initializeStatusHistoryCollection();
            await startStatusHistoryConsumer({
              connection,
              onEvent: processConsumedStatusHistoryEvent,
              log: (message) => log(message, "verbose"),
            });
          } catch (err) {
            log(`[startup] Status history indexer unavailable: ${err}`, "normal");
          }
        }
      }
      
      // Initialize ArmClient
      armClient = new ArmClient({
        natsUrl,
        token: process.env.COLEO_NATS_TOKEN,
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
          if (!("armId" in event)) {
            return;
          }

          const armId = event.armId;
          broadcastArmEvent(armId, event.type, event);
          const agentHost = armClient?.getAgent(event.agentId)?.hostname ?? null;

          const now = new Date().toISOString();
          const armExists = db.query("SELECT id FROM arms WHERE id = ?").get(armId) as { id: string } | null;
          if (!armExists) {
            return;
          }

          const persistDistributedEvent = (eventType: string, payload: unknown): void => {
            const truncatedData = truncateLargeFields(payload) as Record<string, unknown>;

            if (eventStore.isInitialized()) {
              eventStore
                .publishEvent(`coleo.events.arm.${armId}.${eventType}`, {
                  type: eventType,
                  armId,
                  data: truncatedData,
                  timestamp: now,
                })
                .catch((err) => {
                  console.error(`[server] Failed to publish distributed activity event: ${err}`);
                });
            }
          };

          if (event.type === "arm.status_changed") {
            db.run(
              "UPDATE arms SET status = ?, agent_id = COALESCE(?, agent_id), host = COALESCE(?, host), last_heartbeat = ?, updated_at = ? WHERE id = ?",
              [event.newStatus, event.agentId, agentHost, now, now, armId],
            );
            persistDistributedEvent("arm.status_changed", {
              from: event.oldStatus,
              to: event.newStatus,
              error: event.error,
              agentId: event.agentId,
              source: "distributed",
            });
            return;
          }

          if (event.type === "arm.killed") {
            db.run(
              "UPDATE arms SET status = 'stopped', pid = NULL, port = NULL, session_id = NULL, agent_id = NULL, host = NULL, last_heartbeat = ?, updated_at = ? WHERE id = ?",
              [now, now, armId],
            );
            persistDistributedEvent("arm.killed", {
              agentId: event.agentId,
              source: "distributed",
            });
            return;
          }

          if (event.type === "arm.spawned") {
            const state = event.state;
            db.run(
              "UPDATE arms SET status = ?, pid = ?, port = ?, session_id = ?, last_activity_at = COALESCE(?, last_activity_at), agent_id = COALESCE(?, agent_id), host = COALESCE(?, host), last_heartbeat = ?, updated_at = ? WHERE id = ?",
              [state.status, state.pid, state.port, state.sessionId, state.lastActivityAt, event.agentId, agentHost, now, now, armId],
            );
            persistDistributedEvent("arm.spawned", {
              agentId: event.agentId,
              state,
              source: "distributed",
            });
            return;
          }

          if (event.type === "arm.recovered") {
            const state = event.state;
            db.run(
              "UPDATE arms SET status = ?, pid = ?, port = ?, session_id = ?, last_activity_at = COALESCE(?, last_activity_at), agent_id = COALESCE(?, agent_id), host = COALESCE(?, host), last_heartbeat = ?, updated_at = ? WHERE id = ?",
              [state.status, state.pid, state.port, state.sessionId, state.lastActivityAt, event.agentId, agentHost, now, now, armId],
            );
            persistDistributedEvent("arm.recovered", {
              agentId: event.agentId,
              state,
              source: "distributed",
            });
            return;
          }

          if (event.type === "arm.log") {
            db.run(
              "UPDATE arms SET last_activity_at = ?, last_output_at = ?, last_heartbeat = ?, updated_at = ? WHERE id = ?",
              [now, now, now, now, armId],
            );
            persistDistributedEvent("arm.log", {
              level: event.level,
              message: event.message,
              data: event.data,
              agentId: event.agentId,
              source: "distributed",
            });
            return;
          }

          if (event.type === "arm.activity") {
            db.run(
              "UPDATE arms SET last_activity_at = ?, last_output_at = ?, last_heartbeat = ?, updated_at = ? WHERE id = ?",
              [now, now, now, now, armId],
            );
            const rawType = typeof event.activity?.type === "string" ? event.activity.type : "activity";
            const activityData =
              event.activity && typeof event.activity.data === "object" && event.activity.data !== null
                ? event.activity.data as Record<string, unknown>
                : { value: event.activity?.data };
            recordMessageMetrics(db, armId, rawType, activityData, now);
            persistDistributedEvent(rawType, {
              ...activityData,
              agentId: event.agentId,
              source: "distributed",
            });
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

  await maybeStartTranscriptIndexer(log, {
    natsReady: Boolean(nats?.ready()),
    jetstreamReady: eventStore.isInitialized(),
    qdrantReady: qdrantStore.isInitialized(),
  });

  const reconcileIntervalMs = Number.parseInt(
    process.env.COLEO_TRANSCRIPT_INDEXER_RECONCILE_MS || "30000",
    10,
  );
  if (Number.isFinite(reconcileIntervalMs) && reconcileIntervalMs > 0) {
    setInterval(() => {
      void maybeStartTranscriptIndexer(log, {
        natsReady: Boolean(nats?.ready()),
        jetstreamReady: eventStore.isInitialized(),
        qdrantReady: qdrantStore.isInitialized(),
        quietSkips: true,
      });
    }, reconcileIntervalMs);
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
    
    const now = new Date().toISOString();
    const armExists = db.query("SELECT id FROM arms WHERE id = ?").get(armId) as { id: string } | null;
    if (!armExists) {
      console.warn(`[server] Skipping arm event for unknown arm: ${armId}`);
    } else {
      recordMessageMetrics(db, armId, event, truncatedData, now);
      const nextStatus = mapHarnessEventStatus(event, data);
      if (nextStatus) {
        db.run(
          "UPDATE arms SET status = ?, last_activity_at = ?, last_output_at = ?, last_heartbeat = ?, updated_at = ? WHERE id = ?",
          [nextStatus, now, now, now, now, armId],
        );
      } else {
        db.run(
          "UPDATE arms SET last_activity_at = ?, last_output_at = ?, last_heartbeat = ?, updated_at = ? WHERE id = ?",
          [now, now, now, now, armId],
        );
      }
    }

    if (armExists && eventStore.isInitialized()) {
      eventStore
        .publishEvent(`coleo.events.arm.${armId}.${event}`, {
          type: event,
          armId,
          data: truncatedData,
          timestamp: now,
        })
        .catch((err) => {
          console.error(`[server] Failed to publish local arm event: ${err}`);
        });
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
    const now = new Date().toISOString();
    db.run(
      "UPDATE arms SET last_activity_at = ?, last_output_at = ?, last_heartbeat = ?, updated_at = ? WHERE id = ?",
      [now, now, now, now, armId],
    );
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
  console.log(`  API Key:  ${config.apiKey}`);
  console.log("=".repeat(60));
  console.log("");

  // Create WebSocket handlers
  const wsHandlers = createProxyAwareWebSocketHandlers(
    createWebSocketHandlers(config.apiKey, config.logLevel),
  );
  enableHeartbeat(); // Start WebSocket cleanup heartbeat

  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    idleTimeout: 255,
    fetch(req, server) {
      // Handle WebSocket upgrade
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        // Browsers cannot attach a custom header to a WebSocket upgrade. Reef
        // authenticates the dashboard session and injects this private header
        // while proxying the upgrade, so hosted clients never receive the key.
        const authenticated = apiKeyMatches(
          req.headers.get(REEF_PROXY_API_KEY_HEADER),
          config.apiKey,
        );
        const upgraded = server.upgrade(req, {
          data: {
            authenticated,
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
