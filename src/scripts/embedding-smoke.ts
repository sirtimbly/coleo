/**
 * Embedding functional smoke test.
 *
 * Verifies local/mock embeddings always, and OpenAI when OPENAI_API_KEY is set.
 *
 * Usage:
 *   bun run test:embedding
 *   OPENAI_API_KEY=... bun run test:embedding
 *
 * Env:
 *   COLEO_EMBEDDING_PROVIDER  openai | local | mock
 *   OPENAI_API_KEY
 *   OPENAI_EMBEDDING_MODEL
 *   LOCAL_EMBEDDING_MODEL
 */

import { EmbeddingService } from "../embedding";

function log(message: string): void {
	console.log(`[embedding-smoke] ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

function cosineSimilarity(a: number[], b: number[]): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i]! * b[i]!;
		na += a[i]! * a[i]!;
		nb += b[i]! * b[i]!;
	}
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function exercise(service: EmbeddingService, label: string): Promise<void> {
	const started = performance.now();
	log(`${label}: provider=${service.getProviderName()} model=${service.getModel()} dim=${service.getVectorSize()}`);

	const singleStart = performance.now();
	const single = await service.embed("Coleo embedding smoke test");
	log(`${label}: single embed ${single.embedding.length}d in ${(performance.now() - singleStart).toFixed(1)}ms model=${single.model}`);

	assert(single.embedding.length === service.getVectorSize(), `${label}: dim mismatch`);
	assert(single.embedding.every((n) => Number.isFinite(n)), `${label}: non-finite values`);

	const batchStart = performance.now();
	const batch = await service.embedBatch([
		"status report on track",
		"task completed successfully",
		"blocker: missing credentials",
	]);
	log(`${label}: batch ${batch.embeddings.length} in ${(performance.now() - batchStart).toFixed(1)}ms`);

	assert(batch.embeddings.length === 3, `${label}: expected 3 batch embeddings`);
	for (const vec of batch.embeddings) {
		assert(vec!.length === service.getVectorSize(), `${label}: batch dim mismatch`);
	}

	const again = await service.embed("Coleo embedding smoke test");
	const sim = cosineSimilarity(single.embedding, again.embedding);
	assert(sim > 0.99, `${label}: expected consistent embeddings, similarity=${sim}`);

	log(`${label}: PASS in ${(performance.now() - started).toFixed(1)}ms`);
}

async function main(): Promise<void> {
	// Always exercise local/mock path (no network).
	const local = new EmbeddingService({ provider: "local" });
	await exercise(local, "local");

	if (process.env.OPENAI_API_KEY) {
		const openai = new EmbeddingService({
			provider: "openai",
			apiKey: process.env.OPENAI_API_KEY,
			baseUrl: process.env.OPENAI_BASE_URL,
			model: process.env.OPENAI_EMBEDDING_MODEL,
		});
		await exercise(openai, "openai");
	} else {
		log("skip openai (OPENAI_API_KEY unset)");
	}

	// Auto-detect path used by the rest of the app.
	const auto = new EmbeddingService();
	log(`auto-detect: provider=${auto.getProviderName()} dim=${auto.getVectorSize()}`);
	log("PASS");
}

main().catch((err) => {
	console.error(`[embedding-smoke] FAIL: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
