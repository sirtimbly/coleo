/**
 * Status History Search API
 *
 * Hybrid search over Qdrant-backed status history (semantic) with optional
 * keyword scoring on title/content, matching plan endpoints:
 *   POST /api/status-history/search
 *   GET  /api/status-history/stats
 *   GET  /api/arms/:id/status-history  (mounted separately under arms if needed;
 *        also exposed here as GET /api/status-history/by-arm/:armId)
 */

import { Hono } from "hono";
import {
	searchStatusHistory,
	getStatusHistoryHealth,
	indexStatusHistoryEvent,
} from "../../vector/indexing-pipeline";
import type { StatusHistoryEvent, StatusHistoryEventType } from "../../vector/status-history";
import { createEventId } from "../../vector/status-history";

export interface StatusHistorySearchRequest {
	query: string;
	filters?: {
		arm_ids?: string[];
		event_types?: StatusHistoryEventType[];
		from?: string;
		to?: string;
		task_id?: string;
		bug_id?: string;
		source?: string;
		classification?: string;
	};
	limit?: number;
	/** Weight for keyword/title match (0-1). Remainder goes to semantic. */
	keywordWeight?: number;
	semanticWeight?: number;
	include_context?: boolean;
}

export interface StatusHistorySearchHit {
	event: StatusHistoryEvent;
	score: number;
	keywordScore: number;
	semanticScore: number;
	highlights: string[];
}

export interface StatusHistorySearchResponse {
	results: StatusHistorySearchHit[];
	total: number;
	query: string;
	semanticUsed: boolean;
	query_time_ms: number;
}

function normalizeScore(score: number): number {
	return Math.max(0, Math.min(1, score));
}

