/**
 * Embedding Service
 * 
 * Main entry point for generating embeddings.
 * Automatically selects provider based on configuration.
 * 
 * Usage:
 * ```typescript
 * import { embeddingService } from "./embedding";
 * 
 * // Generate single embedding
 * const result = await embeddingService.embed("Hello world");
 * console.log(result.embedding); // number[]
 * 
 * // Generate batch embeddings
 * const batchResult = await embeddingService.embedBatch(["text1", "text2"]);
 * console.log(batchResult.embeddings); // number[][]
 * ```
 */

import { OpenAIEmbeddingProvider } from "./openai-provider";
import { LocalEmbeddingProvider } from "./local-provider";
import type { EmbeddingConfig, EmbeddingOptions, EmbeddingResult, BatchEmbeddingResult } from "./types";

export class EmbeddingService {
	private provider: OpenAIEmbeddingProvider | LocalEmbeddingProvider | null = null;
	private config: EmbeddingConfig;

	constructor(config?: EmbeddingConfig) {
		this.config = config || this.detectConfig();
		this.initializeProvider();
	}

	/**
	 * Auto-detect configuration from environment variables
	 */
	private detectConfig(): EmbeddingConfig {
		// Check for OpenAI API key first
		if (process.env.OPENAI_API_KEY) {
			return {
				provider: "openai",
				apiKey: process.env.OPENAI_API_KEY,
				baseUrl: process.env.OPENAI_BASE_URL,
				model: process.env.OPENAI_EMBEDDING_MODEL,
			};
		}

		// Fall back to local provider
		return {
			provider: "local",
			localModel: process.env.LOCAL_EMBEDDING_MODEL,
		};
	}

	/**
	 * Initialize the appropriate provider based on config
	 */
	private initializeProvider(): void {
		switch (this.config.provider) {
			case "openai":
				this.provider = new OpenAIEmbeddingProvider(
					this.config.apiKey,
					this.config.baseUrl,
				);
				break;
			case "local":
			default:
				this.provider = new LocalEmbeddingProvider(this.config.localModel);
				break;
		}
	}

	/**
	 * Get the current provider name
	 */
	getProviderName(): string {
		return this.provider?.name || "unknown";
	}

	/**
	 * Get the current model name
	 */
	getModel(): string {
		return this.config.model || this.provider?.defaultModel || "unknown";
	}

	/**
	 * Get the vector size for the current model
	 */
	getVectorSize(): number {
		return this.provider?.vectorSize || 1536;
	}

	/**
	 * Generate embedding for a single text
	 */
	async embed(text: string, options?: EmbeddingOptions): Promise<EmbeddingResult> {
		if (!this.provider) {
			throw new Error("Embedding provider not initialized");
		}
		return this.provider.embed(text, options);
	}

	/**
	 * Generate embeddings for multiple texts
	 */
	async embedBatch(texts: string[], options?: EmbeddingOptions): Promise<BatchEmbeddingResult> {
		if (!this.provider) {
			throw new Error("Embedding provider not initialized");
		}
		return this.provider.embedBatch(texts, options);
	}

	/**
	 * Update configuration and reinitialize provider
	 */
	updateConfig(config: Partial<EmbeddingConfig>): void {
		this.config = { ...this.config, ...config };
		this.initializeProvider();
	}
}

// Export singleton instance
export const embeddingService = new EmbeddingService();

// Re-export types
export type { EmbeddingConfig, EmbeddingOptions, EmbeddingResult, BatchEmbeddingResult } from "./types";
export { OpenAIEmbeddingProvider } from "./openai-provider";
export { LocalEmbeddingProvider } from "./local-provider";
