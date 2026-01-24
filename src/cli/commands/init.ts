import { Command } from "commander";
import { join } from "path";
import { mkdir, writeFile, readFile, copyFile, symlink } from "fs/promises";
import { homedir } from "os";
import type { OctopaiConfig } from "../../types";
import { DEFAULT_CONFIG } from "../../types";
import { initMaildir } from "../../mail";
import { getOctopaiDir, TEMPLATES_DIR } from "../context";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize Octopai in the current project (.octopai/)")
    .option("-d, --dir <path>", "Custom directory", ".octopai")
    .option("--preset <name>", "Preset configuration (fullstack, split-stack, full-team)", "")
    .action(async (options) => {
      const octopaiDir = options.dir.startsWith("/") ? options.dir : join(process.cwd(), options.dir);
      const preset = options.preset;
      console.log(`Initializing Octopai in ${octopaiDir}...`);

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

      await initMaildir(join(octopaiDir, "mail"));

      const config: OctopaiConfig = {
        ...DEFAULT_CONFIG,
        octopaiDir,
      };

      await writeFile(join(octopaiDir, "config.toml"), generateConfigToml(config), "utf-8");
      await copyArmTemplates(octopaiDir, preset);

      const octopaiScriptPath = join(octopaiDir, "bin", "octopai");
      await mkdir(join(octopaiDir, "bin"), { recursive: true });
      await writeFile(
        octopaiScriptPath,
        `#!/bin/bash\n# Octopai CLI wrapper - runs from source directory\ncd "${process.cwd()}"\nexec bun run src/cli/index.ts "$@"\n`,
        "utf-8",
      );

      const { spawn } = await import("node:child_process");
      await new Promise<void>((resolve, reject) => {
        spawn("chmod", ["+x", octopaiScriptPath]).on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`chmod failed with code ${code}`));
        });
      });

      let symlinkPath = "";
      try {
        symlinkPath = "/usr/local/bin/octopai";
        await symlink(octopaiScriptPath, symlinkPath);
      } catch {
        try {
          const userBin = join(homedir(), "bin");
          await mkdir(userBin, { recursive: true });
          symlinkPath = join(userBin, "octopai");
          await symlink(octopaiScriptPath, symlinkPath);
        } catch {
          symlinkPath = "";
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
}

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

async function copyArmTemplates(octopaiDir: string, preset: string): Promise<void> {
  const armsDir = join(octopaiDir, "arms");

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
  console.log("Run 'octopai arm spawn' to interactively spawn an arm.");
}