function keywordScore(query: string, title: string, content: string): number {
	const terms = (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter(Boolean);
	if (terms.length === 0) return 0;
	const hay = `${title} ${content}`.toLowerCase();
	let hits = 0;
	for (const term of terms) {
		if (hay.includes(term)) hits += 1;
	}
	return hits / terms.length;
}

function highlights(query: string, title: string, content: string): string[] {
	const terms = (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter(Boolean);
	const out: string[] = [];
	const text = `${title}\n${content}`;
	for (const term of terms) {
		const idx = text.toLowerCase().indexOf(term);
		if (idx >= 0) {
			const start = Math.max(0, idx - 40);
			const end = Math.min(text.length, idx + term.length + 40);
			out.push(text.slice(start, end).replace(/\s+/g, " ").trim());
		}
	}
	return [...new Set(out)].slice(0, 5);
}

function parseDateQuery(raw: string | undefined, label: string): { value?: Date; error?: string } {
	if (!raw) {
		return {};
	}

	const parsed = new Date(raw);
	if (Number.isNaN(parsed.getTime())) {
		return { error: `Invalid ${label} date: ${raw}` };
	}

	return { value: parsed };
}

function parseLimit(raw: string | undefined, fallback: number, max: number): number {
	const parsed = Number.parseInt(raw || String(fallback), 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return fallback;
	}
	return Math.min(parsed, max);
}

export function createStatusHistoryRoutes(): Hono {
	const app = new Hono();

	app.post("/search", async (c) => {
		const start = Date.now();
		try {
			const body = await c.req.json<StatusHistorySearchRequest>();
			const query = body.query?.trim() ?? "";
			if (!query) {
				return c.json({ error: "Query is required" }, 400);
			}

			const limit = body.limit ?? 20;
			const parsedFrom = parseDateQuery(body.filters?.from, "from");
			const parsedTo = parseDateQuery(body.filters?.to, "to");
			if (parsedFrom.error || parsedTo.error) {
				return c.json({ error: parsedFrom.error || parsedTo.error }, 400);
			}

			const keywordWeight = body.keywordWeight ?? 0.35;
			const semanticWeight = body.semanticWeight ?? 0.65;
			const totalWeight = keywordWeight + semanticWeight || 1;
			const kwW = keywordWeight / totalWeight;
			const semW = semanticWeight / totalWeight;

			const filters = body.filters ?? {};
			const armIds = filters.arm_ids ?? [];
			const eventTypes = filters.event_types ?? [];

			// Primary path: semantic search (optionally multi-arm / multi-type via fan-out).
			let semanticUsed = false;
			const semanticHits: Array<{ id: string; score: number; event: StatusHistoryEvent }> = [];

			try {
				if (armIds.length > 1 || eventTypes.length > 1) {
					const arms = armIds.length > 0 ? armIds : [undefined];
					const types = eventTypes.length > 0 ? eventTypes : [undefined];
					const seen = new Set<string>();
					for (const armId of arms) {
						for (const type of types) {
							const batch = await searchStatusHistory(query, {
								limit,
								armId,
								type,
								taskId: filters.task_id,
								bugId: filters.bug_id,
								source: filters.source,
								classification: filters.classification,
								since: parsedFrom.value,
								until: parsedTo.value,
							});
							for (const hit of batch) {
								if (seen.has(hit.id)) continue;
								seen.add(hit.id);
								semanticHits.push(hit);
							}
						}
					}
				} else {
					const batch = await searchStatusHistory(query, {
						limit: limit * 2,
						armId: armIds[0],
						type: eventTypes[0],
						taskId: filters.task_id,
						bugId: filters.bug_id,
						source: filters.source,
						classification: filters.classification,
						since: parsedFrom.value,
						until: parsedTo.value,
					});
					semanticHits.push(...batch);
				}
				semanticUsed = true;
			} catch (err) {
				console.warn("[StatusHistory] Semantic search failed:", err);
			}

			const results: StatusHistorySearchHit[] = semanticHits.map((hit) => {
				const kw = keywordScore(query, hit.event.title, hit.event.content);
				const sem = normalizeScore(hit.score);
				return {
					event: hit.event,
					keywordScore: kw,
					semanticScore: sem,
					score: kw * kwW + sem * semW,
					highlights: body.include_context === false ? [] : highlights(query, hit.event.title, hit.event.content),
				};
			});

			results.sort((a, b) => b.score - a.score);
			const page = results.slice(0, limit);

			const response: StatusHistorySearchResponse = {
				results: page,
				total: results.length,
				query,
				semanticUsed,
				query_time_ms: Date.now() - start,
			};
			return c.json(response);
		} catch (err) {
			console.error("[StatusHistory] Search error:", err);
			return c.json(
				{ error: err instanceof Error ? err.message : "Status history search failed" },
				500,
			);
		}
	});

	app.get("/stats", async (c) => {
		try {
			const health = await getStatusHistoryHealth();
			return c.json({
				period: c.req.query("period") || "all",
				healthy: health.healthy,
				collectionExists: health.collectionExists,
				pointsCount: health.pointsCount,
			});
		} catch (err) {
			return c.json(
				{ error: err instanceof Error ? err.message : "Stats failed" },
				500,
			);
		}
	});

	app.get("/by-arm/:armId", async (c) => {
		const armId = c.req.param("armId");
		const from = parseDateQuery(c.req.query("from"), "from");
		const to = parseDateQuery(c.req.query("to"), "to");
		const limit = parseLimit(c.req.query("limit"), 100, 500);
		if (from.error || to.error) {
			return c.json({ error: from.error || to.error }, 400);
		}

		try {
			// Empty semantic query not useful; use a broad probe via filter-only by searching arm id text.
			const hits = await searchStatusHistory(armId, {
				limit,
				armId,
				since: from.value,
				until: to.value,
			});
			return c.json({
				armId,
				events: hits.map((h) => h.event),
				total: hits.length,
			});
		} catch (err) {
			return c.json(
				{ error: err instanceof Error ? err.message : "Arm status history failed" },
				500,
			);
		}
	});

	/** Index a single status history event (backfill / manual). */
	app.post("/index", async (c) => {
		try {
			const body = await c.req.json<Partial<StatusHistoryEvent> & {
				title: string;
				content: string;
				type?: StatusHistoryEventType;
				source?: string;
			}>();

			if (!body.title || !body.content) {
				return c.json({ error: "title and content are required" }, 400);
			}

			const type = body.type || "status_report";
			const source = body.source || "system";
			const timestamp = body.timestamp || new Date().toISOString();
			const event: StatusHistoryEvent = {
				id: body.id || createEventId(type, source, timestamp),
				type,
				timestamp,
				source,
				title: body.title,
				content: body.content,
				taskId: body.taskId,
				bugId: body.bugId,
				discoveryId: body.discoveryId,
				armId: body.armId,
				status: body.status,
				priority: body.priority,
				classification: body.classification,
				metadata: body.metadata || {},
			};

			await indexStatusHistoryEvent(event);
			return c.json({ success: true, id: event.id });
		} catch (err) {
			return c.json(
				{ error: err instanceof Error ? err.message : "Index failed" },
				500,
			);
		}
	});

	return app;
}
