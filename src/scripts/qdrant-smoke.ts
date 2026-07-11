/**
 * Qdrant functional smoke test.
 *
 * Starts against a running Qdrant (Docker or remote) and verifies:
 * - connectivity via COLEO_QDRANT_URL
 * - collection create
 * - vector upsert
 * - similarity search
 * - cleanup
 *
 * Usage:
 *   docker compose up -d qdrant
 *   bun run test:qdrant
 *
 * Env:
 *   COLEO_QDRANT_URL  default http://localhost:6333
 *   COLEO_QDRANT_SMOKE_KEEP=1  skip collection delete after run
 */

import { QdrantVectorStore } from "../qdrant/client";

const QDRANT_URL = process.env.COLEO_QDRANT_URL || "http://localhost:6333";
const COLLECTION = `coleo-smoke-${Date.now()}`;
const VECTOR_SIZE = 8;
const KEEP = process.env.COLEO_QDRANT_SMOKE_KEEP === "1";

function log(message: string): void {
	console.log(`[qdrant-smoke] ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

function unitVector(index: number, size: number): number[] {
	const vector = Array.from({ length: size }, () => 0);
	vector[index % size] = 1;
	return vector;
}

async function waitForReady(url: string, timeoutMs = 30_000): Promise<void> {
	const start = Date.now();
	let lastError: unknown;

	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(`${url.replace(/\/$/, "")}/collections`, {
				signal: AbortSignal.timeout(2000),
			});
			if (res.ok) return;
			lastError = new Error(`HTTP ${res.status}`);
		} catch (err) {
			lastError = err;
		}
		await Bun.sleep(500);
	}

	throw new Error(
		`Qdrant not ready at ${url} within ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
	);
}

async function main(): Promise<void> {
	const startedAt = performance.now();
	log(`URL: ${QDRANT_URL}`);
	log(`Collection: ${COLLECTION}`);

	const waitStart = performance.now();
	await waitForReady(QDRANT_URL);
	log(`ready in ${(performance.now() - waitStart).toFixed(1)}ms`);

	const store = new QdrantVectorStore(QDRANT_URL);

	const initStart = performance.now();
	await store.initialize();
	log(`initialize in ${(performance.now() - initStart).toFixed(1)}ms`);

	const createStart = performance.now();
	await store.createCollection(COLLECTION, VECTOR_SIZE, "Cosine");
	log(`createCollection in ${(performance.now() - createStart).toFixed(1)}ms`);

	const points = [
		{
			id: "11111111-1111-4111-8111-111111111111",
			vector: unitVector(0, VECTOR_SIZE),
			payload: { label: "alpha", kind: "smoke" },
		},
		{
			id: "22222222-2222-4222-8222-222222222222",
			vector: unitVector(1, VECTOR_SIZE),
			payload: { label: "beta", kind: "smoke" },
		},
		{
			id: "33333333-3333-4333-8333-333333333333",
			vector: unitVector(2, VECTOR_SIZE),
			payload: { label: "gamma", kind: "smoke" },
		},
	];

	const upsertStart = performance.now();
	await store.upsertPoints(COLLECTION, points);
	log(`upsert ${points.length} points in ${(performance.now() - upsertStart).toFixed(1)}ms`);

	const searchStart = performance.now();
	const results = await store.search(COLLECTION, unitVector(0, VECTOR_SIZE), {
		limit: 3,
		with_payload: true,
	});
	const searchMs = performance.now() - searchStart;
	log(`search returned ${results.length} hits in ${searchMs.toFixed(1)}ms`);

	assert(results.length > 0, "expected at least one search result");
	assert(results[0]!.id === points[0]!.id, `expected top hit ${points[0]!.id}, got ${results[0]!.id}`);
	assert(results[0]!.score > 0.99, `expected near-perfect score, got ${results[0]!.score}`);
	assert(results[0]!.payload.label === "alpha", "expected alpha payload on top hit");

	const info = await store.getCollectionInfo(COLLECTION);
	log(`collection status=${info.status} points=${info.points_count}`);
	assert(info.points_count >= points.length, `expected >= ${points.length} points`);

	const collections = await store.listCollections();
	assert(collections.includes(COLLECTION), `collection ${COLLECTION} missing from list`);

	if (!KEEP) {
		const deleteStart = performance.now();
		await store.deleteCollection(COLLECTION);
		log(`deleteCollection in ${(performance.now() - deleteStart).toFixed(1)}ms`);
	} else {
		log(`kept collection ${COLLECTION} (COLEO_QDRANT_SMOKE_KEEP=1)`);
	}

	const totalMs = performance.now() - startedAt;
	log(`PASS total ${totalMs.toFixed(1)}ms`);
}

main().catch((err) => {
	console.error(`[qdrant-smoke] FAIL: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
