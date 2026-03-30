import { Command } from "commander";
import { runMcpServer } from "../../mcp";

export function registerMcpCommands(program: Command): void {
  const mcpCmd = program.command("mcp").description("Run the MCP server used by arms");

  mcpCmd
    .command("serve")
    .description("Run the MCP server (used by arms)")
    .action(async () => {
      await runMcpServer();
    });
}
