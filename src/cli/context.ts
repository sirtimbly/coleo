import { file } from "bun";
import { homedir } from "os";
import { dirname, join } from "path";
import { realpathSync } from "fs";
import { fileURLToPath } from "url";
import { loadEnvFile } from "../config/env";

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

export { loadEnvFile };

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
