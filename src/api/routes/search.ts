/**
 * Search API Routes
 * 
 * Provides hybrid search capabilities combining keyword and semantic search.
 * Uses Qdrant for vector similarity and SQLite for keyword matching.
 */

import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { embeddingService } from "../../embedding";
import { qdrantStore } from "../../qdrant";

interface SearchContext {
  Variables: {
    db: Database;
  };
}

/**
 * Search result item
 */
export interface SearchResult {
	/** Unique identifier */
	id: string;
	/** Result type (task, arm, discovery, etc.) */
	type: string;
	/** Result title */
	title: string;
	/** Result content/description */
	content: string;
	/** Search relevance score (0-1) */
	score: number;
	/** Keyword match score (0-1) */
	keywordScore: number;
	/** Semantic similarity score (0-1) */
	semanticScore: number;
	/** Additional metadata */
	metadata: Record<string, unknown>;
	/** When the item was created */
	createdAt: string;
	/** When the item was last updated */
	updatedAt?: string;
}

/**
 * Search request body
 */
export interface SearchRequest {
	/** Search query */
	query: string;
	/** Search types to include (default: all) */
	types?: string[];
	/** Maximum results to return (default: 20) */
	limit?: number;
	/** Offset for pagination (default: 0) */
	offset?: number;
	/** Minimum score threshold (default: 0.1) */
	minScore?: number;
	/** Weight for keyword search (0-1, default: 0.5) */
	keywordWeight?: number;
	/** Weight for semantic search (0-1, default: 0.5) */
	semanticWeight?: number;
	/** Filter by metadata */
	filters?: Record<string, unknown>;
}

/**
 * Search response
 */
export interface SearchResponse {
	/** Search results */
	results: SearchResult[];
	/** Total number of results */
	total: number;
	/** Query used for search */
	query: string;
	/** Whether semantic search was used */
	semanticUsed: boolean;
	/** Time taken for search in ms */
	took: number;
}

/**
 * Create search routes
 */
export function createSearchRoutes(): Hono<SearchContext> {
	const app = new Hono<SearchContext>();

	// Search across all indexed content
	app.post("/", async (c) => {
		const startTime = Date.now();
		const db = c.get("db");

		try {
			const body = await c.req.json<SearchRequest>();
			const {
				query,
				types,
				limit = 20,
				offset = 0,
				minScore = 0.1,
				keywordWeight = 0.5,
				semanticWeight = 0.5,
				filters,
			} = body;

			if (!query || query.trim().length === 0) {
				return c.json({ error: "Query is required" }, 400);
			}

			// Normalize weights
			const totalWeight = keywordWeight + semanticWeight;
			const normalizedKeywordWeight = totalWeight > 0 ? keywordWeight / totalWeight : 0.5;
			const normalizedSemanticWeight = totalWeight > 0 ? semanticWeight / totalWeight : 0.5;

			// Perform keyword search
			const keywordResults = await performKeywordSearch(
				db,
				query,
				types,
				filters,
				limit * 2, // Get more results for merging
			);

			// Perform semantic search if weights allow
			let semanticResults: SearchResult[] = [];
			let semanticUsed = false;

			if (normalizedSemanticWeight > 0) {
				try {
					semanticResults = await performSemanticSearch(
						query,
						types,
						filters,
						limit * 2,
					);
					semanticUsed = true;
				} catch (err) {
					console.warn("[Search] Semantic search failed, using keyword only:", err);
				}
			}

			// Merge and score results
			const mergedResults = mergeSearchResults(
				keywordResults,
				semanticResults,
				normalizedKeywordWeight,
				normalizedSemanticWeight,
				minScore,
			);

			// Sort by combined score and apply pagination
			const sortedResults = mergedResults
				.sort((a, b) => b.score - a.score)
				.slice(offset, offset + limit);

			const response: SearchResponse = {
				results: sortedResults,
				total: mergedResults.length,
				query,
				semanticUsed,
				took: Date.now() - startTime,
			};

			return c.json(response);
		} catch (err) {
			console.error("[Search] Error performing search:", err);
			return c.json(
				{ error: err instanceof Error ? err.message : "Search failed" },
				500,
			);
		}
	});

	// Get search suggestions
	app.get("/suggestions", async (c) => {
		const db = c.get("db");

		try {
			const query = c.req.query("q") || "";
			const limit = parseInt(c.req.query("limit") || "5", 10);

			if (!query || query.trim().length < 2) {
				return c.json({ suggestions: [] });
			}

			// Get suggestions from recent searches and content
			const suggestions = await getSearchSuggestions(db, query, limit);

			return c.json({ suggestions });
		} catch (err) {
			console.error("[Search] Error getting suggestions:", err);
			return c.json({ suggestions: [] });
		}
	});

	// Index content for search
	app.post("/index", async (c) => {
		try {
			const body = await c.req.json<{
				id: string;
				type: string;
				title: string;
				content: string;
				metadata?: Record<string, unknown>;
			}>();

			await indexContent(body);

			return c.json({ success: true });
		} catch (err) {
			console.error("[Search] Error indexing content:", err);
			return c.json(
				{ error: err instanceof Error ? err.message : "Indexing failed" },
				500,
			);
		}
	});

	return app;
}

