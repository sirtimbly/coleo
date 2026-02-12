/**
 * Search API Tests
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createSearchRoutes } from "../search";
import * as qdrantModule from "../../../qdrant";
import * as embeddingModule from "../../../embedding";

interface TestContext {
	Variables: {
		db: Database;
	};
}

describe("Search API", () => {
	let db: Database;
	let app: Hono<TestContext>;
	let qdrantSpy: ReturnType<typeof spyOn>;
	let embeddingSpy: ReturnType<typeof spyOn>;

	beforeEach(async () => {
		qdrantSpy = spyOn(qdrantModule.qdrantStore, "initialize").mockImplementation(async () => {});
		spyOn(qdrantModule.qdrantStore, "search").mockImplementation(async () => []);
		spyOn(qdrantModule.qdrantStore, "upsertPoints").mockImplementation(async () => {});
		spyOn(qdrantModule.qdrantStore, "createCollection").mockImplementation(async () => {});
		embeddingSpy = spyOn(embeddingModule.embeddingService, "embed").mockImplementation(async () => ({
			embedding: new Array(1536).fill(0),
			model: "mock",
			tokens: 0,
		}));
		spyOn(embeddingModule.embeddingService, "getVectorSize").mockImplementation(() => 1536);

		db = new Database(":memory:");

		// Create search index table
		db.exec(`
			CREATE VIRTUAL TABLE search_index USING fts5(
				id,
				type,
				title,
				content,
				metadata,
				created_at,
				updated_at
			)
		`);

		// Insert test data
		db.run(`
			INSERT INTO search_index (id, type, title, content, metadata, created_at)
			VALUES 
				('task-1', 'task', 'Implement search API', 'Create hybrid search with keyword and semantic', '{"priority": "high"}', '2024-01-01'),
				('task-2', 'task', 'Add embedding service', 'Generate embeddings for semantic search', '{"priority": "medium"}', '2024-01-02'),
				('arm-1', 'arm', 'Backend Architect', 'Arm for backend development', '{"domain": "backend"}', '2024-01-03')
		`);

		// Create app with database context
		app = new Hono<TestContext>();
		app.use("*", async (c, next) => {
			c.set("db", db);
			await next();
		});

		// Mount search routes
		const searchRoutes = createSearchRoutes();
		app.route("/", searchRoutes);
	});

	afterEach(() => {
		db.close();
		qdrantSpy?.mockRestore();
		embeddingSpy?.mockRestore();
	});

	describe("POST /", () => {
		it("should return 400 if query is missing", async () => {
			const res = await app.request("/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});

			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: string };
			expect(body.error).toBe("Query is required");
		});

		it("should return 400 if query is empty", async () => {
			const res = await app.request("/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ query: "" }),
			});

			expect(res.status).toBe(400);
		});

		it("should perform keyword search successfully", async () => {
			const res = await app.request("/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					query: "search API",
					semanticWeight: 0,
				}),
			});

			expect(res.status).toBe(200);
			const body = (await res.json()) as { results: unknown[]; query: string; semanticUsed: boolean; took: number };
			expect(body.results).toBeDefined();
			expect(body.query).toBe("search API");
			expect(body.semanticUsed).toBe(false);
			expect(body.took).toBeGreaterThanOrEqual(0);
		});

		it("should filter by type", async () => {
			const res = await app.request("/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					query: "search",
					types: ["task"],
					semanticWeight: 0,
				}),
			});

			expect(res.status).toBe(200);
			const body = (await res.json()) as { results: { type: string }[] };
			expect(body.results.every((r) => r.type === "task")).toBe(true);
		});

		it("should support pagination", async () => {
			const res = await app.request("/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					query: "search",
					limit: 1,
					offset: 0,
					semanticWeight: 0,
				}),
			});

			expect(res.status).toBe(200);
			const body = (await res.json()) as { results: unknown[] };
			expect(body.results.length).toBeLessThanOrEqual(1);
		});
	});

	describe("GET /suggestions", () => {
		it("should return empty array for short query", async () => {
			const res = await app.request("/suggestions?q=a");
			const body = (await res.json()) as { suggestions: unknown[] };
			expect(body.suggestions).toEqual([]);
		});

		it("should return suggestions for valid query", async () => {
			const res = await app.request("/suggestions?q=search");
			expect(res.status).toBe(200);
			const body = (await res.json()) as { suggestions: unknown[] };
			expect(Array.isArray(body.suggestions)).toBe(true);
		});
	});

	describe("POST /index", () => {
		it("should index content successfully", async () => {
			const res = await app.request("/index", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					id: "task-3",
					type: "task",
					title: "New task",
					content: "Task content",
				}),
			});

			expect(res.status).toBe(200);
			const body = (await res.json()) as { success: boolean };
			expect(body.success).toBe(true);
		});
	});
});
