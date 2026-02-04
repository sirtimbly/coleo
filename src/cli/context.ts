import { file } from "bun";
import { homedir } from "os";
import { dirname, join } from "path";
import { realpathSync } from "fs";
import { fileURLToPath } from "url";

// Re-export getColeoDir from config to ensure single source of truth
export { getColeoDir } from "../config";

const __dirname = dirname(realpathSync(fileURLToPath(import.meta.url)));

export const TEMPLATES_DIR = join(__dirname, "..", "..", "templates");

/**
 * Get the path to brain templates in the installed package
 * This resolves relative to the compiled CLI location
 */
export function getBrainTemplatesDir(): string {
  // When running from dist/commands/init.js: __dirname = dist/commands/
  // Templates are at dist/brain/templates/
  return join(__dirname, "..", "brain", "templates");
}

export async function loadEnvFile(): Promise<void> {
  const envPaths = [
    join(process.cwd(), ".coleo", ".env"),
    join(process.cwd(), ".env"),
  ];

  for (const envPath of envPaths) {
    try {
      const envFile = file(envPath);
      if (await envFile.exists()) {
        const content = await envFile.text();
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIndex = trimmed.indexOf("=");
          if (eqIndex === -1) continue;
          const key = trimmed.slice(0, eqIndex).trim();
          let value = trimmed.slice(eqIndex + 1).trim();
          if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
        break;
      }
    } catch {
      // Ignore errors reading .env
    }
  }
}

export function expandPath(path: string): string {
  if (path.startsWith("~")) {
    return join(homedir(), path.slice(1));
  }
  return path;
}

export function getSubcommandArgs(commandPath: string[]): string[] {
  const argv = process.argv.slice(2);
  for (let i = 0; i <= argv.length - commandPath.length; i++) {
    let isMatch = true;
    for (let j = 0; j < commandPath.length; j++) {
      if (argv[i + j] !== commandPath[j]) {
        isMatch = false;
        break;
      }
    }
    if (isMatch) {
      return argv.slice(i + commandPath.length);
    }
  }
  return [];
}

export interface ApiConfig {
  apiUrl: string;
  headers: Record<string, string>;
}

export function getApiConfig(): ApiConfig {
  const apiPort = process.env.COLEO_API_PORT || "8080";
  const apiHost = process.env.COLEO_API_HOST || "localhost";
  const apiKey = process.env.COLEO_API_KEY;
  const apiUrl = `http://${apiHost}:${apiPort}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
  }

  return { apiUrl, headers };
}

export async function isApiRunning(): Promise<boolean> {
  const { apiUrl } = getApiConfig();
  try {
    const res = await fetch(`${apiUrl}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}
