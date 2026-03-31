/**
 * Arm Spawner
 * 
 * Spawns AI agents via the harness system (PTY-controlled) or in terminal windows.
 * The harness approach is recommended for production as it gives full control.
 */

import { spawn } from "child_process";
import { mkdir, appendFile } from "fs/promises";
import { join } from "path";
import { harnessRegistry, type HarnessSession, type SpawnConfig, type SendPromptOptions } from "../harness";
import { getRandomPreferredModel } from "../config";
import type { Arm } from "../types";

// Re-export types for backward compatibility
export type { AgentType, TerminalEmulator, SpawnOptions } from "./spawner-types";

// Re-export functions used externally
export { getAgentCommand, createMcpConfig } from "./agent-commands";
export { listArms, updateArmStatus, killArm } from "./spawner-db";
export { detectTerminal, getTerminalCommand } from "./terminal-detector";

import { getAgentCommand, createMcpConfig } from "./agent-commands";
import { getDatabase, createArmState } from "./spawner-db";
import { detectTerminal, getTerminalCommand } from "./terminal-detector";
import type { SpawnOptions } from "./spawner-types";

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

  await createMcpConfig(options);

  const logsDir = join(options.coleoDir, "logs");
  await mkdir(logsDir, { recursive: true });

  if (!harnessRegistry.has(options.agent)) {
    console.warn(`No harness available for ${options.agent}, falling back to terminal mode`);
    return spawnArmInTerminal(options);
  }

  const harness = harnessRegistry.get(options.agent);

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
    
    activeSessions.set(options.name, session);

    const pid = harness.getPid ? harness.getPid(session) : undefined;

    const arm = await createArmState(options, pid);

    const db = await getDatabase(options.coleoDir);
    const now = new Date().toISOString();
    try {
      db.run("UPDATE arms SET status = 'idle', last_heartbeat = ?, updated_at = ? WHERE id = ?", [now, now, options.name]);
    } finally {
      db.close();
    }
    arm.status = "idle";

    const logFile = join(logsDir, `${options.name}.log`);
    session.pty.onData = async (data: string) => {
      try {
        await appendFile(logFile, data);
      } catch {
        // Ignore logging errors
      }
    };

    console.log(`Arm "${options.name}" spawned via harness (pid: ${pid}, session: ${session.id})`);

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
  let terminal = options.terminal || "auto";
  if (terminal === "auto" || terminal === "harness") {
    terminal = await detectTerminal();
  }

  console.log(`Spawning arm "${options.name}" using ${options.agent} in ${terminal}${terminal === "headless" || terminal === "tmux" ? " (headless mode)" : ""}`);

  await createMcpConfig(options);

  if (terminal === "headless" || terminal === "tmux") {
    const logsDir = join(options.coleoDir, "logs");
    await mkdir(logsDir, { recursive: true });
  }

  const agentCommand = getAgentCommand(options.agent, options);

  let fullCommand = agentCommand;
  if (options.initialPrompt) {
    fullCommand = `echo "Initial task: ${options.initialPrompt}" && ${agentCommand}`;
  }

  const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const windowTitle = `coleo:${options.name}:${sessionId}`;

  const { cmd, args } = getTerminalCommand(
    terminal,
    fullCommand,
    windowTitle,
    options.workdir
  );

  const child = spawn(cmd, args, {
    detached: true,
    stdio: "ignore",
  });

  child.unref();

  const arm = await createArmState(options, child.pid);

  console.log(`Arm "${options.name}" spawned (pid: ${child.pid}, window: ${windowTitle})`);

  return arm;
}

/**
 * Spawn a new arm - uses harness by default, falls back to terminal if --terminal specified
 */
export async function spawnArm(options: SpawnOptions): Promise<Arm> {
  if (!options.provider && !options.model) {
    const randomModel = getRandomPreferredModel();
    if (randomModel) {
      console.log(`Selected random preferred model: ${randomModel.provider}/${randomModel.model}`);
      options.provider = randomModel.provider;
      options.model = randomModel.model;
    }
  }

  if (options.terminal && options.terminal !== "auto" && options.terminal !== "harness") {
    return spawnArmInTerminal(options);
  }

  return spawnArmWithHarness(options);
}
