import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

interface ProjectDefaults {
  workspace: string;
  directory: string;
  connection?: string;
  webExecutable?: string;
}

/** Add missing launch defaults without replacing credentials or user overrides. */
export async function ensureProjectDefaults(input: ProjectDefaults): Promise<{ changed: string[]; conflicts: string[] }> {
  const defaults: Record<string, string> = {
    COLEO_PROJECT_DIR: input.workspace,
    COLEO_DIR: input.directory,
    ...(input.connection ? { COLEO_CONNECTION: input.connection } : {}),
    ...(input.webExecutable ? { COLEO_WEB_EXECUTABLE: input.webExecutable } : {}),
  };
  const changed: string[] = [];
  const conflicts: string[] = [];
  for (const path of new Set([join(input.workspace, ".env"), join(input.directory, ".env")])) {
    let content = "";
    try { content = await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const existing = new Map<string, string>();
    for (const line of content.split("\n")) {
      const match = line.trim().match(/^(?:export\s+)?([A-Z_]+)\s*=(.*)$/);
      if (match) existing.set(match[1]!, match[2]!.trim().replace(/^(['"])(.*)\1$/, "$2"));
    }
    const additions: string[] = [];
    for (const [key, value] of Object.entries(defaults)) {
      if (/[\r\n\0"]/.test(value)) throw new Error(`Cannot persist ${key}: unsupported characters`);
      if (existing.has(key)) {
        if (existing.get(key) !== value) conflicts.push(`${path}: ${key} differs from saved project settings`);
      } else additions.push(`${key}="${value}"`);
    }
    if (!additions.length) continue;
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${content}${content && !content.endsWith("\n") ? "\n" : ""}${additions.join("\n")}\n`, { mode: 0o600 });
    await rename(temporary, path);
    changed.push(path);
  }
  return { changed, conflicts };
}
