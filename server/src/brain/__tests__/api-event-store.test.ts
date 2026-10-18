/**
 * ApiEventStore mapping tests. The store reads through the authenticated
 * API event routes; fetch is stubbed to return route-shaped payloads.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { ApiEventStore } from "../api-event-store";

const OPTIONS = { baseUrl: "http://127.0.0.1:8080", apiKey: "test-key" };

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function stubFetch(payload: unknown, status = 200): string[] {
	const seen: string[] = [];
	globalThis.fetch = (async (url: string | URL | Request) => {
		seen.push(String(url));
		return new Response(JSON.stringify(payload), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
	return seen;
}

describe("ApiEventStore", () => {
	it("reports unavailable without API options and reads empty", async () => {
		const store = new ApiEventStore();
		expect(store.isInitialized()).toBe(false);
		const window = new (await import("../event-window")).BrainEventWindow({
			store,
			log: () => {},
		});
		expect(window.isAvailable()).toBe(false);
		expect(await window.getWindowForArm("arm-1")).toEqual(
			expect.objectContaining({ armId: "arm-1", events: [] }),
		);
	});

	it("maps arm window responses to EventData", async () => {
		const seen = stubFetch({
			armId: "arm-1",
			window: {
				events: [
					{
						type: "prompt_sent",
						timestamp: "2026-09-22T15:00:00.000Z",
						data: { text: "hi" },
						sequence: 7,
					},
					{ type: 42, timestamp: "bad", data: null },
				],
			},
		});
		const store = new ApiEventStore(OPTIONS);
		expect(store.isInitialized()).toBe(true);
		const events = await store.getArmEvents(
			"arm-1",
			20,
			new Date("2026-09-22T14:50:00.000Z"),
		);
		expect(seen[0]).toContain("/api/events/arms/arm-1/window?");
		expect(events).toEqual([
			{
				type: "prompt_sent",
				armId: "arm-1",
				data: { text: "hi" },
				timestamp: "2026-09-22T15:00:00.000Z",
				sequence: 7,
			},
		]);
	});

	it("maps recent responses to EventData", async () => {
		const seen = stubFetch({
			events: [
				{
					type: "idle",
					armId: "arm-2",
					sequence: 3,
					timestamp: "2026-09-22T15:01:00.000Z",
					data: {},
				},
			],
			count: 1,
		});
		const store = new ApiEventStore(OPTIONS);
		const events = await store.getRecentEvents(10);
		expect(seen[0]).toContain("/api/events/recent?");
		expect(events).toEqual([
			{
				type: "idle",
				armId: "arm-2",
				data: {},
				timestamp: "2026-09-22T15:01:00.000Z",
				sequence: 3,
			},
		]);
	});

	it("rejects stream-internals operations without an API equivalent", async () => {
		const store = new ApiEventStore(OPTIONS);
		await expect(store.getEvent(1)).rejects.toThrow();
		await expect(store.queryEvents({})).rejects.toThrow();
		await expect(store.getEventsByType("idle")).rejects.toThrow();
		await expect(store.getStreamMetrics()).rejects.toThrow();
		await expect(
			store.publishEvent("s", {
				type: "t",
				data: {},
				timestamp: new Date().toISOString(),
			}),
		).rejects.toThrow();
	});
});
