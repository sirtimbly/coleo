/**
 * OpenCode API Harness
 *
 * Controls OpenCode AI agent via its HTTP API server.
 * This is more reliable than PTY-based control as it uses well-defined endpoints.
 * 
 * Uses @opencode-ai/sdk for type-safe API interactions.
 * 
 * See: https://opencode.ai/docs/server/
 */

import { spawn, type Subprocess } from "bun";
import { randomBytes } from "crypto";
import { join } from "node:path";
import { getOctopaiDir } from "../config";
import { OpenCodeEventStream, filterEvent, truncateLargeFields, shouldPersistEvent, type OpenCodeEvent } from "./event-stream";
import { eventStore } from "../nats/jetstream";
import { createOpencodeClient, type OpencodeClient, type Session, type SessionStatus, type Message, type Part } from "@opencode-ai/sdk";
import { resolveModel } from "./model-resolver";
import type {
	AgentHarness,
	HarnessSession,
	HarnessCapabilities,
	SpawnConfig,
	AgentState,
	PTYSession,
	SendPromptOptions,
} from "./types";

/**
 * Extended harness session for API-based control with SDK client
 */
interface ApiHarnessSession extends HarnessSession {
  serverUrl: string;
  serverProcess?: Subprocess;
  sessionId: string;
  port: number;
  eventStream?: OpenCodeEventStream;
  client: OpencodeClient;
  provider?: string;
  model?: string;
}

// Callback type for event forwarding
export type ArmEventCallback = (
	armId: string,
	event: string,
	data: unknown,
) => void;

export class OpenCodeApiHarness implements AgentHarness {
  name = "opencode-api";
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

  private sessions = new Map<string, ApiHarnessSession>();
  private nextPort = 19300; // Start port for OpenCode servers
  private eventCallbacks: Set<ArmEventCallback> = new Set();

  /**
   * Add a callback to receive arm events for broadcasting
   * Multiple callbacks are supported for multiple arms
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
      const response = await fetch(`http://127.0.0.1:${port}/global/health`, {
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
   * Find an available port starting from nextPort
   */
  private async findAvailablePort(): Promise<number> {
    const maxAttempts = 100;
    for (let i = 0; i < maxAttempts; i++) {
      const port = this.nextPort++;
      if (await this.isPortAvailable(port)) {
        return port;
      }
      console.log(`[harness-api] Port ${port} in use, trying next...`);
    }
    throw new Error(`Could not find available port after ${maxAttempts} attempts`);
  }

