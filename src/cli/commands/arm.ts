import { Command } from "commander";
import { join } from "path";
import { clearLine, cursorTo, moveCursor } from "node:readline";
import { spawnArm, listArms, killArm } from "../../arm";
import type { Arm } from "../../types";
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

type ArmAnalysisSummary = {
  state: string;
};

type ArmDisplayState = "Idle" | "Busy" | "Stuck";
const TERMINAL_WIDTH_SAFETY = 2;

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function displayWidth(value: string): number {
  return Array.from(value).length;
}

function truncateToWidth(value: string, max: number): string {
  if (max <= 0) return "";
  const chars = Array.from(value);
  if (chars.length <= max) return value;
  if (max <= 1) return chars.slice(0, max).join("");
  return `${chars.slice(0, max - 1).join("")}…`;
}

function padToWidth(value: string, width: number): string {
  if (width <= 0) return "";
  const len = displayWidth(value);
  if (len >= width) return truncateToWidth(value, width);
  return value + " ".repeat(width - len);
}

function fitToWidth(value: string, columns: number): string {
  const safeColumns = Math.max(0, columns - TERMINAL_WIDTH_SAFETY);
  if (safeColumns <= 0) return "";
  const plain = stripAnsi(value);
  if (displayWidth(plain) <= safeColumns) return value;
  return truncateToWidth(plain, safeColumns);
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs)) return "n/a";
  const safeMs = Math.max(0, durationMs);
  const totalSeconds = Math.floor(safeMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return `${hours}h ${minutes}m`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${days}d ${remainingHours}h`;
}

function classifyArmDisplayState(armStatus: string, monitorState?: string): ArmDisplayState {
  const status = armStatus.toLowerCase();
  const hm = (monitorState || "").toLowerCase();

  if (status === "error" || hm === "looping" || hm === "silent" || hm === "error") {
    return "Stuck";
  }

  if (
    status === "busy" ||
    status === "running" ||
    status === "starting" ||
    hm === "productive" ||
    hm === "waiting_permission" ||
    hm === "starting"
  ) {
    return "Busy";
  }

  return "Idle";
}

function formatStatusIndicator(state: ArmDisplayState, color: boolean): string {
  const text = `● ${state}`;
  if (!color) return text;

  if (state === "Idle") return `\u001b[32m${text}\u001b[0m`;
  if (state === "Busy") return `\u001b[33m${text}\u001b[0m`;
  return `\u001b[31m${text}\u001b[0m`;
}

type RowInput = {
  name: string;
  lifetime: string;
  health: string;
  task: string;
  statusIndicator: string;
};

function buildAlignedArmLines(rows: RowInput[], columns: number): string[] {
  const safeColumns = Math.max(20, columns - TERMINAL_WIDTH_SAFETY);
  const statusWidth = Math.max(...rows.map((row) => displayWidth(stripAnsi(row.statusIndicator))), 0);

  let nameWidth = Math.min(
    28,
    Math.max(10, ...rows.map((row) => displayWidth(row.name)))
  );
  let lifetimeWidth = Math.min(
    10,
    Math.max(4, ...rows.map((row) => displayWidth(row.lifetime)))
  );
  let healthWidth = Math.min(
    20,
    Math.max(8, ...rows.map((row) => displayWidth(row.health)))
  );

  const minTaskWidth = 10;
  let taskWidth = safeColumns - (nameWidth + lifetimeWidth + healthWidth + statusWidth + 4);

  while (taskWidth < minTaskWidth && nameWidth > 10) {
    nameWidth--;
    taskWidth = safeColumns - (nameWidth + lifetimeWidth + healthWidth + statusWidth + 4);
  }
  while (taskWidth < minTaskWidth && healthWidth > 8) {
    healthWidth--;
    taskWidth = safeColumns - (nameWidth + lifetimeWidth + healthWidth + statusWidth + 4);
  }
  while (taskWidth < minTaskWidth && lifetimeWidth > 4) {
    lifetimeWidth--;
    taskWidth = safeColumns - (nameWidth + lifetimeWidth + healthWidth + statusWidth + 4);
  }

  taskWidth = Math.max(0, taskWidth);

  return rows.map((row) => {
    const nameCell = padToWidth(truncateToWidth(row.name, nameWidth), nameWidth);
    const lifetimeCell = padToWidth(truncateToWidth(row.lifetime, lifetimeWidth), lifetimeWidth);
    const healthCell = padToWidth(truncateToWidth(row.health, healthWidth), healthWidth);
    const taskCell = padToWidth(truncateToWidth(row.task, taskWidth), taskWidth);
    return `${nameCell} ${lifetimeCell} ${healthCell} ${taskCell} ${row.statusIndicator}`;
  });
}

function renderLines(lines: string[], previousLineCount: number): number {
  if (!process.stdout.isTTY) {
    for (const line of lines) {
      console.log(stripAnsi(line));
    }
    return lines.length;
  }

  if (previousLineCount > 0) {
    moveCursor(process.stdout, 0, -previousLineCount);
  }

  const totalLines = Math.max(lines.length, previousLineCount);
  for (let i = 0; i < totalLines; i++) {
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
    process.stdout.write(fitToWidth(lines[i] ?? "", process.stdout.columns ?? 120));
    process.stdout.write("\n");
  }

  return lines.length;
}

async function fetchHealthAnalysis(apiUrl: string, headers: Record<string, string>): Promise<Map<string, ArmAnalysisSummary>> {
  const healthByArm = new Map<string, ArmAnalysisSummary>();

  try {
    const res = await fetch(`${apiUrl}/api/events/analysis`, { headers });
    if (!res.ok) return healthByArm;

    const payload = await res.json() as {
      arms?: Array<{
        armId: string;
        state: string;
      }>;
    };

    for (const entry of payload.arms || []) {
      healthByArm.set(entry.armId, {
        state: entry.state,
      });
    }
  } catch {
    return healthByArm;
  }

  return healthByArm;
}

async function fetchArmTasks(apiUrl: string, headers: Record<string, string>): Promise<Map<string, string>> {
  const tasksByArm = new Map<string, string>();

  try {
    const res = await fetch(`${apiUrl}/api/arms`, { headers });
    if (!res.ok) return tasksByArm;

    const payload = await res.json() as {
      arms?: Array<{
        id: string;
        currentTaskSubject?: string | null;
        currentTask?: string | null;
      }>;
    };

    for (const entry of payload.arms || []) {
      const task = entry.currentTaskSubject || entry.currentTask || "";
      if (task) {
        tasksByArm.set(entry.id, task);
      }
    }
  } catch {
    return tasksByArm;
  }

  return tasksByArm;
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

        const result = JSON.parse(rawResponse) as { 
          spawned: boolean;
          distributed?: boolean;
          sessionId?: string;
          pid?: number;
          port?: number;
          provider?: string;
          model?: string;
        };
        console.log(`Arm spawned with opencode-tui harness in ${options.terminal}:`);
        console.log(`  ID: ${armName}`);
        const resolvedProvider = result.provider || armProvider;
        const resolvedModel = result.model || armModel;
        if (resolvedProvider || resolvedModel) {
          console.log(
            `  Model: ${resolvedProvider ? resolvedProvider + "/" : ""}${resolvedModel || "default"}`,
          );
        }
        console.log(`  Status: ${result.spawned ? "idle" : "unknown"}`);
        console.log(`  PID: ${result.pid || "unknown"}`);
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
        provider?: string;
        model?: string;
      };

      console.log(`Arm spawned via API: ${armName}`);
      console.log(`  Full response:`, JSON.stringify(result, null, 2));
      const resolvedProvider = result.provider || armProvider;
      const resolvedModel = result.model || armModel;
      if (resolvedProvider || resolvedModel) {
        console.log(`  Model: ${resolvedProvider ? resolvedProvider + "/" : ""}${resolvedModel || "default"}`);
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
    .option("--once", "Print one snapshot and exit (disable live updates)")
    .option("-i, --interval <ms>", "Refresh interval for live mode", "2000")
    .action(async (options: { all?: boolean; once?: boolean; interval?: string }) => {
      const coleoDir = getColeoDir();
      const { apiUrl, headers } = getApiConfig();
      const refreshInterval = Math.max(250, parseInt(options.interval || "2000", 10) || 2000);
      const liveMode = process.stdout.isTTY && !options.once;
      const useColor = Boolean(process.stdout.isTTY);

      const renderSnapshot = async (): Promise<string[]> => {
        let arms = await listArms(coleoDir);
        if (!options.all) {
          arms = arms.filter((a) => a.status !== "stopped");
        }

        if (arms.length === 0) {
          return [options.all ? "No arms registered." : "No active arms."];
        }

        const [healthByArm, tasksByArm] = await Promise.all([
          fetchHealthAnalysis(apiUrl, headers),
          fetchArmTasks(apiUrl, headers),
        ]);

        const rows: RowInput[] = arms.map((arm) => {
          const analysis = healthByArm.get(arm.id);
          const displayState = classifyArmDisplayState(arm.status, analysis?.state);
          const statusIndicator = formatStatusIndicator(displayState, useColor);
          const healthLabel = (analysis?.state || "unknown").toLowerCase();
          const taskText = tasksByArm.get(arm.id) || arm.currentTask || "-";
          return {
            name: `🐙 ${arm.name || arm.id}`,
            lifetime: formatDuration(Date.now() - arm.startedAt.getTime()),
            health: `📈 ${healthLabel}`,
            task: `☑️ ${taskText}`,
            statusIndicator,
          };
        });

        return buildAlignedArmLines(rows, process.stdout.columns ?? 120);
      };

      let lastRenderedLines = 0;
      let keepRunning = true;
      const stopLiveMode = () => {
        keepRunning = false;
      };

      if (liveMode) {
        process.once("SIGINT", stopLiveMode);
        process.once("SIGTERM", stopLiveMode);
      }

      try {
        do {
          const lines = await renderSnapshot();
          if (liveMode) {
            lastRenderedLines = renderLines(lines, lastRenderedLines);
          } else {
            for (const line of lines) {
              console.log(process.stdout.isTTY ? line : stripAnsi(line));
            }
          }

          if (!liveMode) break;
          if (!keepRunning) break;
          await new Promise((resolve) => setTimeout(resolve, refreshInterval));
        } while (keepRunning);
      } finally {
        if (liveMode) {
          process.stdout.write("\n");
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
      const apiKey = headers["X-API-Key"] || "";

      if (!await isApiRunning()) {
        console.error("API server is not running. Start it with: coleo serve");
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
    const apiKey = headers["X-API-Key"] || "";
    const showTools = options?.tools !== false;
    const showSystem = options?.system !== false;
    const historyCount = parseInt(options?.history || "2", 10);
    const verbose = options?.verbose === true;

    if (!(await isApiRunning())) {
      console.error("API server is not running. Start it with: coleo serve");
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

    let activeSessionId: string | undefined;

    if (historyCount > 0) {
      try {
        const sessionsRes = await fetch(`${opencodeBaseUrl}/session`);
        if (sessionsRes.ok) {
          const sessions = (await sessionsRes.json()) as Array<{ id: string; title: string }>;
          if (sessions.length > 0) {
            const currentSession = sessions[sessions.length - 1];
            if (currentSession) {
              activeSessionId = currentSession.id;
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
                for (const msg of recentMessages) {
                  const role = msg.info.role;
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
    const messageRoles = new Map<string, string>();
    const renderedTextByPartId = new Map<string, string>();
    const renderedAssistantMessageIds = new Set<string>();

    const normalizeRole = (value: unknown): string | undefined => {
      if (typeof value !== "string" || value.length === 0) return undefined;
      if (value === "assistant" || value === "user" || value === "system") return value;
      return value;
    };

    const printRoleHeader = (role: string): void => {
      if (role === currentRole) return;
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
    };

    const clearProcessingIndicator = (role: string): void => {
      if (isProcessing && role === "assistant") {
        isProcessing = false;
        process.stdout.write("\r" + " ".repeat(20) + "\r");
      }
    };

    const renderCompletedAssistantMessages = async (): Promise<void> => {
      if (!activeSessionId) return;
      try {
        const msgsRes = await fetch(`${opencodeBaseUrl}/session/${activeSessionId}/message?limit=${Math.max(10, historyCount * 2)}`);
        if (!msgsRes.ok) return;
        const messages = (await msgsRes.json()) as Array<{
          info?: { id?: string; role?: string };
          parts?: Array<{ type?: string; text?: string }>;
        }>;

        for (const msg of messages) {
          const role = normalizeRole(msg.info?.role);
          if (role !== "assistant") continue;
          const messageId = msg.info?.id;
          if (messageId && renderedAssistantMessageIds.has(messageId)) continue;

          const textParts = (msg.parts || [])
            .filter((part) => part.type === "text" && typeof part.text === "string" && part.text.length > 0)
            .map((part) => part.text as string);

          if (textParts.length === 0) continue;
          printRoleHeader("assistant");
          clearProcessingIndicator("assistant");

          for (const text of textParts) {
            process.stdout.write(text);
            lastWasNewline = text.endsWith("\n");
          }

          if (messageId) {
            renderedAssistantMessageIds.add(messageId);
          }
        }
      } catch {
        // Best-effort fallback only
      }
    };

    const processEvent = async (eventStr: string) => {
      const lines = eventStr.split("\n");
      const dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      if (dataLines.length === 0) return;
      const data = dataLines.join("\n");
      if (!data.trim()) return;

      try {
        const event = JSON.parse(data) as { type: string; properties: Record<string, unknown> };
        const { type, properties: props } = event;

        const sessionIdCandidate = props.sessionID ?? props.sessionId;
        if (typeof sessionIdCandidate === "string" && sessionIdCandidate.length > 0) {
          activeSessionId = sessionIdCandidate;
        }

        if (type === "message.created" || type === "message.updated") {
          const info = props.info as Record<string, unknown> | undefined;
          const role = normalizeRole(info?.role);
          const messageId = typeof info?.id === "string" ? info.id : undefined;
          if (messageId && role) {
            messageRoles.set(messageId, role);
          }
          const infoSessionId = info?.sessionID ?? info?.sessionId;
          if (typeof infoSessionId === "string" && infoSessionId.length > 0) {
            activeSessionId = infoSessionId;
          }

          if (role) {
            printRoleHeader(role);

            // Show processing indicator after user message
            if (role === "user") {
              isProcessing = true;
              process.stdout.write("⏳ Thinking...");
            } else if (role === "assistant") {
              clearProcessingIndicator(role);
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
          const delta = typeof props.delta === "string" ? props.delta : undefined;

          if (part) {
            const partType = part.type as string;
            const partId = typeof part.id === "string" ? part.id : undefined;
            const messageId = (typeof part.messageID === "string" ? part.messageID : undefined)
              || (typeof part.messageId === "string" ? part.messageId : undefined)
              || (typeof props.messageID === "string" ? props.messageID : undefined)
              || (typeof props.messageId === "string" ? props.messageId : undefined);
            const role = normalizeRole(part.role)
              || normalizeRole(props.role)
              || (messageId ? messageRoles.get(messageId) : undefined)
              || (isProcessing ? "assistant" : undefined);

            if (partType === "text") {
              // Use delta for streaming updates, fall back to full text when available
              const textContent = typeof part.text === "string" ? part.text : undefined;
              let textToWrite = delta;

              if (!textToWrite && textContent) {
                if (partId) {
                  const previous = renderedTextByPartId.get(partId) || "";
                  textToWrite = textContent.startsWith(previous)
                    ? textContent.slice(previous.length)
                    : textContent;
                  renderedTextByPartId.set(partId, textContent);
                } else {
                  textToWrite = textContent;
                }
              }

              if (textToWrite && textToWrite.length > 0) {
                // Clear processing indicator on first assistant text
                if (role) {
                  printRoleHeader(role);
                }
                clearProcessingIndicator(role || currentRole);
                process.stdout.write(textToWrite);
                lastWasNewline = textToWrite.endsWith("\n");
                if ((role || currentRole) === "assistant" && messageId) {
                  renderedAssistantMessageIds.add(messageId);
                }
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
          if (!activeSessionId) {
            const statusSessionId = status?.sessionID ?? status?.sessionId ?? props.sessionID ?? props.sessionId;
            if (typeof statusSessionId === "string" && statusSessionId.length > 0) {
              activeSessionId = statusSessionId;
            }
          }
          if (statusType === "idle") {
            if (isProcessing) {
              isProcessing = false;
              process.stdout.write("\r" + " ".repeat(20) + "\r");
            }
            await renderCompletedAssistantMessages();
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
            await processEvent(eventStr);
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
