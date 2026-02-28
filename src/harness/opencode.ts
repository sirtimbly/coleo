/**
 * OpenCode Harness
 * 
 * Controls OpenCode AI agent via PTY terminal interaction.
 */

import { randomBytes } from "crypto";
import { join } from "node:path";
import { getColeoDir } from "../config";
import { getCliEntrypoint } from "../cli/entrypoint";
import type {
  AgentHarness,
  HarnessSession,
  HarnessCapabilities,
  SpawnConfig,
  AgentState,
  UIPatterns,
  SendPromptOptions,
} from "./types";
import { KEY_SEQUENCES } from "./types";
import { PTYManager, stripAnsi } from "./pty-manager";
import { appendTaskAttachmentsToPromptText } from "../lib/prompt-attachments";

/**
 * UI patterns for detecting OpenCode state
 * OpenCode uses a full TUI, so we look for text patterns in the rendered output.
 */
const OPENCODE_PATTERNS: UIPatterns = {
  // OpenCode shows "Ask anything..." when ready for input, and status bar shows path
  prompt: /Ask anything|ctrl\+p commands|developer\/coleo/,
  // Various thinking indicators  
  thinking: /thinking|processing|reading|searching|Generating/i,
  // Confirmation prompts
  approval: /\[Y\/n\]|\(yes\/no\)|Do you want to|Proceed\?/i,
  // Error indicators
  error: /^Error:|^Failed:|error:/im,
  // Success indicators
  success: /^Done|^Completed|successfully/im,
};

export class OpenCodeHarness implements AgentHarness {
  name = "opencode";
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

  private ptyManager = new PTYManager();
  private sessions = new Map<string, HarnessSession>();

