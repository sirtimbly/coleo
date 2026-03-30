import { Command } from "commander";
import { join } from "path";
import { mkdir, writeFile, copyFile, symlink, readdir, access } from "fs/promises";
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

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Set up a project-local .coleo workspace")
    .option("-d, --dir <path>", "Custom directory", ".coleo")
    .option("--non-interactive", "Skip prompts (for automation)", false)
    .action(async (options) => {
      const coleoDir = options.dir.startsWith("/") ? options.dir : join(process.cwd(), options.dir);
      console.log(`Initializing Coleo in ${coleoDir}...`);

      const dirs = [
        "mail/inbox",
        "mail/sent",
        "mail/drafts",
        "mail/archive",
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
      const defaultArmPath = await copyDefaultArmTemplate(coleoDir);
      console.log(`  ✓ Default arm config: ${defaultArmPath}`);

      // Handle API token setup
      const envPath = join(coleoDir, ".env");
      let apiToken = "";
      let envCreated = false;

      try {
        await access(envPath);
        // .env already exists, skip token generation
      } catch {
        // .env doesn't exist, optionally ask user if they want to generate a token
        console.log("\n🔐 API Security Setup");
        console.log("Coleo uses an API token for secure communication between components.");

        let shouldGenerate = false;
        if (options.nonInteractive) {
          console.log("  ℹ Non-interactive mode: skipping API token generation prompt.");
        } else {
          shouldGenerate = await askYesNo("Generate a random API token and save it to .env?");
        }
        
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

# Optional: external NATS Configuration (for distributed mode)
# Leave this unset to let 'coleo serve' auto-start a local nats-server
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

      const { exec } = await import("node:child_process");
      await new Promise<void>((resolve, reject) => {
        exec(`chmod +x "${coleoScriptPath}"`, (error) => {
          if (error) reject(error);
          else resolve();
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

      console.log(`
┌─────────────────────────────────────────────────────────────┐
│                  Coleo initialized!                         │
└─────────────────────────────────────────────────────────────┘

 Directory structure created:
    ${coleoDir}/
    ├── mail/          # Human-agent communication (Maildir)
    ├── coleo.db       # SQLite system of record (created on first server start)
    ├── state/         # Persistent state
    ├── arms/          # Arm configurations
    │   └── default.toml  # Default arm config
    ├── mcp/           # MCP configurations
    ├── logs/          # Log files
    ├── .env           # API token and secrets${envInfo}
    └── src/brain/templates/  # Brain prompt templates
${scriptInfo}${symlinkInfo}

 Quick Start:
   1. Start the API server:  coleo serve start
      (auto-starts local NATS if COLEO_NATS_URL is unset)
   2. Start the brain:      coleo brain start
   3. Check system status:  coleo status
   4. Review tasks:         coleo tasks list
   5. Spawn an arm:         coleo arm spawn --prompt "Pick up the next important task"
   6. Optional web UI:      coleo web start
      Dashboard URL:        http://localhost:5173

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
arm_grace_period_minutes = ${config.brain.armGracePeriodMinutes}

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

async function copyDefaultArmTemplate(coleoDir: string): Promise<string> {
  const armsDir = join(coleoDir, "arms");
  const srcPath = join(TEMPLATES_DIR, "arms", "default.toml");
  const destPath = join(armsDir, "default.toml");
  await copyFile(srcPath, destPath);
  return destPath;
}
