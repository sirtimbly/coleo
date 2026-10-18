/**
 * OpenAI Embedding Provider
 * 
 * Generates embeddings using OpenAI's embedding API.
 * Supports text-embedding-3-small, text-embedding-3-large, and text-embedding-ada-002.
 */

import type { EmbeddingOptions, EmbeddingResult, BatchEmbeddingResult, EmbeddingProvider } from "./types";

interface OpenAIEmbeddingResponse {
	object: string;
	data: Array<{
		object: string;
		embedding: number[];
		index: number;
	}>;
	model: string;
	usage: {
		prompt_tokens: number;
		total_tokens: number;
	};
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
	readonly name = "openai";
	readonly defaultModel = "text-embedding-3-small";

	private apiKey: string;
	private baseUrl: string;
	private model: string;

	constructor(apiKey?: string, baseUrl?: string, model?: string) {
		this.apiKey = apiKey || process.env.OPENAI_API_KEY || "";
		this.baseUrl = baseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
		this.model = model || process.env.OPENAI_EMBEDDING_MODEL || this.defaultModel;

		if (!this.apiKey) {
			console.warn("[OpenAI Embedding] No API key provided. Set OPENAI_API_KEY environment variable.");
		}
	}

	get vectorSize(): number {
		return this.getVectorSize(this.model);
	}

	private getVectorSize(model: string): number {
		switch (model) {
			case "text-embedding-3-small":
				return 1536;
			case "text-embedding-3-large":
				return 3072;
			case "text-embedding-ada-002":
				return 1536;
			default:
				return 1536;
		}
	}

	async embed(text: string, options?: EmbeddingOptions): Promise<EmbeddingResult> {
		if (!this.apiKey) {
			throw new Error("OpenAI API key not configured. Set OPENAI_API_KEY environment variable.");
		}

		const model = options?.model || this.model;
		const timeout = options?.timeout || 30000;

		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), timeout);

			const response = await fetch(`${this.baseUrl}/embeddings`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Authorization": `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify({
					input: text,
					model: model,
				}),
				signal: controller.signal,
			});

			clearTimeout(timeoutId);

			if (!response.ok) {
				const error = await response.text();
				throw new Error(`OpenAI API error: ${response.status} - ${error}`);
			}

			const data = await response.json() as OpenAIEmbeddingResponse;

			if (!data.data[0]) {
				throw new Error("No embedding data returned from OpenAI API");
			}

			return {
				embedding: data.data[0].embedding,
				model: data.model,
				tokensUsed: data.usage.total_tokens,
			};
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") {
				throw new Error(`OpenAI embedding request timed out after ${timeout}ms`);
			}
			throw err;
		}
	}

	async embedBatch(texts: string[], options?: EmbeddingOptions): Promise<BatchEmbeddingResult> {
		if (!this.apiKey) {
			throw new Error("OpenAI API key not configured. Set OPENAI_API_KEY environment variable.");
		}

		if (texts.length === 0) {
			return { embeddings: [], model: options?.model || this.defaultModel };
		}

		const model = options?.model || this.model;
		const batchSize = options?.batchSize || 100; // OpenAI supports up to 2048, but we use smaller batches
		const timeout = options?.timeout || 60000;

		const embeddings: number[][] = [];
		let totalTokens = 0;

		// Process in batches
		for (let i = 0; i < texts.length; i += batchSize) {
			const batch = texts.slice(i, i + batchSize);

			try {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), timeout);

				const response = await fetch(`${this.baseUrl}/embeddings`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Authorization": `Bearer ${this.apiKey}`,
					},
					body: JSON.stringify({
						input: batch,
						model: model,
					}),
					signal: controller.signal,
				});

				clearTimeout(timeoutId);

				if (!response.ok) {
					const error = await response.text();
					throw new Error(`OpenAI API error: ${response.status} - ${error}`);
				}

				const data = await response.json() as OpenAIEmbeddingResponse;

				// Sort by index to maintain order
				const sortedData = data.data.sort((a, b) => a.index - b.index);
				embeddings.push(...sortedData.map((d) => d.embedding));
				totalTokens += data.usage.total_tokens;
			} catch (err) {
				if (err instanceof Error && err.name === "AbortError") {
					throw new Error(`OpenAI embedding batch request timed out after ${timeout}ms`);
				}
				throw err;
			}
		}

		return {
			embeddings,
			model,
			totalTokensUsed: totalTokens,
		};
	}
}
