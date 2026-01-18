#!/usr/bin/env bun
/**
 * Octopai CLI
 * 
 * AI agent orchestrator using the Octopus Model
 */

import { file } from "bun";
import { Command } from "commander";
import { join, dirname } from "path";
import { mkdir, writeFile, readFile, copyFile, readdir, symlink, unlink } from "fs/promises";
import { homedir } from "os";
import { Brain } from "../brain";
import { initMaildir, Maildir } from "../mail";
import { runMcpServer } from "../mcp";
import { spawnArm, listArms, killArm } from "../arm";
import { startServer, disableHeartbeat } from "../api";
import type { OctopaiConfig } from "../types";
import { DEFAULT_CONFIG } from "../types";
import { generateArmName } from "./arm-names";

// Load .env file if it exists (check cwd/.octopai and cwd)
async function loadEnvFile(): Promise<void> {
  const envPaths = [
    join(process.cwd(), ".octopai", ".env"),
    join(process.cwd(), ".env"),
  ];
  
  for (const envPath of envPaths) {
    try {
      const envFile = file(envPath);
      if (await envFile.exists()) {
        const content = await envFile.text();
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIndex = trimmed.indexOf("=");
          if (eqIndex === -1) continue;
          const key = trimmed.slice(0, eqIndex).trim();
          let value = trimmed.slice(eqIndex + 1).trim();
          // Remove quotes if present
          if ((value.startsWith('"') && value.endsWith('"')) || 
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          // Only set if not already set in environment
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
        break; // Stop after first .env file found
      }
    } catch {
      // Ignore errors reading .env
    }
  }
}

// Load env before anything else
await loadEnvFile();

// Disable WebSocket heartbeat for CLI commands (prevents process from hanging)
disableHeartbeat();
disableHeartbeat();

const TEMPLATES_DIR = join(dirname(import.meta.filename), "..", "..", "templates");

const program = new Command();

// Resolve octopai directory (project-local by default)
function getOctopaiDir(): string {
  return process.env.OCTOPAI_DIR || join(process.cwd(), ".octopai");
}

// Expand ~ in paths
function expandPath(path: string): string {
  if (path.startsWith("~")) {
    return join(homedir(), path.slice(1));
  }
  return path;
}

// Get API URL and headers
function getApiConfig() {
  const apiPort = process.env.OCTOPAI_API_PORT || "8080";
  const apiHost = process.env.OCTOPAI_API_HOST || "localhost";
  const apiKey = process.env.OCTOPAI_API_KEY;
  const apiUrl = `http://${apiHost}:${apiPort}`;
  
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
  }
  
  return { apiUrl, headers };
}

