/**
 * Tentacle Spawner
 * 
 * Spawns AI agents in their own terminal windows with MCP configured
 * to connect back to the Octopai brain.
 */

import { spawn, exec } from "child_process";
import { promisify } from "util";
import { writeFile, mkdir, readFile } from "fs/promises";
import { join } from "path";
import type { Tentacle, OctopaiConfig } from "../types";

const execAsync = promisify(exec);

export type AgentType = "opencode" | "claude-code" | "aider" | "custom";
export type TerminalEmulator = "auto" | "ghostty" | "iterm2" | "terminal" | "wezterm" | "kitty" | "headless" | "tmux";

export interface SpawnOptions {
  octopaiDir: string;
  name: string;
  agent: AgentType;
  workdir: string;
  terminal?: TerminalEmulator;
  customCommand?: string;
  initialPrompt?: string;
  /** Run in headless mode (no terminal window) */
  headless?: boolean;
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
      return {
        cmd: "ghostty",
        args: [
          "-e", command,
          "--title", title,
          "--working-directory", workdir,
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
      // Create a new tmux session for the tentacle
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
      const logFile = join(process.env.OCTOPAI_DIR || process.env.HOME + "/.octopai", "logs", `${title}.log`);
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
  
  switch (agent) {
    case "opencode":
      // OpenCode with MCP config pointing to octopai
      return `OCTOPAI_TENTACLE_ID=${options.name} opencode`;

    case "claude-code":
      // Claude Code (assuming similar CLI)
      return `OCTOPAI_TENTACLE_ID=${options.name} claude`;

    case "aider":
      // Aider doesn't support MCP natively, but can still be used
      return `OCTOPAI_TENTACLE_ID=${options.name} aider`;

    case "custom":
      return options.customCommand || "bash";

    default:
      return "bash";
  }
}

/**
 * Create MCP configuration for the tentacle
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
          OCTOPAI_TENTACLE_ID: options.name,
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
 * Create a tentacle state file
 */
async function createTentacleState(options: SpawnOptions, pid?: number): Promise<Tentacle> {
  const tentacle: Tentacle = {
    id: options.name,
    name: options.name,
    agent: options.agent,
    status: "starting",
    pid,
    startedAt: new Date(),
  };

  const stateDir = join(options.octopaiDir, "state", "tentacles");
  await mkdir(stateDir, { recursive: true });

  await writeFile(
    join(stateDir, `${options.name}.json`),
    JSON.stringify(tentacle, null, 2),
    "utf-8"
  );

  // Also create tentacle's notes directory
  const notesDir = join(options.octopaiDir, "state", "tentacles", options.name, "notes");
  await mkdir(notesDir, { recursive: true });

  return tentacle;
}

/**
 * Spawn a new tentacle
 */
export async function spawnTentacle(options: SpawnOptions): Promise<Tentacle> {
  // Detect terminal if auto
  let terminal = options.terminal || "auto";
  if (terminal === "auto") {
    // Force headless if explicitly requested
    if (options.headless) {
      terminal = "headless";
    } else {
      terminal = await detectTerminal();
    }
  }

  console.log(`Spawning tentacle "${options.name}" using ${options.agent} in ${terminal}${terminal === "headless" || terminal === "tmux" ? " (headless mode)" : ""}`);

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

  // Get terminal launch command
  const { cmd, args } = getTerminalCommand(
    terminal,
    fullCommand,
    `octopai: ${options.name}`,
    options.workdir
  );

  // Spawn the terminal
  const child = spawn(cmd, args, {
    detached: true,
    stdio: "ignore",
  });

  child.unref();

  // Create tentacle state
  const tentacle = await createTentacleState(options, child.pid);

  console.log(`Tentacle "${options.name}" spawned (pid: ${child.pid})`);

  return tentacle;
}

/**
 * List running tentacles
 */
export async function listTentacles(octopaiDir: string): Promise<Tentacle[]> {
  const stateDir = join(octopaiDir, "state", "tentacles");
  const { readdir } = await import("fs/promises");

  try {
    const files = await readdir(stateDir);
    const tentacles: Tentacle[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      try {
        const content = await readFile(join(stateDir, file), "utf-8");
        tentacles.push(JSON.parse(content));
      } catch {
        continue;
      }
    }

    return tentacles;
  } catch {
    return [];
  }
}

/**
 * Update tentacle status
 */
export async function updateTentacleStatus(
  octopaiDir: string,
  tentacleId: string,
  status: Tentacle["status"]
): Promise<void> {
  const statePath = join(octopaiDir, "state", "tentacles", `${tentacleId}.json`);

  try {
    const content = await readFile(statePath, "utf-8");
    const tentacle: Tentacle = JSON.parse(content);
    tentacle.status = status;
    tentacle.lastActivity = new Date();

    await writeFile(statePath, JSON.stringify(tentacle, null, 2), "utf-8");
  } catch (err) {
    console.error(`Failed to update tentacle ${tentacleId}:`, err);
  }
}

/**
 * Kill a tentacle (if we have its PID)
 */
export async function killTentacle(octopaiDir: string, tentacleId: string): Promise<boolean> {
  const statePath = join(octopaiDir, "state", "tentacles", `${tentacleId}.json`);

  try {
    const content = await readFile(statePath, "utf-8");
    const tentacle: Tentacle = JSON.parse(content);

    if (tentacle.pid) {
      try {
        process.kill(tentacle.pid);
        console.log(`Killed tentacle ${tentacleId} (pid: ${tentacle.pid})`);
      } catch {
        console.log(`Tentacle ${tentacleId} process already dead`);
      }
    }

    // Update status
    tentacle.status = "stopped";
    await writeFile(statePath, JSON.stringify(tentacle, null, 2), "utf-8");

    return true;
  } catch (err) {
    console.error(`Failed to kill tentacle ${tentacleId}:`, err);
    return false;
  }
}
