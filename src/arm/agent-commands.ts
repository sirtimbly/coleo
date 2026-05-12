/**
 * Agent Commands
 * 
 * Generates commands for spawning AI agents.
 */

import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { getCliEntrypoint } from "../cli/entrypoint";
import type { SpawnOptions, AgentType } from "./spawner-types";

/**
 * Generate the agent command based on type
 */
export function getAgentCommand(agent: AgentType, options: SpawnOptions): string {
  const mcpConfig = join(options.coleoDir, "mcp", `${options.name}.json`);
  
  const modelEnv = options.provider && options.model 
    ? `OPENCODE_MODEL=${options.provider}/${options.model} `
    : options.model 
      ? `OPENCODE_MODEL=${options.model} `
      : "";
  
  switch (agent) {
    case "opencode":
      return `${modelEnv}COLEO_ARM_ID=${options.name} OPENCODE_CONFIG="${mcpConfig}" opencode`;

    case "claude-code":
      return `COLEO_ARM_ID=${options.name} claude`;

    case "aider":
      return `COLEO_ARM_ID=${options.name} aider`;

    case "custom":
      return options.customCommand || "bash";

    default:
      return "bash";
  }
}

/**
 * Create MCP configuration for the arm
 */
export async function createMcpConfig(options: SpawnOptions): Promise<void> {
  const mcpDir = join(options.coleoDir, "mcp");
  await mkdir(mcpDir, { recursive: true });

  const bunBinary = process.execPath;
  const cliEntrypoint = getCliEntrypoint();

  const mcpConfig = {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      coleo: {
        type: "local",
        command: [bunBinary, cliEntrypoint, "mcp", "serve"],
        environment: {
          COLEO_ARM_ID: options.name,
          COLEO_DIR: options.coleoDir,
        },
        enabled: true,
      },
    },
  };

  await writeFile(
    join(mcpDir, `${options.name}.json`),
    JSON.stringify(mcpConfig, null, 2),
    "utf-8"
  );
}
