/**
 * Kimi CLI Config Builder
 * 
 * Builds configuration for Kimi CLI MCP integration.
 */

import { join } from "node:path";
import { getCliEntrypoint } from "../cli/entrypoint";
import type { SpawnConfig } from "./types";

/**
 * Build Kimi CLI configuration for MCP
 */
export async function buildKimiConfig(
	armId: string,
	coleoDir: string,
	config: SpawnConfig,
): Promise<Record<string, unknown>> {
	// Get bun path for MCP
	let bunPath: string;
	try {
		const { execSync } = await import("child_process");
		bunPath = execSync("which bun", { encoding: "utf-8" }).trim();
	} catch {
		bunPath = join(process.env.HOME || "", ".bun", "bin", "bun");
	}

	const bunBinary = process.execPath;
	const cliEntrypoint = getCliEntrypoint();

	const kimiConfig: Record<string, unknown> = {
		// MCP configuration for brain communication
		mcpServers: {
			coleo: {
				command: [bunBinary, cliEntrypoint, "mcp", "serve"],
				env: {
					COLEO_ARM_ID: armId,
					COLEO_DIR: coleoDir,
					PATH: `${join(process.env.HOME || "", ".bun", "bin")}:${process.env.PATH || ""}`,
					HOME: process.env.HOME || "",
				},
				enabled: true,
			},
		},
	};

	// Set model if specified
	if (config.provider && config.model) {
		kimiConfig.provider = config.provider;
		kimiConfig.model = config.model;
	} else if (config.model) {
		kimiConfig.model = config.model;
	}

	return kimiConfig;
}
