/**
 * OpenCode Integration Routes
 *
 * The provider/model dropdowns in the web UI are driven from a cached catalog
 * under `.coleo/cache/opencode-models.json`. The cache is refreshed from the
 * local `opencode` CLI, not from a live OpenCode HTTP server, so the UI reflects
 * authenticated providers on this machine.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

import { getColeoDir } from "../../config";

interface OpenCodeContext {
  Variables: {
    db: Database;
  };
}

const OPENCODE_DEFAULT_PORT = 4096;
const OPENCODE_DEFAULT_HOST = "127.0.0.1";
const execFileAsync = promisify(execFile);

interface OpenCodeModel {
  id: string;
  name: string;
  limit?: {
    context?: number;
    output?: number;
  };
  modalities?: {
    input: Array<"text" | "audio" | "image" | "video" | "pdf">;
    output: Array<"text" | "audio" | "image" | "video" | "pdf">;
  };
}

interface OpenCodeProvider {
  id: string;
  name: string;
  models: OpenCodeModel[];
}

interface OpenCodeProvidersCache {
  fetchedAt: string;
  providers: OpenCodeProvider[];
  connected: string[];
  default: Record<string, string>;
}

function getOpenCodeModelsCachePath(): string {
  return join(getColeoDir(), "cache", "opencode-models.json");
}

function getOpenCodeAuthFilePath(): string {
  const home = process.env.HOME || homedir();
  return join(home, ".local", "share", "opencode", "auth.json");
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function humanizeIdentifier(value: string): string {
  return value
    .split(/[-_/]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getEnvironmentAuthenticatedProviders(): string[] {
  const envToProvider = {
    ANTHROPIC_API_KEY: "anthropic",
    CEREBRAS_API_KEY: "cerebras",
    DEEPINFRA_API_KEY: "deepinfra",
    FRIENDLI_API_KEY: "friendli",
    GOOGLE_API_KEY: "google",
    GROQ_API_KEY: "groq",
    KIMI_FOR_CODING_API_KEY: "kimi-for-coding",
    MOONSHOTAI_API_KEY: "moonshotai",
    OPENAI_API_KEY: "openai",
    OPENROUTER_API_KEY: "openrouter",
    OPENCODE_API_KEY: "opencode",
    PERPLEXITY_API_KEY: "perplexity",
    XAI_API_KEY: "xai",
  } as const;

  return Object.entries(envToProvider)
    .filter(([envName]) => Boolean(process.env[envName]?.trim()))
    .map(([, providerId]) => providerId);
}

export async function getLocallyAuthenticatedProviders(): Promise<string[]> {
  const providerIds = new Set<string>(getEnvironmentAuthenticatedProviders());

  try {
    const content = await readFile(getOpenCodeAuthFilePath(), "utf8");
    const auth = JSON.parse(content) as Record<string, unknown>;
    for (const providerId of Object.keys(auth)) {
      if (providerId.trim()) {
        providerIds.add(providerId);
      }
    }
  } catch {
    // Missing auth file is acceptable; env vars may still provide auth.
  }

  return [...providerIds].sort((a, b) => a.localeCompare(b));
}

function parseOpencodeModelsOutput(
  output: string,
  authenticatedProviderIds: string[],
): OpenCodeProvider[] {
  const allowedProviders = new Set(authenticatedProviderIds);
  const providerModels = new Map<string, Set<string>>();

  for (const rawLine of output.split(/\r?\n/g)) {
    const line = stripAnsi(rawLine).trim();
    if (!line || !line.includes("/")) {
      continue;
    }

    const separatorIndex = line.indexOf("/");
    const providerId = line.slice(0, separatorIndex).trim();
    const modelId = line.slice(separatorIndex + 1).trim();

    if (!providerId || !modelId) {
      continue;
    }
    if (allowedProviders.size > 0 && !allowedProviders.has(providerId)) {
      continue;
    }

    let models = providerModels.get(providerId);
    if (!models) {
      models = new Set<string>();
      providerModels.set(providerId, models);
    }
    models.add(modelId);
  }

  return [...providerModels.entries()]
    .map(([providerId, models]) => ({
      id: providerId,
      name: humanizeIdentifier(providerId),
      models: [...models]
        .sort((a, b) => a.localeCompare(b))
        .map((modelId) => ({
          id: modelId,
          name: modelId,
        })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function writeOpenCodeProvidersCache(
  cache: OpenCodeProvidersCache,
): Promise<void> {
  await mkdir(join(getColeoDir(), "cache"), { recursive: true });
  await writeFile(getOpenCodeModelsCachePath(), JSON.stringify(cache, null, 2), "utf8");
}

export async function readOpenCodeProvidersCache(): Promise<OpenCodeProvidersCache | null> {
  try {
    const content = await readFile(getOpenCodeModelsCachePath(), "utf8");
    const parsed = JSON.parse(content) as Partial<OpenCodeProvidersCache>;

    if (!Array.isArray(parsed.providers)) {
      return null;
    }

    return {
      fetchedAt: parsed.fetchedAt || new Date(0).toISOString(),
      providers: parsed.providers as OpenCodeProvider[],
      connected: Array.isArray(parsed.connected) ? parsed.connected : [],
      default:
        parsed.default && typeof parsed.default === "object"
          ? (parsed.default as Record<string, string>)
          : {},
    };
  } catch {
    return null;
  }
}

export async function refreshOpenCodeProvidersCache(): Promise<OpenCodeProvidersCache | null> {
  const connected = await getLocallyAuthenticatedProviders();
  if (connected.length === 0) {
    return null;
  }

  const { stdout } = await execFileAsync("opencode", ["models"], {
    env: process.env,
    maxBuffer: 1024 * 1024 * 8,
  });

  const providers = parseOpencodeModelsOutput(stdout, connected);
  const cache: OpenCodeProvidersCache = {
    fetchedAt: new Date().toISOString(),
    providers,
    connected,
    default: {},
  };

  await writeOpenCodeProvidersCache(cache);
  return cache;
}

async function findOpenCodeServer(): Promise<string | null> {
  const ports = [OPENCODE_DEFAULT_PORT, 4097, 4098, 4099];

  for (const port of ports) {
    try {
      const url = `http://${OPENCODE_DEFAULT_HOST}:${port}/global/health`;
      const response = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        return `http://${OPENCODE_DEFAULT_HOST}:${port}`;
      }
    } catch {
      // Try next port
    }
  }

  return null;
}

export function createOpenCodeRoutes() {
  const app = new Hono<OpenCodeContext>();

  /**
   * Get available providers/models from the cached authenticated catalog.
   * GET /api/opencode/providers
   */
  app.get("/providers", async (c) => {
    try {
      const cached = await readOpenCodeProvidersCache();
      const locallyAuthenticatedProviders = await getLocallyAuthenticatedProviders();

      if (!cached) {
        return c.json({
          providers: [] as OpenCodeProvider[],
          connected: locallyAuthenticatedProviders,
          cached: false,
          source: "fallback",
          message:
            "No cached OpenCode model catalog yet. Spawn an OpenCode arm to populate .coleo/cache/opencode-models.json.",
        });
      }

      return c.json({
        providers: cached.providers,
        connected: cached.connected.length > 0 ? cached.connected : locallyAuthenticatedProviders,
        default: cached.default,
        cached: true,
        cachedAt: cached.fetchedAt,
        source: "cache",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const locallyAuthenticatedProviders = await getLocallyAuthenticatedProviders();

      return c.json({
        providers: [] as OpenCodeProvider[],
        connected: locallyAuthenticatedProviders,
        error: message,
        fallback: true,
        source: "fallback",
      });
    }
  });

  /**
   * Check if OpenCode server is running
   * GET /api/opencode/health
   */
  app.get("/health", async (c) => {
    try {
      const serverUrl = await findOpenCodeServer();

      if (!serverUrl) {
        return c.json({
          running: false,
          message: "OpenCode server not found",
        });
      }

      const response = await fetch(`${serverUrl}/global/health`, {
        signal: AbortSignal.timeout(2000),
      });

      const data = (await response.json()) as { healthy: boolean; version: string };

      return c.json({
        running: true,
        healthy: data.healthy,
        version: data.version,
        url: serverUrl,
      });
    } catch (err) {
      return c.json({
        running: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return app;
}