/**
 * Perform keyword search using SQLite FTS over real content tables
 * (bugs, tasks) plus a simple LIKE scan over arms. There is no longer a
 * generic `search_index` table to keep in sync — we query the tables the
 * rest of the app already writes to directly.
 */
async function performKeywordSearch(
	db: Database,
	query: string,
	types?: string[],
	filters?: Record<string, unknown>,
	limit = 50,
): Promise<SearchResult[]> {
	const ftsQuery = buildFtsPrefixQuery(query);
	if (!ftsQuery) {
		return [];
	}

	const wantedTypes = types && types.length > 0 ? new Set(types) : null;
	const wantsType = (type: string) => !wantedTypes || wantedTypes.has(type);

	const results: SearchResult[] = [];

	if (wantsType("bug")) {
		results.push(...searchBugs(db, ftsQuery, filters, limit));
	}

	if (wantsType("task")) {
		results.push(...searchTasks(db, ftsQuery, filters, limit));
	}

	if (wantsType("arm")) {
		results.push(...searchArms(db, query, filters, limit));
	}

	return results;
}

interface BugRow {
	id: string;
	title: string;
	description: string;
	status: string;
	priority: string;
	source: string;
	created_at: string;
	updated_at: string;
	rank: number;
}

function searchBugs(
	db: Database,
	ftsQuery: string,
	filters: Record<string, unknown> | undefined,
	limit: number,
): SearchResult[] {
	try {
		const rows = db
			.query(
				`SELECT b.id, b.title, b.description, b.status, b.priority, b.source,
					b.created_at, b.updated_at, bugs_fts.rank as rank
				FROM bugs_fts
				JOIN bugs b ON b.rowid = bugs_fts.rowid
				WHERE bugs_fts MATCH ?
				ORDER BY bugs_fts.rank
				LIMIT ?`,
			)
			.all(ftsQuery, limit) as BugRow[];

		return rankedRowsToResults(rows, (row, keywordScore) => ({
			id: row.id,
			type: "bug",
			title: row.title,
			content: row.description,
			score: 0,
			keywordScore,
			semanticScore: 0,
			metadata: applyFilters(
				{ status: row.status, priority: row.priority, source: row.source },
				filters,
			),
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}));
	} catch (err) {
		console.warn("[Search] Bug FTS query failed:", err);
		return [];
	}
}

interface TaskRow {
	id: string;
	subject: string;
	description: string;
	status: string;
	priority: string;
	domain: string | null;
	created_at: string;
	updated_at: string;
	rank: number;
}

