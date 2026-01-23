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
import { getOctopaiDir } from "../config";
import { OpenCodeEventStream, filterEvent, truncateLargeFields, type OpenCodeEvent } from "./event-stream";
import { eventStore } from "../nats/jetstream";
import { createOpencodeClient, type OpencodeClient, type Session, type SessionStatus, type Message, type Part } from "@opencode-ai/sdk";
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
    const armId = config.env.OCTOPAI_ARM_ID || "unknown";

    // Find an available port
    const port = await this.findAvailablePort();

    // Detect terminal if needed
    const terminal = this.defaultTerminal || (await this.detectTerminal());

    // Build environment for OpenCode
    const octopaiDir = config.env.OCTOPAI_DIR || process.env.OCTOPAI_DIR || getOctopaiDir();
    const mcpDir = join(octopaiDir, "mcp");
    await mkdir(mcpDir, { recursive: true });

    // Get bun path
    let bunPath: string;
    try {
      bunPath = (await execAsync("which bun")).stdout.trim();
    } catch {
      bunPath = join(process.env.HOME || "", ".bun", "bin", "bun");
    }

    const bunBinary = process.execPath;
    const cliEntrypoint = join(process.cwd(), "src/cli/index.ts");

    console.log(`[harness-tui] Configuring MCP command: ${bunBinary} ${cliEntrypoint} mcp serve`);

    // Build OpenCode config
    const opencodeConfig: Record<string, unknown> = {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        octopai: {
          type: "local",
          command: [bunBinary, cliEntrypoint, "mcp", "serve"],
          environment: {
            OCTOPAI_ARM_ID: armId,
            OCTOPAI_DIR: octopaiDir,
            PATH: `${join(process.env.HOME || "", ".bun", "bin")}:${process.env.PATH || ""}`,
            HOME: process.env.HOME || "",
          },
          enabled: true,
        },
      },
    };

    // Set model if specified
    if (config.provider && config.model) {
      opencodeConfig.model = `${config.provider}/${config.model}`;
    } else if (config.model) {
      opencodeConfig.model = config.model;
    }

    // Write OpenCode config
    const opencodeConfigPath = join(mcpDir, `${armId}.json`);
    await writeFile(opencodeConfigPath, JSON.stringify(opencodeConfig, null, 2), "utf-8");
    console.log(
      `[harness-tui] Created OpenCode config at ${opencodeConfigPath}${opencodeConfig.model ? ` (model: ${opencodeConfig.model})` : ""}`
    );

    // Build environment variables
    const env: Record<string, string> = {
      OCTOPAI_ARM_ID: armId,
      OCTOPAI_DIR: octopaiDir,
      OPENCODE_CONFIG: opencodeConfigPath,
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      PATH: `${join(process.env.HOME || "", ".bun", "bin")}:${process.env.PATH || ""}`,
      HOME: process.env.HOME || "",
    };

    // OpenCode command with --port flag
    const windowTitle = `octopai:${armId}`;
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
      body: { title: `Octopai Arm: ${armId}` },
    });
    const newSession = createResponse.data;

    if (!newSession?.id) {
      throw new Error("Failed to create session: no session ID returned");
    }

    const openCodeSession = newSession;
    console.log(`[harness-tui] Created new session ${openCodeSession.id} for arm ${armId}`);

    // Initialize with model if specified
    if (config.provider && config.model) {
      try {
        await client.session.init({
          path: { id: openCodeSession.id },
          body: {
            modelID: config.model,
            providerID: config.provider,
            messageID: `init_${Date.now()}`,
          },
        });
        console.log(`[harness-tui] Initialized session with model: ${config.provider}/${config.model}`);
      } catch (initError) {
        console.log(`[harness-tui] Session init warning: ${initError}`);
      }
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
      provider: config.provider,
      model: config.model,
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
          
          // Publish to JetStream for persistence
          try {
            const subject = `octopai.events.arm.${armId}.${event.type}`;
            await eventStore.publishEvent(subject, {
              type: event.type,
              armId,
              sessionId: event.properties?.sessionID as string,
              data: truncatedProps,
              timestamp: new Date().toISOString(),
            });
          } catch (err) {
            console.error(`[harness-tui] Failed to publish event to JetStream: ${err}`);
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

    // Capture timestamp before sending so we can filter sessions updated after this point
    const timestampBeforeSend = Date.now();

    // Build the message body - include model if specified
    const messageBody: { parts: Array<{ type: "text"; text: string }>; model?: { providerID: string; modelID: string } } = {
      parts: [{ type: "text", text: prompt }],
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

    // Tell TUI to select the newest session so it displays the prompt
    // Retry for up to 5 seconds since the session may take time to appear
    await this.selectNewestSession(tuiSession, {
      sinceTimestamp: timestampBeforeSend,
      maxRetries: 10,
      retryDelayMs: 500,
    });

    console.log(`[harness-tui] Prompt sent successfully to ${tuiSession.armId}`);

    // Update activity timestamp
    tuiSession.pty.lastActivity = new Date();
  }

  /**
   * Select the newest session in the TUI
   * This ensures the TUI displays the most recent conversation after sending a prompt.
   *
   * After sending a prompt via prompt_async, the session may take a moment to appear.
   * This method retries for up to `maxRetries` attempts with `retryDelayMs` between each.
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
  async sendPromptViaApi(session: HarnessSession, prompt: string): Promise<void> {
    const tuiSession = this.sessions.get(session.id);
    if (!tuiSession) {
      throw new Error(`Session ${session.id} not found`);
    }

    console.log(`[harness-tui] Sending prompt via API to ${session.id}: "${prompt.slice(0, 50)}..."`);

    // Use SDK's async prompt endpoint
    await tuiSession.client.session.promptAsync({
      body: { parts: [{ type: "text", text: prompt }] },
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
    prompt: string
  ): Promise<{ info: Message; parts: Part[] }> {
    const tuiSession = this.sessions.get(session.id);
    if (!tuiSession) {
      throw new Error(`Session ${session.id} not found`);
    }

    console.log(`[harness-tui] Sending sync prompt to ${session.id}: "${prompt.slice(0, 50)}..."`);

    // Use SDK's prompt endpoint for synchronous response
    const response = await tuiSession.client.session.prompt({
      body: {
        parts: [{ type: "text", text: prompt }],
      },
      path: { id: tuiSession.sessionId },
    });

    if (response.error) {
      throw new Error(`Failed to send prompt: ${response.error}`);
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
        const messages = await this.getMessages(tuiSession);
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
   * Get messages from a session using SDK
   */
  private async getMessages(tuiSession: TuiHarnessSession): Promise<{ info: Message; parts: Part[] }[]> {
    const response = await tuiSession.client.session.messages({
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
      
      if (!response.error) {
        console.log(`[harness-tui] Aborted session ${session.id}`);
      }
    } catch (err) {
      console.log(`[harness-tui] Failed to abort session: ${err}`);
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

    // Always create a NEW session for recovered arm to prevent cross-contamination
    try {
      const createResponse = await client.session.create({
        body: { title: `Octopai Arm: ${armId} (recovered)` },
      });
      const recoveredSession = createResponse.data;

      if (!recoveredSession?.id) {
        console.log(`[harness-tui] Failed to create session for recovered arm`);
        return null;
      }

      console.log(`[harness-tui] Created new session ${recoveredSession.id} for recovered arm ${armId}`);

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
        sessionId: recoveredSession.id,
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
          sessionId: recoveredSession.id,
          onEvent: async (event: OpenCodeEvent) => {
            // Truncate large fields to prevent MAX_PAYLOAD_EXCEEDED
            const truncatedProps = truncateLargeFields(event.properties || {}) as Record<string, unknown>;
            
            // Publish to JetStream for persistence
            try {
              const subject = `octopai.events.arm.${armId}.${event.type}`;
              await eventStore.publishEvent(subject, {
                type: event.type,
                armId,
                sessionId: event.properties?.sessionID as string,
                data: truncatedProps,
                timestamp: new Date().toISOString(),
              });
            } catch (err) {
              console.error(`[harness-tui] Failed to publish event to JetStream: ${err}`);
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

      console.log(`[harness-tui] Recovered session for ${armId} on port ${port} (session: ${recoveredSession.id})`);
      return tuiSession;
    } catch (err) {
      console.log(`[harness-tui] Failed to recover session: ${err}`);
      return null;
    }
  }
}
