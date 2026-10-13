import { Command } from "commander";
import { join } from "path";
import { readFile, readdir } from "fs/promises";
import { getColeoDir } from "../context";

export function registerConfigCommands(program: Command): void {
  const configCmd = program.command("config").description("Manage Coleo arm configuration");
  // Preset subcommands are intentionally disabled for now.

  configCmd
    .command("arms")
    .description("List configured arms")
    .action(async () => {
      const coleoDir = getColeoDir();
      const armsDir = join(coleoDir, "arms");

      try {
        const files = await readdir(armsDir);
        const configs = files.filter((f) => f.endsWith(".toml"));

        if (configs.length === 0) {
          console.log("No arm configurations found.");
          console.log("Run: coleo init");
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
        console.log("Arms directory not found. Run: coleo init");
      }
    });
}