  /**
   * Spawn a new OpenCode instance via API server
   */
  async spawn(config: SpawnConfig): Promise<HarnessSession> {
    const sessionId = `opencode-api-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const armId = config.env.OCTOPAI_ARM_ID || "unknown";
    
    // Find an available port (handles case where old processes are still running)
    const port = await this.findAvailablePort();

    // Resolve model - validate and fallback if needed
    // This ensures we use a model that's actually available
    let resolvedProvider = config.provider;
    let resolvedModel = config.model;
    
    if (config.provider && config.model) {
      try {
        // Use Octopai API to check available models (server runs on 8080)
        const resolved = await resolveModel(config.provider, config.model, "http://localhost:8080");
        resolvedProvider = resolved.providerId;
        resolvedModel = resolved.modelId;
        
        if (resolved.fallback) {
          console.log(`[harness-api] Model fallback: ${config.provider}/${config.model} -> ${resolved.providerId}/${resolved.modelId}`);
          console.log(`[harness-api] Reason: ${resolved.fallbackReason}`);
        }
      } catch (err) {
        console.log(`[harness-api] Model resolution failed, using original: ${err}`);
        // Continue with original model - OpenCode will handle the error
      }
    }

    // Build environment for the OpenCode server
    // IMPORTANT: Include full process.env to ensure MCP servers can spawn subprocesses
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...config.env,
      OCTOPAI_ARM_ID: armId,
      // Disable SSL certificate verification to work around corporate proxies/VPNs
      // TODO: Make this configurable or find a better solution
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      // Ensure PATH includes bun for MCP servers
      PATH: `${join(process.env.HOME || "", ".bun", "bin")}:${process.env.PATH || ""}`,
    };

    // Always create OpenCode config file for this arm
    // This is the proper way to configure OpenCode (not via env vars)
    // See: https://opencode.ai/docs/models/#set-a-default
    const octopaiDir = config.env.OCTOPAI_DIR || process.env.OCTOPAI_DIR || getOctopaiDir();
    const mcpDir = join(octopaiDir, "mcp");
    
    // Ensure MCP directory exists
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(mcpDir, { recursive: true });
    
    // Try to find bun in PATH first, fall back to ~/.bun/bin/bun
    const { execSync } = await import("child_process");
    let bunPath: string;
    try {
      bunPath = execSync("which bun", { encoding: "utf-8" }).trim();
    } catch {
      bunPath = join(process.env.HOME || "", ".bun", "bin", "bun");
    }
    
    // Build the OpenCode config
    // Use /usr/bin/env to find the binary - this works better with OpenCode's spawn mechanism
    // DEBUG: Use absolute path to bun and CLI entrypoint to eliminate PATH issues
    const bunBinary = process.execPath; // Typically the bun binary
    const cliEntrypoint = join(process.cwd(), "src/cli/index.ts");
    
    console.log(`[harness-api] Configuring MCP command: ${bunBinary} run ${cliEntrypoint} mcp serve`);

    const opencodeConfig: Record<string, unknown> = {
      $schema: "https://opencode.ai/config.json",
      // Configure the Octopai MCP server for brain communication
      mcp: {
        octopai: {
          type: "local",
          // IMPORTANT: The MCP command runs relative to CWD of the OpenCode process
          // Since OpenCode runs in a temp dir, we must use absolute path to the CLI
          // NOTE: We cannot use 'bun run' here because 'bun run' looks for package.json in the current directory
          // Instead, we execute the script directly with bun
          command: [bunBinary, cliEntrypoint, "mcp", "serve"],
          environment: {
            OCTOPAI_ARM_ID: armId,
            OCTOPAI_DIR: octopaiDir,
            // Ensure PATH includes bun
            PATH: `${join(process.env.HOME || "", ".bun", "bin")}:${process.env.PATH || ""}`,
            HOME: process.env.HOME || "",
          },
          // DEBUG: Re-enable MCP with fix attempts
          enabled: true, 
        },
      },
    };

    // Set default model if provider/model specified (use resolved model)
    // Format: "provider_id/model_id" (e.g., "anthropic/claude-sonnet-4-20250514")
    if (resolvedProvider && resolvedModel) {
      opencodeConfig.model = `${resolvedProvider}/${resolvedModel}`;
    } else if (resolvedModel) {
      // If only model specified, use it directly (might include provider already)
      opencodeConfig.model = resolvedModel;
    }

    // Write OpenCode config to the MCP directory
    const opencodeConfigPath = join(mcpDir, `${armId}.json`);
    await writeFile(opencodeConfigPath, JSON.stringify(opencodeConfig, null, 2), "utf-8");
    
    // Tell OpenCode where to find the config
    env.OPENCODE_CONFIG = opencodeConfigPath;
    console.log(`[harness-api] Created OpenCode config at ${opencodeConfigPath}${opencodeConfig.model ? ` (model: ${opencodeConfig.model})` : ""}`);

    console.log(`[harness-api] Starting OpenCode server on port ${port} for arm ${armId}...`);

    // Start OpenCode server
    const serverProcess = spawn(["opencode", "serve", "--port", String(port)], {
      cwd: config.workdir, // This is usually /tmp/...
      env: {
          ...env,
          // Limit memory usage if possible (node options)
          NODE_OPTIONS: "--max-old-space-size=512",
          // Force no color to avoid escape codes in logs
          NO_COLOR: "1" 
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    // Monitor process exit
    serverProcess.exited.then((exitCode) => {
      console.log(`[harness-api] OpenCode server on port ${port} exited with code ${exitCode}`);
    });

    console.log(`[harness-api] Spawned OpenCode process PID: ${serverProcess.pid}`);

    // Stream output for debugging and logging
    const streamLog = async (stream: ReadableStream, type: "stdout" | "stderr") => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value);
          // Print to console for immediate debugging
          process.stdout.write(`[opencode-${port}-${type}] ${text}`);

          
          // Forward to PTY session if available (for logs)
          if (apiSession?.pty?.onData) {
            apiSession.pty.onData(text);
          }
        }
      } catch {
        // Ignore stream errors
      }
    };

    streamLog(serverProcess.stdout, "stdout");
    streamLog(serverProcess.stderr, "stderr");

    const serverUrl = `http://127.0.0.1:${port}`;

    // Wait for server to be ready
    await this.waitForServer(serverUrl, 30000, serverProcess);

    // Create SDK client for type-safe API calls
    const client = createOpencodeClient({ baseUrl: serverUrl });

    // Create a new session using SDK (access .data to get the actual session)
    const sessionResponse = await client.session.create({
      body: { title: "Octopai Arm Session" },
    });
    const session = sessionResponse.data;

    if (!session?.id) {
      throw new Error("Failed to create session: no session ID returned");
    }

    // Initialize session with model if specified (use resolved model)
    if (resolvedProvider && resolvedModel) {
      try {
        await client.session.init({
          path: { id: session.id },
          body: {
            modelID: resolvedModel,
            providerID: resolvedProvider,
            messageID: `init_${Date.now()}`,
          },
        });
        console.log(`[harness-api] Initialized session with model: ${resolvedProvider}/${resolvedModel}`);
      } catch (initError) {
        console.log(`[harness-api] Session init warning: ${initError}`);
      }
    }

    // Create a dummy PTY session for compatibility
    const ptySession: PTYSession = {
      pty: null as any, // No actual PTY
      buffer: "",
      lineBuffer: [],
      lastActivity: new Date(),
    };

    const apiSession: ApiHarnessSession = {
      id: sessionId,
      pty: ptySession,
      harnessName: this.name,
      spawnedAt: new Date(),
      lastHeartbeat: new Date(),
      serverUrl,
      serverProcess,
      sessionId: session.id,
      port,
      client,
      provider: resolvedProvider,
      model: resolvedModel,
    };

    // Start event stream subscription
    if (this.eventCallbacks.size > 0) {
      const eventStream = new OpenCodeEventStream({
        serverUrl,
        armId,
        sessionId: session.id,
        onEvent: async (event: OpenCodeEvent) => {
          // Truncate large fields to prevent MAX_PAYLOAD_EXCEEDED
          const truncatedProps = truncateLargeFields(event.properties || {}) as Record<string, unknown>;
          
          // Check if this event should be persisted to JetStream
          const persistCheck = shouldPersistEvent(event);
          
          // Publish to JetStream for persistence (only meaningful events)
          if (persistCheck.shouldPersist && eventStore.isInitialized()) {
            try {
              const subject = `octopai.events.arm.${armId}.${event.type}`;
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
              console.error(`[harness-api] Failed to publish event to JetStream: ${err}`);
            }
          }

          // Also emit to legacy callbacks for backward compatibility
          this.emitEvent(armId, event.type, {
            ...truncatedProps,
            _timestamp: new Date().toISOString(),
          });
        },
        onError: (error) => {
          console.error(`[harness-api] ${armId} event stream error:`, error.message);
        },
      });
      eventStream.start();
      apiSession.eventStream = eventStream;
      console.log(`[harness-api] Started event stream for ${armId}`);
    }

    this.sessions.set(sessionId, apiSession);

    console.log(`[harness-api] OpenCode API session ${sessionId} started (server session: ${session.id})`);

    return apiSession;
  }

