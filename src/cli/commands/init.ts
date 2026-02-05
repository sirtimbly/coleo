import { Command } from "commander";
import { join } from "path";
import { mkdir, writeFile, readFile, copyFile, symlink, readdir, access } from "fs/promises";
import { homedir } from "os";
import { randomBytes } from "crypto";
import type { ColeoConfig } from "../../types";
import { DEFAULT_CONFIG } from "../../types";
import { initMaildir } from "../../mail";
import { TEMPLATES_DIR, getBrainTemplatesDir } from "../context";
import { getCliEntrypoint } from "../entrypoint";
import { createInterface } from "readline";

/**
 * Generate a secure random API token
 */
function generateApiToken(): string {
  return "co_" + randomBytes(32).toString("hex");
}

/**
 * Ask the user a yes/no question
 */
async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${question} (y/n) `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith("y"));
    });
  });
}

/**
 * Generate example arm.toml content
 */
function generateExampleArmToml(): string {
  return `# Example Arm Configuration
# This is a sample arm configuration file for Coleo
# Copy this to create your own arm configurations in the .coleo/arms/ directory

[arm]
name = "example-arm"
domain = "development"
# Recommended: opencode-api for headless API-driven arms
# Alternative: opencode-tui for visible terminal sessions
harness = "opencode-api"

[model]
# Configure your AI model provider
provider = "openai"  # Examples: "openai", "anthropic", "kimi", "groq", "xai"
model = "gpt-5.1-codex-mini"  # Examples: "gpt-5.1-mini", "gpt-4o", "claude-3-opus", "kimi-k2"

# Optional: Custom model configuration
# [model.config]
# temperature = 0.7
# max_tokens = 4096
# top_p = 0.9

# Optional: Arm-specific settings
# [settings]
# auto_spawn = false
# timeout_minutes = 30

# To spawn this arm, run:
#   coleo arm spawn --config .coleo/arms/example-arm.toml
# Or with a specific workdir:
#   coleo arm spawn --config .coleo/arms/example-arm.toml --workdir ./src
`;
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize Coleo in the current project (.coleo/)")
    .option("-d, --dir <path>", "Custom directory", ".coleo")
    .option("--preset <name>", "Preset configuration (fullstack, split-stack, full-team)", "")
    .action(async (options) => {
      const coleoDir = options.dir.startsWith("/") ? options.dir : join(process.cwd(), options.dir);
      const preset = options.preset;
      console.log(`Initializing Coleo in ${coleoDir}...`);

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
        await mkdir(join(coleoDir, dir), { recursive: true });
      }

      await initMaildir(join(coleoDir, "mail"));

      const config: ColeoConfig = {
        ...DEFAULT_CONFIG,
        coleoDir,
      };

      await writeFile(join(coleoDir, "config.toml"), generateConfigToml(config), "utf-8");
      await copyBrainTemplates(coleoDir);
      await copyArmTemplates(coleoDir, preset);

      // Create example arm.toml
      const armsDir = join(coleoDir, "arms");
      const exampleArmPath = join(armsDir, "example-arm.toml");
      await writeFile(exampleArmPath, generateExampleArmToml(), "utf-8");
      console.log(`  ✓ Example arm config: ${exampleArmPath}`);

      // Handle API token setup
      const envPath = join(coleoDir, ".env");
      let apiToken = "";
      let envCreated = false;

      try {
        await access(envPath);
        // .env already exists, skip token generation
      } catch {
        // .env doesn't exist, ask user if they want to generate a token
        console.log("\n🔐 API Security Setup");
        console.log("Coleo uses an API token for secure communication between components.");
        
        const shouldGenerate = await askYesNo("Generate a random API token and save it to .env?");
        
        if (shouldGenerate) {
          apiToken = generateApiToken();
          const envContent = `# Coleo Environment Configuration
# Generated on ${new Date().toISOString()}

# API Authentication Token
# This token is used to authenticate API requests between components
# Keep it secret and do not commit this file to version control
COLEO_API_TOKEN=${apiToken}

# Optional: API Configuration
# COLEO_API_PORT=8080
# COLEO_API_HOST=localhost

