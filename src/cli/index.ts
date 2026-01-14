#!/usr/bin/env bun
/**
 * Octopai CLI
 * 
 * AI agent orchestrator using the Octopus Model
 */

import { Command } from "commander";
import { join, dirname } from "path";
import { mkdir, writeFile, readFile, copyFile, readdir } from "fs/promises";
import { homedir } from "os";
import { Brain } from "../brain";
import { initMaildir, Maildir } from "../mail";
import { runMcpServer } from "../mcp";
import { spawnArm, listArms, killArm } from "../arm";
import { startServer } from "../api";
import type { OctopaiConfig } from "../types";
import { DEFAULT_CONFIG } from "../types";

const TEMPLATES_DIR = join(dirname(import.meta.filename), "..", "..", "templates");

const program = new Command();

// Resolve octopai directory
function getOctopaiDir(): string {
  return process.env.OCTOPAI_DIR || join(homedir(), ".octopai");
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
  .description("Initialize Octopai in ~/.octopai")
  .option("-d, --dir <path>", "Custom directory", "~/.octopai")
  .option("--preset <name>", "Preset configuration (fullstack, split-stack, full-team)", "")
  .action(async (options) => {
    const octopaiDir = expandPath(options.dir);
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

${preset ? `Preset "${preset}" arms have been configured in ~/.octopai/arms/` : ""}
Edit or delete arm configs in ~/.octopai/arms/ before spawning.

Next steps:
  1. Configure your mail client to read from ${octopaiDir}/mail/inbox
  2. Configure arms: edit ~/.octopai/arms/*.toml
  3. Start the API server: octopai serve
  4. Spawn an arm: octopai arm spawn --name <name> --agent opencode
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
  .description("Run the brain polling loop (foreground)")
  .option("-i, --interval <ms>", "Poll interval in milliseconds", "30000")
  .option("-v, --verbose", "Verbose output", false)
  .option("--once", "Run a single poll cycle and exit")
  .action(async (options) => {
    const octopaiDir = getOctopaiDir();
    const interval = parseInt(options.interval, 10);

    const brain = new Brain({
      octopaiDir,
      pollIntervalMs: interval,
      verbose: options.verbose || true, // Default to verbose in foreground
    });

    await brain.init();

    // Handle graceful shutdown
    process.on("SIGINT", () => {
      console.log("\nShutting down brain...");
      brain.stop();
    });

    process.on("SIGTERM", () => {
      brain.stop();
    });

    if (options.once) {
      await brain.runOnce();
    } else {
      await brain.run();
    }
  });

brainCmd
  .command("status")
  .description("Show brain status")
  .action(async () => {
    const octopaiDir = getOctopaiDir();

    try {
      const content = await readFile(join(octopaiDir, "state", "brain.json"), "utf-8");
      const state = JSON.parse(content);

      console.log("Brain Status:");
      console.log(`  Status: ${state.status}`);
      console.log(`  Last poll: ${state.lastPollAt || "never"}`);
      console.log(`  Poll interval: ${state.pollIntervalMs}ms`);
      console.log(`  Active arms: ${state.activeArms?.length || 0}`);
      console.log(`  Pending tasks: ${state.pendingTasks || 0}`);
      console.log(`  Completed today: ${state.completedToday || 0}`);
    } catch {
      console.log("Brain has not been started yet.");
      console.log("Run: octopai brain run");
    }
  });

// ============================================
// ARM COMMANDS
// ============================================

const armCmd = program.command("arm").description("Manage arms (agents)");

armCmd
  .command("spawn")
  .description("Spawn a new arm")
  .requiredOption("-n, --name <name>", "Arm name/ID")
  .option("-a, --agent <agent>", "Agent type (opencode, claude-code, aider)", "opencode")
  .option("-d, --domain <domain>", "Arm domain (backend, frontend, testing, docs, etc.)", "general")
  .option("-w, --workdir <path>", "Working directory", process.cwd())
  .option("-t, --terminal <terminal>", "Terminal emulator (ghostty, iterm2, terminal, tmux). If not specified, uses API server.")
  .option("-p, --prompt <prompt>", "Initial prompt/task for the agent")
  .option("--provider <provider>", "AI provider (e.g., anthropic, openai)")
  .option("--model <model>", "Model name (e.g., claude-sonnet-4-20250514)")
  .action(async (options) => {
    const octopaiDir = getOctopaiDir();
    
    // If terminal is specified, use the direct spawner (opens a terminal window)
    if (options.terminal) {
      const arm = await spawnArm({
        octopaiDir,
        name: options.name,
        agent: options.agent,
        workdir: expandPath(options.workdir),
        terminal: options.terminal,
        initialPrompt: options.prompt,
        headless: false,
        provider: options.provider,
        model: options.model,
        domain: options.domain,
      });

      console.log(`Arm spawned in terminal: ${arm.id}`);
      console.log(`  Agent: ${arm.agent}`);
      if (arm.provider || arm.model) {
        console.log(`  Model: ${arm.provider ? arm.provider + "/" : ""}${arm.model || "default"}`);
      }
      console.log(`  Domain: ${options.domain}`);
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
    const existsRes = await fetch(`${apiUrl}/api/arms/${options.name}`, { headers });
    const armExists = existsRes.ok;
    
    if (armExists) {
      // Check if it's stopped - if so, we can restart it
      const existingArm = await existsRes.json() as { arm: { status: string } };
      if (existingArm.arm.status !== "stopped") {
        console.error(`Arm ${options.name} already exists with status: ${existingArm.arm.status}`);
        console.error("Use 'octopai arm kill <name>' first, or choose a different name.");
        process.exit(1);
      }
      console.log(`Restarting stopped arm: ${options.name}`);
    } else {
      // Create new arm
      const createRes = await fetch(`${apiUrl}/api/arms`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: options.name,
          domain: options.domain,
          harness: options.agent,
          status: "starting",
          provider: options.provider,
          model: options.model,
        }),
      });
      
      if (!createRes.ok) {
        const err = await createRes.json().catch(() => ({}));
        console.error(`Failed to create arm: ${(err as { error?: string }).error || createRes.statusText}`);
        process.exit(1);
      }
    }
    
    // Spawn via harness
    const spawnRes = await fetch(`${apiUrl}/api/arms/${options.name}/spawn`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workdir: expandPath(options.workdir),
        provider: options.provider,
        model: options.model,
        initialPrompt: options.prompt,
      }),
    });
    
    if (!spawnRes.ok) {
      const err = await spawnRes.json().catch(() => ({}));
      console.error(`Failed to spawn arm: ${(err as { error?: string }).error || spawnRes.statusText}`);
      process.exit(1);
    }
    
    const result = await spawnRes.json() as { sessionId?: string; pid?: number };
    
    console.log(`Arm spawned via API: ${options.name}`);
    console.log(`  Agent: ${options.agent}`);
    if (options.provider || options.model) {
      console.log(`  Model: ${options.provider ? options.provider + "/" : ""}${options.model || "default"}`);
    }
    console.log(`  Domain: ${options.domain}`);
    console.log(`  Session: ${result.sessionId}`);
    console.log(`  PID: ${result.pid || "unknown"}`);
    console.log("");
    console.log("The arm is running in the API server process.");
    console.log(`View logs: tail -f ~/.octopai/logs/${options.name}.log`);
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

// ============================================
// MAIL COMMANDS
// ============================================

const mailCmd = program.command("mail").description("View and send mail");

mailCmd
  .command("inbox")
  .description("List messages in inbox")
  .option("-n, --count <n>", "Number of messages to show", "10")
  .action(async (options) => {
    const octopaiDir = getOctopaiDir();
    const inbox = new Maildir(join(octopaiDir, "mail", "inbox"));

    const messages = await inbox.list("new");
    const curMessages = await inbox.list("cur");
    const allMessages = [...messages, ...curMessages].slice(0, parseInt(options.count, 10));

    if (allMessages.length === 0) {
      console.log("Inbox is empty.");
      return;
    }

    console.log("Inbox:");
    for (const msg of allMessages) {
      const flag = msg.flags.seen ? " " : "●";
      const date = msg.date.toLocaleDateString();
      console.log(`  ${flag} [${date}] ${msg.subject}`);
    }
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
  .command("read <id>")
  .description("Read a specific message")
  .action(async (id) => {
    const octopaiDir = getOctopaiDir();
    const inbox = new Maildir(join(octopaiDir, "mail", "inbox"));

    const messages = [...await inbox.list("new"), ...await inbox.list("cur")];
    const msg = messages.find((m) => m.id.startsWith(id));

    if (!msg) {
      console.log(`Message not found: ${id}`);
      return;
    }

    console.log(`From: ${msg.from}`);
    console.log(`To: ${msg.to}`);
    console.log(`Subject: ${msg.subject}`);
    console.log(`Date: ${msg.date.toLocaleString()}`);
    console.log(`---`);
    console.log(msg.body);
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

  // Copy the fullstack template as default
  const fullstackPath = join(TEMPLATES_DIR, "arms", "fullstack.toml");
  const content = await readFile(fullstackPath, "utf-8");
  await writeFile(join(armsDir, "fullstack-dev.toml"), content, "utf-8");
  console.log("  ✓ fullstack-dev.toml (general purpose)");

  // Also copy other templates for reference
  const templates = ["frontend.toml", "backend.toml", "testing.toml", "docs.toml", "architect.toml"];
  for (const template of templates) {
    try {
      const srcPath = join(TEMPLATES_DIR, "arms", template);
      const destPath = join(armsDir, `example-${template}`);
      await copyFile(srcPath, destPath);
      console.log(`  ✓ example-${template}`);
    } catch {
      // Template might not exist, skip
    }
  }

  console.log(`\nArm templates copied to ${armsDir}/`);
  console.log("Edit or delete these files before spawning arms.");
  console.log("The fullstack-dev.toml is ready to use as-is.");
}

// Run the CLI
program.parse();
