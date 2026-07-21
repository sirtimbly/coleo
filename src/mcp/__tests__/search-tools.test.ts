import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createMcpServer } from "../server";

interface RegisteredTool {
	description?: string;
	inputSchema?: unknown;
	handler?: (args: Record<string, unknown>) => Promise<{
		content: Array<{ type: string; text: string }>;
	}>;
	callback?: (args: Record<string, unknown>) => Promise<{
		content: Array<{ type: string; text: string }>;
	}>;
}

function getTools(): Record<string, RegisteredTool> {
	const server = createMcpServer() as unknown as Record<string, unknown>;
	return server._registeredTools as Record<string, RegisteredTool>;
}

function getHandler(tool: RegisteredTool): RegisteredTool["handler"] {
	return tool.handler ?? tool.callback;
}

describe("MCP search tools", () => {
	const originalFetch = globalThis.fetch;
	let fetchSpy: ReturnType<typeof spyOn> | null = null;

	afterEach(() => {
		if (fetchSpy) {
			fetchSpy.mockRestore();
			fetchSpy = null;
		}
		globalThis.fetch = originalFetch;
	});

	it("registers search and search_status_history tools", () => {
		const tools = getTools();
		expect(tools.search?.description).toMatch(/Search across indexed/i);
		expect(tools.search_status_history?.description).toMatch(/historical status/i);
		expect(tools.historical_search?.description).toMatch(/historical status/i);
	});

	it("search tool posts hybrid query to /api/search", async () => {
		const tools = getTools();
		const handler = getHandler(tools.search!);
		expect(handler).toBeDefined();

		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			expect(String(input)).toContain("/api/search");
			expect(init?.method).toBe("POST");
			const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			expect(body.query).toBe("authentication issues");
			expect(body.types).toEqual(["task"]);
			expect(body.keywordWeight).toBe(0.4);
			expect(body.semanticWeight).toBe(0.6);

			return new Response(
				JSON.stringify({
					results: [{ id: "task-1", title: "Auth", score: 0.9 }],
					total: 1,
					query: "authentication issues",
					semanticUsed: true,
					took: 12,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch);

		const result = await handler!({
			query: "authentication issues",
			types: ["task"],
			keyword_weight: 0.4,
			semantic_weight: 0.6,
		});

		expect(result.content[0]?.text).toContain("authentication issues");
		expect(result.content[0]?.text).toContain("task-1");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("search_status_history tool posts to /api/status-history/search with days_back", async () => {
		const tools = getTools();
		const handler = getHandler(tools.search_status_history!);
		expect(handler).toBeDefined();

		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			expect(String(input)).toContain("/api/status-history/search");
			expect(init?.method).toBe("POST");
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				query: string;
				limit: number;
				filters: { arm_ids?: string[]; event_types?: string[]; from?: string; classification?: string };
			};
			expect(body.query).toBe("database migrations");
			expect(body.limit).toBe(5);
			expect(body.filters.arm_ids).toEqual(["arm-alpha"]);
			expect(body.filters.event_types).toEqual(["status_report"]);
			expect(body.filters.classification).toBe("discovery");
			expect(body.filters.from).toBeDefined();

			return new Response(
				JSON.stringify({
					results: [
						{
							event: { id: "evt-1", title: "Migration blocked" },
							score: 0.88,
						},
					],
					total: 1,
					query: "database migrations",
					semanticUsed: true,
					query_time_ms: 20,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch);

		const result = await handler!({
			query: "database migrations",
			limit: 5,
			filters: {
				arm_ids: ["arm-alpha"],
				event_types: ["status_report"],
				days_back: 7,
				classification: "discovery",
			},
		});

		expect(result.content[0]?.text).toContain("database migrations");
		expect(result.content[0]?.text).toContain("evt-1");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("historical_search tool posts to /api/status-history/search with direct filters", async () => {
		const tools = getTools();
		const handler = getHandler(tools.historical_search!);
		expect(handler).toBeDefined();

		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			expect(String(input)).toContain("/api/status-history/search");
			expect(init?.method).toBe("POST");
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				query: string;
				filters: {
					arm_ids?: string[];
					event_types?: string[];
					from?: string;
				};
			};
			expect(body.query).toBe("deployment failures");
			expect(body.filters.arm_ids).toEqual(["arm-bravo"]);
			expect(body.filters.event_types).toEqual(["task_completion"]);
			expect(body.filters.from).toBeDefined();

			return new Response(
				JSON.stringify({
					results: [
						{
							event: { id: "evt-2", title: "Deploy finished" },
							score: 0.93,
						},
					],
					total: 1,
					query: "deployment failures",
					semanticUsed: true,
					query_time_ms: 15,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch);

		const result = await handler!({
			query: "deployment failures",
			arm_id: "arm-bravo",
			event_type: "task_completion",
			days_back: 14,
		});

		expect(result.content[0]?.text).toContain("deployment failures");
		expect(result.content[0]?.text).toContain("evt-2");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("search tool returns validation message for empty query", async () => {
		const tools = getTools();
		const handler = getHandler(tools.search!);
		const result = await handler!({ query: "  " });
		expect(result.content[0]?.text).toContain("Query is required");
	});
});
