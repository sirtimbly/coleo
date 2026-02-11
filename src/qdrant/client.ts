/**
 * Qdrant Vector Store Client
 * 
 * Provides vector storage and similarity search capabilities using Qdrant.
 * Used for storing and searching arm status history, task completions, and other
 * embeddings for semantic search.
 */

import type { QdrantClient } from "@qdrant/js-client-rest";

export interface VectorPoint {
	id: string;
	vector: number[];
	payload: Record<string, unknown>;
}

export interface SearchResult {
	id: string;
	score: number;
	payload: Record<string, unknown>;
}

export interface SearchOptions {
	filter?: Record<string, unknown>;
	limit?: number;
	offset?: number;
	with_payload?: boolean;
	with_vector?: boolean;
}

/**
 * QdrantVectorStore provides vector storage and search capabilities
 */
export class QdrantVectorStore {
	private client: QdrantClient | null = null;
	private url: string;
	private initialized = false;
	private initPromise: Promise<void> | null = null;
	private configuredUrl?: string;

	constructor(url?: string) {
		this.configuredUrl = url;
		this.url = this.resolveUrl();
	}

	private resolveUrl(): string {
		return this.configuredUrl || process.env.COLEO_QDRANT_URL || "http://localhost:6333";
	}

	/**
	 * Initialize the Qdrant client
	 */
	async initialize(): Promise<void> {
		const resolvedUrl = this.resolveUrl();
		if (resolvedUrl !== this.url) {
			this.url = resolvedUrl;
			this.client = null;
			this.initialized = false;
		}

		if (this.initialized && this.client) return;
		if (this.initPromise) return this.initPromise;

		this.initPromise = (async () => {
			try {
				// Dynamic import to avoid bundling issues
				const { QdrantClient } = await import("@qdrant/js-client-rest");
				this.client = new QdrantClient({ url: this.url });

				// Test connection
				await this.client.getCollections();
				this.initialized = true;
				console.log(`[Qdrant] Connected to ${this.url}`);
			} catch (err) {
				this.client = null;
				this.initialized = false;
				console.error(`[Qdrant] Failed to connect to ${this.url}:`, err);
				throw new Error(`Failed to initialize Qdrant: ${err}`);
			} finally {
				this.initPromise = null;
			}
		})();

		return this.initPromise;
	}

	/**
	 * Check if the store is initialized
	 */
	isInitialized(): boolean {
		return this.initialized;
	}

	private async ensureInitialized(): Promise<QdrantClient> {
		if (!this.initialized || !this.client) {
			await this.initialize();
		}

		if (!this.client) {
			throw new Error("Qdrant not initialized");
		}

		return this.client;
	}

	/**
	 * Create a collection if it doesn't exist
	 */
	async createCollection(
		name: string,
		vectorSize: number,
		distance: "Cosine" | "Euclid" | "Dot" = "Cosine",
	): Promise<void> {
		const client = await this.ensureInitialized();

		try {
			await client.createCollection(name, {
				vectors: {
					size: vectorSize,
					distance,
				},
			});
			console.log(`[Qdrant] Created collection: ${name}`);
		} catch (err) {
			// Collection might already exist
			console.log(`[Qdrant] Collection ${name} may already exist`);
		}
	}

	/**
	 * Delete a collection
	 */
	async deleteCollection(name: string): Promise<void> {
		const client = await this.ensureInitialized();

		try {
			await client.deleteCollection(name);
			console.log(`[Qdrant] Deleted collection: ${name}`);
		} catch (err) {
			console.error(`[Qdrant] Failed to delete collection ${name}:`, err);
		}
	}

	/**
	 * Upsert points into a collection
	 */
	async upsertPoints(collectionName: string, points: VectorPoint[]): Promise<void> {
		const client = await this.ensureInitialized();

		await client.upsert(collectionName, {
			points: points.map((p) => ({
				id: p.id,
				vector: p.vector,
				payload: p.payload,
			})),
		});
	}

	/**
	 * Search for similar vectors
	 */
	async search(
		collectionName: string,
		vector: number[],
		options: SearchOptions = {},
	): Promise<SearchResult[]> {
		const client = await this.ensureInitialized();

		const results = await client.search(collectionName, {
			vector,
			limit: options.limit || 10,
			offset: options.offset,
			filter: options.filter,
			with_payload: options.with_payload ?? true,
			with_vector: options.with_vector ?? false,
		});

		return results.map((r) => ({
			id: String(r.id),
			score: r.score,
			payload: (r.payload as Record<string, unknown>) || {},
		}));
	}

	/**
	 * Delete points by ID
	 */
	async deletePoints(collectionName: string, ids: string[]): Promise<void> {
		const client = await this.ensureInitialized();

		await client.delete(collectionName, {
			points: ids,
		});
	}

	/**
	 * Get collection info
	 */
	async getCollectionInfo(collectionName: string): Promise<{
		status: string;
		points_count: number;
		segments_count: number;
	}> {
		const client = await this.ensureInitialized();

		const info = await client.getCollection(collectionName);
		return {
			status: info.status,
			points_count: info.points_count || 0,
			segments_count: info.segments_count,
		};
	}

	/**
	 * List all collections
	 */
	async listCollections(): Promise<string[]> {
		const client = await this.ensureInitialized();

		const response = await client.getCollections();
		return response.collections.map((c) => c.name);
	}
}

// Export a singleton instance
export const qdrantStore = new QdrantVectorStore();
