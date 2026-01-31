import { Command } from "commander";
import { join } from "path";
import { mkdir, readFile, readdir, writeFile } from "fs/promises";
import { getColeoDir, TEMPLATES_DIR } from "../context";

export function registerConfigCommands(program: Command): void {
  const configCmd = program.command("config").description("Manage Coleo configuration");

  configCmd
    .command("presets")
    .description("List available arm configuration presets")
    .action(async () => {
      const presetsDir = join(TEMPLATES_DIR, "presets");
      try {
        const files = await readdir(presetsDir);
        const presets = files.filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""));

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

        console.log("Usage: coleo init --preset <name>");
        console.log("       coleo config load <name>");
      } catch {
        console.log("No presets found.");
      }
    });

  configCmd
    .command("load <preset>")
    .description("Load an arm configuration preset")
    .action(async (preset) => {
      const coleoDir = getColeoDir();
      const armsDir = join(coleoDir, "arms");
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
