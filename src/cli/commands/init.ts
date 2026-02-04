import { Command } from "commander";
import { join } from "path";
import { mkdir, writeFile, readFile, copyFile, symlink, readdir } from "fs/promises";
import { homedir } from "os";
import type { ColeoConfig } from "../../types";
import { DEFAULT_CONFIG } from "../../types";
import { initMaildir } from "../../mail";
import { TEMPLATES_DIR, getBrainTemplatesDir } from "../context";
import { getCliEntrypoint } from "../entrypoint";

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

      console.log(`
 Coleo initialized!
 
 Directory structure created:
    ${coleoDir}/
    ├── mail/          # Human-agent communication (Maildir)
    ├── queue/         # Inter-agent message queue
    ├── state/         # Persistent state
    ├── arms/          # Arm configurations
    ├── mcp/           # MCP configurations
    ├── logs/          # Log files
    └── src/brain/templates/  # Brain prompt templates
 
${preset ? `Preset "${preset}" arms have been configured in .coleo/arms/` : ""}
${scriptInfo}${symlinkInfo}
  Edit or delete arm configs in .coleo/arms/ before spawning.
 
  Next steps:
     1. In your project repo, create a shared branch for arms to work on (for example: git checkout -b coleo)
     2. Start the API server: coleo serve
     3. Configure arms: edit .coleo/arms/*.toml
     4. Spawn an arm pointed at your project worktree: coleo arm spawn --workdir /path/to/your/project
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