# Optional: NATS Configuration (for distributed mode)
# COLEO_NATS_URL=nats://localhost:4222
`;
          await writeFile(envPath, envContent, "utf-8");
          envCreated = true;
          console.log(`  ✓ API token generated and saved to ${envPath}`);
        } else {
          console.log("  ℹ You can manually set COLEO_API_TOKEN later by:");
          console.log("    - Creating .env in .coleo/ directory");
          console.log("    - Or running: export COLEO_API_TOKEN=your-token-here");
        }
      }

      const coleoScriptPath = join(coleoDir, "bin", "coleo");
      await mkdir(join(coleoDir, "bin"), { recursive: true });
      const cliEntrypoint = getCliEntrypoint();
      const bunBinary = process.execPath;
      await writeFile(
        coleoScriptPath,
        `#!/bin/bash\n# Coleo CLI wrapper - runs from project directory\ncd "${process.cwd()}"\nexec "${bunBinary}" "${cliEntrypoint}" "$@"\n`,
        "utf-8",
      );

      const { spawn } = await import("node:child_process");
      await new Promise<void>((resolve, reject) => {
        spawn("chmod", ["+x", coleoScriptPath]).on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`chmod failed with code ${code}`));
        });
      });

      let symlinkPath = "";
      try {
        symlinkPath = "/usr/local/bin/coleo";
        await symlink(coleoScriptPath, symlinkPath);
      } catch {
        try {
          const userBin = join(homedir(), "bin");
          await mkdir(userBin, { recursive: true });
          symlinkPath = join(userBin, "coleo");
          await symlink(coleoScriptPath, symlinkPath);
        } catch {
          symlinkPath = "";
        }
      }

      const symlinkInfo = symlinkPath ? `\n  ✓ Symlink created: ${symlinkPath}` : "";
      const scriptInfo = `\n  ✓ CLI wrapper: ${coleoScriptPath}`;

      const envInfo = envCreated
        ? `\n  ✓ API token configured in ${join(coleoDir, ".env")}`
        : "";

      const presetInfo = preset
        ? `\n  ✓ Preset "${preset}" configured in ${join(coleoDir, "arms/")}`
        : `
  ✓ Example arm config: ${join(coleoDir, "arms/example-arm.toml")}`;

      console.log(`
┌─────────────────────────────────────────────────────────────┐
│                  Coleo initialized!                         │
└─────────────────────────────────────────────────────────────┘

 Directory structure created:
    ${coleoDir}/
    ├── mail/          # Human-agent communication (Maildir)
    ├── queue/         # Inter-agent message queue
    ├── state/         # Persistent state
    ├── arms/          # Arm configurations
    │   └── example-arm.toml  # Example arm config${presetInfo}
    ├── mcp/           # MCP configurations
    ├── logs/          # Log files
    ├── .env           # API token and secrets${envInfo}
    └── src/brain/templates/  # Brain prompt templates
${scriptInfo}${symlinkInfo}

 Quick Start:
   1. Start the API server:  coleo serve start
   2. Start the web UI:     coleo web start
   3. View dashboard:       http://localhost:5173
   4. Configure arms:       edit .coleo/arms/*.toml
   5. Spawn an arm:         coleo arm spawn --workdir ./src

 Documentation: https://coleo.dev
    `);
    });
}

function generateConfigToml(config: ColeoConfig): string {
  return `# Coleo Configuration
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
# default_org = "coleo"
# default_repo = "workspace"
`;
}

async function copyBrainTemplates(coleoDir: string): Promise<void> {
  const brainTemplatesDir = join(coleoDir, "src", "brain", "templates");
  const sourceDir = getBrainTemplatesDir();
  
  try {
    const templates = await readdir(sourceDir);
    let copied = 0;
    
    for (const template of templates) {
      if (template.endsWith('.jinja')) {
        try {
          const srcPath = join(sourceDir, template);
          const destPath = join(brainTemplatesDir, template);
          await mkdir(brainTemplatesDir, { recursive: true });
          await copyFile(srcPath, destPath);
          copied++;
        } catch (err) {
          console.warn(`  ⚠ Could not copy template ${template}: ${err}`);
        }
      }
    }
    
    if (copied > 0) {
      console.log(`  ✓ ${copied} brain templates copied to ${brainTemplatesDir}/`);
    }
  } catch (err) {
    console.warn(`  ⚠ Could not copy brain templates: ${err}`);
  }
}

async function copyArmTemplates(coleoDir: string, preset: string): Promise<void> {
  const armsDir = join(coleoDir, "arms");

  if (preset) {
    const presetPath = join(TEMPLATES_DIR, "presets", `${preset}.json`);
    try {
      const presetContent = await readFile(presetPath, "utf-8");
      const presetData = JSON.parse(presetContent);

      console.log(`\nLoading preset: ${presetData.name}`);
      console.log(`Description: ${presetData.description}`);

      for (const armConfig of presetData.arms) {
        const templatePath = join(TEMPLATES_DIR, "arms", armConfig.template);
        let content = await readFile(templatePath, "utf-8");
        content = content.replace(/name = "[^"]*"/, `name = "${armConfig.name}"`);
        const destPath = join(armsDir, `${armConfig.name}.toml`);
        await writeFile(destPath, content, "utf-8");
        console.log(`  ✓ ${armConfig.name} (${armConfig.template})`);
      }

      console.log(`\n${presetData.arms.length} arm configuration(s) copied to ${armsDir}/`);
      return;
    } catch (err) {
      console.log(`\nWarning: Could not load preset "${preset}"`);
      console.log("Falling back to default templates...\n");
    }
  }

  await copyDefaultTemplates(armsDir);
}

async function copyDefaultTemplates(armsDir: string): Promise<void> {
  console.log("\nCopying default arm templates...");

  const templates = ["fullstack.toml", "frontend.toml", "backend.toml", "testing.toml", "docs.toml", "architect.toml"];
  for (const template of templates) {
    try {
      const srcPath = join(TEMPLATES_DIR, "arms", template);
      const destPath = join(armsDir, template);
      await copyFile(srcPath, destPath);
      console.log(`  ✓ ${template}`);
    } catch {
      // Ignore missing templates
    }
  }

  console.log(`\nArm templates copied to ${armsDir}/`);
  console.log("Edit or delete these files before spawning arms.");
  console.log("Run 'coleo arm spawn' to interactively spawn an arm.");
}
