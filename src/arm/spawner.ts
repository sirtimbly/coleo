/**
 * Arm Spawner
 * 
 * Spawns AI agents via the harness system (PTY-controlled) or in terminal windows.
 * The harness approach is recommended for production as it gives full control.
 */

import { spawn, exec } from "child_process";
import { promisify } from "util";
import { writeFile, mkdir, readFile, readdir, appendFile } from "fs/promises";
import { join } from "path";
import { initDatabase, Database } from "../db";
import { harnessRegistry, type HarnessSession, type SpawnConfig, type SendPromptOptions } from "../harness";
import { getColeoDir, getRandomPreferredModel } from "../config";
import type { Arm, OctopaiConfig } from "../types";

const execAsync = promisify(exec);

export type AgentType = "opencode" | "opencode-api" | "opencode-tui" | "claude-code" | "aider" | "custom";
export type TerminalEmulator = "auto" | "ghostty" | "iterm2" | "terminal" | "wezterm" | "kitty" | "headless" | "tmux" | "harness";

export interface SpawnOptions {
  octopaiDir: string;
  name: string;
  agent: AgentType;
  workdir: string;
  terminal?: TerminalEmulator;
  customCommand?: string;
  initialPrompt?: string;
  /** Run in headless mode (no terminal window) - uses harness system */
  headless?: boolean;
  /** AI provider (e.g., "opencode", "github-copilot", "anthropic") */
  provider?: string;
  /** Model name (e.g., "claude-sonnet-4", "gpt-5.1-codex") */
  model?: string;
  /** Domain of expertise (e.g., "frontend", "backend", "testing") */
  domain?: string;
}

/**
 * Active harness sessions - maps arm ID to session
 */
const activeSessions = new Map<string, HarnessSession>();

/**
 * Get an active harness session by arm ID
 */
export function getHarnessSession(armId: string): HarnessSession | undefined {
  return activeSessions.get(armId);
}

/**
 * Detect if we're running in a headless environment (no display)
 */
function isHeadlessEnvironment(): boolean {
  // Docker containers typically don't have DISPLAY
  // Also check for common container indicators
  return (
    !process.env.DISPLAY &&
    (process.env.container !== undefined ||
      process.env.DOCKER === "true" ||
      Bun.file("/.dockerenv").size > 0 ||
      process.env.SSH_CONNECTION !== undefined)
  );
}

/**
 * Detect which terminal emulator is available
 */
