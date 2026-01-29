/**
 * Model Selection Module
 *
 * Provides utilities for selecting AI models from a configurable list
 * of preferred provider/model pairs. Supports random selection for
 * model diversity across arms.
 *
 * Configuration via environment variable:
 *   OCTOPAI_PREFERRED_MODELS="provider/model,provider/model,..."
 *
 * Example:
 *   OCTOPAI_PREFERRED_MODELS="openai/gpt-5.1-codex-mini,openai/gpt-4o,opencode-zen/o4-mini"
 */

export interface ModelSpec {
  provider: string;
  model: string;
}

/**
 * Parse a "provider/model" string into a ModelSpec object
 * Returns null if the format is invalid
 */
export function parseModelSpec(spec: string): ModelSpec | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;

  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    // No slash, or slash at start/end
    return null;
  }

  return {
    provider: trimmed.slice(0, slashIndex),
    model: trimmed.slice(slashIndex + 1),
  };
}

/**
 * Get the list of preferred models from environment
 * Returns an empty array if OCTOPAI_PREFERRED_MODELS is not set or invalid
 */
export function getPreferredModels(): ModelSpec[] {
  const envValue = process.env.OCTOPAI_PREFERRED_MODELS;
  if (!envValue) {
    return [];
  }

  const specs: ModelSpec[] = [];
  const parts = envValue.split(",");

  for (const part of parts) {
    const spec = parseModelSpec(part);
    if (spec) {
      specs.push(spec);
    }
  }

  return specs;
}

/**
 * Get a random model from the preferred models list
 * Returns null if no preferred models are configured
 */
export function getRandomPreferredModel(): ModelSpec | null {
  const models = getPreferredModels();
  if (models.length === 0) {
    return null;
  }

  const index = Math.floor(Math.random() * models.length);
  return models[index] ?? null;
}

/**
 * Format a ModelSpec back to "provider/model" string
 */
export function formatModelSpec(spec: ModelSpec): string {
  return `${spec.provider}/${spec.model}`;
}
