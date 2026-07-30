/**
 * OpenCode TUI Harness
 *
 * Spawns OpenCode TUI in a visible terminal window (Ghostty, iTerm2, etc.)
 * and controls it via the HTTP API with /tui/* endpoints.
 *
 * This gives the best of both worlds:
 * - Visible terminal window for debugging and observability
 * - Programmatic control via well-defined HTTP API
 *
 * Uses @opencode-ai/sdk for type-safe API interactions.
 *
 * Key endpoints used:
 * - POST /tui/append-prompt - Add text to prompt
 * - POST /tui/submit-prompt - Submit the current prompt
 * - POST /tui/clear-prompt - Clear the prompt
 * - GET /tui/control/next - Wait for next control request (question/approval)
 * - POST /tui/control/response - Respond to control request
 * - GET /session/status - Check session status
 *
 * See: https://opencode.ai/docs/server/
 */

import { spawn, exec } from "child_process";
import { promisify } from "util";
import { randomBytes } from "crypto";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { getColeoDir } from "../config";
import { getCliEntrypoint } from "../cli/entrypoint";
import { OpenCodeEventStream, filterEvent, truncateLargeFields, shouldPersistEvent, type OpenCodeEvent } from "./event-stream";
import { eventStore } from "../nats/jetstream";
import { createOpencodeClient, type OpencodeClient, type Session, type SessionStatus, type Message, type Part, type Todo } from "@opencode-ai/sdk";
import { resolveModel } from "./model-resolver";
import { buildHarnessPromptParts } from "./prompt-parts";
import { getProjectRuntimeEnvironment } from "../project-scope";
import { resolveApiUrl } from "../network-config";
import { isColeoSessionForArm, shouldPruneSession } from "./session-lifecycle";

/**
 * Format an SDK error for display
 * SDK errors can be objects with name/data properties or plain strings
 */
