/**
 * Embedding Service Tests
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { EmbeddingService, LocalEmbeddingProvider, OpenAIEmbeddingProvider } from "../index";
import type { EmbeddingConfig } from "../types";

describe("LocalEmbeddingProvider", () => {
	let provider: LocalEmbeddingProvider;

	beforeEach(() => {
		provider = new LocalEmbeddingProvider();
	});

	it("should have correct default properties", () => {
		expect(provider.name).toBe("local");
		expect(provider.defaultModel).toBe("Xenova/all-MiniLM-L6-v2");
		expect(provider.vectorSize).toBe(384);
	});

	it("should generate embeddings with correct dimensions", async () => {
		const result = await provider.embed("Hello world");
		
		expect(result.embedding).toBeDefined();
		expect(result.embedding.length).toBe(384);
		expect(result.model).toContain("Xenova/all-MiniLM-L6-v2");
	});

	it("should generate consistent embeddings for same text", async () => {
		const text = "Test consistency";
		const result1 = await provider.embed(text);
		const result2 = await provider.embed(text);

		expect(result1.embedding.length).toBe(result2.embedding.length);
		// Embeddings should be very similar (allowing for floating point differences)
		const similarity = cosineSimilarity(result1.embedding, result2.embedding);
		expect(similarity).toBeGreaterThan(0.99);
	});

	it("should generate different embeddings for different texts", async () => {
		const result1 = await provider.embed("Hello world");
		const result2 = await provider.embed("Goodbye world");

		const similarity = cosineSimilarity(result1.embedding, result2.embedding);
		// Different texts should have lower similarity
		expect(similarity).toBeLessThan(0.95);
	});

	it("should handle batch embeddings", async () => {
		const texts = ["First text", "Second text", "Third text"];
		const result = await provider.embedBatch(texts);

		expect(result.embeddings).toHaveLength(3);
		expect(result.embeddings[0]!.length).toBe(384);
		expect(result.embeddings[1]!.length).toBe(384);
		expect(result.embeddings[2]!.length).toBe(384);
	});

	it("should handle empty batch", async () => {
		const result = await provider.embedBatch([]);
		
		expect(result.embeddings).toHaveLength(0);
	});
});

describe("OpenAIEmbeddingProvider", () => {
	it("should have correct default properties", () => {
		const provider = new OpenAIEmbeddingProvider("fake-key");
		
		expect(provider.name).toBe("openai");
		expect(provider.defaultModel).toBe("text-embedding-3-small");
		expect(provider.vectorSize).toBe(1536);
	});

	it("should throw error when API key is missing at embed time", async () => {
		// Save and clear env var
		const originalKey = process.env.OPENAI_API_KEY;
		delete process.env.OPENAI_API_KEY;
		
		try {
			const provider = new OpenAIEmbeddingProvider();
			// Provider warns on construction but throws on actual embed call
			await expect(provider.embed("test")).rejects.toThrow("OpenAI API key not configured");
		} finally {
			// Restore env var
			if (originalKey) {
				process.env.OPENAI_API_KEY = originalKey;
			}
		}
	});
});

describe("EmbeddingService", () => {
	beforeEach(() => {
		// Clear environment variables
		delete process.env.OPENAI_API_KEY;
		delete process.env.OPENAI_BASE_URL;
	});

	it("should auto-detect local provider when no OpenAI key", () => {
		const service = new EmbeddingService();
		
		expect(service.getProviderName()).toBe("local");
	});

	it("should auto-detect OpenAI provider when API key exists", () => {
		process.env.OPENAI_API_KEY = "test-key";
		const service = new EmbeddingService();
		
		expect(service.getProviderName()).toBe("openai");
	});

	it("should use explicit config over auto-detection", () => {
		process.env.OPENAI_API_KEY = "test-key";
		const config: EmbeddingConfig = { provider: "local" };
		const service = new EmbeddingService(config);
		
		expect(service.getProviderName()).toBe("local");
	});

	it("should generate embeddings through service", async () => {
		const service = new EmbeddingService({ provider: "local" });
		const result = await service.embed("Test text");

		expect(result.embedding).toBeDefined();
		expect(result.embedding.length).toBe(384);
	});

	it("should generate batch embeddings through service", async () => {
		const service = new EmbeddingService({ provider: "local" });
		const result = await service.embedBatch(["Text 1", "Text 2"]);

		expect(result.embeddings).toHaveLength(2);
	});

	it("should return correct vector size", () => {
		const localService = new EmbeddingService({ provider: "local" });
		expect(localService.getVectorSize()).toBe(384);

		process.env.OPENAI_API_KEY = "test-key";
		const openaiService = new EmbeddingService();
		expect(openaiService.getVectorSize()).toBe(1536);
	});
});

// Helper function to calculate cosine similarity
function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length === 0 || b.length === 0) return 0;
	
	let dotProduct = 0;
	let normA = 0;
	let normB = 0;
	
	for (let i = 0; i < a.length; i++) {
		dotProduct += a[i]! * b[i]!;
		normA += a[i]! * a[i]!;
		normB += b[i]! * b[i]!;
	}
	
	return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