// Check if API server is running
async function isApiRunning(): Promise<boolean> {
  const { apiUrl } = getApiConfig();
  try {
    const res = await fetch(`${apiUrl}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

program
  .name("octopai")
  .description("AI agent orchestrator using the Octopus Model")
  .version("0.1.0");

// ============================================
// INIT COMMAND
// ============================================

program
  .command("init")
  .description("Initialize Octopai in the current project (.octopai/)")
  .option("-d, --dir <path>", "Custom directory", ".octopai")
  .option("--preset <name>", "Preset configuration (fullstack, split-stack, full-team)", "")
  .action(async (options) => {
    const octopaiDir = options.dir.startsWith("/") ? options.dir : join(process.cwd(), options.dir);
    const preset = options.preset;
    console.log(`Initializing Octopai in ${octopaiDir}...`);

    // Create directory structure
    const dirs = [
      "mail/inbox",
      "mail/sent",
      "mail/drafts",
      "mail/archive",
      "queue/brain/pending",
      "queue/brain/processed",
      "state",
      "state/arms",
      "state/notes/shared",
      "mcp",
      "logs",
      "arms",
    ];

    for (const dir of dirs) {
      await mkdir(join(octopaiDir, dir), { recursive: true });
    }

    // Initialize maildirs
    await initMaildir(join(octopaiDir, "mail"));

    // Create default config
    const config: OctopaiConfig = {
      ...DEFAULT_CONFIG,
      octopaiDir,
    };

    await writeFile(
      join(octopaiDir, "config.toml"),
      generateConfigToml(config),
      "utf-8"
    );

    // Copy arm templates
    await copyArmTemplates(octopaiDir, preset);

    // Create octopai symlink in /usr/local/bin for easy access
    const octopaiScriptPath = join(octopaiDir, "bin", "octopai");
    await mkdir(join(octopaiDir, "bin"), { recursive: true });
    await writeFile(
      octopaiScriptPath,
      `#!/bin/bash
# Octopai CLI wrapper - runs from source directory
cd "${process.cwd()}"
exec bun run src/cli/index.ts "$@"
`,
      "utf-8"
    );

    // Make script executable (using spawn with chmod since fs.chmod might not be available)
    const { spawn } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => {
      spawn("chmod", ["+x", octopaiScriptPath]).on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`chmod failed with code ${code}`));
      });
    });

    // Try to create symlink in /usr/local/bin (may fail if not writable)
    let symlinkPath = "";
    try {
      symlinkPath = "/usr/local/bin/octopai";
      await symlink(octopaiScriptPath, symlinkPath);
    } catch {
      // Not writable, try ~/bin
      try {
        const userBin = join(homedir(), "bin");
        await mkdir(userBin, { recursive: true });
        symlinkPath = join(userBin, "octopai");
        await symlink(octopaiScriptPath, symlinkPath);
      } catch {
        symlinkPath = ""; // Could not create symlink
      }
    }

    const symlinkInfo = symlinkPath ? `\n  ✓ Symlink created: ${symlinkPath}` : "";
    const scriptInfo = `\n  ✓ CLI wrapper: ${octopaiScriptPath}`;

    console.log(`
 Octopai initialized!

 Directory structure created:
   ${octopaiDir}/
   ├── mail/          # Human-agent communication (Maildir)
   ├── queue/         # Inter-agent message queue
   ├── state/         # Persistent state
   ├── arms/          # Arm configurations
   ├── mcp/           # MCP configurations
   └── logs/          # Log files

${preset ? `Preset "${preset}" arms have been configured in .octopai/arms/` : ""}
${scriptInfo}${symlinkInfo}
 Edit or delete arm configs in .octopai/arms/ before spawning.

  Next steps:
    1. In your project repo, create a shared branch for arms to work on (for example: git checkout -b octopai)
    2. Start the API server: octopai serve
    3. Configure arms: edit .octopai/arms/*.toml
    4. Spawn an arm pointed at your project worktree: octopai arm spawn --workdir /path/to/your/project
  `);
  });

// ============================================
// SERVE COMMAND (API Server)
// ============================================

program
  .command("serve")
  .description("Start the API server (required for harness-based arms)")
  .option("-p, --port <port>", "Port to listen on", "8080")
  .option("-h, --host <host>", "Host to bind to", "0.0.0.0")
  .action(async (options) => {
    await startServer({
      port: parseInt(options.port, 10),
      host: options.host,
    });
  });

// ============================================
// BRAIN COMMANDS
// ============================================

const brainCmd = program.command("brain").description("Manage the Octopai brain");

brainCmd
  .command("run")
  .description("Run brain polling loop (foreground)")
  .option("-i, --interval <ms>", "Poll interval in milliseconds", "30000")
  .option("-v, --verbose", "Verbose output", false)
  .option("--once", "Run a single poll cycle and exit")
  .option("--clean", "Kill zombie/stale OpenCode processes before starting")
  .action(async (options) => {
    const octopaiDir = getOctopaiDir();
    const interval = parseInt(options.interval, 10);
    const verbose = options.verbose ?? false;

    // Handle clean mode - kill zombie processes first
    if (options.clean) {
      console.log("Cleaning up zombie OpenCode processes...");
      const { execSync } = await import("node:child_process");
      try {
        // First find the PIDs
        const pidsOutput = execSync(
          "ps aux | grep 'opencode.*serve' | grep -v grep | awk '{print $2}'",
          { encoding: "utf-8", cwd: process.cwd() }
        ).trim();
        const pids = pidsOutput.split("\n").filter((p: string) => p.length > 0);
        
        if (pids.length > 0) {
          // Kill each PID
          execSync(`kill -9 ${pids.join(" ")} 2>/dev/null || true`, { cwd: process.cwd() });
          console.log(`Killed ${pids.length} stale process(es): ${pids.join(", ")}`);
        } else {
          console.log("No zombie processes found.");
        }
      } catch (err) {
        // If ps finds nothing, that's fine
        console.log("No zombie processes found.");
      }
    }

    const brain = new Brain({
      octopaiDir,
      pollIntervalMs: interval,
      verbose: verbose || true,
    });

    await brain.init();

    process.on("SIGINT", () => {
      console.log("\nShutting down brain...");
      brain.stop();
    });

    process.on("SIGTERM", () => {
      brain.stop();
    });

    if (options.once) {
      await brain.runOnce();
      await brain.shutdown();
    } else {
      await brain.run();
      await brain.shutdown();
    }
  });

brainCmd
  .command("status")
  .description("Show brain status")
  .action(async () => {
    const octopaiDir = getOctopaiDir();
    const dbPath = join(octopaiDir, "octopai.db");

    try {
      // Read from brain.json for basic status
      const content = await readFile(join(octopaiDir, "state", "brain.json"), "utf-8");
      const state = JSON.parse(content);

      // Get actual arm count from database
      let activeArmsCount = 0;
      let pendingTasksCount = 0;
      try {
        const { Database } = await import("bun:sqlite");
        const db = new Database(dbPath, { readonly: true });
        const armsResult = db.query("SELECT COUNT(*) as count FROM arms WHERE status NOT IN ('stopped')").get();
        activeArmsCount = (armsResult as { count: number })?.count || 0;
        
        // Count pending tasks
        const tasksResult = db.query("SELECT COUNT(*) as count FROM tasks WHERE status = 'pending'").get();
        pendingTasksCount = (tasksResult as { count: number })?.count || 0;
        db.close();
      } catch {
        // Database might not exist yet
      }

      console.log("Brain Status:");
      console.log(`  Status: ${state.status || "unknown"}`);
      console.log(`  Last poll: ${state.lastPollAt || "never"}`);
      console.log(`  Poll interval: ${state.pollIntervalMs || 30000}ms`);
      console.log(`  Active arms: ${activeArmsCount}`);
      console.log(`  Pending tasks: ${pendingTasksCount}`);
      console.log(`  Completed today: ${state.completedToday || 0}`);
    } catch {
      console.log("Brain has not been started yet.");
      console.log("Run: octopai brain run");
    }
  });

brainCmd
  .command("prompt:task")
  .description("Show what task the brain would determine next (for copying to agent)")
  .action(async () => {
    const octopaiDir = getOctopaiDir();
    const dbPath = join(octopaiDir, "octopai.db");
    const { Database } = await import("bun:sqlite");

    try {
      const db = new Database(dbPath);
      const { generateTaskDetermination, formatTaskDetermination } = await import("../brain/prompt-generator");
      
      const result = await generateTaskDetermination({
        projectRoot: process.cwd(),
        octopaiDir,
        db,
      });
      
      console.log(formatTaskDetermination(result));
      db.close();
    } catch (err) {
      console.error("Error determining task:", err);
      process.exit(1);
    }
  });

brainCmd
  .command("prompt:context")
  .description("Show context bundle for a task (for copying to agent)")
  .argument("[task-id-or-subject]", "Task ID or subject to generate context for")
  .action(async (taskIdOrSubject) => {
    const octopaiDir = getOctopaiDir();
    const dbPath = join(octopaiDir, "octopai.db");
    const { Database } = await import("bun:sqlite");

    try {
      const db = new Database(dbPath);
      const { generateContextBundle, formatContextBundle } = await import("../brain/prompt-generator");
      
      const taskInput = taskIdOrSubject || "next";
      
      // If "next", find the highest priority pending task
      let taskSubject = taskInput;
      if (taskInput === "next") {
        const pendingTask = db.query(`
          SELECT subject FROM tasks
          WHERE status = 'pending'
          ORDER BY 
            CASE priority 
              WHEN 'critical' THEN 1 
              WHEN 'high' THEN 2 
              WHEN 'normal' THEN 3 
              WHEN 'low' THEN 4 
            END,
            created_at ASC
          LIMIT 1
        `).get() as { subject: string } | undefined;
        
        if (pendingTask) {
          taskSubject = pendingTask.subject;
        } else {
          console.log("No pending tasks found. Please specify a task ID or subject.");
          db.close();
          process.exit(1);
        }
      }
      
      const result = await generateContextBundle({
        projectRoot: process.cwd(),
        octopaiDir,
        db,
      }, taskSubject);
      
      if (result) {
        console.log(formatContextBundle(result));
      } else {
        console.log(`Task not found: ${taskSubject}`);
        console.log("\nAvailable tasks:");
        const tasks = db.query(`
          SELECT id, subject, status, priority FROM tasks
          WHERE status IN ('pending', 'in_progress')
          ORDER BY 
            CASE priority 
              WHEN 'critical' THEN 1 
              WHEN 'high' THEN 2 
              WHEN 'normal' THEN 3 
              WHEN 'low' THEN 4 
            END
          LIMIT 10
        `).all() as Array<{ id: string; subject: string; status: string; priority: string }>;
        
        for (const task of tasks) {
          console.log(`  - ${task.id}: ${task.subject} [${task.priority}]`);
        }
      }
      
      db.close();
    } catch (err) {
      console.error("Error generating context:", err);
      process.exit(1);
    }
  });

// ============================================
// ARM COMMANDS
// ============================================

const armCmd = program.command("arm").description("Manage arms (agents)");

// Simple interactive prompt helper
async function prompt(text: string): Promise<string> {
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(text, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function promptSelect(text: string, options: string[]): Promise<string> {
  if (options.length === 0) {
    return "";
  }
  console.log(text);
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${i + 1}. ${options[i]}`);
  }
  const answer = await prompt("Select: ");
  const idx = parseInt(answer, 10) - 1;
  if (idx >= 0 && idx < options.length) {
    const result = options[idx];
    return result !== undefined ? result : "";
  }
  const fallback = options[0];
  return fallback !== undefined ? fallback : "";
}

async function promptYN(text: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  const answer = await prompt(text + suffix);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

// Load arm templates from ~/.octopai/arms/
async function loadArmTemplates(): Promise<Array<{ name: string; file: string; domain: string; description: string }>> {
  const octopaiDir = getOctopaiDir();
  const armsDir = join(octopaiDir, "arms");
  const templates: Array<{ name: string; file: string; domain: string; description: string }> = [];

  try {
    const files = await readdir(armsDir);
    for (const file of files) {
      if (!file.endsWith(".toml")) continue;
      const filePath = join(armsDir, file);
      try {
        const content = await readFile(filePath, "utf-8");
        const nameMatch = content.match(/name\s*=\s*"([^"]*)"/);
        const domainMatch = content.match(/domain\s*=\s*"([^"]*)"/);
        const traitsMatch = content.match(/traits\s*=\s*"([^"]*)"/);
        const name = nameMatch?.[1] || file.replace(".toml", "");
        const domain = domainMatch?.[1] || "general";
        const description = traitsMatch?.[1] || `${domain} specialist`;
        templates.push({ name, file, domain, description });
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // No templates directory
  }

  return templates;
}

armCmd
  .command("spawn")
  .description("Spawn a new arm (interactive if no arguments provided)")
  .option("-n, --name <name>", "Arm name/ID (auto-generates a sci-fi name if not provided)")
  .option("-w, --workdir <path>", "Working directory", process.cwd())
  .option("-t, --terminal <terminal>", "Terminal emulator (ghostty, iterm2, terminal, tmux). If not specified, uses API server.")
  .option("-p, --prompt <prompt>", "Initial prompt/task for the agent")
  .option("--provider <provider>", "AI provider (e.g., anthropic, openai, opencode-zen)")
  .option("--model <model>", "Model name (e.g., claude-sonnet-4-20250514)")
  .option("--template <name>", "Use a template from ~/.octopai/arms/")
  .action(async (options) => {
    const octopaiDir = getOctopaiDir();
    let armName = options.name || "";
    const armAgent = "opencode";
    const armDomain = "general";
    let armWorkdir = options.workdir || process.cwd();
    let armProvider = options.provider;
    let armModel = options.model;

    // Interactive mode if no name provided
    if (!armName) {
      console.log("\n=== Arm Configuration ===\n");

      // Generate a suggested name (sci-fi alien style)
      const suggestedName = generateArmName();

      // Load templates
      const templates = await loadArmTemplates();

      // Select template or custom
      let useTemplate = false;

      if (templates.length > 0) {
        useTemplate = await promptYN("Would you like to use an arm template?", true);
        if (useTemplate) {
          const templateNames = templates.map((t) => `${t.name} - ${t.description}`);
          templateNames.push("Custom arm (no template)");
          const selected = await promptSelect("Select a template:", templateNames);
          const selectedIdx = templateNames.indexOf(selected);
          if (selectedIdx >= 0 && selectedIdx < templates.length) {
            const selectedTemplate = templates[selectedIdx];
            if (selectedTemplate) {
              armName = selectedTemplate.name;
            }
          } else {
            const customName = await prompt(`Arm name [${suggestedName}]: `);
            armName = customName.trim() || suggestedName;
          }
        } else {
          const customName = await prompt(`Arm name [${suggestedName}]: `);
          armName = customName.trim() || suggestedName;
        }
      } else {
        const customName = await prompt(`Arm name [${suggestedName}]: `);
        armName = customName.trim() || suggestedName;
      }

      if (!armName.trim()) {
        // Fallback - should not happen since we have a suggested name
        armName = suggestedName;
      }

      // Working directory
      const workdir = await prompt(`Working directory [${process.cwd()}]: `);
      if (workdir.trim()) {
        armWorkdir = workdir;
      }

      // Provider and model
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
      console.log(`  Workdir: ${armWorkdir}`);
      if (armProvider) {
        console.log(`  Provider: ${armProvider}`);
        if (armModel) console.log(`  Model: ${armModel}`);
      }
      console.log("");
    }

    // If terminal is specified, use the direct spawner (opens a terminal window)
    if (options.terminal) {
      const arm = await spawnArm({
        octopaiDir,
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

      console.log(`Arm spawned in terminal: ${arm.id}`);
      if (arm.provider || arm.model) {
        console.log(`  Model: ${arm.provider ? arm.provider + "/" : ""}${arm.model || "default"}`);
      }
      console.log(`  Status: ${arm.status}`);
      console.log(`  PID: ${arm.pid || "unknown"}`);
      return;
    }

    // Otherwise, try to use the API server for harness-based spawning
    const { apiUrl, headers } = getApiConfig();

    // Check if API server is running
    if (!await isApiRunning()) {
      console.error("API server is not running.");
      console.error(`Expected at: ${apiUrl}`);
      console.error("");
      console.error("Options:");
      console.error("  1. Start the API server: octopai serve");
      console.error("  2. Use terminal mode: octopai arm spawn --name <name> --terminal ghostty");
      process.exit(1);
    }

    // Check if arm already exists
    const existsRes = await fetch(`${apiUrl}/api/arms/${armName}`, { headers });
    const armExists = existsRes.ok;

    if (armExists) {
      // Check if it's stopped - if so, we can restart it
      const existingArm = await existsRes.json() as { arm: { status: string } };
      if (existingArm.arm.status !== "stopped") {
        console.error(`Arm ${armName} already exists with status: ${existingArm.arm.status}`);
        console.error("Use 'octopai arm kill <name>' first, or choose a different name.");
        process.exit(1);
      }
      console.log(`Restarting stopped arm: ${armName}`);
    } else {
      // Always use opencode-api harness
      const harnessType = "opencode-api";

      // Create new arm
      const createRes = await fetch(`${apiUrl}/api/arms`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: armName,
          domain: armDomain,
          harness: harnessType,
          status: "starting",
          provider: armProvider,
          model: armModel,
        }),
      });

      if (!createRes.ok) {
        const err = await createRes.json().catch(() => ({}));
        console.error(`Failed to create arm: ${(err as { error?: string }).error || createRes.statusText}`);
        process.exit(1);
      }
    }

    // Spawn via harness
    const spawnRes = await fetch(`${apiUrl}/api/arms/${armName}/spawn`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workdir: expandPath(armWorkdir),
        provider: armProvider,
        model: armModel,
        initialPrompt: options.prompt,
      }),
    });
    
    if (!spawnRes.ok) {
      const err = await spawnRes.json().catch(() => ({}));
      console.error(`Failed to spawn arm: ${(err as { error?: string }).error || spawnRes.statusText}`);
      process.exit(1);
    }
    
    const result = await spawnRes.json() as { sessionId?: string; pid?: number };
    
    console.log(`Arm spawned via API: ${armName}`);
    if (armProvider || armModel) {
      console.log(`  Model: ${armProvider ? armProvider + "/" : ""}${armModel || "default"}`);
    }
    console.log(`  Session: ${result.sessionId}`);
    console.log(`  PID: ${result.pid || "unknown"}`);
    console.log("");
    console.log("The arm is running in the API server process.");
    console.log(`Watch events: octopai arm tail ${armName}`);
    console.log(`View status:  octopai arm status ${armName}`);
    console.log(`View todos:   octopai arm todos ${armName}`);
  });

armCmd
  .command("names")
  .description("Generate sample sci-fi arm names (inspired by Children of Time/Ruin)")
  .option("-c, --count <number>", "Number of names to generate", "10")
  .option("--stats", "Show name generator statistics")
  .action(async (options) => {
    const { generateArmNames, getNameGeneratorStats } = await import("./arm-names");
    
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
    const octopaiDir = getOctopaiDir();
    let arms = await listArms(octopaiDir);
    
    // Filter out stopped arms unless --all is specified
    if (!options.all) {
      const activeArms = arms.filter(a => a.status !== "stopped");
      if (activeArms.length === 0 && arms.length > 0) {
        console.log("No active arms. Use --all to see stopped arms.");
        console.log(`(${arms.length} stopped arm(s) hidden)`);
        return;
      }
      arms = activeArms;
    }

    if (arms.length === 0) {
      console.log("No arms registered.");
      console.log("Spawn one with: octopai arm spawn --name <name> --agent opencode");
      return;
    }

    console.log("Arms:");
    for (const a of arms) {
      const status = a.status === "running" || a.status === "idle" ? "●" : 
                     a.status === "busy" ? "◐" : 
                     a.status === "stopped" ? "○" : "◌";
      const domain = (a as { domain?: string }).domain ? ` [${(a as { domain?: string }).domain}]` : "";
      console.log(`  ${status} ${a.id} (${a.agent})${domain} - ${a.status}${a.currentTask ? ` → ${a.currentTask}` : ""}`);
    }
    
    if (options.all) {
      const stoppedCount = arms.filter(a => a.status === "stopped").length;
      if (stoppedCount > 0) {
        console.log("");
        console.log(`Tip: Run 'octopai arm cleanup' to remove ${stoppedCount} stopped arm(s).`);
      }
    }
  });

armCmd
  .command("kill <name>")
  .description("Kill an arm")
  .action(async (name) => {
    const octopaiDir = getOctopaiDir();
    const { apiUrl, headers } = getApiConfig();
    
    // Try to use API first
    if (await isApiRunning()) {
      const killRes = await fetch(`${apiUrl}/api/arms/${name}/kill`, {
        method: "POST",
        headers,
      });
      
      if (killRes.ok) {
        console.log(`Arm ${name} killed via API.`);
        return;
      }
      // If API kill failed, fall through to direct kill
    }
    
    // Direct kill (for terminal-based arms or when API is down)
    const success = await killArm(octopaiDir, name);

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
      console.error("API server is not running. Start it with: octopai serve");
      process.exit(1);
    }

    // Check if arm exists
    const armRes = await fetch(`${apiUrl}/api/arms/${name}`, { headers });
    if (!armRes.ok) {
      console.error(`Arm not found: ${name}`);
      process.exit(1);
    }

    const armData = await armRes.json() as { arm: { status: string } };
    if (armData.arm.status !== "idle" && armData.arm.status !== "busy") {
      console.error(`Arm ${name} is not running (status: ${armData.arm.status})`);
      console.error("Start the arm first with: octopai arm spawn --name " + name);
      process.exit(1);
    }

    // Send prompt
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
    const apiKey = process.env.OCTOPAI_API_KEY;
    
    if (!await isApiRunning()) {
      console.error("API server is not running. Start it with: octopai serve");
      process.exit(1);
    }

    if (!apiKey) {
      console.error("OCTOPAI_API_KEY environment variable is required for WebSocket connection");
      process.exit(1);
    }

    // If a specific arm name is given, verify it exists
    if (name && !options?.all) {
      const armRes = await fetch(`${apiUrl}/api/arms/${name}`, { headers });
      if (!armRes.ok) {
        console.error(`Arm not found: ${name}`);
        process.exit(1);
      }
    }

    const filterTypes = options?.filter?.split(",").map(t => t.trim()) || [];
    const showAll = !name || options?.all;

    console.log(`Tailing events${showAll ? " from all arms" : ` from ${name}`}...`);
    console.log("Press Ctrl+C to stop\n");

    // Connect to WebSocket
    const wsUrl = apiUrl.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      // Authenticate
      ws.send(JSON.stringify({ type: "auth", apiKey }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        
        // Handle auth response
        if (msg.type === "auth") {
          if (msg.success) {
            // Subscribe to arm-events channel
            ws.send(JSON.stringify({ type: "subscribe", channel: "arm-events" }));
          } else {
            console.error("Authentication failed:", msg.error);
            process.exit(1);
          }
          return;
        }

        // Handle subscription confirmation
        if (msg.type === "subscribed") {
          console.log(`Connected and subscribed to ${msg.channel}`);
          return;
        }

        // Handle arm events
        if (msg.channel === "arm-events") {
          const armId = msg.data?.armId;
          const eventType = msg.event?.replace("arm.", "") || "unknown";

          // Filter by arm name if specified
          if (!showAll && armId !== name) return;

          // Filter by event type if specified
          if (filterTypes.length > 0 && !filterTypes.some(t => eventType.includes(t))) return;

          // Format and print the event
          const timestamp = new Date(msg.timestamp).toLocaleTimeString();
          const armLabel = armId ? `[${armId}]` : "";
          
          // Color-code by event type
          let prefix = "";
          if (eventType.includes("status")) prefix = "📊";
          else if (eventType.includes("tool") || eventType.includes("part-tool")) prefix = "🔧";
          else if (eventType.includes("message")) prefix = "💬";
          else if (eventType.includes("file")) prefix = "📄";
          else if (eventType.includes("todo")) prefix = "✅";
          else prefix = "📡";

          // Helper to format a value for display
          const formatValue = (val: unknown): string => {
            if (val === null || val === undefined) return "unknown";
            if (typeof val === "string") return val;
            if (typeof val === "number" || typeof val === "boolean") return String(val);
            if (typeof val === "object") {
              // For objects, try to extract meaningful fields
              const obj = val as Record<string, unknown>;
              if (obj.status) return String(obj.status);
              if (obj.name) return String(obj.name);
              if (obj.id) return String(obj.id);
              // Fallback to compact JSON
              return JSON.stringify(val);
            }
            return String(val);
          };

          // Format the data for display
          let details = "";
          const data = msg.data || {};
          
          if (eventType === "status") {
            // Extract status from nested object if needed
            const statusVal = typeof data.status === "object" && data.status !== null
              ? (data.status as Record<string, unknown>).status || data.status
              : data.status;
            details = `status=${formatValue(statusVal)}`;
            // Add session title if available
            if (data.title) details += ` title="${data.title}"`;
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
            if (data.content) details = `"${data.content}"`;
            if (data.status) details += ` [${formatValue(data.status)}]`;
          } else {
            // Generic: show first few keys with proper formatting
            const keys = Object.keys(data).filter(k => k !== "armId" && k !== "sessionId").slice(0, 3);
            details = keys.map(k => `${k}=${formatValue(data[k])}`).join(" ");
          }

          console.log(`${timestamp} ${prefix} ${armLabel} ${eventType}: ${details}`);
        }
      } catch (err) {
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

    // Handle Ctrl+C
    process.on("SIGINT", () => {
      console.log("\nStopping...");
      ws.close();
      process.exit(0);
    });

    // Keep the process running
    await new Promise(() => {});
  });

armCmd
  .command("watch <name>")
  .description("Watch an arm's conversation in real-time (shows message text as it streams)")
  .option("--no-tools", "Hide tool invocations")
  .option("--no-system", "Hide system messages")
  .option("-n, --history <count>", "Show last N messages on connect", "2")
  .option("-v, --verbose", "Show all SSE events for debugging")
  .action(async (name, options?: { tools?: boolean; system?: boolean; history?: string; verbose?: boolean }) => {
    const { apiUrl, headers } = getApiConfig();
    const apiKey = process.env.OCTOPAI_API_KEY;
    const showTools = options?.tools !== false;
    const showSystem = options?.system !== false;
    const historyCount = parseInt(options?.history || "2", 10);
    const verbose = options?.verbose === true;
    
    if (!await isApiRunning()) {
      console.error("API server is not running. Start it with: octopai serve");
      process.exit(1);
    }

    if (!apiKey) {
      console.error("OCTOPAI_API_KEY environment variable is required for WebSocket connection");
      process.exit(1);
    }

    // Verify arm exists and get port
    const armRes = await fetch(`${apiUrl}/api/arms/${name}`, { headers });
    if (!armRes.ok) {
      console.error(`Arm not found: ${name}`);
      process.exit(1);
    }

    const armData = await armRes.json() as { arm: { port: number | null; status: string } };
    if (!armData.arm.port) {
      console.error(`Arm ${name} is not running (no port assigned)`);
      process.exit(1);
    }

    const port = armData.arm.port;
    const opencodeBaseUrl = `http://127.0.0.1:${port}`;

    console.log(`Watching arm: ${name} (${armData.arm.status})`);
    console.log("Press Ctrl+C to stop\n");

    // Fetch and display recent conversation history
    if (historyCount > 0) {
      try {
        // Get the most recent session
        const sessionsRes = await fetch(`${opencodeBaseUrl}/session`);
        if (sessionsRes.ok) {
          const sessions = await sessionsRes.json() as Array<{ id: string; title: string }>;
          if (sessions.length > 0) {
            // Sort by most recent (last in array is usually newest)
            const currentSession = sessions[sessions.length - 1];
            if (currentSession) {
              console.log(`Session: ${currentSession.title || currentSession.id}`);
              console.log("─".repeat(60));

              // Fetch messages
              const msgsRes = await fetch(`${opencodeBaseUrl}/session/${currentSession.id}/message?limit=${historyCount * 2}`);
              if (msgsRes.ok) {
                const messages = await msgsRes.json() as Array<{
                  info: { role: string; id: string };
                  parts: Array<{ type: string; text?: string; toolName?: string; name?: string; state?: string }>;
                }>;

                // Show last N messages
                const recentMessages = messages.slice(-historyCount);
                for (const msg of recentMessages) {
                  const role = msg.info.role;
                  const roleLabel = role === "assistant" ? "🤖 Assistant" :
                                   role === "user" ? "👤 User" :
                                   role === "system" ? "⚙️ System" : role;
                  
                  if (role === "system" && !showSystem) continue;
                  
                  console.log(roleLabel);
                  console.log("");

                  for (const part of msg.parts) {
                    if (part.type === "text" && part.text) {
                      // Truncate long messages in history
                      const text = part.text.length > 500 
                        ? part.text.slice(0, 500) + "\n... (truncated, showing last 500 chars)"
                        : part.text;
                      console.log(text);
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
      } catch (err) {
        // Ignore history fetch errors, just continue to live stream
        console.log("(Could not fetch message history)");
        console.log("─".repeat(60));
      }
    }

    console.log("Waiting for new messages...\n");

    // Connect directly to OpenCode's SSE endpoint for this arm
    const opencodeUrl = `${opencodeBaseUrl}/event`;
    
    // Track state for formatting
    let currentRole = "";
    let lastWasNewline = true;
    let currentToolName = "";

    const processEvent = (eventStr: string) => {
      const lines = eventStr.split("\n");
      let data = "";

      for (const line of lines) {
        if (line.startsWith("data:")) {
          data = line.slice(5).trim();
        }
      }

      if (!data) return;

      try {
        const event = JSON.parse(data) as { type: string; properties: Record<string, unknown> };
        const { type, properties: props } = event;

        // Verbose logging - show all events
        if (verbose) {
          const propsPreview = JSON.stringify(props).slice(0, 200);
          console.log(`[EVENT] ${type}: ${propsPreview}${propsPreview.length >= 200 ? '...' : ''}`);
        }

        // Handle message events - role is nested under props.info
        if (type === "message.created" || type === "message.updated") {
          const info = props.info as Record<string, unknown> | undefined;
          const role = info?.role as string;
          if (role && role !== currentRole) {
            if (!lastWasNewline) {
              process.stdout.write("\n");
            }
            console.log("─".repeat(60));
            const roleLabel = role === "assistant" ? "🤖 Assistant" :
                             role === "user" ? "👤 User" :
                             role === "system" ? "⚙️ System" : role;
            console.log(roleLabel);
            console.log("");
            currentRole = role;
            lastWasNewline = true;
          }
          
          // Check for errors in the message
          const error = info?.error as Record<string, unknown> | undefined;
          if (error) {
            const errorData = error.data as Record<string, unknown> | undefined;
            const errorMessage = errorData?.message || error.name || "Unknown error";
            if (!lastWasNewline) process.stdout.write("\n");
            console.log(`\n❌ Error: ${errorMessage}`);
            lastWasNewline = true;
          }
        }

        // Handle text parts - OpenCode uses message.part.updated with delta for incremental text
        if (type === "message.part.updated" || type === "message.part.created") {
          const part = props.part as Record<string, unknown> | undefined;
          const delta = props.delta as string | undefined;
          
          if (part) {
            const partType = part.type as string;
            
            if (partType === "text") {
              // Use delta (incremental) if available, otherwise use full text for part.created
              const textToWrite = delta ?? (type === "message.part.created" ? part.text as string : null);
              if (textToWrite) {
                process.stdout.write(textToWrite);
                lastWasNewline = textToWrite.endsWith("\n");
              }
            }
            
            // Handle tool invocations
            if (partType === "tool-invocation" && showTools) {
              const toolName = part.toolName as string || part.name as string;
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
                const error = part.error as string || "unknown error";
                console.log(`   ✗ ${currentToolName || toolName} failed: ${error}`);
                lastWasNewline = true;
              }
            }

            // Handle tool results
            if (partType === "tool-result" && showTools) {
              if (!lastWasNewline) process.stdout.write("\n");
              lastWasNewline = true;
            }
          }
        }

        // Handle session status changes - status is nested
        if (type === "session.status") {
          const status = props.status as Record<string, unknown> | undefined;
          const statusType = status?.type as string;
          if (statusType === "busy") {
            // Agent started processing - could show a spinner here
          } else if (statusType === "idle") {
            // Agent finished
            if (!lastWasNewline) process.stdout.write("\n");
            console.log("\n" + "─".repeat(60));
            console.log("✓ Response complete");
            console.log("─".repeat(60) + "\n");
            lastWasNewline = true;
            currentRole = "";
          }
        }

        // Handle session errors
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

    // Connect to SSE stream
    try {
      if (verbose) {
        console.log(`[DEBUG] Connecting to SSE: ${opencodeUrl}`);
      }
      
      const response = await fetch(opencodeUrl, {
        headers: {
          "Accept": "text/event-stream",
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
        console.log(`[DEBUG] Content-Type: ${response.headers.get('content-type')}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Handle Ctrl+C
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
          console.log(`[DEBUG] Received chunk (${chunk.length} bytes): ${chunk.slice(0, 100).replace(/\n/g, '\\n')}...`);
        }
        buffer += chunk;

        // Process complete events
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
  });

armCmd
  .command("todos <name>")
  .description("Show the todo list for an arm")
  .action(async (name) => {
    const { apiUrl, headers } = getApiConfig();
    
    if (!await isApiRunning()) {
      console.error("API server is not running. Start it with: octopai serve");
      process.exit(1);
    }

    // Verify arm exists
    const armRes = await fetch(`${apiUrl}/api/arms/${name}`, { headers });
    if (!armRes.ok) {
      console.error(`Arm not found: ${name}`);
      process.exit(1);
    }

    // Get todos
    const todosRes = await fetch(`${apiUrl}/api/arms/${name}/todos`, { headers });
    if (!todosRes.ok) {
      const err = await todosRes.json().catch(() => ({}));
      console.error(`Failed to get todos: ${(err as { error?: string }).error || todosRes.statusText}`);
      process.exit(1);
    }

    const data = await todosRes.json() as { todos: Array<{ content: string; status: string; priority?: string }> };
    const todos = data.todos || [];

    if (todos.length === 0) {
      console.log(`No todos for arm: ${name}`);
      return;
    }

    console.log(`Todos for arm: ${name}`);
    console.log("=".repeat(50));

    for (const todo of todos) {
      const statusIcon = todo.status === "completed" ? "✓" :
                         todo.status === "in_progress" ? "→" :
                         todo.status === "cancelled" ? "✗" : "○";
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
      console.error("API server is not running. Start it with: octopai serve");
      process.exit(1);
    }

    // Verify arm exists
    const armRes = await fetch(`${apiUrl}/api/arms/${name}`, { headers });
    if (!armRes.ok) {
      console.error(`Arm not found: ${name}`);
      process.exit(1);
    }

    const armData = await armRes.json() as { arm: { status: string; harness: string; domain?: string; provider?: string; model?: string } };

    // Get detailed status from OpenCode
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
      if (data.session?.updatedAt) console.log(`  Last updated: ${new Date(data.session.updatedAt).toLocaleString()}`);
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
      console.error("API server is not running. Start it with: octopai serve");
      process.exit(1);
    }
    
    // Check arm status first
    const armRes = await fetch(`${apiUrl}/api/arms/${name}`, { headers });
    if (!armRes.ok) {
      console.error(`Arm not found: ${name}`);
      process.exit(1);
    }
    
    const armData = await armRes.json() as { arm: { status: string } };
    if (armData.arm.status !== "stopped") {
      console.error(`Cannot remove arm with status: ${armData.arm.status}`);
      console.error("Kill the arm first with: octopai arm kill " + name);
      process.exit(1);
    }
    
    // Delete the arm
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
      console.error("API server is not running. Start it with: octopai serve");
      process.exit(1);
    }
    
    // Get all arms
    const armsRes = await fetch(`${apiUrl}/api/arms`, { headers });
    if (!armsRes.ok) {
      console.error("Failed to fetch arms");
      process.exit(1);
    }
    
    const armsData = await armsRes.json() as { arms: Array<{ id: string; status: string }> };
    const stoppedArms = armsData.arms.filter(a => a.status === "stopped");
    
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
    const octopaiDir = getOctopaiDir();
    const logPath = join(octopaiDir, "logs", `${name}.log`);

    const { existsSync, createReadStream, statSync } = await import("fs");

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

    // Show initial lines using tail command
    const { spawn } = await import("child_process");
    const tail = spawn("tail", ["-n", options.lines, "-f", logPath], {
      stdio: "inherit",
      cwd: process.cwd(),
    });

    tail.on("error", (err) => {
      console.error(`Failed to tail log: ${err}`);
      process.exit(1);
    });

    // Handle Ctrl+C
    process.on("SIGINT", () => {
      tail.kill("SIGINT");
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      tail.kill("SIGTERM");
      process.exit(0);
    });
  });

// ============================================
// ACTIVITY COMMAND
// ============================================

const activityCmd = program.command("activity").description("View activity log");

activityCmd
  .command("list")
  .description("List recent activity entries")
  .option("-n, --count <n>", "Number of entries to show", "20")
  .option("-a, --actor <name>", "Filter by actor (arm or component name)")
  .action(async (options) => {
    const octopaiDir = getOctopaiDir();
    const dbPath = join(octopaiDir, "octopai.db");

    try {
      const { Database } = await import("bun:sqlite");
      const db = new Database(dbPath, { readonly: true });

      const limit = Math.min(parseInt(options.count, 10), 100);
      let query = `
        SELECT id, timestamp, actor, action, target, details
        FROM activity
      `;
      const params: (string | number)[] = [];

      if (options.actor) {
        query += " WHERE actor = ?";
        params.push(options.actor);
      }

      query += " ORDER BY timestamp DESC LIMIT ?";
      params.push(limit);

      const rows = db.query(query).all(...params) as Array<{
        id: number;
        timestamp: string;
        actor: string;
        action: string;
        target: string | null;
        details: string;
      }>;

      if (rows.length === 0) {
        console.log("No activity recorded yet.");
        console.log("Activity is logged when arms spawn, tasks are processed, etc.");
        db.close();
        return;
      }

      console.log("Activity Log");
      console.log("=".repeat(60));

      for (const row of rows) {
        const timestamp = new Date(row.timestamp).toLocaleString();
        const target = row.target ? ` on ${row.target}` : "";
        const details = JSON.parse(row.details || "{}");

        console.log(`[${timestamp}]`);
        console.log(`  ${row.actor} ${row.action}${target}`);

        // Show relevant details if present
        if (details.domain) console.log(`    domain: ${details.domain}`);
        if (details.status) console.log(`    status: ${details.status}`);
        if (details.workdir) console.log(`    workdir: ${details.workdir}`);
        if (details.pid) console.log(`    pid: ${details.pid}`);
        if (Object.keys(details).length > 0 && !details.domain && !details.status && !details.workdir && !details.pid) {
          console.log(`    details: ${JSON.stringify(details)}`);
        }
        console.log("");
      }

      db.close();
    } catch (err) {
      console.log("No activity database found.");
      console.log("Start the API server or brain to begin logging activity.");
    }
  });

activityCmd
  .command("tail")
  .description("Tail activity log in real-time (Ctrl+C to exit)")
  .option("-n, --count <n>", "Initial entries to show", "10")
  .action(async (options) => {
    const octopaiDir = getOctopaiDir();
    const dbPath = join(octopaiDir, "octopai.db");

    try {
      const { Database } = await import("bun:sqlite");
      const db = new Database(dbPath, { readonly: true });

      // Get last entry ID for polling
      let lastId = 0;
      const lastRow = db.query("SELECT id FROM activity ORDER BY id DESC LIMIT 1").get() as { id: number } | null;
      if (lastRow) lastId = lastRow.id;

      console.log("Tailing activity log (Ctrl+C to exit)...");
      console.log("=".repeat(60));

      // Show initial entries
      const initial = db.query(`
        SELECT id, timestamp, actor, action, target, details
        FROM activity
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(parseInt(options.count, 10)) as Array<{
        id: number;
        timestamp: string;
        actor: string;
        action: string;
        target: string | null;
        details: string;
      }>;

      // Print in reverse (newest first)
      for (const row of [...initial].reverse()) {
        printActivityRow(row);
      }

      // Poll for new entries
      const readline = await import("readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

      const pollInterval = setInterval(() => {
        try {
          const newRows = db.query(`
            SELECT id, timestamp, actor, action, target, details
            FROM activity
            WHERE id > ?
            ORDER BY id ASC
          `).all(lastId) as Array<{
            id: number;
            timestamp: string;
            actor: string;
            action: string;
            target: string | null;
            details: string;
          }>;

          if (newRows.length > 0) {
            for (const row of newRows) {
              printActivityRow(row);
              lastId = row.id;
            }
          }
        } catch {
          // Database might be locked or closed
          clearInterval(pollInterval);
        }
      }, 1000);

      // Handle Ctrl+C
      process.on("SIGINT", () => {
        clearInterval(pollInterval);
        db.close();
        rl.close();
        process.exit(0);
      });

      process.on("SIGTERM", () => {
        clearInterval(pollInterval);
        db.close();
        rl.close();
        process.exit(0);
      });
    } catch (err) {
      console.log("No activity database found.");
      console.log("Start the API server or brain to begin logging activity.");
    }
  });

function printActivityRow(row: { id: number; timestamp: string; actor: string; action: string; target: string | null; details: string }): void {
  const timestamp = new Date(row.timestamp).toLocaleTimeString();
  const target = row.target ? ` on ${row.target}` : "";
  console.log(`[${timestamp}] ${row.actor} ${row.action}${target}`);
}

// ============================================
// MAIL COMMANDS
// ============================================

const mailCmd = program.command("mail").description("View and send mail");

mailCmd
  .command("inbox")
  .description("List messages in inbox")
  .option("-n, --count <n>", "Number of messages to show", "10")
  .option("-a, --all", "Show all messages including read")
  .action(async (options) => {
    const octopaiDir = getOctopaiDir();
    const inbox = new Maildir(join(octopaiDir, "mail", "inbox"));

    const messages = await inbox.list("new");
    const curMessages = await inbox.list("cur");
    
    // By default show unread first, then read
    let allMessages = [...messages, ...curMessages];
    if (!options.all) {
      // Prioritize unread messages
      allMessages = [...messages, ...curMessages.slice(0, Math.max(0, parseInt(options.count, 10) - messages.length))];
    }
    allMessages = allMessages.slice(0, parseInt(options.count, 10));

    if (allMessages.length === 0) {
      console.log("Inbox is empty.");
      return;
    }

    console.log("Inbox:");
    console.log("");
    for (const msg of allMessages) {
      const flag = msg.flags.seen ? " " : "*";
      const date = msg.date.toLocaleDateString();
      // Show a short ID (first 8 chars) for easy reference
      const shortId = msg.id.slice(0, 8);
      console.log(`  ${flag} ${shortId}  ${date}  ${msg.subject}`);
    }
    console.log("");
    console.log(`Use 'octopai mail read <id>' to read a message (id can be partial)`);
  });

mailCmd
  .command("send <message>")
  .description("Send a message to the brain")
  .option("-s, --subject <subject>", "Message subject")
  .action(async (message, options) => {
    const octopaiDir = getOctopaiDir();
    const sent = new Maildir(join(octopaiDir, "mail", "sent"));
    await sent.init();

    const subject = options.subject || `New task: ${message.slice(0, 50)}...`;

    await sent.write({
      from: "human@local",
      to: "brain@octopai.local",
      subject,
      date: new Date(),
      body: message,
      headers: {},
    });

    console.log(`Message sent: ${subject}`);
    console.log("The brain will process it on the next poll cycle.");
  });

mailCmd
  .command("read [id]")
  .description("Read a message (latest if no ID provided)")
  .action(async (id) => {
    const octopaiDir = getOctopaiDir();
    const inbox = new Maildir(join(octopaiDir, "mail", "inbox"));

    const messages = [...await inbox.list("new"), ...await inbox.list("cur")];

    if (messages.length === 0) {
      console.log("Inbox is empty.");
      return;
    }

    // Sort by date, newest first
    messages.sort((a, b) => b.date.getTime() - a.date.getTime());

    let msg = null;
    if (id) {
      msg = messages.find((m) => m.id.startsWith(id));
    } else {
      msg = messages[0];
    }

    if (!msg) {
      if (id) {
        console.log(`Message not found: ${id}`);
      }
      console.log("");
      console.log("Available messages:");
      for (const m of messages.slice(0, 5)) {
        console.log(`  ${m.id.slice(0, 8)}  ${m.subject.slice(0, 50)}`);
      }
      return;
    }

    // Strip ANSI codes and TUI artifacts for clean display
    const stripTerminalArtifacts = (text: string) => text
      .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
      .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "")
      .replace(/\x1B\[[\d;]*[A-Za-z]/g, "")
      .replace(/\x1B[PX^_].*?\x1B\\/g, "")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      .replace(/[─━│┃┄┅┆┇┈┉┊┋┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╌╍╎╏═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬]/g, "")
      .replace(/[▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐░▒▓▔▕▖▗▘▙▚▛▜▝▞▟■□▢▣▤▥▦▧▨▩▪▫▬▭▮▯]/g, "")
      .replace(/[◆◇◈◉◊○◌◍◎●◐◑◒◓◔◕◖◗◘◙◚◛◜◝◞◟◠◡◢◣◤◥◦◧◨◩◪◫◬◭◮◯⬝⬞⬟⬠⬡⬢⬣⬤⬥⬦⬧⬨⬩⬪⬫⬬⬭⬮⬯]/g, "")
      .replace(/[⊙⊚⊛⊜⊝⊞⊟⊠⊡▰▱▲△▴▵▶▷▸▹►▻▼▽▾▿◀◁◂◃◄◅◆◇]/g, "")
      .replace(/[\u2800-\u28FF]/g, "")
      .replace(/[←↑→↓↔↕↖↗↘↙↚↛↜↝↞↟↠↡↢↣↤↥↦↧↨↩↪↫↬↭↮↯↰↱↲↳↴↵↶↷↸↹↺↻↼↽↾↿⇀⇁⇂⇃⇄⇅⇆⇇⇈⇉⇊⇋⇌⇍⇎⇏⇐⇑⇒⇓⇔⇕⇖⇗⇘⇙⇚⇛⇜⇝⇞⇟⇠⇡⇢⇣⇤⇥⇦⇧⇨⇩⇪]/g, "")
      .replace(/[—–·•‣⁃◦]/g, "")
      .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/g, "")
      .replace(/[']{2,}/g, "")
      .replace(/["]{2,}/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    console.log(`ID: ${msg.id}`);
    console.log(`From: ${msg.from}`);
    console.log(`To: ${msg.to}`);
    console.log(`Subject: ${stripTerminalArtifacts(msg.subject)}`);
    console.log(`Date: ${msg.date.toLocaleString()}`);
    console.log(`---`);
    console.log(stripTerminalArtifacts(msg.body));

    // Mark as read
    if (!msg.flags.seen) {
      await inbox.markSeen(msg.id);
    }
  });

// ============================================
// IMAP COMMANDS
// ============================================

const imapCmd = program.command("imap").description("IMAP server for email clients");

imapCmd
  .command("serve")
  .description("Start the IMAP server")
  .option("-p, --port <port>", "IMAP server port", "1143")
  .option("-h, --host <host>", "IMAP server host", "127.0.0.1")
  .option("-u, --username <username>", "IMAP username", "octopai")
  .option("--password <password>", "IMAP password (defaults to auto-generated)")
  .action(async (options) => {
    const octopaiDir = getOctopaiDir();
    const { startImapServer } = await import("../imap");

    // Generate a password if not provided
    let password = options.password;
    if (!password) {
      // Check if we have a stored password in the database
      try {
        const { Database } = await import("bun:sqlite");
        const dbPath = join(octopaiDir, "octopai.db");
        const db = new Database(dbPath);
        const row = db.query("SELECT value FROM config WHERE key = 'imap_password'").get() as { value: string } | null;
        if (row) {
          password = row.value;
        } else {
          // Generate and store a new password
          const crypto = await import("crypto");
          password = crypto.randomBytes(16).toString("hex");
          db.run("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)",
            ["imap_password", password, new Date().toISOString()]);
        }
        db.close();
      } catch {
        // Database might not exist, use a simple default
        password = "octopai";
      }
    }

    console.log(`Starting IMAP server...`);
    console.log(`  Host: ${options.host}`);
    console.log(`  Port: ${options.port}`);
    console.log(`  Username: ${options.username}`);
    console.log(`  Password: ${password}`);
    console.log(``);
    console.log(`Connect with your email client using:`);
    console.log(`  Server: ${options.host}`);
    console.log(`  Port: ${options.port}`);
    console.log(`  Security: None (local only)`);
    console.log(`  Username: ${options.username}`);
    console.log(`  Password: ${password}`);
    console.log(``);

    const server = await startImapServer({
      port: parseInt(options.port, 10),
      host: options.host,
      octopaiDir,
      username: options.username,
      password,
    });

    // Handle graceful shutdown
    process.on("SIGINT", async () => {
      console.log("\nStopping IMAP server...");
      await server.stop();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      await server.stop();
      process.exit(0);
    });
  });

imapCmd
  .command("password")
  .description("Show or reset the IMAP password")
  .option("-r, --reset", "Generate a new password")
  .action(async (options) => {
    const octopaiDir = getOctopaiDir();
    const dbPath = join(octopaiDir, "octopai.db");

    try {
      const { Database } = await import("bun:sqlite");
      const db = new Database(dbPath);

      if (options.reset) {
        const crypto = await import("crypto");
        const password = crypto.randomBytes(16).toString("hex");
        db.run("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)",
          ["imap_password", password, new Date().toISOString()]);
        console.log(`New IMAP password: ${password}`);
      } else {
        const row = db.query("SELECT value FROM config WHERE key = 'imap_password'").get() as { value: string } | null;
        if (row) {
          console.log(`IMAP password: ${row.value}`);
        } else {
          console.log("No IMAP password set. Start the IMAP server to auto-generate one.");
        }
      }

      db.close();
    } catch (err) {
      console.error(`Failed to access database: ${err}`);
      process.exit(1);
    }
  });

// ============================================
// MCP COMMANDS
// ============================================

const mcpCmd = program.command("mcp").description("MCP server commands");

mcpCmd
  .command("serve")
  .description("Run the MCP server (used by arms)")
  .action(async () => {
    await runMcpServer();
  });

// ============================================
// AGENT COMMANDS
// ============================================

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
    const octopaiDir = getOctopaiDir();
    
    // Dynamically import ArmAgent to avoid loading NATS if not needed
    const { ArmAgent } = await import("../agent");
    
    const agent = new ArmAgent({
      agentId: options.id,
      natsUrl: options.natsUrl,
      octopaiDir,
      maxArms: parseInt(options.maxArms, 10),
      heartbeatIntervalMs: parseInt(options.heartbeatInterval, 10),
      debug: options.verbose,
    });
    
    console.log("Starting arm agent...");
    console.log(`  NATS URL: ${options.natsUrl}`);
    console.log(`  Octopai Dir: ${octopaiDir}`);
    console.log(`  Max Arms: ${options.maxArms}`);
    console.log("");
    
    // Handle graceful shutdown
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
      
      // Keep the process running
      await new Promise(() => {});
    } catch (err) {
      console.error(`Failed to start agent: ${err}`);
      console.error("");
      console.error("Make sure the API server with embedded NATS is running:");
      console.error("  octopai serve");
      process.exit(1);
    }
  });

agentCmd
  .command("status")
  .description("Show status of connected agents")
  .action(async () => {
    const { apiUrl, headers } = getApiConfig();
    
    if (!await isApiRunning()) {
      console.error("API server is not running. Start it with: octopai serve");
      process.exit(1);
    }
    
    // This endpoint would need to be added to the API
    const res = await fetch(`${apiUrl}/api/agents`, { headers });
    if (!res.ok) {
      console.error("Failed to get agent status. The API may not support this yet.");
      process.exit(1);
    }
    
    const data = await res.json() as { agents: Array<{ agentId: string; hostname: string; capabilities: string[]; activeArms: number; maxArms: number }> };
    const agents = data.agents || [];
    
    if (agents.length === 0) {
      console.log("No agents connected.");
      console.log("");
      console.log("Start an agent with: octopai agent start");
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

// ============================================
// TASKS COMMAND
// ============================================

const tasksCmd = program.command("tasks").description("Manage tasks");

tasksCmd
  .command("sync")
  .description("Sync tasks from project plan files (.project/plan.md)")
  .option("-v, --verbose", "Show detailed output", false)
  .action(async (options) => {
    const octopaiDir = getOctopaiDir();
    const dbPath = join(octopaiDir, "octopai.db");

    try {
      const { Database } = await import("bun:sqlite");
      const db = new Database(dbPath, { readwrite: true });

      // Enable task auto-discover if not already set
      const autoDiscover = db.query("SELECT value FROM config WHERE key = ?").get("task_auto_discover") as { value: string } | null;
      if (!autoDiscover) {
        db.run("INSERT INTO config (key, value) VALUES (?, ?)", ["task_auto_discover", "true"]);
      }

      // Import plan parser
      const { findPlanFiles, parsePlanFile, tasksToDatabaseFormat } = await import("../brain/plan-parser");

      // Find plan files
      const projectRoot = process.cwd();
      const planFiles = await findPlanFiles(projectRoot);

      if (planFiles.length === 0) {
        console.log("No plan files found.");
        console.log("Expected: .project/plan.md or **/*.plan.md");
        db.close();
        return;
      }

      console.log(`Found ${planFiles.length} plan file(s):`);
      for (const f of planFiles) {
        console.log(`  - ${f}`);
      }
      console.log("");

      let newTasksCount = 0;
      let updatedTasksCount = 0;
      let skippedCount = 0;

      for (const filePath of planFiles) {
        const result = await parsePlanFile(filePath);

        if (result.errors.length > 0) {
          console.log(`Parse errors in ${filePath}:`);
          for (const err of result.errors) {
            console.log(`  - ${err}`);
          }
          continue;
        }

        // Check if file changed
        const existingFile = db.query("SELECT id, last_hash FROM plan_files WHERE file_path = ?")
          .get(filePath) as { id: number; last_hash: string } | undefined;

        if (existingFile?.last_hash === result.fileHash) {
          skippedCount++;
          if (options.verbose) {
            console.log(`  Skipped (unchanged): ${filePath}`);
          }
          continue;
        }

        console.log(`Processing: ${filePath}`);
        console.log(`  Found ${result.tasks.length} task(s), ${result.phases.length} phase(s)`);

        const dbTasks = tasksToDatabaseFormat(result.tasks);

        for (const task of dbTasks) {
          const existing = db.query("SELECT id, status FROM tasks WHERE id = ?").get(task.id) as { id: string; status: string } | undefined;

          if (!existing) {
            db.run(`
              INSERT INTO tasks (id, subject, description, status, priority, source_type, source_ref, phase, metadata)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [task.id, task.subject, task.description, task.status, task.priority, task.source_type, task.source_ref, task.phase, task.metadata]);
            newTasksCount++;
            if (options.verbose) {
              console.log(`    + Added: ${task.subject}`);
            }
          } else if (existing.status === "pending" && task.status === "completed") {
            db.run("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", [task.status, new Date().toISOString(), task.id]);
            updatedTasksCount++;
            if (options.verbose) {
              console.log(`    ~ Updated: ${task.subject} (marked complete)`);
            }
          }
        }

        // Update plan file tracking
        const now = new Date().toISOString();
        if (existingFile) {
          db.run("UPDATE plan_files SET last_parsed_at = ?, last_hash = ?, updated_at = ? WHERE id = ?",
            [now, result.fileHash, now, existingFile.id]);
        } else {
          db.run("INSERT INTO plan_files (file_path, last_parsed_at, last_hash, updated_at) VALUES (?, ?, ?, ?)",
            [filePath, now, result.fileHash, now]);
        }
      }

      console.log("\nTask Sync Summary:");
      console.log(`  New tasks: ${newTasksCount}`);
      console.log(`  Updated: ${updatedTasksCount}`);
      console.log(`  Unchanged: ${skippedCount}`);
      console.log(`  Total plan files: ${planFiles.length}`);

      db.close();
    } catch (err) {
      console.error(`Failed to sync tasks: ${err}`);
      process.exit(1);
    }
  });

tasksCmd
  .command("list")
  .description("List tasks in database")
  .option("-s, --status <status>", "Filter by status (pending, claimed, completed)")
  .option("-n, --limit <n>", "Limit results", "20")
  .action(async (options) => {
    const octopaiDir = getOctopaiDir();
    const dbPath = join(octopaiDir, "octopai.db");

    try {
      const { Database } = await import("bun:sqlite");
      const db = new Database(dbPath, { readonly: true });

      let query = "SELECT id, subject, status, priority, phase FROM tasks";
      const params: string[] = [];

      if (options.status) {
        query += " WHERE status = ?";
        params.push(options.status);
      }

      query += " ORDER BY created_at DESC LIMIT ?";
      params.push(options.limit);

      const rows = db.query(query).all(...params) as Array<{
        id: string;
        subject: string;
        status: string;
        priority: string;
        phase: string | null;
      }>;

      if (rows.length === 0) {
        console.log("No tasks found.");
        console.log("Run 'octopai tasks sync' to import from plan files.");
        db.close();
        return;
      }

      console.log("Tasks:");

      const headers = ["Status", "Priority", "Subject", "Phase", "ID"];
      const tableRows = rows.map((row) => {
        const statusIcon = row.status === "pending" ? "○" :
                          row.status === "claimed" ? "◐" :
                          row.status === "in_progress" ? "◑" : "●";
        const priorityIcon = row.priority === "critical" ? "🔴" :
                            row.priority === "high" ? "🟠" :
                            row.priority === "low" ? "🔵" : "⚪";
        return [
          `${statusIcon} ${row.status}`,
          `${priorityIcon} ${row.priority}`,
          row.subject,
          row.phase || "-",
          row.id,
        ];
      });

      const colWidths: number[] = headers.map((header, idx) => {
        const cells = tableRows.map((row) => row[idx] ?? "");
        const maxCellLength = cells.length > 0 ? Math.max(...cells.map((cell) => cell.length)) : 0;
        return Math.max(header.length, maxCellLength);
      });

      const formatRow = (row: string[]) => row
        .map((cell, idx) => {
          const width = colWidths[idx] ?? (headers[idx] ? headers[idx].length : 0);
          return (cell ?? "").padEnd(width);
        })
        .join("  ");

      console.log(formatRow(headers));
      console.log(colWidths.map((w) => "-".repeat(w)).join("  "));
      for (const row of tableRows) {
        console.log(formatRow(row));
      }

      db.close();
    } catch (err) {
      console.log("No task database found.");
      console.log("Start the API server or run 'octopai tasks sync'.");
    }
  });

// ============================================
// STATUS COMMAND
// ============================================

program
  .command("status")
  .description("Show overall Octopai status")
  .action(async () => {
    const octopaiDir = getOctopaiDir();

    console.log(`Octopai Status`);
    console.log(`Directory: ${octopaiDir}`);
    console.log(``);

    // API server status
    if (await isApiRunning()) {
      console.log(`API Server: running`);
    } else {
      console.log(`API Server: not running`);
    }

    // Brain status
    try {
      const content = await readFile(join(octopaiDir, "state", "brain.json"), "utf-8");
      const state = JSON.parse(content);
      console.log(`Brain: ${state.status} (last poll: ${state.lastPollAt || "never"})`);
    } catch {
      console.log(`Brain: not started`);
    }

    // Arms
    const arms = await listArms(octopaiDir);
    const activeArms = arms.filter(a => a.status !== "stopped");
    const stoppedArms = arms.filter(a => a.status === "stopped");
    console.log(`Arms: ${activeArms.length} active, ${stoppedArms.length} stopped`);
    for (const a of activeArms) {
      console.log(`  - ${a.id}: ${a.status}`);
    }

    // Mail
    const inbox = new Maildir(join(octopaiDir, "mail", "inbox"));
    const newCount = await inbox.count("new");
    console.log(`Inbox: ${newCount} unread`);

    // Tasks
    try {
      const content = await readFile(join(octopaiDir, "state", "tasks.json"), "utf-8");
      const tasks = JSON.parse(content);
      const pending = tasks.filter((t: { status: string }) => t.status === "pending").length;
      const inProgress = tasks.filter((t: { status: string }) => t.status === "in_progress").length;
      console.log(`Tasks: ${pending} pending, ${inProgress} in progress`);
    } catch {
      console.log(`Tasks: 0`);
    }
  });

// ============================================
// CONFIG COMMAND
// ============================================

const configCmd = program.command("config").description("Manage Octopai configuration");

configCmd
  .command("presets")
  .description("List available arm configuration presets")
  .action(async () => {
    const presetsDir = join(TEMPLATES_DIR, "presets");
    try {
      const files = await readdir(presetsDir);
      const presets = files.filter(f => f.endsWith(".json")).map(f => f.replace(".json", ""));

      console.log("Available Presets:\n");

      const presetInfo: Record<string, string> = {
        fullstack: "Single generalist arm for small projects",
        "split-stack": "Frontend + backend specialist arms",
        "full-team": "Full team: frontend, backend, testing, docs, architect",
      };

      for (const preset of presets) {
        console.log(`  ${preset}`);
        console.log(`    ${presetInfo[preset] || "No description"}\n`);
      }

      console.log("Usage: octopai init --preset <name>");
      console.log("       octopai config load <name>");
    } catch {
      console.log("No presets found.");
    }
  });

configCmd
  .command("load <preset>")
  .description("Load an arm configuration preset")
  .action(async (preset) => {
    const octopaiDir = getOctopaiDir();
    const armsDir = join(octopaiDir, "arms");
    await mkdir(armsDir, { recursive: true });

    const presetPath = join(TEMPLATES_DIR, "presets", `${preset}.json`);
    try {
      const presetContent = await readFile(presetPath, "utf-8");
      const presetData = JSON.parse(presetContent);

      console.log(`Loading preset: ${presetData.name}`);
      console.log(`Description: ${presetData.description}\n`);

      for (const armConfig of presetData.arms) {
        const templatePath = join(TEMPLATES_DIR, "arms", armConfig.template);
        let content = await readFile(templatePath, "utf-8");

        // Replace the name in the template
        content = content.replace(/name = "[^"]*"/, `name = "${armConfig.name}"`);

        const destPath = join(armsDir, `${armConfig.name}.toml`);
        await writeFile(destPath, content, "utf-8");
        console.log(`  ✓ ${armConfig.name}.toml`);
      }

      console.log(`\n${presetData.arms.length} arm configuration(s) written to ${armsDir}/`);
    } catch (err) {
      console.error(`Failed to load preset "${preset}": ${err}`);
      process.exit(1);
    }
  });

configCmd
  .command("arms")
  .description("List configured arms")
  .action(async () => {
    const octopaiDir = getOctopaiDir();
    const armsDir = join(octopaiDir, "arms");

    try {
      const files = await readdir(armsDir);
      const configs = files.filter(f => f.endsWith(".toml"));

      if (configs.length === 0) {
        console.log("No arm configurations found.");
        console.log("Run: octopai init");
        return;
      }

      console.log("Arm Configurations:\n");
      for (const config of configs) {
        const content = await readFile(join(armsDir, config), "utf-8");
        const nameMatch = content.match(/name\s*=\s*"([^"]*)"/);
        const domainMatch = content.match(/domain\s*=\s*"([^"]*)"/);
        const name = nameMatch?.[1] || config.replace(".toml", "");
        const domain = domainMatch?.[1] || "general";
        console.log(`  ${name} [${domain}]`);
      }
    } catch {
      console.log("Arms directory not found. Run: octopai init");
    }
  });

// ============================================
// HELPER FUNCTIONS
// ============================================

function generateConfigToml(config: OctopaiConfig): string {
  return `# Octopai Configuration
# Generated on ${new Date().toISOString()}

version = ${config.version}

[brain]
poll_interval_ms = ${config.brain.pollIntervalMs}
max_arms = ${config.brain.maxArms}

[mail]
from_address = "${config.mail.fromAddress}"
digest_schedule = "${config.mail.digestSchedule}"

[terminal]
emulator = "${config.terminal.emulator}"

# Gitea configuration (optional)
# [gitea]
# url = "http://localhost:3000"
# token = "your-token-here"
# default_org = "octopai"
# default_repo = "workspace"
`;
}

/**
 * Copy arm templates to the octopai directory
 */
async function copyArmTemplates(octopaiDir: string, preset: string): Promise<void> {
  const armsDir = join(octopaiDir, "arms");

  if (preset) {
    // Load preset configuration
    const presetPath = join(TEMPLATES_DIR, "presets", `${preset}.json`);
    try {
      const presetContent = await readFile(presetPath, "utf-8");
      const presetData = JSON.parse(presetContent);

      console.log(`\nLoading preset: ${presetData.name}`);
      console.log(`Description: ${presetData.description}`);

      for (const armConfig of presetData.arms) {
        const templatePath = join(TEMPLATES_DIR, "arms", armConfig.template);
        let content = await readFile(templatePath, "utf-8");

        // Replace the name in the template
        content = content.replace(/name = "[^"]*"/, `name = "${armConfig.name}"`);

        const destPath = join(armsDir, `${armConfig.name}.toml`);
        await writeFile(destPath, content, "utf-8");
        console.log(`  ✓ ${armConfig.name} (${armConfig.template})`);
      }

      console.log(`\n${presetData.arms.length} arm configuration(s) copied to ${armsDir}/`);
    } catch (err) {
      console.log(`\nWarning: Could not load preset "${preset}"`);
      console.log("Falling back to default templates...\n");
      await copyDefaultTemplates(armsDir);
    }
  } else {
    // Copy default templates (fullstack)
    await copyDefaultTemplates(armsDir);
  }
}

async function copyDefaultTemplates(armsDir: string): Promise<void> {
  console.log("\nCopying default arm templates...");

  // Copy all arm templates
  const templates = ["fullstack.toml", "frontend.toml", "backend.toml", "testing.toml", "docs.toml", "architect.toml"];
  for (const template of templates) {
    try {
      const srcPath = join(TEMPLATES_DIR, "arms", template);
      const destPath = join(armsDir, template);
      await copyFile(srcPath, destPath);
      console.log(`  ✓ ${template}`);
    } catch {
      // Template might not exist, skip
    }
  }

  console.log(`\nArm templates copied to ${armsDir}/`);
  console.log("Edit or delete these files before spawning arms.");
  console.log("Run 'octopai arm spawn' to interactively spawn an arm.");
}

// Run the CLI
program.parse();
