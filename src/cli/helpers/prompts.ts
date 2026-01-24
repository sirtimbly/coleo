import { readFile } from "fs/promises";
import { join } from "path";
import { createInterface } from "readline";

export async function prompt(text: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(text, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export async function promptSelect(text: string, options: string[]): Promise<string> {
  if (options.length === 0) {
    return "";
  }
  console.log(text);
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${i + 1}. ${options[i]}`);
  }
  const answer = await prompt("Select: ");
  const idx = parseInt(answer, 10) - 1;
  if (idx >= 0 && idx < options.length) {
    const result = options[idx];
    return result !== undefined ? result : "";
  }
  const fallback = options[0];
  return fallback !== undefined ? fallback : "";
}

export async function promptYN(text: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  const answer = await prompt(text + suffix);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

export async function loadArmTemplates(armsDir: string): Promise<Array<{ name: string; file: string; domain: string; description: string }>> {
  const templates: Array<{ name: string; file: string; domain: string; description: string }> = [];
  try {
    const files = await readDirSafe(armsDir);
    for (const file of files) {
      if (!file.endsWith(".toml")) continue;
      const filePath = join(armsDir, file);
      try {
        const content = await readFile(filePath, "utf-8");
        const nameMatch = content.match(/name\s*=\s*"([^"]*)"/);
        const domainMatch = content.match(/domain\s*=\s*"([^"]*)"/);
        const traitsMatch = content.match(/traits\s*=\s*"([^"]*)"/);
        const name = nameMatch?.[1] || file.replace(".toml", "");
        const domain = domainMatch?.[1] || "general";
        const description = traitsMatch?.[1] || `${domain} specialist`;
        templates.push({ name, file, domain, description });
      } catch {
        // Ignore unreadable files
      }
    }
  } catch {
    // Directory may not exist
  }
  return templates;
}

async function readDirSafe(path: string): Promise<string[]> {
  try {
    const { readdir } = await import("fs/promises");
    return await readdir(path);
  } catch {
    return [];
  }
}
