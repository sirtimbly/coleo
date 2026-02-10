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
 * Searchable entity from database
 */
interface SearchableEntity {
	id: string;
	type: string;
	title: string;
	content: string;
	metadata: string;
	created_at: string;
	updated_at?: string;
	score?: number;
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
 * Perform keyword search using SQLite FTS
 */
async function performKeywordSearch(
	db: Database,
	query: string,
	types?: string[],
	filters?: Record<string, unknown>,
	limit = 50,
): Promise<SearchResult[]> {
	// Build the search query
	const searchTerms = query
		.trim()
		.split(/\s+/)
		.map((term) => `${term}*`)
		.join(" ");

	let sql = `
		SELECT 
			id,
			type,
			title,
			content,
			metadata,
			created_at,
			updated_at,
			rank as score
		FROM search_index
		WHERE search_index MATCH ?
	`;

	const params: (string | number)[] = [searchTerms];

	// Add type filter
	if (types && types.length > 0) {
		sql += ` AND type IN (${types.map(() => "?").join(", ")})`;
		params.push(...types);
	}

	// Add custom filters
	if (filters) {
		for (const [key, value] of Object.entries(filters)) {
			sql += ` AND json_extract(metadata, '$.${key}') = ?`;
			params.push(String(value));
		}
	}

	sql += ` ORDER BY rank LIMIT ?`;
	params.push(limit);

	const results = db.query(sql).all(...params) as SearchableEntity[];

	return results.map((row) => ({
		id: row.id,
		type: row.type,
		title: row.title,
		content: row.content,
		score: 0, // Will be calculated during merge
		keywordScore: normalizeScore(row.score || 0),
		semanticScore: 0,
		metadata: JSON.parse(row.metadata || "{}"),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}));
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
	const sql = `
		SELECT DISTINCT title
		FROM search_index
		WHERE title LIKE ?
		ORDER BY created_at DESC
		LIMIT ?
	`;

	const results = db.query(sql).all(`%${query}%`, limit) as { title: string }[];
	return results.map((r) => r.title);
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