async function detectTerminal(): Promise<TerminalEmulator> {
  // In headless environments, prefer tmux if available, otherwise headless
  if (isHeadlessEnvironment()) {
    try {
      await execAsync("which tmux");
      return "tmux";
    } catch {
      return "headless";
    }
  }

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
function getTerminalCommand(
  terminal: TerminalEmulator,
  command: string,
  title: string,
  workdir: string
): { cmd: string; args: string[] } {
  switch (terminal) {
    case "ghostty":
      // Ghostty on macOS works best with open command
      // We wrap in bash -c to handle environment variables properly
      return {
        cmd: "ghostty",
        args: [
          `--title=${title}`,
          `--working-directory=${workdir}`,
          "-e", "bash", "-c", command,
        ],
      };

    case "wezterm":
      return {
        cmd: "wezterm",
        args: [
          "start",
          "--cwd", workdir,
          "--", "bash", "-c", command,
        ],
      };

    case "kitty":
      return {
        cmd: "kitty",
        args: [
          "--title", title,
          "--directory", workdir,
          "bash", "-c", command,
        ],
      };

    case "iterm2":
      // iTerm2 requires AppleScript
      const script = `
        tell application "iTerm2"
          create window with default profile
          tell current session of current window
            write text "cd ${workdir} && ${command}"
          end tell
        end tell
      `;
      return {
        cmd: "osascript",
        args: ["-e", script],
      };

    case "terminal":
    default:
      // Terminal.app also uses AppleScript
      const termScript = `
        tell application "Terminal"
          do script "cd ${workdir} && ${command}"
          activate
        end tell
      `;
      return {
        cmd: "osascript",
        args: ["-e", termScript],
      };

    case "tmux":
      // Create a new tmux session for the arm
      return {
        cmd: "tmux",
        args: [
          "new-session",
          "-d",  // Detached
          "-s", title.replace(/[^a-zA-Z0-9_-]/g, "_"),  // Session name (sanitized)
          "-c", workdir,
          command,
        ],
      };

    case "headless":
      // Run directly as a background process, logging to file
      const logFile = join(process.env.COLEO_DIR || getColeoDir(), "logs", `${title}.log`);
      return {
        cmd: "bash",
        args: [
          "-c",
          `mkdir -p "$(dirname "${logFile}")" && cd "${workdir}" && ${command} >> "${logFile}" 2>&1`,
        ],
      };
  }
}

/**
 * Generate the agent command based on type
 */
function getAgentCommand(agent: AgentType, options: SpawnOptions): string {
  const mcpConfig = join(options.octopaiDir, "mcp", `${options.name}.json`);
  
  // Build model string if provider/model specified
  const modelEnv = options.provider && options.model 
    ? `OPENCODE_MODEL=${options.provider}/${options.model} `
    : options.model 
      ? `OPENCODE_MODEL=${options.model} `
      : "";
  
  switch (agent) {
    case "opencode":
      // OpenCode with MCP config pointing to octopai
      // Use the MCP config file we created for this arm
      return `${modelEnv}OCTOPAI_ARM_ID=${options.name} OPENCODE_MCP_CONFIG="${mcpConfig}" opencode`;

    case "claude-code":
      // Claude Code (assuming similar CLI)
      return `OCTOPAI_ARM_ID=${options.name} claude`;

    case "aider":
      // Aider doesn't support MCP natively, but can still be used
      return `OCTOPAI_ARM_ID=${options.name} aider`;

    case "custom":
      return options.customCommand || "bash";

    default:
      return "bash";
  }
}

/**
 * Create MCP configuration for the arm
 */
async function createMcpConfig(options: SpawnOptions): Promise<void> {
  const mcpDir = join(options.octopaiDir, "mcp");
  await mkdir(mcpDir, { recursive: true });

  // Create an MCP config that tells the agent how to connect to octopai
  const mcpConfig = {
    mcpServers: {
      octopai: {
        command: "octopai",
        args: ["mcp", "serve"],
        env: {
          OCTOPAI_ARM_ID: options.name,
          OCTOPAI_DIR: options.octopaiDir,
        },
      },
    },
  };

  await writeFile(
    join(mcpDir, `${options.name}.json`),
    JSON.stringify(mcpConfig, null, 2),
    "utf-8"
  );
}

/**
 * Get or create database connection (runs migrations)
 */
async function getDatabase(octopaiDir: string): Promise<Database> {
  const dbPath = join(octopaiDir, "octopai.db");
  return await initDatabase(dbPath);
}

/**
 * Create an arm in the database
 */
async function createArmState(options: SpawnOptions, pid?: number): Promise<Arm> {
  const arm: Arm = {
    id: options.name,
    name: options.name,
    agent: options.agent,
    status: "starting",
    pid,
    startedAt: new Date(),
    provider: options.provider,
    model: options.model,
  };

  const db = await getDatabase(options.octopaiDir);
  const now = new Date().toISOString();

  try {
    // Try to insert, or update if exists (upsert)
    db.run(`
      INSERT INTO arms (id, name, domain, harness, status, context_budget, current_context_used, created_at, updated_at, pid, provider, model, config)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        domain = excluded.domain,
        pid = excluded.pid,
        provider = excluded.provider,
        model = excluded.model,
        updated_at = excluded.updated_at
    `, [
      arm.id,
      arm.name,
      options.domain || "general", // domain
      arm.agent, // harness
      arm.status,
      100000, // context_budget
      0, // current_context_used
      now,
      now,
      arm.pid || null,
      arm.provider || null,
      arm.model || null,
      JSON.stringify({}),
    ]);
  } finally {
    db.close();
  }

  // Also create arm's notes directory (still file-based for notes)
  const notesDir = join(options.octopaiDir, "state", "arms", options.name, "notes");
  await mkdir(notesDir, { recursive: true });

  return arm;
}

/**
 * Spawn a new arm using the harness system (recommended)
 * 
 * This spawns the agent in a PTY controlled by the harness, allowing
 * full control over prompts, state detection, and heartbeats.
 */
export async function spawnArmWithHarness(options: SpawnOptions): Promise<Arm> {
  console.log(`Spawning arm "${options.name}" using ${options.agent} via harness (PTY-controlled)`);

  // Create MCP configuration
  await createMcpConfig(options);

  // Create logs directory
  const logsDir = join(options.octopaiDir, "logs");
  await mkdir(logsDir, { recursive: true });

  // Check if harness is available for this agent type
  if (!harnessRegistry.has(options.agent)) {
    console.warn(`No harness available for ${options.agent}, falling back to terminal mode`);
    return spawnArmInTerminal(options);
  }

  // Get the harness
  const harness = harnessRegistry.get(options.agent);

  // Spawn via harness
  const spawnConfig: SpawnConfig = {
    workdir: options.workdir,
    env: {
      OCTOPAI_DIR: options.octopaiDir,
      OCTOPAI_ARM_ID: options.name,
    },
    headless: true,
    provider: options.provider,
    model: options.model,
  };

  try {
    const session = await harness.spawn(spawnConfig);
    
    // Store session for later use
    activeSessions.set(options.name, session);

    // Get the PID from the harness
    const pid = harness.getPid ? harness.getPid(session) : undefined;

    // Create arm state in database
    const arm = await createArmState(options, pid);

    // Update status to idle since harness confirms it's ready
    const db = await getDatabase(options.octopaiDir);
    const now = new Date().toISOString();
    try {
      db.run("UPDATE arms SET status = 'idle', last_heartbeat = ?, updated_at = ? WHERE id = ?", [now, now, options.name]);
    } finally {
      db.close();
    }
    arm.status = "idle";

    // Log output to file
    const logFile = join(logsDir, `${options.name}.log`);
    session.pty.onData = async (data: string) => {
      try {
        await appendFile(logFile, data);
      } catch {
        // Ignore logging errors
      }
    };

    console.log(`Arm "${options.name}" spawned via harness (pid: ${pid}, session: ${session.id})`);

    // Send initial prompt if provided
    if (options.initialPrompt) {
      console.log(`Sending initial prompt to ${options.name}...`);
      await harness.sendPrompt(session, options.initialPrompt);
    }

    return arm;
  } catch (err) {
    console.error(`Failed to spawn arm via harness:`, err);
    throw err;
  }
}

/**
 * Send a prompt to an arm via its harness session
 * @param options.interrupt - If true, send escape key twice before prompt to cancel current work
 */
export async function sendPromptToArm(armId: string, prompt: string, options?: SendPromptOptions): Promise<void> {
  const session = activeSessions.get(armId);
  if (!session) {
    throw new Error(`No active harness session for arm ${armId}`);
  }

  const harness = harnessRegistry.get(session.harnessName);
  await harness.sendPrompt(session, prompt, options);
}

/**
 * Get the state of an arm via its harness session
 */
export async function getArmState(armId: string): Promise<string> {
  const session = activeSessions.get(armId);
  if (!session) {
    return "unknown";
  }

  const harness = harnessRegistry.get(session.harnessName);
  return harness.getState(session);
}

/**
 * Spawn a new arm in a terminal window (legacy approach)
 * 
 * This spawns the agent in a visible terminal window, but the brain
 * has limited control over it.
 */
export async function spawnArmInTerminal(options: SpawnOptions): Promise<Arm> {
  // Detect terminal if auto
  let terminal = options.terminal || "auto";
  if (terminal === "auto" || terminal === "harness") {
    terminal = await detectTerminal();
  }

  console.log(`Spawning arm "${options.name}" using ${options.agent} in ${terminal}${terminal === "headless" || terminal === "tmux" ? " (headless mode)" : ""}`);

  // Create MCP configuration
  await createMcpConfig(options);

  // Create logs directory for headless mode
  if (terminal === "headless" || terminal === "tmux") {
    const logsDir = join(options.octopaiDir, "logs");
    await mkdir(logsDir, { recursive: true });
  }

  // Get the agent command
  const agentCommand = getAgentCommand(options.agent, options);

  // Build initial prompt if provided
  let fullCommand = agentCommand;
  if (options.initialPrompt) {
    // Some agents support --prompt or similar
    // For now, we'll just echo instructions
    fullCommand = `echo "Initial task: ${options.initialPrompt}" && ${agentCommand}`;
  }

  // Generate a unique session ID for this spawn (helps identify windows during testing)
  const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const windowTitle = `octopai:${options.name}:${sessionId}`;

  // Get terminal launch command
  const { cmd, args } = getTerminalCommand(
    terminal,
    fullCommand,
    windowTitle,
    options.workdir
  );

  // Spawn the terminal
  const child = spawn(cmd, args, {
    detached: true,
    stdio: "ignore",
  });

  child.unref();

  // Create arm state
  const arm = await createArmState(options, child.pid);

  console.log(`Arm "${options.name}" spawned (pid: ${child.pid}, window: ${windowTitle})`);

  return arm;
}

/**
 * Spawn a new arm - uses harness by default, falls back to terminal if --terminal specified
 */
export async function spawnArm(options: SpawnOptions): Promise<Arm> {
  // If no provider/model specified, try to get a random preferred model
  if (!options.provider && !options.model) {
    const randomModel = getRandomPreferredModel();
    if (randomModel) {
      console.log(`Selected random preferred model: ${randomModel.provider}/${randomModel.model}`);
      options.provider = randomModel.provider;
      options.model = randomModel.model;
    }
  }

  // Use harness by default (headless PTY with full control)
  // Only use terminal mode if explicitly requested
  if (options.terminal && options.terminal !== "auto" && options.terminal !== "harness") {
    return spawnArmInTerminal(options);
  }

  // Default: use harness for full control
  return spawnArmWithHarness(options);
}

/**
 * Check if a process is running
 */
function isProcessRunning(pid: number): boolean {
  try {
    // Sending signal 0 checks if process exists without killing it
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface ArmRow {
  id: string;
  name: string;
  harness: string;
  status: string;
  pid: number | null;
  provider: string | null;
  model: string | null;
  created_at: string;
  last_activity_at: string | null;
}

/**
 * List running arms from database (also updates status based on process state)
 */
export async function listArms(octopaiDir: string): Promise<Arm[]> {
  const db = await getDatabase(octopaiDir);

  try {
    const rows = db.query(`
      SELECT id, name, harness, status, pid, provider, model, created_at, last_activity_at
      FROM arms
      ORDER BY name
    `).all() as ArmRow[];

    const arms: Arm[] = [];

    for (const row of rows) {
      const arm: Arm = {
        id: row.id,
        name: row.name,
        agent: row.harness,
        status: row.status as Arm["status"],
        pid: row.pid ?? undefined,
        provider: row.provider ?? undefined,
        model: row.model ?? undefined,
        startedAt: new Date(row.created_at),
        lastActivity: row.last_activity_at ? new Date(row.last_activity_at) : undefined,
      };

      // Check if process is still running and update status
      if (arm.pid && arm.status !== "stopped") {
        const running = isProcessRunning(arm.pid);
        if (running) {
          // Process is running - if it was "starting", mark as "idle"
          if (arm.status === "starting") {
            arm.status = "idle";
            db.run("UPDATE arms SET status = ?, updated_at = ? WHERE id = ?", [
              arm.status,
              new Date().toISOString(),
              arm.id,
            ]);
          }
        } else {
          // Process is not running anymore
          arm.status = "stopped";
          db.run("UPDATE arms SET status = ?, updated_at = ? WHERE id = ?", [
            arm.status,
            new Date().toISOString(),
            arm.id,
          ]);
        }
      }

      arms.push(arm);
    }

    return arms;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * Update arm status
 */
export async function updateArmStatus(
  octopaiDir: string,
  armId: string,
  status: Arm["status"]
): Promise<void> {
  const db = await getDatabase(octopaiDir);

  try {
    const now = new Date().toISOString();
    db.run("UPDATE arms SET status = ?, last_activity_at = ?, updated_at = ? WHERE id = ?", [
      status,
      now,
      now,
      armId,
    ]);
  } catch (err) {
    console.error(`Failed to update arm ${armId}:`, err);
  } finally {
    db.close();
  }
}

/**
 * Kill an arm (if we have its PID)
 */
export async function killArm(octopaiDir: string, armId: string): Promise<boolean> {
  const db = await getDatabase(octopaiDir);

  try {
    const row = db.query("SELECT pid FROM arms WHERE id = ?").get(armId) as { pid: number | null } | null;

    if (!row) {
      console.error(`Arm ${armId} not found`);
      return false;
    }

    if (row.pid) {
      try {
        process.kill(row.pid);
        console.log(`Killed arm ${armId} (pid: ${row.pid})`);
      } catch {
        console.log(`Arm ${armId} process already dead`);
      }
    }

    // Update status
    const now = new Date().toISOString();
    db.run("UPDATE arms SET status = ?, updated_at = ? WHERE id = ?", ["stopped", now, armId]);

    return true;
  } catch (err) {
    console.error(`Failed to kill arm ${armId}:`, err);
    return false;
  } finally {
    db.close();
  }
}
