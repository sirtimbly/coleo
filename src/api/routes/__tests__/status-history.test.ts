import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import { createStatusHistoryRoutes } from "../status-history";
import * as pipeline from "../../../vector/indexing-pipeline";
import type { StatusHistoryEvent } from "../../../vector/status-history";

describe("status-history routes", () => {
	let app: Hono;
	let searchSpy: ReturnType<typeof spyOn>;
	let healthSpy: ReturnType<typeof spyOn>;
	let indexSpy: ReturnType<typeof spyOn>;

	const sampleEvent: StatusHistoryEvent = {
		id: "evt-1",
		type: "status_report",
		timestamp: "2026-07-10T12:00:00.000Z",
		source: "arm-alpha",
		title: "Database migration blocked",
		content: "Hit SQLITE_BUSY during migration of tasks table",
		armId: "arm-alpha",
		status: "blocked",
		metadata: {},
	};

	beforeEach(() => {
		searchSpy = spyOn(pipeline, "searchStatusHistory").mockImplementation(async () => [
			{ id: sampleEvent.id, score: 0.91, event: sampleEvent },
		]);
		healthSpy = spyOn(pipeline, "getStatusHistoryHealth").mockImplementation(async () => ({
			healthy: true,
			collectionExists: true,
			pointsCount: 42,
		}));
		indexSpy = spyOn(pipeline, "indexStatusHistoryEvent").mockImplementation(async () => {});

		app = new Hono();
		app.route("/api/status-history", createStatusHistoryRoutes());
	});

	afterEach(() => {
		searchSpy.mockRestore();
		healthSpy.mockRestore();
		indexSpy.mockRestore();
	});

	it("rejects empty search query", async () => {
		const res = await app.request("/api/status-history/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "" }),
		});
		expect(res.status).toBe(400);
	});

	it("returns hybrid scores and highlights for status history search", async () => {
		const res = await app.request("/api/status-history/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "database migration SQLITE_BUSY",
				filters: { arm_ids: ["arm-alpha"], event_types: ["status_report"] },
				limit: 10,
			}),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			results: Array<{
				event: StatusHistoryEvent;
				score: number;
				keywordScore: number;
				semanticScore: number;
				highlights: string[];
			}>;
			total: number;
			semanticUsed: boolean;
			query_time_ms: number;
		};

		expect(body.semanticUsed).toBe(true);
		expect(body.total).toBe(1);
		expect(body.results[0]?.event.id).toBe("evt-1");
		expect(body.results[0]?.semanticScore).toBeCloseTo(0.91, 2);
		expect(body.results[0]?.keywordScore).toBeGreaterThan(0);
		expect(body.results[0]?.score).toBeGreaterThan(0);
		expect(body.results[0]?.highlights.length).toBeGreaterThan(0);
		expect(body.query_time_ms).toBeGreaterThanOrEqual(0);
		expect(searchSpy).toHaveBeenCalled();
	});

	it("passes a classification filter to Qdrant search", async () => {
		const res = await app.request("/api/status-history/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: "database migration",
				filters: { classification: "development" },
			}),
		});

		expect(res.status).toBe(200);
		expect(searchSpy).toHaveBeenCalledWith(
			"database migration",
			expect.objectContaining({ classification: "development" }),
		);
	});

	it("returns collection stats", async () => {
		const res = await app.request("/api/status-history/stats?period=week");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			period: "week",
			healthy: true,
			pointsCount: 42,
		});
	});

	it("lists events for an arm", async () => {
		const res = await app.request("/api/status-history/by-arm/arm-alpha?limit=5");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { armId: string; events: StatusHistoryEvent[]; total: number };
		expect(body.armId).toBe("arm-alpha");
		expect(body.total).toBe(1);
		expect(body.events[0]?.id).toBe("evt-1");
	});

	it("indexes a status history event", async () => {
		const res = await app.request("/api/status-history/index", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				title: "Task done",
				content: "Finished hybrid search API",
				type: "task_completion",
				source: "arm-beta",
				classification: "engineering",
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { success: boolean; id: string };
		expect(body.success).toBe(true);
		expect(body.id).toBeTruthy();
		expect(indexSpy).toHaveBeenCalledTimes(1);
		expect(indexSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				classification: "engineering",
				type: "task_completion",
				source: "arm-beta",
				title: "Task done",
			}),
		);
	});
});