function formatSdkError(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object') {
    const err = error as { name?: string; data?: { message?: string } };
    if (err.name && err.data?.message) {
      return `${err.name}: ${err.data.message}`;
    }
    // Try to get a meaningful string representation
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

import type {
  AgentHarness,
  HarnessSession,
  HarnessCapabilities,
  SpawnConfig,
  AgentState,
  PTYSession,
  SendPromptOptions,
} from "./types";

const execAsync = promisify(exec);

/**
 * Terminal emulator types we support
 */
type TerminalEmulator = "ghostty" | "iterm2" | "terminal" | "wezterm" | "kitty" | "tmux";

/**
 * Extended harness session for TUI-based control
 */
interface TuiHarnessSession extends HarnessSession {
  serverUrl: string;
  terminalPid?: number;
  sessionId: string;
  port: number;
  terminal: TerminalEmulator;
  eventStream?: OpenCodeEventStream;
  armId: string;
  workdir: string;
  healthCheckInterval?: ReturnType<typeof setInterval>;
  consecutiveFailures: number;
  provider?: string;
  model?: string;
  client: OpencodeClient;
}

/**
 * Control request from the TUI
 */
interface ControlRequest {
  type: "question" | "approval" | string;
  data?: unknown;
}

// Callback type for event forwarding (re-use from opencode-api)
import type { ArmEventCallback } from "./opencode-api";

// Callback type for death notification
export type ArmDeathCallback = (armId: string, reason: string) => void;

// Health check configuration
const HEALTH_CHECK_INTERVAL_MS = 5000; // Check every 5 seconds
const MAX_CONSECUTIVE_FAILURES = 3; // Mark dead after 3 failures

export class OpenCodeTuiHarness implements AgentHarness {
  name = "opencode-tui";
  version = "1.0.0";
  capabilities: HarnessCapabilities = {
    mcp: true,
    streaming: true,
    interrupt: true,
    compact: true,
    multiTurn: true,
    fileEditing: true,
    commandExecution: true,
  };

  private sessions = new Map<string, TuiHarnessSession>();
  private nextPort = 19400; // Start port for OpenCode TUI servers
  private eventCallbacks: Set<ArmEventCallback> = new Set();
  private deathCallbacks: Set<ArmDeathCallback> = new Set();
  private defaultTerminal: TerminalEmulator = "ghostty";

  private createSessionTitle(armId: string, reason: "spawn" | "recover" | "reset"): string {
    const iso = new Date().toISOString();
    if (reason === "recover") {
      return `Coleo Arm: ${armId} (recovered ${iso})`;
    }
    if (reason === "reset") {
      return `Coleo Arm: ${armId} (reset ${iso})`;
    }
    return `Coleo Arm: ${armId} (${iso})`;
  }

  private isColeoSession(session: { id?: string; title?: string }, armId: string): boolean {
    return isColeoSessionForArm(session, armId);
  }

  /**
   * Keep only the active session in this OpenCode server instance.
   * Each arm server should be isolated; stale sessions can leak confusing events.
   * Only deletes sessions that were created by Coleo for this specific arm.
   */
  private async pruneOtherSessions(
    client: OpencodeClient,
    armId: string,
    keepSessionId: string,
  ): Promise<void> {
    try {
      const sessionsResponse = await client.session.list();
      const sessions = sessionsResponse.data || [];
      for (const existing of sessions) {
        if (!shouldPruneSession(existing, armId, keepSessionId)) {
          continue;
        }
        try {
          await client.session.delete({ path: { id: existing.id } });
          console.log(`[harness-tui] Deleted stale session ${existing.id} for ${armId}`);
        } catch (err) {
          console.warn(`[harness-tui] Failed deleting stale session ${existing.id} for ${armId}: ${err}`);
        }
      }
    } catch (err) {
      console.warn(`[harness-tui] Failed listing sessions for ${armId}: ${err}`);
    }
  }

  /**
   * Check if we should resume an existing session or start fresh based on task status
   * Returns the existing session ID to resume, or null to create a new session
   */
  private async determineSessionRecoveryStrategy(
    armId: string,
    client: OpencodeClient,
  ): Promise<{ shouldResume: boolean; existingSessionId?: string; reason: string }> {
    // Query Coleo API for arm's current task
    const apiUrl = resolveApiUrl();

    try {
      // Get arm info to find current task
      const armResponse = await fetch(`${apiUrl}/api/arms/${armId}`);
      if (!armResponse.ok) {
        return { shouldResume: false, reason: "Could not fetch arm info from API" };
      }
      const armData = await armResponse.json() as { arm?: { currentTaskId?: string } };
      const currentTaskId = armData.arm?.currentTaskId;

      if (!currentTaskId) {
        return { shouldResume: false, reason: "No task assigned to arm" };
      }

      // Get task details to check status and assignment
      const taskResponse = await fetch(`${apiUrl}/api/tasks/${currentTaskId}`);
      if (!taskResponse.ok) {
        return { shouldResume: false, reason: "Could not fetch task info from API" };
      }
      const taskData = await taskResponse.json() as {
        task?: { status?: string; assignedTo?: string }
      };
      const task = taskData.task;

      if (!task) {
        return { shouldResume: false, reason: "Task not found" };
      }

      // Check if task is in_progress and assigned to this arm
      if (task.status !== "in_progress") {
        return {
          shouldResume: false,
          reason: `Task status is "${task.status}", not "in_progress"`
        };
      }

      if (task.assignedTo !== armId) {
        return {
          shouldResume: false,
          reason: `Task assigned to "${task.assignedTo}", not this arm`
        };
      }

      // Task is in_progress and assigned to this arm - try to find existing session
      const sessionsResponse = await client.session.list();
      const sessions = sessionsResponse.data || [];

      for (const session of sessions) {
        if (session?.id && this.isColeoSession(session, armId)) {
          return {
            shouldResume: true,
            existingSessionId: session.id,
            reason: `Task ${currentTaskId} is in_progress and assigned to this arm`
          };
        }
      }

      return {
        shouldResume: false,
        reason: "Task is in_progress but no existing session found"
      };
    } catch (err) {
      console.warn(`[harness-tui] Error determining recovery strategy: ${err}`);
      return { shouldResume: false, reason: `Error checking task status: ${err}` };
    }
  }

  /**
   * Set the default terminal emulator to use
   */
  setDefaultTerminal(terminal: TerminalEmulator): void {
    this.defaultTerminal = terminal;
  }

  /**
   * Add a callback to be notified when an arm dies
   */
  onDeath(callback: ArmDeathCallback): void {
    this.deathCallbacks.add(callback);
  }

  /**
   * Notify all death callbacks
   */
  private notifyDeath(armId: string, reason: string): void {
    console.log(`[harness-tui] Arm ${armId} died: ${reason}`);
    for (const callback of this.deathCallbacks) {
      try {
        callback(armId, reason);
      } catch {
        // Ignore callback errors
      }
    }
  }

  /**
   * Add a callback to receive arm events for broadcasting
   */
  setEventCallback(callback: ArmEventCallback): void {
    this.eventCallbacks.add(callback);
  }

  /**
   * Emit an event to all registered callbacks
   */
  private emitEvent(armId: string, event: string, data: unknown): void {
    for (const callback of this.eventCallbacks) {
      try {
        callback(armId, event, data);
      } catch {
        // Ignore callback errors
      }
    }
  }

  /**
   * Check if a port is available
   */
  private async isPortAvailable(port: number): Promise<boolean> {
    try {
      await fetch(`http://127.0.0.1:${port}/global/health`, {
        signal: AbortSignal.timeout(500),
      });
      // If we get a response, port is in use
      return false;
    } catch {
      // Connection refused or timeout means port is likely available
      return true;
    }
  }

  /**
   * Find an available port
   */
  private async findAvailablePort(): Promise<number> {
    const maxAttempts = 100;
    for (let i = 0; i < maxAttempts; i++) {
      const port = this.nextPort++;
      if (await this.isPortAvailable(port)) {
        return port;
      }
      console.log(`[harness-tui] Port ${port} in use, trying next...`);
    }
    throw new Error(`Could not find available port after ${maxAttempts} attempts`);
  }

  /**
   * Detect which terminal emulator is available
   */
  private async detectTerminal(): Promise<TerminalEmulator> {
    const terminals: Array<{ name: TerminalEmulator; check: string }> = [
      { name: "ghostty", check: "which ghostty" },
      { name: "wezterm", check: "which wezterm" },
      { name: "kitty", check: "which kitty" },
      { name: "iterm2", check: "ls /Applications/iTerm.app" },
      { name: "terminal", check: "ls /System/Applications/Utilities/Terminal.app" },
    ];

    for (const { name, check } of terminals) {
      try {
        await execAsync(check);
        return name;
      } catch {
        continue;
      }
    }

    return "terminal"; // Fallback to Terminal.app
  }

  /**
   * Get the command to launch a terminal with a specific command
   */
  private getTerminalCommand(
    terminal: TerminalEmulator,
    command: string,
    title: string,
    workdir: string,
    env: Record<string, string>
  ): { cmd: string; args: string[]; spawnOptions?: { env: Record<string, string> } } {
    // Build environment export string for terminals that need it
    const envExports = Object.entries(env)
      .map(([k, v]) => `export ${k}="${v.replace(/"/g, '\\"')}"`)
      .join(" && ");

    const fullCommand = envExports ? `${envExports} && ${command}` : command;

    switch (terminal) {
      case "ghostty":
        return {
          cmd: "ghostty",
          args: [
            `--title=${title}`,
            `--working-directory=${workdir}`,
            "-e",
            "bash",
            "-c",
            fullCommand,
          ],
        };

      case "wezterm":
        return {
          cmd: "wezterm",
          args: ["start", "--cwd", workdir, "--", "bash", "-c", fullCommand],
        };

      case "kitty":
        return {
          cmd: "kitty",
          args: ["--title", title, "--directory", workdir, "bash", "-c", fullCommand],
        };

      case "iterm2": {
        // iTerm2 requires AppleScript
        const script = `
          tell application "iTerm2"
            create window with default profile
            tell current session of current window
              write text "cd ${workdir} && ${fullCommand}"
            end tell
          end tell
        `;
        return {
          cmd: "osascript",
          args: ["-e", script],
        };
      }

      case "tmux":
        // Create a new tmux session for the arm
        return {
          cmd: "tmux",
          args: [
            "new-session",
            "-d", // Detached
            "-s",
            title.replace(/[^a-zA-Z0-9_-]/g, "_"), // Session name (sanitized)
            "-c",
            workdir,
            `bash -c '${fullCommand}'`,
          ],
        };

      case "terminal":
      default: {
        // Terminal.app also uses AppleScript
        const termScript = `
          tell application "Terminal"
            do script "cd ${workdir} && ${fullCommand}"
            activate
          end tell
        `;
        return {
          cmd: "osascript",
          args: ["-e", termScript],
        };
      }
    }
  }

  /**
   * Spawn a new OpenCode TUI instance in a terminal window
   */
  async spawn(config: SpawnConfig): Promise<HarnessSession> {
    const sessionId = `opencode-tui-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const armId = config.env.COLEO_ARM_ID || "unknown";

    // Find an available port
    const port = await this.findAvailablePort();

    // Detect terminal if needed
    const terminal = this.defaultTerminal || (await this.detectTerminal());

    // Resolve model - validate and fallback if needed
    // This ensures we use a model that's actually available
    let resolvedProvider = config.provider;
    let resolvedModel = config.model;
    
    if (config.provider && config.model) {
      try {
        const resolved = await resolveModel(config.provider, config.model, resolveApiUrl());
        if (resolved.fallback) {
          // Keep explicit user choice; API-side provider discovery can be stale.
          console.log(
            `[harness-tui] Keeping explicit model ${config.provider}/${config.model} ` +
            `(resolver suggested fallback ${resolved.providerId}/${resolved.modelId})`
          );
          console.log(`[harness-tui] Fallback reason: ${resolved.fallbackReason}`);
        } else {
          resolvedProvider = resolved.providerId;
          resolvedModel = resolved.modelId;
        }
      } catch (err) {
        console.log(`[harness-tui] Model resolution failed, using original: ${err}`);
        // Continue with original model - OpenCode will handle the error
      }
    }

    // Build environment for OpenCode
    const coleoDir = config.env.COLEO_DIR || process.env.COLEO_DIR || getColeoDir();
    const mcpDir = join(coleoDir, "mcp");
    await mkdir(mcpDir, { recursive: true });

    // Get bun path
    let bunPath: string;
    try {
      bunPath = (await execAsync("which bun")).stdout.trim();
    } catch {
      bunPath = join(process.env.HOME || "", ".bun", "bin", "bun");
    }

    const bunBinary = process.execPath;
    const cliEntrypoint = getCliEntrypoint();

    console.log(`[harness-tui] Configuring MCP command: ${bunBinary} ${cliEntrypoint} mcp serve`);

    // Build OpenCode config
    const opencodeConfig: Record<string, unknown> = {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        coleo: {
          type: "local",
          command: [bunBinary, cliEntrypoint, "mcp", "serve"],
          environment: {
            COLEO_ARM_ID: armId,
            COLEO_DIR: coleoDir,
            ...getProjectRuntimeEnvironment({ ...process.env, ...config.env }),
            PATH: `${join(process.env.HOME || "", ".bun", "bin")}:${process.env.PATH || ""}`,
            HOME: process.env.HOME || "",
          },
          enabled: true,
        },
      },
    };

    // Set model if specified (use resolved model if available)
    if (resolvedProvider && resolvedModel) {
      opencodeConfig.model = `${resolvedProvider}/${resolvedModel}`;
    } else if (resolvedModel) {
      opencodeConfig.model = resolvedModel;
    }

    // Write OpenCode config
    const opencodeConfigPath = join(mcpDir, `${armId}.json`);
    await writeFile(opencodeConfigPath, JSON.stringify(opencodeConfig, null, 2), "utf-8");
    console.log(
      `[harness-tui] Created OpenCode config at ${opencodeConfigPath}${opencodeConfig.model ? ` (model: ${opencodeConfig.model})` : ""}`
    );

    // Build environment variables
    const env: Record<string, string> = {
      COLEO_ARM_ID: armId,
      COLEO_DIR: coleoDir,
      OPENCODE_CONFIG: opencodeConfigPath,
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      PATH: `${join(process.env.HOME || "", ".bun", "bin")}:${process.env.PATH || ""}`,
      HOME: process.env.HOME || "",
    };

    // OpenCode command with --port flag
    const windowTitle = `coleo:${armId}`;
    const opencodeCommand = `opencode --port ${port}`;

    console.log(`[harness-tui] Starting OpenCode TUI on port ${port} for arm ${armId} in ${terminal}...`);

    // Get terminal launch command
    const { cmd, args } = this.getTerminalCommand(
      terminal,
      opencodeCommand,
      windowTitle,
      config.workdir,
      env
    );

    // Spawn the terminal
    const child = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        ...env,
      },
    });

    child.unref();

    const serverUrl = `http://127.0.0.1:${port}`;

    // Wait for server to be ready (with longer timeout since TUI takes time to start)
    await this.waitForServer(serverUrl, 60000);

    // Create SDK client for type-safe API calls
    const client = createOpencodeClient({ baseUrl: serverUrl });

    // Always create a NEW session for this arm to prevent cross-contamination
    // Each arm gets its own isolated session with a unique title
    const createResponse = await client.session.create({
      body: { title: this.createSessionTitle(armId, "spawn") },
    });
    const newSession = createResponse.data;

    if (!newSession?.id) {
      throw new Error("Failed to create session: no session ID returned");
    }

    const openCodeSession = newSession;
    console.log(`[harness-tui] Created new session ${openCodeSession.id} for arm ${armId}`);
    await this.pruneOtherSessions(client, armId, openCodeSession.id);

    // Select this session in the TUI so it displays correctly
    try {
      const selectResponse = await fetch(`${serverUrl}/tui/select-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionID: openCodeSession.id }),
      });
      if (selectResponse.ok) {
        console.log(`[harness-tui] Selected session ${openCodeSession.id} in TUI`);
      } else {
        console.log(`[harness-tui] Failed to select session in TUI: ${selectResponse.statusText}`);
      }
    } catch (selectErr) {
      console.log(`[harness-tui] Error selecting session in TUI: ${selectErr}`);
    }

    // Create dummy PTY session for compatibility
    const ptySession: PTYSession = {
      pty: null as any,
      buffer: "",
      lineBuffer: [],
      lastActivity: new Date(),
    };

    const tuiSession: TuiHarnessSession = {
      id: sessionId,
      pty: ptySession,
      harnessName: this.name,
      spawnedAt: new Date(),
      lastHeartbeat: new Date(),
      serverUrl,
      terminalPid: child.pid,
      sessionId: openCodeSession.id,
      port,
      terminal,
      armId,
      workdir: config.workdir,
      consecutiveFailures: 0,
      provider: resolvedProvider,
      model: resolvedModel,
      client,
    };

    // Start event stream subscription
    if (this.eventCallbacks.size > 0) {
      const eventStream = new OpenCodeEventStream({
        serverUrl,
        armId,
        sessionId: openCodeSession.id,
        onEvent: async (event: OpenCodeEvent) => {
          // Truncate large fields to prevent MAX_PAYLOAD_EXCEEDED
          const truncatedProps = truncateLargeFields(event.properties || {}) as Record<string, unknown>;
          
          // Check if this event should be persisted to JetStream
          const persistCheck = shouldPersistEvent(event);
          
          // Publish to JetStream for persistence (only meaningful events)
          if (persistCheck.shouldPersist && eventStore.isInitialized()) {
            try {
              const subject = `coleo.events.arm.${armId}.${event.type}`;
              await eventStore.publishEvent(subject, {
                type: event.type,
                armId,
                sessionId: event.properties?.sessionID as string,
                data: truncatedProps,
                timestamp: new Date().toISOString(),
                // Include extracted data for monitoring
                ...(persistCheck.tokenData && { tokenData: persistCheck.tokenData }),
                ...(persistCheck.fileChanges && { fileChanges: persistCheck.fileChanges }),
                ...(persistCheck.messageData && { messageData: persistCheck.messageData }),
              });
            } catch (err) {
              console.error(`[harness-tui] Failed to publish event to JetStream: ${err}`);
            }
          }

          // Also emit to legacy callbacks for backward compatibility
          this.emitEvent(armId, event.type, {
            ...truncatedProps,
            _timestamp: new Date().toISOString(),
          });
        },
        onError: (error) => {
          console.error(`[harness-tui] ${armId} event stream error:`, error.message);
        },
      });
      eventStream.start();
      tuiSession.eventStream = eventStream;
      console.log(`[harness-tui] Started event stream for ${armId}`);
    }

    // Start health check polling to detect when the process dies
    this.startHealthCheck(tuiSession);

    this.sessions.set(sessionId, tuiSession);

    console.log(
      `[harness-tui] OpenCode TUI session ${sessionId} started (port: ${port}, terminal: ${terminal}, session: ${openCodeSession.id})`
    );

    return tuiSession;
  }

  /**
   * Start health check polling for a session
   */
  private startHealthCheck(tuiSession: TuiHarnessSession): void {
    const { armId, serverUrl } = tuiSession;

    tuiSession.healthCheckInterval = setInterval(async () => {
      try {
        const response = await fetch(`${serverUrl}/global/health`, {
          signal: AbortSignal.timeout(3000),
        });

        if (response.ok) {
          const data = (await response.json()) as { healthy: boolean };
          if (data.healthy) {
            // Reset failure counter on success
            tuiSession.consecutiveFailures = 0;
            return;
          }
        }
        // Non-OK response counts as failure
        tuiSession.consecutiveFailures++;
      } catch {
        // Connection error counts as failure
        tuiSession.consecutiveFailures++;
      }

      // Check if we've exceeded the failure threshold
      if (tuiSession.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.log(`[harness-tui] Arm ${armId} health check failed ${tuiSession.consecutiveFailures} times, marking as dead`);
        
        // Stop health checking
        this.stopHealthCheck(tuiSession);
        
        // Stop event stream
        if (tuiSession.eventStream) {
          tuiSession.eventStream.stop();
        }
        
        // Remove from sessions
        this.sessions.delete(tuiSession.id);
        
        // Notify death callbacks
        this.notifyDeath(armId, `Health check failed ${tuiSession.consecutiveFailures} times`);
        
        // Emit death event
        this.emitEvent(armId, "process.died", { reason: "health_check_failed" });
      }
    }, HEALTH_CHECK_INTERVAL_MS);

    console.log(`[harness-tui] Started health check for ${armId} (every ${HEALTH_CHECK_INTERVAL_MS}ms)`);
  }

  /**
   * Stop health check polling for a session
   */
  private stopHealthCheck(tuiSession: TuiHarnessSession): void {
    if (tuiSession.healthCheckInterval) {
      clearInterval(tuiSession.healthCheckInterval);
      tuiSession.healthCheckInterval = undefined;
    }
  }

  /**
   * Wait for the OpenCode server to be ready
   */
  private async waitForServer(serverUrl: string, timeoutMs: number): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await fetch(`${serverUrl}/global/health`);
        if (response.ok) {
          const data = (await response.json()) as { healthy: boolean; version: string };
          if (data.healthy) {
            console.log(`[harness-tui] Server ready (version ${data.version})`);
            return;
          }
        }
      } catch {
        // Server not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`OpenCode server failed to start within ${timeoutMs}ms`);
  }

  /**
   * Kill an OpenCode TUI session
   */
  async kill(session: HarnessSession): Promise<void> {
    const tuiSession = this.sessions.get(session.id);
    if (!tuiSession) {
      console.log(`[harness-tui] Session ${session.id} not found`);
      return;
    }

    // Stop health check polling
    this.stopHealthCheck(tuiSession);

    // Stop the event stream
    if (tuiSession.eventStream) {
      tuiSession.eventStream.stop();
    }

    // Try to gracefully dispose via SDK
    try {
      const response = await tuiSession.client.instance.dispose();
      if (!response.error) {
        console.log(`[harness-tui] Disposed OpenCode instance via SDK`);
      }
    } catch {
      console.log(`[harness-tui] Could not dispose via SDK`);
    }

    // Kill the terminal process if we have a reference
    if (tuiSession.terminalPid) {
      try {
        process.kill(tuiSession.terminalPid);
      } catch {
        // Process might already be dead
      }
    }

    this.sessions.delete(session.id);
    console.log(`[harness-tui] OpenCode TUI session ${session.id} killed`);
  }

  /**
   * Reset the session by creating a new OpenCode session.
   * This clears the conversation context, removing any stale task references.
   * Called by the brain after an arm completes a task and needs a fresh context.
   * 
   * @returns The new OpenCode session ID
   */
  async resetSession(session: HarnessSession): Promise<string | undefined> {
    const tuiSession = this.sessions.get(session.id);
    if (!tuiSession) {
      console.log(`[harness-tui] Session ${session.id} not found for reset`);
      return undefined;
    }

    try {
      console.log(`[harness-tui] Resetting session ${session.id} - creating new OpenCode session`);
      
      // Stop the existing event stream
      if (tuiSession.eventStream) {
        tuiSession.eventStream.stop();
      }

      // Create a new OpenCode session via SDK
      const newSessionResponse = await tuiSession.client.session.create({
        body: { title: this.createSessionTitle(tuiSession.armId, "reset") },
      });
      const newSession = newSessionResponse.data;

      if (!newSession?.id) {
        console.log(`[harness-tui] Failed to create new session during reset`);
        return undefined;
      }

      const oldSessionId = tuiSession.sessionId;
      tuiSession.sessionId = newSession.id;
      tuiSession.lastHeartbeat = new Date();
      tuiSession.consecutiveFailures = 0;
      await this.pruneOtherSessions(tuiSession.client, tuiSession.armId, newSession.id);

      // Restart event stream with new session ID
      if (this.eventCallbacks.size > 0) {
        const eventStream = new OpenCodeEventStream({
          serverUrl: tuiSession.serverUrl,
          armId: tuiSession.armId,
          sessionId: newSession.id,
          onEvent: async (event: OpenCodeEvent) => {
            // Truncate large fields to prevent MAX_PAYLOAD_EXCEEDED
            const truncatedProps = truncateLargeFields(event.properties || {}) as Record<string, unknown>;
            
            // Check if this event should be persisted to JetStream
            const persistCheck = shouldPersistEvent(event);
            
            // Publish to JetStream for persistence (only meaningful events)
            if (persistCheck.shouldPersist && eventStore.isInitialized()) {
              try {
                const subject = `coleo.events.arm.${tuiSession.armId}.${event.type}`;
                await eventStore.publishEvent(subject, {
                  type: event.type,
                  armId: tuiSession.armId,
                  sessionId: event.properties?.sessionID as string,
                  data: truncatedProps,
                  timestamp: new Date().toISOString(),
                  ...(persistCheck.tokenData && { tokenData: persistCheck.tokenData }),
                  ...(persistCheck.fileChanges && { fileChanges: persistCheck.fileChanges }),
                  ...(persistCheck.messageData && { messageData: persistCheck.messageData }),
                });
              } catch (err) {
                console.error(`[harness-tui] Failed to publish event to JetStream: ${err}`);
              }
            }

            // Also emit to legacy callbacks for backward compatibility
            this.emitEvent(tuiSession.armId, event.type, {
              ...truncatedProps,
              _timestamp: new Date().toISOString(),
            });
          },
          onError: (error) => {
            console.error(`[harness-tui] ${tuiSession.armId} event stream error:`, error.message);
          },
        });
        eventStream.start();
        tuiSession.eventStream = eventStream;
      }

      // Select the new session in the TUI
      await this.selectSession(tuiSession, { maxRetries: 5, retryDelayMs: 200 });

      console.log(`[harness-tui] Session reset complete: ${oldSessionId} -> ${newSession.id}`);
      return newSession.id;
    } catch (err) {
      console.error(`[harness-tui] Failed to reset session: ${err}`);
      return undefined;
    }
  }

  /**
   * Send a prompt to OpenCode via the session API
   *
   * Uses the /session/:id/prompt_async endpoint which reliably submits
   * the prompt. The prompt will appear in the TUI conversation history.
   */
  async sendPrompt(session: HarnessSession, prompt: string, options?: SendPromptOptions): Promise<void> {
    const tuiSession = this.sessions.get(session.id);
    if (!tuiSession) {
      throw new Error(`Session ${session.id} not found`);
    }

    // If interrupt requested, abort current operation first
    if (options?.interrupt) {
      console.log(`[harness-tui] Aborting current operation before sending prompt`);
      await this.interrupt(session);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    console.log(`[harness-tui] Sending prompt to ${tuiSession.armId}: "${prompt.slice(0, 50)}..."`);

    // Build the message body - include model if specified
    const messageBody: {
      parts: ReturnType<typeof buildHarnessPromptParts>;
      model?: { providerID: string; modelID: string };
    } = {
      parts: buildHarnessPromptParts(prompt, options?.attachments),
    };

    // Pass model as object if session has provider/model set
    if (tuiSession.provider && tuiSession.model) {
      messageBody.model = {
        providerID: tuiSession.provider,
        modelID: tuiSession.model,
      };
      console.log(`[harness-tui] Using model: ${tuiSession.provider}/${tuiSession.model}`);
    }

    // Use SDK's async prompt endpoint (returns 204 No Content on success)
    await tuiSession.client.session.promptAsync({
      body: messageBody,
      path: { id: tuiSession.sessionId },
    });

    // Ensure the TUI is showing our session (the one we initialized with the model)
    await this.selectSession(tuiSession, { maxRetries: 5, retryDelayMs: 200 });

    console.log(`[harness-tui] Prompt sent successfully to ${tuiSession.armId}`);

    // Update activity timestamp
    tuiSession.pty.lastActivity = new Date();
  }

  /**
   * Select the current session in the TUI
   * This ensures the TUI displays the session we're tracking for this arm.
   *
   * After sending a prompt via prompt_async, the TUI may not automatically show it.
   * This method retries selection for up to `maxRetries` attempts.
   */
  private async selectSession(
    tuiSession: TuiHarnessSession,
    options: { maxRetries?: number; retryDelayMs?: number } = {}
  ): Promise<void> {
    const { maxRetries = 5, retryDelayMs = 200 } = options;
    const sessionId = tuiSession.sessionId;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Tell TUI to select our tracked session
        const selectResponse = await fetch(`${tuiSession.serverUrl}/tui/select-session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: sessionId }),
        });

        if (selectResponse.ok) {
          console.log(`[harness-tui] Selected session ${sessionId} (attempt ${attempt})`);
          return;
        }

        console.log(`[harness-tui] Failed to select session (attempt ${attempt}/${maxRetries}): ${selectResponse.statusText}`);
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      } catch (err) {
        console.log(`[harness-tui] Error selecting session (attempt ${attempt}/${maxRetries}): ${err}`);
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }
    }

    console.log(`[harness-tui] Failed to select session ${sessionId} after ${maxRetries} attempts`);
  }

  /**
   * Select the newest session in the TUI (legacy method)
   * This ensures the TUI displays the most recent conversation after sending a prompt.
   *
   * After sending a prompt via prompt_async, the session may take a moment to appear.
   * This method retries for up to `maxRetries` attempts with `retryDelayMs` between each.
   * 
   * @deprecated Use selectSession instead to avoid session confusion
   */
  private async selectNewestSession(
    tuiSession: TuiHarnessSession,
    options: { maxRetries?: number; retryDelayMs?: number; sinceTimestamp?: number } = {}
  ): Promise<void> {
    const { maxRetries = 10, retryDelayMs = 500, sinceTimestamp } = options;

    // Use the timestamp from just before we sent the prompt to filter sessions
    const startFilter = sinceTimestamp ?? Date.now() - 5000; // Default: sessions updated in last 5 seconds

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Get sessions updated since our timestamp (API returns sorted by most recently updated)
        const url = new URL(`${tuiSession.serverUrl}/session`);
        url.searchParams.set("start", startFilter.toString());
        url.searchParams.set("limit", "1"); // We only need the newest

        const sessionsResponse = await fetch(url.toString());
        if (!sessionsResponse.ok) {
          console.log(`[harness-tui] Failed to list sessions (attempt ${attempt}/${maxRetries}): ${sessionsResponse.statusText}`);
          if (attempt < maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
            continue;
          }
          return;
        }

        const sessions = (await sessionsResponse.json()) as Session[];

        if (sessions.length === 0) {
          // No sessions found yet, retry
          if (attempt < maxRetries) {
            console.log(`[harness-tui] No sessions found (attempt ${attempt}/${maxRetries}), retrying...`);
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
            continue;
          }
          console.log(`[harness-tui] No sessions found after ${maxRetries} attempts`);
          return;
        }

        // First session is the newest (API returns sorted by most recently updated)
        const newest = sessions[0]!;

        // Update our tracked session ID if it changed
        if (newest.id !== tuiSession.sessionId) {
          console.log(`[harness-tui] Session changed: ${tuiSession.sessionId} -> ${newest.id}`);
          tuiSession.sessionId = newest.id;
        }

        // Tell TUI to select this session
        const selectResponse = await fetch(`${tuiSession.serverUrl}/tui/select-session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: newest.id }),
        });

        if (selectResponse.ok) {
          console.log(`[harness-tui] Selected session ${newest.id} (attempt ${attempt})`);
          return;
        }

        console.log(`[harness-tui] Failed to select session (attempt ${attempt}/${maxRetries}): ${selectResponse.statusText}`);
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      } catch (err) {
        console.log(`[harness-tui] Error selecting session (attempt ${attempt}/${maxRetries}): ${err}`);
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }
    }

    console.log(`[harness-tui] Failed to select newest session after ${maxRetries} attempts`);
  }

  /**
   * Send a prompt via the session API (non-visual approach)
   *
   * Uses the SDK's prompt_async endpoint which is reliable
   * but doesn't show the prompt being typed in the TUI input field.
   */
  async sendPromptViaApi(
    session: HarnessSession,
    prompt: string,
    options?: SendPromptOptions,
  ): Promise<void> {
    const tuiSession = this.sessions.get(session.id);
    if (!tuiSession) {
      throw new Error(`Session ${session.id} not found`);
    }

    console.log(`[harness-tui] Sending prompt via API to ${session.id}: "${prompt.slice(0, 50)}..."`);

    // Use SDK's async prompt endpoint
    await tuiSession.client.session.promptAsync({
      body: { parts: buildHarnessPromptParts(prompt, options?.attachments) },
      path: { id: tuiSession.sessionId },
    });

    // Update activity timestamp
    tuiSession.pty.lastActivity = new Date();
  }

  /**
   * Send a prompt and wait for the response (synchronous)
    */
  async sendPromptSync(
    session: HarnessSession,
    prompt: string,
    options?: SendPromptOptions,
  ): Promise<{ info: Message; parts: Part[] }> {
    const tuiSession = this.sessions.get(session.id);
    if (!tuiSession) {
      throw new Error(`Session ${session.id} not found`);
    }

    console.log(`[harness-tui] Sending sync prompt to ${session.id}: "${prompt.slice(0, 50)}..."`);

    // Use SDK's prompt endpoint for synchronous response
    const response = await tuiSession.client.session.prompt({
      body: {
        parts: buildHarnessPromptParts(prompt, options?.attachments),
      },
      path: { id: tuiSession.sessionId },
    });

    if (response.error) {
      throw new Error(`Failed to send prompt: ${formatSdkError(response.error)}`);
    }

    return { info: response.data.info, parts: response.data.parts };
  }

  /**
   * Wait for OpenCode to respond and return to idle
   */
  async waitForResponse(session: HarnessSession, timeout: number = 300000): Promise<string> {
    const tuiSession = this.sessions.get(session.id);
    if (!tuiSession) {
      throw new Error(`Session ${session.id} not found`);
    }

    const startTime = Date.now();

    // Poll for idle status
    while (Date.now() - startTime < timeout) {
      const state = await this.getState(session);
      if (state === "idle") {
        // Get the last message
        const messages = await this.getMessages(session);
        if (messages.length > 0) {
          const lastMessage = messages[messages.length - 1];
          if (lastMessage && lastMessage.info.role === "assistant") {
            // Extract text from parts - TextPart has text property
            const textParts = lastMessage.parts
              .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
              .map(p => p.text || "");
            return textParts.join("\n");
          }
        }
        return "";
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`Timeout waiting for response after ${timeout}ms`);
  }

  /**
   * Wait for the next control request from the TUI (question, approval, etc.)
   */
  async waitForControlRequest(session: HarnessSession, timeout: number = 60000): Promise<ControlRequest | null> {
    const tuiSession = this.sessions.get(session.id);
    if (!tuiSession) {
      throw new Error(`Session ${session.id} not found`);
    }

    try {
      const response = await fetch(`${tuiSession.serverUrl}/tui/control/next`, {
        signal: AbortSignal.timeout(timeout),
      });

      if (!response.ok) {
        return null;
      }

      return (await response.json()) as ControlRequest;
    } catch {
      return null;
    }
  }

  /**
   * Respond to a control request (question/approval)
   */
  async respondToControl(session: HarnessSession, response: string): Promise<void> {
    const tuiSession = this.sessions.get(session.id);
    if (!tuiSession) {
      throw new Error(`Session ${session.id} not found`);
    }

    const res = await fetch(`${tuiSession.serverUrl}/tui/control/response`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: response }),
    });

    if (!res.ok) {
      throw new Error(`Failed to respond to control: ${res.statusText}`);
    }
  }

  /**
   * Respond to a permission request via SDK
   * 
   * This uses the event-based permission flow:
   * 1. permission.asked event is received via SSE
   * 2. This method responds with "once", "always", or "reject"
   * 3. permission.replied event confirms the response
   */
  async respondToPermission(
    session: HarnessSession,
    permissionId: string,
    response: "once" | "always" | "reject"
  ): Promise<void> {
    const tuiSession = this.sessions.get(session.id);
    if (!tuiSession) {
      throw new Error(`Session ${session.id} not found`);
    }

    const result = await tuiSession.client.postSessionIdPermissionsPermissionId({
      path: {
        id: tuiSession.sessionId,
        permissionID: permissionId,
      },
      body: { response },
    });

    if (!result.response.ok) {
      throw new Error(`Permission response failed: ${result.response.status}`);
    }

    console.log(`[harness-tui] Permission ${permissionId} responded with: ${response}`);
  }

  /**
   * Get messages from a session using SDK
   */
  async getMessages(
    session: HarnessSession,
    options?: { limit?: number }
  ): Promise<{ info: Message; parts: Part[] }[]> {
    const tuiSession = this.sessions.get(session.id);
    if (!tuiSession) {
      throw new Error(`Session ${session.id} not found`);
    }

    const response = await tuiSession.client.session.messages({
      path: { id: tuiSession.sessionId },
    });

    let messages = response.data || [];
    
    // Apply limit
    const limit = options?.limit;
    if (limit && limit > 0) {
      messages = messages.slice(-limit);
    }
    
    // Truncate large fields to prevent MAX_PAYLOAD_EXCEEDED errors
    return messages.map(msg => ({
      info: msg.info,
      parts: msg.parts?.map((part: Part) => {
        if (part.type === 'text' && part.text) {
          return {
            ...part,
            text: truncateLargeFields(part.text) as string
          };
        }
        return part;
      }) || []
    }));
  }

  /**
   * Get session todo list from OpenCode via SDK.
   */
  async getTodos(session: HarnessSession): Promise<Todo[]> {
    const tuiSession = this.sessions.get(session.id);
    if (!tuiSession) {
      throw new Error(`Session ${session.id} not found`);
    }

    const response = await tuiSession.client.session.todo({
      path: { id: tuiSession.sessionId },
    });

    return response.data || [];
  }

  /**
   * Wait for OpenCode to become idle
   */
  async waitForIdle(session: HarnessSession, timeout: number = 60000): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const state = await this.getState(session);
      if (state === "idle") {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`Timeout waiting for idle state after ${timeout}ms`);
  }

  /**
   * Get the current state of OpenCode via API using SDK
   */
  async getState(session: HarnessSession): Promise<AgentState> {
    const tuiSession = this.sessions.get(session.id);
    if (!tuiSession) {
      return "dead";
    }

    try {
      const response = await tuiSession.client.session.status({});
      const statuses = response.data;

      if (!statuses) {
        return "idle";
      }

      const status = statuses[tuiSession.sessionId];
      if (!status) {
        return "idle";
      }

      // The SDK returns status as { type: "idle" } | { type: "retry", ... } | { type: "busy" }
      switch (status.type) {
        case "idle":
          return "idle";
        case "retry":
        case "busy":
          return "processing";
        default:
          return "idle";
      }
    } catch {
      // Server might be down
      return "dead";
    }
  }

  /**
   * Check if OpenCode is currently processing
   */
  async isProcessing(session: HarnessSession): Promise<boolean> {
    const state = await this.getState(session);
    return state === "processing" || state === "executing";
  }

  /**
   * Interrupt/abort the current operation
   */
  async interrupt(session: HarnessSession): Promise<void> {
    const tuiSession = this.sessions.get(session.id);
    if (!tuiSession) {
      return;
    }

    try {
      const response = await tuiSession.client.session.abort({
        path: { id: tuiSession.sessionId },
      });

      if (response.error) {
        throw new Error(formatSdkError(response.error));
      }

      console.log(`[harness-tui] Aborted session ${session.id}`);
    } catch (err) {
      console.log(`[harness-tui] Failed to abort session: ${err}`);
      throw err;
    }
  }

  /**
   * Compact OpenCode's context via /compact command
   */
  async compact(session: HarnessSession): Promise<void> {
    const tuiSession = this.sessions.get(session.id);
    if (!tuiSession) {
      return;
    }

    try {
      const response = await fetch(`${tuiSession.serverUrl}/tui/execute-command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "compact" }),
      });

      if (response.ok) {
        console.log(`[harness-tui] Compacted context for session ${session.id}`);
      }
    } catch (err) {
      console.log(`[harness-tui] Failed to compact: ${err}`);
    }
  }

  /**
   * Get the PID of the terminal process
   */
  getPid(session: HarnessSession): number {
    const tuiSession = this.sessions.get(session.id);
    return tuiSession?.terminalPid ?? -1;
  }

  /**
   * Check if this harness supports MCP
   */
  hasMCP(): boolean {
    return true;
  }

  /**
   * Get the server URL for this session
   */
  getServerUrl(session: HarnessSession): string | undefined {
    const tuiSession = this.sessions.get(session.id);
    return tuiSession?.serverUrl;
  }

  /**
   * Get the OpenCode session ID
   */
  getOpenCodeSessionId(session: HarnessSession): string | undefined {
    const tuiSession = this.sessions.get(session.id);
    return tuiSession?.sessionId;
  }

  /**
   * Get the port for this session
   */
  getPort(session: HarnessSession): number | undefined {
    const tuiSession = this.sessions.get(session.id);
    return tuiSession?.port;
  }

  /**
   * Recover an existing session (for server restarts)
   */
  async recover(armId: string, port: number, _pid: number): Promise<HarnessSession | null> {
    const serverUrl = `http://127.0.0.1:${port}`;

    // Check if server is healthy before proceeding
    try {
      const response = await fetch(`${serverUrl}/global/health`);
      if (!response.ok) {
        console.log(`[harness-tui] Server on port ${port} not healthy`);
        return null;
      }
      const health = (await response.json()) as { healthy: boolean };
      if (!health.healthy) {
        console.log(`[harness-tui] Server on port ${port} reports unhealthy`);
        return null;
      }
    } catch (err) {
      console.log(`[harness-tui] Cannot connect to server on port ${port}: ${err}`);
      return null;
    }

    // Create SDK client for recovered session
    const client = createOpencodeClient({ baseUrl: serverUrl });

    // Determine whether to resume existing session or create new one based on task status
    const recoveryStrategy = await this.determineSessionRecoveryStrategy(armId, client);

    let recoveredSessionId: string;
    let isResumedSession = false;

    if (recoveryStrategy.shouldResume && recoveryStrategy.existingSessionId) {
      // Resume existing session
      recoveredSessionId = recoveryStrategy.existingSessionId;
      isResumedSession = true;
      console.log(`[harness-tui] Resuming existing session ${recoveredSessionId} for ${armId}: ${recoveryStrategy.reason}`);
    } else {
      // Create a NEW session for recovered arm
      console.log(`[harness-tui] Creating new session for recovered arm ${armId}: ${recoveryStrategy.reason}`);
      try {
        const createResponse = await client.session.create({
          body: { title: this.createSessionTitle(armId, "recover") },
        });
        const newSession = createResponse.data;

        if (!newSession?.id) {
          console.log(`[harness-tui] Failed to create session for recovered arm`);
          return null;
        }

        recoveredSessionId = newSession.id;
        console.log(`[harness-tui] Created new session ${recoveredSessionId} for recovered arm ${armId}`);
      } catch (err) {
        console.log(`[harness-tui] Failed to create new session: ${err}`);
        return null;
      }
    }

    // Prune other sessions (keep only the one we're using)
    await this.pruneOtherSessions(client, armId, recoveredSessionId);

    const sessionId = `opencode-tui-recovered-${armId}-${Date.now().toString(36)}`;

    const ptySession: PTYSession = {
      pty: null as any,
      buffer: "",
      lineBuffer: [],
      lastActivity: new Date(),
    };

    const tuiSession: TuiHarnessSession = {
      id: sessionId,
      pty: ptySession,
      harnessName: this.name,
      spawnedAt: new Date(),
      lastHeartbeat: new Date(),
      serverUrl,
      sessionId: recoveredSessionId,
      port,
      terminal: "ghostty", // Assume ghostty for recovered sessions
      armId,
      workdir: process.cwd(),
      consecutiveFailures: 0,
      client,
    };

    // Start event stream for recovered session
    if (this.eventCallbacks.size > 0) {
      const eventStream = new OpenCodeEventStream({
        serverUrl,
        armId,
        sessionId: recoveredSessionId,
        onEvent: async (event: OpenCodeEvent) => {
          // Truncate large fields to prevent MAX_PAYLOAD_EXCEEDED
          const truncatedProps = truncateLargeFields(event.properties || {}) as Record<string, unknown>;
          
          // Check if this event should be persisted to JetStream
          const persistCheck = shouldPersistEvent(event);
          
          // Publish to JetStream for persistence (only filtered events, and only if NATS is initialized)
          if (persistCheck.shouldPersist && eventStore.isInitialized()) {
            try {
              const subject = `coleo.events.arm.${armId}.${event.type}`;
              await eventStore.publishEvent(subject, {
                type: event.type,
                armId,
                sessionId: event.properties?.sessionID as string,
                data: truncatedProps,
                timestamp: new Date().toISOString(),
                ...(persistCheck.tokenData && { tokenData: persistCheck.tokenData }),
                ...(persistCheck.fileChanges && { fileChanges: persistCheck.fileChanges }),
                ...(persistCheck.messageData && { messageData: persistCheck.messageData }),
              });
            } catch (err) {
              console.error(`[harness-tui] Failed to publish event to JetStream: ${err}`);
            }
          }

          // Also emit to legacy callbacks for backward compatibility
          this.emitEvent(armId, event.type, {
            ...truncatedProps,
            _timestamp: new Date().toISOString(),
          });
        },
        onError: (error) => {
          console.error(`[harness-tui] ${armId} event stream error:`, error.message);
        },
      });
      eventStream.start();
      tuiSession.eventStream = eventStream;
      console.log(`[harness-tui] Started event stream for recovered ${armId}`);
    }

    // Start health check polling for recovered session
    this.startHealthCheck(tuiSession);

    this.sessions.set(sessionId, tuiSession);

    // Update nextPort to avoid conflicts
    if (port >= this.nextPort) {
      this.nextPort = port + 1;
    }

    console.log(`[harness-tui] Recovered session for ${armId} on port ${port} (session: ${recoveredSessionId})`);
    return tuiSession;
  }
}
