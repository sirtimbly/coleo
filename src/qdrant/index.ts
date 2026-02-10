/**
 * Qdrant Vector Store Module
 * 
 * Provides vector storage and similarity search capabilities for Coleo.
 * Used for semantic search of arm history, task completions, and other embeddings.
 */

export { QdrantVectorStore, qdrantStore } from "./client";
export type { VectorPoint, SearchResult, SearchOptions } from "./client";

// Embedding integration
export {
	indexDocuments,
	searchDocuments,
	indexArmStatus,
	indexTaskCompletion,
	searchArmHistory,
} from "./embedding-integration";
export type { SearchableDocument } from "./embedding-integration";