function searchTasks(
	db: Database,
	ftsQuery: string,
	filters: Record<string, unknown> | undefined,
	limit: number,
): SearchResult[] {
	try {
		const rows = db
			.query(
				`SELECT t.id, t.subject, t.description, t.status, t.priority, t.domain,
					t.created_at, t.updated_at, tasks_fts.rank as rank
				FROM tasks_fts
				JOIN tasks t ON t.rowid = tasks_fts.rowid
				WHERE tasks_fts MATCH ?
				ORDER BY tasks_fts.rank
				LIMIT ?`,
			)
			.all(ftsQuery, limit) as TaskRow[];

		return rankedRowsToResults(rows, (row, keywordScore) => ({
			id: row.id,
			type: "task",
			title: row.subject,
			content: row.description,
			score: 0,
			keywordScore,
			semanticScore: 0,
			metadata: applyFilters(
				{ status: row.status, priority: row.priority, domain: row.domain },
				filters,
			),
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}));
	} catch (err) {
		console.warn("[Search] Task FTS query failed:", err);
		return [];
	}
}

interface ArmRow {
	id: string;
	name: string;
	domain: string;
	harness: string;
	status: string;
	created_at: string;
	updated_at: string;
}

function searchArms(
	db: Database,
	query: string,
	filters: Record<string, unknown> | undefined,
	limit: number,
): SearchResult[] {
	// Arms are a small table; a plain LIKE scan is fine and avoids needing an
	// FTS index that would need to stay in sync with frequent status updates.
	try {
		const like = `%${query.trim()}%`;
		const rows = db
			.query(
				`SELECT id, name, domain, harness, status, created_at, updated_at
				FROM arms
				WHERE id LIKE ? OR name LIKE ? OR harness LIKE ? OR domain LIKE ?
				ORDER BY updated_at DESC
				LIMIT ?`,
			)
			.all(like, like, like, like, limit) as ArmRow[];

		return rows.map((row, index) => ({
			id: row.id,
			type: "arm",
			title: row.name,
			content: `${row.harness} · ${row.status}`,
			score: 0,
			keywordScore: normalizeScore(1 - index / Math.max(rows.length, 1)),
			semanticScore: 0,
			metadata: applyFilters({ status: row.status, harness: row.harness, domain: row.domain }, filters),
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}));
	} catch (err) {
		console.warn("[Search] Arm search query failed:", err);
		return [];
	}
}

/**
 * Convert a metadata filter map into a plain object, dropping keys whose
 * requested value doesn't match (acts as a post-filter for the small
 * per-type queries above, which don't build dynamic SQL per filter key).
 */
function applyFilters(
	metadata: Record<string, unknown>,
	filters: Record<string, unknown> | undefined,
): Record<string, unknown> {
	if (!filters) return metadata;
	for (const [key, value] of Object.entries(filters)) {
		if (key in metadata && String(metadata[key]) !== String(value)) {
			return { ...metadata, __filteredOut: true };
		}
	}
	return metadata;
}

/**
 * FTS5 `rank` is a negative bm25-style score where values closer to zero are
 * *worse* matches (i.e. more negative = better). Convert the already-sorted
 * row order into a normalized 0..1 keyword score.
 */
function rankedRowsToResults<T>(
	rows: T[],
	toResult: (row: T, keywordScore: number) => SearchResult,
): SearchResult[] {
	const total = rows.length;
	return rows
		.map((row, index) => toResult(row, normalizeScore(1 - index / Math.max(total, 1))))
		.filter((result) => result.metadata.__filteredOut !== true);
}

/**
 * Convert raw input into an FTS5-safe prefix query.
 */
function buildFtsPrefixQuery(query: string): string {
	const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
	return terms.map((term) => `${term}*`).join(" ");
}


/**
 * Perform semantic search using Qdrant
 */
