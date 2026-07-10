import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";

import { createSearchRoutes } from "../search";
import { embeddingService } from "../../../embedding";
import { qdrantStore } from "../../../qdrant";

interface TestContext {
  Variables: {
    db: Database;
  };
}

interface SearchResponseBody {
  results: Array<{
    id: string;
    type: string;
    title: string;
    score: number;
    keywordScore: number;
    semanticScore: number;
  }>;
  total: number;
  query: string;
  semanticUsed: boolean;
  took: number;
}

describe("search routes", () => {
  let db: Database;
  let app: Hono<TestContext>;
  let searchSpy: ReturnType<typeof spyOn>;
  let createCollectionSpy: ReturnType<typeof spyOn>;
  let upsertPointsSpy: ReturnType<typeof spyOn>;
  let embedSpy: ReturnType<typeof spyOn>;
  let vectorSizeSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    searchSpy = spyOn(qdrantStore, "search").mockImplementation(async () => []);
    createCollectionSpy = spyOn(qdrantStore, "createCollection").mockImplementation(async () => {});
    upsertPointsSpy = spyOn(qdrantStore, "upsertPoints").mockImplementation(async () => {});
    embedSpy = spyOn(embeddingService, "embed").mockImplementation(async () => ({
      embedding: new Array(1536).fill(0),
      model: "mock-embedding-model",
      tokens: 0,
    }));
    vectorSizeSpy = spyOn(embeddingService, "getVectorSize").mockImplementation(() => 1536);

    db = new Database(":memory:");

    // Minimal mirror of the real schema: tasks, bugs, arms + their FTS5
    // external-content indexes (see src/db/index.ts migrations 052-053, 055).
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        priority TEXT NOT NULL DEFAULT 'normal',
        domain TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE tasks_fts USING fts5(
        subject, description, content = 'tasks', content_rowid = 'rowid', tokenize = 'porter unicode61'
      );

      CREATE TABLE bugs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        priority TEXT NOT NULL DEFAULT 'medium',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE bugs_fts USING fts5(
        title, content = 'bugs', content_rowid = 'rowid', tokenize = 'porter unicode61'
      );

      CREATE TABLE arms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        domain TEXT NOT NULL,
        harness TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    db.run(
      `INSERT INTO tasks (id, subject, description, priority, created_at, updated_at)
       VALUES
        ('task-1', 'Implement search API', 'Create hybrid search with keyword ranking', 'high', '2024-01-01', '2024-01-02'),
        ('task-2', 'Add embedding service', 'Generate embeddings for semantic search', 'medium', '2024-01-02', '2024-01-03')`,
    );
    db.run(
      `INSERT INTO tasks_fts (rowid, subject, description) SELECT rowid, subject, description FROM tasks`,
    );

    db.run(
      `INSERT INTO bugs (id, title, description, source, created_at, updated_at)
       VALUES ('bug-1', 'Search API returns 500', 'Query throws when types filter is empty', 'human_reported', '2024-01-04', '2024-01-05')`,
    );
    db.run(`INSERT INTO bugs_fts (rowid, title) SELECT rowid, title FROM bugs`);

    db.run(
      `INSERT INTO arms (id, name, domain, harness, created_at, updated_at)
       VALUES ('arm-1', 'Backend Architect', 'backend', 'opencode-api', '2024-01-03', '2024-01-04')`,
    );

    app = new Hono<TestContext>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      await next();
    });
    app.route("/api/search", createSearchRoutes());
  });

  afterEach(() => {
    searchSpy.mockRestore();
    createCollectionSpy.mockRestore();
    upsertPointsSpy.mockRestore();
    embedSpy.mockRestore();
    vectorSizeSpy.mockRestore();
    db.close();
  });

  describe("POST /api/search", () => {
    it("rejects requests without a usable query", async () => {
      const missing = await app.request("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(missing.status).toBe(400);
      expect(await missing.json()).toEqual({ error: "Query is required" });

      const empty = await app.request("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "" }),
      });
      expect(empty.status).toBe(400);
      expect(await empty.json()).toEqual({ error: "Query is required" });
    });

    it("returns ranked keyword matches from the tasks FTS index", async () => {
      const response = await app.request("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "search API",
          types: ["task"],
          minScore: 0,
          semanticWeight: 0,
        }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as SearchResponseBody;

      expect(body.query).toBe("search API");
      expect(body.semanticUsed).toBe(false);
      expect(body.total).toBe(1);
      expect(body.results).toHaveLength(1);
      expect(body.results[0]).toMatchObject({
        id: "task-1",
        type: "task",
        title: "Implement search API",
      });
      expect(body.results[0]?.keywordScore).toBeGreaterThan(0);
      expect(body.results[0]?.semanticScore).toBe(0);
      expect(body.took).toBeGreaterThanOrEqual(0);
    });

    it("finds bugs via the bugs FTS index", async () => {
      const response = await app.request("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "returns 500",
          minScore: 0,
          semanticWeight: 0,
        }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as SearchResponseBody;

      expect(body.results.map((r) => r.id)).toContain("bug-1");
      expect(body.results.find((r) => r.id === "bug-1")).toMatchObject({
        type: "bug",
        title: "Search API returns 500",
      });
    });

    it("finds arms via name/harness/domain matching", async () => {
      const response = await app.request("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "Backend",
          minScore: 0,
          semanticWeight: 0,
        }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as SearchResponseBody;

      expect(body.results.map((r) => r.id)).toContain("arm-1");
      expect(body.results.find((r) => r.id === "arm-1")).toMatchObject({
        type: "arm",
        title: "Backend Architect",
      });
    });

    it("merges semantic matches when vector search returns additional content", async () => {
      searchSpy.mockImplementationOnce(async () => [
        {
          id: "doc-1",
          score: 0.82,
          payload: {
            type: "discovery",
            title: "Semantic-only result",
            content: "Returned from Qdrant",
            metadata: { source: "semantic" },
            created_at: "2024-02-01T00:00:00.000Z",
          },
        },
      ]);

      const response = await app.request("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "vector-only-query",
          keywordWeight: 0,
          semanticWeight: 1,
        }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as SearchResponseBody;

      expect(body.semanticUsed).toBe(true);
      expect(body.total).toBe(1);
      expect(body.results[0]).toMatchObject({
        id: "doc-1",
        type: "discovery",
        title: "Semantic-only result",
      });
      expect(body.results[0]?.keywordScore).toBe(0);
      expect(body.results[0]?.semanticScore).toBe(0.82);
      expect(body.results[0]?.score).toBe(0.82);
      expect(searchSpy).toHaveBeenCalledTimes(1);
    });

    it("applies type filters before returning results", async () => {
      const response = await app.request("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "search",
          types: ["task"],
          minScore: 0,
          semanticWeight: 0,
        }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as SearchResponseBody;

      expect(body.results.length).toBeGreaterThan(0);
      expect(body.results.every((result) => result.type === "task")).toBe(true);
      expect(body.results.map((result) => result.id)).not.toContain("arm-1");
    });

    it("sanitizes punctuation-only queries into empty result sets instead of FTS errors", async () => {
      const response = await app.request("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "...",
          semanticWeight: 0,
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ results: [], total: 0 });
    });
  });

  describe("GET /api/search/suggestions", () => {
    it("returns empty suggestions for short prefixes", async () => {
      const response = await app.request("/api/search/suggestions?q=a");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ suggestions: [] });
    });

    it("returns matching titles from indexed content", async () => {
      const response = await app.request("/api/search/suggestions?q=search");
      expect(response.status).toBe(200);
      const body = (await response.json()) as { suggestions: string[] };
      expect(body.suggestions).toContain("Implement search API");
      expect(body.suggestions).toContain("Search API returns 500");
    });
  });

  describe("POST /api/search/index", () => {
    it("indexes content into the semantic search backend with the expected payload", async () => {
      const response = await app.request("/api/search/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "task-3",
          type: "task",
          title: "New task",
          content: "Task content",
          metadata: { priority: "low" },
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });

      expect(embedSpy).toHaveBeenCalledWith("New task Task content");
      expect(vectorSizeSpy).toHaveBeenCalledTimes(1);
      expect(createCollectionSpy).toHaveBeenCalledWith("search-index", 1536, "Cosine");
      expect(upsertPointsSpy).toHaveBeenCalledTimes(1);

      const [collectionName, points] = upsertPointsSpy.mock.calls[0] ?? [];
      expect(collectionName).toBe("search-index");
      expect(points).toHaveLength(1);
      expect(points[0]).toMatchObject({
        id: "task-3",
        payload: {
          type: "task",
          title: "New task",
          content: "Task content",
          metadata: { priority: "low" },
        },
      });
      expect(Array.isArray(points[0]?.vector)).toBe(true);
      expect(points[0]?.vector).toHaveLength(1536);
    });
  });
});
