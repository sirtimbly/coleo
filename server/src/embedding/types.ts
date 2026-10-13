/**
 * Embedding Service
 * 
 * Provides text-to-vector embedding generation using either:
 * - OpenAI API (text-embedding-3-small, text-embedding-3-large, etc.)
 * - Local embedding models via transformers.js or similar
 * 
 * Used for generating embeddings before storing in Qdrant vector store.
 */

export interface EmbeddingOptions {
	/** Model to use for embedding generation */
	model?: string;
	/** Maximum batch size for embedding requests */
	batchSize?: number;
	/** Timeout in milliseconds */
	timeout?: number;
}

export interface EmbeddingResult {
	/** The generated embedding vector */
	embedding: number[];
	/** The model used */
	model: string;
	/** Number of tokens used (if available) */
	tokensUsed?: number;
}

export interface BatchEmbeddingResult {
	/** Array of generated embeddings */
	embeddings: number[][];
	/** The model used */
	model: string;
	/** Total tokens used (if available) */
	totalTokensUsed?: number;
}

/**
 * Abstract base class for embedding providers
 */
export abstract class EmbeddingProvider {
	abstract readonly name: string;
	abstract readonly defaultModel: string;
	abstract readonly vectorSize: number;

	abstract embed(text: string, options?: EmbeddingOptions): Promise<EmbeddingResult>;
	abstract embedBatch(texts: string[], options?: EmbeddingOptions): Promise<BatchEmbeddingResult>;
}

/**
 * Configuration for embedding service
 */
export interface EmbeddingConfig {
	/** Provider type: 'openai' | 'local' | 'mock' */
	provider: "openai" | "local" | "mock";
	/** API key (for OpenAI) */
	apiKey?: string;
	/** Base URL for API (optional, for custom endpoints) */
	baseUrl?: string;
	/** Model name */
	model?: string;
	/** Local model path or name (for local provider) */
	localModel?: string;
}