  /**
   * Wait for the OpenCode server to be ready
   */
  private async waitForServer(serverUrl: string, timeoutMs: number, serverProcess?: Subprocess): Promise<void> {
    const startTime = Date.now();
    let lastError = "";
    
    while (Date.now() - startTime < timeoutMs) {
      // Check if process died
      if (serverProcess && serverProcess.exitCode !== null) {
        throw new Error(`OpenCode server process died with exit code ${serverProcess.exitCode}`);
      }
      
      try {
        const response = await fetch(`${serverUrl}/global/health`);
        if (response.ok) {
          const data = await response.json() as { healthy: boolean; version: string };
          if (data.healthy) {
            console.log(`[harness-api] Server ready (version ${data.version})`);
            return;
          }
        }
      } catch (err) {
        // Server not ready yet
        lastError = String(err);
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    throw new Error(`OpenCode server failed to start within ${timeoutMs}ms (last error: ${lastError})`);
  }

  /**
   * Recover/reconnect to an existing OpenCode server
   * Used when the Octopai API server restarts but OpenCode servers are still running
   */
  async recover(armId: string, port: number, pid: number): Promise<HarnessSession | null> {
    const serverUrl = `http://127.0.0.1:${port}`;
    
    // Check if server is healthy
    try {
      const healthResponse = await fetch(`${serverUrl}/global/health`);
      if (!healthResponse.ok) {
        console.log(`[harness-api] Server on port ${port} not healthy`);
        return null;
      }
      const health = await healthResponse.json() as { healthy: boolean };
      if (!health.healthy) {
        console.log(`[harness-api] Server on port ${port} reports unhealthy`);
        return null;
      }
    } catch (err) {
      console.log(`[harness-api] Cannot connect to server on port ${port}: ${err}`);
      return null;
    }

    // Create SDK client for recovered session
    const client = createOpencodeClient({ baseUrl: serverUrl });

    // Always create a NEW session for recovered arm to prevent stale context
    // Previous sessions may have old task IDs that no longer exist in the database
    try {
      console.log(`[harness-api] Creating new session for recovered arm ${armId}`);
      const newSessionResponse = await client.session.create({
        body: { title: `Octopai Arm: ${armId} (recovered)` },
      });
      const recoveredSession = newSessionResponse.data;
      
      if (!recoveredSession?.id) {
        console.log(`[harness-api] Failed to create session for recovered arm`);
        return null;
      }
      
      console.log(`[harness-api] Created new session ${recoveredSession.id} for recovered arm ${armId}`);
      
      const sessionId = `opencode-api-recovered-${armId}-${Date.now().toString(36)}`;
      
      // Create a dummy PTY session for compatibility
      const ptySession: PTYSession = {
        pty: null as any,
        buffer: "",
        lineBuffer: [],
        lastActivity: new Date(),
      };

      const apiSession: ApiHarnessSession = {
        id: sessionId,
        pty: ptySession,
        harnessName: this.name,
        spawnedAt: new Date(),
        lastHeartbeat: new Date(),
        serverUrl,
        serverProcess: undefined, // We don't have a reference to the process
        sessionId: recoveredSession.id,
        port,
        client,
      };

      // Start event stream subscription for recovered session
      if (this.eventCallbacks.size > 0) {
        const eventStream = new OpenCodeEventStream({
          serverUrl,
          armId,
          sessionId: recoveredSession.id,
          onEvent: (event: OpenCodeEvent) => {
            const { shouldBroadcast, eventName, data } = filterEvent(event);
            if (shouldBroadcast) {
              this.emitEvent(armId, eventName, data);
            }
          },
          onError: (error) => {
            console.error(`[harness-api] ${armId} event stream error:`, error.message);
          },
        });
        eventStream.start();
        apiSession.eventStream = eventStream;
        console.log(`[harness-api] Started event stream for recovered ${armId}`);
      }

      this.sessions.set(sessionId, apiSession);
      
      // Update nextPort to avoid conflicts
      if (port >= this.nextPort) {
        this.nextPort = port + 1;
      }

      console.log(`[harness-api] Recovered session for ${armId} on port ${port} (session: ${recoveredSession.id})`);
      return apiSession;
    } catch (err) {
      console.log(`[harness-api] Failed to recover session: ${err}`);
      return null;
    }
  }

  /**
   * Kill an OpenCode session
   */
  async kill(session: HarnessSession): Promise<void> {
    const apiSession = this.sessions.get(session.id);
    if (!apiSession) {
      console.log(`[harness-api] Session ${session.id} not found`);
      return;
    }

    // Stop the event stream
    if (apiSession.eventStream) {
      apiSession.eventStream.stop();
    }

    // Try to gracefully dispose via SDK first
    try {
      const response = await apiSession.client.instance.dispose();
      if (!response.error) {
        console.log(`[harness-api] Disposed OpenCode instance via SDK`);
      }
    } catch {
      // API might not be available, continue with process kill
      console.log(`[harness-api] Could not dispose via SDK, killing process directly`);
    }

    // Kill the server process if we have a reference
    if (apiSession.serverProcess) {
      try {
        apiSession.serverProcess.kill();
      } catch {
        // Process might already be dead
      }
    }

    this.sessions.delete(session.id);
    console.log(`[harness-api] OpenCode API session ${session.id} killed`);
  }

  /**
   * Reset the session by creating a new OpenCode session.
   * This clears the conversation context, removing any stale task references.
   * Called by the brain after an arm completes a task and needs a fresh context.
   * 
   * @returns The new OpenCode session ID
   */
  async resetSession(session: HarnessSession): Promise<string | undefined> {
    const apiSession = this.sessions.get(session.id);
    if (!apiSession) {
      console.log(`[harness-api] Session ${session.id} not found for reset`);
      return undefined;
    }

    try {
      console.log(`[harness-api] Resetting session ${session.id} - creating new OpenCode session`);
      
      // Stop the existing event stream
      if (apiSession.eventStream) {
        apiSession.eventStream.stop();
      }

      // Create a new OpenCode session via SDK
      const newSessionResponse = await apiSession.client.session.create({
        body: { title: `Octopai Arm Session (reset ${Date.now()})` },
      });
      const newSession = newSessionResponse.data;

      if (!newSession?.id) {
        console.log(`[harness-api] Failed to create new session during reset`);
        return undefined;
      }

      const oldSessionId = apiSession.sessionId;
      apiSession.sessionId = newSession.id;
      apiSession.lastHeartbeat = new Date();

      // Restart event stream with new session ID
      if (this.eventCallbacks.size > 0) {
        const eventStream = new OpenCodeEventStream({
          serverUrl: apiSession.serverUrl,
          armId: session.id.replace(/^opencode-api-/, ""),
          sessionId: newSession.id,
          onEvent: (event: OpenCodeEvent) => {
            const { shouldBroadcast, eventName, data } = filterEvent(event);
            if (shouldBroadcast) {
              this.emitEvent(session.id, eventName, data);
            }
          },
          onError: (error) => {
            console.error(`[harness-api] ${session.id} event stream error:`, error.message);
          },
        });
        eventStream.start();
        apiSession.eventStream = eventStream;
      }

      console.log(`[harness-api] Session reset complete: ${oldSessionId} -> ${newSession.id}`);
      return newSession.id;
    } catch (err) {
      console.error(`[harness-api] Failed to reset session: ${err}`);
      return undefined;
    }
  }

  /**
   * Send a prompt to OpenCode via API
   */
  async sendPrompt(session: HarnessSession, prompt: string, options?: SendPromptOptions): Promise<void> {
    const apiSession = this.sessions.get(session.id);
    if (!apiSession) {
      throw new Error(`Session ${session.id} not found`);
    }

    // If interrupt requested, abort any running operation first
    if (options?.interrupt) {
      console.log(`[harness-api] Aborting current operation before sending prompt`);
      await this.interrupt(session);
      // Give it a moment to process the abort
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`[harness-api] Sending prompt to ${session.id}: "${prompt.slice(0, 50)}..."`);

    // Use SDK's async prompt endpoint
    const response = await apiSession.client.session.promptAsync({
      body: {
        parts: [{ type: "text", text: prompt }],
      },
      path: { id: apiSession.sessionId },
    });

    if (response.error) {
      throw new Error(`Failed to send prompt: ${response.error}`);
    }

    // Update activity timestamp
    apiSession.pty.lastActivity = new Date();
  }

  /**
   * Send a prompt and wait for the response
   */
  async sendPromptSync(session: HarnessSession, prompt: string): Promise<{ info: Message; parts: Part[] }> {
    const apiSession = this.sessions.get(session.id);
    if (!apiSession) {
      throw new Error(`Session ${session.id} not found`);
    }

    console.log(`[harness-api] Sending sync prompt to ${session.id}: "${prompt.slice(0, 50)}..."`);

    const response = await apiSession.client.session.prompt({
      body: {
        parts: [{ type: "text", text: prompt }],
      },
      path: { id: apiSession.sessionId },
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
    const apiSession = this.sessions.get(session.id);
    if (!apiSession) {
      throw new Error(`Session ${session.id} not found`);
    }

    const startTime = Date.now();

    // Poll for idle status
    while (Date.now() - startTime < timeout) {
      const state = await this.getState(session);
      if (state === "idle") {
        // Get the last message using SDK
        const messagesResponse = await apiSession.client.session.messages({
          path: { id: apiSession.sessionId },
        });
        const messages = messagesResponse.data;
        
        if (messages && messages.length > 0) {
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

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    throw new Error(`Timeout waiting for response after ${timeout}ms`);
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
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    throw new Error(`Timeout waiting for idle state after ${timeout}ms`);
  }

  /**
   * Get the current state of OpenCode via API using SDK
   */
  async getState(session: HarnessSession): Promise<AgentState> {
    const apiSession = this.sessions.get(session.id);
    if (!apiSession) {
      return "dead";
    }

    try {
      const response = await apiSession.client.session.status({});
      const statuses = response.data;
      
      if (!statuses) {
        return "idle";
      }

      const status = statuses[apiSession.sessionId];
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
    const apiSession = this.sessions.get(session.id);
    if (!apiSession) {
      return;
    }

    try {
      const response = await apiSession.client.session.abort({
        path: { id: apiSession.sessionId },
      });
      
      if (!response.error) {
        console.log(`[harness-api] Aborted session ${session.id}`);
      }
    } catch (err) {
      console.log(`[harness-api] Failed to abort session: ${err}`);
    }
  }

  /**
   * Compact OpenCode's context via /compact command
   */
  async compact(session: HarnessSession): Promise<void> {
    const apiSession = this.sessions.get(session.id);
    if (!apiSession) {
      return;
    }

    try {
      const response = await apiSession.client.session.command({
        body: {
          command: "compact",
          arguments: "",
        },
        path: { id: apiSession.sessionId },
      });

      if (!response.error) {
        console.log(`[harness-api] Compacted context for session ${session.id}`);
      }
    } catch (err) {
      console.log(`[harness-api] Failed to compact: ${err}`);
    }
  }

  /**
   * Get the PID of the OpenCode server process
   */
  getPid(session: HarnessSession): number {
    const apiSession = this.sessions.get(session.id);
    if (!apiSession?.serverProcess) {
      return -1;
    }
    return apiSession.serverProcess.pid;
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
    const apiSession = this.sessions.get(session.id);
    return apiSession?.serverUrl;
  }

  /**
   * Get the OpenCode session ID
   */
  getOpenCodeSessionId(session: HarnessSession): string | undefined {
    const apiSession = this.sessions.get(session.id);
    return apiSession?.sessionId;
  }

  /**
   * Wait for the next control request (question, permission, approval, etc.)
   * Returns null if timeout is reached without a control request
   */
  async waitForControlRequest(session: HarnessSession, timeout: number = 60000): Promise<ControlRequest | null> {
    const apiSession = this.sessions.get(session.id);
    if (!apiSession) {
      throw new Error(`Session ${session.id} not found`);
    }

    try {
      const response = await apiSession.client.tui.control.next({
        query: { directory: process.cwd() },
      });

      if (!response.data) {
        return null;
      }

      // The response is { path: string, body: unknown }
      // The path indicates the type (e.g., "/session/{id}/permissions/{permissionID}")
      const { path, body } = response.data as { path: string; body: unknown };
      
      console.log(`[harness-api] Control request received: ${path}`);
      
      return {
        type: path.includes("/permissions/") ? "permission" : "question",
        path,
        data: body,
      };
    } catch (err) {
      // Timeout or no pending request
      console.log(`[harness-api] No control request: ${err}`);
      return null;
    }
  }

  /**
   * Respond to a control request (question/approval/permission)
   */
  async respondToControl(session: HarnessSession, response: string | ControlResponse): Promise<void> {
    const apiSession = this.sessions.get(session.id);
    if (!apiSession) {
      throw new Error(`Session ${session.id} not found`);
    }

    // If response is a string, wrap it in the expected format
    const body = typeof response === "string" ? { body: response } : response;

    const res = await apiSession.client.tui.control.response({
      body,
      query: { directory: process.cwd() },
    });

    if (res.error) {
      throw new Error(`Failed to respond to control: ${res.error}`);
    }

    console.log(`[harness-api] Control response sent`);
  }

  /**
   * Respond to a permission request specifically
   * @param permissionResponse - "once" to allow once, "always" to always allow, "reject" to deny
   */
  async respondToPermission(
    session: HarnessSession, 
    permissionId: string, 
    permissionResponse: "once" | "always" | "reject"
  ): Promise<void> {
    const apiSession = this.sessions.get(session.id);
    if (!apiSession) {
      throw new Error(`Session ${session.id} not found`);
    }

    const res = await apiSession.client.postSessionIdPermissionsPermissionId({
      path: { id: apiSession.sessionId, permissionID: permissionId },
      body: { response: permissionResponse },
      query: { directory: process.cwd() },
    });

    if (res.error) {
      throw new Error(`Failed to respond to permission: ${JSON.stringify(res.error)}`);
    }

    console.log(`[harness-api] Permission ${permissionId} responded with: ${permissionResponse}`);
  }
}

/**
 * Control request from OpenCode (question, permission, etc.)
 */
export interface ControlRequest {
  type: "question" | "permission" | string;
  path: string;
  data?: unknown;
}

/**
 * Response to a control request
 */
export interface ControlResponse {
  body?: unknown;
  [key: string]: unknown;
}
