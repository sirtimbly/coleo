/**
 * Search API Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createSearchRoutes } from "../search";

describe("Search API", () => {
	let db: Database;
	let app: Hono;

	beforeEach(async () => {
		// Create in-memory database
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
		app = new Hono();
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
	});

	describe("POST /", () => {
		it("should return 400 if query is missing", async () => {
			const res = await app.request("/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});

			expect(res.status).toBe(400);
			const body = await res.json();
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
					semanticWeight: 0, // Disable semantic for this test
				}),
			});

			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.results).toBeDefined();
			expect(body.query).toBe("search API");
			expect(body.semanticUsed).toBe(false);
			expect(body.took).toBeGreaterThan(0);
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
			const body = await res.json();
			expect(body.results.every((r: { type: string }) => r.type === "task")).toBe(true);
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
			const body = await res.json();
			expect(body.results.length).toBeLessThanOrEqual(1);
		});
	});

	describe("GET /suggestions", () => {
		it("should return empty array for short query", async () => {
			const res = await app.request("/suggestions?q=a");
			const body = await res.json();
			expect(body.suggestions).toEqual([]);
		});

		it("should return suggestions for valid query", async () => {
			const res = await app.request("/suggestions?q=search");
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(Array.isArray(body.suggestions)).toBe(true);
		});
	});

	describe("POST /index", () => {
		it("should require Qdrant to be initialized", async () => {
			// This test verifies the endpoint exists but will fail without Qdrant
			// In production, Qdrant would be initialized
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

			// Expect 500 because Qdrant is not initialized in test environment
			expect(res.status).toBe(500);
		});
	});
});
