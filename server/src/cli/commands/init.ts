import { Command } from "commander";
import { join } from "path";
import { mkdir, writeFile, copyFile, symlink, readdir, access, readFile } from "fs/promises";
import { homedir } from "os";
import type { ColeoConfig } from "../../types";
import { DEFAULT_CONFIG } from "../../types";
import { initMaildir } from "../../mail";
import { TEMPLATES_DIR, getBrainTemplatesDir } from "../context";
import { getCliEntrypoint } from "../entrypoint";
import { ensureDefaultArmTemplates } from "../../config";
import { resolveProjectDirectory } from "../../project-scope";
import { promptYN } from "../helpers/prompts";
import {
  createColeoMiseEnvironment,
  generateApiKey,
  readColeoMiseEnvironment,
  readEnvValue,
  updateMiseToml,
} from "../init-environment";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize Coleo in the current project (.coleo/)")
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
        "templates",
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
      const seededTemplates = await ensureDefaultArmTemplates(coleoDir);
      console.log(`  ✓ ${seededTemplates.created.length} default Arm templates ready in ${join(coleoDir, "templates")}`);
      const defaultArmPath = await copyDefaultArmTemplate(coleoDir);
      console.log(`  ✓ Default arm config: ${defaultArmPath}`);

      // Handle project network and API key setup
      const envPath = join(coleoDir, ".env");
      const misePath = join(process.cwd(), "mise.toml");
      const projectDir = resolveProjectDirectory({ COLEO_PROJECT_DIR: process.cwd() }, process.cwd());
      let apiKey = "";
      let envCreated = false;
      let miseConfigured = false;

      const existingEnv = await readFile(envPath, "utf-8").catch(() => "");
      const existingMise = await readFile(misePath, "utf-8").catch(() => "");
      const existingMiseEnvironment = readColeoMiseEnvironment(existingMise);

      if (!options.nonInteractive) {
        console.log("\nProject-local networking");
        console.log("Each Coleo project runs an API server and a local NATS/JetStream server.");
        console.log("Unique ports prevent another project on this host from being reused accidentally");
        console.log("and keep each project's API traffic and JetStream event history isolated.");

        const shouldGeneratePorts = await promptYN(
          "Generate available project-specific API and NATS ports?",
          true,
        );
        if (shouldGeneratePorts) {
          const environment = await createColeoMiseEnvironment(projectDir, {
            ...existingMiseEnvironment,
            COLEO_API_HOST: existingMiseEnvironment.COLEO_API_HOST || process.env.COLEO_API_HOST,
            COLEO_NATS_HOST: existingMiseEnvironment.COLEO_NATS_HOST || process.env.COLEO_NATS_HOST,
            COLEO_API_KEY:
              process.env.COLEO_API_KEY
              || process.env.COLEO_API_TOKEN
              || existingMiseEnvironment.COLEO_API_KEY
              || readEnvValue(existingEnv, "COLEO_API_KEY")
              || readEnvValue(existingEnv, "COLEO_API_TOKEN"),
          });
          apiKey = environment.COLEO_API_KEY;

          console.log(`  API:          http://${environment.COLEO_API_HOST}:${environment.COLEO_API_PORT}`);
          console.log(`  NATS:         nats://${environment.COLEO_NATS_HOST}:${environment.COLEO_NATS_PORT}`);
          console.log(`  NATS monitor: http://${environment.COLEO_NATS_HOST}:${environment.COLEO_NATS_HTTP_PORT}`);
          console.log("  The generated API key will be shared by the server, brain, agents, and CLI.");
          console.log("  Warning: mise.toml will contain that key in plaintext; do not commit it.");

          if (await promptYN(`Write this configuration to ${misePath}?`, true)) {
            await writeFile(misePath, updateMiseToml(existingMise, environment), "utf-8");
            miseConfigured = true;
            console.log(`  Configuration written to ${misePath}`);
          }
        }
      } else {
        console.log("  Non-interactive mode: skipping local port and mise.toml prompts.");
      }

      if (!miseConfigured) {
        try {
          await access(envPath);
          // .env already exists, skip key generation
        } catch {
          // .env doesn't exist, optionally ask user if they want to generate a key
          console.log("\nAPI security setup");
          console.log("Coleo uses an API key for secure communication between components.");

          let shouldGenerate = false;
          if (options.nonInteractive) {
            console.log("  Non-interactive mode: skipping API key generation prompt.");
          } else {
            shouldGenerate = await promptYN("Generate a random API key and save it to .env?", true);
          }

          if (shouldGenerate) {
            apiKey ||= generateApiKey();
            const envContent = `# Coleo Environment Configuration
# Generated on ${new Date().toISOString()}

# API authentication key used by the server, brain, agents, and CLI
# Keep it secret and do not commit this file to version control
COLEO_API_KEY=${apiKey}

# Optional: API Configuration
# COLEO_API_PORT=8080
# COLEO_API_HOST=127.0.0.1

# Optional: local NATS configuration
# COLEO_NATS_HOST=127.0.0.1
# COLEO_NATS_PORT=4222
# COLEO_NATS_HTTP_PORT=8222

# Optional: external NATS URL override (for distributed mode)
# COLEO_NATS_URL=nats://localhost:4222
`;
            await writeFile(envPath, envContent, "utf-8");
            envCreated = true;
            console.log(`  API key generated and saved to ${envPath}`);
          } else {
            console.log("  You can manually set COLEO_API_KEY later by:");
            console.log("    - Creating .env in .coleo/ directory");
            console.log("    - Or running: export COLEO_API_KEY=your-key-here");
          }
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
        ? `\n  ✓ API key configured in ${join(coleoDir, ".env")}`
        : "";
      const miseInfo = miseConfigured ? `\n  ✓ Project network configuration: ${misePath}` : "";

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
    ├── templates/     # Arm templates shown in Setup and Spawn Arm
    ├── mcp/           # MCP configurations
    ├── logs/          # Log files
    ├── .env           # API token and secrets${envInfo}
    └── src/brain/templates/  # Brain prompt templates
${scriptInfo}${symlinkInfo}${miseInfo}

 Quick Start:
   1. Start the API server:  coleo serve start
      (auto-starts local NATS if COLEO_NATS_URL is unset)
   2. Start the web UI:     coleo web start
   3. View dashboard:       http://localhost:5173
   4. Configure arms:       edit .coleo/arms/default.toml
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
arm_grace_period_minutes = ${config.brain.armGracePeriodMinutes}

[mail]
provider = "${config.mail.provider}"
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
