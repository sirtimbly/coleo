import { describe, it, expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpConfig, getAgentCommand, type SpawnOptions } from "../spawner";

function makeOptions(coleoDir: string): SpawnOptions {
  return {
    coleoDir,
    name: "test-arm",
    agent: "opencode",
    workdir: process.cwd(),
  };
}

describe("spawner OpenCode MCP config", () => {
  it("writes OpenCode config with mcp.coleo using current schema", async () => {
    const coleoDir = await mkdtemp(join(tmpdir(), "coleo-spawner-"));
    try {
      const options = makeOptions(coleoDir);
      await createMcpConfig(options);

      const configPath = join(coleoDir, "mcp", `${options.name}.json`);
      const raw = await readFile(configPath, "utf-8");
      const config = JSON.parse(raw) as Record<string, any>;

      expect(config.$schema).toBe("https://opencode.ai/config.json");
      expect(config.mcp?.coleo?.type).toBe("local");
      expect(config.mcp?.coleo?.enabled).toBe(true);
      expect(config.mcp?.coleo?.environment?.COLEO_ARM_ID).toBe(options.name);
      expect(config.mcp?.coleo?.environment?.COLEO_DIR).toBe(options.coleoDir);
      expect(config.mcp?.coleo?.command?.slice(-2)).toEqual(["mcp", "serve"]);

      expect(config.mcpServers).toBeUndefined();
      expect(raw.includes("octopai")).toBe(false);
    } finally {
      await rm(coleoDir, { recursive: true, force: true });
    }
  });

  it("uses OPENCODE_CONFIG in the legacy terminal command", () => {
    const options = makeOptions("/tmp/coleo-test");
    const cmd = getAgentCommand("opencode", options);

    expect(cmd.includes('COLEO_ARM_ID=test-arm')).toBe(true);
    expect(cmd.includes('OPENCODE_CONFIG="/tmp/coleo-test/mcp/test-arm.json"')).toBe(true);
    expect(cmd.includes("OPENCODE_MCP_CONFIG")).toBe(false);
  });
});
