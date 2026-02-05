import { Command } from "commander";
import { join } from "path";
import type { Arm } from "../../types";
import { spawnArm, listArms, killArm } from "../../arm";
import { generateArmName, generateArmNames, getNameGeneratorStats } from "../arm-names";
import {
  expandPath,
  getApiConfig,
  getColeoDir,
  getSubcommandArgs,
  isApiRunning,
} from "../context";
import { prompt, promptSelect, promptYN, loadArmTemplates } from "../helpers/prompts";

function normalizeTemplateName(value: string): string {
  return value.trim().replace(/\.toml$/i, "");
}

export function registerArmCommands(program: Command): void {

  const armCmd = program.command("arm").description("Manage arms (agents)");

  armCmd
    .command("spawn")
    .description("Spawn a new arm (interactive if no arguments provided)")
    .option("-n, --name <name>", "Arm name/ID (auto-generates a sci-fi name if not provided)")
    .option("-w, --workdir <path>", "Working directory", process.cwd())
    .option(
      "-t, --terminal <terminal>",
      "Terminal emulator (ghostty, iterm2, terminal, tmux). If not specified, uses headless API server.",
    )
    .option("-p, --prompt <prompt>", "Initial prompt/task for the agent")
    .option(
      "--harness <harness>",
      "Harness type (opencode-api, opencode-tui, opencode). Default: opencode-tui if terminal specified, otherwise opencode-api.",
    )
    .option("--provider <provider>", "AI provider (e.g., anthropic, openai, opencode-zen)")
    .option("--model <model>", "Model name (e.g., gpt-5.1-codex-mini)")
    .option("--template <name>", "Use a template from ~/.coleo/arms/")
    .option("--recover", "Attempt to recover an existing OpenCode server (default: false)")
    .option("--watch", "Watch the arm's conversation in real-time after spawning")
    .action(async (options) => {
      const coleoDir = getColeoDir();
      const armAgent = "opencode";
      const armDomain = "general";
      const subcommandArgs = getSubcommandArgs(["arm", "spawn"]);
      const interactive = subcommandArgs.length === 0;

      let armName = (options.name || "").trim();
      let armWorkdir = options.workdir || process.cwd();
      let armProvider = options.provider;
      let armModel = options.model;
      let armTemplate = normalizeTemplateName(options.template || "");

      if (!interactive && !armName) {
        armName = generateArmName();
        console.log(`No --name provided. Generated arm name: ${armName}`);
      }

      if (interactive) {
        console.log("\n=== Arm Configuration ===\n");

        const suggestedName = armName || generateArmName();
        const templates = await loadArmTemplates(join(coleoDir, "arms"));

        let useTemplate = false;
        if (templates.length > 0) {
          useTemplate = await promptYN("Would you like to use an arm template?", true);
          if (useTemplate) {
            const templateNames = templates.map((t) => `${t.file} - ${t.description}`);
            templateNames.push("Custom arm (no template)");
            const selected = await promptSelect("Select a template:", templateNames);
            const selectedIdx = templateNames.indexOf(selected);
            if (selectedIdx >= 0 && selectedIdx < templates.length) {
              const selectedTemplate = templates[selectedIdx];
              if (selectedTemplate) {
                armTemplate = normalizeTemplateName(selectedTemplate.file);
              }
            }
          }
        }

        const customName = await prompt(`Arm name [${suggestedName}]: `);
        armName = customName.trim() || suggestedName;

        const workdir = await prompt(`Working directory [${process.cwd()}]: `);
        if (workdir.trim()) {
          armWorkdir = workdir;
        }

        const hasProvider = await promptYN("Configure provider/model?", false);
        if (hasProvider) {
          const provider = await prompt("Provider (anthropic, openai, github-copilot, opencode-zen): ");
          if (provider.trim()) {
            armProvider = provider;
            const model = await prompt("Model [optional]: ");
            if (model.trim()) {
              armModel = model;
            }
          }
        }

        console.log("\n=== Spawning Arm ===");
        console.log(`  Name: ${armName}`);
        if (armTemplate) {
          console.log(`  Template: ${armTemplate}.toml`);
        }
        console.log(`  Workdir: ${armWorkdir}`);
        if (armProvider) {
          console.log(`  Provider: ${armProvider}`);
          if (armModel) console.log(`  Model: ${armModel}`);
        }
        console.log("");
      }

      if (!armName) {
        armName = generateArmName();
      }

      if (options.terminal && !options.harness) {
        console.log(`Using opencode-tui harness for visible terminal with API control...`);

        const { apiUrl, headers } = getApiConfig();
        if (!await isApiRunning()) {
          console.error("API server is not running.");
          console.error(`Expected at: ${apiUrl}`);
          console.error("");
          console.error("The opencode-tui harness requires the API server for arm tracking.");
          console.error("Start the API server: coleo serve");
          process.exit(1);
        }

        const existsRes = await fetch(`${apiUrl}/api/arms/${armName}`, { headers });
        const armExists = existsRes.ok;

        if (armExists) {
          const existingArm = await existsRes.json() as { arm: { status: string } };
          if (existingArm.arm.status !== "stopped") {
            console.error(`Arm ${armName} already exists with status: ${existingArm.arm.status}`);
            console.error("Use 'coleo arm kill <name>' first, or choose a different name.");
            process.exit(1);
          }
          console.log(`Restarting stopped arm: ${armName}`);
        } else {
        const createPayload: Record<string, unknown> = {
          name: armName,
          status: "starting",
          provider: armProvider,
          model: armModel,
        };
        if (armTemplate) {
          createPayload.template = armTemplate;
        } else {
          createPayload.domain = armDomain;
        }
        createPayload.harness = "opencode-tui";

        const createRes = await fetch(`${apiUrl}/api/arms`, {
          method: "POST",
          headers,
          body: JSON.stringify(createPayload),
        });

          if (!createRes.ok) {
            const err = await createRes.json().catch(() => ({}));
            console.error(`Failed to create arm: ${(err as { error?: string }).error || createRes.statusText}`);
            process.exit(1);
          }
        }

        const spawnRes = await fetch(`${apiUrl}/api/arms/${armName}/spawn`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            workdir: expandPath(armWorkdir),
            provider: armProvider,
            model: armModel,
            initialPrompt: options.prompt,
            harness: "opencode-tui",
            terminal: options.terminal,
            recover: options.recover || false,
          }),
        });

        // Always read response as text first, then parse
        const rawResponse = await spawnRes.text();
        
        if (!spawnRes.ok) {
          try {
            const err = JSON.parse(rawResponse);
            console.error(`Failed to spawn arm: ${(err as { error?: string }).error || spawnRes.statusText}`);
          } catch {
            console.error(`Failed to spawn arm: ${spawnRes.statusText}`);
          }
          process.exit(1);
        }

        const result = JSON.parse(rawResponse) as { arm: Arm };
        console.log(`Arm spawned with opencode-tui harness in ${options.terminal}:`);
        console.log(`  ID: ${result.arm.id}`);
        if (result.arm.provider || result.arm.model) {
          console.log(
            `  Model: ${result.arm.provider ? result.arm.provider + "/" : ""}${result.arm.model || "default"}`,
          );
        }
        console.log(`  Status: ${result.arm.status}`);
        console.log(`  PID: ${result.arm.pid || "unknown"}`);
        console.log("");
        console.log("The arm is now running in a visible terminal window.");
        console.log("You can interact with it directly or via the API.");
        return;
      }

      if (options.terminal && options.harness === "opencode") {
        const arm = await spawnArm({
          coleoDir,
          name: armName,
          agent: armAgent,
          workdir: expandPath(armWorkdir),
          terminal: options.terminal,
          initialPrompt: options.prompt,
          headless: false,
          provider: armProvider,
          model: armModel,
          domain: armDomain,
        });

        console.log(`Arm spawned in terminal (legacy mode): ${arm.id}`);
        if (arm.provider || arm.model) {
          console.log(`  Model: ${arm.provider ? arm.provider + "/" : ""}${arm.model || "default"}`);
        }
        console.log(`  Status: ${arm.status}`);
        console.log(`  PID: ${arm.pid || "unknown"}`);
        return;
      }

      const { apiUrl, headers } = getApiConfig();

      if (!await isApiRunning()) {
        console.error("API server is not running.");
        console.error(`Expected at: ${apiUrl}`);
        console.error("");
        console.error("Options:");
        console.error("  1. Start the API server: coleo serve");
        console.error("  2. Use terminal mode: coleo arm spawn --name <name> --terminal ghostty");
        process.exit(1);
      }

      const existsRes = await fetch(`${apiUrl}/api/arms/${armName}`, { headers });
      const armExists = existsRes.ok;

      if (armExists) {
        const existingArm = await existsRes.json() as { arm: { status: string } };
        if (existingArm.arm.status !== "stopped") {
          console.error(`Arm ${armName} already exists with status: ${existingArm.arm.status}`);
          console.error("Use 'coleo arm kill <name>' first, or choose a different name.");
          process.exit(1);
        }
        console.log(`Restarting stopped arm: ${armName}`);
      } else {
        const harnessType = options.harness || "opencode-api";
        const createPayload: Record<string, unknown> = {
          name: armName,
          status: "starting",
          provider: armProvider,
          model: armModel,
        };
        if (armTemplate) {
          createPayload.template = armTemplate;
        } else {
          createPayload.domain = armDomain;
        }
        if (options.harness || !armTemplate) {
          createPayload.harness = harnessType;
        }

        const createRes = await fetch(`${apiUrl}/api/arms`, {
          method: "POST",
          headers,
          body: JSON.stringify(createPayload),
        });

        if (!createRes.ok) {
          const err = await createRes.json().catch(() => ({}));
          console.error(`Failed to create arm: ${(err as { error?: string }).error || createRes.statusText}`);
          process.exit(1);
        }
      }

      const spawnRes = await fetch(`${apiUrl}/api/arms/${armName}/spawn`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          workdir: expandPath(armWorkdir),
          provider: armProvider,
          model: armModel,
          initialPrompt: options.prompt,
          recover: options.recover || false,
        }),
      });

      // Always read response as text first, then parse
      const rawResponse = await spawnRes.text();
      
      if (!spawnRes.ok) {
        let errorMessage = spawnRes.statusText;
        try {
          const err = JSON.parse(rawResponse);
          errorMessage = (err as { error?: string }).error || spawnRes.statusText;
          console.error(`Spawn response error body:`, JSON.stringify(err, null, 2));
        } catch {
          console.error(`Spawn response text:`, rawResponse);
        }
        console.error(`Failed to spawn arm: ${errorMessage}`);
        process.exit(1);
      }
      
      // Debug: Log raw response
      console.log(`Raw spawn response:`, rawResponse);

      const result = JSON.parse(rawResponse) as { 
        spawned: boolean;
        distributed?: boolean;
        agentId?: string;
        host?: string;
        sessionId?: string; 
        pid?: number;
        port?: number;
      };

      console.log(`Arm spawned via API: ${armName}`);
      console.log(`  Full response:`, JSON.stringify(result, null, 2));
      if (armProvider || armModel) {
        console.log(`  Model: ${armProvider ? armProvider + "/" : ""}${armModel || "default"}`);
      }
      if (result.distributed) {
        console.log(`  Type: Distributed (via agent ${result.agentId})`);
        console.log(`  Host: ${result.host}`);
        console.log(`  Port: ${result.port}`);
        console.log(`  PID: ${result.pid || "unknown"}`);
        console.log("  Note: Distributed arms don't have direct session access");
      } else {
        console.log(`  Session: ${result.sessionId}`);
        console.log(`  PID: ${result.pid || "unknown"}`);
      }
      console.log("");
      console.log("The arm is running in the API server process.");

      if (options.watch) {
        const isLocalAgent = !result.agentId || 
          result.host === "127.0.0.1" || 
          result.host?.includes("localhost") ||
          result.host?.includes("Timothys-MacBook");
        
        if (result.distributed && !isLocalAgent) {
          console.log("\n⚠️  Cannot watch distributed arm directly.");
          console.log(`The arm is running on remote agent ${result.host}:${result.port}`);
          console.log(`Use: octopai arm tail ${armName}`);
          console.log(`Or:  octopai arm status ${armName}`);
        } else {
          console.log("\n");
          await watchArm(armName, { history: "0" });
        }
      } else {
        console.log(`Watch events: coleo arm tail ${armName}`);
        console.log(`View status:  coleo arm status ${armName}`);
        console.log(`View todos:   coleo arm todos ${armName}`);
      }
    });

  armCmd
    .command("names")
    .description("Generate sample sci-fi arm names (inspired by Children of Time/Ruin)")
    .option("-c, --count <number>", "Number of names to generate", "10")
    .option("--stats", "Show name generator statistics")
    .action(async (options) => {
      if (options.stats) {
        const stats = getNameGeneratorStats();
        console.log("\n=== Arm Name Generator ===");
        console.log("Inspired by Adrian Tchaikovsky's 'Children of Time' series\n");
        console.log(`Prefixes:          ${stats.prefixes}`);
        console.log(`Suffixes:          ${stats.suffixes}`);
        console.log(`Epithets:          ${stats.epithets}`);
        console.log(`Classic names:     ${stats.classics}`);
        console.log(`Base combinations: ${stats.baseCombinations.toLocaleString()}`);
        console.log(`With epithets:     ${stats.withEpithets.toLocaleString()}`);
        console.log(`Total unique:      ${stats.total.toLocaleString()}`);
        console.log("");
      }

      const count = Math.min(Math.max(1, parseInt(options.count) || 10), 100);
      const names = generateArmNames(count);

      console.log(`\n=== ${count} Arm Name Suggestions ===\n`);
      names.forEach((name, i) => {
        console.log(`  ${(i + 1).toString().padStart(2)}. ${name}`);
      });
      console.log("");
    });

  armCmd
    .command("list")
    .description("List all arms")
    .option("--all", "Include stopped arms (hidden by default)")
    .action(async (options) => {
      const coleoDir = getColeoDir();
      let arms = await listArms(coleoDir);

      if (!options.all) {
        const activeArms = arms.filter((a) => a.status !== "stopped");
        if (activeArms.length === 0 && arms.length > 0) {
          console.log("No active arms. Use --all to see stopped arms.");
          console.log(`(${arms.length} stopped arm(s) hidden)`);
          return;
        }
        arms = activeArms;
      }

      if (arms.length === 0) {
        console.log("No arms registered.");
        console.log("Spawn one with: coleo arm spawn --name <name> --agent opencode");
        return;
      }

      console.log("Arms:");
      for (const a of arms) {
        const status = a.status === "running" || a.status === "idle"
          ? "●"
          : a.status === "busy"
            ? "◐"
            : a.status === "stopped"
              ? "○"
              : "◌";
        const domain = (a as { domain?: string }).domain ? ` [${(a as { domain?: string }).domain}]` : "";
        console.log(`  ${status} ${a.id} (${a.agent})${domain} - ${a.status}${a.currentTask ? ` → ${a.currentTask}` : ""}`);
      }

      if (options.all) {
        const stoppedCount = arms.filter((a) => a.status === "stopped").length;
        if (stoppedCount > 0) {
          console.log("");
          console.log(`Tip: Run 'coleo arm cleanup' to remove ${stoppedCount} stopped arm(s).`);
        }
      }
    });

  armCmd
    .command("kill <name>")
    .description("Kill an arm")
    .action(async (name) => {
      const coleoDir = getColeoDir();
      const { apiUrl, headers } = getApiConfig();

      if (await isApiRunning()) {
        const killRes = await fetch(`${apiUrl}/api/arms/${name}/kill`, {
          method: "POST",
          headers,
        });

        if (killRes.ok) {
          console.log(`Arm ${name} killed via API.`);
          return;
        }
      }

      const success = await killArm(coleoDir, name);

      if (success) {
        console.log(`Arm ${name} killed.`);
      } else {
        console.log(`Failed to kill arm ${name}.`);
      }
    });

  armCmd
    .command("prompt <name> <message>")
    .description("Send a prompt to a running arm")
    .option("-i, --interrupt", "Send escape key twice before prompt to cancel/interrupt current work")
    .action(async (name, message, options: { interrupt?: boolean }) => {
      const { apiUrl, headers } = getApiConfig();

      if (!await isApiRunning()) {
        console.error("API server is not running. Start it with: coleo serve");
        process.exit(1);
      }

      const armRes = await fetch(`${apiUrl}/api/arms/${name}`, { headers });
      if (!armRes.ok) {
        console.error(`Arm not found: ${name}`);
        process.exit(1);
      }

      const armData = await armRes.json() as { arm: { status: string } };
      if (armData.arm.status !== "idle" && armData.arm.status !== "busy") {
        console.error(`Arm ${name} is not running (status: ${armData.arm.status})`);
        console.error("Start the arm first with: coleo arm spawn --name " + name);
        process.exit(1);
      }

      const promptRes = await fetch(`${apiUrl}/api/arms/${name}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: message, interrupt: options.interrupt }),
      });

      if (!promptRes.ok) {
        const err = await promptRes.json().catch(() => ({}));
        console.error(`Failed to send prompt: ${(err as { error?: string }).error || promptRes.statusText}`);
        process.exit(1);
      }

      console.log(`Prompt sent to arm ${name}${options.interrupt ? " (interrupted first)" : ""}`);
      console.log(`(Arm is now ${armData.arm.status === "idle" ? "busy" : "processing"})`);
    });

  armCmd
    .command("tail [name]")
    .description("Watch real-time events from arm(s)")
    .option("-a, --all", "Show events from all arms (default if no name given)")
    .option("-f, --filter <types>", "Filter event types (comma-separated, e.g. 'status,tool')")
    .action(async (name?: string, options?: { all?: boolean; filter?: string }) => {
      const { apiUrl, headers } = getApiConfig();
      const apiKey = process.env.COLEO_API_KEY;

      if (!await isApiRunning()) {
        console.error("API server is not running. Start it with: coleo serve");
        process.exit(1);
      }

      if (!apiKey) {
        console.error("COLEO_API_KEY environment variable is required for WebSocket connection");
        process.exit(1);
      }

      if (name && !options?.all) {
        const armRes = await fetch(`${apiUrl}/api/arms/${name}`, { headers });
        if (!armRes.ok) {
          console.error(`Arm not found: ${name}`);
          process.exit(1);
        }
      }

      const filterTypes = options?.filter?.split(",").map((t) => t.trim()) || [];
      const showAll = !name || options?.all;

      console.log(`Tailing events${showAll ? " from all arms" : ` from ${name}`}...`);
      console.log("Press Ctrl+C to stop\n");

      const wsUrl = apiUrl.replace(/^http/, "ws") + "/ws";
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "auth", apiKey }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);

          if (msg.type === "auth") {
            if (msg.success) {
              ws.send(JSON.stringify({ type: "subscribe", channel: "arm-events" }));
            } else {
              console.error("Authentication failed:", msg.error);
              process.exit(1);
            }
            return;
          }

          if (msg.type === "subscribed") {
            console.log(`Connected and subscribed to ${msg.channel}`);
            return;
          }

          if (msg.channel === "arm-events") {
            const armId = msg.data?.armId;
            const eventType = msg.event?.replace("arm.", "") || "unknown";

            if (!showAll && armId !== name) return;
            if (filterTypes.length > 0 && !filterTypes.some((t) => eventType.includes(t))) return;

            const timestamp = new Date(msg.timestamp).toLocaleTimeString();
            const armLabel = armId ? `[${armId}]` : "";

            let prefix = "";
            if (eventType.includes("status")) prefix = "📊";
            else if (eventType.includes("tool") || eventType.includes("part-tool")) prefix = "🔧";
            else if (eventType.includes("message")) prefix = "💬";
            else if (eventType.includes("file")) prefix = "📄";
            else if (eventType.includes("todo")) prefix = "✅";
            else prefix = "📡";

            const formatValue = (val: unknown): string => {
              if (val === null || val === undefined) return "unknown";
              if (typeof val === "string") return val;
              if (typeof val === "number" || typeof val === "boolean") return String(val);
              if (typeof val === "object") {
                const obj = val as Record<string, unknown>;
                if (obj.status) return String(obj.status);
                if (obj.name) return String(obj.name);
                if (obj.id) return String(obj.id);
                return JSON.stringify(val);
              }
              return String(val);
            };

            let details = "";
            const data = msg.data || {};

            if (eventType === "status") {
              const statusVal = typeof data.status === "object" && data.status !== null
                ? (data.status as Record<string, unknown>).status || data.status
                : data.status;
              details = `status=${formatValue(statusVal)}`;
              if (data.title) details += ` title="${formatValue(data.title)}"`;
            } else if (eventType.includes("part-tool")) {
              details = `tool=${formatValue(data.toolName || data.name)}`;
              if (data.state) details += ` state=${formatValue(data.state)}`;
              else if (data.status) details += ` status=${formatValue(data.status)}`;
            } else if (eventType.includes("message")) {
              details = `role=${formatValue(data.role)}`;
              if (data.id) details += ` id=${formatValue(data.id)}`;
            } else if (eventType.includes("file")) {
              details = `path=${formatValue(data.path)}`;
            } else if (eventType.includes("todo")) {
              if (data.content) details = `"${formatValue(data.content)}"`;
              if (data.status) details += ` [${formatValue(data.status)}]`;
            } else {
              const keys = Object.keys(data).filter((k) => k !== "armId" && k !== "sessionId").slice(0, 3);
              details = keys.map((k) => `${k}=${formatValue(data[k])}`).join(" ");
            }

            console.log(`${timestamp} ${prefix} ${armLabel} ${eventType}: ${details}`);
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.onerror = (err) => {
        console.error("WebSocket error:", err);
      };

      ws.onclose = () => {
        console.log("\nConnection closed");
        process.exit(0);
      };

      process.on("SIGINT", () => {
        console.log("\nStopping...");
        ws.close();
        process.exit(0);
      });

      await new Promise(() => {});
    });

  /**
   * Watch an arm's conversation in real-time
   */
  async function watchArm(
    name: string,
    options?: { tools?: boolean; system?: boolean; history?: string; verbose?: boolean }
  ): Promise<void> {
    const { apiUrl, headers } = getApiConfig();
    const apiKey = process.env.COLEO_API_KEY;
    const showTools = options?.tools !== false;
    const showSystem = options?.system !== false;
    const historyCount = parseInt(options?.history || "2", 10);
    const verbose = options?.verbose === true;

    if (!(await isApiRunning())) {
      console.error("API server is not running. Start it with: coleo serve");
      process.exit(1);
    }

    if (!apiKey) {
      console.error("COLEO_API_KEY environment variable is required for WebSocket connection");
      process.exit(1);
    }

    const armRes = await fetch(`${apiUrl}/api/arms/${name}`, { headers });
    if (!armRes.ok) {
      console.error(`Arm not found: ${name}`);
      process.exit(1);
    }

    const armData = (await armRes.json()) as { 
      arm: { 
        port: number | null; 
        status: string;
        agentId?: string | null;
        host?: string | null;
      } 
    };
    
    // For distributed arms, check if we can access them
    if (armData.arm.agentId && !armData.arm.port) {
      console.error(`Arm ${name} is running on a remote agent (${armData.arm.agentId})`);
      console.error(`Remote host: ${armData.arm.host || "unknown"}`);
      console.error(`Cannot watch remote arms directly. Use: octopai arm tail ${name}`);
      process.exit(1);
    }
    
    if (!armData.arm.port) {
      console.error(`Arm ${name} is not running (no port assigned)`);
      process.exit(1);
    }

    const port = armData.arm.port;
    const isLocalAgent = !armData.arm.agentId || armData.arm.host === "127.0.0.1" || armData.arm.host?.includes("localhost");
    const agentHost = isLocalAgent ? "127.0.0.1" : armData.arm.host;
    const opencodeBaseUrl = `http://${agentHost}:${port}`;

    console.log(`Watching arm: ${name} (${armData.arm.status})`);
    if (armData.arm.agentId) {
      console.log(`  Type: Distributed (agent: ${armData.arm.agentId})`);
      console.log(`  Host: ${agentHost}:${port}`);
    } else {
      console.log(`  URL: ${opencodeBaseUrl}`);
    }
    console.log("Press Ctrl+C to stop\n");

    if (historyCount > 0) {
      try {
        const sessionsRes = await fetch(`${opencodeBaseUrl}/session`);
        if (sessionsRes.ok) {
          const sessions = (await sessionsRes.json()) as Array<{ id: string; title: string }>;
          if (sessions.length > 0) {
            const currentSession = sessions[sessions.length - 1];
            if (currentSession) {
              console.log(`Session: ${currentSession.title || currentSession.id}`);
              console.log("─".repeat(60));

              const msgsRes = await fetch(
                `${opencodeBaseUrl}/session/${currentSession.id}/message?limit=${historyCount * 2}`
              );
              if (msgsRes.ok) {
                const messages = (await msgsRes.json()) as Array<{
                  info: { role: string; id: string };
                  parts: Array<{
                    type: string;
                    text?: string;
                    toolName?: string;
                    name?: string;
                    state?: string;
                  }>;
                }>;

                const recentMessages = messages.slice(-historyCount);
                console.error(`[DEBUG HISTORY] Loaded ${messages.length} messages, showing ${recentMessages.length}`);
                for (const msg of recentMessages) {
                  const role = msg.info.role;
                  console.error(`[DEBUG HISTORY] Message role=${role}, parts=${msg.parts.length}`);
                  const roleLabel =
                    role === "assistant"
                      ? "🤖 Assistant"
                      : role === "user"
                        ? "👤 User"
                        : role === "system"
                          ? "⚙️ System"
                          : role;

                  if (role === "system" && !showSystem) continue;

                  console.log(roleLabel);
                  console.log("");

                  for (const part of msg.parts) {
                    if (part.type === "text" && part.text) {
                      // For long user messages (system prompt + user prompt combo), extract just the user part
                      if (role === "user" && part.text.length > 1000) {
                        const systemPromptEnd = part.text.indexOf("\n\n## Additional Instructions");
                        const systemPromptLength = systemPromptEnd > 0 ? systemPromptEnd : part.text.length;
                        console.log(`[System prompt: ${systemPromptLength.toLocaleString()} chars]`);
                        const additionalInstructionsMatch = part.text.match(/## Additional Instructions\n\n([\s\S]+)$/);
                        if (additionalInstructionsMatch && additionalInstructionsMatch[1]) {
                          console.log(additionalInstructionsMatch[1].trim());
                        } else {
                          console.log("(Initial prompt with system context)");
                        }
                      } else {
                        const text =
                          part.text.length > 500
                            ? part.text.slice(0, 500) + "\n... (truncated, showing last 500 chars)"
                            : part.text;
                        console.log(text);
                      }
                    } else if (part.type === "tool-invocation" && showTools) {
                      const toolName = part.toolName || part.name || "unknown";
                      const state = part.state || "completed";
                      console.log(`🔧 Tool: ${toolName} [${state}]`);
                    }
                  }
                  console.log("");
                  console.log("─".repeat(60));
                }
              }
            }
          }
        }
      } catch {
        console.log("(Could not fetch message history)");
        console.log("─".repeat(60));
      }
    }

    console.log("Waiting for new messages...\n");

    const opencodeUrl = `${opencodeBaseUrl}/event`;

    let currentRole = "";
    let lastWasNewline = true;
    let currentToolName = "";
    let isProcessing = false;

    const processEvent = (eventStr: string) => {
      const lines = eventStr.split("\n");
      let eventType = "";
      let data = "";

      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data = line.slice(5).trim();
        }
      }

      if (!data) return;

      try {
        const event = JSON.parse(data) as { type: string; properties: Record<string, unknown> };
        const { type, properties: props } = event;
        
        // TEMPORARY: Log all events to debug
        if (type.includes('message') || type.includes('part')) {
          console.error(`[DEBUG] Event: ${type}`);
        }

        if (type === "message.created" || type === "message.updated") {
          const info = props.info as Record<string, unknown> | undefined;
          const role = info?.role as string;
          if (role && role !== currentRole) {
            if (!lastWasNewline) {
              process.stdout.write("\n");
            }
            console.log("─".repeat(60));
            const roleLabel =
              role === "assistant"
                ? "🤖 Assistant"
                : role === "user"
                  ? "👤 User"
                  : role === "system"
                    ? "⚙️ System"
                    : role;
            console.log(roleLabel);
            console.log("");
            currentRole = role;
            lastWasNewline = true;

            // Show processing indicator after user message
            if (role === "user") {
              isProcessing = true;
              process.stdout.write("⏳ Thinking...");
            }
          }

          const error = info?.error as Record<string, unknown> | undefined;
          if (error) {
            const errorData = error.data as Record<string, unknown> | undefined;
            const errorMessage = errorData?.message || error.name || "Unknown error";
            if (!lastWasNewline) process.stdout.write("\n");
            console.log(`\n❌ Error: ${errorMessage}`);
            lastWasNewline = true;
          }
        }

        if (type === "message.part.updated" || type === "message.part.created") {
          const part = props.part as Record<string, unknown> | undefined;
          const delta = props.delta as string | undefined;

          if (part) {
            const partType = part.type as string;

            if (partType === "text") {
              // Use delta for streaming updates, fall back to full text when available
              const textContent = part.text as string | undefined;
              const textToWrite = delta ?? textContent;
              
              // TEMPORARY: Debug text parts
              console.error(`[DEBUG TEXT] delta=${delta ? 'yes' : 'no'}, textContent=${textContent ? textContent.length : 0} chars, textToWrite=${textToWrite ? textToWrite.length : 0} chars`);
              
              if (textToWrite && textToWrite.length > 0) {
                // Clear processing indicator on first assistant text
                if (isProcessing && currentRole === "assistant") {
                  isProcessing = false;
                  process.stdout.write("\r" + " ".repeat(20) + "\r"); // Clear "Thinking..."
                }
                process.stdout.write(textToWrite);
                lastWasNewline = textToWrite.endsWith("\n");
              }
            }

            if (partType === "tool-invocation" && showTools) {
              const toolName = (part.toolName as string) || (part.name as string);
              const state = part.state as string;

              if (state === "pending" || state === "running") {
                if (!lastWasNewline) process.stdout.write("\n");
                console.log(`\n🔧 Tool: ${toolName}`);
                currentToolName = toolName;
                lastWasNewline = true;
              } else if (state === "completed") {
                if (!lastWasNewline) process.stdout.write("\n");
                console.log(`   ✓ ${currentToolName || toolName} completed`);
                lastWasNewline = true;
              } else if (state === "error") {
                if (!lastWasNewline) process.stdout.write("\n");
                const error = (part.error as string) || "unknown error";
                console.log(`   ✗ ${currentToolName || toolName} failed: ${error}`);
                lastWasNewline = true;
              }
            }

            if (partType === "tool-result" && showTools) {
              if (!lastWasNewline) process.stdout.write("\n");
              lastWasNewline = true;
            }
          }
        }

        if (type === "session.status") {
          const status = props.status as Record<string, unknown> | undefined;
          const statusType = status?.type as string;
          if (statusType === "idle") {
            if (!lastWasNewline) process.stdout.write("\n");
            console.log("\n" + "─".repeat(60));
            console.log("✓ Response complete");
            console.log("─".repeat(60) + "\n");
            lastWasNewline = true;
            currentRole = "";
          }
        }

        if (type === "session.error") {
          const error = props.error as Record<string, unknown> | undefined;
          if (error) {
            const errorData = error.data as Record<string, unknown> | undefined;
            const errorMessage = errorData?.message || error.name || "Unknown error";
            if (!lastWasNewline) process.stdout.write("\n");
            console.log(`\n❌ Session Error: ${errorMessage}`);
            lastWasNewline = true;
          }
        }
      } catch {
        // Ignore parse errors
      }
    };

    try {
      if (verbose) {
        console.log(`[DEBUG] Connecting to SSE: ${opencodeUrl}`);
      }

      const response = await fetch(opencodeUrl, {
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });

      if (!response.ok) {
        console.error(`Failed to connect to OpenCode: ${response.statusText}`);
        process.exit(1);
      }

      if (!response.body) {
        console.error("No response body from OpenCode");
        process.exit(1);
      }

      if (verbose) {
        console.log(`[DEBUG] Connected! Response status: ${response.status}`);
        console.log(`[DEBUG] Content-Type: ${response.headers.get("content-type")}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      let running = true;
      process.on("SIGINT", () => {
        console.log("\n\nStopping...");
        running = false;
        reader.cancel();
        process.exit(0);
      });

      while (running) {
        const { done, value } = await reader.read();
        if (done) {
          if (verbose) console.log("[DEBUG] Stream ended (done=true)");
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        if (verbose && chunk.trim()) {
          console.log(
            `[DEBUG] Received chunk (${chunk.length} bytes): ${chunk.slice(0, 100).replace(/\n/g, "\\n")}...`
          );
        }
        buffer += chunk;

        const events = buffer.split("\n\n");
        buffer = events.pop() || "";

        for (const eventStr of events) {
          if (eventStr.trim()) {
            processEvent(eventStr);
          }
        }
      }
    } catch (err) {
      console.error(`Connection error: ${err}`);
      process.exit(1);
    }
  }

  armCmd
    .command("watch <name>")
    .description("Watch an arm's conversation in real-time (shows message text as it streams)")
    .option("--no-tools", "Hide tool invocations")
    .option("--no-system", "Hide system messages")
    .option("-n, --history <count>", "Show last N messages on connect", "2")
    .option("-v, --verbose", "Show all SSE events for debugging")
    .action(async (name, options?: { tools?: boolean; system?: boolean; history?: string; verbose?: boolean }) => {
      await watchArm(name, options);
    });

  armCmd
    .command("todos <name>")
    .description("Show the todo list for an arm")
    .action(async (name) => {
      const { apiUrl, headers } = getApiConfig();

      if (!await isApiRunning()) {
        console.error("API server is not running. Start it with: coleo serve");
        process.exit(1);
      }

      const armRes = await fetch(`${apiUrl}/api/arms/${name}`, { headers });
      if (!armRes.ok) {
        console.error(`Arm not found: ${name}`);
        process.exit(1);
      }

      const todosRes = await fetch(`${apiUrl}/api/arms/${name}/todos`, { headers });
      const todosRaw = await todosRes.text();
      
      if (!todosRes.ok) {
        try {
          const err = JSON.parse(todosRaw);
          console.error(`Failed to get todos: ${(err as { error?: string }).error || todosRes.statusText}`);
        } catch {
          console.error(`Failed to get todos: ${todosRes.statusText}`);
        }
        process.exit(1);
      }

      const data = JSON.parse(todosRaw) as { todos: Array<{ content: string; status: string; priority?: string }> };
      const todos = data.todos || [];

      if (todos.length === 0) {
        console.log(`No todos for arm: ${name}`);
        return;
      }

      console.log(`Todos for arm: ${name}`);
      console.log("=".repeat(50));

      for (const todo of todos) {
        const statusIcon = todo.status === "completed"
          ? "✓"
          : todo.status === "in_progress"
            ? "→"
            : todo.status === "cancelled"
              ? "✗"
              : "○";
        const priority = todo.priority ? ` [${todo.priority}]` : "";
        console.log(`  ${statusIcon} ${todo.content}${priority}`);
      }
    });

  armCmd
    .command("status <name>")
    .description("Show detailed status for an arm")
    .action(async (name) => {
      const { apiUrl, headers } = getApiConfig();

      if (!await isApiRunning()) {
        console.error("API server is not running. Start it with: coleo serve");
        process.exit(1);
      }

      const armRes = await fetch(`${apiUrl}/api/arms/${name}`, { headers });
      if (!armRes.ok) {
        console.error(`Arm not found: ${name}`);
        process.exit(1);
      }

      const armData = await armRes.json() as {
        arm: { status: string; harness: string; domain?: string; provider?: string; model?: string };
      };

      const statusRes = await fetch(`${apiUrl}/api/arms/${name}/status`, { headers });

      console.log(`Status for arm: ${name}`);
      console.log("=".repeat(50));
      console.log(`  Database status: ${armData.arm.status}`);
      console.log(`  Harness: ${armData.arm.harness || "unknown"}`);
      if (armData.arm.domain) console.log(`  Domain: ${armData.arm.domain}`);
      if (armData.arm.provider || armData.arm.model) {
        console.log(`  Model: ${armData.arm.provider ? armData.arm.provider + "/" : ""}${armData.arm.model || "default"}`);
      }

      if (statusRes.ok) {
        const data = await statusRes.json() as {
          sessionId?: string;
          status?: string;
          session?: {
            id?: string;
            status?: string;
            updatedAt?: string;
            title?: string;
          };
        };

        console.log("");
        console.log("OpenCode Session:");
        if (data.sessionId) console.log(`  Session ID: ${data.sessionId}`);
        if (data.status) console.log(`  Session status: ${data.status}`);
        if (data.session?.title) console.log(`  Title: ${data.session.title}`);
        if (data.session?.updatedAt) {
          console.log(`  Last updated: ${new Date(data.session.updatedAt).toLocaleString()}`);
        }
      } else {
        console.log("");
        console.log("OpenCode Session: Not available (arm may be stopped)");
      }
    });

  armCmd
    .command("remove <name>")
    .description("Remove a stopped arm from the database")
    .action(async (name) => {
      const { apiUrl, headers } = getApiConfig();

      if (!await isApiRunning()) {
        console.error("API server is not running. Start it with: coleo serve");
        process.exit(1);
      }

      const armRes = await fetch(`${apiUrl}/api/arms/${name}`, { headers });
      if (!armRes.ok) {
        console.error(`Arm not found: ${name}`);
        process.exit(1);
      }

      const armData = await armRes.json() as { arm: { status: string } };
      if (armData.arm.status !== "stopped") {
        console.error(`Cannot remove arm with status: ${armData.arm.status}`);
        console.error("Kill the arm first with: coleo arm kill " + name);
        process.exit(1);
      }

      const deleteRes = await fetch(`${apiUrl}/api/arms/${name}`, {
        method: "DELETE",
        headers,
      });

      if (deleteRes.ok) {
        console.log(`Arm ${name} removed from database.`);
      } else {
        const err = await deleteRes.json().catch(() => ({}));
        console.error(`Failed to remove arm: ${(err as { error?: string }).error || deleteRes.statusText}`);
        process.exit(1);
      }
    });

  armCmd
    .command("cleanup")
    .description("Remove all stopped arms from the database")
    .action(async () => {
      const { apiUrl, headers } = getApiConfig();

      if (!await isApiRunning()) {
        console.error("API server is not running. Start it with: coleo serve");
        process.exit(1);
      }

      const armsRes = await fetch(`${apiUrl}/api/arms`, { headers });
      if (!armsRes.ok) {
        console.error("Failed to fetch arms");
        process.exit(1);
      }

      const armsData = await armsRes.json() as { arms: Array<{ id: string; status: string }> };
      const stoppedArms = armsData.arms.filter((a) => a.status === "stopped");

      if (stoppedArms.length === 0) {
        console.log("No stopped arms to clean up.");
        return;
      }

      console.log(`Removing ${stoppedArms.length} stopped arm(s)...`);

      for (const arm of stoppedArms) {
        const deleteRes = await fetch(`${apiUrl}/api/arms/${arm.id}`, {
          method: "DELETE",
          headers,
        });

        if (deleteRes.ok) {
          console.log(`  Removed: ${arm.id}`);
        } else {
          console.log(`  Failed to remove: ${arm.id}`);
        }
      }

      console.log("Cleanup complete.");
    });

  armCmd
    .command("logs <name>")
    .description("Tail the log file for an arm (Ctrl+C to exit)")
    .option("-n, --lines <n>", "Number of initial lines to show", "100")
    .action(async (name, options) => {
      const coleoDir = getColeoDir();
      const logPath = join(coleoDir, "logs", `${name}.log`);

      const { existsSync } = await import("fs");

      if (!existsSync(logPath)) {
        console.error(`Log file not found: ${logPath}`);
        console.error("Arm may not have been spawned yet, or logs are stored elsewhere.");
        process.exit(1);
      }

      console.log(`Tailing logs for arm: ${name}`);
      console.log(`Log file: ${logPath}`);
      console.log("=".repeat(60));
      console.log("(Ctrl+C to exit)");
      console.log("=".repeat(60));

      const { spawn } = await import("child_process");
      const tail = spawn("tail", ["-n", options.lines, "-f", logPath], {
        stdio: "inherit",
        cwd: process.cwd(),
      });

      tail.on("error", (err) => {
        console.error(`Failed to tail log: ${err}`);
        process.exit(1);
      });

      process.on("SIGINT", () => {
        tail.kill("SIGINT");
        process.exit(0);
      });

      process.on("SIGTERM", () => {
        tail.kill("SIGTERM");
        process.exit(0);
      });
    });
}
