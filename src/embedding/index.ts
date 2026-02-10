/**
 * Embedding Module
 * 
 * Provides text-to-vector embedding generation for semantic search.
 * Supports both OpenAI API and local embedding models.
 * 
 * @example
 * ```typescript
 * import { embeddingService } from "./embedding";
 * 
 * // Single embedding
 * const result = await embeddingService.embed("Hello world");
 * 
 * // Batch embeddings
 * const batch = await embeddingService.embedBatch(["text1", "text2", "text3"]);
 * 
 * // Use with Qdrant
 * import { qdrantStore } from "../qdrant";
 * await qdrantStore.upsertPoints("my-collection", [{
 *   id: "1",
 *   vector: result.embedding,
 *   payload: { text: "Hello world" }
 * }]);
 * ```
 */

export { EmbeddingService, embeddingService } from "./service";
export { OpenAIEmbeddingProvider } from "./openai-provider";
export { LocalEmbeddingProvider } from "./local-provider";
export type {
	EmbeddingConfig,
	EmbeddingOptions,
	EmbeddingResult,
	BatchEmbeddingResult,
	EmbeddingProvider,
} from "./types";
