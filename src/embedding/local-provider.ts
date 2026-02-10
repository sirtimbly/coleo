/**
 * Local Embedding Provider
 * 
 * Generates embeddings using local models.
 * Uses Xenova/transformers for running models locally in Bun/Node.js.
 * Falls back to mock embeddings if transformers is not available.
 */

import type { EmbeddingOptions, EmbeddingResult, BatchEmbeddingResult, EmbeddingProvider } from "./types";

export class LocalEmbeddingProvider implements EmbeddingProvider {
	readonly name = "local";
	readonly defaultModel = "Xenova/all-MiniLM-L6-v2";
	readonly vectorSize = 384; // all-MiniLM-L6-v2 produces 384-dimensional embeddings

	private model: string;
	private pipeline: unknown | null = null;
	private initialized = false;

	constructor(model?: string) {
		this.model = model || process.env.LOCAL_EMBEDDING_MODEL || this.defaultModel;
	}

	/**
	 * Initialize the local embedding pipeline
	 */
	async initialize(): Promise<void> {
		if (this.initialized) return;

		try {
			// Try to dynamically import transformers
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const mod = await import("@xenova/transformers" as string).catch(() => null);
			if (mod && 'pipeline' in mod) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				this.pipeline = await (mod as any).pipeline("feature-extraction", this.model);
				console.log(`[Local Embedding] Initialized model: ${this.model}`);
			} else {
				console.warn(`[Local Embedding] Transformers not available, using mock embeddings`);
			}
			this.initialized = true;
		} catch (err) {
			console.warn(`[Local Embedding] Failed to load transformers, using mock embeddings: ${err}`);
			// Will fall back to mock embeddings
			this.initialized = true;
		}
	}

	private generateMockEmbedding(text: string, size: number): number[] {
		// Generate deterministic mock embeddings based on text hash
		// This ensures same text always produces same embedding
		const hash = this.hashString(text);
		const embedding: number[] = [];
		
		for (let i = 0; i < size; i++) {
			// Use hash to generate pseudo-random but deterministic values
			const value = Math.sin(hash + i * 0.1) * 0.5 + 0.5;
			embedding.push(value);
		}

		// Normalize the vector
		const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
		return embedding.map((val) => val / magnitude);
	}

	private hashString(str: string): number {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash = hash & hash;
		}
		return hash;
	}

	async embed(text: string, options?: EmbeddingOptions): Promise<EmbeddingResult> {
		await this.initialize();

		const model = options?.model || this.model;

		if (this.pipeline) {
			try {
				// Use actual transformers pipeline
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const result = await (this.pipeline as any)(text, {
					pooling: "mean",
					normalize: true,
				});
				
				// Extract embedding from result
				const embedding = Array.from(result.data) as number[];
				
				return {
					embedding,
					model,
				};
			} catch (err) {
				console.warn(`[Local Embedding] Pipeline failed, using mock: ${err}`);
				// Fall through to mock
			}
		}

		// Use mock embedding
		return {
			embedding: this.generateMockEmbedding(text, this.vectorSize),
			model: `${model} (mock)`,
		};
	}

	async embedBatch(texts: string[], options?: EmbeddingOptions): Promise<BatchEmbeddingResult> {
		await this.initialize();

		if (texts.length === 0) {
			return { embeddings: [], model: options?.model || this.model };
		}

		const model = options?.model || this.model;
		const batchSize = options?.batchSize || 32;
		const embeddings: number[][] = [];

		// Process in batches to avoid memory issues
		for (let i = 0; i < texts.length; i += batchSize) {
			const batch = texts.slice(i, i + batchSize);

			if (this.pipeline) {
				try {
					// Process batch with transformers
					for (const text of batch) {
						const result = await this.embed(text, options);
						embeddings.push(result.embedding);
					}
				} catch (err) {
					console.warn(`[Local Embedding] Batch pipeline failed, using mock: ${err}`);
					// Fall back to mock for remaining
					for (const text of batch) {
						embeddings.push(this.generateMockEmbedding(text, this.vectorSize));
					}
				}
			} else {
				// Use mock for entire batch
				for (const text of batch) {
					embeddings.push(this.generateMockEmbedding(text, this.vectorSize));
				}
			}
		}

		return {
			embeddings,
			model: this.pipeline ? model : `${model} (mock)`,
		};
	}
}
