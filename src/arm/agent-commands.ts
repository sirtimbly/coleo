/**
 * Agent Commands
 *
 * Functions for generating agent commands and MCP configuration.
 */

import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import { getCliEntrypoint } from "../cli/entrypoint";
import type { AgentType, SpawnOptions } from "./spawner-types";

/**
 * Generate the agent command based on type
 */
export function getAgentCommand(agent: AgentType, options: SpawnOptions): string {
  const mcpConfig = join(options.coleoDir, "mcp", `${options.name}.json`);
  
  // Build model string if provider/model specified
  const modelEnv = options.provider && options.model 
    ? `OPENCODE_MODEL=${options.provider}/${options.model} `
    : options.model 
      ? `OPENCODE_MODEL=${options.model} `
      : "";
  
  switch (agent) {
    case "opencode":
      // OpenCode reads config from OPENCODE_CONFIG
      return `${modelEnv}COLEO_ARM_ID=${options.name} OPENCODE_CONFIG="${mcpConfig}" opencode`;

    case "claude-code":
      // Claude Code (assuming similar CLI)
      return `COLEO_ARM_ID=${options.name} claude`;

    case "aider":
      // Aider doesn't support MCP natively, but can still be used
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

  // OpenCode v1.1+ expects MCP servers under `mcp` in OPENCODE_CONFIG.
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
