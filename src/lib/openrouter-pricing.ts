import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

import { getColeoDir } from "../config";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface OpenRouterModelPrice {
  id: string;
  canonicalSlug?: string;
  input: number;
  output: number;
}

export interface OpenRouterPricingCatalog {
  fetchedAt: string;
  models: OpenRouterModelPrice[];
}

export interface OpenRouterPricingEstimate {
  input: number;
  output: number;
  source: "openrouter";
  estimated: true;
  fetchedAt: string;
  matchedModel: string;
}

const PROVIDER_ALIASES: Record<string, string> = {
  xai: "x-ai",
};

const MARKET_PROXY_PROVIDERS = new Set([
  "github-copilot",
  "kilo",
  "opencode",
]);

const catalogPromises = new Map<string, Promise<OpenRouterPricingCatalog | null>>();

function parseTokenPrice(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1_000_000 : null;
}

export function parseOpenRouterPricingCatalog(
  payload: unknown,
  fetchedAt = new Date().toISOString(),
): OpenRouterPricingCatalog {
  const data = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as { data?: unknown }).data
    : undefined;
  const models: OpenRouterModelPrice[] = [];

  if (Array.isArray(data)) {
    for (const entry of data) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const pricing = record.pricing && typeof record.pricing === "object" && !Array.isArray(record.pricing)
        ? record.pricing as Record<string, unknown>
        : null;
      const id = typeof record.id === "string" ? record.id : null;
      const input = parseTokenPrice(pricing?.prompt);
      const output = parseTokenPrice(pricing?.completion);
      if (!id || input === null || output === null) continue;
      models.push({
        id,
        canonicalSlug: typeof record.canonical_slug === "string" ? record.canonical_slug : undefined,
        input,
        output,
      });
    }
  }

  return { fetchedAt, models };
}

function inferModelOwner(modelId: string): string | null {
  if (/^(gpt-|o[134](?:-|$))/.test(modelId)) return "openai";
  if (modelId.startsWith("claude-")) return "anthropic";
  if (modelId.startsWith("gemini-")) return "google";
  if (modelId.startsWith("deepseek-")) return "deepseek";
  if (modelId.startsWith("grok-")) return "x-ai";
  if (modelId.toLowerCase().startsWith("qwen")) return "qwen";
  return null;
}

export function resolveOpenRouterPricing(
  catalog: OpenRouterPricingCatalog | null,
  providerId: string,
  modelId: string,
): OpenRouterPricingEstimate | undefined {
  if (!catalog) return undefined;
  const candidates = new Set<string>();
  if (modelId.includes("/")) candidates.add(modelId);
  candidates.add(`${PROVIDER_ALIASES[providerId] ?? providerId}/${modelId}`);
  if (MARKET_PROXY_PROVIDERS.has(providerId)) {
    const owner = inferModelOwner(modelId);
    if (owner) candidates.add(`${owner}/${modelId}`);
  }

  const match = catalog.models.find((model) =>
    candidates.has(model.id) || Boolean(model.canonicalSlug && candidates.has(model.canonicalSlug))
  );
  if (!match) return undefined;
  return {
    input: match.input,
    output: match.output,
    source: "openrouter",
    estimated: true,
    fetchedAt: catalog.fetchedAt,
    matchedModel: match.id,
  };
}

async function readCachedCatalog(cachePath: string): Promise<OpenRouterPricingCatalog | null> {
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as OpenRouterPricingCatalog;
    if (!Array.isArray(parsed.models) || typeof parsed.fetchedAt !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function getOpenRouterPricingCatalog(): Promise<OpenRouterPricingCatalog | null> {
  const cacheDir = join(getColeoDir(), "cache");
  const cachePath = join(cacheDir, "openrouter-pricing.json");
  const existing = catalogPromises.get(cachePath);
  if (existing) return existing;

  const promise = (async () => {
    const cached = await readCachedCatalog(cachePath);
    const cachedAt = cached ? new Date(cached.fetchedAt).getTime() : 0;
    if (cached && Number.isFinite(cachedAt) && Date.now() - cachedAt < CACHE_TTL_MS) {
      return cached;
    }

    try {
      const response = await fetch(OPENROUTER_MODELS_URL, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`OpenRouter models returned ${response.status}`);
      const catalog = parseOpenRouterPricingCatalog(await response.json());
      await mkdir(cacheDir, { recursive: true });
      await writeFile(cachePath, JSON.stringify(catalog, null, 2), "utf8");
      return catalog;
    } catch {
      return cached;
    }
  })();

  catalogPromises.set(cachePath, promise);
  try {
    return await promise;
  } finally {
    catalogPromises.delete(cachePath);
  }
}
