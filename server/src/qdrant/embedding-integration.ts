/**
 * Embedding + Qdrant Integration Example
 * 
 * This example shows how to use the embedding service with Qdrant
 * for semantic search of arm status history and task completions.
 */

import { embeddingService } from "../embedding";
import { getProjectCollectionName, getProjectScope } from "../project-scope";
import { qdrantStore } from "./client";

export interface SearchableDocument {
	id: string;
	text: string;
	metadata: Record<string, unknown>;
}

/**
 * Index documents with embeddings into Qdrant
 */
export async function indexDocuments(
	collectionBaseName: string,
	documents: SearchableDocument[],
): Promise<void> {
	const collectionName = getProjectCollectionName(collectionBaseName);
	const projectScope = getProjectScope();
	// Ensure collection exists with correct vector size
	const vectorSize = embeddingService.getVectorSize();
	await qdrantStore.createCollection(collectionName, vectorSize, "Cosine");

	// Generate embeddings for all documents
	const texts = documents.map((d) => d.text);
	const embeddingsResult = await embeddingService.embedBatch(texts);

	// Create points for Qdrant
	const points = documents.map((doc, i) => ({
		id: doc.id,
		vector: embeddingsResult.embeddings[i]!,
		payload: {
			text: doc.text,
			...doc.metadata,
			project_dir: projectScope.projectDir,
			project_key: projectScope.projectKey,
		},
	}));

	// Upsert into Qdrant
	await qdrantStore.upsertPoints(collectionName, points);
	console.log(`[Index] Indexed ${documents.length} documents into ${collectionName}`);
}

/**
 * Search for similar documents
 */
export async function searchDocuments(
	collectionBaseName: string,
	query: string,
	limit = 10,
): Promise<Array<{
	id: string;
	score: number;
	text: string;
	metadata: Record<string, unknown>;
}>> {
	// Generate embedding for query
	const queryEmbedding = await embeddingService.embed(query);

	// Search Qdrant
	const results = await qdrantStore.search(
		getProjectCollectionName(collectionBaseName),
		queryEmbedding.embedding,
		{
			limit,
			with_payload: true,
		},
	);

	return results.map((r) => ({
		id: r.id,
		score: r.score,
		text: String(r.payload.text || ""),
		metadata: r.payload,
	}));
}

/**
 * Example usage for indexing arm status history
 */
export async function indexArmStatus(
	armId: string,
	status: string,
	timestamp: Date,
): Promise<void> {
	const document: SearchableDocument = {
		id: `arm-${armId}-${timestamp.getTime()}`,
		text: status,
		metadata: {
			armId,
			timestamp: timestamp.toISOString(),
			type: "arm_status",
		},
	};

	await indexDocuments("arm-history", [document]);
}

/**
 * Example usage for indexing task completions
 */
export async function indexTaskCompletion(
	taskId: string,
	summary: string,
	artifacts: string[],
): Promise<void> {
	const document: SearchableDocument = {
		id: `task-${taskId}`,
		text: `${summary}\n\nArtifacts: ${artifacts.join(", ")}`,
		metadata: {
			taskId,
			type: "task_completion",
			artifacts,
		},
	};

	await indexDocuments("task-completions", [document]);
}

/**
 * Search arm history for similar statuses
 */
export async function searchArmHistory(
	query: string,
	armId?: string,
	limit = 10,
): Promise<ReturnType<typeof searchDocuments>> {
	const filter = armId ? { arm_id: armId } : undefined;
	
	// Generate embedding for query
	const queryEmbedding = await embeddingService.embed(query);

	// Search with filter
	const results = await qdrantStore.search(getProjectCollectionName("arm-history"), queryEmbedding.embedding, {
		limit,
		filter,
		with_payload: true,
	});

	return results.map((r) => ({
		id: r.id,
		score: r.score,
		text: String(r.payload.text || ""),
		metadata: r.payload,
	}));
}
