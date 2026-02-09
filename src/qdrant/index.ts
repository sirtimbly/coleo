/**
 * Qdrant Vector Store Module
 * 
 * Provides vector storage and similarity search capabilities for Coleo.
 * Used for semantic search of arm history, task completions, and other embeddings.
 */

export { QdrantVectorStore, qdrantStore } from "./client";
export type { VectorPoint, SearchResult, SearchOptions } from "./client";
