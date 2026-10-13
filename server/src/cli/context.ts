import { file } from "bun";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { existsSync, realpathSync } from "fs";
import { fileURLToPath } from "url";
import { loadEnvFile } from "../config/env";
import { resolveApiKey, resolveApiUrl } from "../network-config";

// Re-export getColeoDir from config to ensure single source of truth
export { getColeoDir } from "../config";

const __dirname = dirname(realpathSync(fileURLToPath(import.meta.url)));

function getBaseDirs(): string[] {
  const dirs: string[] = [__dirname];
  if (process.argv[1]) {
    dirs.push(dirname(resolve(process.argv[1])));
  }
  return Array.from(new Set(dirs));
}

function resolveExistingDir(candidates: string[], requiredRelative?: string): string {
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    if (!requiredRelative || existsSync(join(candidate, requiredRelative))) {
      return candidate;
    }
  }
  return candidates[0] ?? "";
}

export function resolveTemplatesDir(): string {
  const candidates: string[] = [];
  for (const baseDir of getBaseDirs()) {
    candidates.push(join(baseDir, "..", "templates"));
    candidates.push(join(baseDir, "..", "..", "templates"));
  }
  return resolveExistingDir(candidates, join("arms", "default.toml"));
}

export const TEMPLATES_DIR = resolveTemplatesDir();

/**
 * Get the path to brain templates in the installed package
 * This resolves relative to the compiled CLI location
 */
export function getBrainTemplatesDir(): string {
  const candidates: string[] = [];
  for (const baseDir of getBaseDirs()) {
    candidates.push(join(baseDir, "..", "brain", "templates"));
    candidates.push(join(baseDir, "..", "src", "brain", "templates"));
  }
  return resolveExistingDir(candidates, "initial-arm-prompt.jinja");
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
  const apiKey = resolveApiKey();
  const apiUrl = resolveApiUrl();

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
