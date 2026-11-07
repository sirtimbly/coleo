import { mkdir, writeFile, copyFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { initMaildir } from "../mail";
import { ensureDefaultArmTemplates } from "../config";
import { getBrainTemplatesDir, TEMPLATES_DIR } from "./context";

/** Create missing runtime assets, never replace a user's configuration or templates. */
export async function initializeSetupRuntime(directory: string): Promise<void> {
  for (const name of ["state/arms", "state/notes/shared", "mcp", "logs", "arms", "templates", "src/brain/templates"]) {
    await mkdir(join(directory, name), { recursive: true });
  }
  await initMaildir(join(directory, "mail"));
  try { await writeFile(join(directory, "config.toml"), "# Coleo runtime configuration\nversion = 1\n", { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const copyMissing = async (source: string, target: string) => {
    try { await copyFile(source, target, constants.COPYFILE_EXCL); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  };
  for (const name of await readdir(getBrainTemplatesDir())) {
    if (name.endsWith(".jinja")) await copyMissing(join(getBrainTemplatesDir(), name), join(directory, "src/brain/templates", name));
  }
  await copyMissing(join(TEMPLATES_DIR, "arms/default.toml"), join(directory, "arms/default.toml"));
  await ensureDefaultArmTemplates(directory);
}
