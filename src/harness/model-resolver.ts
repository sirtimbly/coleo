/**
 * Model Resolver for Coleo Harnesses
 * 
 * Handles model validation and fallback when the requested model
 * is not available. Resolution order:
 * 
 * 1. Try the requested provider/model
 * 2. If model not found, find cheapest model from same provider
 * 3. If provider not available, find same model from another provider the user has access to
 * 4. If all else fails, use the first available model from any connected provider
 */

import { resolveApiKey, resolveApiUrl } from "../network-config";

export interface ModelInfo {
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
  // Price per million tokens (input/output)
  pricing?: {
    input?: number;
    output?: number;
  };
}

export interface ProviderInfo {
  id: string;
  name: string;
  models: ModelInfo[];
}

export interface ProvidersResponse {
  providers: ProviderInfo[];
  connected: string[];
  fallback?: boolean;
  error?: string;
}

export interface ResolvedModel {
  providerId: string;
  modelId: string;
  providerName: string;
  modelName: string;
  fallback: boolean;
  fallbackReason?: string;
}

// Known model pricing (per million tokens, approximate)
// This is used when pricing info isn't available from the API
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Claude models
  "gpt-5.1-codex-mini": { input: 3, output: 15 },
  "claude-opus-4": { input: 15, output: 75 },
  "claude-3-5-sonnet": { input: 3, output: 15 },
  "claude-3-opus": { input: 15, output: 75 },
  
  // GPT models
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4-turbo": { input: 10, output: 30 },
  "o1": { input: 15, output: 60 },
  "o1-mini": { input: 3, output: 12 },
  "o3-mini": { input: 1.1, output: 4.4 },
  
  // Gemini models
  "gemini-2.5-pro": { input: 1.25, output: 5 },
  "gemini-2.5-flash": { input: 0.075, output: 0.3 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  
  // Default for unknown models
  "default": { input: 5, output: 20 },
};

/**
 * Get the estimated cost for a model (input + output per million tokens)
 */
function getModelCost(model: ModelInfo): number {
  if (model.pricing) {
    return (model.pricing.input ?? 0) + (model.pricing.output ?? 0);
  }
  
  // Look up by model ID, fallback to default pricing
  const pricing = MODEL_PRICING[model.id] ?? MODEL_PRICING["default"]!;
  return pricing.input + pricing.output;
}

/**
 * Find the cheapest model from a provider
 */
function findCheapestModel(provider: ProviderInfo): ModelInfo | null {
  if (!provider.models || provider.models.length === 0) {
    return null;
  }
  
  return provider.models.reduce((cheapest, model) => {
    if (!cheapest) return model;
    return getModelCost(model) < getModelCost(cheapest) ? model : cheapest;
  }, null as ModelInfo | null);
}

/**
 * Find a model by ID across all providers
 */
function findModelAcrossProviders(
  providers: ProviderInfo[],
  modelId: string,
  connectedProviders: string[],
  excludeProvider?: string
): { provider: ProviderInfo; model: ModelInfo } | null {
  for (const provider of providers) {
    // Skip excluded provider
    if (excludeProvider && provider.id === excludeProvider) continue;
    
    // Prefer connected providers
    if (!connectedProviders.includes(provider.id)) continue;
    
    const model = provider.models.find(m => m.id === modelId);
    if (model) {
      return { provider, model };
    }
  }
  
  // Try non-connected providers as last resort
  for (const provider of providers) {
    if (excludeProvider && provider.id === excludeProvider) continue;
    
    const model = provider.models.find(m => m.id === modelId);
    if (model) {
      return { provider, model };
    }
  }
  
  return null;
}

/**
 * Get the first available model from any connected provider
 */
function getFirstAvailableModel(
  providers: ProviderInfo[],
  connectedProviders: string[]
): { provider: ProviderInfo; model: ModelInfo } | null {
  // First try connected providers
  for (const provider of providers) {
    const firstModel = provider.models[0];
    if (connectedProviders.includes(provider.id) && firstModel) {
      return { provider, model: firstModel };
    }
  }
  
  // Then try any provider with models
  for (const provider of providers) {
    const firstModel = provider.models[0];
    if (firstModel) {
      return { provider, model: firstModel };
    }
  }
  
  return null;
}

/**
 * Fetch available providers and models from the API
 */