async function performSemanticSearch(
	query: string,
	types?: string[],
	filters?: Record<string, unknown>,
	limit = 50,
): Promise<SearchResult[]> {
	// Generate embedding for query
	const embeddingResult = await embeddingService.embed(query);
	const queryVector = embeddingResult.embedding;

	// Build filter for Qdrant
	const qdrantFilter: Record<string, unknown> = {};

	if (types && types.length > 0) {
		qdrantFilter.must = types.map((type) => ({
			key: "type",
			match: { value: type },
		}));
	}

	if (filters) {
		for (const [key, value] of Object.entries(filters)) {
			if (!qdrantFilter.must) qdrantFilter.must = [];
			(qdrantFilter.must as unknown[]).push({
				key: `metadata.${key}`,
				match: { value },
			});
		}
	}

	// Search Qdrant
	const results = await qdrantStore.search(
		"search-index",
		queryVector,
		{
			limit,
			filter: qdrantFilter,
			with_payload: true,
		},
	);

	return results.map((result) => {
		const payload = result.payload;
		return {
			id: result.id,
			type: String(payload.type || "unknown"),
			title: String(payload.title || ""),
			content: String(payload.content || ""),
			score: 0, // Will be calculated during merge
			keywordScore: 0,
			semanticScore: normalizeScore(result.score),
			metadata: (payload.metadata as Record<string, unknown>) || {},
			createdAt: String(payload.created_at || new Date().toISOString()),
			updatedAt: payload.updated_at ? String(payload.updated_at) : undefined,
		};
	});
}

/**
 * Merge keyword and semantic search results
 */
function mergeSearchResults(
	keywordResults: SearchResult[],
	semanticResults: SearchResult[],
	keywordWeight: number,
	semanticWeight: number,
	minScore: number,
): SearchResult[] {
	const resultMap = new Map<string, SearchResult>();

	// Add keyword results
	for (const result of keywordResults) {
		resultMap.set(result.id, {
			...result,
			score: result.keywordScore * keywordWeight,
		});
	}

	// Merge semantic results
	for (const result of semanticResults) {
		const existing = resultMap.get(result.id);
		if (existing) {
			// Combine scores
			existing.semanticScore = result.semanticScore;
			existing.score =
				existing.keywordScore * keywordWeight +
				result.semanticScore * semanticWeight;
		} else {
			resultMap.set(result.id, {
				...result,
				score: result.semanticScore * semanticWeight,
			});
		}
	}

	// Filter by minimum score and convert to array
	return Array.from(resultMap.values()).filter(
		(result) => result.score >= minScore,
	);
}

/**
 * Get search suggestions based on partial query
 */
async function getSearchSuggestions(
	db: Database,
	query: string,
	limit: number,
): Promise<string[]> {
	const like = `%${query}%`;
	const rows = db
		.query(
			`SELECT title, created_at FROM (
				SELECT title, created_at FROM bugs WHERE title LIKE ?
				UNION ALL
				SELECT subject as title, created_at FROM tasks WHERE subject LIKE ?
				UNION ALL
				SELECT name as title, created_at FROM arms WHERE name LIKE ?
			)
			ORDER BY created_at DESC
			LIMIT ?`,
		)
		.all(like, like, like, limit) as { title: string }[];

	return [...new Set(rows.map((r) => r.title))];
}

/**
 * Index content for search
 */
async function indexContent(content: {
	id: string;
	type: string;
	title: string;
	content: string;
	metadata?: Record<string, unknown>;
}): Promise<void> {
	// Generate embedding for semantic search
	const embeddingResult = await embeddingService.embed(
		`${content.title} ${content.content}`,
	);

	// Ensure Qdrant collection exists
	const vectorSize = embeddingService.getVectorSize();
	await qdrantStore.createCollection("search-index", vectorSize, "Cosine");

	// Index in Qdrant for semantic search
	await qdrantStore.upsertPoints("search-index", [
		{
			id: content.id,
			vector: embeddingResult.embedding,
			payload: {
				type: content.type,
				title: content.title,
				content: content.content,
				metadata: content.metadata || {},
				created_at: new Date().toISOString(),
			},
		},
	]);
}

/**
 * Normalize a score to 0-1 range
 */
function normalizeScore(score: number): number {
	// Clamp between 0 and 1
	return Math.max(0, Math.min(1, score));
}
