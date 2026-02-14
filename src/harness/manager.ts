/**
 * Harness Manager
 * 
 * Manages active harness sessions for the API server.
 * Sessions are stored in memory and tied to the server's lifecycle.
 */

import { mkdir, appendFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessSession, SpawnConfig, SendPromptOptions } from "./types";
import { harnessRegistry } from "./registry";
import type { AgentHarness } from "./types";
import { eventStore } from "../nats/jetstream";
import type { OpenCodeApiHarness, ArmEventCallback } from "./opencode-api";
import type { OpenCodeTuiHarness, ArmDeathCallback } from "./opencode-tui";
import { truncateLargeFields } from "./event-stream";

export type LogCallback = (armId: string, data: string) => void;
export type EventCallback = (armId: string, event: string, data: unknown) => void;
export type DeathCallback = (armId: string, reason: string) => void;

export interface ActiveSession {
  session: HarnessSession;
  harness: AgentHarness;
  armId: string;
  logFile: string;
  spawnedAt: Date;
}

/**
 * Manages all active harness sessions
 */
export class HarnessManager {
  private sessions = new Map<string, ActiveSession>();
  private coleoDir: string;
  private logsDir: string;
  private logCallbacks: Set<LogCallback> = new Set();
  private eventCallbacks: Set<EventCallback> = new Set();
  private deathCallbacks: Set<DeathCallback> = new Set();

  constructor(coleoDir: string) {
    this.coleoDir = coleoDir;
    this.logsDir = join(coleoDir, "logs");
  }

  /**
   * Initialize the manager
   */
  async init(): Promise<void> {
    await mkdir(this.logsDir, { recursive: true });
    console.log("[harness-manager] Initialized");
  }

  /**
   * Subscribe to log output from all arms
   */
  onLog(callback: LogCallback): () => void {
    this.logCallbacks.add(callback);
    return () => this.logCallbacks.delete(callback);
  }

  /**
   * Subscribe to events from all arms (OpenCode SSE events)
   */
  onEvent(callback: EventCallback): () => void {
    this.eventCallbacks.add(callback);
    return () => this.eventCallbacks.delete(callback);
  }

  /**
   * Subscribe to arm death notifications
   */
  onDeath(callback: DeathCallback): () => void {
    this.deathCallbacks.add(callback);
    return () => this.deathCallbacks.delete(callback);
  }

  /**
   * Emit log data to all subscribers
   */
  private emitLog(armId: string, data: string): void {
    for (const callback of this.logCallbacks) {
      try {
        callback(armId, data);
      } catch {
        // Ignore callback errors
      }
    }
  }

