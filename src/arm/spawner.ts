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
import { harnessRegistry, type HarnessSession, type SpawnConfig, type SendPromptOptions } from "../harness";
import { getColeoDir, getRandomPreferredModel } from "../config";
import type { Arm } from "../types";

// Import from extracted modules
import type { AgentType, TerminalEmulator, SpawnOptions } from "./spawner-types";
import { isHeadlessEnvironment, detectTerminal, getTerminalCommand } from "./terminal-detector";
import { getAgentCommand, createMcpConfig } from "./agent-commands";
import { listArms, updateArmStatus, killArm, createArmState } from "./spawner-db";

const execAsync = promisify(exec);

// Re-export types and functions for backward compatibility
export type { AgentType, TerminalEmulator, SpawnOptions } from "./spawner-types";
export { isHeadlessEnvironment, detectTerminal, getTerminalCommand } from "./terminal-detector";
export { getAgentCommand, createMcpConfig } from "./agent-commands";
export { listArms, updateArmStatus, killArm, isProcessRunning, createArmState } from "./spawner-db";

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
  const logsDir = join(options.coleoDir, "logs");
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
        COLEO_DIR: options.coleoDir,
        COLEO_ARM_ID: options.name,
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
    await updateArmStatus(options.coleoDir, options.name, "idle");
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
    const logsDir = join(options.coleoDir, "logs");
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
  const windowTitle = `coleo:${options.name}:${sessionId}`;

  // Get terminal launch command
  const { cmd, args } = await getTerminalCommand(
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