export async function fetchProviders(apiUrl: string = resolveApiUrl()): Promise<ProvidersResponse> {
  try {
    const apiKey = resolveApiKey();
    const response = await fetch(`${apiUrl}/api/opencode/providers`, {
      signal: AbortSignal.timeout(5000),
      headers: apiKey ? { "X-API-Key": apiKey } : undefined,
    });
    
    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }
    
    return await response.json() as ProvidersResponse;
  } catch (err) {
    console.error("[model-resolver] Failed to fetch providers:", err);
    return {
      providers: [],
      connected: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function supportsInputModality(
  providerId: string | null | undefined,
  modelId: string | null | undefined,
  modality: "text" | "audio" | "image" | "video" | "pdf",
  apiUrl: string = resolveApiUrl(),
): Promise<boolean | null> {
  if (!providerId || !modelId) {
    return null;
  }

  const data = await fetchProviders(apiUrl);
  const provider = data.providers.find((entry) => entry.id === providerId);
  const model = provider?.models.find((entry) => entry.id === modelId);
  if (!model?.modalities?.input) {
    return null;
  }

  return model.modalities.input.includes(modality);
}

/**
 * Resolve a model to an available provider/model combination
 * 
 * @param requestedProvider - The requested provider ID
 * @param requestedModel - The requested model ID
 * @param apiUrl - The API server URL (defaults to Coleo's configured API endpoint)
 * @returns Resolved model info with fallback details
 */
export async function resolveModel(
  requestedProvider: string,
  requestedModel: string,
  apiUrl: string = resolveApiUrl()
): Promise<ResolvedModel> {
  const data = await fetchProviders(apiUrl);
  
  if (data.providers.length === 0) {
    // No providers available, return original request
    console.warn("[model-resolver] No providers available, using original request");
    return {
      providerId: requestedProvider,
      modelId: requestedModel,
      providerName: requestedProvider,
      modelName: requestedModel,
      fallback: false,
    };
  }
  
  // Find the requested provider
  const requestedProviderInfo = data.providers.find(p => p.id === requestedProvider);
  
  // Step 1: Try the exact requested provider/model
  if (requestedProviderInfo) {
    const exactModel = requestedProviderInfo.models.find(m => m.id === requestedModel);
    if (exactModel) {
      console.log(`[model-resolver] Using exact match: ${requestedProvider}/${requestedModel}`);
      return {
        providerId: requestedProvider,
        modelId: requestedModel,
        providerName: requestedProviderInfo.name,
        modelName: exactModel.name,
        fallback: false,
      };
    }
    
    // Step 2: Model not found in provider, find cheapest alternative from same provider
    const cheapestModel = findCheapestModel(requestedProviderInfo);
    if (cheapestModel) {
      console.log(
        `[model-resolver] Model "${requestedModel}" not found in ${requestedProvider}, ` +
        `falling back to cheapest: ${cheapestModel.id}`
      );
      return {
        providerId: requestedProvider,
        modelId: cheapestModel.id,
        providerName: requestedProviderInfo.name,
        modelName: cheapestModel.name,
        fallback: true,
        fallbackReason: `Model "${requestedModel}" not available in ${requestedProviderInfo.name}, using cheapest alternative`,
      };
    }
  }
  
  // Step 3: Provider not available or has no models, try to find same model from another provider
  const altProvider = findModelAcrossProviders(
    data.providers,
    requestedModel,
    data.connected,
    requestedProvider
  );
  
  if (altProvider) {
    console.log(
      `[model-resolver] Provider "${requestedProvider}" not available, ` +
      `found model "${requestedModel}" in ${altProvider.provider.id}`
    );
    return {
      providerId: altProvider.provider.id,
      modelId: requestedModel,
      providerName: altProvider.provider.name,
      modelName: altProvider.model.name,
      fallback: true,
      fallbackReason: `Provider "${requestedProvider}" not available, using ${altProvider.provider.name}`,
    };
  }
  
  // Step 4: Last resort - use first available model from any connected provider
  const firstAvailable = getFirstAvailableModel(data.providers, data.connected);
  
  if (firstAvailable) {
    console.log(
      `[model-resolver] Neither provider "${requestedProvider}" nor model "${requestedModel}" available, ` +
      `falling back to ${firstAvailable.provider.id}/${firstAvailable.model.id}`
    );
    return {
      providerId: firstAvailable.provider.id,
      modelId: firstAvailable.model.id,
      providerName: firstAvailable.provider.name,
      modelName: firstAvailable.model.name,
      fallback: true,
      fallbackReason: `Neither provider "${requestedProvider}" nor model "${requestedModel}" available`,
    };
  }
  
  // No fallback available, return original request and let it fail at runtime
  console.warn("[model-resolver] No fallback available, using original request");
  return {
    providerId: requestedProvider,
    modelId: requestedModel,
    providerName: requestedProvider,
    modelName: requestedModel,
    fallback: false,
  };
}

/**
 * Validate that a provider/model combination is available
 * 
 * @param providerId - The provider ID to check
 * @param modelId - The model ID to check
 * @param apiUrl - The API server URL
 * @returns True if the model is available, false otherwise
 */
export async function isModelAvailable(
  providerId: string,
  modelId: string,
  apiUrl: string = resolveApiUrl()
): Promise<boolean> {
  const data = await fetchProviders(apiUrl);
  
  const provider = data.providers.find(p => p.id === providerId);
  if (!provider) return false;
  
  return provider.models.some(m => m.id === modelId);
}

/**
 * Get a list of all available models sorted by cost
 */
export async function getAvailableModelsByCost(
  apiUrl: string = resolveApiUrl()
): Promise<Array<{ providerId: string; modelId: string; cost: number }>> {
  const data = await fetchProviders(apiUrl);
  
  const models: Array<{ providerId: string; modelId: string; cost: number }> = [];
  
  for (const provider of data.providers) {
    for (const model of provider.models) {
      models.push({
        providerId: provider.id,
        modelId: model.id,
        cost: getModelCost(model),
      });
    }
  }
  
  return models.sort((a, b) => a.cost - b.cost);
}
