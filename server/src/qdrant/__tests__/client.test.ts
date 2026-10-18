import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { QdrantVectorStore } from "../client";

describe("QdrantVectorStore", () => {
	const originalEnv = process.env.COLEO_QDRANT_URL;

	beforeEach(() => {
		delete process.env.COLEO_QDRANT_URL;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.COLEO_QDRANT_URL;
		} else {
			process.env.COLEO_QDRANT_URL = originalEnv;
		}
	});

	it("resolves URL from constructor over env and default", () => {
		process.env.COLEO_QDRANT_URL = "http://env-qdrant:6333";
		const store = new QdrantVectorStore("http://explicit:6333");
		expect((store as unknown as { url: string }).url).toBe("http://explicit:6333");
	});

	it("resolves URL from COLEO_QDRANT_URL when not configured", () => {
		process.env.COLEO_QDRANT_URL = "http://env-qdrant:6333";
		const store = new QdrantVectorStore();
		expect((store as unknown as { url: string }).url).toBe("http://env-qdrant:6333");
	});

	it("defaults to localhost:6333", () => {
		const store = new QdrantVectorStore();
		expect((store as unknown as { url: string }).url).toBe("http://localhost:6333");
	});

	it("collection and search APIs use the injected client", async () => {
		const store = new QdrantVectorStore("http://localhost:6333");
		const fakeClient = {
			getCollections: mock(async () => ({ collections: [] })),
			createCollection: mock(async () => ({})),
			createPayloadIndex: mock(async () => ({})),
			deleteCollection: mock(async () => ({})),
			upsert: mock(async () => ({})),
			search: mock(async () => [
				{ id: "p1", score: 0.98, payload: { text: "hello" } },
			]),
			delete: mock(async () => ({})),
			getCollection: mock(async () => ({
				status: "green",
				points_count: 1,
				segments_count: 1,
			})),
		};

		(store as unknown as { client: typeof fakeClient; initialized: boolean }).client = fakeClient;
		(store as unknown as { initialized: boolean }).initialized = true;

		expect(store.isInitialized()).toBe(true);

		await store.createCollection("demo", 8, "Cosine");
		expect(fakeClient.createCollection).toHaveBeenCalledWith("demo", {
			vectors: { size: 8, distance: "Cosine" },
		});

		await store.createPayloadIndex("demo", "timestamp", "datetime");
		expect(fakeClient.createPayloadIndex).toHaveBeenCalledWith("demo", {
			field_name: "timestamp",
			field_schema: "datetime",
		});

		await store.upsertPoints("demo", [
			{ id: "p1", vector: [1, 0, 0, 0, 0, 0, 0, 0], payload: { text: "hello" } },
		]);
		expect(fakeClient.upsert).toHaveBeenCalled();

		const results = await store.search("demo", [1, 0, 0, 0, 0, 0, 0, 0], { limit: 5 });
		expect(results).toEqual([{ id: "p1", score: 0.98, payload: { text: "hello" } }]);

		const info = await store.getCollectionInfo("demo");
		expect(info).toEqual({ status: "green", points_count: 1, segments_count: 1 });

		await store.deletePoints("demo", ["p1"]);
		expect(fakeClient.delete).toHaveBeenCalledWith("demo", { points: ["p1"] });

		await store.deleteCollection("demo");
		expect(fakeClient.deleteCollection).toHaveBeenCalledWith("demo");
	});

	it("listCollections maps collection names", async () => {
		const store = new QdrantVectorStore("http://localhost:6333");
		const fakeClient = {
			getCollections: mock(async () => ({
				collections: [{ name: "a" }, { name: "b" }],
			})),
		};
		(store as unknown as { client: typeof fakeClient; initialized: boolean }).client = fakeClient;
		(store as unknown as { initialized: boolean }).initialized = true;

		await expect(store.listCollections()).resolves.toEqual(["a", "b"]);
	});
});
