import { Command } from "commander";
import { getApiConfig, getColeoDir, isApiRunning } from "../context";

export function registerAgentCommands(program: Command): void {
  const agentCmd = program.command("agent").description("Manage arm agents (distributed arm management)");

  agentCmd
    .command("start")
    .description("Start an arm agent daemon on this host")
    .option("-n, --nats-url <url>", "NATS server URL", "nats://localhost:4222")
    .option("-m, --max-arms <n>", "Maximum number of arms to manage", "10")
    .option("-i, --heartbeat-interval <ms>", "Heartbeat interval in milliseconds", "30000")
    .option("-v, --verbose", "Enable debug logging")
    .option("--id <id>", "Custom agent ID (default: auto-generated from hostname)")
    .action(async (options) => {
      const coleoDir = getColeoDir();

      const { ArmAgent } = await import("../../agent");

      const agent = new ArmAgent({
        agentId: options.id,
        natsUrl: options.natsUrl,
        octopaiDir: coleoDir,
        maxArms: parseInt(options.maxArms, 10),
        heartbeatIntervalMs: parseInt(options.heartbeatInterval, 10),
        debug: options.verbose,
      });

      console.log("Starting arm agent...");
      console.log(`  NATS URL: ${options.natsUrl}`);
      console.log(`  Coleo Dir: ${coleoDir}`);
      console.log(`  Max Arms: ${options.maxArms}`);
      console.log("");

      process.on("SIGINT", async () => {
        console.log("\nStopping agent...");
        await agent.stop();
        process.exit(0);
      });

      process.on("SIGTERM", async () => {
        await agent.stop();
        process.exit(0);
      });

      try {
        await agent.start();
        const info = agent.getInfo();
        console.log("");
        console.log("=".repeat(60));
        console.log(`  Agent ID: ${info.agentId}`);
        console.log(`  Hostname: ${info.hostname}`);
        console.log(`  Capabilities: ${info.capabilities.join(", ")}`);
        console.log("=".repeat(60));
        console.log("");
        console.log("Agent running. Press Ctrl+C to stop.");

        await new Promise(() => {});
      } catch (err) {
        console.error(`Failed to start agent: ${err}`);
        console.error("");
        console.error("Make sure the API server with embedded NATS is running:");
        console.error("  coleo serve");
        process.exit(1);
      }
    });

  agentCmd
    .command("status")
    .description("Show status of connected agents")
    .action(async () => {
      const { apiUrl, headers } = getApiConfig();

      if (!(await isApiRunning())) {
        console.error("API server is not running. Start it with: coleo serve");
        process.exit(1);
      }

      const res = await fetch(`${apiUrl}/api/agents`, { headers });
      if (!res.ok) {
        console.error("Failed to get agent status. The API may not support this yet.");
        process.exit(1);
      }

      const data = (await res.json()) as {
        agents: Array<{
          agentId: string;
          hostname: string;
          capabilities: string[];
          activeArms: number;
          maxArms: number;
        }>;
      };
      const agents = data.agents || [];

      if (agents.length === 0) {
        console.log("No agents connected.");
        console.log("");
        console.log("Start an agent with: coleo agent start");
        return;
      }

      console.log("Connected Agents:");
      console.log("=".repeat(60));

      for (const agent of agents) {
        console.log(`  ${agent.agentId}`);
        console.log(`    Hostname: ${agent.hostname}`);
        console.log(`    Capabilities: ${agent.capabilities.join(", ")}`);
        console.log(`    Arms: ${agent.activeArms}/${agent.maxArms}`);
        console.log("");
      }
    });
}
