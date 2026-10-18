import type { ColeoConfig } from "../types";

export interface BrainModelConfig {
	provider: string;
	model: string;
	apiKey: string;
	baseUrl: string;
}

export interface BrainModel {
	id: string;
	name: string;
}

export type BrainModelConfigSource =
	| BrainModelConfig
	| (() => BrainModelConfig | Promise<BrainModelConfig>);

type BrainModelFetch = (input: string, init?: RequestInit) => Promise<Response>;

export function resolveBrainModelConfig(
	config?: Pick<ColeoConfig["brain"], "provider" | "model" | "apiKey">,
): BrainModelConfig {
	const provider = config?.provider || process.env.COLEO_BRAIN_PROVIDER || "openai";

	return {
		provider,
		model: config?.model || process.env.COLEO_BRAIN_MODEL || process.env.OPENAI_MODEL || "gpt-5.6-luna",
		apiKey: config?.apiKey || process.env.COLEO_BRAIN_API_KEY || process.env.OPENAI_API_KEY || "",
		baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
	};
}

export async function resolveBrainModelConfigSource(
	source?: BrainModelConfigSource,
): Promise<BrainModelConfig> {
	if (typeof source === "function") {
		return source();
	}
	return source || resolveBrainModelConfig();
}

export async function listBrainModels(
	config: BrainModelConfig,
	fetchFn: BrainModelFetch = fetch,
): Promise<BrainModel[]> {
	if (config.provider !== "openai") {
		throw new Error(`Model discovery is not available for provider "${config.provider}"`);
	}
	if (!config.apiKey) {
		throw new Error("Configure the brain provider API key before loading models");
	}

	const response = await fetchFn(`${config.baseUrl}/models`, {
		headers: {
			Authorization: `Bearer ${config.apiKey}`,
		},
	});
	if (!response.ok) {
		const message = await response.text();
		throw new Error(`Provider returned ${response.status}: ${message.slice(0, 200)}`);
	}

	const payload = await response.json() as { data?: Array<{ id?: unknown }> };
	return (payload.data || [])
		.flatMap((item) => typeof item.id === "string" && item.id ? [{ id: item.id, name: item.id }] : [])
		.sort((left, right) => left.name.localeCompare(right.name));
}
