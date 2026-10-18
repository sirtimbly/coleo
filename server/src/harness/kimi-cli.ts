/**
 * Kimi CLI Harness
 *
 * Controls Kimi CLI agent via PTY terminal interaction in headless mode.
 * Kimi CLI is a TUI-based agent without a server-mode API, so we use
 * PTY-based control via stdin/stdout with keyboard sequences.
 *
 * Key interaction patterns (from kimi-cli docs):
 * - Agent mode (default): Input sent to AI
 * - Shell mode (Ctrl+X): Execute shell commands directly
 * - Thinking mode (Tab): Toggle deep thinking
 * - Multi-line input: Ctrl-J or Alt-Enter for newlines
 * - Image paste: Ctrl-V (if model supports image_in)
 * - Interrupt: Ctrl-C or Esc twice
 * - Slash commands: /help, /compact, /yolo, etc.
 * - File references: @path completion
 *
 * UI State Detection:
 * - Idle: Shows prompt pattern (e.g., ">" or input cursor)
 * - Processing: "Thinking...", spinner indicators
 * - Approval: "[Y/n]" prompts, permission requests
 * - Error: Error messages in red
 * 
 * @module harness/kimi-cli
 */

import { randomBytes } from "crypto";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { getColeoDir } from "../config";
import type {
	AgentHarness,
	HarnessSession,
	HarnessCapabilities,
	SpawnConfig,
	AgentState,
	SendPromptOptions,
} from "./types";
import { KEY_SEQUENCES } from "./types";
import { PTYManager } from "./pty-manager";

// Import extracted modules
import {
	type KimiCliHarnessSession,
	KIMI_CLI_PATTERNS,
} from "./kimi-cli-types";
import { KimiCliHealthManager } from "./kimi-cli-health";
import { buildKimiConfig } from "./kimi-cli-config";
import { detectAndEmitEvents } from "./kimi-cli-events";

// Import shared callback types
import type { ArmEventCallback } from "./opencode-api";
import type { ArmDeathCallback } from "./opencode-tui";

export {
	type KimiCliHarnessSession,
	KIMI_CLI_PATTERNS,
} from "./kimi-cli-types";
export { KimiCliHealthManager } from "./kimi-cli-health";
export { buildKimiConfig } from "./kimi-cli-config";
export { detectAndEmitEvents } from "./kimi-cli-events";

export class KimiCliHarness implements AgentHarness {
	name = "kimi-cli";
	version = "1.0.0";
	capabilities: HarnessCapabilities = {
		mcp: true, // Kimi CLI supports MCP
		streaming: true,
		interrupt: true,
		compact: true, // Via /compact command
		multiTurn: true,
		fileEditing: true,
		commandExecution: true, // Via shell mode (Ctrl+X)
	};

	private ptyManager = new PTYManager();
	private sessions = new Map<string, KimiCliHarnessSession>();
	private eventCallbacks: Set<ArmEventCallback> = new Set();
	private deathCallbacks: Set<ArmDeathCallback> = new Set();
	private healthManager: KimiCliHealthManager;

	constructor() {
		this.healthManager = new KimiCliHealthManager(this.ptyManager, {
			onDeath: this.notifyDeath.bind(this),
			onEvent: this.emitEvent.bind(this),
		});
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
		console.log(`[harness-kimi] Arm ${armId} died: ${reason}`);
		for (const callback of this.deathCallbacks) {
			try {
				callback(armId, reason);
			} catch {
				// Ignore callback errors
			}
		}
	}

	/**
	 * Add a callback to receive arm events
	 */
	setEventCallback(callback: ArmEventCallback): void {
		this.eventCallbacks.add(callback);
	}

