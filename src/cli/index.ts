#!/usr/bin/env bun
/**
 * Octopai CLI
 * 
 * AI agent orchestrator using the Octopus Model
 */

import { Command } from "commander";
import { join } from "path";
import { mkdir, writeFile, readFile } from "fs/promises";
import { homedir } from "os";
import { Brain } from "../brain";
import { initMaildir, Maildir } from "../mail";
import { runMcpServer } from "../mcp";
import { spawnTentacle, listTentacles, killTentacle } from "../tentacle";
import type { OctopaiConfig } from "../types";
import { DEFAULT_CONFIG } from "../types";

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
  .action(async (options) => {
    const octopaiDir = expandPath(options.dir);
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
      "state/tentacles",
      "state/notes/shared",
      "mcp",
      "logs",
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

    console.log(`
Octopai initialized!

Directory structure created:
  ${octopaiDir}/
  ├── mail/          # Human-agent communication (Maildir)
  ├── queue/         # Inter-agent message queue
  ├── state/         # Persistent state
  ├── mcp/           # MCP configurations
  └── logs/          # Log files

Next steps:
  1. Configure your mail client to read from ${octopaiDir}/mail/inbox
  2. Start the brain: octopai brain run
  3. Spawn a tentacle: octopai tentacle spawn --name explorer --agent opencode
`);
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
      console.log(`  Active tentacles: ${state.activeTentacles?.length || 0}`);
      console.log(`  Pending tasks: ${state.pendingTasks || 0}`);
      console.log(`  Completed today: ${state.completedToday || 0}`);
    } catch {
      console.log("Brain has not been started yet.");
      console.log("Run: octopai brain run");
    }
  });

// ============================================
// TENTACLE COMMANDS
// ============================================

const tentacleCmd = program.command("tentacle").description("Manage tentacles");

tentacleCmd
  .command("spawn")
  .description("Spawn a new tentacle")
  .requiredOption("-n, --name <name>", "Tentacle name/ID")
  .option("-a, --agent <agent>", "Agent type (opencode, claude-code, aider)", "opencode")
  .option("-w, --workdir <path>", "Working directory", process.cwd())
  .option("-t, --terminal <terminal>", "Terminal emulator (auto, ghostty, iterm2, terminal, tmux, headless)", "auto")
  .option("-p, --prompt <prompt>", "Initial prompt/task for the agent")
  .option("--headless", "Run in headless mode (no terminal window, for containers/SSH)")
  .action(async (options) => {
    const octopaiDir = getOctopaiDir();

    const tentacle = await spawnTentacle({
      octopaiDir,
      name: options.name,
      agent: options.agent,
      workdir: expandPath(options.workdir),
      terminal: options.terminal,
      initialPrompt: options.prompt,
      headless: options.headless,
    });

    console.log(`Tentacle spawned: ${tentacle.id}`);
    console.log(`  Agent: ${tentacle.agent}`);
    console.log(`  Status: ${tentacle.status}`);
    console.log(`  PID: ${tentacle.pid || "unknown"}`);
  });

tentacleCmd
  .command("list")
  .description("List all tentacles")
  .action(async () => {
    const octopaiDir = getOctopaiDir();
    const tentacles = await listTentacles(octopaiDir);

    if (tentacles.length === 0) {
      console.log("No tentacles registered.");
      console.log("Spawn one with: octopai tentacle spawn --name <name> --agent opencode");
      return;
    }

    console.log("Tentacles:");
    for (const t of tentacles) {
      const status = t.status === "running" || t.status === "idle" ? "●" : 
                     t.status === "busy" ? "◐" : "○";
      console.log(`  ${status} ${t.id} (${t.agent}) - ${t.status}${t.currentTask ? ` [${t.currentTask}]` : ""}`);
    }
  });

tentacleCmd
  .command("kill <name>")
  .description("Kill a tentacle")
  .action(async (name) => {
    const octopaiDir = getOctopaiDir();
    const success = await killTentacle(octopaiDir, name);

    if (success) {
      console.log(`Tentacle ${name} killed.`);
    } else {
      console.log(`Failed to kill tentacle ${name}.`);
    }
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
  .description("Run the MCP server (used by tentacles)")
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

    // Brain status
    try {
      const content = await readFile(join(octopaiDir, "state", "brain.json"), "utf-8");
      const state = JSON.parse(content);
      console.log(`Brain: ${state.status} (last poll: ${state.lastPollAt || "never"})`);
    } catch {
      console.log(`Brain: not started`);
    }

    // Tentacles
    const tentacles = await listTentacles(octopaiDir);
    console.log(`Tentacles: ${tentacles.length}`);
    for (const t of tentacles) {
      console.log(`  - ${t.id}: ${t.status}`);
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
// HELPER FUNCTIONS
// ============================================

function generateConfigToml(config: OctopaiConfig): string {
  return `# Octopai Configuration
# Generated on ${new Date().toISOString()}

version = ${config.version}

[brain]
poll_interval_ms = ${config.brain.pollIntervalMs}
max_tentacles = ${config.brain.maxTentacles}

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

// Run the CLI
program.parse();
