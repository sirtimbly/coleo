/**
 * OpenCode API Harness
 * 
 * Controls OpenCode AI agent via its HTTP API server.
 * This is more reliable than PTY-based control as it uses well-defined endpoints.
 * 
 * See: https://opencode.ai/docs/server/
 */

import { spawn, type Subprocess } from "bun";
import { randomBytes } from "crypto";
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
 * Session status from OpenCode API
 */
interface SessionStatus {
  status: "idle" | "pending" | "running" | "error";
  error?: string;
}

/**
 * Session info from OpenCode API
 */
interface Session {
  id: string;
  version: string;
  projectID: string;
  directory: string;
  title: string;
  time: {
    created: number;
    updated: number;
  };
  summary?: {
    additions: number;
    deletions: number;
    files: number;
  };
}

/**
 * Message part from OpenCode API
 */
interface MessagePart {
  type: string;
  content?: string;
  [key: string]: unknown;
}

/**
 * Message info from OpenCode API
 */
interface MessageInfo {
  id: string;
  role: "user" | "assistant";
  sessionID: string;
  time: {
    created: number;
    updated: number;
  };
}

/**
 * Extended harness session for API-based control
 */
interface ApiHarnessSession extends HarnessSession {
  serverUrl: string;
  serverProcess?: Subprocess;
  sessionId: string;
  port: number;
}

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

  /**
   * Spawn a new OpenCode instance via API server
   */
  async spawn(config: SpawnConfig): Promise<HarnessSession> {
    const sessionId = `opencode-api-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const armId = config.env.OCTOPAI_ARM_ID || "unknown";
    const port = this.nextPort++;

    // Build environment for the OpenCode server
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...config.env,
      OCTOPAI_ARM_ID: armId,
    };

    // Set model if specified
    if (config.provider && config.model) {
      env.OPENCODE_MODEL = `${config.provider}/${config.model}`;
    } else if (config.model) {
      env.OPENCODE_MODEL = config.model;
    }

    console.log(`[harness-api] Starting OpenCode server on port ${port} for arm ${armId}...`);

    // Start OpenCode server
    const serverProcess = spawn(["opencode", "serve", "--port", String(port)], {
      cwd: config.workdir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const serverUrl = `http://127.0.0.1:${port}`;

    // Wait for server to be ready
    await this.waitForServer(serverUrl, 30000);

    // Create a new session
    const session = await this.createSession(serverUrl);

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
    };

    this.sessions.set(sessionId, apiSession);

    console.log(`[harness-api] OpenCode API session ${sessionId} started (server session: ${session.id})`);

    return apiSession;
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
          const data = await response.json() as { healthy: boolean; version: string };
          if (data.healthy) {
            console.log(`[harness-api] Server ready (version ${data.version})`);
            return;
          }
        }
      } catch {
        // Server not ready yet
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    throw new Error(`OpenCode server failed to start within ${timeoutMs}ms`);
  }

  /**
   * Create a new OpenCode session
   */
  private async createSession(serverUrl: string): Promise<Session> {
    const response = await fetch(`${serverUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Octopai Arm Session" }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create session: ${response.statusText}`);
    }

    return await response.json() as Session;
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

    // Kill the server process
    if (apiSession.serverProcess) {
      apiSession.serverProcess.kill();
    }

    this.sessions.delete(session.id);
    console.log(`[harness-api] OpenCode API session ${session.id} killed`);
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

    // Use async prompt endpoint so we don't block
    const response = await fetch(`${apiSession.serverUrl}/session/${apiSession.sessionId}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to send prompt: ${response.statusText}`);
    }

    // Update activity timestamp
    apiSession.pty.lastActivity = new Date();
  }

  /**
   * Send a prompt and wait for the response
   */
  async sendPromptSync(session: HarnessSession, prompt: string): Promise<{ info: MessageInfo; parts: MessagePart[] }> {
    const apiSession = this.sessions.get(session.id);
    if (!apiSession) {
      throw new Error(`Session ${session.id} not found`);
    }

    console.log(`[harness-api] Sending sync prompt to ${session.id}: "${prompt.slice(0, 50)}..."`);

    const response = await fetch(`${apiSession.serverUrl}/session/${apiSession.sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to send prompt: ${response.statusText}`);
    }

    return await response.json() as { info: MessageInfo; parts: MessagePart[] };
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
        // Get the last message
        const messages = await this.getMessages(apiSession);
        if (messages.length > 0) {
          const lastMessage = messages[messages.length - 1];
          if (lastMessage && lastMessage.info.role === "assistant") {
            // Extract text from parts
            const textParts = lastMessage.parts
              .filter(p => p.type === "text")
              .map(p => p.content || "");
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
   * Get messages from a session
   */
  private async getMessages(apiSession: ApiHarnessSession): Promise<{ info: MessageInfo; parts: MessagePart[] }[]> {
    const response = await fetch(`${apiSession.serverUrl}/session/${apiSession.sessionId}/message`);
    if (!response.ok) {
      return [];
    }
    return await response.json() as { info: MessageInfo; parts: MessagePart[] }[];
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
   * Get the current state of OpenCode via API
   */
  async getState(session: HarnessSession): Promise<AgentState> {
    const apiSession = this.sessions.get(session.id);
    if (!apiSession) {
      return "dead";
    }

    try {
      const response = await fetch(`${apiSession.serverUrl}/session/status`);
      if (!response.ok) {
        return "error";
      }

      const statuses = await response.json() as Record<string, SessionStatus>;
      const status = statuses[apiSession.sessionId];

      if (!status) {
        return "idle"; // Session exists but no status means idle
      }

      switch (status.status) {
        case "idle":
          return "idle";
        case "pending":
        case "running":
          return "processing";
        case "error":
          return "error";
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
      const response = await fetch(`${apiSession.serverUrl}/session/${apiSession.sessionId}/abort`, {
        method: "POST",
      });
      
      if (response.ok) {
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
      const response = await fetch(`${apiSession.serverUrl}/session/${apiSession.sessionId}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "compact",
          arguments: [],
        }),
      });

      if (response.ok) {
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
}