  /**
   * Spawn a new OpenCode instance
   */
  async spawn(config: SpawnConfig): Promise<HarnessSession> {
    const sessionId = `opencode-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const armId = config.env.COLEO_ARM_ID || config.env.COLEO_TENTACLE_ID || "unknown";

    // Build environment
    const env: Record<string, string> = {
      ...config.env,
      COLEO_ARM_ID: armId,
      NODE_TLS_REJECT_UNAUTHORIZED: "0", // Allow self-signed certs for development
    };

    // Always create OpenCode config file for this arm
    // This is the proper way to configure OpenCode (not via env vars)
    const coleoDir = config.env.COLEO_DIR || process.env.COLEO_DIR || getColeoDir();
    const mcpDir = join(coleoDir, "mcp");
    
    // Ensure MCP directory exists
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(mcpDir, { recursive: true });
    
    // Use bun from the system PATH or fall back to ~/.bun/bin/bun
    const bunPath = process.execPath;
    const cliEntrypoint = getCliEntrypoint();
    
    // Build the OpenCode config
    // See: https://opencode.ai/docs/models/#set-a-default
    const opencodeConfig: Record<string, unknown> = {
      $schema: "https://opencode.ai/config.json",
      // Configure the Coleo MCP server for brain communication
      mcp: {
        coleo: {
          type: "local",
          command: [bunPath, cliEntrypoint, "mcp", "serve"],
          environment: {
            COLEO_ARM_ID: armId,
            COLEO_DIR: coleoDir,
          },
          enabled: true,
        },
      },
    };

    // Set default model if provider/model specified
    // Format: "provider_id/model_id" (e.g., "anthropic/claude-sonnet-4-20250514")
    if (config.provider && config.model) {
      opencodeConfig.model = `${config.provider}/${config.model}`;
    } else if (config.model) {
      // If only model specified, use it directly (might include provider already)
      opencodeConfig.model = config.model;
    }

    // Write OpenCode config to the MCP directory
    const opencodeConfigPath = join(mcpDir, `${armId}.json`);
    await writeFile(opencodeConfigPath, JSON.stringify(opencodeConfig, null, 2), "utf-8");
    
    // Tell OpenCode where to find the config
    env.OPENCODE_CONFIG = opencodeConfigPath;
    console.log(`[harness] Created OpenCode config at ${opencodeConfigPath}${opencodeConfig.model ? ` (model: ${opencodeConfig.model})` : ""}`);

    // Spawn OpenCode in PTY
    const ptySession = this.ptyManager.spawn("opencode", [], {
      workdir: config.workdir,
      env,
    });

    const session: HarnessSession = {
      id: sessionId,
      pty: ptySession,
      harnessName: this.name,
      spawnedAt: new Date(),
      lastHeartbeat: new Date(),
    };

    this.sessions.set(sessionId, session);

    // Wait for OpenCode to initialize and show prompt
    try {
      await this.ptyManager.waitForPattern(ptySession, OPENCODE_PATTERNS.prompt, 60000);
      console.log(`[harness] OpenCode session ${sessionId} initialized and ready`);
    } catch (err) {
      console.error(`[harness] OpenCode failed to initialize:`, err);
      // Still return the session, it might just be slow
    }

    return session;
  }

  /**
   * Kill an OpenCode session
   */
  async kill(session: HarnessSession): Promise<void> {
    // Try graceful exit first
    this.ptyManager.write(session.pty, "/exit\r");
    
    // Wait briefly for graceful exit
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Force kill if still running
    try {
      this.ptyManager.kill(session.pty);
    } catch {
      // Already dead
    }

    this.sessions.delete(session.id);
    console.log(`[harness] OpenCode session ${session.id} killed`);
  }

  /**
   * Send a prompt to OpenCode
   * @param options.interrupt - If true, send escape key twice before prompt to cancel current work
   */
  async sendPrompt(session: HarnessSession, prompt: string, options?: SendPromptOptions): Promise<void> {
    const promptText = appendTaskAttachmentsToPromptText(prompt, options?.attachments);

    // If interrupt is requested, send escape key twice to cancel current work
    if (options?.interrupt) {
      console.log(`[harness] Sending interrupt (2x ESC) to ${session.id} before prompt`);
      
      // Capture buffer state before sending ESC
      const bufferBefore = session.pty.buffer.length;
      
      // First, focus the input window by sending a Tab or clicking
      // OpenCode uses 'i' to focus input in some modes, but ESC should work from anywhere
      // Send first ESC to potentially exit any menu/modal and focus input
      this.ptyManager.write(session.pty, KEY_SEQUENCES.ESCAPE);
      await new Promise(resolve => setTimeout(resolve, 600));
      
      // Send second ESC to cancel any in-progress operation
      this.ptyManager.write(session.pty, KEY_SEQUENCES.ESCAPE);
      await new Promise(resolve => setTimeout(resolve, 600));
      
      const bufferAfter = session.pty.buffer.length;
      console.log(`[harness] Escape keys sent. Buffer: ${bufferBefore} -> ${bufferAfter} bytes (+${bufferAfter - bufferBefore})`);
    }

    // Clear buffer before sending so we can track new output
    const startIndex = session.pty.buffer.length;

    // Wait for OpenCode to be ready for input (show prompt pattern)
    try {
      await this.ptyManager.waitForPattern(session.pty, OPENCODE_PATTERNS.prompt, 5000);
    } catch {
      console.log(`[harness] Warning: OpenCode prompt not detected, sending anyway`);
    }

    // OpenCode accepts text input followed by Enter
    // For multi-line prompts, we need to handle them carefully
    const lines = promptText.split("\n");
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line !== undefined) {
        this.ptyManager.write(session.pty, line);
        if (i < lines.length - 1) {
          // Use shift+enter for newlines within the prompt (if supported)
          // For now, just concatenate with space
          this.ptyManager.write(session.pty, " ");
        }
      }
    }

    // Small delay to ensure text is processed before Enter
    await new Promise(resolve => setTimeout(resolve, 50));

    // Send Enter to submit
    this.ptyManager.sendKey(session.pty, "ENTER");
    
    console.log(`[harness] Sent prompt to ${session.id}: "${promptText.slice(0, 50)}..."${options?.interrupt ? " [interrupted]" : ""} [ENTER sent]`);
  }

  /**
   * Wait for OpenCode to respond and return to idle
   */
  async waitForResponse(session: HarnessSession, timeout: number = 300000): Promise<string> {
    const startIndex = session.pty.buffer.length;

    // Wait for the prompt to reappear
    await this.ptyManager.waitForPattern(session.pty, OPENCODE_PATTERNS.prompt, timeout);

    // Get the response (everything between sending and prompt reappearing)
    const response = session.pty.buffer.slice(startIndex);
    return stripAnsi(response);
  }

  /**
   * Wait for OpenCode to become idle (no activity)
   */
  async waitForIdle(session: HarnessSession, timeout: number = 60000): Promise<void> {
    // Wait for no output for 3 seconds (OpenCode is verbose during processing)
    await this.ptyManager.waitForQuiet(session.pty, 3000, timeout);
  }

  /**
   * Detect the current state of OpenCode
   */
  async getState(session: HarnessSession): Promise<AgentState> {
    const recentOutput = this.ptyManager.getRecentOutput(session.pty, 1000);

    // Check for error state
    if (OPENCODE_PATTERNS.error.test(recentOutput)) {
      return "error";
    }

    // Check for approval request
    if (OPENCODE_PATTERNS.approval.test(recentOutput)) {
      return "waiting_approval";
    }

    // Check for thinking/processing
    if (OPENCODE_PATTERNS.thinking.test(recentOutput)) {
      return "processing";
    }

    // Check if we're at the prompt (idle)
    if (OPENCODE_PATTERNS.prompt.test(recentOutput)) {
      return "idle";
    }

    // Check if there's been recent activity
    const timeSinceActivity = Date.now() - session.pty.lastActivity.getTime();
    if (timeSinceActivity > 5000) {
      // No activity for 5 seconds, probably idle or dead
      // Try to determine which
      if (session.pty.buffer.length === 0) {
        return "dead";
      }
      return "idle";
    }

    // Default to processing if there's activity
    return "processing";
  }

  /**
   * Check if OpenCode is currently processing
   */
  async isProcessing(session: HarnessSession): Promise<boolean> {
    const state = await this.getState(session);
    return state === "processing" || state === "executing";
  }

  /**
   * Interrupt OpenCode (Ctrl+C)
   */
  async interrupt(session: HarnessSession): Promise<void> {
    this.ptyManager.sendKey(session.pty, "CTRL_C");
    console.log(`[harness] Interrupted session ${session.id}`);
  }

  /**
   * Compact OpenCode's context
   */
  async compact(session: HarnessSession): Promise<void> {
    await this.sendPrompt(session, "/compact");
    await this.waitForIdle(session);
    console.log(`[harness] Compacted context for session ${session.id}`);
  }

  /**
   * Check if this harness supports MCP
   */
  hasMCP(): boolean {
    return true;
  }

  /**
   * Get the MCP endpoint for this session (if applicable)
   */
  getMCPEndpoint(session: HarnessSession): string {
    // OpenCode uses stdio for MCP, not a socket
    return `stdio:opencode`;
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): HarnessSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * List all active sessions
   */
  listSessions(): HarnessSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Update heartbeat for a session
   */
  updateHeartbeat(session: HarnessSession): void {
    session.lastHeartbeat = new Date();
  }

  /**
   * Get the PID of the session's PTY process
   */
  getPid(session: HarnessSession): number {
    return this.ptyManager.getPid(session.pty);
  }
}

// Singleton instance
export const openCodeHarness = new OpenCodeHarness();