	/**
	 * Remove an event callback
	 */
	removeEventCallback(callback: ArmEventCallback): void {
		this.eventCallbacks.delete(callback);
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
	 * Spawn a new Kimi CLI instance in headless PTY mode
	 */
	async spawn(config: SpawnConfig): Promise<HarnessSession> {
		const sessionId = `kimi-cli-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
		const armId = config.env.COLEO_ARM_ID || "unknown";

		// Ensure MCP directory exists
		const coleoDir = config.env.COLEO_DIR || process.env.COLEO_DIR || getColeoDir();
		const mcpDir = join(coleoDir, "mcp");
		await mkdir(mcpDir, { recursive: true });

		// Build Kimi CLI config for MCP
		const kimiConfig = await buildKimiConfig(armId, coleoDir, config);
		const kimiConfigPath = join(mcpDir, `${armId}-kimi.json`);
		await writeFile(kimiConfigPath, JSON.stringify(kimiConfig, null, 2), "utf-8");

		// Build environment
		const env: Record<string, string> = {
			...process.env as Record<string, string>,
			...config.env,
			COLEO_ARM_ID: armId,
			COLEO_DIR: coleoDir,
			KIMI_CONFIG_PATH: kimiConfigPath,
			// Force non-interactive settings
			NO_COLOR: "1",
			TERM: "xterm-256color",
		};

		// Add model configuration if specified
		const args: string[] = [];
		if (config.provider && config.model) {
			// Kimi CLI uses --provider and --model flags or config
			args.push("--provider", config.provider);
			args.push("--model", config.model);
		} else if (config.model) {
			args.push("--model", config.model);
		}

		console.log(`[harness-kimi] Starting Kimi CLI for arm ${armId}...`);
		console.log(`[harness-kimi] Config: ${kimiConfigPath}`);

		// Spawn Kimi CLI in PTY (headless mode)
		const ptySession = this.ptyManager.spawn("kimi", args, {
			workdir: config.workdir,
			env,
		});

		const session: KimiCliHarnessSession = {
			id: sessionId,
			pty: ptySession,
			harnessName: this.name,
			spawnedAt: new Date(),
			lastHeartbeat: new Date(),
			armId,
			workdir: config.workdir,
			provider: config.provider,
			model: config.model,
			consecutiveFailures: 0,
		};

		// Set up data handler for event detection
		ptySession.onData = (data: string) => {
			detectAndEmitEvents(session, armId, data, this.emitEvent.bind(this));
		};

		// Set up exit handler
		ptySession.onExit = (code: number) => {
			console.log(`[harness-kimi] Kimi CLI exited with code ${code}`);
			this.healthManager.stopHealthCheck(session);
			this.sessions.delete(sessionId);
			this.notifyDeath(armId, `Process exited with code ${code}`);
			this.emitEvent(armId, "process.died", { exitCode: code });
		};

		this.sessions.set(sessionId, session);

		// Wait for Kimi CLI to initialize
		try {
			console.log(`[harness-kimi] Waiting for Kimi CLI to initialize (waiting for prompt)...`);
			await this.waitForInitialization(session);
			console.log(`[harness-kimi] Kimi CLI session ${sessionId} initialized and ready`);
		} catch (err) {
			console.error(`[harness-kimi] Kimi CLI failed to initialize:`, err);
			// Still return the session, it might just be slow
		}

		// Start health check polling
		this.healthManager.startHealthCheck(session, (sessionId) => {
			this.sessions.delete(sessionId);
		});

		// Emit spawned event
		this.emitEvent(armId, "spawned", {
			sessionId,
			pid: this.ptyManager.getPid(ptySession),
			workdir: config.workdir,
			provider: config.provider,
			model: config.model,
		});

		return session;
	}

	/**
	 * Wait for Kimi CLI to initialize
	 */
	private async waitForInitialization(session: KimiCliHarnessSession): Promise<void> {
		// Wait for initial prompt to appear
		await this.ptyManager.waitForPattern(session.pty, KIMI_CLI_PATTERNS.prompt, 60000, {
			label: "initialization prompt",
		});
	}

	/**
	 * Kill a Kimi CLI session
	 */
	async kill(session: HarnessSession): Promise<void> {
		const kimiSession = this.sessions.get(session.id);
		if (!kimiSession) {
			console.log(`[harness-kimi] Session ${session.id} not found`);
			return;
		}

		// Stop health check
		this.healthManager.stopHealthCheck(kimiSession);

		// Try graceful exit first using /exit command
		try {
			this.ptyManager.write(session.pty, "/exit\r");
			await new Promise((resolve) => setTimeout(resolve, 1000));
		} catch {
			// Ignore errors during graceful exit attempt
		}

		// Force kill if still running
		try {
			this.ptyManager.kill(session.pty);
		} catch {
			// Already dead
		}

		this.sessions.delete(session.id);

		// Emit stopped event
		this.emitEvent(kimiSession.armId, "stopped", {
			sessionId: session.id,
			timestamp: new Date().toISOString(),
		});

		console.log(`[harness-kimi] Kimi CLI session ${session.id} killed`);
	}

	/**
	 * Send a prompt to Kimi CLI
	 */
	async sendPrompt(
		session: HarnessSession,
		prompt: string,
		options?: SendPromptOptions,
	): Promise<void> {
		const kimiSession = this.sessions.get(session.id);
		if (!kimiSession) {
			throw new Error(`Session ${session.id} not found`);
		}

		// If interrupt is requested, send escape keys to cancel current work
		if (options?.interrupt) {
			console.log(`[harness-kimi] Sending interrupt to ${session.id} before prompt`);

			// Send Ctrl+C first
			this.ptyManager.sendKey(session.pty, "CTRL_C");
			await new Promise((resolve) => setTimeout(resolve, 300));

			// Send Escape twice as backup (Kimi CLI specific)
			this.ptyManager.write(session.pty, KEY_SEQUENCES.ESCAPE);
			await new Promise((resolve) => setTimeout(resolve, 300));
			this.ptyManager.write(session.pty, KEY_SEQUENCES.ESCAPE);
			await new Promise((resolve) => setTimeout(resolve, 500));
		}

		// Wait for prompt to be ready
		try {
			await this.ptyManager.waitForPattern(session.pty, KIMI_CLI_PATTERNS.prompt, 5000, {
				label: "ready prompt",
				logProgress: false,
			});
		} catch {
			console.log(`[harness-kimi] Warning: Prompt not detected, sending anyway`);
		}

		// Handle multi-line prompts
		// Kimi CLI supports Ctrl+J or Alt+Enter for multi-line input
		const lines = prompt.split("\n");

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line !== undefined) {
				this.ptyManager.write(session.pty, line);

				if (i < lines.length - 1) {
					// Use Ctrl+J for multi-line input
					this.ptyManager.write(session.pty, KEY_SEQUENCES.CTRL_C); // Actually need Ctrl+J
					// Ctrl+J is \x0a (line feed)
					this.ptyManager.write(session.pty, "\x0a");
				}
			}
		}

		// Small delay to ensure text is processed
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Send Enter to submit
		this.ptyManager.sendKey(session.pty, "ENTER");

		console.log(
			`[harness-kimi] Sent prompt to ${session.id}: "${prompt.slice(0, 50)}..."${
				options?.interrupt ? " [interrupted]" : ""
			}`,
		);

		// Emit task started event
		this.emitEvent(kimiSession.armId, "task_started", {
			sessionId: session.id,
			timestamp: new Date().toISOString(),
			prompt: prompt.slice(0, 200), // Truncated for logging
		});

		// Update activity
		session.pty.lastActivity = new Date();
	}

	/**
	 * Wait for Kimi CLI to respond and return to idle
	 */
	async waitForResponse(session: HarnessSession, timeout: number = 300000): Promise<string> {
		const kimiSession = this.sessions.get(session.id);
		if (!kimiSession) {
			throw new Error(`Session ${session.id} not found`);
		}

		const startIndex = session.pty.buffer.length;

		// Wait for the prompt to reappear (indicates completion)
		console.log(`[harness-kimi] Waiting for response (prompt pattern)...`);
		await this.ptyManager.waitForPattern(session.pty, KIMI_CLI_PATTERNS.prompt, timeout, {
			label: "prompt",
		});

		// Get the response (everything between sending and prompt reappearing)
		const response = session.pty.buffer.slice(startIndex);
		const { stripAnsi } = await import("./pty-manager");
		const strippedResponse = stripAnsi(response);

		// Emit task completed event
		this.emitEvent(kimiSession.armId, "task_completed", {
			sessionId: session.id,
			timestamp: new Date().toISOString(),
			responseLength: strippedResponse.length,
		});

		return strippedResponse;
	}

	/**
	 * Wait for Kimi CLI to become idle (no activity)
	 */
	async waitForIdle(session: HarnessSession, timeout: number = 60000): Promise<void> {
		// Wait for no output for 2 seconds
		await this.ptyManager.waitForQuiet(session.pty, 2000, timeout);
	}

	/**
	 * Detect the current state of Kimi CLI
	 */
	async getState(session: HarnessSession): Promise<AgentState> {
		const kimiSession = this.sessions.get(session.id);
		if (!kimiSession) {
			return "dead";
		}

		// Check if process is still alive
		const isAlive = await this.healthManager.isSessionAlive(kimiSession);
		if (!isAlive) {
			return "dead";
		}

		const recentOutput = this.ptyManager.getRecentOutput(session.pty, 2000);

		// Check for error state
		if (KIMI_CLI_PATTERNS.error.test(recentOutput)) {
			return "error";
		}

		// Check for approval request
		if (KIMI_CLI_PATTERNS.approval.test(recentOutput)) {
			return "waiting_approval";
		}

		// Check for thinking/processing
		if (KIMI_CLI_PATTERNS.thinking.test(recentOutput)) {
			return "processing";
		}

		// Check if we're at the prompt (idle)
		if (KIMI_CLI_PATTERNS.prompt.test(recentOutput)) {
			return "idle";
		}

		// Check if there's been recent activity
		const timeSinceActivity = Date.now() - session.pty.lastActivity.getTime();
		if (timeSinceActivity > 3000) {
			// No activity for 3 seconds, likely idle
			return "idle";
		}

		// Default to processing if there's recent activity
		return "processing";
	}

	/**
	 * Check if Kimi CLI is currently processing
	 */
	async isProcessing(session: HarnessSession): Promise<boolean> {
		const state = await this.getState(session);
		return state === "processing" || state === "executing";
	}

	/**
	 * Interrupt Kimi CLI
	 * Sends Ctrl+C (and Escape as backup)
	 */
	async interrupt(session: HarnessSession): Promise<void> {
		const kimiSession = this.sessions.get(session.id);
		if (!kimiSession) {
			return;
		}

		// Send Ctrl+C
		this.ptyManager.sendKey(session.pty, "CTRL_C");
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Send Escape twice as backup (Kimi CLI specific)
		this.ptyManager.write(session.pty, KEY_SEQUENCES.ESCAPE);
		await new Promise((resolve) => setTimeout(resolve, 200));
		this.ptyManager.write(session.pty, KEY_SEQUENCES.ESCAPE);

		console.log(`[harness-kimi] Interrupted session ${session.id}`);

		// Emit event
		this.emitEvent(kimiSession.armId, "interrupted", {
			sessionId: session.id,
			timestamp: new Date().toISOString(),
		});
	}

	/**
	 * Compact Kimi CLI's context using /compact command
	 */
	async compact(session: HarnessSession): Promise<void> {
		const kimiSession = this.sessions.get(session.id);
		if (!kimiSession) {
			return;
		}

		await this.sendPrompt(session, "/compact");
		await this.waitForIdle(session);

		console.log(`[harness-kimi] Compacted context for session ${session.id}`);

		this.emitEvent(kimiSession.armId, "session.compacted", {
			sessionId: session.id,
			timestamp: new Date().toISOString(),
		});
	}

	/**
	 * Reset the session by starting fresh
	 * Kimi CLI doesn't have sessions like OpenCode, so we use /clear command
	 */
	async resetSession(session: HarnessSession): Promise<string | undefined> {
		const kimiSession = this.sessions.get(session.id);
		if (!kimiSession) {
			console.log(`[harness-kimi] Session ${session.id} not found for reset`);
			return undefined;
		}

		try {
			console.log(`[harness-kimi] Resetting session ${session.id}`);

			// Send /clear command to clear conversation history
			await this.sendPrompt(session, "/clear");
			await this.waitForIdle(session);

			// Generate a new session identifier
			const newSessionId = `kimi-reset-${Date.now().toString(36)}`;

			console.log(`[harness-kimi] Session reset complete: ${session.id}`);

			this.emitEvent(kimiSession.armId, "session.reset", {
				sessionId: session.id,
				timestamp: new Date().toISOString(),
			});

			return newSessionId;
		} catch (err) {
			console.error(`[harness-kimi] Failed to reset session:`, err);
			return undefined;
		}
	}

	/**
	 * Respond to an approval prompt
	 * Sends "y" or "n" based on response
	 */
	async respondToApproval(session: HarnessSession, allow: boolean): Promise<void> {
		const kimiSession = this.sessions.get(session.id);
		if (!kimiSession) {
			throw new Error(`Session ${session.id} not found`);
		}

		const response = allow ? "y" : "n";
		this.ptyManager.write(session.pty, response);
		this.ptyManager.sendKey(session.pty, "ENTER");

		console.log(`[harness-kimi] Responded to approval with: ${response}`);

		this.emitEvent(kimiSession.armId, "permission.replied", {
			sessionId: session.id,
			timestamp: new Date().toISOString(),
			allowed: allow,
		});
	}

	/**
	 * Enable YOLO mode (auto-approve all requests)
	 * Uses the /yolo command
	 */
	async enableYoloMode(session: HarnessSession): Promise<void> {
		const kimiSession = this.sessions.get(session.id);
		if (!kimiSession) {
			return;
		}

		await this.sendPrompt(session, "/yolo");
		await this.waitForIdle(session);

		console.log(`[harness-kimi] YOLO mode enabled for session ${session.id}`);
	}

	/**
	 * Check if this harness supports MCP
	 */
	hasMCP(): boolean {
		return true;
	}

	/**
	 * Get the MCP endpoint for this session
	 * Kimi CLI uses stdio for MCP
	 */
	getMCPEndpoint(_session: HarnessSession): string {
		return "stdio:kimi-cli";
	}

	/**
	 * Get the PID of the session's PTY process
	 */
	getPid(session: HarnessSession): number {
		return this.ptyManager.getPid(session.pty);
	}

	/**
	 * Get a session by ID
	 */
	getSession(sessionId: string): KimiCliHarnessSession | undefined {
		return this.sessions.get(sessionId);
	}

	/**
	 * List all active sessions
	 */
	listSessions(): KimiCliHarnessSession[] {
		return Array.from(this.sessions.values());
	}

	/**
	 * Update heartbeat for a session
	 */
	updateHeartbeat(session: KimiCliHarnessSession): void {
		session.lastHeartbeat = new Date();
	}
}

// Singleton instance
export const kimiCliHarness = new KimiCliHarness();
