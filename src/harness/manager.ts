/**
 * Harness Manager
 * 
 * Manages active harness sessions for the API server.
 * Sessions are stored in memory and tied to the server's lifecycle.
 */

import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessSession, SpawnConfig } from "./types";
import { harnessRegistry } from "./registry";
import type { AgentHarness } from "./types";

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
  private octopaiDir: string;
  private logsDir: string;

  constructor(octopaiDir: string) {
    this.octopaiDir = octopaiDir;
    this.logsDir = join(octopaiDir, "logs");
  }

  /**
   * Initialize the manager
   */
  async init(): Promise<void> {
    await mkdir(this.logsDir, { recursive: true });
    console.log("[harness-manager] Initialized");
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

    // Prepare spawn config
    const spawnConfig: SpawnConfig = {
      workdir: options.workdir,
      env: {
        OCTOPAI_DIR: this.octopaiDir,
        OCTOPAI_ARM_ID: armId,
      },
      headless: true,
      provider: options.provider,
      model: options.model,
    };

    // Spawn the session
    console.log(`[harness-manager] Spawning ${armId} via ${agent} harness...`);
    const session = await harness.spawn(spawnConfig);

    // Set up logging
    const logFile = join(this.logsDir, `${armId}.log`);
    session.pty.onData = async (data: string) => {
      try {
        await appendFile(logFile, data);
      } catch {
        // Ignore logging errors
      }
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

    // Send initial prompt if provided
    if (options.initialPrompt) {
      console.log(`[harness-manager] Sending initial prompt to ${armId}...`);
      await harness.sendPrompt(session, options.initialPrompt);
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
   * Send a prompt to an arm
   */
  async sendPrompt(armId: string, prompt: string): Promise<void> {
    const active = this.sessions.get(armId);
    if (!active) {
      throw new Error(`No active session for arm ${armId}`);
    }

    await active.harness.sendPrompt(active.session, prompt);
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
}

// Global instance (set by API server on startup)
let globalManager: HarnessManager | null = null;

export function setGlobalHarnessManager(manager: HarnessManager): void {
  globalManager = manager;
}

export function getGlobalHarnessManager(): HarnessManager | null {
  return globalManager;
}
