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

// Check if Qdrant is available
async function isQdrantAvailable(): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 1000);
		
		const response = await fetch("http://localhost:6333/health", {
			signal: controller.signal,
		});
		
		clearTimeout(timeoutId);
		return response.status === 200;
	} catch {
		return false;
	}
}

describe("Search API", () => {
	let db: Database;
	let app: Hono<TestContext>;
	let qdrantAvailable: boolean;

	beforeEach(async () => {
		// Check Qdrant availability
		qdrantAvailable = await isQdrantAvailable();

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
		app = new Hono<TestContext>();
		app.use("*", async (c, next) => {
			c.set("db", db);
			await next();
		});
		app.route("/", createSearchRoutes());
	});

	afterEach(() => {
		db.close();
		qdrantSpy?.mockRestore();
		embeddingSpy?.mockRestore();
	});

	describe("POST /", () => {
		it("should perform keyword search successfully", async () => {
			// Skip if Qdrant not available
			if (!qdrantAvailable) {
				console.log("Skipping test: Qdrant not available");
				return;
			}

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
			const body = await res.json();
			expect(body.results).toBeDefined();
			// Should only return tasks
			expect(body.results.every((r: { type: string }) => r.type === "task")).toBe(true);
		});

		it("should return empty results for no match", async () => {
			const res = await app.request("/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					query: "nonexistent query xyz123",
					semanticWeight: 0,
				}),
			});

			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.results).toHaveLength(0);
		});

		it("should require query parameter", async () => {
			const res = await app.request("/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});

			expect(res.status).toBe(400);
		});
	});

	describe("POST /index", () => {
		it("should require Qdrant to be initialized", async () => {
			// Skip if Qdrant not available
			if (!qdrantAvailable) {
				console.log("Skipping test: Qdrant not available");
				return;
			}

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