  /**
   * Emit event data to all subscribers and publish to JetStream
   */
  private async emitEvent(armId: string, event: string, data: unknown): Promise<void> {
    // Truncate large fields to prevent MAX_PAYLOAD_EXCEEDED errors
    const truncatedData = truncateLargeFields(data) as Record<string, unknown>;
    
    // Publish to JetStream for persistence (only if initialized)
    if (eventStore.isInitialized()) {
      try {
        const subject = `coleo.events.arm.${armId}.${event}`;
        await eventStore.publishEvent(subject, {
          type: event,
          armId,
          data: truncatedData,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        console.error(`[harness-manager] Failed to publish event to JetStream: ${err}`);
      }
    }

    // Emit to legacy subscribers (for backward compatibility)
    for (const callback of this.eventCallbacks) {
      try {
        callback(armId, event, truncatedData);
      } catch {
        // Ignore callback errors
      }
    }
  }

  /**
   * Emit death notification to all subscribers
   */
  private emitDeath(armId: string, reason: string): void {
    // Remove the session from our map
    this.sessions.delete(armId);
    console.log(`[harness-manager] Arm ${armId} died: ${reason}`);

    for (const callback of this.deathCallbacks) {
      try {
        callback(armId, reason);
      } catch {
        // Ignore callback errors
      }
    }
  }

  /**
   * Spawn a new arm via harness
   */
  async spawn(
    armId: string,
    agent: string,
    options: {
      workdir: string;
      provider?: string;
      model?: string;
      initialPrompt?: string;
    }
  ): Promise<ActiveSession> {
    // Check if already has a session
    if (this.sessions.has(armId)) {
      throw new Error(`Arm ${armId} already has an active session`);
    }

    // Get harness for agent type
    if (!harnessRegistry.has(agent)) {
      throw new Error(`No harness available for agent type: ${agent}`);
    }
    const harness = harnessRegistry.get(agent);

    // Set up event callback for opencode-api or opencode-tui harness
    if ((agent === "opencode-api" || agent === "opencode-tui") && this.eventCallbacks.size > 0) {
      (harness as OpenCodeApiHarness | OpenCodeTuiHarness).setEventCallback(async (armId, event, data) => {
        await this.emitEvent(armId, event, data);
      });
    }

    // Set up death callback for opencode-tui harness
    if (agent === "opencode-tui") {
      (harness as OpenCodeTuiHarness).onDeath((armId, reason) => {
        this.emitDeath(armId, reason);
      });
    }

    // Prepare spawn config
    const spawnConfig: SpawnConfig = {
      workdir: options.workdir,
      env: {
        COLEO_DIR: this.coleoDir,
        COLEO_ARM_ID: armId,
      },
      headless: true,
      mcpServers: ["coleo"],
      provider: options.provider,
      model: options.model,
    };

    // Spawn the session
    console.log(`[harness-manager] Spawning ${armId} via ${agent} harness...`);
    const session = await harness.spawn(spawnConfig);

    // Set up logging
    const logFile = join(this.logsDir, `${armId}.log`);
    session.pty.onData = async (data: string) => {
      // Write to file
      try {
        await appendFile(logFile, data);
      } catch {
        // Ignore logging errors
      }
      // Emit to subscribers (for real-time streaming)
      this.emitLog(armId, data);
    };

    // Store active session
    const activeSession: ActiveSession = {
      session,
      harness,
      armId,
      logFile,
      spawnedAt: new Date(),
    };
    this.sessions.set(armId, activeSession);

    console.log(`[harness-manager] ${armId} spawned (pid: ${harness.getPid?.(session)}, session: ${session.id})`);

    // Send initial prompt if provided - use async endpoint so we don't block spawn
    // The AI will process the prompt in the background and call MCP tools as needed
    if (options.initialPrompt) {
      console.log(`[harness-manager] Sending initial prompt to ${armId} (async)...`);
      try {
        // Reset session before sending initial prompt to ensure a fresh context
        // This prevents stale conversation history from previous sessions
        if (harness.resetSession) {
          console.log(`[harness-manager] Resetting session for ${armId} before sending initial prompt...`);
          const newSessionId = await harness.resetSession(session);
          if (newSessionId) {
            console.log(`[harness-manager] Session reset for ${armId}: new session ${newSessionId}`);
          }
          // Small delay to ensure the new session is fully ready
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        await harness.sendPrompt(session, options.initialPrompt);
        console.log(`[harness-manager] Initial prompt sent to ${armId}`);
      } catch (err) {
        console.error(`[harness-manager] Failed to send initial prompt: ${err}`);
      }
    }

    return activeSession;
  }

  /**
   * Kill an arm's harness session
   */
  async kill(armId: string): Promise<void> {
    const active = this.sessions.get(armId);
    if (!active) {
      console.log(`[harness-manager] No active session for ${armId}`);
      return;
    }

    console.log(`[harness-manager] Killing session for ${armId}...`);
    await active.harness.kill(active.session);
    this.sessions.delete(armId);
    console.log(`[harness-manager] ${armId} killed`);
  }

  /**
   * Try to recover/reconnect to an existing arm process
   * Used when the API server restarts but arm processes are still running
   */
  async recover(
    armId: string,
    harnessType: string,
    port: number,
    pid: number
  ): Promise<boolean> {
    // Check if already has a session
    if (this.sessions.has(armId)) {
      console.log(`[harness-manager] ${armId} already has active session`);
      return true;
    }

    // Only opencode-api and opencode-tui harnesses support recovery
    if (harnessType !== "opencode-api" && harnessType !== "opencode-tui") {
      console.log(`[harness-manager] Recovery not supported for harness type: ${harnessType}`);
      return false;
    }

    // Get the harness
    const harness = harnessRegistry.get(harnessType);
    if (!harness) {
      console.log(`[harness-manager] Harness not found: ${harnessType}`);
      return false;
    }

    // Set up event callback for opencode-api or opencode-tui harness
    if ((harnessType === "opencode-api" || harnessType === "opencode-tui") && this.eventCallbacks.size > 0) {
      (harness as OpenCodeApiHarness | OpenCodeTuiHarness).setEventCallback(async (armId, event, data) => {
        await this.emitEvent(armId, event, data);
      });
    }

    // Set up death callback for opencode-tui harness
    if (harnessType === "opencode-tui") {
      (harness as OpenCodeTuiHarness).onDeath((armId, reason) => {
        this.emitDeath(armId, reason);
      });
    }

    // Check if harness has recover method
    if (!('recover' in harness) || typeof (harness as any).recover !== 'function') {
      console.log(`[harness-manager] Harness ${harnessType} does not support recovery`);
      return false;
    }

    // Try to recover the session
    console.log(`[harness-manager] Attempting to recover ${armId} on port ${port}...`);
    const session = await (harness as any).recover(armId, port, pid);
    
    if (!session) {
      console.log(`[harness-manager] Failed to recover ${armId}`);
      return false;
    }

    // Set up logging
    const logFile = join(this.logsDir, `${armId}.log`);
    if (session.pty?.onData) {
      session.pty.onData = async (data: string) => {
        try {
          await appendFile(logFile, data);
        } catch {
          // Ignore logging errors
        }
        this.emitLog(armId, data);
      };
    }

    // Store active session
    const activeSession: ActiveSession = {
      session,
      harness,
      armId,
      logFile,
      spawnedAt: session.spawnedAt || new Date(),
    };

    this.sessions.set(armId, activeSession);
    console.log(`[harness-manager] Successfully recovered ${armId}`);
    return true;
  }

  /**
   * Send a prompt to an arm
   * @param options.interrupt - If true, send escape key twice before prompt to cancel current work
   */
  async sendPrompt(armId: string, prompt: string, options?: SendPromptOptions): Promise<void> {
    const active = this.sessions.get(armId);
    if (!active) {
      throw new Error(`No active session for arm ${armId}`);
    }

    await active.harness.sendPrompt(active.session, prompt, options);
  }

  /**
   * Get the state of an arm
   */
  async getState(armId: string): Promise<string> {
    const active = this.sessions.get(armId);
    if (!active) {
      return "stopped";
    }

    return active.harness.getState(active.session);
  }

  /**
   * Get structured session messages for an arm (if the harness supports it)
   */
  async getMessages(armId: string, options?: { limit?: number }): Promise<unknown[]> {
    const active = this.sessions.get(armId);
    if (!active) {
      throw new Error(`No active session for arm ${armId}`);
    }

    if (!active.harness.getMessages) {
      return [];
    }

    return active.harness.getMessages(active.session, options);
  }

  /**
   * Get structured todo items for an arm (if the harness supports it)
   */
  async getTodos(armId: string): Promise<unknown[]> {
    const active = this.sessions.get(armId);
    if (!active) {
      throw new Error(`No active session for arm ${armId}`);
    }

    if (!active.harness.getTodos) {
      return [];
    }

    return active.harness.getTodos(active.session);
  }

  /**
   * Check if an arm has an active session
   */
  hasSession(armId: string): boolean {
    return this.sessions.has(armId);
  }

  /**
   * Get session info for an arm
   */
  getSession(armId: string): ActiveSession | undefined {
    return this.sessions.get(armId);
  }

  /**
   * Get PID for an arm's session
   */
  getPid(armId: string): number | undefined {
    const active = this.sessions.get(armId);
    if (!active || !active.harness.getPid) {
      return undefined;
    }
    return active.harness.getPid(active.session);
  }

  /**
   * Get port for an arm's session (for API harnesses)
   */
  getPort(armId: string): number | undefined {
    const active = this.sessions.get(armId);
    if (!active) {
      return undefined;
    }
    // Check if session has a port property (API harness sessions do)
    const session = active.session as { port?: number };
    return session.port;
  }

  /**
   * Reset an arm's OpenCode session to clear stale context.
   * Creates a new OpenCode session while keeping the same harness process.
   * This is used by the brain after task completion to ensure fresh context
   * for the next task assignment.
   * 
   * @returns The new session ID, or undefined if reset failed
   */
  async resetSession(armId: string): Promise<string | undefined> {
    const active = this.sessions.get(armId);
    if (!active) {
      console.log(`[harness-manager] No active session for arm ${armId}, cannot reset`);
      return undefined;
    }

    // Check if the harness supports resetSession
    if (!active.harness.resetSession) {
      console.log(`[harness-manager] Harness ${active.harness.name} does not support resetSession`);
      return undefined;
    }

    console.log(`[harness-manager] Resetting session for arm ${armId}...`);
    const newSessionId = await active.harness.resetSession(active.session);
    
    if (newSessionId) {
      console.log(`[harness-manager] Session reset for arm ${armId}: new session ${newSessionId}`);
      
      // Log to file
      const logEntry = `[${new Date().toISOString()}] Session reset: ${newSessionId}\n`;
      appendFile(active.logFile, logEntry).catch(() => {});
    } else {
      console.log(`[harness-manager] Session reset failed for arm ${armId}`);
    }
    
    return newSessionId;
  }

  /**
   * List all active sessions
   */
  listSessions(): ActiveSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Shutdown all sessions
   */
  async shutdown(): Promise<void> {
    console.log(`[harness-manager] Shutting down ${this.sessions.size} sessions...`);
    for (const [armId] of this.sessions) {
      await this.kill(armId);
    }
    console.log("[harness-manager] All sessions shut down");
  }

  /**
   * Get log file path for an arm
   */
  getLogFile(armId: string): string {
    return join(this.logsDir, `${armId}.log`);
  }

  /**
   * Read logs for an arm
   */
  async readLogs(armId: string, options?: { tail?: number }): Promise<string> {
    const logFile = this.getLogFile(armId);
    try {
      const content = await readFile(logFile, "utf-8");
      if (options?.tail) {
        const lines = content.split("\n");
        return lines.slice(-options.tail).join("\n");
      }
      return content;
    } catch {
      return "";
    }
  }

  /**
   * Get log file size
   */
  async getLogSize(armId: string): Promise<number> {
    const logFile = this.getLogFile(armId);
    try {
      const stats = await stat(logFile);
      return stats.size;
    } catch {
      return 0;
    }
  }
}

// Global instance (set by API server on startup)
let globalManager: HarnessManager | null = null;

export function setGlobalHarnessManager(manager: HarnessManager): void {
  globalManager = manager;
}

export function getGlobalHarnessManager(): HarnessManager | null {
  return globalManager;
}
