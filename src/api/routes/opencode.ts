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
import { getArmClient } from "../arm-client-registry";
import { HttpError } from "../middleware";

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
  /**
   * Estimated cost index for the model: sum of input and output price per
   * million tokens (USD). Useful for comparing relative model expense in the UI.
   */
  cost?: number;
  /**
   * Detailed per-million-token pricing when available.
   */
  pricing?: {
    input?: number;
    output?: number;
  };
}

// Known approximate pricing (USD per million tokens). Used when the OpenCode
// CLI catalog does not include pricing metadata.
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Claude / Anthropic
  "claude-opus-4": { input: 15, output: 75 },
  "claude-3-5-sonnet": { input: 3, output: 15 },
  "claude-3-opus": { input: 15, output: 75 },
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-opus-4-20250514": { input: 15, output: 75 },

  // OpenAI
  "gpt-5.1-codex-mini": { input: 3, output: 15 },
  "gpt-5.1-codex": { input: 3, output: 15 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4-turbo": { input: 10, output: 30 },
  "o1": { input: 15, output: 60 },
  "o1-mini": { input: 3, output: 12 },
  "o3-mini": { input: 1.1, output: 4.4 },
  "openai/gpt-oss-120b": { input: 0, output: 0 },
  "openai/gpt-oss-20b": { input: 0, output: 0 },

  // Google / Gemini
  "gemini-2.5-pro": { input: 1.25, output: 5 },
  "gemini-2.5-flash": { input: 0.075, output: 0.3 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-2.5-flash-thinking": { input: 0.075, output: 0.3 },

  // DeepSeek
  "deepseek-ai/DeepSeek-R1-0528": { input: 0.55, output: 2.19 },
  "deepseek-ai/DeepSeek-V3.2": { input: 0.27, output: 1.1 },
  "deepseek-ai/DeepSeek-V4-Flash": { input: 0.1, output: 0.4 },
  "deepseek-ai/DeepSeek-V4-Pro": { input: 0.5, output: 2 },

  // Meta
  "meta-llama/Llama-3.3-70B-Instruct-Turbo": { input: 0.2, output: 0.4 },
  "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8": { input: 0.2, output: 0.8 },
  "meta-llama/Llama-4-Scout-17B-16E-Instruct": { input: 0.15, output: 0.6 },

  // Kimi / Moonshot
  "moonshotai/Kimi-K2.5": { input: 1.2, output: 6 },
  "moonshotai/Kimi-K2.6": { input: 1.2, output: 6 },
  "moonshotai/Kimi-K2.7-Code": { input: 1.2, output: 6 },
  "kimi-for-coding/kimi-k2.5": { input: 1.2, output: 6 },

  // Alibaba
  "Qwen/Qwen3-32B": { input: 0.1, output: 0.3 },
  "Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo": { input: 0.8, output: 2.4 },

  // Default fallback
  default: { input: 5, output: 20 },
};

function getModelPricing(modelId: string): { input: number; output: number } {
  return MODEL_PRICING[modelId] ?? MODEL_PRICING.default!;
}

function enrichModelWithPricing(model: OpenCodeModel): OpenCodeModel {
  if (model.pricing) {
    const inputPrice =
      typeof model.pricing.input === "number" && Number.isFinite(model.pricing.input)
        ? model.pricing.input
        : 0;
    const outputPrice =
      typeof model.pricing.output === "number" && Number.isFinite(model.pricing.output)
        ? model.pricing.output
        : 0;

    if (typeof model.cost === "number") {
      return model;
    }

    return {
      ...model,
      cost: inputPrice + outputPrice,
    };
  }

  const pricing = getModelPricing(model.id);
  return {
    ...model,
    pricing,
    cost: pricing.input + pricing.output,
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
        .map((modelId) => enrichModelWithPricing({
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
      providers: (parsed.providers as OpenCodeProvider[]).map((provider) => ({
        ...provider,
        models: provider.models.map(enrichModelWithPricing),
      })),
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
   * List every provider installed in OpenCode on a selected arm host.
   * GET /api/opencode/agents/:agentId/providers
   */
  app.get("/agents/:agentId/providers", async (c) => {
    const armClient = getArmClient();
    if (!armClient) {
      throw new HttpError(503, "Arm host connection is not available");
    }

    const agentId = c.req.param("agentId");
    const agent = armClient.getAgent(agentId);
    if (!agent) {
      throw new HttpError(404, `Arm host ${agentId} is not connected`);
    }
    if (!agent.capabilities.includes("opencode-provider-auth")) {
      throw new HttpError(409, "This arm host must be updated before providers can be configured");
    }

    const response = await armClient.getOpenCodeProviders(agentId);
    if (!response.success || !response.data) {
      throw new HttpError(502, response.error || "Unable to list OpenCode providers on the arm host");
    }
    return c.json(response.data);
  });

  /**
   * Store an API key in OpenCode's auth file on a selected arm host.
   * POST /api/opencode/agents/:agentId/providers/:providerId/api-key
   */
  app.post("/agents/:agentId/providers/:providerId/api-key", async (c) => {
    const armClient = getArmClient();
    if (!armClient) {
      throw new HttpError(503, "Arm host connection is not available");
    }

    const agentId = c.req.param("agentId");
    const providerId = c.req.param("providerId");
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(providerId)) {
      throw new HttpError(400, "Invalid OpenCode provider ID");
    }
    const body = await c.req.json<{ apiKey?: unknown }>();
    if (typeof body.apiKey !== "string" || !body.apiKey.trim()) {
      throw new HttpError(400, "API key is required");
    }

    const agent = armClient.getAgent(agentId);
    if (!agent) {
      throw new HttpError(404, `Arm host ${agentId} is not connected`);
    }
    if (!agent.capabilities.includes("opencode-provider-auth")) {
      throw new HttpError(409, "This arm host must be updated before providers can be configured");
    }

    const response = await armClient.setOpenCodeApiKey(agentId, providerId, body.apiKey);
    if (!response.success || !response.data) {
      throw new HttpError(502, response.error || "Unable to save the OpenCode API key");
    }
    return c.json(response.data);
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
